# Desktop Local-First Tech Debt Audit

## Standard

This branch should leave dohc in a lean, coherent state that a top-tier
engineer would want to work in.

Phase 17 result over the working tree (re-measured by `git diff HEAD
--numstat` after the post-review fix pass): **112 files changed, +1,099 /
−8,287 lines (net −7,188)**; 22 tracked files deleted, 45 files renamed
(`apps/app` → `apps/web`, D-36 closed), 38 dependency entries removed across
five manifests, every gate green after.

## Code Deleted

- **`apps/web/src/editor-v2/` — 12 files.** The Convex-era Tiptap/Yjs web
  editor stack (markdown extensions, hocuspocus provider, IndexedDB state,
  import/export, schema contracts + 6 test files). No live route imported it
  — it was kept alive only by its own tests; the cloud shell edits through
  the REST `DohcBackendClient`, and desktop collab uses its own
  `renderer/collab` path. The hocuspocus SERVICE keeps its own (tested)
  projection copies.
- **`apps/web/src/lib/` — 6 files.** `frontmatter.ts(+test)` and
  `pastedAttachments.ts(+test)` (only editor-v2 consumed them),
  `use-theme.ts` (knip: unused file), `mediaTypes.ts` (consolidated into
  workspace-core, see below).
- **`scripts/check-dual-backend-baseline.mjs` + root script
  `check:dual-backend-baseline`** — the old-stack baseline; nothing
  referenced it outside historical docs.
- **`scripts/dev-postgres.mjs`** — superseded by the `dev:postgres` compose
  one-liner; referenced only by historical docs.
- **`packages/config` — 2 files.** An empty package (a tsconfig base no
  tsconfig extended). Workspace glob covers its removal.
- **`apps/app/.env.local`** (untracked) — live Convex deployment values for a
  deleted backend.
- **Dead functions:** `findSubpages`, `pathToBreadcrumbs`, `ancestors` +
  `Crumb` type (web path-tree; zero callers, zero tests),
  `resolveSessionActor` (workspace-api throw-only placeholder),
  `configureSha` (desktop collab seam nothing wired; comment claimed
  production wiring that did not exist — comment fixed to the truth),
  `mediaTypeForSource` ×2 (mcp + desktop, replaced by the shared table).
- **`DOHC_BACKEND` / `VITE_DOHC_BACKEND` env switch** — removed from
  `docker-compose.self-host.yml` (4 lines) and `.env.self-host.example`;
  no source read it (the backend-mode switch collapsed to postgres-only in
  phase 13; `resolveDohcBackendMode`/`convexBackendClient.ts` were already
  gone — verified by grep, recorded here as the D-36-adjacent check the plan
  asked for).
- **21 unused `export` keywords dropped** (18 knip value findings + 3 type
  exports caught in the review pass — the knip gate excludes types, see
  Allowlists; symbols in-file only): `WORKSPACE_UPLOAD_ACCEPT`,
  `DatabaseColumnView` + `DatabaseTableView` (both sites: the
  bridgeContract zod consts — the knip findings — and the same-named
  `workspaceDatabase.ts` interfaces, review pass), web `TreePage` (review
  pass), `updateFeedUrl`, `pathsToEvents`,
  `ALLOWED_WORKSPACE_COMMANDS` (+type), hocuspocus `DohcWikilink`,
  `DohcInlineAtom`, `DohcFormula`, `DohcQueryBlock`,
  `markdownProjectionHash`, workspace-api `MAX_ASSET_SIZE_BYTES`,
  `decodedBase64Size`, `MAX_SYNC_ASSET_BYTES`, web `isSourceCodeFilePath`.

## Code Consolidated

- **Extension → media-type table: 4 sites → 1 owner.**
  `packages/workspace-core/src/paths.ts` `mediaTypeForPath` (returns `null`
  for unknown; callers own their fallback) now feeds: mcp import
  (`?? "text/plain"`), desktop sqlite import (`?? "text/plain"`), workspace-fs
  sync metadata (thin wrapper, `?? "application/octet-stream"`), and web
  uploads (`@dohc/workspace-core` added to web deps + `ssr.noExternal`).
  Pinned by new `mediaTypeForPath` tests in workspace-core.
- **`.views` → `.apps` runtime language.** hocuspocus
  `source-kind.ts` (plain-text collab eligibility) and web `path-tree.ts`
  label logic now key on `.apps/` (the shipped product language; matches
  workspace-core `classifyPath`); tests updated. The app-tester static check
  still *rejects* `.views`/`@dohc/view` app code — that is a guard, kept.
- **apps/app → apps/web rename (D-36 re-evaluated and EXECUTED).** All
  references updated (`scripts/check-self-host.mjs`, `.coderabbit.yaml`,
  `knip.json`, `check-architecture-debt.mjs`, README, AGENTS, two test
  comments); package was already `@dohc/web`, so no import changes. Gates
  after: repo typecheck clean, @dohc/web 41/41 (Node 22.13), desktop E2E
  unaffected (see Commands Run).
- **Stale live docs fixed instead of allowlisted:** README layout/stack
  lines, root `AGENTS.md` pointer, `apps/web/AGENTS.md` (was a pure
  Convex-era file — rewritten), `.coderabbit.yaml` (filters, labels, path
  instructions, custom checks de-Convexed and pointed at
  workspace-api/desktop), `docs/security/authz-boundaries.md` (rewritten for
  the current architecture), migration `0001_initial.sql` comment (raw-SQL
  apply, no hash ledger — safe). Historical-but-stale docs got explicit
  Historical banners: `docs/development/local-dev.md`, `testing.md`,
  `docs/product/spec.md`, `docs/qa/playwright-checklist.md`
  (`backend-modes.md` already had one).
- **`docs/superpowers/reviews/codex/phase-05.md`** distilled from a
  3,611-line raw transcript to a findings dossier (phase-10/11 style); its
  `check-tech-debt.mjs` allowlist entry deleted exactly as its `deleteWhen`
  required (5 → 4 entries).

## Dependencies Removed

- **apps/web: 32 dependencies + 2 devDependencies.** The editor/agent-era
  cluster: `@ai-sdk/*` ×3, `ai`, `@tiptap/*` ×10, `@hocuspocus/provider`,
  `yjs`, `y-indexeddb`, `y-prosemirror`, `y-protocols`, `emoji-mart` ×3,
  `d3-force-3d`, `react-force-graph-2d`, `prismjs`(+types),
  `react-simple-code-editor`, `lowlight`, `mdast-util-from-markdown`,
  `isomorphic-dompurify`, `jose`, `js-yaml`(+types), `zod`. Added:
  `@dohc/workspace-core` (consolidation), `jsdom` (was resolving via
  hoisting only).
- **packages/mcp:** `@dohc/workspace-fs` (no import). 
- **packages/workspace-postgres:** `zod` (no import).
- **services/workspace-api:** `@better-auth/cli` (referenced nowhere; rerun
  via `pnpm dlx` if schema generation is ever needed).
- **Added for honesty (previously hoisting-only):** desktop devDeps
  `playwright`, `@modelcontextprotocol/sdk`, `js-yaml`, `@electron/asar`
  (e2e + packaging scripts import them); root devDeps `pg`, `tsx`
  (scripts import them); root devDep `knip` (new gate).

## Convex Deletion Evidence

Phase 13 deleted the code; this phase deleted the residue and installed the
guard. `node scripts/check-architecture-debt.mjs` scans every shipping file
(apps/packages/services/scripts/tests + root configs incl. compose, env
examples, `.coderabbit.yaml`, README, AGENTS) for legacy-backend tokens,
`workspace-convex-compat`, `DOHC_BACKEND`, and dual-backend language. It
passes with exactly two source-comment allowances (the postgres-acl
anti-regression assertion; the shared-link 404 comment) — see Allowlists.
Docs may mention the old backend only from the 59-file exact-path historical
list. Source files containing a NUL byte now FAIL the gate outright — git
classes them binary and every text rule would otherwise silently skip them
(real blind spot found in review: `workspaceDatabase.ts` carried a literal
NUL in its edit-queue key template; replaced with the `\u0000` escape).

## Web-First Code Retained And Why

- `apps/web` itself: the cloud/shared-link client per the plan — compact
  shell (cloud/, backend/, 3 components, path-tree) on the postgres seam.
- `path-tree.ts` retains Convex-era *shape* fields (`FolderInput` cosmetics,
  `fileId`, lock/star flags) that the compact shell does not populate; they
  are tested pure-data behavior, harmless, and the next tree iteration
  decides their fate. Knip reports no unused exports there after cleanup
  (holds under `--include types` too, after the review pass de-exported
  `TreePage`).

## Compatibility Code Retained And Deletion Conditions

- `/shared/$shareId` alias route → delete when pre-pivot link traffic no
  longer matters (its comment documents that old share-row links 404).
- `workspace-fs.mediaTypeForPath` wrapper (string-default flavor of the
  shared table) → delete if callers move to nullable handling.
- Migration `0001_initial.sql` deferred-FK scaffold note → promote FKs and
  rewrite when compatibility tests cover those flows (original condition
  stands).

## Allowlisted Unused/Architecture Findings

knip (`knip.json` `ignoreDependencies`, all CSS/bin seams invisible to
import analysis):

1. apps/web `tailwindcss` — `@import "tailwindcss"` in `src/styles.css`;
   delete if the web drops Tailwind.
2. apps/web `@fontsource/ibm-plex-mono` — CSS `@import` ×4 in
   `src/styles.css`; delete if the brand font changes.
3. apps/desktop `tailwindcss` — CSS `@import` in `renderer/styles.css`;
   same condition.
4. apps/desktop `@dohc/brand` — `@import "@dohc/brand/tokens.css"`; delete
   if tokens are inlined.
5. apps/desktop `@dohc/mcp` — provides the `dohc-mcp` bin on PATH that
   `mcpConfigFor` hands to agent tools (spawned, never imported); delete if
   the packaged binary override becomes the only launch path.

Measured scope limits of the knip gate (its "0 findings" covers unused
files and dependencies repo-wide, plus unused VALUE exports in
apps/services — not more):

6. `knip.json` sets `"exclude": ["types", "enumMembers"]` globally, so
   unused *type* exports are not gated. `knip --include types` reports 24
   type-only findings (hocuspocus hook payload/doc types, `MeasuredMetric`,
   `CloudSyncSnapshot`, `ChannelName`, …) — public-shape/documentation
   types left exported on purpose. Verification condition: re-run
   `pnpm check:unused -- --include types` when touching those modules;
   delete the exclusion once that list is fixed or individually tagged.
7. packages/* have no dead-EXPORT coverage: each package entry
   (`src/index.ts`) star-re-exports its modules and knip treats entry
   exports as public API, so a dead export inside packages/* yields zero
   findings (unused *files* and *deps* there are still caught —
   probe-confirmed in both directions). Verification condition: a future
   tightening pass sets `"includeEntryExports": true` and triages; until
   then, dead-export claims for packages/* rest on review, not the gate.

`scripts/check-architecture-debt.mjs` (each entry carries reason +
`deleteWhen` in-file; summarized):

1. `services/hocuspocus/src/postgres-acl.test.ts` — anti-regression
   assertion that FAILS on legacy-backend code.
2. `apps/web/src/routes/_app.shared.$shareId.tsx` — honest 404 comment for
   dead pre-pivot links.
3. `scripts/check-tech-debt.mjs` — names the historical plan FILENAME in its
   allowlist.
4. `services/app-tester/src/staticCheck.ts` (+`.test.ts`) — the trust check
   must name the legacy patterns it bans.
5. `apps/desktop/src/workspaces/appPackage.test.ts` +
   `apps/desktop/e2e/appPackage.spec.ts` — fixtures proving legacy-SDK apps
   are rejected end-to-end.
6. Media-type-table rule (owner `workspace-core/paths.ts`):
   `workspaceAssets.ts` (protocol-serving ALLOWLIST — deliberately narrower;
   unknown → octet-stream is a security property), `UploadFileButton.tsx`
   (file-picker `accept` UI), `postgresBackendClient.ts` (browser-side
   mediaType→cloud-kind mapping; the workspace-fs equivalent is Node-only),
   `workspace-postgres` `atoms.ts` + `dataImport.ts` (reverse-direction
   kind↔contentType/parser dispatch).
7. 59 historical docs by exact path (plans, reviews, execution logs, and the
   Historical-bannered docs above) may mention the old architecture; any
   other doc fails the gate.

## Tests That Prove Behavior Survived

- Full repo suite after all deletions: **15 packages, 589 tests, 0 failures**
  (web 41 — editor-v2's 60+ tests left WITH the dead feature; desktop 144;
  hocuspocus 81 incl. `.apps` plain-text source-kind; workspace-core 91 incl.
  new `mediaTypeForPath`; workspace-fs 33; sync 38; history 20; postgres 23;
  workspace-api 30; mcp 17; app-tester 29; sqlite-worker 11; contracts 10;
  performance 18; agent-sandbox 3).
- Desktop E2E 21/21 (incl. `fileTypes`, `sqliteImport` — media-type
  consolidation; `appPackage` — legacy rejection; `liveCoEditing` — collab
  hash change).
- `backendSwitch.test.tsx` pins the postgres-only seam; `cloudWebRole`
  pins the web role; `brandNoLegacy` updated (dropped its read of the
  deleted `use-theme.ts`).

## Commands Run

| Command | Outcome |
| --- | --- |
| `pnpm -r --if-present typecheck` | pass (all workspaces, post-rename) |
| `pnpm -r --if-present test` (Node 22.13) | pass — 15 suites / 589 tests |
| `pnpm build:desktop` | pass |
| `DOHC_E2E_NO_CHROMIUM_SANDBOX=1 xvfb-run -a pnpm test:desktop:e2e` | pass — 21/21 |
| `pnpm smoke:desktop` | pass |
| `node scripts/check-performance.mjs` | pass (budgets green) |
| `pnpm check:self-host` (read-only preflight) | pass (post-rename paths) |
| `pnpm check:unused` (knip) | pass — 0 findings |
| `pnpm check:debt` | pass — 4 allowlist entries |
| `pnpm check:architecture-debt` | pass — 12 allowlist entries, 59 historical docs |
| `git diff --check` | clean |
| `node scripts/dev-cloud.mjs` + `check:cloud-ready` | pass after a REAL fix — the script spawned workspace-api with `DOHC_TEST_AUTH=1` but no `NODE_ENV`, and the phase-14 hardening correctly refuses that seam outside development/test, so `pnpm dev:cloud` could never boot the API. Fixed (`NODE_ENV ?? 'development'` + bounded health wait); torn down by `kill -TERM` on the recorded pidfile pid only |

## Remaining Risk

- `path-tree.ts` carries unpopulated Convex-era row fields (see above) —
  cosmetic, tested, next tree iteration owns it.
- The historical-docs allowlist is exact-path by design; archiving
  `docs/development/v2-*` wholesale would shrink it (deletion condition:
  move them under a `docs/archive/` that the checker can class-allow).
- `workspaceAssets.ts` and the shared media table intentionally disagree
  (serving allowlist vs detection table); the checker documents why — do not
  "fix" by merging.
- Web upload media type now prefers `file.type` then the shared table —
  behavior is pinned by `backendSwitch` upload tests; new extensions belong
  in workspace-core, not call sites.
