# RPC-C C1 implementation summary

## Implemented surface

- Added daemon-side `ydoc.open`, `ydoc.recordUpdate`, `ydoc.settle`,
  `ydoc.applyExternalMarkdownEdit`, `ydoc.close`, and `ydoc.resync` dispatch
  paths with strict camelCase/`deny_unknown_fields` serde parameter shapes.
- Added per-`EngineService` sessions with daemon-minted
  `ydoc-{monotone:016x}` identifiers, workspace-handle scoping, exclusive
  `LeaseRegistry` guards, lineage/regime state, first-seed state, event
  baseline, and last-settled SHA. Leases drop on `ydoc.close`,
  `workspace.close`, stale-handle eviction, and service teardown.
- `ydoc.open` resolves the current text head server-side, refuses binary
  heads, derives absent object IDs with `derive_capture_object_id`, preserves
  an existing marker's content kind/regime, defaults new lineages to
  local-only, returns an empty/full Y.Doc state, and exposes explicit
  `lineage` plus `seedMarkdown` for absent lineages over existing text.
- `ydoc.recordUpdate` decodes base64, routes bytes through the existing
  abort-safe replay validator and content-addressed durable append, returns the
  durable lineage sequence plus `deduped`, and refuses a raced first seed with
  `seed-onto-existing-lineage`.
- Plaintext settlement reconstructs and projects the durable Y.Doc, mints a
  non-journaled domain moment/snapshot, uses the current text SHA (or absent)
  as materialization preimage, uses `moment_order` as target generation,
  synchronously materializes only its own job, updates durable/session settle
  state, and returns projection provenance. Richdoc settlement refuses with
  `richdoc-settle-unsupported`.
- `ydoc.applyExternalMarkdownEdit` validates session/workspace scope and
  refuses with `external-edit-unsupported-live` in C1.
- `ydoc.close` optionally uses the same settle path, performs regime-aware
  collab close/prune, drains deferred replicated Y.Doc envelopes for replicated
  lineages, and releases the lease. `ydoc.resync` returns full state and resets
  the session event baseline.
- Added a daemon-owned single-shot self-write suppression registry. Settlement
  records `(workspace, path, sha)` before replying; capture consumes an exact
  matching `Changed` observation without minting a capture moment or flipping
  ownership.
- Added the `LeaseProbe` sync seam, a no-live-leases implementation, direct
  `LeaseRegistry` support, `ydoc-session-live` ack/defer results, and a close
  drain that uses the imported replication log as the durable pending queue.
- Replaced the hardcoded handshake generation with a process-lifetime
  `AtomicU64` allocation starting at 1.
- Added the client stale-to-`ydoc.resync` recovery path and event-baseline
  reset. The client now consumes daemon `lineage`/`seedMarkdown` fields without
  changing `ydocWireContract.ts`, builds the first seed with the projection
  package, and records it before returning the opened session.

## Files and tests

- Core daemon/session composition:
  `crates/dohc-workspace-engine/src/lib.rs`
- Actor-owned durable operations and synchronous materialization:
  `crates/dohc-engine-runtime/src/actor.rs`
- Non-journaling projected-write seam:
  `crates/dohc-engine-domain/src/store.rs`
- Capture suppression plumbing:
  `crates/dohc-workspace-engine/src/capture_sink.rs` and
  `capture_driver.rs`
- Sync lease/defer/drain seam:
  `crates/dohc-engine-sync/src/ydoc_apply.rs`
- Per-authentication generation:
  `crates/dohc-workspace-engine/src/bin/dohc-workspace-engine.rs`
- Client seed/resync path:
  `packages/workspace-engine-client/src/ydoc/ydocLiveAdapter.ts` and
  `ydocLoopbackEngine.ts`
- New RPC acceptance coverage:
  `crates/dohc-workspace-engine/tests/rpc_ydoc.rs`
- Sync mutation test:
  `crates/dohc-engine-sync/src/tests.rs`
- Client recovery test:
  `packages/workspace-engine-client/src/ydoc/ydocLiveAdapter.test.ts`

The RPC acceptance test covers settlement over an existing file with no
spurious conflict, moment retrieval, one-and-only-one new moment after capture
flush (with a mutation comment identifying how to restore the suppression
bug), open/record/settle/close/reopen/resync round-trip, double-open busy,
binary-head refusal, richdoc-settle refusal, raced-seed refusal, live external
edit refusal, workspace-close lease release, and cross-workspace isolation.
The sync test proves a live-key envelope advances the peer ack without
mutating `ydoc_updates`.

## Verification

- Did **not** run `cargo build` or `cargo test`, as required.
- Direct `rustfmt --edition 2024` parsing/formatting completed successfully for
  every changed Rust source.
- `git diff --check` passes.
- Changed Cargo TOML and package JSON parse successfully.
- The workspace-engine-client typecheck/test commands were attempted but could
  not start because this worktree has no installed `node_modules` (`tsc` and
  `vitest` were unavailable). No dependency installation was performed.

## Deviations

None known. `packages/workspace-engine-client/src/ydoc/ydocWireContract.ts` was
left unchanged as required; the C1 lineage/seed additions are consumed from
the raw result alongside the existing decoder.
