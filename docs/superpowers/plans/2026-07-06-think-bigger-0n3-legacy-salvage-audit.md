# Think Bigger 0N-3: Legacy Salvage And Retirement Audit

Status: audit complete (read-only lane; no code changed)
Date: 2026-07-06
Arc: 0N (Agent Loop), lane 0N-3
Basis: User Decision 6 (replacement, not migration) in
[the Think Bigger plan](./2026-06-23-think-bigger-dohc-workspace-engine.md);
all claims verified against source at main `fefd0df7`.

## Headline findings

- The cloud stack (`services/workspace-api`, `packages/workspace-postgres`,
  `services/hocuspocus`, plus `apps/web`'s backend client) is **fully
  decoupled from the desktop default path** — no `apps/desktop` file imports
  it; the desktop reaches it only over HTTP via opt-in cloud sync. It can be
  gated or retired independently of the local product.
- The retirement chokepoint for the local legacy path is
  `apps/desktop/src/workspaces/workspaceWatcher.ts`: every unflagged
  workspace records `.dohc/history` through it. Legacy history/sync die only
  when the engine flag defaults on.
- There is **no large body of dead runtime code** to delete today. Every
  genuinely free deletion is docs/Convex-era. The legacy stack is
  dead-ending, not dead.
- The honest flag-default-on gates are **live rich-doc collaboration
  (Y.Doc)** and **binary/asset versioning** — both reachable on the local
  default path today and absent from the engine.

## Subsystem classification

LOC = non-test source, rounded.

| Subsystem | Paths | ~LOC | Classification | Suggested arc |
| --- | --- | --- | --- | --- |
| Atoms/backend contracts | `packages/workspace-contracts/src/` (non-engine modules) | 1,555 | Split: `engine.ts` subpath KEEPS (engine-owned); atoms/share/member schemas RETIRE with the API | sync/0P |
| Postgres persistence | `packages/workspace-postgres/src/` | 2,498 | RETIRE (KEEP-UNTIL for cloud); superseded by per-workspace SQLite | sync/0P re-establishes a server store fresh if needed |
| Workspace API | `services/workspace-api/src/` | 2,777 | KEEP-UNTIL (cloud only); shares/invites/members are capabilities the engine lacks | cloud-shares arc |
| Hocuspocus (Y.Doc collab) | `services/hocuspocus/src/` | 4,681 | KEEP-AS-IS then SALVAGE-REIMPLEMENT; engine has no live-CRDT equivalent | collab arc |
| Legacy history | `packages/workspace-history/src/` | 1,638 | KEEP-UNTIL + partial SALVAGE (`mergeMarkdown` subpath and record types stay) | engine core |
| Legacy sync | `packages/workspace-sync/src/` | 667 | KEEP-UNTIL (desktop watcher uses `batchToChangeSet`) + SALVAGE-REIMPLEMENT | sync/0P |
| SQLite worker service | `services/sqlite-worker/src/` | 943 | KEEP-UNTIL (cloud/import); lessons already fed engine storage | data arc |
| Desktop workspace databases | `apps/desktop/src/workspaces/workspaceDatabase.ts` | 323 | KEEP-AS-IS (orthogonal feature, `node:sqlite`) | later data arc |
| Y.Doc renderer collab + editor | `renderer/collab/`, `renderer/editor/` | ~4,100 | KEEP-AS-IS then SALVAGE-REIMPLEMENT; gates flag default | collab arc |
| Desktop cloud sync + credentials | `cloudSyncEngine.ts`, `cloudCredentialStore.ts`, `cloudLogin.ts`, `cloudDataFragments.ts` | ~450 | KEEP-UNTIL + SALVAGE (credential store reusable for secrets) | sync/0P, secrets |
| Legacy history restore | `apps/desktop/src/workspaces/historyRestore.ts` | 256 | KEEP-UNTIL (unflagged restore); engine restore already exists for flagged | retires with legacy history |
| Sites | `siteRunner.ts`, `sitePackage.ts`, sites views, `workspace-core/sites.ts` | ~1,000 | KEEP-AS-IS (orthogonal) | none |
| Cloud shares/invites/members/data-fragments | `workspace-api` routes | ~1,435 | KEEP-UNTIL (cloud); engine lacks multi-user entirely | cloud-shares arc |
| MCP | `packages/mcp/src/` | 3,006 | SALVAGE-REIMPLEMENT (re-point recording at engine moments; keep tools/scanner) | Arc 0N-1 (in flight) |
| Ripgrep search | desktop `workspaceSearch.ts` + `main.ts` wiring | ~400 | KEEP-UNTIL engine search is actually mounted (it is package-only today) | search arc |
| Shared infra | `packages/workspace-core/`, `packages/workspace-fs/` | 2,852 | KEEP-AS-IS — foundation for BOTH stacks; never retire with legacy | keep |
| Brand / SDK / performance / agent-sandbox | various | — | KEEP-AS-IS (orthogonal) | keep |

Retire-eligible backend footprint: ~5,256 source LOC (`workspace-api` +
`workspace-postgres`) plus ~2,300 desktop-facing legacy history/sync LOC.

## Load-bearing dependency edges

- `workspaceWatcher.ts` imports `@dohc/workspace-history`
  (`createChangeSetStore`, …) and `@dohc/workspace-sync`
  (`batchToChangeSet`) — the unflagged default recorder. Chokepoint.
- `workspaceActivity.ts` already branches engine-vs-legacy (`captureFor` /
  `engineCapture()`); the legacy branch is cleanly deletable at flag flip.
- `collabSession.ts` imports `@dohc/workspace-history/mergeMarkdown` — a
  salvage edge, not a retire blocker.
- `apps/web` is the only importer of the Postgres backend client; retiring
  the cloud backend retires the web app as a coupled unit.
- `packages/mcp/src/tools.ts` imports history + sync + sqlite-worker — must
  be re-pointed before those packages die (0N-1 begins this).

## Flag-default-on gate list

All items closed as of 2026-07-07 (lane WS-H1); the flag default flips in the
same lane. Evidence per item:

- [x] Live collab (Y.Doc) re-homed on the engine or explicitly decoupled so
      the flip does not regress co-editing. **Closed by decoupling** per the
      [WS-G2 collab design](./2026-07-06-think-bigger-wsg2-collab-design.md)
      (decision (a) decouple-and-defer; (b) Y.Doc driver is the committed
      later shape). G2-A pinning tests:
      `apps/desktop/e2e/workspace-collab-decoupling.spec.ts` (engine-flagged
      local workspace edits a rich doc with zero WebSockets and a refused
      collabToken; bridge-write materializations become engine moments) and
      the "G2-A: engine restore while a collab session is open" block in
      `apps/desktop/src/renderer/collab/collabSession.test.ts`
      (restore-while-open merges into the doc or rescues to `.conflict`, and
      the advanced materialization base stops the next settle from
      overwriting the restore).
- [x] Binary/asset versioning in the engine (WS-G1, commit `c4148627`):
      capped binary capture in
      `apps/desktop/src/workspaces/workspaceEngineCapture.ts`
      (`contentKind: "binary"`, binary blobs in the engine store) with
      engine-side support in `packages/workspace-engine`.
- [x] Engine search mounted in the desktop renderer (WS-D): the
      `searchWorkspace` IPC routes flagged workspaces through
      `searchWorkspaceEngine` (`apps/desktop/src/main.ts`), rendered by
      `apps/desktop/src/renderer/workbench/SearchView.tsx`; E2E
      `apps/desktop/e2e/workspace-engine-search.spec.ts`.
- [x] MCP agent recording routed through engine moments (Arc 0N-1):
      `packages/mcp/src/tools.ts` skips legacy change-set writes for flagged
      workspaces (`recordChange` → `recordedBy: "workspace-engine"`); the
      desktop watcher captures MCP's physical writes as engine moments with
      agent authorship (`engineCaptureGate.ts` `activeAgentRun`).
- [x] Engine restore/version/merge UX at parity for every unflagged-restore
      scenario (0M-4/0M-5): `restoreEngineMomentFile` IPC + engine History
      restore/undo (`apps/desktop/src/workspaces/workspaceEngineRestore.test.ts`),
      versions/merge surfaces
      (`apps/desktop/e2e/workspace-versions.spec.ts`,
      `apps/desktop/e2e/workspace-engine-history.spec.ts`).
- [x] History-capture failure notice (landed in PR 0M-7).

## Recommended retirement sequence

- **Phase A — free deletions (now, docs-only):** delete/replace the
  Convex-era docs (`docs/security/authz-boundaries.md`,
  `docs/development/v2-phase-plans/phase-1.3-convex-acl-bridge.md`, Convex
  sections of `docs/architecture/backend-modes.md` and
  `docs/self-hosting.md`); sweep residual Convex references in comments and
  config.
- **Phase B — salvage consolidation (dual-stack, no user impact):** move
  `mergeMarkdown` + the history record types the engine needs behind an
  engine-owned boundary so `changeSetStore.ts` becomes independently
  deletable; re-point MCP recording at engine moments (Arc 0N-1).
- **Phase C — flag flip (gated on the list above):** default
  `workspaceEngineAlpha` on; delete the legacy branch in
  `workspaceWatcher.ts`/`workspaceActivity.ts`, `changeSetStore.ts`,
  `historyRestore.ts`; retire `batchToChangeSet`; desktop sync reimplements
  fresh under Arc 0P.
- **Phase D — cloud stack decision (independent):** either gate/remove
  `workspace-api` + `hocuspocus` + `workspace-postgres` + the web backend
  client as a coupled unit, or rebuild shares/members/collab against the
  engine; atoms/Postgres retire last (auth- and data-touching).

## Cheapest first deletions

1. `docs/security/authz-boundaries.md` (describes Convex enforcement; code
   is Postgres/engine now).
2. Convex-era plan docs and doc sections (see Phase A).
3. Residual `apps/app`/Convex references in comments/config (the app itself
   is already gone).
4. Thin unreferenced cloud routes (e.g. `routes/email.ts`) — only if the
   cloud arc is deferred and `apps/web` provably does not call them.
5. The legacy capture branch scaffolding — cheapest CODE deletion, but only
   at Phase C.
