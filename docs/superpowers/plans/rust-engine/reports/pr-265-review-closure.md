# PR #265 review closure

| Finding | Disposition | Named test(s) | Mutation result |
| --- | --- | --- | --- |
| P1 — `closeWorkspace` had no close barrier, allowing concurrent handle reuse and `closeAll()` repopulation | FIXED | `EngineWorkspaceSessions > drains active runs and blocks replacement opens until closeWorkspace finishes`; `EngineWorkspaceSessions > makes closeAll terminal so teardown cannot be repopulated` | Removing the active-run drain made the first test run and fail at the assertion that no `workspace.close` request may start during an active operation (`expected length 0, received 1`); restoring the drain made it pass. Removing the terminal `closeAll()` admission fence made the second test run and fail because the late run resolved with `"unexpected"` instead of rejecting; restoring the fence made it pass. |
| P2 — the two-second workspace-open deadline aborted large opens, and the initial open was not retried | FIXED | `EngineWorkspaceSessions > opens workspaces without a daemon deadline`; `EngineWorkspaceSessions > retries an initial workspace open failure before running the operation` | Restoring the 2,000 ms deadline made the first test run and fail because the open request contained `deadlineMs: 2000`; removing it made the test pass. Reducing safe open attempts back to one made the second test run and fail because the promise rejected with `transient workspace open failure`; restoring the retry made it pass with two open attempts and one operation call. |

## Verification

- `pnpm --filter @dohc/desktop test -- src/mainChatIpcBackends.test.ts src/workspaces/engineWorkspaceSessions.test.ts` — 9 tests passed.
- `pnpm --filter @dohc/desktop typecheck` — passed.
- `CARGO_TARGET_DIR=C:/w/rpcs234/target cargo fmt --all` — passed.
- `git diff --check` — passed.
- `git diff origin/main --stat -- packages/` — empty.

Sibling paths checked: active normal operations, concurrent opens, reconnect retries, transport retries, initial and rebind open failures, concurrent `closeWorkspace` calls, runs waiting behind a workspace close, and bulk shutdown all use the same session lease/close barrier. `closeAll()` is terminal and rejects both newly arriving runs and runs that were waiting for a per-workspace close, so its one-time workspace snapshot cannot be repopulated.

Unresolved findings: none.
