# RPC-B summary

## Methods added

- Channels: `chats.channels.create`, `ensureGeneral`, `ensureAgent`, `list`, `findBySlug`
- Threads: `chats.threads.start`, `list`
- Messages: `chats.messages.send`, `list`
- Read state: `chats.readState.markThreadRead`, `get`
- Follows: `chats.follows.set`, `list`
- Personal feed: `chats.feed.markSeen`, `listPersonal`
- Bookmarks: `chats.bookmarks.save`, `list`, `markReady`
- Dispatch: `chats.dispatch.enqueue`, `claimNextPending`, `complete`, `fail`

Every method has a deny-unknown-fields camelCase parameter DTO, a dispatch arm, an `ActorHandle` passthrough, and a dedicated actor command/reply variant. All actor waits use `read_under_ctx`, including writes. Workspace ids come only from the open daemon handle. Message pages clamp to 500 and expose `nextAfterMessageOrder`; personal-feed pages clamp to the domain's 100-row maximum and expose `nextCursor`, `headCursor`, and `readState`.

Dispatch completion/failure now resolve the run under the handle-derived workspace id in `LinkedChatStore`, preventing a run id from another workspace from being completed or failed.

## Files touched

- `crates/dohc-workspace-engine/src/lib.rs` — RPC dispatch, DTO parsing, domain input construction, cancellation-aware actor waits, and camelCase response projections.
- `crates/dohc-engine-runtime/src/actor.rs` — 23 chat command variants, `ActorHandle` methods, and single-actor-turn `LinkedChatStore` execution.
- `crates/dohc-engine-domain/src/chats.rs` — follow validation, feed metadata, guarded bookmark readiness, run-id validation, channel aggregates, and workspace-scoped dispatch transitions.
- `crates/dohc-engine-domain/tests/chats.rs` — channel-summary expectations plus dispatch run-id coverage.
- `crates/dohc-workspace-engine/tests/rpc_chats.rs` — new end-to-end RPC-B acceptance coverage.
- `SUMMARY.md` — this handoff.
- `RPC_B_BRIEF.md` — removed as requested by the brief.

## Test coverage written

`rpc_chats.rs` uses `InProcessTransport`, real shadow markers, and only real RPC/domain writes. It covers channel creation/provisioning/list/slug lookup and derived counts; channel-thread creation; message sends and the observable 500-row keyset clamp; thread listing; read-state get/mark; validated follows; personal-feed visibility, 100-row clamp, cursors, page read state, and mark-seen; bookmark save/list and guarded generation-ready ownership; bounded dispatch run ids plus claim/complete/fail and close/reopen reclaim/exhaustion; clean `InvalidParams` errors for invalid coordinates; cross-workspace empty-state probes; and cross-workspace dispatch completion refusal.

## Not run or included

Per the task constraint, no `cargo build`, `cargo check`, or `cargo test` command was run. The changed Rust files were parsed/formatted with `rustfmt`, and `git diff --check` passes. Compilation and execution remain for the orchestrator gate.

Replication apply arms and reactions/decisions/attachment/mention indexing were intentionally left out: `crates/dohc-engine-domain/src/chats.rs:32-35` explicitly defers those surfaces to R10 or later. No additional chat query or presentation surface was invented beyond the R09 methods at `chats.rs:744-2019`.

## Review round 1

- Removed the unsafe anytime `chats.dispatch.reclaimRunning` RPC. Each actual workspace open now performs one dispatch reclaim after the capture driver starts; the actor/domain reclaim APIs remain internal.
- Added actor-entry cancellation checks to every specified chat write and passed each RPC operation token through to its actor command.
- Made follows refuse missing/DM channels, missing or DM-linked threads, and person/agent targets without a matching authored message in a non-DM thread.
- Extended personal-feed pages with the feed-wide read state and newest-message head cursor, emitted as camelCase values or `null`.
- Ported bookmark projection ownership claiming: projection identity/path are both-or-neither, path and generation/state are fenced in the claim update, and successful readiness records projection identity, projected generation, and projection time.
- Enforced the verbatim dispatch run-id storage bounds (non-empty, at most 512 UTF-8 bytes, no NUL) for claim, complete, and fail.
- Added per-channel `threadCount` and `unreadCount` aggregates and acceptance coverage showing the counts change with messages and read-cursor advances.

The RPC acceptance flow now covers unfollowable targets, feed page cursors/read state, guarded bookmark projection ownership, invalid run ids, channel aggregates, the removed reclaim method, and close/reopen reclaim through exhaustion. The domain dispatch case also covers the run-id bounds.

## Review round 2

- Chat message sends now update their FTS row inside the same domain transaction as the message insert. Channel-thread starts atomically index both the derived thread header and first message. Runtime repair/rebuild calls the same domain-owned delete-then-insert SQL and shared title/message text derivations.
- Dispatch enqueue now returns `true` only for a fresh ledger row. A duplicate for the same thread returns `false`; a missing or different-thread conflict fails as chat `state-corrupt`, which the RPC maps to `Internal`.
- `chats.channels.create`, `ensureGeneral`, and `ensureAgent` now carry the request cancellation token and refuse mutation when it is already cancelled at actor entry.
- Dispatch run ids are trimmed before validation, storage, and lookup. The existing empty, 512-byte, and NUL checks apply to the trimmed value, so padded claims can be completed with the normalized id.
- Channel listing now fails closed on negative or non-integer persisted read-state sequence/revision values before calculating unread aggregates, while retaining the aggregate's zero clamp for valid over-count cursors.

Round-2 regression coverage proves stable-policy write-time chat search (with a mutation-guard comment), duplicate/conflicting enqueue behavior, normalized run-id completion, and corrupt negative read-state rejection. Per the task constraint, no Cargo build, check, or test command was run; all changed Rust files passed direct `rustfmt --edition 2024 --check`, and `git diff --check` passed.
