import { describe, expect, it } from "bun:test"
import {
  claudeACPCompactionStatus,
  claudeACPElicitationContent,
  claudeACPElicitationFields,
  claudeACPPermissionRuleset,
  requestPermissionForActive,
  resolveACPPath,
  claudeContextUsage,
  claudeUsage,
} from "@/session/llm/claude-acp"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk"
import { SessionID } from "../../src/session/schema"

describe("Claude ACP compaction status", () => {
  it("recognizes Claude ACP compaction control messages", () => {
    expect(claudeACPCompactionStatus("Compacting...")).toBe("started")
    expect(claudeACPCompactionStatus("\n\nCompacting completed.")).toBe("completed")
    expect(claudeACPCompactionStatus("Compacting failed: too much context")).toBeUndefined()
    expect(claudeACPCompactionStatus("Compacting the answer now.")).toBeUndefined()
  })
})

describe("Claude ACP usage", () => {
  it("maps ACP usage into inclusive OpenCode token usage", () => {
    const usage = claudeUsage({
      inputTokens: 100,
      outputTokens: 25,
      cachedReadTokens: 30,
      cachedWriteTokens: 10,
      thoughtTokens: 5,
      totalTokens: 165,
    })

    expect(usage?.inputTokens).toBe(140)
    expect(usage?.nonCachedInputTokens).toBe(100)
    expect(usage?.cacheReadInputTokens).toBe(30)
    expect(usage?.cacheWriteInputTokens).toBe(10)
    expect(usage?.outputTokens).toBe(25)
    expect(usage?.reasoningTokens).toBe(5)
    expect(usage?.totalTokens).toBe(165)
  })

  it("uses ACP context usage as the reported total when available", () => {
    const usage = claudeUsage(
      {
        inputTokens: 100,
        outputTokens: 25,
        cachedReadTokens: 30,
        cachedWriteTokens: 10,
        totalTokens: 165,
      },
      { used: 32_000, size: 1_000_000 },
    )

    expect(usage?.inputTokens).toBe(140)
    expect(usage?.outputTokens).toBe(25)
    expect(usage?.totalTokens).toBe(32_000)
    expect(usage?.providerMetadata?.anthropic).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cachedReadTokens: 30,
      cachedWriteTokens: 10,
      totalTokens: 165,
      context: { used: 32_000, size: 1_000_000 },
    })
  })

  it("omits usage when Claude ACP does not report it", () => {
    expect(claudeUsage(undefined)).toBeUndefined()
    expect(claudeUsage(null)).toBeUndefined()
  })

  it("creates context-only usage from ACP usage updates", () => {
    const usage = claudeContextUsage({ used: 48_000, size: 200_000 })

    expect(usage?.inputTokens).toBe(0)
    expect(usage?.outputTokens).toBe(0)
    expect(usage?.totalTokens).toBe(48_000)
    expect(usage?.providerMetadata?.anthropic).toEqual({
      context: { used: 48_000, size: 200_000 },
    })
  })
})

describe("Claude ACP elicitation", () => {
  it("maps ACP form enum choices through OpenCode questions", () => {
    const fields = claudeACPElicitationFields({
      mode: "form",
      sessionId: "ses_123",
      message: "Choose research depth",
      requestedSchema: {
        properties: {
          depth: {
            type: "string",
            title: "Depth",
            oneOf: [
              { title: "Quick", const: "quick" },
              { title: "Deep", const: "deep" },
            ],
          },
          includeSources: {
            type: "boolean",
            title: "Include sources",
          },
        },
      },
    })

    expect(fields.map((field) => field.question)).toEqual([
      {
        header: "Depth",
        question: "Depth",
        options: [
          { label: "Quick", description: "quick" },
          { label: "Deep", description: "deep" },
        ],
        custom: false,
      },
      {
        header: "Include sources",
        question: "Include sources",
        options: [
          { label: "Yes", description: "Choose research depth" },
          { label: "No", description: "Choose research depth" },
        ],
        custom: false,
      },
    ])
    expect(claudeACPElicitationContent(fields, [["Deep"], ["Yes"]])).toEqual({
      depth: "deep",
      includeSources: true,
    })
  })

  it("maps ACP multi-select and numeric answers back to content values", () => {
    const fields = claudeACPElicitationFields({
      mode: "form",
      sessionId: "ses_123",
      message: "Configure report",
      requestedSchema: {
        properties: {
          sections: {
            type: "array",
            title: "Sections",
            items: {
              anyOf: [
                { title: "Economy", const: "economy" },
                { title: "Politics", const: "politics" },
              ],
            },
          },
          limit: {
            type: "integer",
            title: "Limit",
          },
        },
      },
    })

    expect(fields[0]?.question.multiple).toBe(true)
    expect(claudeACPElicitationContent(fields, [["Economy", "Politics"], ["3"]])).toEqual({
      sections: ["economy", "politics"],
      limit: 3,
    })
  })
})

describe("Claude ACP permissions", () => {
  it("forces native prompts for explicit ACP permission requests over inherited denies", () => {
    expect(
      claudeACPPermissionRuleset("bash", ["bun test"]),
    ).toEqual([
      { permission: "bash", pattern: "bun test", action: "ask" },
    ])
  })

  it("cancels ACP permission requests when the OpenCode bridge fails before user selection", async () => {
    const abort = new AbortController()

    const result = await requestPermissionForActive(
      {
        sessionID: SessionID.make("ses_test"),
        abort: abort.signal,
        permission: {
          ask: async () => {
            throw new PermissionV1.NotFoundError({ requestID: PermissionV1.ID.make("per_missing") })
          },
          reply: async () => {},
        },
      },
      permissionRequest(),
    )

    expect(result).toEqual({ outcome: { outcome: "cancelled" } })
  })

  it("keeps explicit OpenCode permission rejections as ACP reject selections", async () => {
    const abort = new AbortController()

    const result = await requestPermissionForActive(
      {
        sessionID: SessionID.make("ses_test"),
        abort: abort.signal,
        permission: {
          ask: async () => {
            throw new PermissionV1.RejectedError()
          },
          reply: async () => {},
        },
      },
      permissionRequest(),
    )

    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "deny" } })
  })

  it("still asks for edit permission when Claude sends incomplete diff content", async () => {
    const abort = new AbortController()
    const replies: PermissionV1.AskInput[] = []

    const result = await requestPermissionForActive(
      {
        sessionID: SessionID.make("ses_test"),
        abort: abort.signal,
        permission: {
          ask: async (input) => {
            replies.push(input)
            return "once"
          },
          reply: async () => {},
        },
      },
      editPermissionRequestWithIncompleteDiff(),
    )

    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } })
    expect(replies).toHaveLength(1)
    expect(replies[0]?.permission).toBe("edit")
    expect(replies[0]?.patterns).toEqual(["C:/Users/matt/new-file.txt"])
  })
})

describe("Claude ACP filesystem", () => {
  it("keeps absolute ACP file paths instead of scoping them under cwd", () => {
    expect(resolveACPPath("C:/Users/matt/Projects/opencode", "C:/Users/matt/acp-permission-test.txt")).toBe(
      "C:\\Users\\matt\\acp-permission-test.txt",
    )
  })
})

function permissionRequest() {
  return {
    sessionId: "claude_session",
    toolCall: {
      toolCallId: "call_1",
      kind: "execute",
      title: "printf hello",
      rawInput: { command: "printf hello" },
    },
    options: [
      { optionId: "allow", kind: "allow_once", name: "Allow" },
      { optionId: "deny", kind: "reject_once", name: "Deny" },
    ],
  } satisfies RequestPermissionRequest
}

function editPermissionRequestWithIncompleteDiff() {
  const content = [
    {
      type: "diff",
      path: "C:/Users/matt/new-file.txt",
    } as NonNullable<RequestPermissionRequest["toolCall"]["content"]>[number],
  ]

  return {
    sessionId: "claude_session",
    toolCall: {
      toolCallId: "call_edit",
      kind: "edit",
      title: "Create C:/Users/matt/new-file.txt",
      rawInput: { filePath: "C:/Users/matt/new-file.txt" },
      content,
    },
    options: [
      { optionId: "allow", kind: "allow_once", name: "Allow" },
      { optionId: "deny", kind: "reject_once", name: "Deny" },
    ],
  } satisfies RequestPermissionRequest
}
