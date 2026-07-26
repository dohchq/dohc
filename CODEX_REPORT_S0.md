# R13b-rest S0 — live desktop adapters

Date: 2026-07-26
Branch: `codex/rust-engine-r13b-live-adapters`

## What was built

- Added the shared minimal-daemon request layer used by the new adapters. It
  owns monotonically increasing request IDs, workspace handles, idempotency
  keys, deadline forwarding, response-ID validation, transport closing, and
  typed daemon refusal mapping.
- Added `ChatsLiveAdapter`, covering every one of the 60 dispatched `chats.*`
  methods. Its named methods mirror the `LinkedChatStore` and
  `AgentDispatchStore` surfaces, including pagination and legacy
  `chats.threads.list` conversion.
- Expanded `chatsWireContract.ts` from 42 to all 60 dispatched chat methods,
  with exact Rust-daemon result shapes and fail-closed result decoding.
- Expanded `ChatsLoopbackEngine` to accept all 60 methods so it remains useful
  as an in-memory differential oracle.
- Added `VersionedLiveAdapter`, covering all 30 versioned methods plus
  `workspace.open`, `workspace.close`, conflicts, search, watcher status, and
  capture flush.
- Completed and tightened the versioned result decoders. Nested objects and
  arrays now reject unknown fields and malformed discriminants instead of
  accepting partially valid payloads.
- Added a strict workspace-family wire contract for the eight non-versioned
  dispatch methods.
- Exported all new contracts and adapters from the package root.
- Appended a dated correction to `RPC_GAP.md`; its historical snapshots were
  preserved.

## Wire coverage

Every row below has typed request params, an exact method constant, a strict
result decoder, live-adapter dispatch, and request-encoding coverage.

| Family | Method | Decoder | Live request |
|---|---|---:|---:|
| chats | `chats.channels.create` | yes | yes |
| chats | `chats.channels.ensureAgent` | yes | yes |
| chats | `chats.channels.ensureGeneral` | yes | yes |
| chats | `chats.channels.findBySlug` | yes | yes |
| chats | `chats.channels.list` | yes | yes |
| chats | `chats.channels.getWireId` | yes | yes |
| chats | `chats.threads.start` | yes | yes |
| chats | `chats.threads.create` | yes | yes |
| chats | `chats.threads.list` | yes | yes |
| chats | `chats.threads.listForFile` | yes | yes |
| chats | `chats.threads.listForChannel` | yes | yes |
| chats | `chats.threads.findChannelId` | yes | yes |
| chats | `chats.threads.getProjection` | yes | yes |
| chats | `chats.messages.send` | yes | yes |
| chats | `chats.messages.list` | yes | yes |
| chats | `chats.readState.get` | yes | yes |
| chats | `chats.readState.markThreadRead` | yes | yes |
| chats | `chats.decisions.resolve` | yes | yes |
| chats | `chats.decisions.listForThread` | yes | yes |
| chats | `chats.reactions.set` | yes | yes |
| chats | `chats.reactions.list` | yes | yes |
| chats | `chats.attachments.listForThread` | yes | yes |
| chats | `chats.attachments.listFileMentions` | yes | yes |
| chats | `chats.mentions.listForHandle` | yes | yes |
| chats | `chats.agentReadState.listUnreadThreads` | yes | yes |
| chats | `chats.agentReadState.markThreadRead` | yes | yes |
| chats | `chats.follows.set` | yes | yes |
| chats | `chats.follows.list` | yes | yes |
| chats | `chats.follows.ensureDefaults` | yes | yes |
| chats | `chats.feed.markSeen` | yes | yes |
| chats | `chats.feed.listPersonal` | yes | yes |
| chats | `chats.bookmarks.save` | yes | yes |
| chats | `chats.bookmarks.list` | yes | yes |
| chats | `chats.bookmarks.find` | yes | yes |
| chats | `chats.bookmarks.listPending` | yes | yes |
| chats | `chats.bookmarks.markReady` | yes | yes |
| chats | `chats.bookmarks.archive` | yes | yes |
| chats | `chats.bookmarks.markPending` | yes | yes |
| chats | `chats.bookmarks.markFailed` | yes | yes |
| chats | `chats.bookmarks.markStale` | yes | yes |
| chats | `chats.dispatch.enqueue` | yes | yes |
| chats | `chats.dispatch.recordEligibleTriggers` | yes | yes |
| chats | `chats.dispatch.claimNextPending` | yes | yes |
| chats | `chats.dispatch.listPending` | yes | yes |
| chats | `chats.dispatch.openRuns` | yes | yes |
| chats | `chats.dispatch.listRunMessages` | yes | yes |
| chats | `chats.dispatch.runIdForMessage` | yes | yes |
| chats | `chats.dispatch.runRecordsForThread` | yes | yes |
| chats | `chats.dispatch.getRunRecord` | yes | yes |
| chats | `chats.dispatch.isThreadPaused` | yes | yes |
| chats | `chats.dispatch.getThreadPauseState` | yes | yes |
| chats | `chats.dispatch.recentCount` | yes | yes |
| chats | `chats.dispatch.failPendingForThread` | yes | yes |
| chats | `chats.dispatch.recordRunMessage` | yes | yes |
| chats | `chats.dispatch.setThreadPaused` | yes | yes |
| chats | `chats.dispatch.markFailureNotePosted` | yes | yes |
| chats | `chats.dispatch.requeueFailedTrigger` | yes | yes |
| chats | `chats.dispatch.listAppQuitRecoveries` | yes | yes |
| chats | `chats.dispatch.complete` | yes | yes |
| chats | `chats.dispatch.fail` | yes | yes |
| versioned | `versionedText.write` | yes | yes |
| versioned | `versionedText.read` | yes | yes |
| versioned | `versionedText.rename` | yes | yes |
| versioned | `versionedText.delete` | yes | yes |
| versioned | `versionedText.rollback` | yes | yes |
| versioned | `versionedText.list` | yes | yes |
| versioned | `versionedBinary.write` | yes | yes |
| versioned | `versionedBinary.read` | yes | yes |
| versioned | `versionedBinary.readBlob` | yes | yes |
| versioned | `versions.createNamed` | yes | yes |
| versioned | `versions.list` | yes | yes |
| versioned | `versions.setActive` | yes | yes |
| versioned | `versions.ensureMain` | yes | yes |
| versioned | `versions.active` | yes | yes |
| versioned | `versionedText.merge` | yes | yes |
| versioned | `versionedText.compare` | yes | yes |
| versioned | `versions.compareFiles` | yes | yes |
| versioned | `secrets.write` | yes | yes |
| versioned | `secrets.list` | yes | yes |
| versioned | `secrets.materialize` | yes | yes |
| versioned | `secrets.delete` | yes | yes |
| versioned | `secrets.fork` | yes | yes |
| versioned | `secrets.compare` | yes | yes |
| versioned | `secrets.apply` | yes | yes |
| versioned | `secrets.restore` | yes | yes |
| versioned | `secrets.moments.list` | yes | yes |
| versioned | `secrets.moments.get` | yes | yes |
| versioned | `moments.list` | yes | yes |
| versioned | `moments.get` | yes | yes |
| versioned | `search.ensureIndex` | yes | yes |
| workspace | `workspace.open` | yes | yes |
| workspace | `workspace.close` | yes | yes |
| workspace | `conflicts.list` | yes | yes |
| workspace | `conflicts.open` | yes | yes |
| workspace | `conflicts.resolve` | yes | yes |
| workspace | `search.query` | yes | yes |
| workspace | `watcher.status` | yes | yes |
| workspace | `capture.flush` | yes | yes |

The 18 newly added chat decoders are:
`chats.bookmarks.list`, `chats.bookmarks.markReady`,
`chats.bookmarks.save`, `chats.channels.create`,
`chats.channels.ensureAgent`, `chats.channels.ensureGeneral`,
`chats.channels.findBySlug`, `chats.channels.list`,
`chats.dispatch.complete`, `chats.dispatch.enqueue`,
`chats.dispatch.fail`, `chats.feed.markSeen`, `chats.follows.list`,
`chats.follows.set`, `chats.messages.list`, `chats.readState.get`,
`chats.readState.markThreadRead`, and `chats.threads.list`.

## Tests

Final command:

`pnpm --filter @dohc/workspace-engine-client test`

Result: **5 test files passed, 136 tests passed**.

| Test file | Count | Relevant coverage |
|---|---:|---|
| `src/chats/chatsLiveAdapter.test.ts` | 21 | all 60 request encodings; all 18 new decoder shapes and malformed/unknown rejection; retryable and terminal refusals; loopback differential smoke |
| `src/versioned/versionedLiveAdapter.test.ts` | 13 | all 30 versioned request encodings; open plus seven bound workspace requests; all eight workspace decoder shapes and malformed/unknown rejection; new versioned decoder cases; refusal mapping; loopback differential smoke |
| `src/chats/chatsWireContract.test.ts` | 21 | all 60 loopback arms plus existing chat invariants and decoder rejection |
| `src/versioned/versionedWireContract.test.ts` | 58 | versioned loopback behavior and strict decoder rejection |
| `src/ydoc/ydocLiveAdapter.test.ts` | 23 | unchanged reference-adapter regression coverage |

Type validation:

- `pnpm --filter @dohc/workspace-engine-client typecheck` — passed.
- `pnpm -r typecheck` — reached packages outside this shard, then stopped on
  the pre-existing `apps/site/src/ProductDemo.tsx:562` error: the supplied
  `chats` prop is absent from the target component's declared props. S0 did not
  modify `apps/site`.
- The package has no lint script.

### Mutation-proof evidence

Each mutation was temporary, the named test was observed failing, and the
strict implementation was restored before the final green run.

| Mutated decoder | Deliberate break | Observed failure |
|---|---|---|
| `chats.channels.list` | bypassed object/field validation with a constant result | `ChatsLiveAdapter > strictly decodes the daemon payload for 'chats.channels.list'` failed because the malformed payload no longer threw |
| `watcher.status` | replaced strict boolean/unknown-field validation with constants | `VersionedLiveAdapter > strictly decodes 'watcher.status' and rejects malformed or unknown fields` failed because the malformed payload no longer threw |
| `versionedText.compare` | forced every result to `{ status: "unchanged" }` | `VersionedLiveAdapter > strictly decodes the newly dispatched versioned list, compare, and empty acknowledgements` failed: expected `merged`, received `unchanged` |

## Interface compatibility

### ChatsLiveAdapter

Named async methods cover every currently daemon-backed `LinkedChatStore`
member: thread/channel creation and reads, messages, human and agent read
state, decisions, attachments, mentions, reactions, follows, feed, bookmarks,
projection, and close. Pagination is hidden behind the store-shaped list
methods. The adapter also covers every `AgentDispatchStore` operation by name.

The transport is necessarily asynchronous. `LinkedChatStore` is already async,
but the current `AgentDispatchStore` contract is synchronous; the desktop
call-site shard must await its dispatch calls when replacing the SQLite-local
store. `LinkedChatStore.applyReplicationOp` has no chat RPC in this 60-method
surface and is not implemented here.

The legacy `chats.threads.list` daemon shape carries only
`linkedObjectId`; it has no linked path or linked timestamp. The adapter
therefore cannot reconstruct those two optional oracle fields. It uses the
thread creation timestamp as `linkedAtMs`. Cursorless list RPCs fail closed if
the daemon reports truncation rather than silently returning partial data.

### VersionedLiveAdapter

Named async methods cover the daemon-backed `VersionedTextStore` and
`SecretFileStore` operations: versions, text/binary writes and reads,
rename/delete/rollback, compare/merge, conflicts, moments, all secret
operations, search-index creation, and close. It additionally exposes the
workspace-level search, watcher, and capture methods.

The following oracle-only seams are not structurally implementable from the
current daemon contracts:

- `VersionedTextStore.runInEngineWriteLane` exposes an in-process SQLite
  transaction callback.
- `writeProjectedTextFile`, `getObject`, and both stores'
  `applyReplicationOp` have no matching method in these wire contracts.
- `querySearchIndex` expects internal full-text candidates, while
  `search.query` returns final rendered search hits. The adapter exposes the
  latter as `querySearch`.
- `versionedText.compare` and `versionedText.merge` return daemon summary
  shapes, not every rich oracle comparison/merge field.
- `versionedText.delete` does not accept the oracle's optional caller-supplied
  `momentId`; the adapter accepts the store-shaped input but cannot put that
  field on the wire.
- Over-cap text, secret, and blob bodies require blob-egress support that is
  outside the minimal `sendRequest`/`close` client. The adapter throws
  `VersionedAdapterCapabilityError` instead of returning a partial or empty
  body.

These gaps are explicit so the later call-site shards do not mistake a
wire-complete adapter for a drop-in implementation of in-process-only
facilities.

## Not closed in S0

- No desktop call sites were changed; this shard was explicitly limited to
  `packages/workspace-engine-client`.
- No relay sync, share push/pull, key-envelope custody, or CLI
  unread-file-threads aggregate was added. These remain the missing families
  recorded in the dated RPC gap update.
- Blob egress is not present on the minimal desktop daemon interface.
- The in-process-only store seams and the dispatch-store async call-site
  conversion listed above remain for their owning shards.

The TypeScript oracle remained read-only:

`git diff origin/main --stat -- packages/workspace-engine` produced no output.
