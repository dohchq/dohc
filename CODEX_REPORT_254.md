# PR #254 review closure report

All 13 genuinely-open findings were fixed. No finding remains unresolved.

| # | Severity / thread | Disposition | Named proof test | Mutation result |
|---:|---|---|---|---|
| 1 | P1 `PRRT_kwDOSk1N0c6T3cLJ` | FIXED | `EngineClient > times out only the expired request and ignores its late reply` | Restoring `fail()` in the request deadline timer ran the test and failed its unrelated-request resolution assertion; restoring request-local rejection and late-reply tombstones passed. |
| 2 | P2 `PRRT_kwDOSk1N0c6T31R_` | FIXED | `live agent dispatch store > deadlines every scan-side dispatch read` | Removing the scan RPC request options ran the test and failed with five `undefined` deadlines instead of `2000`; restoring bounded, transport-retried reads passed. |
| 3 | P2 `PRRT_kwDOSk1N0c6T3cNW` | FIXED | `live agent dispatch store > deadlines and transport-retries eligible-trigger recording` | Removing the deadline/retry options ran the test and rejected on the first simulated lost transport response instead of resolving after rebind; restoring them passed. |
| 4 | P2 `PRRT_kwDOSk1N0c6T3cNc` | FIXED | `chatDispatchService > re-resolves an ambiguously committed claim even when pending is empty` | Disabling uncertain-claim resolution ran the test and failed because no runner started for the already-running row; restoring resolution before the pending-list gate passed. |
| 5 | P2 `PRRT_kwDOSk1N0c6T3cNb` | FIXED | `chatDispatchService > reserves the workspace while the asynchronous claim is pending` | Removing the pre-claim reservation ran the test and failed because the runner self-test spawned during the deferred claim; restoring reservation before preparation/claim passed. |
| 6 | P2 `PRRT_kwDOSk1N0c6T31SA` | FIXED | `chatDispatchService > restores a Resume budget bypass when the claim RPC rejects` | Removing bypass restoration from the claim error path ran the test and failed because the recovery scan re-paused the thread; restoring the bypass passed. |
| 7 | P2 `PRRT_kwDOSk1N0c6T3cNZ` | FIXED | `restart_failure_remains_durably_recoverable_before_requeue` and `chatDispatchService > recovers a restart-failed row left behind before its requeue` | Restricting the durable recovery query back to `app-quit` ran the Rust test and failed its assertion (`None` versus the restart recovery); restoring restart-failure discovery passed both Rust and desktop recovery tests. |
| 8 | P2 `PRRT_kwDOSk1N0c6T3cNY` | FIXED | `CLI socket server > persists pending provenance across shutdown without reporting it settled` | Restoring close-time deletion ran the test and failed because shutdown reported the link settled (and removed its durable record); restoring disk persistence passed. |
| 9 | P2 `PRRT_kwDOSk1N0c6T31R7` | FIXED | `CLI socket server > persists pending provenance across shutdown without reporting it settled` | The same close-time mutation ran and failed the restart-recovery assertion path; restoring durable rehydration linked the message after simulated restart and passed. |
| 10 | P2 `PRRT_kwDOSk1N0c6T3cLI` | FIXED | `CLI socket server > persists pending provenance across shutdown without reporting it settled` | Restoring `notifySettled` in `close()` ran the test and failed with a settled callback during shutdown; restoring silent close plus a distinct abandonment callback passed. |
| 11 | P2 `PRRT_kwDOSk1N0c6T3cLH` | FIXED | `CLI socket server > bounds the provenance recovery queue and abandons after its attempt cap` | Removing the size/attempt caps ran the test and failed because the second link entered the full queue; restoring the cap, bounded exponent, age/attempt budgets, and abandonment path passed. |
| 12 | nit `PRRT_kwDOSk1N0c6T3cLG` | FIXED | `CLI socket server > caps all foreground provenance work with one wall-clock budget` | Replacing the shared budget with a long per-attempt window ran the test and failed because all three full-deadline attempts executed; restoring the shrinking shared deadline passed. |
| 13 | nit `PRRT_kwDOSk1N0c6T3cLL` | FIXED | `EngineWorkspaceRunOptions > documents that transport retries replay the caller operation` | Removing the JSDoc ran the source-contract test and failed its documentation assertions; restoring the idempotent/self-verifying replay warning passed. |

## Sibling-path audit

- The no-runner `failPendingForThread` path and ambiguous requeue verification now use the same deadline and transport-retry guarantees as normal dispatch scans.
- Workspace ownership is reserved before asynchronous workspace preparation and claim, and is released/restored on preparation failure, claim failure, null claim, stop, and pause paths.
- CLI recovery now checks for shutdown again after an in-flight retry settles, so a late retry cannot emit a settled callback or start a shutdown scan.
- CLI recovery persists attempts and creation time, caps the backoff exponent, queue size, attempts, and age, and restores all records atomically before rewriting the recovery file.

## Verification

- `pnpm --filter @dohc/desktop typecheck` — passed.
- Focused desktop suites — 130 passed, 1 skipped.
- `CARGO_TARGET_DIR=C:/w/rpcs1/target cargo test -p dohc-engine-domain --test chats_b2` — 31 passed.
- `CARGO_TARGET_DIR=C:/w/rpcs1/target cargo fmt --all` — completed.
- Full desktop suite with bounded concurrency (`vitest run --maxWorkers=4 --minWorkers=1`) — 2,183 passed, 4 skipped. An earlier unrestricted run hit two Windows load/SQLite timing flakes; both passed alone and in the bounded full run.
- `git diff HEAD --stat -- packages/` — empty; this work did not modify `packages/`.
- `git diff origin/main --stat -- packages/` is **not** empty because commits `d0af3f23` and `e6f486a4` already changed five package files before this task. Those pre-existing PR changes were preserved to comply with the read-only-package instruction.
