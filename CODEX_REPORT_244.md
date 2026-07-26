# PR #244 CodeRabbit 2026-07-25 11:37 review disposition

Reviewed the seven unresolved CodeRabbit threads created at
`2026-07-25T11:37` (comment ids `3650109295`, `3650109297`,
`3650109298`, `3650109300`, `3650109302`, `3650109304`, and
`3650109306`). No file under `packages/` was modified.

## F1 — full-workspace pending-replication scan

**Disposition: fixed for the empty common case; retention cap intentionally not
implemented.**

`replay_ready_pending_chat_coordinates` now starts with:

```sql
SELECT EXISTS(
  SELECT 1
  FROM chat_pending_replication
  WHERE workspace_id = ?1
  LIMIT 1
)
```

An empty workspace returns before preparing or executing the
`chat_pending_replication`/`replication_log` join or entering the fixed-point
loop. The structural domain-boundary wrapper remains on every write path; no
call-site allowlist was introduced.

The probe is index-backed. `chat_pending_replication` has primary key
`(workspace_id, origin_id, origin_seq)`, and
`empty_pending_replay_fast_path_does_not_open_the_replication_log` asserts that
SQLite selects its covering index for `workspace_id = ?`. The same test drops
`replication_log` after checking the plan and proves an unrelated boundary write
still succeeds when there are no pending rows.

The parked-row cap suggestion is not semantically safe on this branch:

- A parked row represents an accepted and acknowledged replication coordinate
  whose dependency may arrive later. Dropping it is permanent replicated data
  loss.
- The primary key permits at most one parked row per
  `(workspace_id, origin_id, origin_seq)`, and the row stores only bounded
  identifiers plus the dependency key; it does not duplicate the payload,
  which is already in `replication_log`.
- Growth is not theoretically bounded per origin: an origin can continue with
  later sequential coordinates after a coordinate parks. A batch is capped at
  500 ops, so 100,000 parked coordinates require at least 200 full relay
  batches, but repeated batches can still grow the set until storage limits.
- Converting overflow to `Err` would use the current unacked/wedged refusal
  behavior, not an established durable overflow disposition. Inventing that
  policy in this PR would be riskier than retaining the operation.

Consequently, a non-empty backlog still costs `O(P)` per boundary replay and
parked retention remains unbounded over time. This is the one residual tradeoff
that could not be safely removed with the branch's existing refusal semantics.

**Coverage:** `empty_pending_replay_fast_path_does_not_open_the_replication_log`.

**Mutation proof:** changed the guard to `if false && !has_pending`. The named
test failed behaviorally with `StateCorrupt: no such table: replication_log`.
After restoration it passed.

## F2 — redundant third replay in `set_follow`

**Disposition: fixed.**

Removed the explicit `replay_pending_chat_coordinates_for_change` call from
`set_follow`. `journal_local_op_in_tx` still provides the targeted replay for
journaled follows, while `write_with_pending_chat_replay` remains the structural
fallback for every follow, including receiver-private follows that do not
journal.

**Coverage:**
`local_follow_write_replays_a_parked_remote_feed_read_at_the_domain_boundary`
uses `replication_owner_user_id: None`, so it exercises the boundary replay
without relying on the journal-triggered path.

## F3 — duplicate deterministic slug wrappers

**Disposition: fixed.**

Removed `deterministic_placeholder_slug`. Authoritative channels and
placeholders now share the single `deterministic_channel_slug` entry point.

**Coverage:** all channel collision and placeholder convergence tests listed
under F5/F7.

## F4 — collision retry can exceed the 200-unit slug gate

**Disposition: fixed.**

Retry allocation no longer appends an unbounded `-x` chain. Every collision
candidate is a bounded base prefix (at most 135 ASCII bytes), `-`, and a
64-character SHA-256 hex digest. Later attempts deterministically rehash the
base, stable allocation identity, and attempt number, so every result is at
most 200 UTF-16 units regardless of retry count.

**Coverage:** `preoccupied_channel_fallback_converges_across_peers` forces the
first collision candidate to be occupied, verifies convergence and uniqueness,
and asserts every resulting slug is at most 200 UTF-16 units.

## F5 — global slug rewrites and incumbent displacement

**Disposition: both sub-claims fixed.**

### F5.1 — needless writes

`rebalance_channel_slugs` now loads each stored slug and computes the full
convergent allocation, but its sentinel and final UPDATE passes include only
rows whose computed slug differs from the stored slug. There are still `O(N)`
reads/computation because allocation is a pure function of the complete channel
set, but writes fall from `2N` to `2C`, where `C` is the number of rows whose
allocation actually changes.

These internal UPDATEs do not create replication journal entries; the imported
envelope is journaled once by the outer apply transaction. There are no
production `chat_channels` UPDATE triggers whose semantics require no-op
updates.

**Coverage:** `noncolliding_channel_apply_does_not_rewrite_unchanged_slugs`
installs an UPDATE trigger after the first channel, applies a non-colliding
second channel, and observes zero updates to the incumbent.

**Mutation proof:** removed the stored/computed equality filter. The named test
failed behaviorally with `left: 2, right: 0`. After restoration it passed.

### F5.2 — stable, convergent precedence

Channel slug precedence now sorts by:

1. replicated `createdAtMs`;
2. stable wire identity for equal timestamps; and
3. channel id as an internal final tie-break.

The target's `createdAtMs` and wire identity are passed into rebalancing before
insert or placeholder promotion, so allocation does not depend on the
placeholder's arrival timestamp or local row id. Existing rows prefer a
non-well-known wire identity; this prevents a local-only `general`/`agent`
backfill alias from changing the cross-peer tie-break. Collision hashes also use
the stable allocation identity rather than the possibly local placeholder row
id.

Thus the earlier-created channel keeps the base slug, later colliders receive
bounded hashed variants, and peers converge regardless of delivery order.

**Coverage:**

- `replicated_creation_order_determines_channel_slug_precedence`
- `authoritative_placeholder_slug_collision_converges_across_peers`
- `preoccupied_channel_fallback_converges_across_peers`

**Mutation proof:** restored channel-id-only ordering. The authoritative
placeholder test failed because the earlier incumbent changed from
`shared-name` to
`shared-name-2fb6501c4eb308d0d94d5cfbbd9b30fb47676413274b18bc269cdc7a0d936a72`.
After restoration both the incumbent and delivery-permutation tests passed.

## F6 — wrong error signal for missing target allocation

**Disposition: fixed.**

The impossible missing-target result now uses
`SyncError::Storage(StorageError::StateCorrupt)` through the established
`SyncError::corrupt` constructor instead of `CoordinateDiverged`.

**Coverage:** `missing_target_slug_is_classified_as_storage_corruption`.

**Mutation proof:** restored `CoordinateDiverged`. The named test failed its
`matches!(error, SyncError::Storage(_))` assertion. After restoration it passed.

## F7 — tests did not pin the incumbent

**Disposition: fixed.**

`authoritative_placeholder_slug_collision_converges_across_peers` now pins the
earlier incumbent to `shared-name`.
`preoccupied_channel_fallback_converges_across_peers` now pins the
earlier-created `channel-a` to `x`, pins the deliberately occupied first
fallback, and checks that the newcomer takes a distinct bounded retry.

## TypeScript oracle behavior

The read-only oracle in `packages/workspace-engine/src/linkedChatStore.ts` uses
local occupancy:

- `replaceChannelPlaceholderMetadata` leaves the current slug owner in place.
- `nextFreeChannelSlug` assigns the incoming channel `slug-2`, `slug-3`, and so
  on.
- direct replicated channel apply uses that same local next-free allocator.

`packages/workspace-engine/src/syncFolder.test.ts` explicitly expects each
peer's own local channel to keep the base slug after a two-way collision. That
means the oracle preserves a local lookup alias but does not converge slug
ownership across peers. Although channel payloads carry `createdAtMs`, the
oracle does not use it for slug allocation.

The Rust path deliberately does not copy that arrival-order rule. Per this
review's hard constraint, it uses replicated creation time plus stable wire
identity so the allocation is a pure convergent projection of replicated state.

## Verification

All cargo commands used:

```text
CARGO_TARGET_DIR=C:/w/_targets/chatval
TEMP=C:/w/_targets/chatval-tmp
TMP=C:/w/_targets/chatval-tmp
```

- `cargo fmt --all` — PASS
- `cargo test -p dohc-engine-sync` — PASS (124 crate tests, 7 R10CC probes,
  1 security-contract test, doc tests)
- `cargo test -p dohc-engine-domain` — PASS (all crate, integration, and doc
  tests; the chat suite has 45 passing tests)
- `cargo clippy -p dohc-engine-sync -p dohc-engine-domain --all-targets --all-features -- -D warnings`
  — PASS
- `git diff --check` — PASS

No full-repository gate was run, as requested.

## Anything not closed

No review finding was ignored. The only behavior intentionally left in place is
unbounded durable retention of genuinely unresolved parked coordinates, for the
F1 data-loss/refusal-semantics reasons above. The empty common case is now one
covering-index probe; a non-empty parked backlog still requires the fixed-point
`O(P)` scan.
