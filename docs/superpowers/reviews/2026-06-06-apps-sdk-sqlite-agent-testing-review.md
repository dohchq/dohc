# Apps SDK / SQLite / Agent Testing Review

## Verdict

Block merge.

The third-pass fixes close the major security and persistence blockers from the prior review: SQLite ingest is now worker-backed, app-origin semantic writes use `actorKind: "app"`, storage ownership is checked before SQLite ingest, AppTester executes code in a Playwright browser sandbox, and the focused/full test suites I ran pass. The remaining blocker is narrower but still release-critical: manifest-declared app tests are accepted without being executed, so an incomplete generated app can pass AppTester and the onboarding quality gate as long as it has one real persistent control. There is also a remaining fail-open risk in app descriptor resolution on large workspace scans, separate from the fixed `getSourceFiles` and app-test source loading paths.

## Critical Findings

### Manifest-declared app tests are ignored, so incomplete apps can pass

- Severity: Critical
- File/line: `/home/ice/dev/dohc/services/app-tester/src/runAppTest.ts:715`, `/home/ice/dev/dohc/services/app-tester/src/runAppTest.ts:733`, `/home/ice/dev/dohc/apps/app/convex/onboarding.ts:284`
- Problem: `checkManifestTests` returns success unconditionally. `runAppTest` includes this as the `manifest tests` check, and onboarding accepts the latest app-test result when `result.ok` is true and the digest is fresh. The manifest's declared tests are therefore not converted into required controls, required SDK writes, expected state changes, or fixture-specific workflow assertions.
- Why it matters: The implementation claims AppTester can prevent false-positive generated app quality. In practice, an app can declare workflows such as "add expense", "categorize transaction", and "mark reviewed", implement only the first workflow, and still pass. That can let onboarding complete with an incomplete app that appears tested but does not perform the promised persistent workflows.
- Reproduction or reasoning: I ran an adversarial `runAppTest` probe with a manifest containing three tests for add/categorize/mark-reviewed behavior and app code containing only one visible `Add expense` button that performs a real collection insert. The result was `ok: true`; all checks, including `manifest tests`, passed. The no-op implementation is visible in `checkManifestTests`, which currently returns `{ ok: true }` without inspecting `tests`.
- Suggested fix: Make manifest tests executable or fail closed. Each declared test should bind to a visible control or interaction target, click it in the browser sandbox, require the expected SDK write target (`doc`, `collection`, or `database`), and verify the expected state/data delta. If the manifest test schema is too free-form to enforce, formalize it before using it as a quality gate and fail manifests with unenforceable tests.
- Test that should fail before the fix: Add a test where the finance fixture manifest declares add/categorize/mark-reviewed workflows, but the rendered app only implements `Add expense`. Expected result: `runAppTest` returns `ok: false` with a failure such as `manifest-test-missing-control` or `manifest-test-missing-persistence`, and onboarding refuses the app.

## Important Findings

### App descriptor resolution can still proceed from partial package scans

- Severity: Important
- File/line: `/home/ice/dev/dohc/apps/app/convex/apps.ts:329`, `/home/ice/dev/dohc/apps/app/convex/apps.ts:449`, `/home/ice/dev/dohc/apps/app/convex/appSecurity.ts:46`
- Problem: `getSourceFiles` and app testing now fail closed when source scans are capped, but `resolveAppDescriptor` still calls `visibleAtomsForPackage`, which logs/truncates after the workspace scan cap and returns whatever it found. Security helpers then derive descriptors from that partial result.
- Why it matters: If a workspace has more than the scan cap and `app.json` is outside the scanned window while another source file is inside it, descriptor resolution can build from incomplete package state. That can affect app trust state, manifest-derived maximum scopes, and direct app data/database APIs even if bundle source loading fails closed elsewhere.
- Reproduction or reasoning: `visibleAtomsForPackage` still returns an atom list after a capped scan instead of an error. `resolveAppDescriptor` uses that list to find the manifest/source files, and `appSecurity` consumes the resolved descriptor as authoritative. The third-pass fix covers `getSourceFiles` at `/home/ice/dev/dohc/apps/app/convex/apps.ts:506`, but not this descriptor/security path.
- Suggested fix: Make descriptor resolution fail closed on capped scans, or replace the scan with an indexed package/prefix query that cannot truncate silently. Propagate a typed `source-scan-truncated` error through app trust, app data, and app database API entry points.
- Test that should fail before the fix: Seed a workspace where an app package has a source file visible before the scan cap and `app.json` after the cap. Calls through `apps.get`, `appTrust.state`, `appData.getAtom`, and `databaseFiles.appQuery` should fail with a scan-truncated error instead of resolving a partial/default descriptor.

### Agent prompt still uses legacy "views" as creation language

- Severity: Important
- File/line: `/home/ice/dev/dohc/apps/app/convex/agent.ts:251`, `/home/ice/dev/dohc/apps/app/convex/agent.ts:831`, `/home/ice/dev/dohc/apps/app/convex/agent.ts:1007`, `/home/ice/dev/dohc/apps/app/convex/agent.ts:4696`
- Problem: The system prompt still tells agents to create and reason about "views", "source-backed html views", and "files/views" in normal product-generation language. Bundle validation now uses first-class app wording, but the generation prompt can still steer agents toward stale terminology and artifact concepts.
- Why it matters: The migration requirement is that `.views` / `@dohc/view` remain compatibility language only, not product language. Leaving the main agent prompt on "views" risks future generated apps, documentation, and user-facing agent output drifting back to the old model.
- Reproduction or reasoning: `agent.ts` contains repeated non-compatibility usages such as "create new files/views", "Source and view must agree", and "Source-backed HTML views". These are not limited to migration compatibility.
- Suggested fix: Replace general prompt language with "apps", "HTML reports", "read-only surfaces", or "operating surfaces" as appropriate. Keep `.views` and `@dohc/view` only in explicit migration/legacy compatibility text.
- Test that should fail before the fix: Add a prompt regression test that rejects non-compatibility occurrences of "views", "HTML views", `.views`, and `@dohc/view` in the agent system prompt and generated-app guidance.

## Minor Findings

No findings.

## Missing Test Coverage

- Manifest tests are not covered as executable workflow requirements; an app with missing declared workflows should fail AppTester and onboarding.
- App descriptor/security APIs need capped-scan fail-closed tests for `apps.get`, `appTrust.state`, `appData` entry points, and `databaseFiles` app APIs.
- AppTester should include at least one end-to-end test that runs a built app bundle through the real app shell/SDK bridge, not only the test harness bridge.
- Generated app quality checks should prove that hardcoded but plausible non-placeholder metrics cannot pass when they do not match seeded docs/collections/databases.
- A live authenticated WorkOS/onboarding/provider smoke remains unrun locally; this is the remaining environment-dependent release risk called out by the implementation team.

## Security Checklist

| Check | Pass/Fail/Unclear | Evidence |
|---|---|---|
| server-derived identity | Pass | Convex entry points derive identity/workspace server-side; app/browser RPC args reject spoofed workspace identity in `/home/ice/dev/dohc/apps/app/src/apps/sdkProtocol.ts`, and database creation/app ops use server context in `/home/ice/dev/dohc/apps/app/convex/databaseFiles.ts` and `/home/ice/dev/dohc/apps/app/convex/databaseOps.ts`. |
| workspace boundary | Pass | Database files, app data, storage ingest, and app testing resolve workspace from authenticated context and check workspace-scoped records. |
| manifest max-scope only | Partial | App data/database calls enforce manifest scopes plus ACL/trust, but descriptor resolution can still be based on a partial package scan on large workspaces. |
| per-user trust | Pass | App trust is keyed per user and manifest write key; focused app trust/security tests passed. |
| trust resets on manifest write changes | Pass | Freshness/trust behavior is covered by app trust tests and manifest write-key derivation. |
| source ACLs | Pass | Doc, collection, and database reads/writes call server-side authorization helpers; storage ownership is now checked before SQLite ingest. |
| locks/review gates | Pass | Database ops enforce lock/review gates, and app-origin Hocuspocus semantic writes use `actorKind: "app"` so user locks block app writes. |
| app iframe isolation | Pass | Runtime iframe uses `sandbox="allow-scripts"` with `srcDoc`, no same-origin, no referrer, source-gated `postMessage`, and shell CSP. AppTester now runs untrusted code in a Playwright browser sandbox. |
| path traversal rejection | Pass | Runtime SDK and database APIs normalize/reject unsafe paths; SQLite fixture now uses `dohc.database(path).table(name)`. |
| SQLite raw-byte CRDT avoidance | Pass | Browser/app snapshots are ignored for ingest; worker materializes SQLite bytes and raw database bytes are not synced through Y.Doc. |

## Persistence And Collaboration Checklist

| Behavior | Pass/Fail/Unclear | Evidence |
|---|---|---|
| persistent app state goes through docs/collections/databases | Partial | Runtime/database paths persist through server APIs and the Playwright finance smoke proved reload/collaboration persistence, but AppTester can still pass missing manifest workflows. |
| source-backed collection reads respect ACL/workspace | Pass | App data collection reads resolve source-backed data server-side and focused security tests passed. |
| collection mutations use canonical source writes | Pass | Collection mutations flow through Hocuspocus semantic writes with app actor context; SQLite collections are rejected from plain `dohc.collection` mutations. |
| document mutations use canonical source writes | Pass | App doc mutations call semantic Hocuspocus APIs instead of client-local state. |
| app writes respect user locks/review gates | Pass | Third-pass change to `actorKind: "app"` makes user locks apply; focused Hocuspocus regression tests passed. |
| stale test results invalidated by source-backed seed changes | Pass | App-test freshness digest includes seeded docs, collections, and databases. |
| large source scans fail closed | Partial | App testing, collection indexing, and `getSourceFiles` fail closed, but descriptor/security resolution can still use partial scan results. |

## SQLite Checklist

| Behavior | Pass/Fail/Unclear | Evidence |
|---|---|---|
| real SQLite ingest through worker | Pass | `databaseFiles` calls worker ingest and tests verify browser/app snapshots are ignored. |
| storage ownership checked before ingest | Pass | `_authorizeStorageForCreate` validates workspace storage ownership before byte fetch. |
| app SQLite writes use database/table SDK path | Pass | `databaseOps.appApply` requires database authorization and the finance fixture uses `dohc.database('ledger.sqlite').table('transactions')`. |
| row operations and materialized bytes | Pass | SQLite worker focused tests passed, including engine and failure-injection coverage. |
| operation logs | Pass | `databaseOps` persists operation records and focused database op tests passed. |
| version conflicts | Pass | `applyDatabaseOperation` enforces expected version and row conflict checks; concurrency tests passed. |
| locks/review gates | Pass | `appApply` checks database lock/review state and source ACLs before writes. |
| raw bytes not CRDT-synced | Pass | Raw SQLite snapshots from app/browser are ignored; worker-owned bytes are stored/materialized server-side. |

## App Tester / Generated App Quality Checklist

| Behavior | Pass/Fail/Unclear | Evidence |
|---|---|---|
| executes rendered app code | Pass | AppTester now runs app code in a Playwright page sandbox; direct probes caught `process`, network, and infinite-loop attempts. |
| clicks visible controls | Pass | AppTester records visible primary controls and requires each clicked control to produce persistent SDK writes and UI state changes. |
| fake/no-op buttons rejected | Pass | A probe with one real button and one no-op visible button failed with `control-missing-persistence`. |
| manifest-declared workflows enforced | Fail | `checkManifestTests` returns success unconditionally; an incomplete finance-style app with only one implemented workflow passed. |
| blank renders rejected | Pass | Browser render and screenshot checks are covered by focused AppTester tests. |
| placeholder metrics rejected | Partial | Existing checks catch obvious placeholder text/empty data, but I did not find proof that plausible hardcoded metrics unrelated to seed data are rejected. |
| real screenshots captured | Pass | AppTester screenshot tests passed and browser sandbox returns rendered screenshots. |
| persistence across reload/collaboration | Pass | No-secret Playwright finance app runtime smoke passed across reload/collaboration boundaries. |
| onboarding gate prevents false-positive generated apps | Fail | Onboarding trusts `result.ok`; because manifest tests are no-op, incomplete declared workflows can still pass the gate. |

## Verification Performed

- Read required project/review context: `/home/ice/dev/dohc/AGENTS.md`, `/home/ice/dev/dohc/apps/app/AGENTS.md`, `/home/ice/dev/dohc/apps/app/convex/_generated/ai/guidelines.md`, the implementation plan, and the execution log including the third-pass remediation section.
- Inspected `git diff main...codex/apps-sdk-sqlite-agent-testing`; branch head was `367fdd4e13b1d405ccaebc429daa16ae4c436b28`.
- Ran direct AppTester adversarial probes:
  - Node `process` global access: failed with sandbox violation.
  - Browser network/fetch access: failed with sandbox violation.
  - No-op visible control: failed with `control-missing-persistence`.
  - Infinite loop: failed with `sandbox-timeout`.
  - Manifest tests ignored probe: unexpectedly passed with `ok: true`.
- Ran focused service/AppTester/SQLite/Hocuspocus slice: `7 files passed`, `44 tests passed`.
- Ran focused app/security review slice under `apps/app`: `17 files passed`, `80 tests passed`.
- Ran TypeScript checks for `apps/app`, `services/app-tester`, `services/hocuspocus`, and `services/sqlite-worker`: all exited `0`.
- Ran full `apps/app` Vitest suite: `181 files passed`, `1546 tests passed`, `1 skipped` for the existing `ANTHROPIC_API_KEY` live-eval gate.
- Ran no-secret Playwright finance runtime smoke: `1 passed`, covering finance app persistence across reload/collaboration boundaries.
- Ran `git diff --check main...codex/apps-sdk-sqlite-agent-testing`: no whitespace errors.
- I did not run a live authenticated WorkOS/onboarding/provider smoke because it requires external authenticated environment/secrets.

## Final Recommendation

Do not merge until manifest tests are real executable quality gates and descriptor resolution fails closed on capped scans. The exact required fixes are: implement/fail-closed manifest test enforcement in AppTester and onboarding, add negative tests for incomplete declared finance workflows, make app descriptor/security resolution reject scan truncation everywhere, and remove non-compatibility "views" language from the agent prompt with a regression test. After those land, rerun the focused adversarial probes, focused app/security slice, full `apps/app` suite, TypeScript checks, `git diff --check`, and the Playwright finance smoke; schedule the remaining live authenticated onboarding/provider smoke before release.
