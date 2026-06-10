# Convex deletion review — ported test map + pre-deletion gate (Phase 13)

This is the gate for deleting Convex. Convex is removed ONLY after every
important Convex-era behavior has a passing replacement test in the local-first
stack (desktop + workspace packages + Postgres services). "Do not delete product
behavior; delete only after replacement tests exist."

## Status of prerequisites

- Step 2 baseline (`pnpm check:desktop-local-first-baseline`): **PASS** (EXIT 0).
  All 14 packages green; `@dohc/web test` carries 5 recorded known-fail
  Convex-era tests (tolerated baseline); `check:debt` green.
- Step 2.5 cross-model pre-deletion audit: **COMPLETE** (codex gpt-5.5 xhigh,
  663,812 tokens over the full Convex sources → `/tmp/codex-phase13-audit.log`)
  and **triaged below**. Step 3 may begin once the two concrete pre-deletion
  work items in the triage are part of its scope.

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

## Step 2.5 audit triage (lead decision per finding)

The audit surfaced 15 findings (7 missing rows, 8 overclaims). Triage verdicts
against the REPOSITIONED product (desktop-first local files; web = cloud client
+ shared links; collaboration = the paid engine):

**Concrete pre-deletion work (folded into Step 3 scope):**

1. **Share lifecycle for the kept product** (audit a2/b1, P1): the repositioned
   web KEEPS shared links. Step 3 must ship the workspace-api shared-link
   resolution endpoint over the Postgres `shares` table WITH lifecycle tests:
   view/edit capability honored, **revocation honored** (soft-deleted share →
   403), non-member with share can read only the shared atom. Pending-email
   and org-wide audiences are future cloud features (schema's
   `recipient_user_id` model holds them later) — recorded, not silently lost.
2. **Database op idempotency payload-compare** (audit b5, P1): Convex rejected
   a reused operation id with a DIFFERENT op/payload; the Postgres
   `databaseFiles` apply returns idempotent success on any reused id. Step 3
   fixes `packages/workspace-postgres/src/services/databaseFiles.ts` to compare
   the stored op payload and reject mismatched reuse, with a test. This is a
   kept desktop path (sqlite op-log sync).

**Deliberate simplifications / retirements (decisions, not silent loss):**

3. **atomAccess/folderAccess private-restricted ACLs + tombstones** (a1, b1):
   the post-pivot authorization model IS the simplification — workspace
   membership grants the workspace's files; finer grain = atom `shares` +
   `locks` (tested in postgres-acl) + the desktop collaboration policy
   (protected targets → propose/review; boundary crossings → confirm; 30
   tests). Private-within-shared ACL trees are not in the repositioned product.
4. **Web agent approval cards / skill-turn gates** (a3, b4): the web agent
   surface is retired. The local agent goes through the MCP boundary: every
   share returns needs-confirmation (tested), boundary crossings queue for
   explicit confirmation (collaborationPolicy tests), nothing auto-trusts an
   app (tested). A persisted approval inbox is named future work (phase 11
   notes), not a deletion casualty.
5. **Trash/restore/30-day purge** (a4): replaced by architecture. Locally,
   files are user-owned on disk — dohc never hard-deletes user files (the MCP
   deliberately ships no delete tool) and history records change sets. Cloud
   rows are soft-deleted (`deleted_at` everywhere) and the sync engine's
   no-resurrect rule is tested. A restore UI over soft-deletes is future
   product work; the cron purge was a Convex-era ops artifact.
6. **Captures/windows/viewData reviewed-by-default** (a5): the cross-desk
   live-data dashboard surface is retired with the Convex web product. The
   audit itself conditions this finding on that surface staying. Post-pivot
   apps are local source folders behind the fingerprint-bound trust gate.
7. **Stable atom-id hijack + formula/query leakage** (a6): formula/query blocks
   are retired web-editor surfaces. The kept stable-id property is enforced
   where it matters now: the hocuspocus projection rejects frontmatter-id
   mismatch (`frontmatter-id-mismatch`, tested) and Postgres atoms are keyed by
   server-side UUIDs.
8. **Workspace slugs / URL identity** (a7): the repositioned web routes by
   workspace id; pretty slugs and verified-email share routes are future
   naming work (Phase 15 recorded cloud naming; nothing in the kept product
   resolves slugs).
9. **Org lifecycle breadth — invites, last-owner guard, member removal**
   (b3): the Better Auth `organization` plugin ships these primitives, and the
   post-pivot member-management API is named FUTURE work for the collab
   product. Deleting Convex loses no working post-pivot flow (the Convex flows
   served the retired web app); recorded as a tracked gap, not a regression.
10. **Hocuspocus live revocation** (b2): bounded today, not absent — writes
    are re-checked per update (`beforeSync` ACL), and reads die with the 5-min
    collab JWT whose re-mint re-checks membership at `/collab/token`. What is
    missing is the immediate socket kick (authz-version bump), already
    explicitly tracked in `postgres-acl.ts` with its bump-condition comment.
    Exposure window ≤ token TTL; recorded, deletion-safe.
11. **App trust freshness** (b6): local trust is fingerprint-bound (trust
    resets when sources change — covered in apps tests); Convex's seed/digest
    freshness checks belonged to the retired hosted runtime.
12. **Cloud asset registry idempotency / dohc-asset refs** (b7): the web
    editor's hosted asset registry is retired; local assets are plain files,
    cloud sync dedupes by sha256 (merge-sync tests).
13. **Onboarding lease/CAS** (b8, audit-rated P3 if retired): retired — the
    desktop first-run replaces agentic web onboarding (tested).
14. **Conformance breadth** (b8/atom row): row wording amended — conformance
    covers CRUD/stale-write/asset/rename; lock classes and agent overwrite
    guards live in the desktop policy + locks model.

Routed from phase 15's review: Step 3 also deletes the trailing
`VITE_CONVEX_URL` block from `.env.self-host.example`.
