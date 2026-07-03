import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { assistantContextTokens, isDefaultTitle } from "../../src/util/session"

describe("util.session", () => {
  test("recognizes generated parent and child titles", () => {
    expect(isDefaultTitle("New session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("Child session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("New session - custom")).toBeFalse()
  })

  test("uses provider total for assistant context when available", () => {
    const message = {
      tokens: {
        total: 34_452,
        input: 30_000,
        output: 4_000,
        reasoning: 452,
        cache: {
          read: 32_000,
          write: 700,
        },
      },
    } as AssistantMessage

    expect(assistantContextTokens(message)).toBe(34_452)
  })

  test("sums assistant tokens when provider total is unavailable", () => {
    const message = {
      tokens: {
        input: 30_000,
        output: 4_000,
        reasoning: 452,
        cache: {
          read: 32_000,
          write: 700,
        },
      },
    } as AssistantMessage

    expect(assistantContextTokens(message)).toBe(67_152)
  })
})
