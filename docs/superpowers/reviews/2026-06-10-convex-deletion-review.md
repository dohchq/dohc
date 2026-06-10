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
| uploads / assets (blob storage) | desktop `workspaceAssets`/`workspaceFiles` tests + `FileInspector.test` + file-type E2E | pass |
| visible SQLite / data import / query | `@dohc/sqlite-worker` tests + desktop `workspaceDatabase.test` + MCP `import_data`/`query_database` | pass |
| local history / change sets | `@dohc/workspace-history` `changeSetStore.test` + desktop watcher history | pass |
| onboarding / first-run setup | desktop `DesktopFirstRun.test` + `firstRunWorkspace.spec` E2E | pass |
| agent integration / MCP tools | `@dohc/mcp` `tools.test` (10 tools, path containment) + desktop `AgentIntegration.test` + `localAgent.spec` E2E | pass |
| agent run attribution | desktop watcher attribution seam + `AgentIntegration.test` | pass |

## CRITICAL OPEN QUESTION (must be resolved before Step 3 deletion)

The replacement tests above cover the local-first **data + behavior** layer. But
the **web app UI** (`apps/app`, `@dohc/web`) is still hard-wired to Convex:
`ConvexProviderWithAuth` at the route root and `useQuery(api.*)` / `useMutation`
throughout (~64 source files), with auth via `@convex-dev/workos-authkit`. There
is no UI-level backend indirection — the dual-backend switch lives in the
workspace data packages, not in the web UI.

Therefore deleting `apps/app/convex` + the generated `api` + `@convex-dev/workos-authkit`
WITHOUT first either (a) rewiring the web UI's data layer to the Postgres /
workspace-api backend, or (b) gutting the Convex-coupled UI to the repositioned
cloud shell, would break `@dohc/web` typecheck and the entire web app — which
fails this phase's own Step 4 gate (`pnpm -r typecheck && pnpm -r test`).

The Step 2.5 audit must enumerate any Convex behavior missing a replacement row
above; SEPARATELY, the web-UI-post-Convex decision (rewire vs gut) is the
prerequisite that makes the physical deletion safe. The deletion is staged
deliberately, not a single rm -rf, precisely because of this coupling.
