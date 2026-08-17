# Spike: BYOAI harness drivers

Date: 2026-08-17. Read-only spike by Fable; no production code changed. Every
citation is against main at `cf8a9fb0`. Companion to
[`2026-08-13-plugin-system.md`](2026-08-13-plugin-system.md) and
[`2026-08-17-sites-plugin-spike.md`](2026-08-17-sites-plugin-spike.md).

The decision this serves (Ice, 2026-08-17): dohc does **not** ship the t3
plugin. The first built-in plugins are thin **harness drivers** that connect a
user's existing AI harness — Claude Code, Codex CLI, their own subscription,
their own login — to dohc. The reference model is VS Code: the host's chat is
the one first-party surface and providers plug in behind it. dohc holds two
structural advantages VS Code lacks: chats are captured workspace memory, not
ephemeral panels, and agent edits carry provenance through the engine's
attribution and gates. The agreed split: dohc's chat surface, capture, and
provenance are **core**; "how to talk to harness X" is a small readable
**plugin**, one per harness, which doubles as the worked example a user's
agent copies to add harness #3.

## Conclusion

**The drivers largely exist; the work is a seam, not a subsystem.** dohc
already ships two working BYOAI paths. Path A, the chat runner, is the full
loop today: a message in the agent channel spawns the user's own CLI with the
rendered thread on stdin, and the harness reports back into chat through
`dohc chat reply --as-agent`, captured and run-linked. Path B, the agent
drivers, already speaks `codex app-server` and Claude-over-ACP as supervised
JSON-RPC children with dohc's MCP server injected — but its output dead-ends
in an in-memory panel snapshot and never reaches chat. Essentially all
harness-specific code in both paths is one 711-line file
(`AgentProcessDrivers.ts`, plus its e2e double and two inert strings — §3.1);
everything
above it — dispatch ledger, budgets, recovery, attribution, MCP config, the
Settings probe UI — is harness-neutral and stays core. The recommended
contribution point is therefore **core calls plugins**: a `drivers` manifest
contribution adapted into the existing `AgentDriver` registry, which needs
**no plugin→chat SDK at all** — the harness itself keeps replying through the
CLI/MCP door, and the loop-breaking and attribution invariants never leave
core. Sizes: the contribution point is M, the command-capable broker it needs
is the sites spike's P3 (M), each harness plugin is S, and nothing here is L —
the substrate (chat tables, dispatch ledger, run attribution) already ships in
the engine.

## 1. What exists today, end to end

### 1.1 Chat is engine-owned memory

A thread is file-linked or belongs to a channel — exactly one owner, enforced
by the store (`packages/workspace-contracts/src/engine.ts:1265-1280`).
Channels come in three kinds: `"channel" | "dm" | "agent"` (`engine.ts:1197`);
the `agent` kind is the auto-provisioned "My agent" channel
(`ensureAgentChannel`, `engine.ts:1503`; provisioned on every dispatch scan,
`apps/desktop/src/agents/chatDispatchService.ts:1251-1257`).

Messages are rows in the engine's SQLite store at `.dohc/engine/engine.db`
(`engine.ts:38,1220`), written by the Rust engine
(`crates/dohc-engine-domain/src/chats.rs:2932-2951`; DDL at
`crates/dohc-engine-storage/src/migration.rs:515-601`, `chat_messages` at
`:577-601`). A message carries
`author: ChatActor` — `{kind: "human"|"agent", displayName}`, nothing more
(`engine.ts:1222-1224`) — plus `authorUserId` (opaque relay id, the authz key;
`engine.ts:1339-1344`) and `origin?: "cli"` (`engine.ts:1346`). There is no
per-agent identity in a chat message; "which agent" is not modelled, and the
mention handle is the literal string `'agent'` hardcoded in engine SQL
(`chats.rs:5474`).

Chats are not moments. They replicate through their own envelopes
(`chat.channel.create` / `chat.thread.create` / `chat.message.append`,
`engine.ts:710-713`); a thread becomes a Markdown file only through the
bookmark projection
(`apps/desktop/src/workspaces/chatBookmarkProjection.ts:1-30`).

Renderer: `ChatsView.tsx` owns channels, the feed, and the agent surfaces —
`AgentBadge` (`:513-521`) and `RunChip` (`:636-720`), which renders a reply's
linked run (command, start time, exit code, log path). Agent authorship
displays as "<Name>'s agent" (`chatMessages.tsx:33-43`). One invariant to
carry: **the renderer send path can only author human messages** — the author
is derived in main and hardcoded `kind: "human"`
(`apps/desktop/src/main.ts:8530-8537`). Agent authorship has exactly two
producers: the CLI server, serving the CLI and MCP verbs alike (§1.2), and
main's own dispatch service, whose `sendAgentMessage` posts service notes —
failure, no-runner, budget-pause — as `{kind: "agent"}` directly
(`apps/desktop/src/agents/chatDispatchService.ts:616-665`).

### 1.2 Path A: the chat runner — the full BYOAI loop, today

**Trigger.** A human message in the agent channel, or one that @-mentions
`agent`, records a pending dispatch. The rule is durable SQL in the engine
(`chats.rs:5451-5476`): `author_kind = 'human'`, `origin <> 'cli'`, verified
author when signed in, channel kind `agent` or a mention row with handle
`'agent'`. Loop safety is per path, not one stamp. The CLI `post`/`reply`
verbs stamp `origin: "cli"` (`apps/desktop/src/cli/cliServer.ts:1950,2012`);
the MCP verbs `startChannelChat`/`replyToChat` omit `origin` entirely — their
rows land NULL (`cliServer.ts:1689,1727-1738`) — and are loop-safe only
because `requestCli` hardcodes `actor: "agent"`
(`packages/mcp/src/tools.ts:2699`) and the trigger requires
`author_kind = 'human'`; main's own service notes are agent-authored for the
same reason. A future human-actor MCP write would need its own origin
discipline. The TS mirror is `messageCanTrigger`
(`chatDispatchService.ts:340-352`).

**Claim and budget.** The dispatch ledger lives in the engine
(`chat_dispatch_ledger`, `migration.rs:755`;
`liveAgentDispatchStore.ts` adapts it over the daemon RPC). Dispatch claims
one run per workspace, pauses a thread after 10 dispatches in 10 minutes with
a visible resume path (`chatDispatchService.ts:30-32,1178-1207`), posts
failure notes for no-reply/timeout/app-quit (`:835-857,891-921`), and
requeues interrupted runs once (`:1319-1395`).

**Spawn.** The runner is one user-level free-text command —
`runner: {command ≤4096, enabled, timeoutMinutes 1-1440}` in desktop user
settings (`apps/desktop/src/settings/userSettings.ts:26-43,71`), configured in
Settings → Agents & MCP (`renderer/settings/RunnerSettingsCard.tsx`). Dispatch
tokenizes it (`chatDispatchService.ts:290-330`), spawns it detached with
`cwd = workspace root`, stdout/stderr to a `0o600` run log
(`:525-537,595-613`), and delivers the prompt on **stdin, never argv** — the
comment at `:572-582` records the Windows constraint (cmd.exe's ~8191-char
limit; no safe double quote) that forced this. The environment is inherited
`process.env` plus `DOHC_CHAT_THREAD`, `DOHC_CHAT_ACTOR=agent`, `DOHC_RUN_ID`,
`DOHC_STATE_DIR`, and the `dohc` CLI prepended to `PATH` (`:539-560`). No
credential is passed, ever.

**Prompt contract.** The rendered thread (`runnerThreadContext.ts:41-89`) plus
a report contract: reply in-thread with
`dohc chat reply <threadId> --as-agent "<report>"`; "Your final text is not
shown anywhere; only messages you post through `dohc chat` are shown"
(`chatDispatchService.ts:332-338`). The reply is pull, not parse: dohc never
interprets the harness's stdout.

**Reply.** The `dohc` CLI is a thin client over a per-boot named
pipe/unix socket with a token file (`packages/cli/src/client.ts:21-31`,
`cliServer.ts:63`); `--as-agent` sets the actor
(`cliServer.ts:333-337` derives `{kind: "agent"}`), `DOHC_RUN_ID` is stamped
from env (`packages/cli/src/index.ts:176`) and links the message to its run
(`cliServer.ts:1444`), which is what makes the `RunChip` render. The MCP chat
write tools (`dohc_reply_to_chat`, `dohc_start_channel_chat`) are thin
wrappers over the same socket with `actor: "agent"`
(`packages/mcp/src/tools.ts:2689-2711`, `packages/mcp/src/server.ts:446-457`)
— but through their own verb handlers, which share the authorship rule and
skip the `origin` stamp (see the trigger note above).

**Test coverage caveat.** The dispatch e2e
(`apps/desktop/e2e/workspace-agent-dispatch.spec.ts`) skips on Windows
(`:17-22`) and its fixture is stale: `fakeChatRunner.mjs:7` still reads the
prompt from argv, but production moved the prompt to stdin, so the fixture's
own guard (`:11-14`, `prompt === mode`) exits 2 and both tests would fail on
any platform. The loop is effectively untested end to end right now (#824).

### 1.3 Path B: agent drivers — the harness clients, without chat

`AgentDriver` is a real interface: `probe()` and `startSession()`
(`apps/desktop/src/agents/AgentDriver.ts:113-118`), a registry
(`:128-166`), and a normalized event union — session state, assistant and
reasoning text deltas, tool/command/file-change items, permission requests
with allow/reject options, token usage, turn-completed
(`AgentDriver.ts:14-58`). Three drivers register
(`AgentProcessDrivers.ts:705-711`):

- **`codex-app-server`** spawns `codex app-server` and speaks its JSON-RPC:
  `thread/start` with `cwd = workspaceRoot` and dohc's MCP server injected as
  `config.mcp_servers.dohc` (`:603-618`), turn approvals mapped to permission
  events (`:568-577`), and dohc's three modes mapped to Codex
  approval-policy/sandbox pairs (`:143-173`). ChatGPT token refresh is
  explicitly refused back to the CLI's own login (`:586-593`).
- **`claude-acp`** spawns `claude-code-acp` — the ACP **adapter**, not the
  `claude` CLI — with `session/new {cwd, mcpServers}` and file-system
  capabilities declared false (`:374-389`), mapping `session/update`
  notifications to events (`:397-445`).
- **`generic-acp`** spawns a command named `agent`. All three commands are
  overridable via `DOHC_AGENT_<PREFIX>_COMMAND` / `_ARGS_JSON` (`:47-56`).

Probe is a 3-second `--version` spawn (`:58-92`); auth status is hardcoded
`"unknown"` with the label "CLI login" and the hint "Install and log in with
the provider CLI." (`:94-104`) — dohc never reads harness credentials.

Above the drivers, `AgentSessionManager` runs one session per workspace and
accumulates events into an in-memory snapshot capped at 200 messages/items
(`AgentSessionManager.ts:93-95,256-282`), with the mode hardcoded
`"approval-required"` (`:395`) and each session bracketed by an agent run for
attribution (`:406`). **Nothing here reaches chat.** The dedicated Agent panel
was retired (`main.ts:9852-9858`); the only surfaces left are the Settings
probe list (`renderer/settings/AgentsMcpSettings.tsx:277-307`) and "Try it in
a version", the one caller that starts a driver session (`main.ts:2246-2264`).

One measured fact that sharpens the plugin question: on this development
machine, `claude` 2.1.233 is installed and logged in, but `claude-code-acp`
is not — so the built-in Claude driver probes "Not found" on a machine where
Claude Code works. The adapter dependency, not the harness, is the failure
point.

### 1.4 The surface a harness sees

- **MCP server.** The desktop hands out (and drivers inject) a launch config
  for `dohc-mcp --workspace <root> --home <state>`; a share view appends
  `--share-access <level>`, and today the server registers **no** write tool
  at any share level — the level rides along for tiers a later PR adds
  (`main.ts:2003-2048`, `packages/mcp/src/server.ts:109-129`).
  Tools cover files, search, changes, sites, databases, share, and chat
  (`server.ts:131-479`).
- **CLI.** `dohc chat` verbs: channels, threads, inbox, show, post, reply,
  react, grep, export (`packages/cli/src/index.ts:62-160`).
- **AGENTS.md.** dohc idempotently maintains a managed block in the
  workspace's AGENTS.md teaching any harness the chat verbs and telling it to
  pass `--as-agent` on every call "because environment variables do not
  persist between agent harness tool calls"
  (`apps/desktop/src/cli/agentsChatBlock.ts:12-21,172-185`; wired at
  `main.ts:2836-2846`). That sentence is the existing integration cost stated
  out loud: the harness contract is convention, enforced by prompt.

### 1.5 Attribution and provenance

File edits: a dohc-tracked agent run claims the workspace activity slot;
the capture watcher attributes every write during the window to the agent;
ending the run clears it (`AgentIntegration.ts:156-235`, slot claim at
`main.ts:2195-2208`; dispatch stamps `agentId: "dohc-chat-runner"`,
`chatDispatchService.ts:988-992`). The moment author shape is
`AgentMomentAuthor {agentId, onBehalfOf, agentRunId?}`, and an absent author
is documented as "the honest default, not a fallback" — raw external agent
CLIs outside a tracked run stay actor-neutral (`engine.ts:143-155`).
`onBehalfOf: "local"` renders as the user's own name (`main.ts:7921-7927`).
Plugin SDK writes already stamp a per-operation author
`plugin:<id>` + spawn run id (`plugins/pluginSdkHost.ts:158-163`).

Two terminology notes for whoever builds this. First, "the door" is the
plugin plan's name for the attributed SDK/daemon write path (design rule 2 in
`2026-08-13-plugin-system.md`); no code identifier carries that name — chat's
actual gates are `assertSharedChannelWritable` (`main.ts:8506-8514`) and the
MCP share tiering. Second, two different types are both named
`AgentRunRecord`: the engine dispatch record
(`engine.ts:1786-1798`) and the panel-run record in `.dohc/agent-runs.json`
(`AgentIntegration.ts:20-27`). Same name, different shapes, different stores.

### 1.6 Dead settings

`agents.mcpAutoStart`, `agents.defaultDriverId` (≤120 chars), and
`agents.defaultModel` (≤200 chars) exist in the workspace-settings contract
(`packages/workspace-contracts/src/workspaceSettings.ts:38-52`, defaults at
`workspaceSettingsValues.ts:15-17`, desktop mirror at
`apps/desktop/src/workspaces/workspaceSettings.ts:29-31`) and **nothing reads
them** — a repo grep finds only schemas, defaults, tests, and the site demo
bridge. Same defect class as the write-only `sites.defaultPreviewMode` the
sites spike caught. The live configuration is the user-level runner command
plus the driver probe list.

## 2. The harnesses, measured

Verified on this machine 2026-08-17: `claude` 2.1.233, `codex-cli` 0.146.0.
Facts below are from `--help` output unless marked. *(binary-strings)* means
the evidence is string constants inside the shipped executable — strong but
worth one cheap live invocation to confirm before building.
*(assumption)* is stated inference, not observed.

| Concern | Claude Code 2.1.233 | Codex CLI 0.146.0 |
| --- | --- | --- |
| Headless entry | `-p/--print` | `codex exec` |
| Duplex streaming session | Yes: `--input-format stream-json` + `--output-format stream-json`; a `control_request`/`control_response` channel carries `can_use_tool` permission prompts, `set_permission_mode`, `interrupt` *(binary-strings)* | No. One-shot stdin; multi-turn is `exec resume <id>` per turn, or the `codex app-server` / `codex mcp-server` daemons |
| Turn-done + final text | `{"type":"result",…}` event with the final text, `is_error`, `session_id`, usage *(binary-strings)*; also a `Stop` hook | Process exit; `-o/--output-last-message <file>`; `turn.completed`/`turn.failed` in `--json` *(binary-strings)* |
| Session handle | `--session-id <uuid>` — dohc can mint it; `-c/--continue` is scoped to the spawn cwd | UUID or thread name; `exec resume <id>`, `--last` |
| Working directory | **No flag** — set the child's cwd | `-C/--cd <dir>`; refuses non-git dirs without `--skip-git-repo-check` |
| Containment | Permission modes only (`--permission-mode`, `--allowed-tools`) | Approval policy (`-a untrusted\|on-request\|never`) **and** OS sandbox (`-s read-only\|workspace-write\|danger-full-access`). `--full-auto` no longer exists |
| MCP injection | `--mcp-config <json-or-file>` + `--strict-mcp-config`, per invocation | No per-invocation flag: `codex mcp add` or `-c` config overrides *(assumption on exact key path)* |
| System prompt | `--system-prompt`, `--append-system-prompt` | No flag — `AGENTS.md` or prompt prefix |
| Auth | `~/.claude/.credentials.json` + keychain; `claude auth status` | `~/.codex/auth.json`; `codex login status`; `--ignore-user-config` keeps auth while dropping config |

The credential constraint holds cleanly: **neither CLI has any per-invocation
credential flag.** A spawned child inherits the stored login *(assumption —
help-text inference; no authenticated call was made in this spike)*. dohc
needs only the exit status of `claude auth status` / `codex login status` to
improve today's hardcoded "unknown" probe, and must never open either
credential file.

Traps for the driver author: `-p` means `--print` on Claude and `--profile`
on Codex; `-c` means `--continue` on Claude and `--config` on Codex; and
`claude --bare` looks like the clean-harness flag but disables the stored
login and demands an API key — the exact inversion of the BYOAI auth model.
In `-p` mode Claude skips the workspace-trust dialog and silently ignores
invalid settings files.

## 3. The gap: what a driver plugin needs

Against the plugin SDK as shipped (verified unchanged since the sites spike's
baseline — the diff `7ac22086..cf8a9fb0` touches only docs and one test):

| # | A harness driver needs | Status | Detail |
| --- | --- | --- | --- |
| 1 | Register as a driver | LACKS | Manifest contributes panels, commands, webApps, settings only (`plugins/pluginManifestSchema.ts:249-321`); nothing driver-shaped. The new contribution point (§3.1). |
| 2 | Spawn the harness executable | LACKS | The broker forks JS modules contained to the plugin root (`plugins/pluginChildProcessBroker.ts:469-476`). This is the sites spike's **P3** (command-capable brokered spawn) — cite, not re-argue. A driver additionally needs duplex stdio to the child (JSON-RPC/NDJSON both ways), where P3's sketch needed spawn + teardown + logs. |
| 3 | Probe and auth-check | LACKS | Same primitive as #2 (`--version`, `auth status` are spawns). |
| 4 | Receive the user's chat turn | HAS (core) | Dispatch scan, ledger, claims, budgets already exist engine-side (§1.2). A plugin needs this surface only under option B below. |
| 5 | Deliver the reply into chat | HAS (core, for the harness) | The harness itself replies through the CLI/MCP door with agent authorship, origin `cli`, and the run link (§1.2). Plugin **host code** has no chat surface at all — the plugin SDK routes zero chat methods (`plugins/pluginSdkHost.ts:119-190`) — and under option A it never needs one. |
| 6 | Hand the harness its MCP config | HAS (core) | `mcpRuntimeConfigFor` builds it and drivers receive it in `startSession` input (`main.ts:2051-2071`, `AgentDriver.ts:87-96`). |
| 7 | Surface permission requests | HAS (core) | The normalized event union and the answer IPC exist (`AgentDriver.ts:36-45`, `main.ts:9908-9914`). |
| 8 | Per-harness settings UX | HAS | Manifest settings render real UI (`pluginManifestSchema.ts:146-235`); the probe rows in Settings render from the registry (`AgentsMcpSettings.tsx:277-307`). |
| 9 | Attribute the harness's edits | HAS (core) | The run slot and moment authors are driver-agnostic (§1.5). |

### 3.1 The contribution point, weighed both ways

**Option A — core calls plugins (drivers as plugins).** The manifest grows
`drivers: [{id, displayName}]`; activation registers the driver the way
command ids already register (`PluginActivateResult.commands`,
`plugins/pluginHostProtocol.ts:33-35`); the host protocol grows
`driver.probe` / `driver.startSession` / `driver.prompt` / `driver.cancel` /
`driver.answerPermission` / `driver.stop` / `driver.dispose` requests — plus
the optional `setModel` and `answerUserInput` members
(`AgentDriver.ts:107-110`) — and a `driver.event` notification carrying the
`AgentEvent` union; core wraps each registration in an adapter that satisfies
`AgentDriver` and merges it into the existing registry
(`AgentDriver.ts:128-166`). Chat, dispatch, attribution, MCP config, and the
Settings UI do not change. Two shapes do not serialize as they stand and must
be redesigned at the seam, not passed through: `permissionPolicy` is a
**function-valued** field of the start input (`AgentDriver.ts:94`), so it
becomes a declarative policy or stays a host-side callback the plugin never
sees; `resumeCursor` is typed `unknown` (`:99-100`) and must be constrained
to JSON-serializable data. Two more details the code already anticipates: the
event union's `raw` fields must be dropped at the process boundary — the
type's own comment demands exactly that for future IPC consumers
(`AgentDriver.ts:11-13`) — and a crashing plugin maps to the session's
`closed`/fatal-error path, with the host's crash-loop auto-disable
(`pluginHostProtocol.ts:115-116`) bounding the blast radius. One trust
direction is new and inbound: `AgentProbe.auth.email`/`loginHint` carry a
must-not-cross-into-IPC-or-logs comment (`AgentDriver.ts:67-68`), and under
this option a **plugin supplies** those fields into core — core must treat
every probe field as untrusted display data and keep the redaction rule at
its own boundary.

**Option B — plugins call core (a chat SDK).** The SDK grows `chat.*` methods
plus a turn subscription; the plugin owns the loop: claim triggers, spawn the
harness, post replies. This is the wrong default for three reasons the code
makes concrete. The machinery a plugin would re-own is the 1,948-line
dispatch service — durable claims, budgets and pauses, failure notes,
presence, app-quit recovery, the self-test — per plugin. The invariants would
leave core: a plugin post is loop-safe only through the guards the trigger
SQL encodes — agent author kind, or the `origin` exclusion (§1.2,
`chats.rs:5451-5476`) — and a chat SDK that ever posts human-authored text
without that discipline creates an infinite dispatch loop, while
single-claim-per-workspace becomes a convention instead of a served
guarantee. And it contradicts the agreed
split — chat stays core; option B is chat-as-plugin wearing a smaller hat.
Option B's one real merit is agent shapes that are not "a local process per
harness" (a cloud agent, a fleet). That argues for a chat SDK **later**, as
its own decision, not for making it the driver mechanism now.

**Recommendation: option A.** The seam already exists and is exactly
harness-sized: everything harness-specific in the tree is
`AgentProcessDrivers.ts` (711 lines, two harnesses plus shared helpers) — the
residue elsewhere is inert (the literal id union at `AgentDriver.ts:1`, a
placeholder runner command at `RunnerSettingsCard.tsx:14-15`) plus one test
double, the 301-line `e2e/fixtures/fakeAgentProcess.mjs`, which encodes both
harness protocols and moves with the drivers; everything above the drivers is
neutral. The smallest honest contribution point is
driver registration routed through the core machinery. It adds no new chat
authority *surface*, but it does re-aim an existing one: the state-dir token
that the CLI client treats as the sole authentication gate
(`packages/cli/src/client.ts:21-31`) is handed to a harness child spawned by
installed plugin code instead of by a command the user typed. That is
acceptable exactly on the plugin plan's full-trust premise (Ice's 2026-07-28
call, design rule 3 in `2026-08-13-plugin-system.md`) — and it is the real
stake of decision 5 below.

### 3.2 What still has to meet in the middle

Path A and path B must converge for the VS Code model to hold: today the
chat-captured path is headless-per-turn and the streaming path is chat-less.
The join is dispatch driving a **driver session** instead of a raw command:
`startClaim` calls `driver.startSession` + `prompt()` with the trigger text,
and the session's `resumeCursor` (`AgentDriver.ts:99-100`) — backed by
`--session-id` on Claude and `exec resume` on Codex — gives a thread
continuity across turns instead of re-sending the whole rendered thread every
dispatch (`buildRunnerThreadContext` re-renders everything today,
`runnerThreadContext.ts:44-52`). The free-text runner command stays as the
escape hatch for harness #_n_ that no plugin covers yet. Whether the
session's streamed turn text also lands in the thread is decision 2 below —
the machinery question (events flowing) and the product question (what chat
shows) are separable.

## 4. The driver plugin sketch

What `claude-code` and `codex` plugins look like on today's SDK plus the
driver contribution (§3.1) and command-capable broker (P3):

- **Manifest** (`dohc-plugin.json`): `name: "dohc-driver-claude-code"`,
  `drivers: [{id: "claude-code", displayName: "Claude Code"}]`, a couple of
  typed settings (model, permission posture) that render real UI — unlike
  today's dead `agents.*` keys.
- **Probe**: brokered spawn of `claude --version`, then `claude auth status`
  (exit code only), filling the probe row that today hardcodes auth
  "unknown" (`AgentProcessDrivers.ts:94-104`). Harness missing → the row
  renders "Not found" with the existing install hint; nothing else activates.
- **Session (Claude)**: either keep the ACP adapter (`claude-code-acp` — a
  dependency the user must install separately; not present on this machine)
  or drive the native duplex protocol:
  `claude -p --input-format stream-json --output-format stream-json
  --session-id <minted uuid> --mcp-config <inline dohc-mcp json>`, mapping
  `can_use_tool` control requests to permission events and the `result` event
  to turn-completed. Working directory is the spawn cwd (no flag exists).
- **Session (Codex)**: `codex app-server` exactly as core does it today —
  that class (`AgentProcessDrivers.ts:541-703`) moves into the plugin nearly
  verbatim, including the mode→sandbox/approval mapping. Per-turn headless
  fallback: `codex exec --json -o <file> -C <root> --skip-git-repo-check`,
  resuming with `exec resume <threadId>`.
- **Workspace context**: cwd plus the injected dohc MCP server (files,
  search, sites, databases, chat — §1.4). Codex takes the MCP config in
  `thread/start`; headless Claude takes `--mcp-config` inline; headless Codex
  has no per-invocation flag and needs a `-c` override or `codex mcp add`
  *(assumption on the exact key)*.
- **Edits and provenance**: unchanged from today, by construction. The
  harness edits files in the workspace root; the capture watcher records
  moments attributed through the run slot the session already brackets
  (§1.5); review surfaces like the try-in-version card hang off the same
  run-ended seam (`main.ts:2210-2219`). Replies enter chat through the
  harness's own `dohc chat reply --as-agent` / `dohc_reply_to_chat`, keeping
  authorship, loop safety, and the run chip intact without adding any write
  path beyond the ones §1.2 names.
- **The worked example**: harness #3 is a copy of one driver class — roughly
  250–330 lines of "spawn this, map these events, probe like this" — plus a
  manifest. That matches the stated goal: the plugin is the documentation.

## 5. Decisions for Ice

1. **Contribution direction**: drivers as plugins behind the core registry
   (recommended), or a plugin chat-write SDK? — smaller contract and the
   loop/attribution invariants stay core, versus freedom for non-process
   agent shapes later.
2. **What chat shows**: keep the report contract (the harness posts what it
   chooses; the working transcript is not chat — today's rule,
   `chatDispatchService.ts:337`), or post each driver turn's final text as an
   agent message so the conversation reads like VS Code chat? — full captured
   memory versus channel legibility; a middle path is capturing the
   transcript as a workspace file and keeping chat for reports.
3. **Session lifecycle**: one resumable harness session per thread
   (`--session-id` / `exec resume`) or today's process-per-dispatch that
   re-sends the whole thread? — continuity and token cost versus stateless
   simplicity and crash isolation.
4. **Claude transport**: depend on `claude-code-acp` (a separate install that
   is absent on this very machine) or target the native stream-json duplex
   (present in 2.1.233, permission channel verified only as binary strings)?
5. **Bundling**: the sites spike's bundled-approval question applies verbatim
   to first-party driver plugins — ship pre-approved in the app image,
   install into `plugins/` (visible, forkable, prompts on dohc updates), or
   the eject hybrid?
6. **Dead settings**: wire `agents.defaultDriverId`/`defaultModel` into
   dispatch driver selection, or delete them until the driver work lands? —
   they currently promise behavior that does not exist.
7. **Dispatch permission posture**: chat-triggered runs are unsupervised
   today (no permission model at all), while driver sessions hardcode
   approval-required (`AgentSessionManager.ts:395`) — when dispatch drives a
   driver, which mode does it get, and does waiting-permission surface
   in-thread? Decide with the consequence in view: approval-required maps
   Codex to a **read-only** sandbox (`AgentProcessDrivers.ts:168-173`), and no
   in-thread permission surface exists yet — choosing it today makes
   unattended dispatch useless as-is.

## 6. Verdict and sizes

| Piece | Size | Why this size |
| --- | --- | --- |
| **W1. Driver contribution point** — manifest field, `driver.*` host-protocol methods, plugin-backed `AgentDriver` adapter, registry merge, Settings list merge | **M** | Every seam exists: the interface (`AgentDriver.ts:113-118`), the registry, the bidirectional request/notify transport (`pluginHostProtocol.ts:121-128`), the activation-registration pattern (`:33-35`). New work is protocol cases, serializable event mapping (drop `raw`), the two non-serializable shapes (§3.1: `permissionPolicy`, `resumeCursor`), and lifetime binding to plugin crashes. |
| **W2. Command-capable broker with duplex stdio** — supersets the sites spike's P3 | **M** | P3's spawn/teardown/containment argument carries over unchanged; the addition is message-stream access to the child's stdio, which the broker's existing supervised-child plumbing was built around. |
| **W3. Dispatch drives driver sessions** — claim → `startSession`/`prompt`, resume cursors per thread, runner command kept as fallback | **M** | `startClaim` is one seam (`chatDispatchService.ts:977-1050`); the sessions and cursors exist; the work is lifecycle (session-per-thread vs per-workspace), mode selection (decision 7), and failure-note parity. One favorable fact: the broker is constructed main-side per workspace with POSIX and Windows tree kills and `disposeSpawn` (`pluginChildProcessBroker.ts:11,96-101,282`), so core keeps kill authority over a harness child without plugin cooperation — the dispatch timeout crosses the boundary as a broker dispose, never as a request the plugin must honor. |
| **W4. Session events into the chat surface** — presence upgrade, optional turn-text posting per decision 2 | **S–M** | Presence and `onMessagePosted` push exist; posting turn text is a `sendMessage` from main (the service-note path, `chatDispatchService.ts:638-649`) — the size is in the product choice, not the plumbing. |
| **W5. `claude-code` driver plugin** | **S** | One driver class plus manifest (§4); the ACP variant is a move of existing code. Native-protocol variant needs the two binary-strings claims verified first. |
| **W6. `codex` driver plugin** | **S** | `CodexAppServerDriver` moves nearly verbatim (`AgentProcessDrivers.ts:541-703`). |
| **W7. Settings reconciliation** — wire or delete `agents.*`; auth-status probes | **S** | Decision 6; probes are two exit-code spawns once W2 exists. Mid-session expiry is already modelled: the event union carries `auth`/`login-required` (`AgentDriver.ts:53-57`), emitted today on Codex token-refresh refusals (`AgentProcessDrivers.ts:586-593`) — wire it to a visible re-login prompt so an expired login fails as itself, not as a run timeout. |

**Buildable on the planned primitives — yes, and with less substrate work
than Sites needed.** The sites conversion surfaced two L items (read-only
authority, scoped sub-grants); the driver program surfaces none, because the
heavy machinery — chat tables, dispatch ledger, run attribution, MCP
tiering — already ships in the engine and stays there. The one genuinely new
authority question (plugins writing chat) is avoided entirely by option A.
The verdict's one exposure is W2: if arbitrary-executable containment becomes
a policy question — which executables a plugin may spawn, whether the user
approves them — W2 grows L-shaped.
Sequencing that falls out: W1+W2 together (W1 is inert without a spawn
primitive), then W5/W6 as the extraction proof (delete the moved classes from
`AgentProcessDrivers.ts` in the same change, per the no-compat rule), with
W3/W4 as the product milestone that makes the two existing paths one. Fix the
stale dispatch fixture (§1.2, #824) before any of it, so the loop being
changed is the loop being tested.
