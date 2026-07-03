import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"

export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

export function assistantContextTokens(message: AssistantMessage) {
  return (
    message.tokens.total ??
    message.tokens.input +
      message.tokens.output +
      message.tokens.reasoning +
      message.tokens.cache.read +
      message.tokens.cache.write
  )
}

export function latestAssistantContextMessage(messages: readonly Message[]) {
  const withUsage = (message: Message): message is AssistantMessage =>
    message.role === "assistant" && assistantContextTokens(message) > 0
  return messages.reduce<AssistantMessage | undefined>((max, message) => {
    if (!withUsage(message)) return max
    if (!max || assistantContextTokens(message) >= assistantContextTokens(max)) return message
    return max
  }, undefined)
}
