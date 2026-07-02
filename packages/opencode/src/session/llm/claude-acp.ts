import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ClientSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream } from "@agentclientprotocol/sdk"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type {
  Client,
  CreateTerminalRequest,
  CreateTerminalResponse,
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
import { LLMEvent, type LLMEvent as LLMEventType } from "@opencode-ai/llm"
import type { ModelMessage } from "ai"
import { createTwoFilesPatch } from "diff"
import * as Stream from "effect/Stream"

type PermissionBridge = {
  readonly ask: (input: PermissionV1.AskInput) => Promise<PermissionV1.Reply>
  readonly reply: (input: PermissionV1.ReplyInput) => Promise<void>
}

type StreamInput = {
  readonly cwd: string
  readonly sessionID: PermissionV1.AskInput["sessionID"]
  readonly modelID: string
  readonly mcpServers: readonly McpServer[]
  readonly messages: ModelMessage[]
  readonly abort: AbortSignal
  readonly ruleset: PermissionV1.Ruleset
  readonly permission: PermissionBridge
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
  }
  disposeTimer?: ReturnType<typeof setTimeout>
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
    disposeConnection(connection)
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
        }
        try {
          await activeConnection.client.prompt({
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
            finish(queue, "error")
            return
          }
          finish(queue, "stop")
        } finally {
          activeConnection.active = undefined
          cleanupTerminals(activeConnection)
          scheduleDispose(activeConnection)
        }
      })
    } catch (error) {
      if (connection) {
        connection.active = undefined
        cleanupTerminals(connection)
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
  return error instanceof Error ? error.message : String(error)
}

function abortError() {
  return new DOMException("Aborted", "AbortError")
}

function claudeEnv(modelID: string) {
  return {
    ...process.env,
    ANTHROPIC_MODEL: claudeModelID(modelID),
  }
}

function makeClient(connection: Connection): Client {
  return {
    sessionUpdate: async (params: SessionNotification) => sessionUpdate(connection.active?.queue, params),
    requestPermission: (params) => requestPermission(connection, params),
    readTextFile: (params) => readTextFile(connection.active?.cwd ?? connection.cwd, params),
    writeTextFile: (params) => writeTextFile(connection.active?.cwd ?? connection.cwd, params),
    createTerminal: (params) => createTerminal(connection, params),
    terminalOutput: (params) => terminalOutput(connection.terminals, params),
    waitForTerminalExit: (params) => waitForTerminalExit(connection.terminals, params),
    killTerminal: (params) => killTerminal(connection.terminals, params),
    releaseTerminal: (params) => releaseTerminal(connection.terminals, params),
  }
}

function sessionUpdate(queue: ReturnType<typeof makeQueue> | undefined, params: SessionNotification) {
  if (!queue) return
  if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") {
    queue.text(params.update.content.text)
    return
  }
  if (params.update.sessionUpdate === "agent_thought_chunk" && params.update.content.type === "text") {
    queue.reasoning(params.update.content.text)
  }
}

async function requestPermission(
  connection: Connection,
  params: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  const active = connection.active
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
      ruleset: active.ruleset,
    })
    return allowPermission(params, reply)
  } catch {
    if (active.abort.aborted) return cancelledPermission()
    return rejectPermission(params)
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
    metadata.filepath = diff.path
    metadata.filePath = diff.path
    metadata.diff = createTwoFilesPatch(diff.path, diff.path, diff.oldText ?? "", diff.newText)
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

async function readTextFile(cwd: string, params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
  const content = await Bun.file(scoped(cwd, params.path)).text()
  if (!params.line && !params.limit) return { content }
  const start = (params.line ?? 1) - 1
  return { content: content.split(/\r?\n/).slice(start, params.limit ? start + params.limit : undefined).join("\n") }
}

async function writeTextFile(cwd: string, params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
  const target = scoped(cwd, params.path)
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
    cwd: params.cwd ? scoped(input.cwd, params.cwd) : input.cwd,
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

function finish(queue: ReturnType<typeof makeQueue>, reason: "stop" | "error") {
  queue.closeBlocks()
  queue.push(LLMEvent.stepFinish({ index: 0, reason }))
  queue.push(LLMEvent.finish({ reason }))
  queue.end()
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
  if (modelID === "claude") return "default"
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

function scoped(cwd: string, value: string) {
  const target = path.resolve(cwd, value)
  const root = path.resolve(cwd)
  if (target === root || target.startsWith(`${root}${path.sep}`)) return target
  throw RequestError.invalidParams({ path: value }, "Path is outside the session workspace")
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
