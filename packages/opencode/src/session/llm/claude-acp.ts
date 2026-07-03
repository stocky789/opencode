import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ClientSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream } from "@agentclientprotocol/sdk"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type {
  Client,
  CreateElicitationRequest,
  CreateElicitationResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  ElicitationContentValue,
  ElicitationPropertySchema,
  KillTerminalRequest,
  KillTerminalResponse,
  McpServer,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk"
import { LLMEvent, Usage, type FinishReason, type LLMEvent as LLMEventType } from "@opencode-ai/llm"
import { Question } from "@/question"
import type { ModelMessage } from "ai"
import { createTwoFilesPatch } from "diff"
import * as Stream from "effect/Stream"

type PermissionBridge = {
  readonly ask: (input: PermissionV1.AskInput) => Promise<PermissionV1.Reply>
  readonly reply: (input: PermissionV1.ReplyInput) => Promise<void>
}

type QuestionBridge = {
  readonly ask: (input: Parameters<Question.Interface["ask"]>[0]) => Promise<ReadonlyArray<Question.Answer>>
}

type StreamInput = {
  readonly cwd: string
  readonly sessionID: PermissionV1.AskInput["sessionID"]
  readonly modelID: string
  readonly agent: string
  readonly mcpServers: readonly McpServer[]
  readonly messages: ModelMessage[]
  readonly abort: AbortSignal
  readonly ruleset: PermissionV1.Ruleset
  readonly permission: PermissionBridge
  readonly question: QuestionBridge
}

type Terminal = {
  readonly process: Bun.Subprocess<"ignore", "pipe", "pipe">
  readonly output: string[]
  readonly limit: number
  readonly exited: Promise<WaitForTerminalExitResponse>
  exitStatus?: WaitForTerminalExitResponse
}

type QueueItem =
  | { readonly type: "event"; readonly event: LLMEventType }
  | { readonly type: "done" }
  | { readonly type: "error"; readonly error: unknown }

type ACPUsage = {
  readonly cachedReadTokens?: number | null
  readonly cachedWriteTokens?: number | null
  readonly inputTokens: number
  readonly outputTokens: number
  readonly thoughtTokens?: number | null
  readonly totalTokens: number
}

type ACPContextUsage = {
  readonly used: number
  readonly size: number
}

type ACPProviderMetadata = {
  readonly anthropic: Record<string, unknown>
}

type ElicitationField = {
  readonly key: string
  readonly question: Question.Info
  readonly value: (answers: ReadonlyArray<string>) => ElicitationContentValue | undefined
}

type Connection = {
  readonly key: string
  readonly cwd: string
  readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">
  client: ClientSideConnection
  readonly stderr: string[]
  readonly terminals: Map<string, Terminal>
  sessionID: string
  lock: Promise<void>
  used: boolean
  disposed: boolean
  active?: {
    readonly cwd: string
    readonly queue: ReturnType<typeof makeQueue>
    readonly sessionID: PermissionV1.AskInput["sessionID"]
    readonly abort: AbortSignal
    readonly ruleset: PermissionV1.Ruleset
    readonly permission: PermissionBridge
    readonly question: QuestionBridge
    contextUsage?: ACPContextUsage
    providerCompacted?: boolean
  }
  disposeTimer?: ReturnType<typeof setTimeout>
}

type ActivePermissionRequest = {
  readonly sessionID: PermissionV1.AskInput["sessionID"]
  readonly abort: AbortSignal
  readonly permission: PermissionBridge
}

const TEXT_ID = "claude-acp-text"
const REASONING_ID = "claude-acp-reasoning"
const IDLE_CLOSE_MS = 10 * 60_000
const connections = new Map<string, Promise<Connection>>()
const activeConnections = new Set<Connection>()

process.once("exit", () => {
  for (const connection of activeConnections) {
    cleanupTerminals(connection)
    connection.child.kill()
  }
})

export function stream(input: StreamInput): Stream.Stream<LLMEventType, unknown> {
  return Stream.fromAsyncIterable(run(input), (error) =>
    error instanceof Error ? error : new Error(String(error)),
  )
}

async function* run(input: StreamInput) {
  const queue = makeQueue()
  let connection: Connection | undefined
  let finished = false
  const onAbort = () => {
    if (!connection) return
    void connection.client.cancel({ sessionId: connection.sessionID }).catch(() => undefined)
  }
  input.abort.addEventListener("abort", onAbort, { once: true })

  void (async () => {
    try {
      queue.push(LLMEvent.stepStart({ index: 0 }))
      const activeConnection = await getConnection(input)
      connection = activeConnection
      await withConnectionLock(activeConnection, async () => {
        if (input.abort.aborted) {
          finish(queue, "error")
          return
        }
        clearDisposeTimer(activeConnection)
        activeConnection.stderr.length = 0
        activeConnection.active = {
          cwd: input.cwd,
          queue,
          sessionID: input.sessionID,
          abort: input.abort,
          ruleset: input.ruleset,
          permission: input.permission,
          question: input.question,
        }
        try {
          const response = await activeConnection.client.prompt({
            sessionId: activeConnection.sessionID,
            prompt: [
              {
                type: "text",
                text: activeConnection.used ? currentPromptText(input.messages) : promptText(input.messages),
              },
            ],
          })
          activeConnection.used = true
          await new Promise((resolve) => setTimeout(resolve, 50))
          if (input.abort.aborted) {
            finish(
              queue,
              "error",
              claudeUsage(response.usage, activeConnection.active?.contextUsage) ??
                claudeContextUsage(activeConnection.active?.contextUsage),
              claudeProviderMetadata(activeConnection.active?.providerCompacted),
            )
            return
          }
          finish(
            queue,
            finishReason(response.stopReason),
            claudeUsage(response.usage, activeConnection.active?.contextUsage),
            claudeProviderMetadata(activeConnection.active?.providerCompacted),
          )
        } finally {
          const providerCompacted = activeConnection.active?.providerCompacted === true
          activeConnection.active = undefined
          cleanupTerminals(activeConnection)
          // OpenCode compaction rewrites our stored history, but Claude Code keeps its own ACP session history.
          // Start the next turn in a fresh Claude session so it is seeded from the compacted transcript.
          if (input.agent === "compaction" || providerCompacted) disposeConnection(activeConnection)
          else scheduleDispose(activeConnection)
        }
      })
    } catch (error) {
      if (connection) {
        const usage = claudeContextUsage(connection.active?.contextUsage)
        const providerMetadata = claudeProviderMetadata(connection.active?.providerCompacted)
        const aborted = input.abort.aborted
        connection.active = undefined
        cleanupTerminals(connection)
        if (aborted) {
          scheduleDispose(connection)
          finish(queue, "error", usage, providerMetadata)
          return
        }
        disposeConnection(connection)
      }
      if (input.abort.aborted) {
        finish(queue, "error")
        return
      }
      const message = connection?.stderr.join("").trim()
      queue.fail(message ? new Error(`${errorMessage(error)}\n${message}`) : error)
    }
  })()

  try {
    for await (const event of queue) {
      finished = event.type === "finish"
      yield event
    }
  } finally {
    input.abort.removeEventListener("abort", onAbort)
    if (connection && !finished) {
      await connection.client.cancel({ sessionId: connection.sessionID }).catch(() => undefined)
      disposeConnection(connection)
    }
  }
}

async function getConnection(input: StreamInput) {
  const key = connectionKey(input)
  const existing = connections.get(key)
  if (existing) {
    const connection = await existing
    if (!connection.disposed) return connection
    connections.delete(key)
  }
  const created = createConnection(input, key).catch((error) => {
    connections.delete(key)
    throw error
  })
  connections.set(key, created)
  return created
}

async function createConnection(input: StreamInput, key: string): Promise<Connection> {
  if (input.abort.aborted) throw abortError()
  const stderr: string[] = []
  const terminals = new Map<string, Terminal>()
  const child = Bun.spawn({
    cmd: claudeCommand(),
    cwd: input.cwd,
    env: claudeEnv(input.modelID),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const connection = {
    key,
    cwd: input.cwd,
    child,
    stderr,
    terminals,
    sessionID: "",
    lock: Promise.resolve(),
    used: false,
    disposed: false,
  } as Connection
  activeConnections.add(connection)
  connection.client = new ClientSideConnection(
    () => makeClient(connection),
    ndJsonStream(writable(child.stdin), child.stdout),
  )
  void collect(child.stderr, stderr, 32_000)
  const onAbort = () => disposeConnection(connection)
  input.abort.addEventListener("abort", onAbort, { once: true })
  void child.exited.finally(() => {
    if (connection.disposed) return
    connection.disposed = true
    activeConnections.delete(connection)
    connections.delete(connection.key)
  })
  try {
    await connection.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "OpenCode", version: "0.0.0" },
      clientCapabilities: {
        auth: { terminal: true },
        elicitation: { form: {} },
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    })
    if (input.abort.aborted) throw abortError()
    const session = await connection.client.newSession({ cwd: input.cwd, mcpServers: [...input.mcpServers] })
    if (input.abort.aborted) throw abortError()
    connection.sessionID = session.sessionId
    scheduleDispose(connection)
    return connection
  } catch (error) {
    disposeConnection(connection)
    throw error
  } finally {
    input.abort.removeEventListener("abort", onAbort)
  }
}

async function withConnectionLock<T>(connection: Connection, fn: () => Promise<T>) {
  const previous = connection.lock.catch(() => undefined)
  let release!: () => void
  connection.lock = previous.then(() => new Promise<void>((resolve) => (release = resolve)))
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

function connectionKey(input: StreamInput) {
  return [input.sessionID, input.cwd, input.modelID, stableStringify(input.mcpServers)].join("\0")
}

function scheduleDispose(connection: Connection) {
  if (connection.disposed) return
  clearDisposeTimer(connection)
  connection.disposeTimer = setTimeout(() => disposeConnection(connection), IDLE_CLOSE_MS)
  connection.disposeTimer.unref?.()
}

function clearDisposeTimer(connection: Connection) {
  if (!connection.disposeTimer) return
  clearTimeout(connection.disposeTimer)
  connection.disposeTimer = undefined
}

function disposeConnection(connection: Connection) {
  if (connection.disposed) return
  connection.disposed = true
  clearDisposeTimer(connection)
  activeConnections.delete(connection)
  connections.delete(connection.key)
  cleanupTerminals(connection)
  if (connection.sessionID) void connection.client.closeSession({ sessionId: connection.sessionID }).catch(() => undefined)
  connection.child.kill()
  void Promise.allSettled([connection.client.closed, connection.child.exited])
}

function cleanupTerminals(connection: Connection) {
  for (const terminal of connection.terminals.values()) terminal.process.kill()
  connection.terminals.clear()
}

function claudeCommand() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
  return ["node", path.join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js")]
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.trim() === "Authentication required") {
    return "Claude Code authentication required. Run `claude auth login` in a normal terminal, then retry in OpenCode."
  }
  return message
}

function abortError() {
  return new DOMException("Aborted", "AbortError")
}

function claudeEnv(modelID: string) {
  const selected = claudeModelID(modelID)
  if (!selected) return process.env
  return {
    ...process.env,
    ANTHROPIC_MODEL: selected,
  }
}

function makeClient(connection: Connection): Client {
  return {
    sessionUpdate: async (params: SessionNotification) => sessionUpdate(connection, params),
    requestPermission: (params) => requestPermission(connection, params),
    unstable_createElicitation: (params) => createElicitation(connection, params),
    readTextFile: (params) => readTextFile(connection.active?.cwd ?? connection.cwd, params),
    writeTextFile: (params) => writeTextFile(connection.active?.cwd ?? connection.cwd, params),
    createTerminal: (params) => createTerminal(connection, params),
    terminalOutput: (params) => terminalOutput(connection.terminals, params),
    waitForTerminalExit: (params) => waitForTerminalExit(connection.terminals, params),
    killTerminal: (params) => killTerminal(connection.terminals, params),
    releaseTerminal: (params) => releaseTerminal(connection.terminals, params),
  }
}

function sessionUpdate(connection: Connection, params: SessionNotification) {
  const active = connection.active
  if (!active) return
  if (params.update.sessionUpdate === "usage_update") {
    const used = token(params.update.used)
    const size = token(params.update.size)
    if (used !== undefined && size !== undefined) active.contextUsage = { used, size }
    return
  }
  if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") {
    const compaction = claudeACPCompactionStatus(params.update.content.text)
    if (compaction) {
      if (compaction === "completed") active.providerCompacted = true
      return
    }
    active.queue.text(params.update.content.text)
    return
  }
  if (params.update.sessionUpdate === "agent_thought_chunk" && params.update.content.type === "text") {
    active.queue.reasoning(params.update.content.text)
  }
}

async function requestPermission(
  connection: Connection,
  params: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  return requestPermissionForActive(connection.active, params)
}

export async function requestPermissionForActive(
  active: ActivePermissionRequest | undefined,
  params: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  if (!active || active.abort.aborted) return cancelledPermission()

  const requestID = PermissionV1.ID.ascending()
  const permission = permissionName(params)
  const metadata = permissionMetadata(params)
  const patterns = permissionPatterns(permission, metadata, params)
  const onAbort = () => {
    void active.permission.reply({ requestID, reply: "reject" }).catch(() => undefined)
  }
  active.abort.addEventListener("abort", onAbort, { once: true })

  try {
    const reply = await active.permission.ask({
      id: requestID,
      sessionID: active.sessionID,
      permission,
      patterns,
      always: permissionAlways(permission, patterns),
      metadata,
      ruleset: claudeACPPermissionRuleset(permission, patterns),
    })
    return allowPermission(params, reply)
  } catch (error) {
    if (active.abort.aborted) return cancelledPermission()
    if (
      error instanceof PermissionV1.DeniedError ||
      error instanceof PermissionV1.RejectedError ||
      error instanceof PermissionV1.CorrectedError
    ) {
      return rejectPermission(params)
    }
    return cancelledPermission()
  } finally {
    active.abort.removeEventListener("abort", onAbort)
  }
}

function permissionName(params: RequestPermissionRequest) {
  switch (params.toolCall.kind) {
    case "execute":
      return "bash"
    case "edit":
    case "delete":
    case "move":
      return "edit"
    case "fetch":
      return "webfetch"
    case "search":
      return "grep"
    case "read":
      return "read"
    default:
      return params.toolCall.kind ? `claude_${params.toolCall.kind}` : "claude_tool"
  }
}

function permissionMetadata(params: RequestPermissionRequest): Record<string, unknown> {
  const metadata = { ...recordValue(params.toolCall.rawInput) }
  metadata.toolCallId = params.toolCall.toolCallId
  metadata.kind = params.toolCall.kind ?? "other"
  metadata.title = params.toolCall.title ?? params.toolCall.toolCallId

  const location = params.toolCall.locations?.find((item) => item.path)?.path
  if (location) {
    metadata.path ??= location
    metadata.filePath ??= location
    metadata.filepath ??= location
  }

  const diff = params.toolCall.content?.find((item) => item.type === "diff")
  if (diff) {
    const diffPath = stringValue(diff.path)
    if (diffPath) {
      metadata.filepath = diffPath
      metadata.filePath = diffPath
    }
    if (diffPath && typeof diff.newText === "string") {
      metadata.diff = createTwoFilesPatch(
        diffPath,
        diffPath,
        typeof diff.oldText === "string" ? diff.oldText : "",
        diff.newText,
      )
    }
  }

  if (params.toolCall.kind === "execute") metadata.command ??= params.toolCall.title ?? params.toolCall.toolCallId
  if (params.toolCall.kind === "fetch") metadata.url ??= params.toolCall.title
  if (params.toolCall.kind === "search") metadata.pattern ??= params.toolCall.title
  return metadata
}

function permissionPatterns(
  permission: string,
  metadata: Record<string, unknown>,
  params: RequestPermissionRequest,
) {
  const locations = params.toolCall.locations?.map((item) => item.path).filter((item): item is string => !!item) ?? []
  if (permission === "bash") return [stringValue(metadata.command) ?? params.toolCall.title ?? params.toolCall.toolCallId]
  if (permission === "webfetch") return [stringValue(metadata.url) ?? params.toolCall.title ?? "*"]
  if (permission === "grep") return [stringValue(metadata.pattern) ?? params.toolCall.title ?? "*"]

  const file = firstString(metadata.filePath, metadata.filepath, metadata.path)
  if ((permission === "read" || permission === "edit") && file) return [file]
  if (locations.length > 0) return locations
  return ["*"]
}

function permissionAlways(permission: string, patterns: string[]) {
  if (permission === "bash") return patterns
  return ["*"]
}

export function claudeACPPermissionRuleset(permission: string, patterns: string[]) {
  return patterns.map((pattern) => ({ permission, pattern, action: "ask" as const })) satisfies PermissionV1.Ruleset
}

function allowPermission(params: RequestPermissionRequest, reply: PermissionV1.Reply): RequestPermissionResponse {
  const preferred = reply === "always" ? "allow_always" : "allow_once"
  const option =
    params.options.find((item) => item.kind === preferred) ??
    params.options.find((item) => item.kind === "allow_once" || item.kind === "allow_always")
  if (!option) return cancelledPermission()
  return { outcome: { outcome: "selected", optionId: option.optionId } }
}

function rejectPermission(params: RequestPermissionRequest): RequestPermissionResponse {
  const option = params.options.find((item) => item.kind === "reject_once" || item.kind === "reject_always")
  if (!option) return cancelledPermission()
  return { outcome: { outcome: "selected", optionId: option.optionId } }
}

function cancelledPermission(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } }
}

async function createElicitation(
  connection: Connection,
  params: CreateElicitationRequest,
): Promise<CreateElicitationResponse> {
  const active = connection.active
  if (!active || active.abort.aborted) return { action: "cancel" }
  if (params.mode !== "form" || !("sessionId" in params)) return { action: "decline" }

  const fields = claudeACPElicitationFields(params)
  if (fields.length === 0) return { action: "accept", content: {} }

  try {
    const answers = await active.question.ask({
      sessionID: active.sessionID,
      questions: fields.map((field) => field.question),
    })
    return { action: "accept", content: claudeACPElicitationContent(fields, answers) }
  } catch {
    if (active.abort.aborted) return { action: "cancel" }
    return { action: "decline" }
  }
}

export function claudeACPElicitationFields(params: CreateElicitationRequest): ElicitationField[] {
  if (params.mode !== "form") return []
  return Object.entries(params.requestedSchema.properties ?? {}).map(([key, property]) =>
    elicitationField(key, property, params),
  )
}

export function claudeACPElicitationContent(
  fields: ReadonlyArray<ElicitationField>,
  answers: ReadonlyArray<Question.Answer>,
) {
  return Object.fromEntries(
    fields.flatMap((field, index) => {
      const value = field.value(answers[index] ?? [])
      if (value === undefined) return []
      return [[field.key, value]]
    }),
  )
}

function elicitationField(key: string, property: ElicitationPropertySchema, params: CreateElicitationRequest) {
  const title = property.title ?? key
  const description = property.description ?? params.message
  const base = {
    header: shortHeader(title),
    question: title,
  }

  if (property.type === "string") {
    const choices = property.oneOf?.map((item) => ({ label: item.title, description: item.const })) ?? property.enum
    const options = choices?.map((item) =>
      typeof item === "string" ? { label: item, description } : { label: item.label, description: item.description },
    )
    const values = choices?.map(
      (item): readonly [string, string] =>
        typeof item === "string" ? [item, item] : [item.label, item.description],
    )
    return {
      key,
      question: { ...base, options: options ?? [], custom: !options?.length },
      value: (answers: ReadonlyArray<string>) => valueFromLabels(values, answers, property.default),
    } satisfies ElicitationField
  }

  if (property.type === "array") {
    const raw = "anyOf" in property.items ? property.items.anyOf : property.items.enum
    const values = raw.map(
      (item): readonly [string, string] => (typeof item === "string" ? [item, item] : [item.title, item.const]),
    )
    return {
      key,
      question: {
        ...base,
        options: values.map(([label, value]) => ({ label, description: value })),
        custom: false,
        multiple: true,
      },
      value: (answers: ReadonlyArray<string>) => valueFromLabels(values, answers, property.default ?? []),
    } satisfies ElicitationField
  }

  if (property.type === "boolean") {
    return {
      key,
      question: {
        ...base,
        options: [
          { label: "Yes", description },
          { label: "No", description },
        ],
        custom: false,
      },
      value: (answers: ReadonlyArray<string>) => {
        if (answers[0] === "Yes") return true
        if (answers[0] === "No") return false
        return property.default ?? undefined
      },
    } satisfies ElicitationField
  }

  return {
    key,
    question: { ...base, options: [], custom: true },
    value: (answers: ReadonlyArray<string>) => {
      const value = answers[0]
      if (value === undefined || value.trim() === "") return property.default ?? undefined
      const parsed = property.type === "integer" ? Number.parseInt(value, 10) : Number(value)
      if (Number.isNaN(parsed)) return property.default ?? undefined
      return parsed
    },
  } satisfies ElicitationField
}

function valueFromLabels(
  values: ReadonlyArray<readonly [string, string]> | undefined,
  answers: ReadonlyArray<string>,
  fallback: string | ReadonlyArray<string> | null | undefined,
) {
  if (!values) return answers[0] ?? fallback ?? undefined
  const selected = answers.flatMap((answer) => values.find(([label]) => label === answer)?.[1] ?? [])
  if (Array.isArray(fallback)) return selected.length ? selected : fallback
  return selected[0] ?? fallback ?? undefined
}

function shortHeader(value: string) {
  return value.length <= 30 ? value : value.slice(0, 30)
}

async function readTextFile(cwd: string, params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
  const content = await Bun.file(resolveACPPath(cwd, params.path)).text()
  if (!params.line && !params.limit) return { content }
  const start = (params.line ?? 1) - 1
  return { content: content.split(/\r?\n/).slice(start, params.limit ? start + params.limit : undefined).join("\n") }
}

async function writeTextFile(cwd: string, params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
  const target = resolveACPPath(cwd, params.path)
  await mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, params.content)
  return {}
}

async function createTerminal(
  input: { readonly cwd: string; readonly terminals: Map<string, Terminal> },
  params: CreateTerminalRequest,
): Promise<CreateTerminalResponse> {
  const terminalId = `claude-acp-terminal-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const output: string[] = []
  const subprocess = Bun.spawn({
    cmd: [params.command, ...(params.args ?? [])],
    cwd: params.cwd ? resolveACPPath(input.cwd, params.cwd) : input.cwd,
    env: params.env ? { ...process.env, ...Object.fromEntries(params.env.map((entry) => [entry.name, entry.value])) } : process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const terminal: Terminal = {
    process: subprocess,
    output,
    limit: params.outputByteLimit ?? 128_000,
    exited: subprocess.exited.then((exitCode) => {
      terminal.exitStatus = { exitCode }
      return terminal.exitStatus
    }),
  }
  input.terminals.set(terminalId, terminal)
  void collect(subprocess.stdout, output, terminal.limit)
  void collect(subprocess.stderr, output, terminal.limit)
  return { terminalId }
}

async function terminalOutput(
  terminals: Map<string, Terminal>,
  params: TerminalOutputRequest,
): Promise<TerminalOutputResponse> {
  const terminal = requireTerminal(terminals, params.terminalId)
  return { output: terminal.output.join(""), truncated: false, exitStatus: terminal.exitStatus }
}

async function waitForTerminalExit(
  terminals: Map<string, Terminal>,
  params: WaitForTerminalExitRequest,
): Promise<WaitForTerminalExitResponse> {
  return requireTerminal(terminals, params.terminalId).exited
}

async function killTerminal(terminals: Map<string, Terminal>, params: KillTerminalRequest): Promise<KillTerminalResponse> {
  requireTerminal(terminals, params.terminalId).process.kill()
  return {}
}

async function releaseTerminal(
  terminals: Map<string, Terminal>,
  params: ReleaseTerminalRequest,
): Promise<ReleaseTerminalResponse> {
  const terminal = requireTerminal(terminals, params.terminalId)
  terminal.process.kill()
  terminals.delete(params.terminalId)
  return {}
}

function requireTerminal(terminals: Map<string, Terminal>, terminalID: string) {
  const terminal = terminals.get(terminalID)
  if (!terminal) throw RequestError.resourceNotFound(terminalID)
  return terminal
}

async function collect(stream: ReadableStream<Uint8Array>, output: string[], limit: number) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const read = await reader.read().catch(() => undefined)
    if (!read || read.done) return
    output.push(decoder.decode(read.value, { stream: true }))
    while (output.join("").length > limit) output.shift()
  }
}

function finish(
  queue: ReturnType<typeof makeQueue>,
  reason: FinishReason,
  usage?: Usage,
  providerMetadata?: ACPProviderMetadata,
) {
  queue.closeBlocks()
  queue.push(LLMEvent.stepFinish({ index: 0, reason, usage, providerMetadata }))
  queue.push(LLMEvent.finish({ reason, usage, providerMetadata }))
  queue.end()
}

function finishReason(reason: string): FinishReason {
  if (reason === "end_turn") return "stop"
  if (reason === "max_tokens") return "length"
  if (reason === "cancelled") return "error"
  if (reason === "refusal") return "content-filter"
  return "unknown"
}

export function claudeUsage(input: ACPUsage | null | undefined, context?: ACPContextUsage) {
  if (!input) return
  const nonCachedInputTokens = token(input.inputTokens)
  const cacheReadInputTokens = token(input.cachedReadTokens)
  const cacheWriteInputTokens = token(input.cachedWriteTokens)
  const inputTokens = (nonCachedInputTokens ?? 0) + (cacheReadInputTokens ?? 0) + (cacheWriteInputTokens ?? 0)
  return new Usage({
    inputTokens,
    outputTokens: token(input.outputTokens),
    nonCachedInputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    reasoningTokens: token(input.thoughtTokens),
    totalTokens: context?.used ?? token(input.totalTokens),
    providerMetadata: { anthropic: context ? { ...input, context } : input },
  })
}

export function claudeContextUsage(context: ACPContextUsage | undefined) {
  if (!context) return
  return new Usage({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: context.used,
    providerMetadata: { anthropic: { context } },
  })
}

export function claudeACPCompactionStatus(text: string) {
  const normalized = text.trim()
  if (normalized === "Compacting...") return "started"
  if (normalized === "Compacting completed.") return "completed"
  return undefined
}

function claudeProviderMetadata(providerCompacted: boolean | undefined): ACPProviderMetadata | undefined {
  if (!providerCompacted) return
  return { anthropic: { acpCompacted: true } }
}

function token(value: number | null | undefined) {
  if (typeof value !== "number") return
  if (!Number.isFinite(value)) return
  return Math.max(0, value)
}

function promptText(messages: ModelMessage[]) {
  const last = messages.at(-1)
  if (last?.role === "user") {
    const text = contentText(last.content).trim()
    if (text.match(/^\/[A-Za-z][\w:-]*(?:\s|$)/)) return text
  }

  return messages
    .map((message) => `${message.role.toUpperCase()}:\n${contentText(message.content)}`)
    .filter((message) => message.trim() !== "")
    .join("\n\n")
}

function currentPromptText(messages: ModelMessage[]) {
  const last = messages.at(-1)
  if (last?.role !== "user") return promptText(messages)
  const text = contentText(last.content).trim()
  return text || promptText(messages)
}

function claudeModelID(modelID: string) {
  if (modelID === "claude" || modelID === "default") return
  if (modelID === "fable") return "claude-fable-5"
  if (modelID === "fable[1m]") return "claude-fable-5[1m]"
  return modelID
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (!value || typeof value !== "object") return JSON.stringify(value)
  return `{${Object.entries(value)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string")
}

function contentText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return JSON.stringify(content)
  return content
    .map((part) => {
      if (part.type === "text") return part.text
      if (part.type === "file") return `[file: ${part.filename ?? part.mediaType}]`
      if (part.type === "image") return "[image]"
      return JSON.stringify(part)
    })
    .join("\n")
}

export function resolveACPPath(cwd: string, value: string) {
  if (path.isAbsolute(value)) return path.resolve(value)
  return path.resolve(cwd, value)
}

function writable(sink: Bun.FileSink): WritableStream<Uint8Array> {
  return new WritableStream({
    write: (chunk) => {
      sink.write(chunk)
      sink.flush()
    },
    close: () => {
      sink.end()
    },
  })
}

function makeQueue() {
  const items: QueueItem[] = []
  const waiting: ((item: QueueItem) => void)[] = []
  let textStarted = false
  let reasoningStarted = false
  return {
    push(event: LLMEventType) {
      offer({ type: "event", event })
    },
    text(text: string) {
      if (!textStarted) {
        textStarted = true
        offer({ type: "event", event: LLMEvent.textStart({ id: TEXT_ID }) })
      }
      offer({ type: "event", event: LLMEvent.textDelta({ id: TEXT_ID, text }) })
    },
    reasoning(text: string) {
      if (!reasoningStarted) {
        reasoningStarted = true
        offer({ type: "event", event: LLMEvent.reasoningStart({ id: REASONING_ID }) })
      }
      offer({ type: "event", event: LLMEvent.reasoningDelta({ id: REASONING_ID, text }) })
    },
    closeBlocks() {
      if (reasoningStarted) {
        reasoningStarted = false
        offer({ type: "event", event: LLMEvent.reasoningEnd({ id: REASONING_ID }) })
      }
      if (textStarted) {
        textStarted = false
        offer({ type: "event", event: LLMEvent.textEnd({ id: TEXT_ID }) })
      }
    },
    end() {
      offer({ type: "done" })
    },
    fail(error: unknown) {
      offer({ type: "error", error })
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        const item = items.shift() ?? (await new Promise<QueueItem>((resolve) => waiting.push(resolve)))
        if (item.type === "event") {
          yield item.event
          continue
        }
        if (item.type === "error") throw item.error
        return
      }
    },
  }

  function offer(item: QueueItem) {
    const resolve = waiting.shift()
    if (resolve) {
      resolve(item)
      return
    }
    items.push(item)
  }
}

export * as ClaudeACP from "./claude-acp"
