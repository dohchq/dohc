# Old Plan Port/Delete Inventory

Classification of the merged dual-backend substrate (main @ bc62bd2) for the desktop local-first pivot. Evidence: dual-backend execution log, readiness review, tech-debt audit (digested in the execution log's Reference Digests), and direct path verification on 2026-06-10. The stale local branch `codex/dual-backend-filesystem-agent-runtime` is never used — all code below lives in the current working tree.

## Keep And Promote

| Asset | Evidence | Pivot role |
|---|---|---|
| `packages/workspace-contracts` | conformance harness + domain validators, 8 tests green | contract layer both desktop core and cloud sync code against; conformance harness reused for sync engine |
| `packages/workspace-postgres` | Drizzle schema/migrations/repos/services, 12 tests green, zero Convex coupling | the only cloud/self-host backend (Phase 9) |
| `packages/workspace-fs` | materialize/scan/diff/apply/syncClient/watch, 6 tests green | local workspace engine (Phase 5); NOTE: watch is polling — Phase 5 replaces with chokidar |
| `services/workspace-api` | HTTP handler + ResolveActor (`src/auth/session.ts`), route surface proven | cloud/self-host API; Better Auth mounts here (Phase 9) |
| `services/agent-sandbox` | allowlist shell, diff capture, approvals; 2+4 tests green | hosted/cloud sandbox; desktop local agents use folder+MCP first (Phase 11) |
| `services/sqlite-worker` | import/query/row ops, 11 tests green; requires Node 22.13+ (`node:sqlite`) | SQLite import/materialization/query (Phase 8) |
| `services/app-tester` | 25 tests green incl. backend matrix | app quality gate (Phase 7); matrix pivots to desktop/local/cloud |
| `services/hocuspocus` | 78 tests green | live co-editing server (Phase 10) — after ACL port off Convex |

## Port With Changes

| Asset | Source paths (verified) | Change |
|---|---|---|
| File-type views | `apps/app/src/components/FileTypeView.tsx`, `DatabaseStudio.tsx`, `DatabaseTableGrid.tsx` | port into desktop FileInspector dispatch table (Phase 6); strip Convex/web data hooks; data via typed desktop bridge |
| File tree / upload | `apps/app/src/components/FileTree.tsx`, `UploadFileButton.tsx` | desktop shell surfaces (Phase 3/6); subject to Phase 3 component reuse map criterion |
| Agent output separation | `apps/app/src/components/AgentActivityTimeline.tsx`, `AgentRunRail.tsx`, `AgentChatSidebar.tsx` | desktop agent activity panel (Phase 3); presentation primitives reusable |
| App runtime / trust | `apps/app/convex/apps.ts`, `appAgent.ts`, `appTesting.ts`, `appTrust.ts` + app runtime client code | behavior ports to local `.apps/<name>` discovery + build cache (Phase 7); trust/scope semantics preserved, Convex storage replaced |
| Hocuspocus ACL | `services/hocuspocus/src/convex-acl.ts` (exports createConvexAcl: checkAtomAccess/loadAtomBootstrap/setBodyCache/createAtom surface) | port to `postgres-acl.ts` against workspace-postgres grants + Better Auth sessions (Phase 10) |
| Backend matrix | `services/app-tester/src/backendMatrix.test.ts`, `apps/app/e2e/backendMatrix.spec.ts` | rewrite as desktop/local/cloud matrix (Phases 9, 18) |
| Auth actor shape | `services/workspace-api/src/auth/session.ts` ResolveActor | keep actor shape; resolve from Better Auth sessions instead of Convex/WorkOS (Phase 9) |

## Delete After Replacement (each with its gate)

| Asset | Replacement proof required | Phase |
|---|---|---|
| `apps/app/convex/` (entire Convex backend, ~40 modules) | ported test map rows all pass (atoms/authz/auth/app trust/uploads/onboarding) | 13 |
| `packages/workspace-convex-compat` | conformance covered by postgres adapter alone | 13 |
| Dual-backend switch (`apps/app/src/backend/backendClient.ts`, `convexBackendClient.ts`, `postgresBackendClient.ts`, `DOHC_BACKEND`) | desktop/local/cloud matrix replaces it | 13/17 |
| `@convex-dev/workos-authkit` + `use-auth-bridge.ts` + auth.config.ts + WORKOS_* env | Better Auth tests + cloudLogin E2E green | 13 |
| `services/hocuspocus/src/convex-acl.ts` + HOCUSPOCUS_CONVEX_* env | postgres-acl tests + live co-editing E2E green | 13 |
| Web-first atom tools duplicating local-file paths | MCP/local-file workflows cover behavior | 13/17 |
| `.views` compatibility paths | `.apps` migration/regression tests green | 17 |
| Convex scripts in dev-sync.mjs, reset:dev, env examples | desktop/local dev path documented | 13 |
| `scripts/check-dual-backend-baseline.mjs` | desktop-local-first baseline replaces it | 17 |

## Delete Immediately

- Nothing. Day-1 deletion candidates all have live consumers until their phase gate. (Aggression budget goes to Phases 13/17 where tests prove safety.)

## Tests To Preserve

- workspace-contracts conformance harness (becomes the sync-engine contract test).
- workspace-postgres schema/conformance/services suites.
- app-tester suite (matrix relabeled, assertions kept).
- hocuspocus suite (ACL tests swapped to postgres-acl, doc/persistence tests kept).
- @dohc/web security/collab slices (authz boundaries, app security/trust, agent approvals) — these become the Phase 13 ported-test-map evidence.

## Tests To Rewrite

- `backendSwitch.test.tsx` → desktop/local/cloud mode tests.
- `apps/app/e2e/backendMatrix.spec.ts` → desktop product readiness matrix (Phase 18).
- Convex-coupled integration tests (`agentSandboxIntegration`, `hocuspocusAuth`-dependent) → replacement tests named in the Phase 13 ported test map.
- Web onboarding tests → desktop first-run tests (Phase 3) + web cloud-role tests (Phase 12).

## Remaining Questions

- Does `apps/app/src/routes/r/$atomId.tsx` (share-page SSR via ConvexHttpClient) need a Postgres-backed replacement before Phase 13, or does Phase 12 web repositioning subsume it? (Tracked for Phase 12 planning; default: workspace-api share endpoint.)
- sqlite-worker fallback path when `node:sqlite` is unavailable — keep or delete once toolchain freeze guarantees 22.13+? (Phase 8 delete-or-justify.)
- Hocuspocus Y.Doc persistence currently writes to its own Postgres URL (`HOCUSPOCUS_DATABASE_URL`) — unify with workspace Postgres in Phase 10 or keep separate? (Phase 10 design panel input.)
