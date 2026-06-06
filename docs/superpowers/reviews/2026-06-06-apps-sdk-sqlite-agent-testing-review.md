# Apps SDK / SQLite / Agent Testing Review

## Verdict

Block merge.

This third pass reviewed the current working tree after the second-pass remediation. Several previously reported blockers are materially improved: SQLite bytes are now parsed through the worker, database row ops update structured state and can materialize bytes, database paths/locks/review gates are enforced, collection/index/onboarding caps fail closed, bundle errors use app language, and the focused test slices I ran pass. Merge is still blocked because the app tester now executes untrusted app code inside the Node service process, database creation can ingest any caller-supplied storage id without proving workspace ownership, the SQLite finance tracker fixture does not route its rendered buttons through SQLite database APIs, and AppTester can still approve mixed fake UI. Also note the requested compare range is still empty: `main` and `codex/apps-sdk-sqlite-agent-testing` both resolve to `b697c94a0e11fda7deb2479f5ef566ced56381f7`; the reviewed implementation is uncommitted working-tree state.

## Critical Findings

### 1. AppTester executes untrusted app code in the Node service process

- Severity: Critical
- File/line: `services/app-tester/src/runAppTest.ts:164-208`, `services/app-tester/src/runAppTest.ts:225-228`, `services/app-tester/src/server.ts:59-60`
- Problem: The tester transpiles app source and runs it with `new Function(...)` in the app-tester Node process. The custom `requireStub` blocks imports, but it does not sandbox globals; app code can still reference `globalThis.process`, `fetch`, timers, CPU-heavy loops, and any other Node global available to the service.
- Why it matters: `test_app` handles generated workspace code. A malicious or compromised app can read service environment variables, make network calls, or hang the tester process. Because test results are returned to Convex/onboarding, this turns the quality gate into a secret-leak and availability boundary.
- Reproduction or reasoning: I ran a harmless probe with `APP_TESTER_PROBE_SECRET=harmless-probe` and an app component that referenced `globalThis.process?.env?.APP_TESTER_PROBE_SECRET`; `runAppTest` returned `ok: true` instead of rejecting access to process globals. The source path is direct: line 204 invokes `new Function`, then line 221 calls the component and lines 225-228 execute click handlers in the same process.
- Suggested fix: Run app tests in an isolated browser context or separate locked-down worker with no Node globals, strict timeout/resource limits, disabled network unless explicitly allowed, and no access to service env. Do not use `new Function` in the privileged service process for untrusted app code.
- Test that should fail before the fix: A generated app that reads `globalThis.process.env.APP_TESTER_PROBE_SECRET`, calls `fetch('https://example.com')`, or loops forever should be rejected or killed by the sandbox without exposing data or blocking the process.

### 2. Database creation can ingest storage blobs that are not owned by the caller's workspace

- Severity: Critical
- File/line: `apps/app/convex/databaseFiles.ts:100-148`, `apps/app/convex/databaseFiles.ts:305-347`, `apps/app/convex/assets.ts:168-172`
- Problem: `databaseFiles.create` accepts a browser-supplied `storageId`, reads it with `ctx.storage.get`, parses it, and creates a database in the caller's active workspace. There is no check that the storage id was uploaded by this user, registered as a `workspaceAssets` row for this workspace, or otherwise authorized.
- Why it matters: Convex storage ids are global object handles. This API lets any authenticated caller who obtains another workspace's SQLite storage id ingest and read that database snapshot in their own workspace. `assets.resolveAsset` also returns `storageId` to clients, so treating the id as sufficient authority is too risky.
- Reproduction or reasoning: Lines 319-346 derive identity/workspace correctly, but the only storage check is `verifiedSqliteBlob(ctx, args.storageId)`, which reads the blob and validates SQLite content. `_createVerified` then inserts the database under the caller's workspace. No `workspaceAssets.by_workspace_storage` lookup or creator/ACL check exists before the blob is parsed.
- Suggested fix: Require database creation to reference a workspace-owned asset id, or verify `(workspaceId, storageId)` in `workspaceAssets` before reading bytes. Prefer passing `assetId` over raw `_storage` ids and enforce asset ACL/ownership before worker ingest.
- Test that should fail before the fix: Alice uploads/registers a SQLite asset in workspace A. Bob calls `databaseFiles.create` in workspace B with Alice's `storageId`. The mutation must return an authorization error and must not create a `databaseFiles` row.

### 3. The generated SQLite finance tracker fixture does not persist through the SQLite runtime path

- Severity: Critical
- File/line: `apps/app/src/apps/fixtures/financeTrackerApp.ts:115-131`, `apps/app/src/apps/AppRuntimeHost.tsx:421-545`, `apps/app/convex/appData.ts:1082-1084`, `apps/app/convex/appFinanceTracker.acceptance.test.ts:268-312`
- Problem: The SQLite fixture declares a SQLite collection backed by `ledger.sqlite`, but its rendered buttons call `dohc.collection('ledger').insert/update(...)`. The runtime host only routes SQLite row ops to `databaseOps.appApply` when the RPC includes `args.database`, which is produced by `dohc.database(path).table(name)`, not plain `dohc.collection(name)`. Plain collection mutations for SQLite are explicitly rejected as `unsupported-format`.
- Why it matters: The generated SQLite finance tracker can pass the acceptance suite while its actual rendered "Add expense", "Categorize", and "Mark reviewed" buttons fail in the app runtime. That is a broken persistence claim for one of the headline generated fixtures.
- Reproduction or reasoning: `financeTrackerSqliteAppSource` uses `dohc.collection('ledger')` at lines 116, 127, and 131. `AppRuntimeHost` routes non-database collection writes to `appData.runCollectionMutation`, and `_resolveCollectionMutationForRun` rejects `config.format === 'sqlite'`. The acceptance test bypasses the app source and calls `api.databaseOps.appApply` directly at lines 268-312, so it never proves the fixture buttons persist.
- Suggested fix: Update the SQLite app source to call `dohc.database('ledger.sqlite').table('ledger')...` or extend `useCollection`/`dohc.collection` to bind the manifest's SQLite database automatically. Then acceptance must render/click the fixture through the real SDK bridge and assert database rows/op logs change.
- Test that should fail before the fix: Build/run `financeTrackerSqliteAppSource`, click "Add expense", and assert the RPC goes to `api.databaseOps.appApply` and creates a new row in `finance/ledger.sqlite`. The current fixture should fail with `unsupported-format`.

### 4. AppTester can still approve fake controls when any other control persists

- Severity: Critical
- File/line: `services/app-tester/src/runAppTest.ts:225-229`, `services/app-tester/src/runAppTest.ts:339-348`, `services/app-tester/src/runAppTest.browser.test.ts:51-75`
- Problem: The tester clicks all visible buttons, then checks only whether at least one mutating SDK call happened and the aggregate SDK snapshot changed. It does not require each visible primary control to cause the expected persistent mutation.
- Why it matters: A generated app can include one real "Add expense" button and a no-op "Mark reviewed" or "Categorize" button, and `test_app` still returns `ok: true`. This is a false-positive app quality gate and can let onboarding ship fake workflows.
- Reproduction or reasoning: I ran an adversarial app with two visible buttons: one `Add expense` button that inserts a row and one `Mark reviewed` button whose handler is a no-op. `runAppTest` returned `ok: true` with all checks passing. The existing regression only covers a no-op button plus an unused helper, not mixed real/fake controls.
- Suggested fix: Track SDK calls and state deltas per clicked control. For every visible command-like button in the tested workflow, require a matching persistent SDK write, expected target, and post-click state change. Manifest tests should define expected controls/actions when labels are ambiguous.
- Test that should fail before the fix: An app with visible "Add expense" persisting and visible "Mark reviewed" doing nothing must fail mutation persistence for the no-op control.

### 5. App text writes can race past user locks because Hocuspocus sees them as user writes

- Severity: Critical
- File/line: `apps/app/convex/appData.ts:887-889`, `apps/app/convex/appData.ts:954-958`, `apps/app/convex/appData.ts:1237-1241`, `apps/app/convex/hocuspocusAuth.ts:73-80`, `services/hocuspocus/src/semantic-api.ts:149-158`
- Problem: App doc/collection writes check atom locks during the Convex preflight query, but the final Hocuspocus semantic write is sent with `actorKind: 'user'`. Hocuspocus allows a workspace owner with `actorKind: 'user'` to write a `userLocked` atom; only `actorKind: 'agent'` is blocked.
- Why it matters: App writes are not direct manual edits. If a user locks a source after appData's preflight but before the Hocuspocus apply request, the final authoritative write gate can allow the app-origin write through as a user write. That violates the non-negotiable that app writes respect locks/review gates at the canonical write boundary.
- Reproduction or reasoning: The lock check at lines 887-889 is before the cross-service call. The Hocuspocus final guard calls `acl.canWriteAtom`, and `canOwnerWrite` returns true for `userLocked` when `actorKind !== 'agent'`. App actions/doc/collection writes all construct `actorKind: 'user'`.
- Suggested fix: Introduce an `actorKind: 'app'` or otherwise mark app-origin semantic writes so Hocuspocus denies userLocked sources for app writes. The final Hocuspocus ACL check must enforce the same lock/review semantics as Convex preflight, not rely on a stale earlier check.
- Test that should fail before the fix: Arrange for `_resolveDocMutationForRun` or `_resolveCollectionMutationForRun` to succeed, then set `userLocked: true` before `/apply/replaceRange`; Hocuspocus must reject the app-origin write and leave the Y.Doc unchanged.

## Important Findings

### 1. App test seed/freshness still omits source-backed docs

- Severity: Important
- File/line: `apps/app/convex/appTesting.ts:58-61`, `apps/app/convex/appTesting.ts:191-253`, `apps/app/convex/appTesting.ts:268-272`, `services/app-tester/src/runAppTest.ts:51-55`, `services/app-tester/src/runAppTest.ts:191-193`, `services/app-tester/src/runAppTest.ts:319-336`
- Problem: The digest implementation supports `seed.docs`, and AppTester has a `useDoc` stub, but Convex never populates doc seed data. `_resolveAppTestPayload` only builds `seed.collections` and `seed.databases`; `hasRealRows` ignores docs, so doc-backed apps can render placeholder or empty state without failing source-backed-data checks.
- Why it matters: Apps are allowed to persist through docs, not just collections/databases. A generated app that uses `useDoc('rules.md')` or `dohc.doc(...)` can pass/stay fresh even when the referenced doc changes or is empty in the tester.
- Reproduction or reasoning: The seed payload type in `appTesting.ts` has no `docs` field. `runAppTest` returns an empty body for `useDoc` unless `seed.docs` exists, but Convex never sends it. `checkSourceBackedData` only considers collection/database rows as real data.
- Suggested fix: Seed authorized docs referenced by manifest read scopes or manifest tests into `seed.docs`, include them in `computeAppSourceDigest`, and treat non-empty docs as source-backed data for placeholder checks.
- Test that should fail before the fix: A `useDoc('rules.md')` app with a non-empty `rules.md` source should receive that body in AppTester; changing `rules.md` should make `latestResult` return null until `test_app` is rerun.

### 2. Runtime app source loading can still return partial packages on large workspaces

- Severity: Important
- File/line: `apps/app/convex/apps.ts:329-355`, `apps/app/convex/apps.ts:522-555`
- Problem: `appTesting` now fails closed on scan overflow, but runtime app resolution/source loading still scans the first `ATOM_SCAN_CAP + 1`, logs/truncates, and can return `ok: true` from `getSourceFiles` with a partial package.
- Why it matters: In a large workspace, app runtime bundling can miss source files that fall after the cap and render/build a partial app while only setting `truncated: true`. The caller may not treat that as a hard failure, and this is the production runtime path rather than just the tester path.
- Reproduction or reasoning: `visibleAtomsForPackage` warns and slices on overflow. `getSourceFiles` sets `truncated = raw.length > ATOM_SCAN_CAP` but still returns `{ ok: true, entry, files, truncated }`.
- Suggested fix: Fail closed for runtime package loading when the workspace scan overflows, or add an index/prefix query that fetches only atoms under `packageRoot` without workspace-wide truncation.
- Test that should fail before the fix: Seed more than 5,000 atoms such that an app source file is beyond the scan cap; `apps.getSourceFiles` should return an explicit truncation error rather than `ok: true` with incomplete files.

### 3. The reviewed branch still has no committed diff from main

- Severity: Important
- File/line: repository state
- Problem: `git diff main...codex/apps-sdk-sqlite-agent-testing` is empty because both refs point to the same commit, while the implementation is present as dirty tracked edits and untracked files.
- Why it matters: The requested review scope is the merge diff. As-is, there is nothing for GitHub/CI to merge or review on that branch, and follow-up verification can drift from the working tree I reviewed.
- Reproduction or reasoning: `git rev-parse main` and `git rev-parse codex/apps-sdk-sqlite-agent-testing` both returned `b697c94a0e11fda7deb2479f5ef566ced56381f7`; `git diff --name-status main...codex/apps-sdk-sqlite-agent-testing` returned no files; `git status --short` showed the Apps/SQLite implementation as local changes/untracked files.
- Suggested fix: Commit the intended implementation to `codex/apps-sdk-sqlite-agent-testing` before merge review/CI, after fixing the blockers above.
- Test that should fail before the fix: CI/review automation should reject a "feature branch" whose compare range is empty while required implementation files are untracked or dirty locally.

## Minor Findings

No findings.

## Missing Test Coverage

- AppTester sandbox test proving generated app code cannot read `process.env`, access Node globals, make network calls, or hang the tester.
- SQLite database creation test proving raw `_storage` ids from another workspace cannot be ingested.
- Rendered SQLite finance tracker test that clicks the actual fixture buttons through `@dohc/app` and proves `databaseOps.appApply`/op logs change.
- Per-control AppTester persistence tests where one visible control persists and another visible control is a no-op.
- Hocuspocus semantic-write regression where app-origin writes are denied after a source becomes `userLocked` between Convex preflight and final apply.
- `useDoc`/`dohc.doc` AppTester seed and freshness tests for non-empty source docs.
- Runtime `apps.getSourceFiles` fail-closed behavior when app package loading hits scan caps.
- Live authenticated WorkOS/browser onboarding smoke with the real app tester and SQLite worker, not only deterministic stubs.

## Security Checklist

| Check | Pass/Fail/Unclear | Evidence |
| --- | --- | --- |
| server-derived identity | Pass | App/security/database paths derive identity through Convex auth, for example `appSecurity.ts:46-60`, `databaseFiles.ts:319-346`, and `databaseOps.ts:168-192`. |
| workspace boundary | Fail | `databaseFiles.create` derives workspace but does not prove the supplied `storageId` belongs to that workspace before ingesting it (`databaseFiles.ts:331-346`). |
| manifest max-scope only | Pass | Manifest read/write/database/collection scopes are normalized and checked as ceilings (`appManifest.ts:287-386`, `appScopes.ts:51-67`). |
| per-user trust | Pass | Trust rows are keyed by workspace/user/package and current trust key (`appTrust.ts:16-40`, `appTrust.ts:95-125`). |
| trust resets on manifest write changes | Pass | Trust key includes write scopes, actions, collection write targets, and database write targets (`appManifest.ts:201-237`). |
| source ACLs | Partial | App reads/writes and database reads check source/folder ACLs, but raw storage ingest lacks workspace ownership proof. |
| locks/review gates | Fail | Database row ops now check DB locks/review gates, but app text writes can race because final Hocuspocus ACL treats them as user writes. |
| app iframe isolation | Pass | Runtime iframe uses `sandbox="allow-scripts"` without same-origin and validates `event.source` (`AppRuntimeHost.tsx:772-803`). |
| path traversal rejection | Pass | Database logical paths now reject absolute/traversal/backslash/null/double-slash forms (`databaseSchema.ts:18-34`, `databaseFiles.ts:324-327`, `databaseOps.ts:168-170`). |
| SQLite raw-byte CRDT avoidance | Pass | Raw SQLite bytes are not mirrored into atoms/Y.Doc; structured database state lives in `databaseFiles` and row ops update snapshots/op logs (`schema.ts:400-435`). |

## Persistence And Collaboration Checklist

| Behavior | Pass/Fail/Unclear | Evidence |
| --- | --- | --- |
| Persistent app state goes through docs, collections, or databases | Partial | Runtime RPCs route to Convex/Hocuspocus/database APIs, but the SQLite fixture uses the wrong SDK path and AppTester can approve mixed fake controls. |
| Source-backed collection reads respect source ACLs | Pass | `collectionData` filters via `canReadAtom` and fails closed on source scan overflow (`collectionData.ts:39-76`). |
| Collection mutations use canonical source writes | Pass | Non-SQLite collection mutations plan semantic replacements and write through Hocuspocus (`appData.ts:1193-1305`). |
| Document mutations use canonical source writes | Pass | Doc mutations route through Hocuspocus semantic anchors/replacements (`appData.ts:912-1008`). |
| App writes respect locks/review gates | Fail | Database locks/review gates pass, but app text writes can race past `userLocked` at the Hocuspocus boundary. |
| Collaboration conflicts are detected | Partial | SQLite expected-version conflicts and Hocuspocus stale-intent behavior are tested; app authors can omit database expectedVersion, and text lock races remain. |
| Large scans are complete or fail closed | Partial | App testing/onboarding/index scans improved, but runtime app source loading can still return partial packages. |

## SQLite Checklist

| Behavior | Pass/Fail/Unclear | Evidence |
| --- | --- | --- |
| Real SQLite ingest through worker | Pass | `databaseFiles.create` reads storage bytes and calls `/ingest`; focused tests passed (`databaseFiles.ts:100-148`, `databaseFiles.ts:305-347`). |
| Caller snapshots ignored | Pass | Public `tables` is compatibility-only ignored, and tests prove fake caller snapshots are not stored. |
| Storage blob ownership enforced | Fail | No workspace asset/ownership check exists before `ctx.storage.get(args.storageId)`. |
| Row ops update canonical state | Pass | `databaseOps.applyDatabaseOperation` patches structured snapshots and versions (`databaseOps.ts:43-148`). |
| Operation logs/idempotency | Pass | Operation ids are checked before mutation and logs are inserted on success (`databaseOps.ts:57-76`, `databaseOps.ts:132-146`). |
| Version conflicts | Pass | Direct and app row ops enforce expected versions when supplied (`databaseOps.ts:85-89`, `databaseOps.ts:249-259`). |
| Materialized bytes after row ops | Pass | `databaseFiles.materialize` calls `/materialize` and stores new bytes (`databaseFiles.ts:397-431`); focused tests passed. |
| Database locks/review gates | Pass | `applyDatabaseOperation` blocks `systemLocked`, `userLocked`, and `reviewRequired` before mutation/log append (`databaseOps.ts:77-84`). |
| SQLite generated app runtime persistence | Fail | The SQLite fixture uses plain collection calls, so rendered buttons do not reach `databaseOps.appApply`. |

## App Tester / Generated App Quality Checklist

| Behavior | Pass/Fail/Unclear | Evidence |
| --- | --- | --- |
| Executes rendered app code | Fail | It executes code in Node with `new Function`, not a safe browser sandbox. |
| Clicks visible controls | Partial | It clicks visible buttons, but evaluates persistence only as an aggregate after all clicks (`runAppTest.ts:225-229`, `runAppTest.ts:339-348`). |
| Catches blank renders | Pass | Focused service tests passed for blank render detection. |
| Catches fake buttons | Fail | Mixed real/no-op visible controls returned `ok: true` in my probe. |
| Catches placeholder metrics over real data | Partial | Collection/database row placeholders are checked; doc-backed data is ignored. |
| Captures real screenshots | Partial | Failure screenshots are generated with Playwright from tester-rendered HTML, but not from the actual bundled browser app runtime (`runAppTest.ts:366-391`). |
| Checks persistence across reload/collaboration | Partial | The Playwright smoke covers a stubbed runtime; AppTester itself does not remount/reload per control, and the SQLite fixture runtime path is untested. |
| Onboarding requires current generated app quality | Partial | Source/collection/database digesting improved, but docs are omitted and AppTester can false-positive fake controls. |

## Verification Performed

- Read the required files: `AGENTS.md`, `apps/app/AGENTS.md`, `apps/app/convex/_generated/ai/guidelines.md`, the Apps/SQLite/agent-testing plan, and the execution log including the second-pass remediation section.
- Checked branch state: `git rev-parse main`, `git rev-parse codex/apps-sdk-sqlite-agent-testing`, and `git diff --name-status main...codex/apps-sdk-sqlite-agent-testing`. Result: both refs are `b697c94a0e11fda7deb2479f5ef566ced56381f7`; compare diff is empty.
- Checked working tree: `git status --short`, `git diff --stat`, and `git diff --name-only`. Result: implementation is local dirty/untracked working-tree state; `git diff --stat` only reports tracked edits and omits many untracked implementation files.
- Ran focused app review/security slice:
  `cd apps/app && npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts convex/appReviewFixes.test.ts convex/appSecurity.test.ts convex/appTrust.test.ts convex/appData.collectionMutations.test.ts convex/appData.docMutations.test.ts convex/databaseFiles.test.ts convex/databaseOps.test.ts convex/databaseOps.concurrency.test.ts convex/appTesting.test.ts convex/collectionIndex.test.ts convex/appFinanceTracker.acceptance.test.ts src/apps/AppRuntimeHost.security.test.tsx src/apps/AppRuntimeHost.database.test.ts src/apps/buildAppBundle.test.ts`
  Result: 14 files passed, 55 tests passed.
- Ran focused AppTester/SQLite worker slice:
  `npx -y node@24 node_modules/vitest/vitest.mjs run services/app-tester/src/runAppTest.test.ts services/app-tester/src/runAppTest.browser.test.ts services/app-tester/src/runAppTest.screenshot.test.ts services/sqlite-worker/src/sqliteEngine.test.ts services/sqlite-worker/src/sqliteEngine.concurrency.test.ts services/sqlite-worker/src/sqliteEngine.failureInjection.test.ts`
  Result: 6 files passed, 23 tests passed.
- Ran `git diff --check`. Result: passed.
- Checked CodeRabbit availability: `/home/ice/.local/bin/coderabbit auth status --agent` returned `not_authenticated`; CodeRabbit review was not available.
- Ran an adversarial AppTester mixed-control probe. Result: an app with one persistent `Add expense` button and one no-op `Mark reviewed` button returned `ok: true`.
- Ran an AppTester Node-global probe with `APP_TESTER_PROBE_SECRET=harmless-probe`. Result: an app referencing `globalThis.process?.env` returned `ok: true`, confirming the tester does not reject Node global access.
- I did not rerun the full `apps/app` suite, the Playwright finance smoke, or a live authenticated WorkOS browser smoke in this pass.

## Final Recommendation

Do not merge. Required fixes before merge: sandbox AppTester outside the Node service process, enforce workspace ownership for SQLite upload storage ids, make the SQLite finance tracker fixture use the real database SDK path and test it through rendered runtime clicks, require per-control persistence in AppTester, enforce app-origin lock semantics at the final Hocuspocus write boundary, seed/digest doc sources for `useDoc`, and fail closed for runtime app source loading on scan caps. After those fixes, commit the implementation to the review branch and rerun focused slices plus the full `apps/app` suite and Playwright/runtime smoke.
