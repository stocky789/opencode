import { describe, expect, it } from "bun:test"
import { claudeUsage } from "@/session/llm/claude-acp"

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

  it("omits usage when Claude ACP does not report it", () => {
    expect(claudeUsage(undefined)).toBeUndefined()
    expect(claudeUsage(null)).toBeUndefined()
  })
})
