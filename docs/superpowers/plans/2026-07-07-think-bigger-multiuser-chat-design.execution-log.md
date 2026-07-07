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
keeps the op maximizing a TOTAL order `(atMs, then 'removed' > 'added' on a
tie — remove-wins)`. Apply is one conflict-target upsert whose `WHERE` admits
the incoming op only if it is strictly newer by that order:

```
ON CONFLICT(workspace_id, message_id, emoji, author_id) DO UPDATE SET …
  WHERE excluded.at_ms > chat_reactions.at_ms
     OR (excluded.at_ms = chat_reactions.at_ms AND excluded.state > chat_reactions.state)
```

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
author_display_name`, indexed by `(workspace_id, thread_id, message_id)`. Added
to both schema paths in `engineDbSchema.ts`. No FK to `chat_messages` — a
cross-origin reaction can arrive before the message it targets, and the CRDT
converges regardless of that order. Store methods `setReaction` / `listReactions`
(`linkedChatStore.ts`) share the `upsertReactionLww` statement verbatim with the
`chat.reaction.set` branch of `applyReplicationOp`, so a local set and an
imported op can never drift. `syncApply.ts` dispatches the new kind to the chat
store. The reaction apply branch carries NO head-check (like `ydoc.update`).

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
