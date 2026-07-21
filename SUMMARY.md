# RPC-B summary

## Methods added

- Channels: `chats.channels.create`, `ensureGeneral`, `ensureAgent`, `list`, `findBySlug`
- Threads: `chats.threads.start`, `list`
- Messages: `chats.messages.send`, `list`
- Read state: `chats.readState.markThreadRead`, `get`
- Follows: `chats.follows.set`, `list`
- Personal feed: `chats.feed.markSeen`, `listPersonal`
- Bookmarks: `chats.bookmarks.save`, `list`, `markReady`
- Dispatch: `chats.dispatch.enqueue`, `claimNextPending`, `complete`, `fail`, `reclaimRunning`

Every method has a deny-unknown-fields camelCase parameter DTO, a dispatch arm, an `ActorHandle` passthrough, and a dedicated actor command/reply variant. All actor waits use `read_under_ctx`, including writes. Workspace ids come only from the open daemon handle. Message pages clamp to 500 and expose `nextAfterMessageOrder`; personal-feed pages clamp to the domain's 100-row maximum and expose `nextCursor`.

Dispatch completion/failure now resolve the run under the handle-derived workspace id in `LinkedChatStore`, preventing a run id from another workspace from being completed or failed.

## Files touched

- `crates/dohc-workspace-engine/src/lib.rs` — RPC dispatch, DTO parsing, domain input construction, cancellation-aware actor waits, and camelCase response projections.
- `crates/dohc-engine-runtime/src/actor.rs` — 23 chat command variants, `ActorHandle` methods, and single-actor-turn `LinkedChatStore` execution.
- `crates/dohc-engine-domain/src/chats.rs` — workspace-scoped dispatch complete/fail lookup.
- `crates/dohc-engine-domain/tests/chats.rs` — existing dispatch test updated for the scoped API.
- `crates/dohc-workspace-engine/tests/rpc_chats.rs` — new end-to-end RPC-B acceptance coverage.
- `SUMMARY.md` — this handoff.
- `RPC_B_BRIEF.md` — removed as requested by the brief.

## Test coverage written

`rpc_chats.rs` uses `InProcessTransport`, real shadow markers, and only real RPC/domain writes. It covers channel creation/provisioning/list/slug lookup; channel-thread creation; message sends and the observable 500-row keyset clamp; thread listing; read-state get/mark; follows; personal-feed visibility, 100-row clamp, cursor, and mark-seen; bookmark save/list/generation-ready CAS; dispatch claim/complete/fail/reclaim/exhaustion; clean `InvalidParams` errors for unknown channel/thread coordinates; cross-workspace empty-state probes; and cross-workspace dispatch completion refusal.

## Not run or included

Per the task constraint, no `cargo build`, `cargo check`, or `cargo test` command was run. The changed Rust files were parsed/formatted with `rustfmt`, and `git diff --check` passes. Compilation and execution remain for the orchestrator gate.

Replication apply arms and reactions/decisions/attachment/mention indexing were intentionally left out: `crates/dohc-engine-domain/src/chats.rs:32-35` explicitly defers those surfaces to R10 or later. No additional chat query or presentation surface was invented beyond the R09 methods at `chats.rs:744-2019`.
