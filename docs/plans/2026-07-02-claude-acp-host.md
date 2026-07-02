# Claude ACP Host Experience Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a native, Zed-style Claude ACP experience to OpenCode so a user can select Claude as an external agent, have OpenCode start/control the Claude ACP process, and use OpenCode's UI for prompts, slash commands, MCP servers, permissions, file edits, diffs, terminals, cancellation, and session history.

**Architecture:** Keep the existing `opencode acp` implementation as OpenCode-as-ACP-agent. Add a separate ACP host/client subsystem in the server/core path so OpenCode can host external ACP agents such as Claude. External ACP sessions stay separate from native `SessionV2` execution and are projected into the app timeline through a dedicated external-session API.

**Tech Stack:** Bun, TypeScript, Effect, Effect HttpApi, OpenCode Schema/Core/Protocol/Server/App packages, `@agentclientprotocol/sdk`, existing EventV2, existing PTY services, existing permission and session UI components.

---

## Source Findings

Zed has two Claude integrations:

- Claude Code terminal threads run the normal CLI inside a terminal-like UI. This is not the native ACP agent experience.
- Claude ACP external agents run an ACP-speaking Claude process and let Zed render the conversation natively.

The native path works like this:

1. Zed resolves a configured agent command such as the Claude ACP agent.
2. Zed starts the command as a child process with stdin/stdout/stderr piped.
3. Zed speaks ACP JSON-RPC over stdio.
4. Zed sends `initialize`, opens or resumes an ACP session, then sends prompts.
5. Claude streams `SessionUpdate` notifications back.
6. Claude can ask the host for permissions, text file reads/writes, and terminals.
7. Zed renders messages, thinking, tool calls, plans, diffs, usage, commands, and auth state in its Agent Panel.

OpenCode already implements the opposite direction:

- `packages/opencode/src/cli/cmd/acp.ts` starts OpenCode's ACP server.
- `packages/opencode/src/acp/agent.ts` implements ACP agent-side methods.
- `packages/opencode/src/acp/service.ts` maps ACP requests to OpenCode sessions, commands, models, and MCP registration.
- `packages/opencode/src/acp/event.ts` maps OpenCode events to ACP session updates.
- `packages/opencode/src/acp/permission.ts` maps OpenCode permission prompts to ACP permission requests.
- `packages/opencode/src/acp/tool.ts` maps OpenCode tool parts to ACP tool updates.

Do not modify that code path to host Claude. The new work is an ACP host/client path.

---

## Implementation Guardrails

- Keep native `SessionV2` and external ACP sessions separate.
- Do not turn Claude into an OpenCode LLM provider.
- Do not route Claude prompts through `SessionRunner`.
- Do not change `opencode acp` behavior except shared dependency movement if needed.
- Do not import Core or Server from Protocol, Client, or Schema.
- After Protocol or Server HttpApi changes, run `bun run generate` from `packages/client`.
- Run tests and typechecks from package directories, never from the repo root.
- Keep Claude-specific behavior in a descriptor/adapter. The host core should support generic ACP agents.

---

## Phase 0: Prove the ACP Host Boundary

### Task 0.1: Confirm the SDK client API

**Objective:** Identify the exact `@agentclientprotocol/sdk` exports needed for an ACP host/client.

**Files:**

- Inspect: `packages/opencode/package.json`
- Inspect: `bun.lock`
- Inspect: `packages/opencode/src/acp/agent.ts`
- Inspect: `packages/opencode/src/cli/cmd/acp.ts`

**Steps:**

- [ ] From `packages/opencode`, run a small temporary type inspection or use editor navigation to identify SDK exports for:
  - JSON-RPC transport over stdio;
  - client-side connection;
  - ACP request/response types;
  - session notification types;
  - client request handlers such as permission, file IO, and terminal calls.
- [ ] Decide whether `@agentclientprotocol/sdk` must move to `packages/core/package.json`.
- [ ] If Core will own the ACP host service, add the SDK to `@opencode-ai/core` dependencies and keep `opencode` depending on it only if the existing ACP server path still imports it directly.
- [ ] Record the chosen SDK surface in this plan or in the PR description.

**Verification:**

- [ ] `cd packages/core && bun typecheck` succeeds after dependency changes.
- [ ] `cd packages/opencode && bun typecheck` succeeds after dependency changes.

### Task 0.2: Add a fake ACP agent fixture

**Objective:** Create a deterministic ACP child process for host tests before implementing Claude-specific behavior.

**Files:**

- Create: `packages/core/test/acp-host/fixture/fake-acp-agent.ts`
- Create: `packages/core/test/acp-host/fixture/json-rpc.ts`

**Implementation notes:**

- The fake process should read newline-delimited JSON-RPC from stdin and write newline-delimited JSON-RPC to stdout.
- It should support at least:
  - `initialize`;
  - `session/new`;
  - `session/prompt`;
  - `session/cancel`;
  - a test-only method or environment flag that makes it request permission, file IO, or terminal access.
- Keep stderr available for crash/error tests.

**Verification:**

- [ ] `cd packages/core && bun test test/acp-host/fixture` runs and proves the fixture can answer one JSON-RPC request.

---

## Phase 1: Add Shared External ACP Types

### Task 1.1: Add public external-agent schema

**Objective:** Define the public types used by Protocol, Server, Client, and App without importing the ACP SDK into those packages.

**Files:**

- Create: `packages/schema/src/external-agent.ts`
- Modify: `packages/schema/src/event-manifest.ts` later when external session events are added.

**Types to define:**

- `ExternalAgent.ID`
- `ExternalAgent.Type = "acp"`
- `ExternalAgent.Info`
- `ExternalAgent.Status`
- `ExternalAgent.AuthMethod`
- `ExternalAgent.Command`
- `ExternalAgent.Mode`
- `ExternalAgent.ConfigOption`
- `ExternalAgent.Session`
- `ExternalAgent.Entry`
- `ExternalAgent.Event` namespace for durable external session events in Phase 4.

**Shape sketch:**

```ts
export * as ExternalAgent from "./external-agent"

import { Schema } from "effect"
import { Location } from "./location"
import { Prompt } from "./prompt"

export const ID = Schema.String.pipe(Schema.brand("ExternalAgentID"))
export type ID = typeof ID.Type

export const Type = Schema.Literal("acp")

export const Status = Schema.Union(
  Schema.Struct({ type: Schema.Literal("idle") }),
  Schema.Struct({ type: Schema.Literal("starting") }),
  Schema.Struct({ type: Schema.Literal("auth-required") }),
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("errored"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("exited"), code: Schema.Number.pipe(Schema.optional) }),
)

export const Info = Schema.Struct({
  id: ID,
  type: Type,
  name: Schema.String,
  status: Status,
})

export const Session = Schema.Struct({
  id: Schema.String,
  agentID: ID,
  location: Location.Ref,
  title: Schema.String.pipe(Schema.optional),
  created: Schema.Number,
  updated: Schema.Number,
})

export const PromptInput = Schema.Struct({
  prompt: Prompt,
})
```

Keep the final schemas aligned with existing schema style and do not use `any`.

**Tests:**

- Create: `packages/opencode/test/schema/external-agent.test.ts` if schema tests live there, otherwise use the nearest existing schema test location.

**Verification:**

- [ ] Schema encode/decode tests pass.
- [ ] `cd packages/schema && bun typecheck` passes.

### Task 1.2: Add config schema for hosted ACP agents

**Objective:** Let users configure Claude and future ACP agents without confusing them with native OpenCode agents.

**Files:**

- Create: `packages/core/src/config/external-agent.ts`
- Modify: `packages/core/src/config.ts`
- Test: `packages/opencode/test/config/external-agent.test.ts`

**Config shape:**

```jsonc
{
  "external_agents": {
    "claude": {
      "type": "acp",
      "enabled": true,
      "command": "claude",
      "args": ["--acp"],
      "env": {
        "ANTHROPIC_API_KEY": ""
      },
      "mcp": "forward"
    }
  }
}
```

**Implementation notes:**

- Add `export * as ConfigExternalAgent from "./external-agent"` at the top of the new config file.
- Import `ConfigExternalAgent` in `packages/core/src/config.ts`.
- Add `external_agents: Schema.Record(Schema.String, ConfigExternalAgent.Info).pipe(Schema.optional)` to `Config.Info`.
- Use `mcp: "forward" | "disabled" | "configured-only"` only if implementation needs it. Start with the smallest useful shape.
- The exact Claude command and args must be verified during implementation. Keep them configurable.

**Tests:**

- [ ] Decode a minimal ACP agent config.
- [ ] Decode env and args.
- [ ] Reject a config with an unsupported `type`.
- [ ] Verify old config documents still decode.

**Verification:**

- [ ] `cd packages/opencode && bun test test/config/external-agent.test.ts`
- [ ] `cd packages/core && bun typecheck`

---

## Phase 2: Build the ACP Host Core Service

### Task 2.1: Create the ACP host module skeleton

**Objective:** Add a Core service boundary that can be injected into Server routes.

**Files:**

- Create: `packages/core/src/acp-host/index.ts`
- Create: `packages/core/src/acp-host/error.ts`
- Create: `packages/core/src/acp-host/process.ts`
- Create: `packages/core/src/acp-host/connection.ts`
- Create: `packages/core/src/acp-host/registry.ts`
- Create: `packages/core/src/acp-host/session.ts`
- Modify: `packages/core/package.json` if SDK dependency is moved here.

**Service sketch:**

```ts
export * as AcpHost from "./acp-host"

import { Context, Effect } from "effect"
import { ExternalAgent } from "@opencode-ai/schema/external-agent"

export interface Interface {
  readonly list: () => Effect.Effect<ExternalAgent.Info[]>
  readonly connect: (agentID: ExternalAgent.ID) => Effect.Effect<ExternalAgent.Info>
  readonly restart: (agentID: ExternalAgent.ID) => Effect.Effect<ExternalAgent.Info>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AcpHost") {}
```

**Implementation notes:**

- Use one process-level connection per `(location, agentID)` unless a later task proves a different scope is required.
- Load config through `Config.Service`.
- Resolve location through `Location.Service`.
- Use named service bindings in Effect generators.
- Keep child process management in `process.ts`, JSON-RPC/SDK connection in `connection.ts`, and config lookup in `registry.ts`.

**Verification:**

- [ ] `cd packages/core && bun typecheck` passes with empty service methods implemented as no-op/failing placeholders.

### Task 2.2: Implement child process start and stop

**Objective:** Start an ACP agent as a background process with controlled lifecycle.

**Files:**

- Modify: `packages/core/src/acp-host/process.ts`
- Test: `packages/core/test/acp-host/process.test.ts`

**Behavior:**

- Resolve command and args from config.
- Spawn with stdin/stdout/stderr piped.
- Inherit process env, then apply configured env overrides.
- Track `pid`, `startedAt`, `stderrTail`, and exit code.
- Kill the child when the service finalizer runs.
- Surface command-not-found and early-exit as typed errors.

**Tests:**

- [ ] Starts the fake ACP agent.
- [ ] Captures stderr tail.
- [ ] Reports early exit.
- [ ] Stops process on finalizer.

**Verification:**

- [ ] `cd packages/core && bun test test/acp-host/process.test.ts`

### Task 2.3: Implement initialize handshake

**Objective:** Establish an ACP connection and validate protocol compatibility.

**Files:**

- Modify: `packages/core/src/acp-host/connection.ts`
- Test: `packages/core/test/acp-host/connection.test.ts`

**Behavior:**

- Send `initialize` with:
  - OpenCode client info;
  - supported protocol version;
  - client capabilities for terminal auth, file IO, permission requests, terminals, images, and MCP transports as implementation support lands.
- Store:
  - agent info;
  - protocol version;
  - capabilities;
  - auth methods;
  - initial status.
- If the agent reports an incompatible protocol version, stop the child and return a typed error.

**Tests:**

- [ ] Successful initialize transitions to `ready`.
- [ ] Auth-required initialize transitions to `auth-required`.
- [ ] Protocol mismatch returns a typed error.

**Verification:**

- [ ] `cd packages/core && bun test test/acp-host/connection.test.ts`

### Task 2.4: Add connection registry

**Objective:** Reuse and supervise active ACP agent connections.

**Files:**

- Modify: `packages/core/src/acp-host/registry.ts`
- Modify: `packages/core/src/acp-host/index.ts`
- Test: `packages/core/test/acp-host/registry.test.ts`

**Behavior:**

- `list()` returns configured external agents plus current connection status.
- `connect(agentID)` starts the process only once for the active location.
- `restart(agentID)` stops and reconnects.
- Process exit updates the status and wakes subscribers.
- Missing config or missing binary returns a clear error.

**Tests:**

- [ ] Two `connect` calls for the same agent reuse one process.
- [ ] `restart` creates a new process.
- [ ] Missing agent ID fails with a typed error.

**Verification:**

- [ ] `cd packages/core && bun test test/acp-host/registry.test.ts`

---

## Phase 3: Add External Session Protocol and Server Routes

### Task 3.1: Add Protocol group

**Objective:** Expose external ACP agents and sessions through generated client APIs.

**Files:**

- Create: `packages/protocol/src/groups/external-agent.ts`
- Modify: `packages/protocol/src/api.ts`
- Modify: `packages/protocol/src/errors.ts` if new errors are needed.

**Endpoints:**

```text
GET  /api/external-agent
POST /api/external-agent/:agentID/connect
POST /api/external-agent/:agentID/restart

GET  /api/external-agent/:agentID/session
POST /api/external-agent/:agentID/session
GET  /api/external-agent/:agentID/session/:sessionID
POST /api/external-agent/:agentID/session/:sessionID/resume
POST /api/external-agent/:agentID/session/:sessionID/prompt
POST /api/external-agent/:agentID/session/:sessionID/cancel
POST /api/external-agent/:agentID/session/:sessionID/close
GET  /api/external-agent/:agentID/session/:sessionID/history
GET  /api/external-agent/:agentID/session/:sessionID/events
```

**Implementation notes:**

- Follow the style in `packages/protocol/src/groups/session.ts`.
- Use `LocationGroup` middleware for agent list/connect/create session.
- Do not use native session middleware for external sessions unless an external-session-specific middleware is introduced.
- Keep route names visibly external to avoid collisions with `/api/session`.

**Verification:**

- [ ] `cd packages/protocol && bun typecheck`

### Task 3.2: Add Server handler

**Objective:** Wire Protocol endpoints to the ACP host Core service.

**Files:**

- Create: `packages/server/src/handlers/external-agent.ts`
- Modify: `packages/server/src/handlers.ts`
- Modify: `packages/server/src/routes.ts`

**Implementation notes:**

- Add `AcpHost.node` or equivalent to `applicationServices` in `packages/server/src/routes.ts`.
- Add `ExternalAgentHandler` to `Layer.mergeAll(...)` in `packages/server/src/handlers.ts`.
- Follow `packages/server/src/handlers/session.ts` for error mapping style.

**Initial route behavior:**

- `external-agent.list` returns configured agents and status.
- `external-agent.connect` initializes the child process.
- `external-agent.restart` restarts it.
- Session routes can return typed `ServiceUnavailableError` placeholders until Phase 4 implements session state, but add tests for the final intended behavior as each route is implemented.

**Verification:**

- [ ] `cd packages/server && bun typecheck`

### Task 3.3: Generate client

**Objective:** Make external-agent routes available to the app through the generated client.

**Files:**

- Generated by command: `packages/client/src/generated*`

**Steps:**

- [ ] Run `cd packages/client && bun run generate`.
- [ ] Do not edit generated files manually.

**Verification:**

- [ ] `cd packages/client && bun typecheck`

---

## Phase 4: Implement Durable External Sessions

### Task 4.1: Add external session events

**Objective:** Persist ACP-hosted session state without writing into native `SessionV2` tables.

**Files:**

- Modify: `packages/schema/src/external-agent.ts`
- Modify: `packages/schema/src/event-manifest.ts`
- Create: `packages/core/src/acp-host/event.ts`
- Create: `packages/core/src/acp-host/store.ts`
- Test: `packages/core/test/acp-host/session-events.test.ts`

**Durable event types:**

```text
external.agent.session.created
external.agent.session.loaded
external.agent.session.info.updated
external.agent.session.prompted
external.agent.session.entry.appended
external.agent.session.entry.updated
external.agent.session.status.updated
external.agent.session.closed
```

**Implementation notes:**

- Aggregate by external OpenCode session ID, not by Claude's raw ACP session ID.
- Store Claude's ACP session ID as data.
- Include `agentID`, `location`, and timestamps in session lifecycle events.
- Preserve raw ACP update payload metadata where schema-safe.
- Add durable definitions to `ServerDefinitions` if server replay must include them and to `Definitions` if global event subscribers need them.

**Tests:**

- [ ] Publish `created`, `prompted`, and `entry.appended`.
- [ ] Replay through `EventV2.readAggregate`.
- [ ] Decode rejects malformed entries.

**Verification:**

- [ ] `cd packages/core && bun test test/acp-host/session-events.test.ts`

### Task 4.2: Add session store and projection

**Objective:** Build current external session state from durable ACP events.

**Files:**

- Modify: `packages/core/src/acp-host/store.ts`
- Create: `packages/core/src/acp-host/projection.ts`
- Test: `packages/core/test/acp-host/projection.test.ts`

**Entry model:**

- `user_message`
- `assistant_message`
- `assistant_thought`
- `tool_call`
- `tool_call_update`
- `plan`
- `permission_request`
- `terminal`
- `usage`
- `session_info`
- `error`

**Behavior:**

- `listSessions(agentID)` returns external sessions for the active location.
- `getSession(sessionID)` returns projected session info.
- `history(sessionID, after?, limit?)` returns durable external session events.
- `events(sessionID, after?)` replays durable events and tails live events.
- Reconstruct transcript after app refresh.

**Tests:**

- [ ] Projection orders entries by durable sequence.
- [ ] Entry update replaces the intended entry without dropping raw metadata.
- [ ] History pagination returns `hasMore`.

**Verification:**

- [ ] `cd packages/core && bun test test/acp-host/projection.test.ts`

### Task 4.3: Implement new/load/resume/close session calls

**Objective:** Call the ACP agent session lifecycle methods and persist OpenCode external session records.

**Files:**

- Modify: `packages/core/src/acp-host/session.ts`
- Modify: `packages/core/src/acp-host/index.ts`
- Test: `packages/core/test/acp-host/session-lifecycle.test.ts`

**Behavior:**

- `newSession(agentID, input)`:
  - connect if needed;
  - send current cwd/location;
  - include additional directories only after a deliberate design;
  - include MCP server descriptors after Phase 7;
  - persist external session created event.
- `resumeSession(agentID, sessionID)`:
  - reconnect if needed;
  - call ACP resume/load method with stored ACP session ID;
  - update status.
- `closeSession(agentID, sessionID)`:
  - call ACP close if supported;
  - persist closed status.

**Tests:**

- [ ] Fake agent receives `session/new` with cwd.
- [ ] Returned ACP session ID is persisted.
- [ ] Resume uses the stored ACP session ID.
- [ ] Close updates projected status.

**Verification:**

- [ ] `cd packages/core && bun test test/acp-host/session-lifecycle.test.ts`

---

## Phase 5: Prompting and Session Updates

### Task 5.1: Send prompts to the ACP agent

**Objective:** Route external session prompts to Claude/fake Claude through ACP.

**Files:**

- Modify: `packages/core/src/acp-host/session.ts`
- Test: `packages/core/test/acp-host/prompt.test.ts`

**Behavior:**

- Convert OpenCode `Prompt` content to ACP prompt content.
- Preserve text, embedded context, file references, and image attachments only when the agent capability supports them.
- Persist a `user_message` entry before or at the same boundary as the ACP prompt call.
- Send ACP prompt to the external agent.
- Implement `cancel(sessionID)` through ACP cancel.

**Tests:**

- [ ] Text prompt is sent to fake agent.
- [ ] Image prompt is rejected with a clear error when the fake agent does not advertise image support.
- [ ] Cancel sends the ACP cancel method.

**Verification:**

- [ ] `cd packages/core && bun test test/acp-host/prompt.test.ts`

### Task 5.2: Map ACP `SessionUpdate` notifications

**Objective:** Convert ACP streaming updates into durable external session entries.

**Files:**

- Create: `packages/core/src/acp-host/update.ts`
- Modify: `packages/core/src/acp-host/connection.ts`
- Test: `packages/core/test/acp-host/update.test.ts`

**Mapping requirements:**

- User chunks append to or create `user_message` entries.
- Agent message chunks append to or create `assistant_message` entries.
- Agent thought chunks append to or create `assistant_thought` entries.
- Tool call create/update events map to `tool_call` and `tool_call_update`.
- Plan updates map to `plan`.
- Usage/session info updates map to `usage` and `session_info`.
- Unknown updates persist as `session_info` or `error` with raw metadata instead of crashing.

**Tests:**

- [ ] Text chunks coalesce in order.
- [ ] Tool call update changes status from pending to running to completed.
- [ ] Unknown update does not crash the connection.

**Verification:**

- [ ] `cd packages/core && bun test test/acp-host/update.test.ts`

---

## Phase 6: Permissions, File IO, and Diffs

### Task 6.1: Bridge ACP permission requests

**Objective:** Show Claude permission prompts in OpenCode and reply to Claude with the user's choice.

**Files:**

- Create: `packages/core/src/acp-host/permission.ts`
- Modify: `packages/schema/src/external-agent.ts`
- Modify: `packages/protocol/src/groups/external-agent.ts`
- Modify: `packages/server/src/handlers/external-agent.ts`
- Test: `packages/core/test/acp-host/permission.test.ts`

**Behavior:**

- When ACP sends a permission request, persist an external permission request entry.
- Expose pending external permission requests through external-agent session state.
- Add a route to reply:

```text
POST /api/external-agent/:agentID/session/:sessionID/permission/:requestID/reply
```

- Return the selected ACP option to the child process.
- If the user denies or the session closes, reply with denial instead of leaving Claude hanging.
- Add saved approvals only when the ACP request has a stable resource identity.

**Tests:**

- [ ] Fake agent permission request appears in projected session state.
- [ ] Reply route resolves the pending JSON-RPC request.
- [ ] Close session denies pending permission requests.

**Verification:**

- [ ] `cd packages/core && bun test test/acp-host/permission.test.ts`
- [ ] Regenerate client after route changes: `cd packages/client && bun run generate`

### Task 6.2: Implement file read requests

**Objective:** Let Claude read files through OpenCode's location-aware filesystem boundary.

**Files:**

- Create: `packages/core/src/acp-host/file.ts`
- Test: `packages/core/test/acp-host/file.test.ts`

**Behavior:**

- Resolve file paths relative to the active Location.
- Reject path escapes and unsupported binary reads unless ACP supports binary content.
- Return text content and metadata to the ACP agent.
- Persist read tool entries when the ACP update stream does not already include them.

**Tests:**

- [ ] Reads an in-workspace file.
- [ ] Rejects `../` escapes.
- [ ] Handles missing file with an ACP error response.

**Verification:**

- [ ] `cd packages/core && bun test test/acp-host/file.test.ts`

### Task 6.3: Implement file write requests and diffs

**Objective:** Mediate Claude file writes through OpenCode review and diff UI.

**Files:**

- Modify: `packages/core/src/acp-host/file.ts`
- Modify: `packages/schema/src/external-agent.ts`
- Test: `packages/core/test/acp-host/file-write.test.ts`

**Behavior:**

- Build a unified diff before applying a write.
- Persist a pending edit entry with file path and diff.
- If permission is required, wait for approval.
- Apply the write only after approval.
- Reply to ACP with success or a typed failure.
- Persist final edit status.

**Tests:**

- [ ] Write request creates a diff entry.
- [ ] Approval writes file content.
- [ ] Denial leaves file unchanged and replies to ACP.

**Verification:**

- [ ] `cd packages/core && bun test test/acp-host/file-write.test.ts`

---

## Phase 7: MCP Forwarding and Slash Commands

### Task 7.1: Forward MCP servers into ACP sessions

**Objective:** Give Claude ACP sessions access to OpenCode-configured MCP servers where capabilities allow it.

**Files:**

- Create: `packages/core/src/acp-host/mcp.ts`
- Modify: `packages/core/src/acp-host/session.ts`
- Test: `packages/core/test/acp-host/mcp.test.ts`

**Behavior:**

- Read MCP config from the same location-scoped config used by native OpenCode.
- Convert enabled MCP servers to ACP `mcpServers`.
- Respect transport support:
  - HTTP;
  - SSE;
  - stdio only if ACP SDK/protocol and agent capabilities support it.
- Omit unsupported servers and expose diagnostics in session info.
- Avoid double-registration by honoring external agent MCP config policy.

**Tests:**

- [ ] Remote MCP server is forwarded when supported.
- [ ] Unsupported transport is omitted with diagnostic.
- [ ] Disabled MCP server is not forwarded.

**Verification:**

- [ ] `cd packages/core && bun test test/acp-host/mcp.test.ts`

### Task 7.2: Surface ACP slash commands

**Objective:** Make Claude-provided slash commands work without routing them through OpenCode native command handling.

**Files:**

- Modify: `packages/core/src/acp-host/update.ts`
- Modify: `packages/schema/src/external-agent.ts`
- Modify: `packages/app/src/pages/session/use-composer-commands.tsx`
- Modify: `packages/app/src/pages/session/use-session-commands.tsx` if command sources are centralized there.
- Test: `packages/app/src/pages/session/composer/session-composer-state.test.ts`

**Behavior:**

- Persist ACP available command updates.
- In native sessions, keep existing OpenCode slash commands.
- In external Claude sessions, show ACP-provided commands.
- Pass Claude commands such as `/login` and `/compact` through the ACP prompt path.
- Reserve only UI-local commands that OpenCode must own.

**Tests:**

- [ ] ACP command update changes composer completions for an external session.
- [ ] Native OpenCode command completions are unchanged.
- [ ] `/login` prompt is sent to ACP in an external session.

**Verification:**

- [ ] `cd packages/app && bun test:unit -- src/pages/session`

---

## Phase 8: Terminal Hosting

### Task 8.1: Implement ACP terminal callbacks with OpenCode PTY

**Objective:** Let Claude use host-created terminals while OpenCode owns the process and UI.

**Files:**

- Create: `packages/core/src/acp-host/terminal.ts`
- Modify: `packages/core/src/acp-host/connection.ts`
- Test: `packages/core/test/acp-host/terminal.test.ts`

**Behavior:**

- Handle ACP terminal create/output/wait/kill/release requests.
- Use existing Core PTY service rather than spawning ad-hoc shell processes.
- Attach terminal IDs to the external session for cleanup.
- Persist terminal entries in the external session log.

**Tests:**

- [ ] Fake agent creates a terminal and gets output.
- [ ] Wait returns exit status.
- [ ] Closing the external session kills or releases attached terminals.

**Verification:**

- [ ] `cd packages/core && bun test test/acp-host/terminal.test.ts`

---

## Phase 9: App Integration

### Task 9.1: Add external-agent sync context

**Objective:** Load and update external agent/session state in the app.

**Files:**

- Create: `packages/app/src/context/external-agent.tsx`
- Modify: `packages/app/src/context/server-sync.tsx`
- Modify: `packages/app/src/context/global-sync/types.ts`

**Behavior:**

- Fetch external agent list.
- Fetch external session info/history.
- Subscribe to external session events.
- Track pending external permissions.
- Keep native `server-session` state unchanged.

**Verification:**

- [ ] `cd packages/app && bun typecheck`

### Task 9.2: Add runtime selector for new sessions

**Objective:** Let the user choose native OpenCode or Claude when starting a session.

**Files:**

- Modify: `packages/app/src/pages/session/new-session-layout.ts`
- Modify: session sidebar/new-session components identified during implementation.
- Test: nearest app unit test for new session helpers or add one.

**Behavior:**

- Show native OpenCode as the default.
- Show Claude when `external_agents.claude` is configured or auto-detected.
- If Claude is missing, show disabled state with a setup message.
- Creating a Claude session calls external-agent session create, not `/api/session`.

**Verification:**

- [ ] App unit test covers native and Claude creation paths.
- [ ] `cd packages/app && bun typecheck`

### Task 9.3: Render external ACP timelines

**Objective:** Display Claude sessions with the same native quality as OpenCode sessions.

**Files:**

- Create: `packages/app/src/pages/session/external-timeline/projection.ts`
- Create: `packages/app/src/pages/session/external-timeline/rows.ts`
- Modify: `packages/app/src/pages/session/timeline/message-timeline.tsx` or route above it to choose native/external projection.
- Reuse where possible: `packages/app/src/pages/session/timeline/*`
- Reuse where possible: `packages/session-ui/src/*`

**Behavior:**

- Render:
  - user messages;
  - assistant messages;
  - thoughts;
  - tool calls;
  - plans;
  - diffs;
  - terminal output;
  - usage;
  - errors.
- Add external-only row components only where existing `Part` rendering cannot represent ACP entries cleanly.
- Preserve stable row keys for virtual scrolling.

**Tests:**

- [ ] Projection test for text + thought + tool call.
- [ ] Projection test for diff summary.
- [ ] Projection test for running status and cancel state.

**Verification:**

- [ ] `cd packages/app && bun test:unit -- src/pages/session`

### Task 9.4: Reuse permission and question docks

**Objective:** Show ACP permission prompts in the existing composer dock region.

**Files:**

- Modify: `packages/app/src/pages/session/composer/session-permission-dock.tsx`
- Modify: `packages/app/src/pages/session/composer/index.ts`
- Modify: `packages/app/src/context/permission.tsx` only if shared logic is needed.

**Behavior:**

- Native sessions continue using native permission state.
- External sessions read pending external permissions from external-agent context.
- Reply buttons call the external-agent permission reply route.
- Auto-accept only applies when the external permission can be safely scoped.

**Verification:**

- [ ] Unit test or browser test shows external permission prompt and reply.
- [ ] Native permission prompt still works.

### Task 9.5: Add external session controls

**Objective:** Make Claude sessions feel first-class without showing irrelevant native controls.

**Files:**

- Modify: `packages/app/src/pages/session/session-layout.ts`
- Modify: `packages/app/src/pages/session/session-side-panel.tsx`
- Modify: model/provider selector components identified during implementation.

**Behavior:**

- Show Claude connection/auth state.
- Show ACP-provided modes/config options/model selector when available.
- Hide native OpenCode provider/model controls for external sessions unless mapped through ACP.
- Cancel button calls external-agent cancel route.
- Reconnect/restart action appears when the ACP process exits.

**Verification:**

- [ ] Browser verification covers ready, auth-required, running, canceled, and exited states.

---

## Phase 10: Claude Descriptor and UX Polish

### Task 10.1: Add built-in Claude descriptor

**Objective:** Provide a zero-config or near-zero-config Claude option when possible.

**Files:**

- Create: `packages/core/src/acp-host/builtin.ts`
- Modify: `packages/core/src/acp-host/registry.ts`
- Test: `packages/core/test/acp-host/builtin.test.ts`

**Behavior:**

- Built-in ID: `claude`.
- Display name: `Claude`.
- Type: `acp`.
- Auto-detect candidate command only after verifying the current Claude ACP entrypoint.
- Allow user config to override command, args, env, and MCP policy.
- If not installed, report a clear missing-command status.

**Verification:**

- [ ] Configured Claude overrides built-in defaults.
- [ ] Missing Claude binary returns setup status.

### Task 10.2: Add docs

**Objective:** Document setup and troubleshooting.

**Files:**

- Modify: `packages/web/src/content/docs/acp.mdx`
- Add or modify external agent docs page if the docs structure supports it.

**Docs must cover:**

- Difference between `opencode acp` and OpenCode hosting Claude ACP.
- Required Claude installation.
- Config example.
- MCP forwarding behavior.
- Slash command behavior.
- Permission behavior.
- Troubleshooting missing binary, auth required, protocol mismatch, and process exit.

**Verification:**

- [ ] Docs build or relevant docs typecheck passes.

---

## Phase 11: End-to-End Verification

### Task 11.1: Run package checks

Run from package directories only:

```bash
cd packages/schema && bun typecheck
cd packages/core && bun typecheck
cd packages/protocol && bun typecheck
cd packages/server && bun typecheck
cd packages/client && bun typecheck
cd packages/app && bun typecheck
cd packages/opencode && bun typecheck
```

Run targeted tests:

```bash
cd packages/core && bun test test/acp-host
cd packages/opencode && bun test test/acp
cd packages/app && bun test:unit -- src/pages/session
```

### Task 11.2: Manual browser verification

**Setup:**

- Start OpenCode normally.
- Use the fake ACP agent first.
- Use real Claude only after the fake agent path passes.

**Scenarios:**

- [ ] Native OpenCode session still creates and prompts normally.
- [ ] External Claude/fake Claude appears in the new-session runtime selector.
- [ ] Missing Claude binary shows a clear error.
- [ ] Claude/fake Claude connects and initializes.
- [ ] Auth-required state appears and can be resolved.
- [ ] Prompt streams assistant text.
- [ ] Cancel interrupts a running turn.
- [ ] Slash commands are external-agent-specific.
- [ ] MCP servers are forwarded or omitted with visible diagnostics.
- [ ] Permission request appears in OpenCode and reply unblocks the agent.
- [ ] File write creates a diff and requires approval.
- [ ] Terminal request renders output and cleans up.
- [ ] Browser refresh reconstructs the external transcript.
- [ ] Process crash/exited state is visible and restart works.

---

## Milestone Commit Plan

Use small conventional commits. Suggested sequence:

```bash
git commit -m "test(core): add fake acp host agent fixture"
git commit -m "feat(core): add external acp agent config"
git commit -m "feat(core): add acp host connection service"
git commit -m "feat(protocol): add external agent routes"
git commit -m "feat(core): persist external acp sessions"
git commit -m "feat(core): bridge acp prompts and updates"
git commit -m "feat(core): bridge acp permissions and files"
git commit -m "feat(core): forward mcp servers to acp agents"
git commit -m "feat(core): host acp terminals"
git commit -m "feat(app): add external claude session experience"
git commit -m "docs: document claude acp hosting"
```

---

## Final Acceptance Criteria

- OpenCode can host an ACP-speaking Claude process as a native external agent.
- Existing `opencode acp` still works for Zed and other ACP hosts.
- Native OpenCode sessions still use existing providers, commands, MCP servers, permissions, and timeline behavior.
- Claude ACP sessions support prompt, cancel, auth, slash commands, MCP forwarding, permission prompts, file reads/writes, diffs, terminal callbacks, and transcript replay.
- External ACP sessions are not stored as native `SessionV2` executions.
- Generated client code is regenerated after Protocol changes.
- Package-level typechecks and targeted tests pass.
- Docs explain setup and troubleshooting.
