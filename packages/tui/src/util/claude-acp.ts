export const ClaudeACPProviderID = "claude-acp"

type ClaudeACPSlashCommand = {
  readonly name: string
  readonly hint?: string
  readonly description: string
}

export const ClaudeACPSlashCommands: readonly ClaudeACPSlashCommand[] = [
  {
    name: "compact",
    hint: "<instructions>",
    description: "Summarize the current conversation context",
  },
  {
    name: "config",
    hint: "key=value",
    description: "Update Claude Code configuration",
  },
  {
    name: "context",
    description: "Show current context usage",
  },
  {
    name: "debug",
    hint: "[issue description]",
    description: "Enable debug logging for this session",
  },
  {
    name: "effort",
    hint: "[low|medium|high|max|auto]",
    description: "Set Claude Code reasoning effort",
  },
  {
    name: "heapdump",
    description: "Dump the JS heap to Desktop",
  },
  {
    name: "init",
    description: "Initialize CLAUDE.md guidance",
  },
  {
    name: "model",
    hint: "[model]",
    description: "Switch the Claude Code model",
  },
  {
    name: "reload-skills",
    description: "Reload Claude Code skills from disk",
  },
  {
    name: "review",
    hint: "[pr number]",
    description: "Review a pull request",
  },
  {
    name: "security-review",
    description: "Review pending changes for security issues",
  },
  {
    name: "usage",
    description: "Show session usage",
  },
  {
    name: "usage-credits",
    description: "Configure usage credits",
  },
  {
    name: "extra-usage",
    description: "Alias for usage credits",
  },
  {
    name: "insights",
    description: "Analyze Claude Code sessions",
  },
  {
    name: "goal",
    description: "Set a goal for Claude Code to work toward",
  },
  {
    name: "team-onboarding",
    description: "Create teammate onboarding guidance from Claude Code usage",
  },
]

const ClaudeACPSlashCommandNames = new Set<string>(ClaudeACPSlashCommands.map((command) => command.name))

export function isClaudeACPSlashCommand(command: string) {
  return ClaudeACPSlashCommandNames.has(command.replace(/^\//, ""))
}
