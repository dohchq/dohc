# Think Bigger Multi-User Chat Execution Log

Read-only summary: append-only record of the lanes landed against the
multi-user chat design. Created: 2026-07-07.

Plan:

- [Think Bigger Multi-User Chat](./2026-07-07-think-bigger-multiuser-chat-design.md)

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
