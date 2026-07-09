# dohc Chats — Agent Runner & Dispatch Spec

Status: draft for review, rev 2 (incorporates multi-agent review findings)
Date: 2026-07-10
Companion to: `2026-07-10-dohc-chats-hybrid-feed-spec.md`,
`2026-07-10-dohc-chats-cli-spec.md`

## Summary

A chat message addressed to an agent must cause an agent to actually work.
This spec defines that dispatch loop: a message lands → dohc spawns the user's
own agent harness as a local process → the harness works in the workspace and
reports back through the `dohc chat` CLI.

The core inversion: **dohc runs harnesses, not models.** dohc never calls a
model API and holds no model credentials. A "runner" is a user-configured
shell command — `claude -p`, `codex exec`, or any script that accepts a prompt
and can run shell commands. Subscription-authenticated harnesses work because
they run on the machine where the subscription already lives. API-based agents
are not a separate integration path; they are just another runner command.

Honest v1 scope: the remote sender surface is any device already running the
dohc app; the dedicated **phone client does not exist yet** and is a separate
client workstream (see Deferred). Everything below is built so that when a
phone surface ships, it plugs into this loop unchanged.

## Decisions locked

1. **A runner is a command template; the config is a trust anchor.** It is
   stored **outside the workspace tree** in the app config directory, edited
   only by the human through dohc settings, and read fresh from that trusted
   location on every dispatch. It must never be derivable from agent-writable
   workspace content — a dispatched harness has shell access to the workspace,
   and a runner config it can rewrite is remote code execution on the next
   dispatch. Corollaries: prefer sandboxed runner commands (an unsandboxed
   runner can write anywhere on disk, including the app config dir, and voids
   this protection — say so in the settings UI); dohc owns one non-negotiable
   contract regardless of flags: **the report CLI must be reachable from
   inside the harness sandbox.** Illustrative configs that actually satisfy
   the report contract:

   ```
   runner: claude -p --permission-mode acceptEdits --allowedTools "Bash(dohc chat:*)"
   # or: codex exec --sandbox workspace-write -c sandbox_workspace_write.network_access=true
   # or: ./scripts/my-agent.sh
   ```

   (Plain `--permission-mode acceptEdits` auto-denies Bash in headless mode —
   the loop would "work" but never report. Codex's workspace-write sandbox
   blocks network by default, which kills the loopback IPC transport.)
   **Config-time self-test:** on save, dohc spawns the runner with a canned
   prompt that must post exactly one message to a scratch thread and verifies
   it lands. A sandbox that blocks the report path is caught at setup, not on
   the first remote dispatch.
2. **One agent per workspace, v1.** "My agent" — matching the
   `<User>'s agent` author model. Specialization is skills, not personas.
3. **The runner host is the desktop.** Subscription auth lives on the user's
   device. Cloud runners are out of scope.
4. **The agent-DM is a new primitive, not today's DM.** Shipped DMs are
   human-to-human and grant-based (email recipients → relay chat-channel
   grants to another authenticated user). The agent has no relay identity, so
   no existing construct can address it. Define a new
   `ChatChannelKind: "agent"`: auto-provisioned per workspace ("My agent"),
   owner-only, **never carries a share grant**, and replicates across the
   owner's own devices over the owner's own-device sync lane — explicitly not
   the per-recipient shareFilter grant lane human DMs ride. Everything that
   keys on DM-ness must point at the new kind too: the dispatcher triggers on
   `kind:"agent"` channels, the projection default ("agent DM threads
   project") keys on it, and presence scoping resolves it. Implementation
   gate: confirm the own-device sync lane actually replicates unshared
   channels today; if only share-backed channels replicate, an owner-device
   replication path for `kind:"agent"` is part of this work (open question 1).
5. **Triggers are engine-side and author-gated.** v1 triggers: a
   **human-authored** message in the agent-DM channel, and an `@agent`
   mention by the workspace owner in a post or comment. Only committed,
   human-authored messages with typed addressing create triggers;
   agent-authored messages never do; **CLI-origin writes never do** (human
   dispatch arrives via the UI or the relay — a message posted through the
   local CLI socket is by definition an agent's hands or a terminal, not the
   remote flow). Channel subscriptions with standing instructions are phase 2.
6. **Dispatch is a durable ledger, never a read cursor.** Each trigger gets a
   dispatch record (`triggerMessageId → pending | running | done`, plus
   `runId`) written **before** spawn and keyed by message id, so relay replay
   on reconnect cannot double-spawn. "Pending" means a dispatch record
   without a completed run — it is never inferred from read-by-agent state.
   The runner packs context with `show --peek`; the agent read cursor
   advances only on successful reply or explicit completion (otherwise a
   mid-run `show` would silently consume a queued follow-up). On app
   startup, sweep run records with no exit: post the in-thread failure note
   and re-dispatch once.
7. **A UI-independent dispatch service lives in the main process.** Today
   chat sync is renderer-driven polling that only runs while a chat view is
   open; the loop cannot ride that. An always-on main-process service (a)
   pulls relay ops on interval/reconnect and (b) observes newly applied
   `chat.message.append` ops, feeding trigger predicate → ledger → spawn. It
   runs with every window closed.
8. **Thread = session; mid-run messages steer when the harness can, queue
   when it can't.** One live run per thread. If the harness supports live
   input (e.g. Claude Code headless with stream-JSON input), messages
   arriving mid-run are delivered at the next model boundary — OpenClaw's
   steer semantics, provided by the harness instead of by dohc owning a model
   loop. Otherwise they queue as the next turn: resume the harness session
   when supported (`claude -p --resume`), or re-pack the thread context
   fresh. Follow-up is the guaranteed baseline; steering is a per-runner
   capability flag.
9. **The prompt is a context pack plus a report contract.** The runner
   assembles: the thread rendered as markdown (via `dohc chat show --peek`),
   paths of attached work objects, and a fixed instruction block: *reply
   in-thread with `dohc chat reply`; report outcomes, don't stream tool logs;
   on long tasks post progress the way a teammate would; if blocked on the
   user, reply with `--needs-decision`; your final text is not shown anywhere
   — only what you post via the CLI is.*
10. **Attribution is ambient — and never load-bearing.** The runner exports
    env vars (`DOHC_CHAT_THREAD`, `DOHC_CHAT_ACTOR=agent`, `DOHC_RUN_ID`) so
    CLI calls inside the run are attributed as the agent and linked to the
    run. These are display/provenance conveniences only: a child process can
    shed an env var, so **no dispatch, loop-prevention, or authorization
    decision may key on them** (see 11).
11. **Loop prevention is engine-side with a hard budget.** Layered: (a) the
    trigger predicate in decision 5 (agent-authored and CLI-origin messages
    never trigger); (b) where the transport allows (local unix socket), the
    engine correlates a CLI write to the active run by process ancestry —
    peer PID descending from the run's spawned process group — which env
    manipulation cannot shed; (c) a mandatory backstop independent of any
    client signal: a per-thread re-dispatch budget (max N runs per thread per
    rolling window, exponential backoff), and on breach the thread's dispatch
    auto-pauses with a system note. The budget is the real guarantee; origin
    rules are the precision layer. (Ancestry is unavailable across the
    WSL↔Windows boundary, which is exactly why the budget is mandatory.)
12. **Never fail silently — durably.** The guarantees are the dispatch ledger
    (decision 6), the startup sweep, and the in-thread failure note on
    crash/timeout/no-reply, all durable engine state. The sender-side
    "delivered but not picked up" status derives from the replication log
    (message present, no dispatch record progress) — not from presence.
13. **Agent presence is a cosmetic hint.** `working | idle` ships as an
    additive opaque payload state on the existing presence surface, published
    under the owner's relay identity with a distinct agent `clientId` (the
    payload schema gains the agent flag). It is best-effort, self-expiring,
    and absent entirely in pure-solo/offline mode; nothing reliability-shaped
    may depend on it.
14. **Concurrency: one live run per workspace, v1.** This matches the shipped
    single per-workspace run-attribution slot (FS-capture attribution assumes
    one active run). Cross-thread triggers join a bounded workspace FIFO with
    per-thread coalescing; backpressure is surfaced in-thread ("queued behind
    <thread>"). The reconnect drain feeds the same FIFO oldest-first. Future
    parallelism means per-run worktree isolation and per-run attribution —
    not more concurrent runs on the shared checkout.
15. **dohc grants nothing.** The harness runs with the permissions the user
    configured. Engine-side gates (locks, folder/atom access, skill-turn
    gates, sharing boundaries) still apply to every workspace write the run
    makes through the engine. (Note the limit honestly: engine gates do not
    mediate raw shell filesystem writes — that boundary is the harness
    sandbox, which is why decision 1 keeps the trust anchor outside the
    workspace and recommends sandboxed runners.)
16. **Run records are owner-private, workspace-scoped.** A run persists
    `{ workspaceId, threadId, command, startedAtMs, exitCode, logPath }`;
    agent messages carry a chip that opens it. The record and its log never
    cross a share, projection, search, or export surface — the log is raw
    harness stdout/stderr and may contain anything the harness printed
    (secrets included), so it is a local, access-gated file that is never
    inlined into any atom. Chat shows the report; the trace stays behind the
    chip.
17. **Stopping a run targets only what we own.** SIGTERM to the specific
    child process group the runner spawned. No pattern-matching kills, ever.
18. **Offline is a queue, not an error.** With the desktop offline, triggers
    accumulate durably (relay-side, then ledger on reconnect via decision 7's
    pull). Presence reads offline; the sender-side status derives per
    decision 12. On reconnect the dispatch service drains the FIFO
    oldest-first under the decision-14 cap.
19. **Only the workspace owner's agent answers, v1.** An `@agent` mention
    from another user in a shared channel does not dispatch. Cross-user
    dispatch is a consent problem and is deferred.

## Migration: the shipped mention-dispatch path

The desktop already ships a renderer-side agent system this spec must
reconcile with, not ignore: the ChatsView mention roster feeds
`handleAgentMentioned` (DesktopWorkspaceShell) with a workspace-global
`agentActive` busy queue, backed by `AgentSessionManager` with ACP drivers
(`claude-code-acp`, codex app-server) and a `dohc` MCP server; ChatsView also
has an "Addressed to me" `agentNotifications` inbox. Reconciliation:

- **The engine-level dispatcher becomes the single dispatch authority.**
  `handleAgentMentioned` is deleted or becomes a thin call into it; the
  renderer never dispatches. (This also fixes a shipped gap: relay-arrived
  mentions never triggered the renderer path.)
- **v1 runner invocation is the plain headless shell command**, not ACP
  sessions: harness-agnostic, subscription-native, and one architecture to
  harden. The ACP drivers remain for the interactive agent panel; wrapping
  ACP as an alternative runner kind is a later option, not a v1 branch.
- The workspace-global busy queue is subsumed by the decision-14 FIFO.
- `agentNotifications` ask/needs-input types map onto the typed
  needs-decision state (defined in the hybrid-feed spec) and are then
  deprecated.

## The loop, end to end

```
sender surface (desktop UI; later: phone client): DM "audit the projections"
  → relay → desktop dispatch service (always-on, main process)
  → trigger predicate: human-authored, kind:"agent" channel, not CLI-origin
  → dispatch record written (pending) → spawn runner (FIFO slot)
      presence: agent working (cosmetic)
      prompt = thread markdown (show --peek) + attachments + report contract
  → harness works; posts progress / needs-decision / done via `dohc chat reply`
      (env-attributed to the agent, linked to the run)
  → exit: run record completed; ledger → done; read cursor advances
  → user replies "also check the exports"
  → steer at model boundary if capable, else new pending record → next turn
```

## needs-decision handling

Decisions are per-message records, not a thread scalar (see the hybrid-feed
spec): an agent reply with `--needs-decision` opens a decision on that
message; the thread renders needs-decision while any decision is open. The
run may exit — it does not block waiting. The user's decision reply is just
the next queued trigger; the resolving reply (CLI `--resolve` or the UI
gesture) closes the specific decision record.

## Deferred

- **The phone client** — a net-new client workstream (auth, relay
  append/pull, push notifications, chip rendering, decision submission),
  specified separately. The flagship "decide from your phone" claim is gated
  on it; nothing in this loop changes when it arrives. Note: workspace-api is
  auth-only and must not grow application routes for this.
- **Channel subscriptions / standing instructions** (phase 2).
- **Cloud runners**; **multiple named runners**; **cross-user dispatch**;
  **queue-mode controls** (steer/followup/collect/interrupt à la OpenClaw —
  v1 ships steer-if-capable plus the stop button); **ACP as a runner kind**.

## Open questions

1. Does the own-device sync lane replicate unshared channels today, or does
   `kind:"agent"` need a new owner-device replication path? (Must be answered
   before the first slice; the phone hop depends on it.)
2. Default run timeout (lean: 30m — long tasks post progress and the user can
   stop from the thread).
3. Does an `@agent` mention in a comment pack the whole post thread or just
   the branch? (Lean: whole thread; branches are presentation.)
4. Re-dispatch budget defaults (lean: 5 runs per thread per 10 minutes, then
   auto-pause with a system note).

## First slice

1. `kind:"agent"` channel: auto-provision, own-device replication confirmed
   or built, dispatcher keyed on it.
2. Main-process dispatch service (relay pull + append observation, UI
   independent).
3. Dispatch ledger + trigger predicate + startup sweep + re-dispatch budget.
4. Runner config in app config dir + settings UI + config-time self-test.
5. Spawn with report-contract prompt (`show --peek` context pack); failure
   note on silent exit; SIGTERM stop from the thread UI.
6. Run records (owner-private) + trace chip; env-var attribution.
7. Workspace FIFO + queued follow-up turns (resume if the harness supports
   it).
8. Presence working/idle (cosmetic).
9. `@agent` mention trigger (owner-authored) in posts/comments, replacing
   `handleAgentMentioned` per the migration section.

This slice makes "message your agent from another dohc surface, get a report
with chips" real with any harness the user already pays for — and leaves a
clean socket for the phone client to plug into.
