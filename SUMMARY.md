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

## Adversarial review round (opus, pre-PR)

- **P0 fixed**: `ydoc.settle` on an un-seeded/absent lineage previously
  projected a fresh empty doc and clobbered the existing file; it now
  refuses with the collab `NoMarker` error, mirroring collab `settle()`.
  Mutation-verified: restoring `None => Ydoc::wire()` makes the new
  refusal test fail with a successful empty-markdown settle.
- **P1 fixed (drain completeness)**: acked-but-parked replicated envelopes
  were only drained on `ydoc.close` of a replicated session — workspace
  close, stale-handle eviction, and crashes orphaned them. `ydoc.open` now
  drains parked envelopes for its key before loading state, so any parked
  update lands on the next use of the doc regardless of how the previous
  session ended. New sync test proves defer -> drain applies (and re-drain
  dedupes).
- **P1 fixed (settle atomicity)**: the `settle_seq`/`last_settled_sha`
  marker update now commits in the SAME transaction as the settlement
  moment; a crash can no longer leave a minted moment on an
  unsettled-looking lineage (which forced a non-idempotent re-settle).
- **Flow bug found by strengthening the resync assertion**: a local-only
  close PRUNES the CRDT cache to a bare marker, but reopen still reported
  `lineage: "existing"` with an EMPTY doc and no `seedMarkdown` — the
  client's next settle would clobber the settled file. `lineage` now
  reports durable DOC STATE (marker with `head_update_seq > 0`), so a
  pruned reopen is `absent` + `seedMarkdown` and the artifact re-seeds the
  cache (the recordUpdate seed guard already admits a pruned marker).
- **P2 fixed (stale suppression entry)**: `consume_match` is now
  single-shot on ANY Changed observation of the path (a non-matching sha
  clears the stale entry), and workspace close/eviction clears the
  workspace's entries (the registry outlives workspaces).
- **P2 fixed (wire-size guard)**: `ydoc.open`/`ydoc.resync` refuse with
  `ydoc-state-exceeds-wire-limit` when the full state cannot fit one DOP1
  string post-base64 (48 KiB raw), instead of relying on the framer.
- **P2 fixed (client leak)**: a throw during the client's first-seed apply
  now releases the registered session and closes the daemon lease before
  surfacing.
- **Documented**: daemon settle path owns `settle_seq` as moment_order
  generation (collab `settle()` never runs on daemon lineages in C1);
  lease-on-actor-panic recovers via workspace reopen eviction (noted, not
  changed).
