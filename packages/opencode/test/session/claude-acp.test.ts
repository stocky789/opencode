import { describe, expect, it } from "bun:test"
import { claudeACPCompactionStatus, claudeUsage } from "@/session/llm/claude-acp"

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
})
