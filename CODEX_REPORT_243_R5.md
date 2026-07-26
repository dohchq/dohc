# PR #243 — Codex-bot round 5

Commit: `62e76852438e9c7b2eb9eea5574de4628d0b038f`

Branch: `codex/rust-engine-rpc-e-moment-append`

The implementation is committed locally and has not been pushed. This report is
intentionally uncommitted.

## Findings addressed

### 1. Preserve complete imported metadata across every version fork

Every runtime fork copier now carries the complete metadata tuple:
`metadata_origin`, `metadata_summary`, and `metadata_correlation_id`.

Post-ordinal-17 copier inventory:

1. `dohc-engine-domain/src/store.rs:1555` — local fork live snapshots.
2. `dohc-engine-domain/src/store.rs:1567` — local fork-base snapshots.
3. `dohc-engine-sync/src/version_apply.rs:182` — legacy replicated fork live
   snapshots.
4. `dohc-engine-sync/src/version_apply.rs:197` — legacy replicated fork-base
   snapshots.
5. `dohc-engine-sync/src/version_apply.rs:309` — shipped replicated fork
   snapshots inserted into both live and fork-base tables.

The complete search also found the three ordinal-10 schema rebuild copiers in
`migration.rs`: `snapshots_v10` at line 1251, `fork_base_snapshots_v10` at line
1283, and `moments_v10` at line 1337. They intentionally retain the ordinal-9
shape because they execute before ordinal 17 creates the optional metadata
columns; they are not runtime fork paths and cannot select columns that do not
exist yet.

Regressions and mutation proofs:

- `create_named_version_forks_and_isolates` verifies local live and fork-base
  rows retain both optional fields.
- `version_create_legacy_payload_copies_workspace_scoped_source_tables`
  verifies both legacy replicated `INSERT ... SELECT` destinations.
- `version_create_router_materializes_shipped_fork_snapshots_and_replays_idempotently`
  verifies summary/correlation fields in both shipped destinations.
- Each test asserts the complete tuple on both destination tables, so dropping
  either field or missing any copier fails.

### 2. Remove the actual live alias for an imported rename

The rename fast-forward path now resolves the alias to remove from the matched
local snapshot path. It falls back to `payloadBeforePath` only when no local
snapshot exists, matching the delete path's resolution rule.

Regression:
`moment_append_head_fast_forward_write_delete_and_rename_updates_alias_snapshot_and_search`
now imports a rename whose wire before-path is `peer-old.md` while the matched
local head is at `old.md`. It verifies that only `new.md` remains.

Mutation proof: restoring wire-path-only deletion leaves `old.md` as a stale
second alias and fails the exact alias-set assertion.

### 3. Enforce one moment-ID namespace across plaintext and secret history

A first-delivery `moment.append` now rejects an occupied ID if it exists in
either `moments` or `secret_moments`. It returns a hard
`SyncError::InvalidInput` before history, replication-log, or ack mutation.

The secret applier now performs the same two-table reservation check for its
synthesized `secret-sync-{origin}-{seq}` IDs. Its existing zero-row guard
remains as a final same-table race/invariant check.

Regressions and mutation proofs:

- `moment_append_first_delivery_rejects_plaintext_id_collision_but_redelivery_skips`
  proves a distinct coordinate cannot claim an existing plaintext ID while an
  actual coordinate replay still skips idempotently.
- `moment_append_rejects_id_collision_with_secret_history` proves plaintext
  import rejects an ID owned by protected history.
- `secret_put_rejects_synthesized_moment_id_owned_by_plaintext_history` proves
  the reverse cross-table direction.
- Existing `secret_put_rejects_synthesized_moment_id_owned_by_unrelated_local_history`
  and `secret_put_redelivery_skips_its_own_synthesized_moment` continue to prove
  same-table rejection and secret coordinate replay.
- Each rejection test verifies the original owner remains unique, no incoming
  tip/history row persists, and the peer ack stays at `-1`.

### 4. Reject reserved replicated metadata origins

Replicated plaintext moment metadata now uses exactly the TypeScript oracle
allowlist:

- `api`
- `local-file`
- `restore`
- `sync`
- `unknown`

Both the moment metadata and a present before-snapshot metadata tuple use this
validation. Reserved ownership markers `capture` and `ydoc`, empty values, and
all other values fail with hard `SyncError::InvalidInput`.

Regression:
`moment_append_accepts_only_oracle_metadata_origins_without_ack_on_rejection`
proves all five allowed values apply and tests both reserved values in both
metadata positions. Rejections persist no moment/snapshot and do not advance
the peer ack.

Mutation proof: restoring the previous empty-only check makes each reserved
origin case apply or enter conflict processing, failing the hard-error and
zero-state assertions.

## Verification evidence

Environment used for every Cargo command:

- `CARGO_TARGET_DIR=C:/w/_targets/rpcema`
- `TEMP=C:/w/_targets/rpcema-tmp`
- `TMP=C:/w/_targets/rpcema-tmp`

Final verification:

- `cargo test -p dohc-engine-sync -p dohc-engine-storage` — passed:
  26 storage unit tests, 12 storage integration tests, 160 sync unit tests,
  7 r10cc probes, and 1 security-contract test; 0 failures.
- `cargo test -p dohc-engine-domain --test versioning create_named_version_forks_and_isolates`
  — passed: 1 regression, 0 failures.
- `cargo test -p dohc-engine-testkit --test durability` — passed: 10
  crash/reopen durability tests, 0 failures.
- `cargo fmt --all -- --check` — passed.
- `cargo clippy -p dohc-engine-sync -p dohc-engine-storage --all-targets -- -D warnings`
  — passed.
- `git diff --check` — passed before commit.
- `git diff --name-only -- packages` — empty; `packages/` remained read-only.

No full repository gate was run, per the scoped instruction.
