# Convex deletion review — ported test map + pre-deletion gate (Phase 13)

This is the gate for deleting Convex. Convex is removed ONLY after every
important Convex-era behavior has a passing replacement test in the local-first
stack (desktop + workspace packages + Postgres services). "Do not delete product
behavior; delete only after replacement tests exist."

## Status of prerequisites

- Step 2 baseline (`pnpm check:desktop-local-first-baseline`): **PASS** (EXIT 0).
  All 14 packages green; `@dohc/web test` carries 5 recorded known-fail
  Convex-era tests (tolerated baseline); `check:debt` green.
- Step 2.5 cross-model pre-deletion audit: **launched** (codex gpt-5.5 xhigh,
  read-only) — see Resume Snapshot. Step 3 (deletion) MUST NOT begin while it is
  in flight.

## Ported test map (Convex-era behavior → local-first replacement)

| Convex-era behavior | Replacement package / test | Status |
|---|---|---|
| atom create / read / write | `@dohc/workspace-core` (paths, assets), `@dohc/workspace-postgres` repositories, `@dohc/workspace-sync` mergeSync | pass |
| workspace identity / registry | desktop `registryStore.test`, `createWorkspaceFolder.test` | pass |
| authz boundaries (member/owner/share) | `@dohc/workspace-api` session/actor + `@dohc/hocuspocus` `postgres-acl.test` (member/owner/share/lock) | pass |
| auth / login (WorkOS via Convex) | Better Auth (`@dohc/workspace-api` `betterAuth.test`) + desktop device-flow `cloudLogin.test` + `cloudLogin.spec` E2E | pass |
| cloud sync (push/pull, conflicts) | `@dohc/workspace-sync` `cloudSync.test` + `mergeSync.test` + desktop `cloudSyncEngine.test` + `cloudSync.spec` E2E | pass |
| hocuspocus ACL (`convex-acl`) | `postgres-acl.test` + two-client `liveCoEditing.spec` E2E | pass |
| live co-editing (Yjs over Postgres) | `@dohc/hocuspocus` hooks/persistence/import-export tests + `liveCoEditing.spec` (content survives, converges, no markers) | pass |
| collaboration policy / conflict resolution | `@dohc/workspace-sync` collaborationPolicy + `@dohc/workspace-history` conflictResolution (3-way merge) | pass |
| app discovery / trust / test | `@dohc/workspace-core` apps + desktop `appPackage.test` + `appPackage.spec` E2E (static AppTester) | pass |
| uploads / assets (blob storage) | `@dohc/workspace-contracts` conformance (saveAsset/readAsset, run against the postgres adapter) + desktop `workspaceAssets.test` (path containment, symlink escape, size caps) + `workspaceFiles.test` + `FileInspector.test` + file-type E2E | pass |
| visible SQLite / data import / query | `@dohc/sqlite-worker` tests + desktop `workspaceDatabase.test` + MCP `import_data`/`query_database` | pass |
| local history / change sets | `@dohc/workspace-history` `changeSetStore.test` + desktop watcher history | pass |
| onboarding / first-run setup | desktop `DesktopFirstRun.test` + `firstRunWorkspace.spec` E2E | pass |
| agent integration / MCP tools | `@dohc/mcp` `tools.test` (10 tools, path containment) + desktop `AgentIntegration.test` + `localAgent.spec` E2E | pass |
| agent run attribution | desktop watcher attribution seam + `AgentIntegration.test` | pass |

## CRITICAL OPEN QUESTION (must be resolved before Step 3 deletion)

The replacement tests above cover the local-first **data + behavior** layer.
The **web app UI** (`apps/app`, `@dohc/web`) already has a real — but narrow —
backend seam, and is Convex-coupled everywhere else. Precisely:

**The existing seam** (from the dual-backend work, tested): an env-selected
(`DOHC_BACKEND` / `VITE_DOHC_BACKEND`; browser query strings deliberately
ignored; default `convex`) `DohcBackendClient` in `apps/app/src/backend/`
(`backendClient.ts`, `postgresBackendClient.ts`, `convexBackendClient.ts`)
covering five file ops — `listFiles` / `readText` / `createTextFile` /
`uploadFile` / `renameFile` — where the postgres client is a real HTTP client
for `services/workspace-api` (`GET /files`, `GET/POST /files/text`,
`POST /files/upload`, `POST /files/rename`). It is wired through `_app.tsx`
(client instantiation + file-list source switch + create/rename delegation) and
passed into `FileTree`, `AtomView`, and `UploadFileButton`. Tested by
`src/__tests__/backendSwitch.test.tsx` (mode resolution, op routing, endpoint
shapes, source-level wiring guard) and parameterized in
`e2e/backendMatrix.spec.ts` (contract-level: synthetic UI + in-memory backend,
NOT the real web UI against a live workspace-api).

**What the seam does NOT cover:** auth (`ConvexProviderWithAuth` at the route
root, WorkOS AuthKit — no Better Auth client exists in the web app), workspace
listing (`api.orgs.myWorkspaces`), folders, sharing (`atomShares`), agent chat,
search, graph, onboarding, HTML atoms (`r/$atomId` uses `ConvexHttpClient`
server-side), command palette skills, and AtomEditor formula queries. Measured
coupling: ~31 non-test src files use Convex hooks, ~23 import `_generated/api`,
~30 hook call sites in `_app.tsx` alone — and those hooks mount UNCONDITIONALLY
even in postgres mode, so a Convex deployment is still required at runtime.
The seam alone does not make deletion safe.

Therefore deleting `apps/app/convex` + the generated `api` + the WorkOS bridge
WITHOUT first (a) extending the existing `DohcBackendClient` seam for the kept
surfaces (files/editor/viewing — a concrete, already-tested starting point) and
(b) gutting the Convex-only surfaces the repositioning retires (agent chat,
graph, search, onboarding, HTML atoms, app runtime in browser) plus replacing
web auth (Better Auth) and shared links (a workspace-api endpoint over the
existing Postgres `shares` table) would break `@dohc/web` typecheck and the
entire web app — failing this phase's own Step 4 gate
(`pnpm -r typecheck && pnpm -r test`).

The Step 2.5 audit must enumerate any Convex behavior missing a replacement row
above, evaluating rewire-vs-gut FROM the seam inventory described here. The
deletion is staged deliberately, not a single rm -rf, precisely because of this
coupling.
