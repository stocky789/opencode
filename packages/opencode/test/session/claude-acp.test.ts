import { describe, expect, test } from "bun:test"
import type { CreateElicitationRequest, RequestPermissionRequest } from "@agentclientprotocol/sdk"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionID } from "../../src/session/schema"
import { ClaudeACPTest } from "../../src/session/llm/claude-acp"

const sessionID = SessionID.make("ses_claude_acp")

describe("Claude ACP adapter", () => {
  test("routes ACP permission requests through native permission prompts", async () => {
    const harness = createHarness({ permissionReply: "once" })
    const response = await ClaudeACPTest.requestPermissionForActive(harness.active, executePermission())

    expect(harness.permissions).toHaveLength(1)
    expect(harness.permissions[0]).toMatchObject({
      sessionID,
      permission: "bash",
      patterns: ["bun test"],
      always: ["bun test"],
      metadata: {
        command: "bun test",
        kind: "execute",
        title: "bun test",
        toolCallId: "tool_execute",
      },
      ruleset: [{ permission: "bash", pattern: "bun test", action: "ask" }],
    })
    expect(response).toEqual({ outcome: { outcome: "selected", optionId: "allow" } })
  })

  test("returns the ACP always-allow option when native permission allows always", async () => {
    const harness = createHarness({ permissionReply: "always" })
    const response = await ClaudeACPTest.requestPermissionForActive(harness.active, executePermission())

    expect(response).toEqual({ outcome: { outcome: "selected", optionId: "allow_always" } })
  })

  test("forces native prompts for explicit ACP permission requests", async () => {
    const harness = createHarness({
      permissionReply: "once",
      ruleset: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    await ClaudeACPTest.requestPermissionForActive(harness.active, executePermission())

    expect(harness.permissions[0]?.ruleset).toEqual([{ permission: "bash", pattern: "bun test", action: "ask" }])
  })

  test("advertises form elicitation so Claude can ask interactive questions", () => {
    expect(ClaudeACPTest.clientCapabilities()).toMatchObject({
      elicitation: { form: {} },
    })
  })

  test("routes ACP form elicitation through native question prompts", async () => {
    const harness = createHarness({ questionAnswers: [["Minimal"], ["UI", "Tests"]] })
    const response = await ClaudeACPTest.createElicitationForActive(harness.active, askUserQuestionElicitation())

    expect(harness.questions).toEqual([
      {
        sessionID,
        questions: [
          {
            question: "Which implementation path should Claude take?",
            header: "Approach",
            options: [
              { label: "Minimal", description: "Small scoped fix" },
              { label: "Broad", description: "Larger refactor" },
            ],
            custom: true,
          },
          {
            question: "Which areas should Claude inspect?",
            header: "Areas",
            options: [
              { label: "UI", description: "UI" },
              { label: "Tests", description: "Tests" },
            ],
            multiple: true,
          },
        ],
      },
    ])
    expect(response).toEqual({
      action: "accept",
      content: {
        question_0: "Minimal",
        question_1: ["UI", "Tests"],
      },
    })
  })

  test("sends custom answers back using Claude's custom field", async () => {
    const harness = createHarness({ questionAnswers: [["Use the existing permission footer"], []] })
    const response = await ClaudeACPTest.createElicitationForActive(harness.active, askUserQuestionElicitation())

    expect(response).toEqual({
      action: "accept",
      content: {
        question_0_custom: "Use the existing permission footer",
      },
    })
  })
})

function createHarness(input: {
  readonly permissionReply?: PermissionV1.Reply
  readonly questionAnswers?: readonly (readonly string[])[]
  readonly ruleset?: PermissionV1.Ruleset
}) {
  const permissions: PermissionV1.AskInput[] = []
  const questions: Array<{
    readonly sessionID: typeof sessionID
    readonly questions: readonly {
      readonly question: string
      readonly header: string
      readonly options: readonly { readonly label: string; readonly description: string }[]
      readonly multiple?: boolean
      readonly custom?: boolean
    }[]
  }> = []
  const abort = new AbortController()
  return {
    active: {
      sessionID,
      abort: abort.signal,
      ruleset: input.ruleset ?? ([{ permission: "bash", pattern: "*", action: "ask" }] satisfies PermissionV1.Ruleset),
      permission: {
        ask: (request: PermissionV1.AskInput) => {
          permissions.push(request)
          return Promise.resolve(input.permissionReply ?? "once")
        },
        reply: () => Promise.resolve(),
      },
      question: {
        ask: (request: (typeof questions)[number]) => {
          questions.push(request)
          return Promise.resolve(input.questionAnswers ?? [])
        },
      },
    },
    permissions,
    questions,
  }
}

function executePermission(): RequestPermissionRequest {
  return {
    sessionId: "claude_session",
    toolCall: {
      toolCallId: "tool_execute",
      status: "pending",
      title: "bun test",
      kind: "execute",
      rawInput: { command: "bun test" },
      locations: [],
    },
    options: [
      { optionId: "allow_always", kind: "allow_always", name: "Allow always" },
      { optionId: "allow", kind: "allow_once", name: "Allow" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ],
  }
}

function askUserQuestionElicitation(): CreateElicitationRequest {
  return {
    mode: "form",
    sessionId: "claude_session",
    toolCallId: "tool_question",
    message: "Claude needs more input",
    requestedSchema: {
      type: "object",
      properties: {
        question_0: {
          type: "string",
          title: "Approach",
          description: "Which implementation path should Claude take?",
          oneOf: [
            { const: "Minimal", title: "Small scoped fix" },
            { const: "Broad", title: "Larger refactor" },
          ],
        },
        question_0_custom: {
          type: "string",
          title: "Custom approach",
          description: "Custom approach",
        },
        question_1: {
          type: "array",
          title: "Areas",
          description: "Which areas should Claude inspect?",
          items: {
            anyOf: [
              { const: "UI", title: "UI" },
              { const: "Tests", title: "Tests" },
            ],
          },
        },
      },
      required: ["question_0"],
    },
  }
}
