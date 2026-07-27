# PR #263 review closure report

All 29 supplied findings were addressed. No finding remains unresolved. Duplicate
threads below intentionally cite the same regression and mutation run when they
describe the same defect.

| # | Severity / thread | Disposition | Named regression test | Mutation result |
|---:|---|---|---|---|
| 1 | P1 `PRRT_kwDOSk1N0c6T5zjX` key-envelope stale overwrite | FIXED | `key_envelope_conflict_is_surfaced_without_rebasing_over_the_winner` | Restored the conflict-download-retry loop: assertion failed with 3 stale uploads instead of 1; strict CAS restored: PASS. |
| 2 | P1 `PRRT_kwDOSk1N0c6T5KPK` key-envelope conflict clobber | FIXED | `key_envelope_conflict_is_surfaced_without_rebasing_over_the_winner` | Same mutant as #1 failed on the repeated stale request bytes; restored: PASS. |
| 3 | P1 `PRRT_kwDOSk1N0c6T42ee` `keys.upload` hides CAS failure | FIXED | `deferred_key_upload_surfaces_the_first_cas_conflict_without_a_cached_retry_loop` | Restored rebasing: assertion received `relay-io-pending` instead of `Conflict`; restored: PASS. |
| 4 | P1 `PRRT_kwDOSk1N0c6T5zjY` recovery retains share push state | FIXED | `recover_origin_clears_shared_push_positions_before_rebased_ops_are_scanned` | Removed the recovery delete: assertion found the stale state row; restored: PASS. |
| 5 | P1 `PRRT_kwDOSk1N0c6T5K45` rebased share tail skipped | FIXED | `recover_origin_clears_shared_push_positions_before_rebased_ops_are_scanned` | Same mutant as #4 retained physical cursor 99 and failed before the rebased push; restored push count is 1: PASS. |
| 6 | P1 `PRRT_kwDOSk1N0c6T5zjV` multi-path grant collapsed | FIXED | `share_view_pull_accepts_every_tracked_path_selected_by_the_relay` | Restored one `docs` prefix: `(fetched, skipped)` became `(2, 1)` instead of `(2, 0)`; restored: PASS. |
| 7 | P1 `PRRT_kwDOSk1N0c6T4VhZ` RPC requires one path prefix | FIXED | `share_view_pull_is_read_only_and_defers_its_persisted_cursor` and `share_view_pull_accepts_every_tracked_path_selected_by_the_relay` | Single-prefix mutant failed the multi-path assertion; RPC test passes without `pathPrefix`: PASS. |
| 8 | P1 `PRRT_kwDOSk1N0c6T5zjb` share pull drops `has_more` | FIXED | `share_view_pull_returns_one_page_as_a_pending_resumable_cursor` and `share_view_outcome_json_surfaces_has_more` | Forced outcome `has_more=false`: assertion on first bounded page failed; removed JSON field: assertion saw `null`; restored: PASS. |
| 9 | P1 `PRRT_kwDOSk1N0c6T42ef` owner push includes imported origins | FIXED | `workspace_push_excludes_origins_imported_from_share_views` | Removed `imported=0`: push count became 2 instead of 1; restored: PASS. |
| 10 | P1 `PRRT_kwDOSk1N0c6T4VhS` share blobs redownload exponentially | FIXED | `share_view_actor_replay_does_not_redownload_completed_blob_prefixes` | Disabled the pre-fetch idempotency check: blob calls became 6 instead of 3; restored: PASS. |
| 11 | P2 `PRRT_kwDOSk1N0c6T42ea` all-present `BlobsHave` retained | FIXED | `completed_empty_blob_inventory_is_released_without_an_upload` | Removed the empty-inventory release arm: completed state remained non-empty and assertion failed; restored: PASS. |
| 12 | P2 `PRRT_kwDOSk1N0c6T4Vhc` cached key-envelope retries | FIXED | `deferred_key_upload_surfaces_the_first_cas_conflict_without_a_cached_retry_loop` | Restored the retry loop: assertion received deferred GET instead of the first conflict; restored: PASS. |
| 13 | P2 `PRRT_kwDOSk1N0c6T42eV` old token can regress cursor | FIXED | `newer_pull_token_supersedes_the_older_token_for_the_same_scope` and `persisted_relay_and_share_cursors_never_regress_within_the_same_stream` | Removed supersession: old token committed and `expect_err` failed. Removed monotonic SQL guard: cursor became 4 instead of 10. Restored: PASS. |
| 14 | P2 `PRRT_kwDOSk1N0c6T40-B` pending token map unbounded | FIXED | `newer_pull_token_supersedes_the_older_token_for_the_same_scope` | Removed per-scope replacement: old token remained valid and assertion failed; restored: PASS. |
| 15 | P2 `PRRT_kwDOSk1N0c6T4Vhf` abandoned pulls leak tokens | FIXED | `newer_pull_token_supersedes_the_older_token_for_the_same_scope` | Same supersession mutant retained both tokens and failed; restored: PASS. |
| 16 | P2 `PRRT_kwDOSk1N0c6T5K4_` retries retain regressive tokens | FIXED | `newer_pull_token_supersedes_the_older_token_for_the_same_scope` and `persisted_relay_and_share_cursors_never_regress_within_the_same_stream` | Supersession mutant accepted the abandoned token; monotonic mutant persisted 4 over 10; restored: PASS. |
| 17 | P2 `PRRT_kwDOSk1N0c6T5K48` permanent absence mapped as outage | FIXED | `relay_error_mapping_preserves_recovery_and_authorization_conditions` | Remapped share/key absence to `WORKSPACE_UNAVAILABLE`: assertion expected `SHARE_UNAVAILABLE` and failed; restored: PASS. |
| 18 | P2 `PRRT_kwDOSk1N0c6T5zjd` relay errors collapse to invalid params | FIXED | `relay_error_mapping_preserves_recovery_and_authorization_conditions` | Remapped `OriginDiverged` to `INVALID_PARAMS`: assertion failed. Dedicated protocol codes now cover every recovery/action condition; restored: PASS. |
| 19 | P2 `PRRT_kwDOSk1N0c6T5KPR` truncated test request panics | FIXED | `truncated_test_request_body_returns_unexpected_eof_without_panicking` | Removed length guard: caught slice panic made the explicit no-panic assertion fail; restored: PASS. |
| 20 | P3 `PRRT_kwDOSk1N0c6T40-D` forbidden mapped as invalid params | FIXED | `relay_error_mapping_preserves_recovery_and_authorization_conditions` | Remapped `Forbidden` to `INVALID_PARAMS`: assertion expected `FORBIDDEN` and failed; restored: PASS. |
| 21 | P3 `PRRT_kwDOSk1N0c6T5KPI` redelivery re-derives materialization | FIXED | `redelivered_moment_uses_the_durable_apply_time_materialization_decision` | Restored live-active-version gating: durable change list became empty and assertion failed; restored ledger-backed decision: PASS. |
| 22 | P3 `PRRT_kwDOSk1N0c6T40-R` timestamp scan runs every open | FIXED | `persists the legacy timestamp validation marker after the first scan` | Forced the scan despite the marker: reopen threw on a post-marker poison row and `not.toThrow` failed; restored: PASS. |
| 23 | P3 `PRRT_kwDOSk1N0c6T5KO-` base URL query/fragment accepted | FIXED | `relay_base_url_rejects_query_and_fragment_components` | Removed query/fragment guards: constructor acceptance assertion failed; restored: PASS. |
| 24 | P3 `PRRT_kwDOSk1N0c6T5KO_` share-view limit unclamped | FIXED | `status_classes_and_all_transport_endpoints_preserve_auth_and_wire_shapes` | Removed `.min(MAX_PULL_OPS)`: expected `limit=500` target was absent and assertion failed; restored: PASS. |
| 25 | P3 `PRRT_kwDOSk1N0c6T5KPH` eager canonical payload | FIXED | `fresh_coordinate_does_not_canonicalize_payload_for_a_comparison_that_cannot_exist` | Reintroduced eager canonicalization: call count was 1 instead of 0 and assertion failed; restored: PASS. |
| 26 | P3 `PRRT_kwDOSk1N0c6T5KPP` blob existence probe reads content | FIXED | `pull_blob_existence_probe_does_not_read_and_rehash_present_content` | Restored `local_blob_bytes(...).is_none()`: reader count was 1 instead of 0 and assertion failed; restored: PASS. |
| 27 | P3 `PRRT_kwDOSk1N0c6T5KPU` falsy timestamps coerce to zero | FIXED | `rejects fractional and out-of-range timestamps before admitting log rows` | Restored `Number(...)` coercion: a falsy case returned HTTP 200 instead of 400 and assertion failed; restored: PASS. |
| 28 | P3 `PRRT_kwDOSk1N0c6T409_` dual-kind test ignores pull error | FIXED | `relay_hydrates_text_and_binary_rows_for_one_shared_digest` | Injected a post-hydration error: the new `SyncPassOutcome::Complete` assertion failed; restored: PASS. The fixture now uses a valid empty Yjs base update that is also valid UTF-8. |
| 29 | nit `PRRT_kwDOSk1N0c6T5KO3` “quadratic actor turns” | REFUTED | `deferred_multi_page_pull_schedules_each_http_request_once` | Four distinct pages schedule exactly four HTTP requests; completed prefixes are memoized. `Actor::relay` sends one `Command::Relay` per pending I/O plus the terminal command, so actor turns are linear, not quadratic. No production mutation was warranted. |

## Sibling-path checks

- Cursor supersession is backed by monotonic persistence guards for both relay
  and share cursors.
- Timestamp type validation now exists in both the HTTP parser and the exported
  storage append path.
- Strict key-envelope CAS is shared by the direct sync client and deferred actor
  path; neither downloads/rebases on conflict.
- Share-view fallback still rejects secret/untracked paths while accepting every
  tracked path already filtered by the relay grant.

## Validation

- `cargo fmt --all`
- `cargo test -p dohc-engine-runtime --lib`
- `cargo test -p dohc-engine-sync --lib` (188 passed)
- Focused `dohc-workspace-engine` lib and `rpc_relay` tests named above
- `cargo test -p dohc-engine-sync-http --lib`
- `cargo test -p dohc-engine-sync-http --test relay_http status_classes_and_all_transport_endpoints_preserve_auth_and_wire_shapes`
- `cargo test -p dohc-engine-protocol --lib`
- `pnpm --filter @dohc/sync-relay typecheck`
- Focused `server.test.ts` timestamp/cutover/marker tests
- `git diff origin/main --stat -- packages/` is empty

No finding could not be resolved.
