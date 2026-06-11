# E6 Agent Driver Spec — recon digest of t3code's provider architecture

Source repo: `/home/ice/dev/oss-repos/t3code` (paths below relative to it).
Scope: contract for dohc Phase E6 (Claude Code via ACP, Codex via native
app-server). NOTE: t3code drives Claude through the Agent SDK
(`apps/server/src/provider/Layers/ClaudeAdapter.ts:9-21`), and uses its
`effect-acp` package for Cursor/Grok via `provider/acp/AcpSessionRuntime.ts`.
dohc's ClaudeAcpDriver follows the ACP runtime shape; Claude-specific behavior
(models, permission semantics) is taken from ClaudeAdapter/ClaudeProvider.

## 1. Session lifecycle

### ACP (effect-acp, generated from ACP schema v0.11.3 — `_generated/meta.gen.ts:2`)
States: spawned → initialized → authenticated → session-open → (idle ⇄ turn-active) → closed.
1. **Spawn** agent as child, ndjson JSON-RPC over stdio (`packages/effect-acp/src/protocol.ts:74` uses `RpcSerialization.ndJsonRpc()`); `shell: win32` (`provider/acp/AcpSessionRuntime.ts:208`).
2. **`initialize`** req: `{ protocolVersion: 1, clientCapabilities: { fs: {readTextFile,writeTextFile}, terminal, auth?, elicitation? }, clientInfo }` (`AcpSessionRuntime.ts:372-382`).
3. **`authenticate`** `{ methodId }` — t3code always calls it (`AcpSessionRuntime.ts:384-392`; Cursor uses `"cursor_login"`, `acp/CursorAcpSupport.ts:61`). dohc: try `session/new` first; only surface the CLI login flow on auth failure.
4. **Session open**: `session/new` `{ cwd: <abs workspace root>, mcpServers: [...] }` → `{ sessionId, models?, modes?, configOptions? }`; resume path tries `session/load` `{ sessionId, cwd, mcpServers }` and falls back to `session/new` on failure (`AcpSessionRuntime.ts:399-438`). Other agent methods: `session/fork|resume|list|close`, `session/set_model`, `session/set_mode`, `session/set_config_option` (`_generated/meta.gen.ts:6-20`).
5. **Prompt turn**: `session/prompt` `{ sessionId, prompt: ContentBlock[] }` (text/image/audio/resource_link/resource); response `{ stopReason: "end_turn"|"max_tokens"|"max_turn_requests"|"refusal"|"cancelled", usage? }` (`schema.gen.ts:7447,7485,9871`). The request stays in flight for the whole turn.
6. **Streamed events** — `session/update` notification, `params.update.sessionUpdate` ∈ `user_message_chunk | agent_message_chunk | agent_thought_chunk | tool_call | tool_call_update | plan | usage_update | current_mode_update | config_option_update | available_commands_update | session_info_update` (`schema.gen.ts:8907+`). Tool calls carry `toolCallId, title, kind, status(pending|in_progress|completed|failed), content, locations, rawInput/rawOutput`. `usage_update` carries `Usage {inputTokens, outputTokens, totalTokens, cached*}` (`schema.gen.ts:730`). t3code folds these into a small union `ModeChanged | AssistantItemStarted/Completed | PlanUpdated | ToolCallUpdated | ContentDelta` (`acp/AcpRuntimeModel.ts:44-72`), merging tool_call/tool_call_update by id and synthesizing assistant segment boundaries (`AcpSessionRuntime.ts:596-752`).
7. **Cancel**: `session/cancel` notification (not a request) (`effect-acp/src/client.ts:479`); the in-flight prompt then resolves with `stopReason: "cancelled"`; client MUST answer pending permission requests with `{outcome:"cancelled"}` (`schema.gen.ts:7646` doc note).
8. **Teardown**: close scope → kill child; stdin EOF surfaces as transport termination error to all pending requests (`protocol.ts:411-432`).
Agent→client requests the client must serve: `session/request_permission`, `session/elicitation`, `fs/read_text_file`, `fs/write_text_file`, `terminal/create|output|wait_for_exit|kill|release` (`meta.gen.ts:23-35`). t3code defaults fs/terminal capabilities to false (`AcpSessionRuntime.ts:246-258`); dohc should also start with fs:false, terminal:false (agent uses its own tools in cwd).

### Codex app-server (effect-codex-app-server + CodexSessionRuntime)
States: spawned → initialized → thread-open → (idle ⇄ turn-active) → closed.
1. **Spawn** `codex app-server` with `CODEX_HOME` in env, cwd = workspace root, `forceKillAfter: 2s`, `shell: win32` (`Layers/CodexSessionRuntime.ts:716-728`). Framing: newline-delimited JSON-RPC (`packages/effect-codex-app-server/src/protocol.ts:96`).
2. **Handshake**: `initialize` `{ clientInfo:{name,title,version}, capabilities:{experimentalApi:true} }` then `initialized` notification (`CodexSessionRuntime.ts:1192-1193`, params built at `Layers/CodexProvider.ts:238-249`). `initialize` response `userAgent` yields the version string (`CodexProvider.ts:291`).
3. **Thread open**: `thread/start` `{ cwd, approvalPolicy, sandbox, model?, serviceTier?, config? }`; resume = `thread/resume` `{ threadId, ...same }` with fallback to `thread/start` when the thread is unknown (`CodexSessionRuntime.ts:285-299,432-469`). runtimeMode mapping: approval-required→`untrusted`+`read-only`; auto-accept-edits→`on-request`+`workspace-write`; full-access→`never`+`danger-full-access` (`CodexSessionRuntime.ts:261-283`). Server replies `thread/started` notification with the provider thread id.
4. **Prompt turn**: `turn/start` `{ threadId, input:[{type:"text",text}|{type:"image",url}], approvalPolicy, sandboxPolicy, model?, effort?, serviceTier?, collaborationMode? }` → `{ turn: { id } }` (`CodexSessionRuntime.ts:343-389,1255-1291`). Steer/interrupt: `turn/steer`, `turn/interrupt` `{ threadId, turnId }` (`CodexSessionRuntime.ts:1292-1304`).
5. **Streamed events** (server notifications, `meta.gen.ts:103-168`): turn lifecycle `turn/started`, `turn/completed` (status completed|failed|interrupted, error on failure), `turn/plan/updated`, `turn/diff/updated`; items `item/started`, `item/completed`, deltas `item/agentMessage/delta`, `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `item/fileChange/patchUpdated`, `item/mcpToolCall/progress`; tokens `thread/tokenUsage/updated` (`usage.last/total.{inputTokens,cachedInputTokens,outputTokens,reasoningOutputTokens,totalTokens}`, `modelContextWindow` — `Layers/CodexAdapter.ts:157-191`); errors `error` (`{error:{message}, willRetry}` — willRetry⇒warning not failure, `CodexAdapter.ts:1240-1255`); plus `account/updated`, `account/rateLimits/updated`, `mcpServer/oauthLogin/completed`, `model/rerouted`, `deprecationNotice`, `configWarning`, `thread/compacted`. stderr is parsed line-wise; only ERROR-level lines surface, "failed to connect to websocket" is fatal (`CodexSessionRuntime.ts:391-409`, `CodexAdapter.ts:150-155`).
6. **Teardown**: settle pending approvals as "cancel", emit session/closed, close scope (kills child, SIGKILL after 2s), watch `child.exitCode` to emit session/exited when the process dies unexpectedly (`CodexSessionRuntime.ts:1163-1250`).

## 2. Permission-request flow

### ACP
- Agent→client request `session/request_permission`: `{ sessionId, toolCall: { toolCallId, title?, kind?, status?, content?, locations?, rawInput? }, options: PermissionOption[] }` where each option is `{ optionId, name, kind: "allow_once"|"allow_always"|"reject_once"|"reject_always" }` (`schema.gen.ts:398-420,7671`).
- Response: `{ outcome: { outcome:"selected", optionId } | { outcome:"cancelled" } }` (`schema.gen.ts:7639-7775`).
- t3code answers in its `handleRequestPermission` handler (`Layers/CursorAdapter.ts:642-710`): full-access mode auto-selects an allow option; otherwise it emits a `request.opened` event, parks on a Deferred until the UI calls respondToRequest, then maps decision→optionId: accept→"allow-once", acceptForSession→"allow-always", decline→"reject-once", cancel→`{outcome:"cancelled"}` (`acp/AcpAdapterSupport.ts:46-56`). NOTE: t3code hardcodes optionId strings; dohc MUST select from the offered `options[]` by `kind` instead (ids are agent-defined).
- Policy injection point = that one handler. dohc: route through collaborationPolicy (boundary-crossing check on `toolCall.locations` paths) before showing the dialog; auto-allow inside-workspace reads if policy says so.

### Codex app-server
- Server→client JSON-RPC REQUESTS (must be responded to): `item/commandExecution/requestApproval` `{ threadId, turnId, itemId, command?, reason?, approvalId? }` and `item/fileChange/requestApproval` `{ threadId, turnId, itemId, reason? }` → response `{ decision }` with decision ∈ accept | acceptForSession | decline | cancel (t3code's `ProviderApprovalDecision` passes through, `CodexSessionRuntime.ts:944-1054`); legacy `applyPatchApproval`/`execCommandApproval` also exist (`meta.gen.ts:91-101`). `item/tool/requestUserInput` `{ questions:[{id,header,question,options[]}] }` → `{ answers: {questionId:{answers:[...]}} }` (`CodexSessionRuntime.ts:1056-1104`).
- t3code parks each request on a Deferred keyed by a fresh requestId, emits `request.opened`, resolves on UI `respondToRequest(requestId, decision)`; close settles all pending with "cancel". `serverRequest/resolved` notifications are correlated back via approvalId (`CodexSessionRuntime.ts:842-861`).
- Coarse policy = `approvalPolicy`/`sandbox(Policy)` set per thread AND per turn (above); fine policy = the request handlers.

### Claude SDK reference (for semantics only)
`canUseTool(toolName, input, {signal, suggestions})` → `{behavior:"allow", updatedInput, updatedPermissions?}` | `{behavior:"deny", message}`; acceptForSession returns the SDK's `suggestions` as `updatedPermissions` (session-scoped allow rules); abort signal → decision "cancel" (`Layers/ClaudeAdapter.ts:2807-2960`). full-access maps to `permissionMode:"bypassPermissions"` + `allowDangerouslySkipPermissions` (`ClaudeAdapter.ts:2988-3014`). Via ACP, claude-code-acp translates these to `session/request_permission`; expect allow_always options to mean "for this session".

## 3. Subscription auth

### Codex (ChatGPT plan)
- Auth state is read with `account/read` → `{ account?: { type: "chatgpt"|"apiKey"|"amazonBedrock", planType, email }, requiresOpenaiAuth }`; unauthenticated ⇒ status error + "Run `codex login`" (`Layers/CodexProvider.ts:294-301,378-405`). planType→label table at `CodexProvider.ts:56-89` (free/go/plus/pro/prolite/team/business/enterprise/edu).
- `account/chatgptAuthTokens/refresh` is a SERVER request `{ reason:"unauthorized", previousAccountId? }` → `{ accessToken, chatgptAccountId, chatgptPlanType? }` (`schema.gen.ts:28000-28027`). It is only sent in EXTERNAL auth mode (client supplied tokens via `account/login/start` type `chatgptAuthTokens`); in managed/CLI-login mode the app-server refreshes from `CODEX_HOME/auth.json` itself. t3code registers NO handler — unknown server requests get methodNotFound (`CodexSessionRuntime.ts:1106-1108`) — and only maps the method name for event labeling (`CodexAdapter.ts:301-302`). dohc (managed mode, real ~/.codex): same — respond methodNotFound, but LOG it; never implement token storage.
- `mcpServer/oauthLogin/completed` notification `{ name, success, error? }` → surfaced as an `mcp.oauth.completed` event for the UI (`CodexAdapter.ts:1132-1151`). Also forward `account/updated` and `account/rateLimits/updated` (`CodexAdapter.ts:1102-1130`) so the panel can show plan/rate-limit state live.
- Login flows exist as requests if needed: `account/login/start`, `account/login/cancel`, `account/logout`, completion notification `account/login/completed` (`meta.gen.ts:69-72,168`).

### Claude (subscription models)
- Model catalog is hardcoded + version-gated in `Layers/ClaudeProvider.ts:55-283` (fable-5 ≥2.1.169, opus-4-8 ≥2.1.154, opus-4-7 ≥2.1.111 via `claude --version`), each with effort/contextWindow/fastMode option descriptors; `resolveClaudeApiModelId` appends `[1m]` for the 1M context selection (`ClaudeProvider.ts:354-361`); effort normalization (ultracode→xhigh+settings.ultracode, ultrathink→prompt prefix) at `ClaudeProvider.ts:331-352`.
- Subscription detection: spawn a throwaway SDK query with a never-yielding prompt, read `initializationResult().account.{email,subscriptionType,tokenSource}` + slash commands, abort — no API call ever made (`ClaudeProvider.ts:564-617`). subscriptionType→label ("Pro","Max 5x/20x","Team","Enterprise"...) at `ClaudeProvider.ts:373-440`; tokenSource apiKey ⇒ "Claude API Key".
- Via ACP dohc gets `models`/`configOptions` from `session/new` instead; keep the probe as the subscription-tier source (it's the only place tier is exposed) and flag plan-included models in the picker.

### Homes / env
- Claude: `HOME` is overridden ONLY if a custom homePath is configured; default = real home (`Drivers/ClaudeHome.ts:17-28`). Continuation key `claude:home:<resolvedHome>` (`ClaudeHome.ts:30-35`).
- Codex: `CODEX_HOME` env (tilde-expanded — `CodexSessionRuntime.ts:713-720`); default `~/.codex` (`Drivers/CodexHomeLayout.ts:34-40`). Multi-account "shadow home" symlinks shared dirs (sessions, sqlite, skills, …) and keeps `auth.json`/`models_cache.json` private per instance (`CodexHomeLayout.ts:19-31,190-260`).
- **dohc delta (per plan directive)**: default to the user's REAL `~/.claude` and `~/.codex` (i.e., set NO HOME/CODEX_HOME override at all) so existing CLI logins work zero-config; keep per-workspace isolation as an opt-in advanced setting (Codex shadow-home pattern is the template). Never collect credentials; on unauthenticated, show the CLI's own login instruction.

## 4. Process management

| | Claude ACP (dohc) | Codex app-server |
|---|---|---|
| Executable | `claude-code-acp` (Zed adapter for `@zed-industries/agent-client-protocol`); verify exact binary/launch during build — t3code precedents: cursor `agent acp` (`CursorAcpSupport.ts:43-47`), grok `grok agent stdio` | `codex app-server` (`CodexSessionRuntime.ts:723`) |
| cwd | workspace root (spawn cwd AND `session/new.cwd`) | workspace root (spawn cwd AND `thread/start.cwd`) |
| Framing | ndjson JSON-RPC 2.0 over stdio | ndjson JSON-RPC 2.0 over stdio (`protocol.ts:96,335`) |
| Kill | scope close → SIGTERM | SIGTERM, force-kill after 2s (`client.ts:20,283`) |
| stderr | ignored by t3code ACP runtime | parsed; ERROR lines → runtime.warning/error events |

- **Reaper** (`Layers/ProviderSessionReaper.ts`): sweep every 5 min; stop any session binding idle >30 min (lastSeenAt) unless it has an `activeTurnId`; stop via the normal stopSession path; failures only logged. dohc: same policy on the session map (no DB needed — in-memory lastSeen + persisted resume cursor).
- **Session directory** (`Layers/ProviderSessionDirectory.ts`): persists threadId→{provider, instanceId, runtimeMode, status, resumeCursor, lastSeenAt} so sessions can resume after app restart. dohc equivalent: a row in workspace SQLite or `.dohc/agent-sessions.json`.
- **Event logger** (`Layers/EventNdjsonLogger.ts`): per-thread rotating log files (`<threadSegment>.log`, 10MB × 10, 200ms batches), one line per protocol event `[ISO] NTIVE: <json>` (`EventNdjsonLogger.ts:71-75`); "native" stream = raw protocol frames, "canonical" = mapped events; write is best-effort (failures→warnings). Both adapters tee every raw event through it (`CodexAdapter.ts:1423-1437`). dohc: same two streams under `<workspace>/.dohc/agent-logs/`.

## 5. Proposed dohc interface (plain TypeScript, no Effect)

```ts
// packages/agent-drivers (new). Implemented by ClaudeAcpDriver + CodexAppServerDriver.
export type PermissionDecision = "allow-once" | "allow-always" | "deny-once" | "deny-always" | "cancel";
export type AgentEvent =
  | { kind: "session-state"; state: "starting" | "ready" | "running" | "error" | "closed"; reason?: string }
  | { kind: "text-delta"; itemId: string; stream: "assistant" | "reasoning"; text: string }
  | { kind: "item"; phase: "started" | "updated" | "completed"; item: {
      id: string; type: "tool_call" | "command" | "file_change" | "mcp_tool_call" | "web_search" | "plan" | "other";
      title: string; detail?: string; status: "pending" | "in_progress" | "completed" | "failed";
      locations?: string[]; raw?: unknown } }
  | { kind: "plan"; steps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }> }
  | { kind: "permission-request"; requestId: string; requestType: "command" | "file-change" | "file-read" | "tool" | "other";
      title: string; detail?: string; locations?: string[];
      options: Array<{ optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" }>;
      raw?: unknown }
  | { kind: "permission-resolved"; requestId: string; decision: PermissionDecision }
  | { kind: "token-usage"; used: number; max?: number; input?: number; output?: number }
  | { kind: "turn-completed"; turnId: string; status: "completed" | "failed" | "cancelled"; errorMessage?: string }
  | { kind: "auth"; event: "account-updated" | "rate-limits" | "mcp-oauth-completed" | "login-required"; detail?: unknown }
  | { kind: "error"; message: string; fatal: boolean };

export interface AgentModel { id: string; name: string; planIncluded: boolean;  // subscription-tier flag
  options?: Array<{ id: "effort" | "contextWindow" | string; values: string[]; default?: string }> }
export interface AgentProbe { installed: boolean; version?: string;
  auth: { status: "authenticated" | "unauthenticated" | "unknown"; label?: string; email?: string; loginHint?: string };
  models: AgentModel[] }

export interface AgentDriver {
  readonly id: "claude-acp" | "codex-app-server";
  readonly displayName: string;
  probe(env?: NodeJS.ProcessEnv): Promise<AgentProbe>;            // detection + auth + models (§3)
  startSession(input: {
    workspaceRoot: string;                                        // becomes spawn cwd + session/new.cwd | thread/start.cwd
    mode: "approval-required" | "auto-accept-edits" | "full-access";
    model?: string; resumeCursor?: unknown;                       // opaque per driver (acp sessionId | codex threadId)
    mcp: { command: string; args: string[] };                     // dohc MCP server launch spec (see below)
    onEvent: (e: AgentEvent) => void;
    permissionPolicy?: (req: Extract<AgentEvent, {kind:"permission-request"}>) => PermissionDecision | null; // null ⇒ ask UI
    logDir?: string;                                              // NDJSON native+canonical logs
  }): Promise<AgentSession>;
}

export interface AgentSession {
  readonly sessionId: string;                                     // driver-native id
  readonly resumeCursor: unknown;                                 // persist for resume
  prompt(input: { text: string; attachments?: Array<{ type: "image"; pathOrUrl: string }> }): Promise<{ turnId: string }>;
  cancel(): Promise<void>;                                        // session/cancel | turn/interrupt
  answerPermission(requestId: string, decision: PermissionDecision): Promise<void>;
  answerUserInput?(requestId: string, answers: Record<string, string | string[]>): Promise<void>; // codex item/tool/requestUserInput
  setModel?(modelId: string): Promise<void>;                      // session/set_model | next turn/start.model
  stop(): Promise<void>;                                          // graceful close + settle pending as cancel
  dispose(): Promise<void>;                                       // kill child (force after 2s)
}
```

- **MCP injection**: Claude/ACP — pass `mcpServers: [{ name: "dohc", command, args: ["--workspace", root, "--home", home], env: [] }]` in `session/new` (stdio variant of the `McpServer` union, `effect-acp schema.gen.ts:989-1011`; dohc server bin = `dohc-mcp`, `packages/mcp/package.json` + `src/server.ts:3-4`). Codex — `thread/start.config` accepts config-toml-shaped overrides (`schema.gen.ts:35625-35641`, key `mcp_servers.dohc = { command, args }`); verify in build phase, fallback = `config/value/write` request or a scoped `CODEX_HOME` config layer.
- **Attribution hooks**: the panel calls `AgentIntegration.startAgentRun(workspaceId)` immediately before `session.prompt()` and `endAgentRun(...)` on the `turn-completed` event (seam exists: `apps/desktop/src/agents/AgentIntegration.ts:120,149,208`); driver code stays attribution-free. The reaper's stop path must also end any open run.
- Registry: a tiny `AgentDriverRegistry` (map id→driver, probe-all for the picker) mirrors `ProviderAdapterRegistry`'s lookup-only facade (`Layers/ProviderAdapterRegistry.ts:33-101`); a reaper interval owns idle sessions (§4).

## 6. Windows deltas to verify in the build phase

1. **Spawn shell**: t3code sets `shell: true` on win32 everywhere (`AcpSessionRuntime.ts:208`, codex `client.ts:284`, `CodexSessionRuntime.ts:727`, `ClaudeProvider.ts:627`) because `codex.cmd`/`claude.cmd` npm shims aren't directly spawnable. Verify arg-quoting safety with shell:true, or resolve the `.cmd`→real binary instead.
2. **Binary discovery**: claude native installs land in `%USERPROFILE%\.local\bin\claude.exe` (`Drivers/ClaudeDriver.ts:58-65`); also check `where claude` / `where codex` and WSL-vs-Windows PATH mismatches.
3. **Home dirs**: `NodeOS.homedir()` and `expandHomePath("~/...")` must produce Windows paths (`CodexHomeLayout.ts:34-40`, `CodexSessionRuntime.ts:713-716`); `CODEX_HOME` with backslashes; never pass `~` through env.
4. **Codex Windows sandbox**: handle `windowsSandbox/setupCompleted` and `windows/worldWritableWarning` notifications (`CodexAdapter.ts:1282-1332`) — first run on Windows may need `windowsSandbox/setupStart`.
5. **Symlinks** (only if shadow-home isolation ships): `fileSystem.symlink` needs Developer Mode or junctions on Windows (`CodexHomeLayout.ts:148-174`).
6. **cwd casing/UNC**: ACP `session/new.cwd` must be an absolute path; normalize drive letters before comparing paths in permission policy.

## 7. E2E fakes (gate)

Fake ACP agent: stdio loop answering `initialize`→caps, `session/new`→sessionId, `session/prompt`→scripted `session/update`s + one `session/request_permission`, honoring `session/cancel`. Fake codex: answer `initialize`/`initialized`, `thread/start`, `turn/start`, emit `item/*` deltas + `item/commandExecution/requestApproval` + `thread/tokenUsage/updated` + `turn/completed`; also emit `account/rateLimits/updated` and one unsolicited `account/chatgptAuthTokens/refresh` request to assert the methodNotFound+log behavior. t3code's test doubles: `Layers/CodexSessionRuntime.test.ts`, `effect-acp/src/client.test.ts`.
