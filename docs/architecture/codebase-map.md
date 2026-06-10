# Codebase map — module boundaries

The intended final shape after the desktop-first/Postgres pivot (Phase 17).
`pnpm check:architecture-debt` enforces the structural rules below; this
document is the human-readable contract. Directions, in one line: apps
consume packages; services consume packages; packages never consume apps,
and never consume services except two audited edges from packages/mcp
(`@dohc/app-tester/static` and `@dohc/sqlite-worker` — library-shaped
services, candidates for reclassification as packages); one audited
service-to-service edge (workspace-api consumes hocuspocus's auth helpers);
nothing consumes a deleted backend.

## apps/desktop — the product

- **Owns:** Electron main process (window, typed IPC handlers, workspace
  registry, watcher wiring, cloud login/sync engine wiring, MCP launch
  config), `src/preload.ts` (the ONLY renderer↔system seam), and the
  sandboxed React renderer (shell, file views, collab textarea, palette).
- **Must not import:** web code (`@dohc/web`, `apps/web/*`); in
  `src/renderer/**`: any `node:*`/`electron` module — renderer talks ONLY to
  `window.dohcDesktop` (typed `DohcDesktopBridge`). Preload may name channels
  only via `CHANNELS.*`.
- **Imported by:** nothing (it is a leaf).
- **Proof:** `scripts/check-architecture-debt.mjs` (renderer purity, preload
  contract, no web imports); desktop unit suite (144) incl.
  `bridgeContract`/`channels` typing; E2E `apps/desktop/e2e/*` (21);
  `smoke-test.mjs`, `package-smoke.mjs`, `fuse-smoke.mjs`.

## apps/web (`@dohc/web`) — dohc Cloud web client

- **Owns:** sign-in (Better Auth cookie session), cloud workspace
  browse/light-edit shell (`src/cloud/`), shared-link pages (`/r/$atomId`,
  `/shared/$shareId` alias), the `DohcBackendClient` seam (`src/backend/`).
- **Must not import:** `electron`, `@dohc/desktop`, Node-only workspace
  packages (`workspace-fs`, `workspace-history`, …). Browser-safe shared
  packages are fine (`@dohc/brand`, `@dohc/workspace-core`).
- **Imported by:** nothing (leaf).
- **Proof:** `src/__tests__/cloudWebRole.test.tsx` (no electron/desktop deps,
  cloud role claims), `backendSwitch.test.tsx` (single postgres seam, op
  routing), `brandNoLegacy.test.ts`; suite of 41 under Node 22.13.

## packages/workspace-core — pure workspace law (no I/O)

- **Owns:** path validation (`validateUserWritePath`, `normalizeAbsolutePath`,
  `validateWorkspaceRootChoice` — the ONE owner), file-type detection
  (`classifyPath`, `mediaTypeForPath` — the ONE extension→media-type table),
  workspace mode/metadata, change-set/conflict/database-op contracts, watcher
  and sync-status contracts.
- **Must not import:** anything but Node type shims — it must stay
  browser-safe (the web bundles it; `ssr.noExternal` in apps/web).
- **Imported by:** desktop, web, workspace-fs/-sync/-history, mcp.
- **Proof:** `src/*.test.ts` (91), including traversal/alias adversarial
  cases; duplicate-owner rules in `check-architecture-debt.mjs`.

## packages/workspace-fs — filesystem engine (Node)

- **Owns:** scan/diff/apply, manifest metadata + sha256, watcher event
  batching (`watchEvents`, SQLite sidecar collapse), the sync client CLI.
- **Must not import:** apps, services, electron. (Dev-only: its tests use
  `@dohc/workspace-api` as a devDependency to run against a live server.)
- **Imported by:** desktop, workspace-sync, agent-sandbox, (mcp via history
  flows is indirect).
- **Proof:** `src/*.test.ts` (33) incl. WAL-sidecar and symlink cases from the
  phase-05 codex findings.

## packages/workspace-sync — sync policy

- **Owns:** merge-sync engine and cloud-sync policy (what syncs, conflict
  naming, never-git-markers).
- **Must not import:** apps, services, electron.
- **Imported by:** desktop (cloudSyncEngine wiring).
- **Proof:** `mergeSync`/`cloudSync` tests (38).

## packages/workspace-history — local-first history

- **Owns:** change-set store (serialized index writes), markdown 3-way merge.
- **Must not import:** apps, services, electron.
- **Imported by:** desktop, mcp.
- **Proof:** history store tests (20) incl. the concurrent-record race.

## packages/workspace-postgres — cloud persistence

- **Owns:** drizzle schema + raw SQL migrations, repositories
  (atoms/assets/databases/workspaces), authz policy (`assertWorkspaceMember`),
  provisioning/import services, the postgres test adapter.
- **Must not import:** apps, desktop, anything browser-only.
- **Imported by:** workspace-api.
- **Proof:** live-pg suites (`workspaces`, `syncBackend`, `databaseOps`,
  `dataImport`, conformance via workspace-contracts).

## packages/workspace-contracts — shared wire contracts

- **Owns:** zod contracts for workspace files/actors and the backend
  conformance suite (`./conformance`).
- **Must not import:** anything but zod.
- **Imported by:** workspace-fs, workspace-postgres, workspace-api,
  agent-sandbox.
- **Proof:** contract tests + the conformance suite run by backends.

## packages/mcp — local agent surface

- **Owns:** the `dohc-mcp` stdio server and every MCP tool schema; all path
  arguments go through workspace-core validation; DB queries are read-only
  and bounded. Consumes two library-shaped services (the audited cross-layer
  edges named in the header): `@dohc/app-tester/static` (app trust check)
  and `@dohc/sqlite-worker` (query engine).
- **Must not import:** apps, electron, web.
- **Imported by:** desktop (dependency provides the `dohc-mcp` bin; spawned,
  not imported).
- **Proof:** `src/tools` tests (17) + desktop E2E `localAgent.spec.ts`
  (real MCP client over stdio).

## packages/brand / packages/performance

- **Brand owns** logo/tokens (`tokens.css`); imported by web + desktop;
  proof: brand tests + `brandNoLegacy`. **Performance owns** the marks/budget
  helpers; imported by desktop (dev) and `scripts/check-performance.mjs`;
  proof: its unit tests + the perf gate.

## services/workspace-api — the cloud API (Better Auth + sync + shares)

- **Owns:** HTTP routes (files/assets/sync/workspaces/shared), Better Auth
  wiring (cookie + device-flow Bearer), session→actor resolution, env-gated
  CORS.
- **Must not import:** apps, electron. May import workspace-postgres,
  workspace-contracts, and `@dohc/hocuspocus` auth/doc-name helpers (the
  audited package→service exception, so collab tokens share one secret
  format).
- **Imported by:** nothing at runtime; workspace-fs tests (dev-only).
- **Proof:** live-pg route suites incl. share revocation/bypass attempts and
  device-flow tests.

## services/hocuspocus — collaboration authority

- **Owns:** Yjs doc hosting, signed-token auth, doc-name parsing, Postgres
  ACL (final access decision), markdown↔Y.Doc projection, plain-text doc
  selection for `.apps/` source files (`source-kind.ts`).
- **Must not import:** apps, desktop, web.
- **Imported by:** workspace-api (auth/doc-name exports only).
- **Proof:** suite of 81 (`auth`, `doc-name`, `postgres-acl` — which also
  asserts no legacy-backend references — `hooks`, `semantic-api`) +
  integration config; desktop E2E `liveCoEditing.spec.ts`.

## services/sqlite-worker / services/app-tester / services/agent-sandbox

- **sqlite-worker owns** the SQLite engine (import/query/edit op-log);
  imported by mcp and desktop; proof: `importData`/engine tests + desktop
  `sqliteImport.spec.ts`.
- **app-tester owns** app readiness checks: `runAppTest` + the static trust
  check (rejects legacy view-era SDK patterns); imported by desktop and mcp;
  proof: its suite + desktop `appPackage.spec.ts`.
- **agent-sandbox owns** the constrained command sandbox for cloud agent
  runs; imports workspace-contracts/-fs only; proof: `agentSandbox.test.ts`.

## scripts/ — repo gates

`check-architecture-debt.mjs` (boundaries + forbidden evolution language),
`check-tech-debt.mjs` (debt markers), `check-self-host*.mjs`,
`check-cloud-ready.mjs`, `check-performance.mjs`,
`check-desktop-local-first-baseline.mjs`, `dev-cloud.mjs`,
`reset-postgres-dev-data.mjs`. Root `pnpm check:lean` = knip + debt +
architecture. Scripts import only root devDependencies (pg, tsx declared).
