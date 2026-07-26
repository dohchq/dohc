# PR #244 round 2 implementation report

## Result

Implemented the orchestrator decision: Rust channel slug allocation now follows
oracle-parity local occupancy semantics. Existing rows are never displaced by a
new arrival. A colliding newcomer receives a bounded SHA-256 variant derived
only from its own replicated identity. Cross-peer channel binding remains the
wire id; the slug is only a local alias.

No files under `packages/` were modified. `REVIEW_ROUND2.md` was read in full
and deleted after this report was prepared.

## Per-finding disposition

### Finding 1 — peer-local `created_at_ms` contaminated allocation: CLOSED

- Deleted `rebalance_channel_slugs`, its workspace-wide row load, timestamp
  sort, sentinel pass, and bystander updates.
- `allocate_channel_slug` now probes `(workspace_id, slug)` occupancy for only
  the materializing row. It never sorts or considers any timestamp.
- `incoming_placeholder_never_displaces_bootstrapped_general_regardless_of_clock`
  covers the review's General-channel repro with General created both before and
  after the remote placeholder's timestamp.
- The trigger-counting guard now includes an older colliding newcomer and
  categorically observes zero slug updates to existing rows.

### Finding 2 — target override / bystander `COALESCE` made allocation last-writer-dependent: CLOSED

- Deleted the bystander identity query and target override wholesale.
- A channel create uses its wire id (the replicated channel id is the effective
  wire id when the optional wire field is absent).
- A placeholder uses its wire id when present; otherwise it uses its
  deterministic `placeholder:{origin}:{slug}` channel identity.
- Neither incumbent ids, local rowids, clocks, nor any other local row state
  enters the collision hash.
- `colliding_newcomer_hash_is_stable_across_local_occupancy_histories` applies
  one replicated newcomer to peers whose incumbents have different local ids,
  bystanders, and timestamps, and checks the exact wire-keyed hash.

### Finding 3 — negative channel `createdAtMs` accepted: CLOSED

- `ChannelCreate.created_at_ms` is now gated by
  `is_replicated_timestamp` (`0..=MAX_WIRE_INTEGER`).
- `imported_channel_refuses_non_timestamp_created_at_ms_without_row_or_ack`
  checks both `-1` and `i64::MAX`, including no materialized row and no ack.
- `created_at_ms` has no allocation role.

### Finding 4 — noncollision base could exceed 200 units: CLOSED

- Every allocation base is passed through UTF-16-unit-aware,
  char-boundary-safe `truncate_slug_base(..., 200)`.
- Placeholder synthetic names are based on this bounded allocation base,
  including the wire-id-only fallback.
- Collision bases are independently bounded to 135 UTF-16 units before adding
  `-` plus the 64-hex digest.
- Every slug persisted by the sync materializer is guarded with
  `debug_assert!(is_replicated_channel_slug(...))`.
- `overlong_wire_only_placeholder_slug_round_trips_through_local_thread_journal`
  proves a 240-unit wire-only placeholder stores a valid 200-unit slug, a local
  thread re-journals it, and a second peer accepts that envelope.

### Finding 5 — tests did not bite: CLOSED

The falsified convergence tests were removed/replaced. New or strengthened
guards:

- `incoming_placeholder_never_displaces_bootstrapped_general_regardless_of_clock`
- `colliding_newcomer_hash_is_stable_across_local_occupancy_histories`
- `authoritative_channel_materialization_only_reallocates_its_own_placeholder`
- `noncolliding_channel_apply_does_not_rewrite_unchanged_slugs`
- `overlong_wire_only_placeholder_slug_round_trips_through_local_thread_journal`
- `collision_slug_truncation_is_bounded_and_does_not_leave_a_dash_boundary`
- `imported_channel_refuses_non_timestamp_created_at_ms_without_row_or_ack`
- `set_follow_returns_the_post_boundary_replay_winner`

The pending replay EXPLAIN test now builds its statement from the exported
`PENDING_CHAT_WORKSPACE_EXISTS_SQL` constant used by production. It no longer
explains a copied string.

### Finding 6 — F2 rationale wrong and `set_follow` returned pre-replay state: CLOSED

- The source comment now records the factual cover: only
  `write_with_pending_chat_replay` replays for `set_follow`;
  `insert_local_replication_op` and `journal` only persist log rows.
- After the wrapper commits and replays, `set_follow` re-reads the register and
  returns the committed LWW end-state.
- `set_follow_returns_the_post_boundary_replay_winner` parks a newer remote
  unfollow, performs a local follow, and proves the returned value is the remote
  winner applied after the closure.

### Finding 10 — byte slicing and redundant lookup: CLOSED

- `truncate_slug_base` walks chars while counting UTF-16 units, so it cannot
  split UTF-8 or UTF-16 characters.
- It trims a trailing `-`, preventing empty slug segments.
- The old `used.contains`/nested loop and all recompute code were deleted.
- `collision_slug_truncation_is_bounded_and_does_not_leave_a_dash_boundary`
  uses a base longer than 135 units whose 135th unit is `-`; the resulting
  199-unit slug is valid and contains no `--`.

### Finding 11 — BEHAVIOR_DELTA overclaimed convergence: CLOSED

Section 13.1 now states the actual behavior:

- oracle-parity local occupancy;
- no cross-peer slug convergence;
- incumbents, including local-only and DM channels, are never rewritten;
- deterministic bounded newcomer hashes are the sole deliberate improvement
  over TS `-2`/`-3` counters;
- wire ids, not slugs, carry cross-peer identity.

## Design notes

- The occupancy query excludes only the row being materialized. This permits a
  placeholder to change its own name/slug when its authoritative channel create
  arrives, without moving any bystander.
- If the base is occupied, attempts are `hash(base, own_identity, attempt)` for
  attempt `0, 1, ...` until the candidate is free.
- Slug non-convergence is intentional and matches the oracle. Local occupancy
  can differ because user-created, DM, and well-known channels are local facts.
- No O(N) rewrite path remains.

## Fail-then-pass and mutation evidence

All named tests pass in the final two-crate run. Before the implementation, the
new tests produced these red-state failures:

- General repro:
  `left: "general-5e8778...ffa6", right: "general"` with
  `"an incoming row must never rename the locally bootstrapped General channel"`.
- Different occupancy histories:
  `left: "contested", right: "contested-5e7969...d470"`.
- Negative timestamp:
  `assertion failed: matches!(..., Err(SyncError::InvalidInput { .. }))`.
- Trigger guard:
  `left: 2, right: 0` for
  `"channel arrival must never update an existing row, even on collision"`.
- Wire-only bound:
  `"the synthesized base must already satisfy the outbound channelSlug grammar"`.
- Dash-boundary truncation:
  old output contained `--9e475b...` while the expected output contained
  `-9e475b...`.
- Follow return:
  `left: Following, right: Unfollowed`.

Post-implementation mutations were applied one at a time and restored:

1. Reintroduced incumbent displacement in `allocate_channel_slug`.
   `incoming_placeholder_never_displaces_bootstrapped_general_regardless_of_clock`
   failed with local General changed to
   `"general-0b9126...51d4"` instead of `"general"`.
2. Keyed channel-create collision hashing on local `channel_id` instead of wire
   id. `colliding_newcomer_hash_is_stable_across_local_occupancy_histories`
   failed with `"contested-3c5aa7...5c58"` instead of
   `"contested-5e7969...d470"`.
3. Reverted channel timestamp validation to `is_persisted_safe_integer`.
   `imported_channel_refuses_non_timestamp_created_at_ms_without_row_or_ack`
   accepted the negative timestamp and failed its `InvalidInput` assertion.
4. Removed the 200-unit base truncation.
   `overlong_wire_only_placeholder_slug_round_trips_through_local_thread_journal`
   failed at `assertion failed: is_replicated_channel_slug(&base)`.
5. Removed trailing-dash trimming.
   `collision_slug_truncation_is_bounded_and_does_not_leave_a_dash_boundary`
   failed at `assertion failed: is_replicated_channel_slug(&slug)`.
6. Returned the closure's pre-replay `ChatFollow`.
   `set_follow_returns_the_post_boundary_replay_winner` failed with
   `left: Following, right: Unfollowed`.
7. Changed the shared emptiness probe to join `replication_log`.
   `empty_pending_replay_fast_path_does_not_open_the_replication_log` failed
   after its table drop with `no such table: replication_log`.

Every mutation was restored before final verification.

## Final verification

Environment:

- `CARGO_TARGET_DIR=C:/w/_targets/chatval`
- `TEMP=C:/w/_targets/chatval-tmp`
- `TMP=C:/w/_targets/chatval-tmp`

Commands:

- `cargo test -p dohc-engine-sync -p dohc-engine-domain` — PASS
- `cargo fmt --all` — PASS
- `cargo clippy -p dohc-engine-sync -p dohc-engine-domain --all-targets --all-features -- -D warnings` — PASS
- `git diff --check` — PASS

The full repository gate was intentionally not run, per instruction.

## Not closed

None of review findings 1, 2, 3, 4, 5, 6, 10, or 11 remain open.
