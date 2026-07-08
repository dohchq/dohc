# Think Bigger Multi-User Chat Execution Log

Read-only summary: append-only record of the lanes landed against the
multi-user chat design. Created: 2026-07-07.

Plan:

- [Think Bigger Multi-User Chat](./2026-07-07-think-bigger-multiuser-chat-design.md)

## Verified Chat Authorship MU-C0

The foundational security lane: the relay now stamps/verifies that a chat op's
claimed author equals the authenticated pushing actor before the op is admitted
to the replication log. This closes the reaction-forgery / PII gap MU-C2 shipped
with a documented `⚠️` and unblocks DMs (MU-C3) + shared channels (MU-C4) — they
now build recipient-scoping on a VERIFIED identity. Depends on 0P-B (the relay)
only.

### The trust boundary — where/how the relay verifies

The engine cannot verify authorship: it has no origin→user map. The relay can —
it authenticates WHO is pushing (`actor.userId`, server-derived from the Better
Auth session via `resolveActor`; a client cannot assert it). MU-C0 adds
`assertChatAuthorship(rawOps, actor.userId)` to the `POST /sync/:ws/log`
append path (`services/sync-relay/src/server.ts`), running BEFORE
`storage.appendLogBatch` so a batch mixing one forged op with valid ones is
rejected atomically — nothing reaches the log. For every op naming an author it
checks the claim against the pusher:

- `chat.message.append.authorUserId` — OPTIONAL. Absent = a solo/legacy send
  (no verified identity, allowed); present and ≠ actor → reject.
- `chat.reaction.set.authorId` — REQUIRED. Missing/non-string OR ≠ actor →
  reject (a reaction is inherently an authored act; fail-closed).
- Any future authored chat op is covered by adding it to `CHAT_AUTHOR_FIELDS`.

A mismatch throws `403 authorship_mismatch` (not 404: the caller is
authenticated and owns the bucket — the request is forbidden, not hidden;
non-retryable — the client must send its OWN id). This is the second narrow,
tested relaxation of "chat payloads are opaque" (after PR-18's share filter),
scoped to one field, fail-closed. The shared-channel member-append route (MU-C4)
reuses the same gate.

### Canonical opaque author identity (message + reaction)

Authorship keys on the OPAQUE Better Auth user id — NEVER a raw email (a raw
email would replicate into the immutable CRDT history: PII/GDPR exposure). This
is the same id the client already derives and the relay verifies as
`actor.userId`.

- `ChatMessageAppendPayload` and `ChatMessage` gained an optional
  `authorUserId` (`packages/workspace-contracts/src/engine.ts`). The store's
  `sendMessage` / `startChannelThread` take an optional `authorUserId`, persist
  it to a new lazy-additive nullable `chat_messages.author_user_id` column
  (`engineDbSchema.ts` `ensureNullableColumn`), carry it in the journaled op
  ONLY when present, and return it. The apply path persists the replicated value
  (authoritative only because the relay verified it). The display name
  (`authorDisplayName` / `author`) stays a SEPARATE, non-authoritative field —
  rendering only, never identity/authz.
- Desktop main stamps `authorUserId: relayAuthorUserId()` on both send paths;
  `relayAuthorUserId()` returns `cachedCredentials?.userId` (opaque) ONLY when
  signed in, so a solo/signed-out send OMITS the field and its op is
  byte-identical to the pre-MU-C0 shape. Identity is main-derived, never
  renderer-supplied.
- Reactions already carry the opaque `authorId` (MU-C2's fix via
  `cachedCredentials.userId ?? localReactorFallbackId()`); MU-C0 makes the relay
  verify it. No raw email is used as an identity/CRDT key anywhere — grep-confirmed
  across the engine chat store, the contracts, the relay, and desktop
  (`cachedCredentials.email` survives ONLY in `localUserDisplayName()` (display)
  and an MCP env var, never as an author id).

### Engine side — trusts the relay; the MU-C2 `⚠️` notes are CLOSED

The engine's `applyReplicationOp` still trusts `authorId`/`authorUserId`
verbatim, and this is now correct: a replicated authored op is authoritative
ONLY because the relay verified it before admitting it to the log; a
locally-applied op uses the local identity; the no-relay/solo path is a single
trusted user. The three MU-C2 "unverified until MU-C0" notes are updated to
reflect the close: the `chat.reaction.set` apply-site comment
(`linkedChatStore.ts`), the design doc's Reactions `⚠️ SECURITY` block (now `✅
VERIFIED`) and Authenticated-authorship section, and this log.

### Adversarial forgery-rejection evidence (BLOCKING, incl. over-HTTP)

- Relay unit (`server.test.ts`, +8): honest author (msg + reaction) admitted;
  solo message omitting `authorUserId` admitted (byte-identical); a
  `message.append` forging another user's `authorUserId` → 403
  `authorship_mismatch`, log unchanged; a `chat.reaction.set` forging
  `authorId` → 403, log unchanged; a reaction with NO `authorId` → 403
  (fail-closed); a batch mixing one valid + one forged op → 403 ATOMIC (the
  valid op is NOT admitted either); a non-chat opaque op carrying an
  `authorId`-shaped field passes through untouched.
- Relay child-process integration (`main.integration.test.ts`, +1, real HTTP):
  a second authenticated user (alice, owns the bucket) cannot forge mallory's
  authorship on a message or a reaction (403, empty log); a mixed batch is
  rejected atomically; alice authoring as HERSELF is admitted. Proves the relay
  derives identity server-side over the wire.
- Engine (`linkedChatStore.test.ts`, +3): a solo `message.append` OMITS
  `authorUserId` (byte-identical); a signed-in send stamps the opaque id, both
  send paths journal it, and a fresh peer persists+returns it through the real
  apply path; an invalid (blank/oversized) `authorUserId` is rejected at the
  store boundary.

### Suite counts (Linux-green)

- `pnpm -r typecheck`: green (all 13 packages).
- sync-relay: 75 passed (server 32 incl. +8, main.integration 13 incl. +1,
  shares 14, shareFilter 16). The MU-C2 chat fuzz (agent messages, no
  `authorUserId`) still converges — solo/absent ops admitted.
- workspace-engine: default config 376 passed (+3); fs-lock config 128
  passed / 5 skipped.
- desktop: 1082 passed / 2 skipped, +1 pre-existing parallel-load flake
  (`FileInspector.engineSaveState.test.tsx`, a transient "saving" timing
  assertion) that passes on isolated re-run — same class as the documented
  MU-C2 `versionedFileWorkspace` flake, unrelated to this lane. Chat renderer
  suites (chatMessages/ChatsView/LinkedChats) green.
- workspace-auth: 8 passed. `git diff --check`: clean.

### Files changed

- `packages/workspace-contracts/src/engine.ts` — `authorUserId` on
  `ChatMessageAppendPayload` + `ChatMessage`; `authorUserId` input on
  `sendMessage` / `startChannelThread`.
- `packages/workspace-engine/src/{engineDbSchema.ts, linkedChatStore.ts}` —
  lazy-additive `chat_messages.author_user_id` column; `normalizeAuthorUserId`;
  plumb + persist + return `authorUserId` on send/start/apply; row mapping;
  updated reaction apply-site trust-boundary comment.
- `services/sync-relay/src/server.ts` — `assertChatAuthorship` +
  `CHAT_AUTHOR_FIELDS` + `authorshipMismatch()` (403); wired into `POST /log`.
- `apps/desktop/src/main.ts` — `relayAuthorUserId()`; stamp on both send paths.
- Tests: `services/sync-relay/src/{server.test.ts, main.integration.test.ts}`,
  `packages/workspace-engine/src/linkedChatStore.test.ts`.
- Docs: the design doc (Reactions `⚠️`→`✅`, Authenticated-authorship note) and
  this log.

### Handoff to DMs (MU-C3) + shared channels (MU-C4)

Both now have a VERIFIED, server-derived author identity to build
recipient-scoping on. The append-time gate (`assertChatAuthorship`) is the
reusable primitive: MU-C4's `POST /sync/shares/:shareId/log` member-append route
runs the SAME check (plus the chat-aware `filterOpForShare` branch scoping to
the granted `channelWireId`), and MU-C3's DM messages/reactions inherit it
unchanged. `authorUserId` is persisted and returned, so recipient/participant UI
can key on the durable opaque id, never the display name.

## Chat Reactions MU-C2

Durable, commutative emoji reactions on chat messages — solo AND replicated.
Independent of G2-C (no editor/presence dependency).

### The op — `chat.reaction.set`

New `SyncReplicationOpKind` + discriminated envelope member
(`packages/workspace-contracts/src/engine.ts`). Payload
`ChatReactionSetPayload` = `{ reactionId, messageId, threadId, emoji, authorId,
authorKind, authorDisplayName, state: "added"|"removed", atMs }`. Blob-free; it
rides the SAME 0P chat push/pull/apply pipeline as the other three chat kinds
(`journalLocalReplicationOp` → relay → `applyReplicationOp`). The relay is
op-kind-agnostic (treats `opKind` as an opaque ≤128-char string, no allowlist),
so no relay changes were needed.

### CRDT semantics — LWW-per-cell (why commutative + idempotent)

State is an observed register per `(messageId, emoji, authorId)` CELL. Each cell
keeps the op maximizing a STRICT TOTAL order
`(atMs, stateRank['removed'=1 > 'added'=0], originId, originSeq)`. Apply is one
conflict-target upsert whose `WHERE` admits the incoming op only if it is
strictly GREATER by that order:

```
ON CONFLICT(workspace_id, message_id, emoji, author_id) DO UPDATE SET …
  WHERE excluded.at_ms > chat_reactions.at_ms
     OR (excluded.at_ms = chat_reactions.at_ms
         AND (excluded.state > chat_reactions.state
           OR (excluded.state = chat_reactions.state
               AND (excluded.origin_id > chat_reactions.origin_id
                 OR (excluded.origin_id = chat_reactions.origin_id
                     AND excluded.origin_seq > chat_reactions.origin_seq)))))
```

Because `(origin_id, origin_seq)` uniquely names every op, the tuple has NO
residual ties: two ops with equal `(atMs, state)` but different origins resolve
to the SAME winner on every peer regardless of arrival order. The op's origin
coordinates are read from the replication envelope on the apply path and minted
locally (this device's origin + the seq the op journals at) on the `setReaction`
path, so both paths store the identical tie-break key.

- Commutative: the winner is `max` over a total order → applying the same set of
  ops in ANY interleaving (across incremental sync passes, not just one merged
  pass) converges. Different authors never share a cell, so cross-user
  add/remove never conflict.
- Idempotent: re-applying an op is never strictly newer than the value it
  already produced → a no-op. Tombstones ('removed' rows) are RETAINED so a
  stale re-add cannot revive a newer remove.

Chosen over the plan's op-order 2P-set because LWW converges under arbitrary
ARRIVAL order (the two-store fuzz gate), where naive INSERT-OR-IGNORE/DELETE
would diverge when an older remove arrives after a newer add.

### Store schema + apply

`chat_reactions` table (lazy-additive, NOT in `REQUIRED_ENGINE_TABLES` — same
posture as the channel tables), PK `(workspace_id, message_id, emoji,
author_id)`, columns `reaction_id, thread_id, state, at_ms, author_kind,
author_display_name, origin_id, origin_seq`, indexed by
`(workspace_id, thread_id, message_id)`. No FK to `chat_messages` — a
cross-origin reaction can arrive before the message it targets, and the CRDT
converges regardless of that order. Store methods `setReaction` / `listReactions`
(`linkedChatStore.ts`) share the `upsertReactionLww` statement verbatim with the
`chat.reaction.set` branch of `applyReplicationOp`, so a local set and an
imported op can never drift. `listReactions` INNER JOINs `chat_messages` on
`(workspace_id, thread_id, message_id)` so a reaction for an absent / unseeable
message never surfaces to the UI (orphans stay in the table for convergence).
`syncApply.ts` dispatches the new kind to the chat store. The reaction apply
branch carries NO head-check (like `ydoc.update`).

### Solo + replicated proof (two-store convergence)

Solo: `setReaction` persists with no relay and journals the op so it replicates
on first sync. Engine tests (`linkedChatStore.test.ts`, 9 new): solo add/list,
reacting to an AGENT message (individual-first), toggle-off with a retained
tombstone, `message-not-found` guard, distinct reactors, FULL two-store
replication over the chat pipeline (channel→thread→message→reaction) with
idempotent whole-stream replay, add/remove commutativity + remove-wins tie
across two apply orders, CRDT-level idempotency (a stale re-add never revives a
newer remove), and a two-engine random-interleaving FUZZ that converges to the
LWW winner.

### UI / taste

Reactions render in the shared `ChatMessageList` (`chatMessages.tsx`) used by
BOTH the Chats view and the file-rail LinkedChats panel, so authorship and
affordances never fork. Grouped pills (emoji + count, the viewer's own
highlighted with `aria-pressed`, a "who reacted" tooltip that labels agent
reactors as "<name>'s agent"), plus a subtle per-message quick-pick (a short
8-emoji set, `role=menu`, Escape-to-close, outside-press dismiss) revealed on
hover/focus. Reacting to an agent's message is first-class. Identity is
main-derived (`setChatReaction` attributes the local user, never renderer-
supplied); toggles are optimistic and reconcile to the canonical list under the
liveness token. Renderer tests: 5 new in `chatMessages.test.tsx`; existing
Chats/LinkedChats suites updated for the new bridge methods.

### Forward-compat with MU-C0 (verified authorship)

`authorId` is the field the relay later stamps/verifies as `actor.userId`. Solo
it anchors on the local user id (`cachedCredentials.email ?? "local-user"`);
`authorKind`/`authorDisplayName` ride along so replicated reactions render
without a separate lookup. No blocking dependency on MU-C0.

### Suite counts (Linux)

- Engine: 447 baseline + 9 new = 456 (main config; the documented
  `versionedFileWorkspace` flake under parallel load passes on isolated re-run).
- Desktop: 1045 baseline + 5 new = 1050 passed (2 skipped).
- `pnpm -r typecheck` green; desktop `build` green; `git diff --check` clean.
- Relay untouched (op-kind-agnostic transport), so no sync-relay changes.

### Files changed

- `packages/workspace-contracts/src/engine.ts` — op kind, `ChatReactionSetPayload`,
  `ChatReaction`/`ChatReactionAuthor`/`ChatReactionState`, envelope member, store
  interface methods, `message-not-found` error code.
- `packages/workspace-engine/src/{engineDbSchema.ts, syncReplication.ts,
  linkedChatStore.ts, syncApply.ts, index.ts}` — table, re-exports, store
  methods + LWW apply, dispatch.
- `apps/desktop/src/{ipc/bridgeContract.ts, ipc/channels.ts, preload.ts,
  main.ts}` — reaction records, channels, preload bindings, IPC handlers +
  local reactor identity.
- `apps/desktop/src/renderer/workbench/{chatMessages.tsx, ChatsView.tsx,
  LinkedChats.tsx}` — reaction UI + wiring.
- Tests: `linkedChatStore.test.ts`, `chatMessages.test.tsx`,
  `ChatsView.test.tsx`, `LinkedChats.test.tsx`.

### Gate-fix round (PR #93 review)

A codex review of the MU-C2 lane found four correctness/security issues; this
round fixed three and DOCUMENTED the fourth (whose real fix is the MU-C0 lane).

1. **LWW register was not a total order → permanent divergence (HIGH, fixed).**
   The register compared only `(atMs, state)`; two ops with equal `(atMs, state)`
   but different `origin`/`threadId` were resolved by ARRIVAL ORDER (the "strictly
   newer" `WHERE` rejected the second), so peers could store different rows and
   diverge forever (visibly, when `threadId` differs). Fix: the register is now a
   STRICT total order `(atMs, stateRank, origin_id, origin_seq)`. `origin_id` /
   `origin_seq` are stored on each cell — read from the replication envelope on
   apply, minted locally (this device's origin + the seq the op journals at) on
   `setReaction`. Because `(origin_id, origin_seq)` uniquely names every op the
   order has no residual ties, so all peers converge to the same winner under any
   arrival order. Proof: a new cross-origin equal-`(atMs,state)` convergence test
   plus the fuzz extended to only advance its clock half the time (deliberate
   cross-origin `atMs` ties) with the expected winner computed by the full tuple.

2. **Forged authorship on the replicated apply (HIGH, DOCUMENTED — real fix is
   MU-C0).** `authorId` is part of the CRDT cell key and the replicated apply
   trusts the payload verbatim, so an authenticated relay collaborator can
   add/remove a VICTIM's reaction cell. The engine cannot map a replication
   origin to a user, so it cannot verify here — that is MU-C0's relay-side job.
   This round: (a) confirmed the LOCAL IPC path is clean (desktop main derives
   `authorId` from the signed-in user, never the renderer); (b) documented the
   limitation operator-facing — a prominent `⚠️ SECURITY` block in the design doc
   Reactions/Authorization section, this log entry, and a prominent comment at the
   `chat.reaction.set` apply site — stating replicated reaction authorship is
   UNVERIFIED until MU-C0, so shared reactions are solo / trusted-relay-
   collaborators only. **What MU-C0 must do to close it:** the relay stamps and
   verifies `authorId === actor.userId` server-side on shared channels (the same
   origin→user provenance it establishes for `message.append`) BEFORE a reaction
   op is admitted to the replication log; ops whose claimed author ≠ the
   authenticated actor are rejected. Only then may replicated reaction authorship
   be trusted, and shared reactions enabled across untrusted relay members.

3. **Clock skew could pin a cell forever (MEDIUM, fixed).** A device with a
   far-future clock adds a reaction; a correctly-clocked device's later remove has
   a lower `atMs` → rejected everywhere → the cell can't change. Fix: at the
   replicated trust boundary, `clampFutureReactionAtMs` clamps an incoming op's
   `atMs` to `localNow + REACTION_MAX_FUTURE_SKEW_MS` (5 min) so a runaway-future
   op can't outrun every real clock — the pin is bounded to minutes instead of
   forever. Documented as a minimal mitigation, not a determinism guarantee
   (peers clamp against their own clocks, so a clamped op can transiently diverge
   until a later in-window op settles it; a hybrid logical clock would remove that
   residue — deferred). Local ops are unclamped (own trusted clock). Proof: a new
   test where a far-future add is clamped and a later remove with a lower raw
   `atMs` still wins.

4. **Orphan reactions leaked metadata / grew unbounded (MEDIUM, fixed).**
   `listReactions` returned active rows by `thread_id` WITHOUT joining
   `chat_messages`, so reactions for messages the viewer can't see (or that don't
   exist) leaked to the renderer. Fix: `listReactions` INNER JOINs `chat_messages`
   on `(workspace_id, thread_id, message_id)` so only reactions for PRESENT
   messages surface; orphans stay in the table for eventual convergence (a bounded
   pending-orphan GC is noted as a future nicety, not done here). Proof: a new
   test that an orphan reaction (no matching message) does not appear in
   `listReactions` output while a real reaction does.

Two CodeRabbit findings on the exact reworked code were folded into this round:
(a) **local at_ms is now strictly monotonic per cell** — `setReaction` bumps
`atMs` past the stored cell so a fast toggle (remove → re-add within one ms)
doesn't tie and lose to the remove under the remove-wins rule (the total order
puts stateRank above origin_seq, so a same-origin causally-later re-add needed
the bump); (b) the convergence **fuzz is now seeded** (mulberry32, seed logged on
failure) so a red run is replayable. The remaining CodeRabbit comments are
pre-existing MU-C2 UI concerns (optimistic-toggle rollback, picker Escape focus,
emoji content validation) and the email-as-authorId PII question (MU-C0 owns the
canonical user-id contract) — out of this gate round's scope.

Engine suite: 367 → 371 parallel (+4 gate-fix tests: cross-origin tie
convergence, clock clamp, orphan JOIN, monotonic local re-add; the fuzz was
extended in place) + 128/5-skip serial unchanged. `chat_reactions` gained
`origin_id`/`origin_seq` columns — the table is new in MU-C2 and never shipped,
so this is part of the initial shape (no migration). Files touched:
`engineDbSchema.ts`, `linkedChatStore.ts`, `linkedChatStore.test.ts`, and this
log + the design doc.

## Presence and Typing MU-C1

Shipped the ephemeral awareness transport (presence / typing / co-viewing) and
its client bindings — the one lane sequenced behind G2-C's live `session.doc`.
Presence is opt-in (only under collaboration = signedIn && relayConnected),
never journaled, dropped on disconnect/TTL, server-attributed, and fully
self-hostable on the SAME relay process.

### The ephemeral awareness transport (relay)

- `services/sync-relay/src/presence.ts` — `PresenceHub`, an IN-MEMORY,
  long-poll pub/sub. It is DELIBERATELY separate from the durable op log: it
  holds no sqlite handle, writes no row, and is lost on relay restart (0P Risk 2
  / the G2-C awareness rule). `publish`/`leave`/`snapshot`/`wait` with a
  per-scope monotonic version cursor, TTL expiry (default 30s — a vanished
  client is dropped even without an explicit leave), a per-scope entry cap, and
  empty-scope GC so a workspace that opens/closes thousands of docs never
  accumulates dead scopes.
- Transport shape is LONG-POLL, not websocket/SSE: the relay's node adapter
  buffers each request/response, so a streaming body can't flow through it; a
  GET that parks until a change or a bounded `hold` (default 25s < TTL) and
  returns a finite `{ version, peers }` fits the existing adapter with no new
  server primitive. A publisher heartbeats faster than the TTL to stay present;
  a peer re-polls with the last version.
- `server.ts` routes: `GET/POST /sync/:workspaceId/presence?topic=…`
  (owner, gated by `workspaceIsOwnedBy`) and
  `GET/POST /sync/shares/:shareId/presence?topic=…` (recipient, gated by
  `shareForRecipient` + a fail-closed topic gate). Both resolve to ONE scope
  key `ws <ownerWorkspaceId> <topic>`, so an owner and every share recipient of
  the same (workspace, topic) fan into a single scope and see each other. The
  share path re-checks revocation in-flight, mirroring `share-log`.
- `shareFilter.ts` `presenceTopicAllowedForShare` — fail-closed, reuses the
  durable `pathVisibleThroughShare` check, so presence can never fan out to a
  topic the grant doesn't already expose (a recipient of `a.md` cannot subscribe
  to presence for `b.md`). Forward-compatible: a future `chat-channel` selector
  (MU-C4) extends it to `topic === channelWireId`.
- `main.ts` constructs one process-wide hub (ephemeral, never persisted).

### Why it's never journaled + self-hostable

Nothing in the presence path touches `storage`. The server test asserts that
after presence activity the durable log has ZERO rows and the whole state lives
only in `PresenceHub.stats()`, which returns to zero on leave. It rides the
relay a self-hoster already runs — no new service, no cloud dependency; if a
proxy blocks the presence routes, chat/editing still work fully and only
presence degrades (the design's "awareness-channel-down still allows chat"
contract).

### Server-derived identity (no spoof)

Each entry's `userId` is stamped from the authenticated Better Auth actor, never
from the client body. A test publishes a `state` carrying a fake `userId` and
asserts attribution stays the authenticated actor (the same posture MU-C0
establishes for authorship). The client `state` is opaque display data only.

### The Yjs-awareness binding for doc co-presence

- `apps/desktop/src/renderer/collab/docPresence.ts` — binds a
  `y-protocols/awareness` `Awareness` to the engine MIRROR doc and bridges it
  over the SAME ephemeral transport keyed by the doc path. This is the design's
  handoff: "the provider exposes the live `session.doc`; presence binds Yjs
  AWARENESS to it as the ephemeral channel." Each publish carries the encoded
  awareness update + numeric Yjs clientID; the receiver applies remote updates
  and prunes a departed editor's state. Surfaces the calm "who's editing"
  names/count today; the Awareness lives on the doc so a future
  CollaborationCaret extension (not yet a dependency) renders remote cursors
  with no rework.

### Channel presence + typing UI (taste)

- `presenceChannel.ts` — transport-agnostic `PresenceChannel` (immediate
  publish, heartbeat, long-poll loop, graceful degrade, clean stop+leave) + the
  relay-backed transport.
- `usePresence.ts` — the React hook. DORMANT for solo (no transport => builds
  nothing, mirroring the engine co-editing hook), a monotonic-token
  no-stale-repaint guard (a slow poll for topic/workspace A never repaints B),
  and self-clearing typing.
- `PresenceIndicators.tsx` — calm faces ("N here", deduped per user, +overflow)
  + a subtle "X is typing…" line, both `aria-live="polite"`, rendering NOTHING
  when alone (no layout thrash).
- Wired into `ChatsView` (faces in the channel/thread header, typing line above
  the composer, composer keystrokes drive `setTyping`) behind an optional
  `collaboration` prop that is null for solo. The final step of exposing relay
  creds to the renderer to populate that prop is the remaining wiring (handoff).

### Opt-in / solo-dormant proof

With `collaboration === null` the Chats surface constructs no channel, publishes
nothing, and shows no presence — asserted directly (a solo render never calls
the transport). The hook returns empty and the indicators render null.

### Two-client-over-relay evidence

`services/sync-relay/src/presence.integration.test.ts` spawns a REAL relay child
(the `SYNC_RELAY_TEST_AUTH` seam) and proves, over HTTP: client A parks a
long-poll, client B publishes typing, A wakes and sees B typing, then B's leave
clears B for A — plus a non-owner gets the generic 404 for another workspace's
presence.

### Suites

- sync-relay: 67 → 95 (+14 hub unit, +12 server, +2 two-client integration).
- workspace-engine: 128/5-skip serial — unchanged.
- desktop: +15 collab-core tests (channel/doc/hook) +2 ChatsView presence =
  1100 pass / 2 skip. Repo `pnpm -r typecheck` green; sync-relay + desktop
  builds green; `git diff --check` clean.

### Handoff

The presence primitive (`PresenceHub` scope + the two authenticated routes +
`createRelayPresenceTransport` + `usePresence`/`bindDocPresence`) is reused
verbatim by DMs and shared channels: they key the SAME scope by
`channelWireId`, authorize via the SAME `shareForRecipient` gate (a
`chat-channel` selector extends `presenceTopicAllowedForShare`), and get
presence/typing for free. The only remaining live-wiring is exposing the relay
base URL + bearer to the renderer to populate `ChatsView`'s `collaboration`
prop (and a matching prop on the editor for doc co-presence).
## Shared Channels MU-C4

The bidirectional chat-channel share: a whole channel (threads + messages +
reactions) shared across accounts through a new grant kind on PR-18's share
rows, replicated over the relay, behind the signed-in collaboration surface.
This is the lane that adds the design's one genuinely new mechanism — the
first place a non-owner WRITES into an owner's bucket.

### The grant model (relay)

- `sync_relay_shares.selector_json` gains a second kind:
  `{ kind: "chat-channel", channelWireId, access }` with
  `access ∈ {"read-write" (default), "read-only"}` — the design's accepted
  recommendation (collaborative by default, read-only as the broadcast
  opt-in). `validateChatChannelShareSelector` gates grant time;
  `parseAnyShareSelectorJson` re-validates every stored row on load and fails
  closed (null → the generic 404). The PR-18 create/claim/revoke surface —
  email invites, pending claims, anti-enumeration, revocation stamping — is
  reused verbatim; the create route just accepts `channelWireId`/`access`
  beside `paths`/`versionId` (`services/sync-relay/src/shareFilter.ts`,
  `server.ts`).

### The fail-closed chat branch of `filterOpForShare`

`filterOpForShare` (which EXCLUDED all chat ops) gains a chat branch used
only by chat-channel selectors, allowlisting exactly:
`chat.channel.create` whose `wireId` IS the granted wire id;
`chat.thread.create` carrying the granted `channelWireId` (a linked-file
claim, a missing threadId, or a foreign wire id is excluded);
`chat.message.append` / `chat.reaction.set` whose thread RESOLVES to the
granted channel. Resolution is the load-bearing security decision: those ops
carry only a `threadId`, so the relay resolves the binding from its OWN log —
`storage.findThreadCreateChannelWireId` returns the channelWireId of the
EARLIEST `chat.thread.create` for that thread (relay order, LIKE-prefiltered
with escaped wildcards, JSON-verified). Earliest-wins mirrors the engine's
insert-if-absent apply, so a member pushing a FORGED thread.create that
claims the granted channel for the owner's existing private thread can never
re-bind it: the batch is rejected at append, and even a hand-inserted forgery
would be out-resolved by the true earlier op at serve time. Everything else —
other channels, DMs, file moments, secrets, version ops, `workspace.init`,
unknown kinds — falls to the terminal deny. Chat decisions carry
`blobSha256s: []`, so a chat share can never make any blob reachable
(byte-identical 404 on every blob probe). Path selectors are untouched: chat
ops stay excluded from file shares, file ops from chat shares — the two kinds
cannot widen each other.

### The member append route — `POST /sync/shares/:shareId/log`

The bidirectional extension of PR-18's read-only recipient model. Gauntlet in
order: (1) `shareForRecipient` — membership/revocation/granter-standing, every
denial the same byte-identical generic 404; (2) chat-channel selector with
`access === "read-write"` — a read-only member (or any path share) gets an
explicit 403 `share_read_only` (a refusal, not a 404: the member legitimately
knows the share exists); (3) MU-C0's `assertChatAuthorship` — every authored
op must claim the AUTHENTICATED pusher (missing `authorUserId` is stamped),
so no member can forge a message or reaction as another member; (4) every op
through the SAME chat filter that scopes reads, batch-aware (a thread created
earlier in the batch is a valid in-batch target, but the log's earliest
binding always outranks the batch) — one rejected op 403s the WHOLE batch
atomically (`share_op_rejected`, deliberately unspecific). Accepted ops land
in the OWNER's bucket under a share-namespaced origin
(`share:<shareId>:<clientOriginId>`), so a member can never extend or collide
with the owner's — or another member's — origin sequence space (tested: a
member deliberately claiming the owner's origin id lands in its own
namespace and the owner's next contiguous append still succeeds). A revoke
racing the append is re-checked immediately before `appendLogBatch`.

### How the channel converges (one log, many writers)

All members read the SAME owner-bucket log through their own share
(server-filtered); the owner reads it as their normal own-bucket pull, which
now applies member ops like any remote origin's. The member side is
`packages/workspace-engine/src/syncSharedChannel.ts`:

- `pullSharedChannel` replays the filtered log into the member's OWN chat
  store. A filtered log has per-source-origin seq gaps by construction and
  `applyReplicationOp` fails closed on gaps, so each source origin is
  renumbered DENSELY (in relay order — identical for every member) under
  `shared:<shareId>:<originId>`; `shared_channel_peers` records (last source
  seq consumed, last dense seq assigned) so a crash-refetch is an exact skip,
  never a double-apply. The member's own pushed ops echo back under their
  namespaced origin and are skipped outright. A client-side scope gate
  (mirroring `syncShareView`'s `pathReplayable` third-gate posture) drops
  anything a hostile relay serves outside the granted channel. Engine wire-id
  / thread-id / message-id convergence then makes every member's channel copy
  identical.
- `pushSharedChannel` scans the LOCAL origin's journal for chat ops that
  belong to the channel (channel.create for the wire id, threads bound to it,
  messages/reactions in those threads — resolved against the local store),
  renumbers them densely into the share's own contiguous sequence
  (`shared_channel_push_state`, committed per accepted batch so retries
  resend identical seqs the relay dedups), and appends through the member
  route under this machine's own origin id. 403 `share_read_only` surfaces as
  `SharedChannelReadOnlyError` (nothing marked pushed — a later access flip
  re-sends); every 404 as `ShareUnavailableError`.
- State tables are `SHARED_CHANNEL_SYNC_DDL` in `engineDbSchema.ts` (lazy
  additive, same posture as the other sync tables).

### Revocation (honest end-of-share)

Server: revoke stamps `revoked_at_ms`; the member's next fetch AND next
append are the byte-identical generic 404; the in-flight re-checks abort a
racing read or append. Client: `ShareUnavailableError` marks the registry row
`ended: true` — the locally replayed copy stays readable (they legitimately
saw it), nothing new arrives, nothing leaves, and the UI says so plainly.
Member-initiated LEAVE is purely local (registry removal; only the granter
revokes the grant itself).

### Desktop UI (Chats)

Channels you own get a Share affordance keyed on the channel's wire id
(header button → member list with per-person access + Remove, an email +
"View only" form, one honest sentence about what sharing means). Invitations
appear under "Shared with you" with one-click Join (info → pull → registry
record with an origin-relay pin, mirroring the shared-view rule). Joined
channels show calm provenance ("Shared by owner@… — read-only"), disable
composers when read-only or ended, and offer Leave. `general` is REFUSED at
share time: its well-known wire id is the same in every workspace by design,
so sharing it would merge strangers' personal chats. Refresh rides
`listChatChannels` (fresh on open), fire-and-forget pushes after
send/thread/reaction, and the workspace's relay sync cadence through a
contained best-effort seam (`relaySyncEngine.syncSharedChannels`) that can
never fail the file-sync pass. Solo/signed-out renders byte-identically to
before — every sharing affordance hides when share listing is unavailable.

**Presence seam (MU-C1):** PR #97 was not merged into this lane's base
(d856b688), so presence is a documented seam, not wired: once the awareness
channel lands, member presence attaches in ChatsView keyed by
`(shareId | channelWireId)` with fan-out gated by the same grant check.

### Adversarial evidence (the blocking gate)

- Sentinel no-leak: the owner's bucket seeded with a private channel
  (`SENTINEL-private-*`), a file moment, and a secret op — a member's share
  page never contains any sentinel, the private wire id, or `.env`
  (`sharedChannels.test.ts`, plus filter-level sentinel matrix in
  `shareFilter.test.ts`, plus store-level over the live relay).
- Non-member isolation: read AND append probes on a real share are
  byte-identical to a share that never existed; the granter probing the
  recipient route is denied identically; unauthenticated stays 401.
- No-forge: a member's message/reaction claiming another user 403s
  (`authorship_mismatch`) atomically; a missing author is stamped to the
  authenticated pusher.
- Atomic batch rejection: six escape attempts (private-thread message,
  private thread.create, foreign channel.create, file moment, unknown-thread
  message, forged re-bind of an existing private thread) each 403 the whole
  batch — the valid leading op never lands.
- Read-only: reads flow, appends 403 `share_read_only`, nothing reaches the
  owner's log; path shares refuse appends with the same code.
- Revocation: next fetch/append 404 byte-identically; mid-append revoke race
  aborts with nothing landed; the member's received list empties.
- Live relay (child process, `main.integration.test.ts`): owner + two
  read-write members CONVERGE on one channel (identical message sets
  including verified author ids) through push/pull over real HTTP; a
  read-only member reads everything and is refused append; a non-member is
  denied byte-identically; the owner's other channel never reaches any
  member's store; revocation closes member B's view while their local copy
  (plus their orphaned post-revocation message) stays readable and never
  reaches the owner.
- Hostile-relay client gate: a relay double serving foreign-channel ops,
  file ops, and unknown kinds — the member's pull drops every one
  (`syncSharedChannel.test.ts`).
- Solo unaffected: no grant → no route reachable; the desktop suite's solo
  Chats tests pass unchanged, and sharing UI is provably absent when the
  surface is unavailable.

### Suite counts (Linux)

- sync-relay: 100 (was 78) — +13 `sharedChannels.test.ts`, +8 chat filter
  tests in `shareFilter.test.ts`, +1 live-relay convergence e2e in
  `main.integration.test.ts`.
- workspace-engine: 382 parallel (+6 `syncSharedChannel.test.ts`) +
  128/5-skip serial unchanged.
- desktop: 1095 passed / 2 skipped (+12: 5 `sharedChannels.test.ts`, 5
  ChatsView shared-channel tests, 1 registry, 1 relaySyncEngine).
- `pnpm -r typecheck`, `pnpm build`, docs link checker: green.

### Files changed

- `services/sync-relay/src/shareFilter.ts` — chat-channel selector,
  validation, union parser, `ChatShareThreadResolver`, the chat filter branch.
- `services/sync-relay/src/storage.ts` — `findThreadCreateChannelWireId`
  (earliest-binding lookup).
- `services/sync-relay/src/server.ts` — chat grants on shares-create, the
  member append route, resolver-wired share-log/share-blob, `share_read_only`
  / `share_op_rejected`.
- `packages/workspace-engine/src/syncSharedChannel.ts` (+ engineDbSchema DDL,
  linkedChatStore `getChannelWireId`, contracts, index exports).
- `apps/desktop`: `workspaces/sharedChannels.ts` (best-effort syncer),
  `workspaces/registryStore.ts`/`WorkspaceRegistry.ts` (joined set),
  `workspaces/relaySyncEngine.ts` (contained cadence seam), `main.ts`
  (share/list/join/leave IPC, wire-id plumbing, prompt pushes, general
  refusal, path-share listing untouched by chat grants), `ipc/bridgeContract`
  / `channels` / `preload`, `renderer/workbench/ChatsView.tsx`.
- Tests: `sharedChannels.test.ts` (relay), `shareFilter.test.ts`,
  `main.integration.test.ts`, `syncSharedChannel.test.ts` (engine),
  `sharedChannels.test.ts` (desktop), `ChatsView.test.tsx`,
  `registryStore.test.ts`, `relaySyncEngine.test.ts`.

### Handoff to MU-C5 (final isolation sweep)

Everything the sweep needs is in place and named: the isolation matrix lives
in `sharedChannels.test.ts` + `shares.test.ts` (byte-identical denials), the
forgery gate in `server.test.ts` + the live-relay authorship test, the leak
sentinels in `shareFilter.test.ts`/`sharedChannels.test.ts`, and the
self-host posture is unchanged (the chat-channel grant is rows in the
existing `sync_relay_shares` table + one route on the existing relay — no new
service, nothing cloud-locked). Named follow-ups for the sweep to press on:
(1) MU-C3 DMs will rebase onto this relay surface (the DM recipient-set model
should reuse `shareNotAppendable`/`share_op_rejected` and the earliest-binding
resolver); (2) shared read cursors stay local-only by design; (3) log growth
in the owner bucket from member appends rides the existing GC-before-GA
framing; (4) presence wiring once MU-C1 merges.
