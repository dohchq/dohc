# Apps SDK / SQLite / Agent Testing Review

## Verdict

Ready with risks.

The `aca922a` remediation fixes the last blocker I found: app-agent confirmations now display the app, operation, sources, and full prompt that is submitted after confirmation. I rechecked the server-side app-agent authorization, app trust keys, asset scoping, SQLite row operations, AppTester hardening, onboarding gate, and generated finance tracker paths against `main...codex/apps-sdk-sqlite-agent-testing`. Fresh local verification passed across focused slices, the full `apps/app` suite, TypeScript, and the no-secret browser finance smoke. The remaining risk is not a code blocker from this review pass: no live authenticated WorkOS/onboarding/provider smoke was run, and the existing `ANTHROPIC_API_KEY` live-eval path remains skipped.

## Critical Findings

No findings.

## Important Findings

No findings.

## Minor Findings

No findings.

## Missing Test Coverage

- Live authenticated WorkOS/provider onboarding smoke: exercise sign-in, workspace selection, generated app creation, provider-backed app testing, and app launch in a real authenticated browser session.
- Live `ANTHROPIC_API_KEY` eval gate: run the existing live eval path once secrets are available so the expected skip is not the only signal before release.

## Security Checklist

| Check | Pass/Fail/Unclear | Evidence |
|---|---|---|
| server-derived identity | Pass | App-agent authorization derives workspace and identity server-side in `/home/ice/dev/dohc/apps/app/convex/appAgent.ts:58`; app assets do the same in `/home/ice/dev/dohc/apps/app/convex/assets.ts:121`; database ops derive identity in `/home/ice/dev/dohc/apps/app/convex/databaseOps.ts:171`. |
| workspace boundary | Pass | App-agent, asset, app-data, database, and app-testing APIs resolve the active workspace server-side; focused security and full app suites passed. |
| manifest max-scope only | Pass | App-agent capabilities are manifest-gated in `/home/ice/dev/dohc/apps/app/convex/appAgent.ts:65`; source scope is checked in `/home/ice/dev/dohc/apps/app/convex/appAgent.ts:90`; database app writes require declared database write grants in `/home/ice/dev/dohc/apps/app/convex/databaseOps.ts:216`. |
| per-user trust | Pass | App-agent requests require current per-user trust in `/home/ice/dev/dohc/apps/app/convex/appAgent.ts:71`; database writes repeat the trust check in `/home/ice/dev/dohc/apps/app/convex/databaseOps.ts:227`. |
| trust resets on manifest write changes | Pass | Trust keys include write scopes, actions, collection writes, database writes, and agent capabilities in `/home/ice/dev/dohc/apps/app/convex/appManifest.ts:215`. App trust tests passed. |
| source ACLs | Pass | Agent handoff sources require manifest scope and `canReadAtom` in `/home/ice/dev/dohc/apps/app/convex/appAgent.ts:90`; app asset URLs require an app-readable referencing source in `/home/ice/dev/dohc/apps/app/convex/assets.ts:147`. |
| locks/review gates | Pass | Patch proposals reject unwritable/locked sources in `/home/ice/dev/dohc/apps/app/convex/appAgent.ts:176`; database row writes reject locked/review-gated files in `/home/ice/dev/dohc/apps/app/convex/databaseOps.ts:79`. Hocuspocus semantic API tests passed. |
| app iframe isolation | Pass | Runtime messages are checked against the iframe `contentWindow` in `/home/ice/dev/dohc/apps/app/src/apps/AppRuntimeHost.tsx:920`; the iframe uses `sandbox="allow-scripts"` without `allow-same-origin` in `/home/ice/dev/dohc/apps/app/src/apps/AppRuntimeHost.tsx:944`. AppTester browser sandbox tests passed. |
| path traversal rejection | Pass | Database paths are normalized and rejected before ACL checks in `/home/ice/dev/dohc/apps/app/convex/databaseOps.ts:38`; focused database/path tests passed. |
| SQLite raw-byte CRDT avoidance | Pass | SQLite tests verify server/worker ingest and materialization, structured row state, and no raw-byte atom/Y.Doc mirroring. |
| app-agent confirmation integrity | Pass | `/home/ice/dev/dohc/apps/app/src/apps/AppRuntimeHost.tsx:107` builds full confirmation text; `/home/ice/dev/dohc/apps/app/src/apps/AppRuntimeHost.tsx:185` displays it with preserved whitespace; `/home/ice/dev/dohc/apps/app/src/apps/AppRuntimeHost.tsx:466` reauthorizes before submitting. Long-tail agent and patch tests in `/home/ice/dev/dohc/apps/app/src/apps/AppRuntimeHost.agent.test.tsx:120` and `/home/ice/dev/dohc/apps/app/src/apps/AppRuntimeHost.agent.test.tsx:152` passed. |

## Persistence And Collaboration Checklist

| Behavior | Pass/Fail/Unclear | Evidence |
|---|---|---|
| persistent app state goes through docs/collections/databases | Pass | AppTester rejects local-only controls, and the Playwright finance smoke passed across reload/collaboration boundaries. |
| source-backed collection reads respect ACL/workspace | Pass | App data/security tests passed, including manifest ceiling plus source ACL checks and scan-cap fail-closed behavior. |
| collection mutations use canonical source writes | Pass | Collection mutation tests cover Hocuspocus semantic writes and provenance rather than local state or raw markdown-cache patching. |
| document mutations use canonical source writes | Pass | Document mutation tests cover Hocuspocus semantic replacement. |
| app writes respect user locks/review gates | Pass | Database and Hocuspocus semantic regression tests passed, including app-origin `actorKind: "app"` lock behavior. |
| stale test results invalidated by source-backed seed changes | Pass | App-test freshness includes source-backed docs, collections, and databases; onboarding/app-testing tests passed. |
| large source scans fail closed | Pass | Descriptor, collection index, app data, app trust, and database file capped-scan tests passed. |

## SQLite Checklist

| Behavior | Pass/Fail/Unclear | Evidence |
|---|---|---|
| real SQLite ingest through worker | Pass | `databaseFiles` tests verify worker-derived tables and ignore caller-supplied snapshots. |
| storage ownership checked before ingest | Pass | Database file tests cover rejection of storage blobs outside the caller workspace. |
| app SQLite writes use database/table SDK path | Pass | Finance acceptance tests use `dohc.database(path).table(name)`, and `databaseOps.appApply` validates database/table access in `/home/ice/dev/dohc/apps/app/convex/databaseOps.ts:196`. |
| row operations and materialized bytes | Pass | SQLite worker engine, concurrency, and failure-injection tests passed. |
| operation logs | Pass | `databaseOps` records operation rows in `/home/ice/dev/dohc/apps/app/convex/databaseOps.ts:135`; operation-log tests passed. |
| version conflicts | Pass | `applyDatabaseOperation` rejects stale versions in `/home/ice/dev/dohc/apps/app/convex/databaseOps.ts:85`; concurrency tests passed. |
| locks/review gates | Pass | Locked/review-gated databases are rejected before app row mutations in `/home/ice/dev/dohc/apps/app/convex/databaseOps.ts:79`; database op tests passed. |
| raw bytes not CRDT-synced | Pass | Database op tests verify structured snapshots are canonical and raw SQLite bytes are not synced through atoms/Y.Doc. |

## App Tester / Generated App Quality Checklist

| Behavior | Pass/Fail/Unclear | Evidence |
|---|---|---|
| executes rendered app code | Pass | AppTester browser tests execute code in Playwright and catch syntax/runtime failures. |
| clicks visible controls | Pass | `runAppTest` tracks visible control results and requires SDK writes plus state changes. |
| fake/no-op buttons rejected | Pass | Browser tests reject dead-code persistence writes and hidden/no-op primary buttons. |
| manifest-declared workflows enforced | Pass | Onboarding and direct adversarial coverage reject missing manifest-declared finance controls. |
| blank renders rejected | Pass | Browser render and screenshot artifact tests passed. |
| placeholder metrics rejected | Pass | Onboarding generated-app quality tests reject placeholder metrics over real source data. |
| real screenshots captured | Pass | Screenshot artifact test passed and returns a PNG artifact on render failure. |
| persistence across reload/collaboration | Pass | Playwright no-secret finance smoke passed. |
| onboarding gate prevents incomplete declared finance workflows | Pass | `onboardingGeneratedAppQuality.test.ts` passed, including missing declared workflow coverage. |

## Verification Performed

- Read required context: `/home/ice/dev/dohc/AGENTS.md`, `/home/ice/dev/dohc/apps/app/AGENTS.md`, `/home/ice/dev/dohc/apps/app/convex/_generated/ai/guidelines.md`, `/home/ice/dev/dohc/docs/superpowers/plans/2026-06-06-dohc-apps-sdk-sqlite-and-agent-testing.md`, and `/home/ice/dev/dohc/docs/superpowers/plans/2026-06-06-dohc-apps-sdk-sqlite-and-agent-testing.execution-log.md`.
- Inspected `git diff main...codex/apps-sdk-sqlite-agent-testing`; branch head was `aca922af7b5821ddcbc0da40e66fe6e96a3c3803`.
- Inspected `aca922a Show full app agent confirmation payload`, including `/home/ice/dev/dohc/apps/app/src/apps/AppRuntimeHost.tsx` and `/home/ice/dev/dohc/apps/app/src/apps/AppRuntimeHost.agent.test.tsx`.
- Inspected app/security surfaces including `/home/ice/dev/dohc/apps/app/convex/appAgent.ts`, `/home/ice/dev/dohc/apps/app/convex/appManifest.ts`, `/home/ice/dev/dohc/apps/app/convex/appTrust.ts`, `/home/ice/dev/dohc/apps/app/convex/assets.ts`, `/home/ice/dev/dohc/apps/app/convex/databaseOps.ts`, `/home/ice/dev/dohc/apps/app/src/routes/_app.tsx`, and `/home/ice/dev/dohc/apps/app/src/components/ViewFrame.tsx`.
- Checked CodeRabbit CLI availability. `coderabbit --version` returned `0.5.3`, but `coderabbit auth status --agent` returned unauthenticated. `coderabbit auth login --agent` required browser authentication, so I stopped the pending auth helper and did not run CodeRabbit review.
- Ran focused runtime/app-agent/assets slice: `5 files passed`, `18 tests passed`.
- Ran service/AppTester/SQLite/Hocuspocus slice: `7 files passed`, `46 tests passed`.
- Ran full `/home/ice/dev/dohc/apps/app` Vitest suite: `183 files passed`, `1561 tests passed`, `1 skipped` for the existing `ANTHROPIC_API_KEY` live-eval gate.
- Ran TypeScript checks for `/home/ice/dev/dohc/apps/app`, `/home/ice/dev/dohc/services/app-tester`, `/home/ice/dev/dohc/services/hocuspocus`, and `/home/ice/dev/dohc/services/sqlite-worker`: all exited `0`.
- Ran `git diff --check main...codex/apps-sdk-sqlite-agent-testing`: no whitespace errors.
- Ran no-secret Playwright finance app runtime smoke: `1 passed`, covering persistence across reload/collaboration boundaries.
- I did not run a live authenticated WorkOS/onboarding/provider smoke because it requires external authenticated environment/secrets.

## Final Recommendation

No code fixes are required before merge from this review pass. Merge with the explicit release risk that a live authenticated WorkOS/onboarding/provider smoke and the `ANTHROPIC_API_KEY` live eval still need to run before launch. Keep the new adversarial app-agent confirmation tests in place; they are the guardrail that proved the final blocker was actually closed.
