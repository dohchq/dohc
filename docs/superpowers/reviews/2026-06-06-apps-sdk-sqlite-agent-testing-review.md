# Apps SDK / SQLite / Agent Testing Review

## Verdict

Block merge.

The fourth-pass fixes for manifest-declared tests, descriptor scan truncation, and stale "views" product language are real: I verified the direct adversarial manifest probe now fails closed, the focused service/app slices pass, and the full `apps/app` suite passes. The remaining blocker is a different high-risk app boundary: `dohc.agent.run` and `dohc.patch.propose` let untrusted app code auto-submit prompts into the user's agent context without server-side app authorization, manifest-agent enforcement, per-user trust, or a host confirmation gate. That gives a read-only app a confused-deputy path to ask the agent to read or mutate workspace state outside the app's declared scopes. I also found an asset URL resolution gap where app code can resolve any same-workspace asset ID it knows, without manifest/source binding.

## Critical Findings

### App-origin agent handoffs auto-run with user authority and no app authorization gate

- Severity: Critical
- File/line: `/home/ice/dev/dohc/apps/app/src/apps/AppRuntimeHost.tsx:707`, `/home/ice/dev/dohc/apps/app/src/apps/AppRuntimeHost.tsx:718`, `/home/ice/dev/dohc/apps/app/src/routes/_app.tsx:1410`, `/home/ice/dev/dohc/apps/app/src/components/Chat.tsx:258`, `/home/ice/dev/dohc/apps/app/src/components/Chat.tsx:954`, `/home/ice/dev/dohc/apps/app/convex/appManifest.ts:275`
- Problem: The runtime accepts `dohc.agent.run` from the sandboxed app, calls `onRunAgent` directly, stores the app-provided prompt as `pendingPrompt`, navigates to chat, and `Chat` auto-submits that pending prompt when the thread is available. `dohc.patch.propose` follows the same auto-submitted agent path after only a client-side write-scope check. The parsed manifest `agent` capability is not enforced, no per-user app trust key is required, and no server-side app authorization or host confirmation happens before the agent turn starts.
- Why it matters: This lets a malicious or compromised app that otherwise has no write trust cause an agent run under the user's normal workspace authority. The app cannot directly read outside its manifest, but it can prompt the agent to read, summarize, edit, export, or otherwise act on sources outside the app's declared scopes. That violates the core boundary that browser/app callers are not trusted to provide permissions and that app-origin actions must remain constrained by app trust, manifest ceilings, ownership, sharing, locks, and review gates.
- Reproduction or reasoning: A mounted app can run `dohc.agent.run({ prompt: 'Read private files and update the workspace...', sources: ['private/notes.md'] })` from `useEffect` or a button. `parseAppRpcRequest` only validates the payload shape, `AppRuntimeHost` forwards it through `onRunAgent`, `_app.tsx` turns it into `pendingPrompt`, and `runPendingPromptHandoff` calls `submit(pendingPrompt)` automatically. There is no Convex app-security check in that path, and `appManifest.agent` is parsed but not used as an authorization gate.
- Suggested fix: Treat app-origin agent handoffs as privileged app actions. Require an explicit manifest agent capability, include those capabilities in the per-user trust key, create/authorize the request server-side with `packageRoot`, user, workspace, and current manifest write/agent key, and show a host confirmation dialog before submitting any agent prompt. The agent runtime should receive structured `originatingApp` metadata and either enforce app max scopes for source context or require explicit user confirmation before using sources/actions outside those scopes. `patch.propose` should use the same server-backed/confirmed path instead of client-only scope checks plus auto-submit.
- Test that should fail before the fix: Render a read-only app with no trusted write or agent capability whose mount effect calls `dohc.agent.run` with an out-of-scope source. Assert no chat `submit` occurs, the host returns `app-agent-not-authorized` or `app-agent-confirmation-required`, and no agent message is created until the user explicitly confirms an authorized app-agent request. Add the same negative test for `dohc.patch.propose`.

## Important Findings

### App asset resolution is workspace-wide instead of manifest/source-scoped

- Severity: Important
- File/line: `/home/ice/dev/dohc/apps/app/src/apps/AppRuntimeHost.tsx:672`, `/home/ice/dev/dohc/apps/app/convex/assets.ts:75`, `/home/ice/dev/dohc/apps/app/convex/appManifest.ts:23`
- Problem: `dohc.asset(assetId).resolve()` forwards any app-provided asset id to `api.assets.resolveAsset`. That server query checks only that the asset belongs to the active workspace, then returns a storage URL. App manifests do not declare asset read scopes, and the runtime does not prove the asset is referenced by a source the app is allowed to read.
- Why it matters: In a shared workspace, an app that learns or hardcodes a workspace asset id can mint a URL for that asset even if the asset belongs to a private chat attachment or source outside the app's manifest/read scope. Workspace boundary is necessary but not sufficient for app sandboxing when app reads are supposed to be source-scoped.
- Reproduction or reasoning: The runtime case for `dohc.asset.resolve` passes only `assetId` plus workspace args. `assets.resolveAsset` checks `asset.workspaceId === workspaceId` and returns `url`; there is no `packageRoot`, manifest check, source ACL check, or source-reference proof.
- Suggested fix: Make asset resolution app-aware. Require `packageRoot` plus a source path or manifest-declared asset scope, verify the app can read the source that references the asset, and only then return a URL. For standalone assets, add explicit manifest asset scopes that are treated as ceilings and still require user/source ACLs.
- Test that should fail before the fix: Create two assets in the same workspace, reference only one from an app-readable source, then call app asset resolve for both. The referenced asset should resolve; the unreferenced/private asset should return an authorization error.

## Minor Findings

No findings.

## Missing Test Coverage

- App-origin `dohc.agent.run` must have negative tests for read-only apps, untrusted apps, undeclared manifest agent capabilities, out-of-scope sources, mount-time auto-runs, and confirmation cancellation.
- `dohc.patch.propose` needs the same server-backed authorization and confirmation tests as agent handoff, including out-of-scope and untrusted app cases.
- App asset resolution needs tests proving a valid same-workspace asset id is not enough; the asset must be tied to an app-readable source or explicit app asset scope.
- AppTester should add coverage for intentional `dohc.agent.run` controls once the agent handoff permission model is fixed; today persistence checks mostly cover doc/collection/database writes.
- A live authenticated WorkOS/onboarding/provider smoke remains unrun locally.

## Security Checklist

| Check | Pass/Fail/Unclear | Evidence |
|---|---|---|
| server-derived identity | Partial | Convex doc/collection/database APIs derive identity server-side, but app-origin `dohc.agent.run`/`patch.propose` bypass Convex app-security checks and auto-submit a prompt through the user's chat context. |
| workspace boundary | Pass | Database files, app data, app testing, and asset resolution derive the active workspace server-side; focused security tests passed. |
| manifest max-scope only | Fail | App data/database calls enforce manifest ceilings, but app-origin agent handoffs can ask the agent to operate outside app scopes without manifest-agent enforcement or trust. |
| per-user trust | Fail | Collection/doc/database writes require trust; app-origin agent handoffs do not require per-user app trust even though they can trigger agent-mediated workspace changes. |
| trust resets on manifest write changes | Pass | Write trust key derivation and app trust tests pass for declared write scopes/actions/databases. Agent capabilities are not currently included in the enforced trust model. |
| source ACLs | Partial | Direct app source reads/writes check ACLs. Agent handoff sources are app-provided prompt text and are not checked against app manifest/source ACLs before auto-submit. |
| locks/review gates | Partial | Direct app writes and Hocuspocus app-origin writes respect locks/review gates. Agent-mediated actions rely on normal agent gates after an untrusted app has already started the run. |
| app iframe isolation | Pass | Runtime iframe uses `sandbox="allow-scripts"` with source-gated `postMessage`; AppTester runs app code in a Playwright sandbox with Node/network probes blocked. |
| path traversal rejection | Pass | Runtime SDK and database APIs reject unsafe paths; focused path tests passed. |
| SQLite raw-byte CRDT avoidance | Pass | SQLite bytes are worker-ingested/materialized and not synced through Y.Doc. |

## Persistence And Collaboration Checklist

| Behavior | Pass/Fail/Unclear | Evidence |
|---|---|---|
| persistent app state goes through docs/collections/databases | Pass | Runtime writes route through appData/databaseOps, and the Playwright finance smoke proved reload/collaboration persistence. |
| source-backed collection reads respect ACL/workspace | Pass | App data and collection tests cover source ACLs and workspace scoping. |
| collection mutations use canonical source writes | Pass | Collection mutations flow through Hocuspocus semantic writes with `actorKind: "app"`. |
| document mutations use canonical source writes | Pass | Doc mutations call Hocuspocus semantic APIs instead of local state/raw body patching. |
| app writes respect user locks/review gates | Pass for direct writes | Direct database/doc/collection app writes are blocked by locks/review gates. App-triggered agent runs remain a separate unresolved boundary. |
| stale test results invalidated by source-backed seed changes | Pass | App-test freshness includes seeded docs, collections, and databases. |
| large source scans fail closed | Pass for descriptor/security paths | Fourth-pass tests cover `apps.get`, `appTrust.state`, `appData.getAtom`, and `databaseFiles.appQuery` fail-closed behavior on capped scans. |

## SQLite Checklist

| Behavior | Pass/Fail/Unclear | Evidence |
|---|---|---|
| real SQLite ingest through worker | Pass | `databaseFiles` calls worker ingest and tests verify caller snapshots are ignored. |
| storage ownership checked before ingest | Pass | `_authorizeStorageForCreate` validates workspace storage ownership before byte fetch. |
| app SQLite writes use database/table SDK path | Pass | `databaseOps.appApply` requires database authorization and the finance fixture uses `dohc.database('ledger.sqlite').table('transactions')`. |
| row operations and materialized bytes | Pass | SQLite worker tests passed, including engine, concurrency, and failure-injection coverage. |
| operation logs | Pass | `databaseOps` persists operation records and focused database op tests passed. |
| version conflicts | Pass | `applyDatabaseOperation` enforces expected version and row conflict checks; concurrency tests passed. |
| locks/review gates | Pass | `appApply` checks database lock/review state and source ACLs before writes. |
| raw bytes not CRDT-synced | Pass | Raw SQLite snapshots from app/browser are ignored; worker-owned bytes are stored/materialized server-side. |

## App Tester / Generated App Quality Checklist

| Behavior | Pass/Fail/Unclear | Evidence |
|---|---|---|
| executes rendered app code | Pass | AppTester runs app code in a Playwright page sandbox; direct probes and service tests caught Node globals, network, and hangs. |
| clicks visible controls | Pass | AppTester records visible controls and requires each persistent control to produce SDK writes/state changes. |
| fake/no-op buttons rejected | Pass | Mixed real/no-op controls fail with `control-missing-persistence`; focused tests passed. |
| manifest-declared workflows enforced | Pass | The direct incomplete finance probe now fails with `manifest-test-missing-control`; onboarding regression tests passed. |
| blank renders rejected | Pass | Browser render checks and screenshot tests passed. |
| placeholder metrics rejected | Pass for covered fixtures | Generated app quality tests reject placeholder metrics over seeded source data. |
| real screenshots captured | Pass | Screenshot artifact test passed. |
| persistence across reload/collaboration | Pass | No-secret Playwright finance app runtime smoke passed across reload/collaboration boundaries. |
| onboarding gate prevents incomplete declared finance workflows | Pass | Fourth-pass onboarding generated-app quality tests cover missing manifest workflows. |

## Verification Performed

- Read required project/review context: `/home/ice/dev/dohc/AGENTS.md`, `/home/ice/dev/dohc/apps/app/AGENTS.md`, `/home/ice/dev/dohc/apps/app/convex/_generated/ai/guidelines.md`, the implementation plan, and the updated execution log through the fourth-pass remediation section.
- Inspected `git diff main...codex/apps-sdk-sqlite-agent-testing`; branch head was `3fd22d6878d27eeffd8c4567cc2a04c773098772`.
- Inspected the fourth-pass commit `3fd22d6 Fix apps rereview blockers`.
- Ran direct adversarial manifest probe: failed closed with `manifest-test-missing-control`.
- Ran focused service/AppTester/SQLite/Hocuspocus slice: `7 files passed`, `46 tests passed`.
- Ran focused app/security review slice under `apps/app`: `22 files passed`, `124 tests passed`.
- Ran TypeScript checks for `apps/app`, `services/app-tester`, `services/hocuspocus`, and `services/sqlite-worker`: all exited `0`.
- Ran `git diff --check main...codex/apps-sdk-sqlite-agent-testing`: no whitespace errors.
- Ran full `apps/app` Vitest suite: `181 files passed`, `1552 tests passed`, `1 skipped` for the existing `ANTHROPIC_API_KEY` live-eval gate.
- Ran no-secret Playwright finance runtime smoke: `1 passed`, covering finance app persistence across reload/collaboration boundaries.
- I did not run a live authenticated WorkOS/onboarding/provider smoke because it requires external authenticated environment/secrets.

## Final Recommendation

Do not merge until app-origin agent handoffs are moved behind a real authorization and confirmation boundary. The exact required fixes are: enforce manifest-declared agent capabilities, include agent/patch capabilities in per-user trust, authorize app-agent requests server-side, prevent automatic chat submission from untrusted app RPCs, and ensure agent source/action scope cannot exceed the app's declared ceilings without explicit user confirmation. Also make asset resolution app/source-scoped instead of workspace-wide by asset id. After those land, rerun the direct adversarial app-agent probe, focused app/security slice, service slice, TypeScript checks, full `apps/app` suite, `git diff --check`, and the Playwright finance smoke; schedule the remaining live authenticated WorkOS/onboarding/provider smoke before release.
