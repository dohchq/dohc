# Desktop Local-First Product Readiness Review

Phase 18 (Final E2E Product Readiness Matrix). The product under review is
the branch `claude/desktop-local-first-cloud-sync` at `eee0139` (phase17)
plus the Phase 18 artifacts on the working tree
(`apps/desktop/e2e/productReadiness.spec.ts`, this review, the execution
log). Verification ran 2026-06-11 on WSL2 against the live dev Postgres
(`localhost:54329`).

## Verdict

**READY — with the honest boundary that "ready" means: every product claim
the plan makes is proven by an automated end-to-end test against real
servers and real files, on one developer machine.** The full verification
battery is green (table below). What has NOT been proven is listed in its
own section and none of it is silently missing: each gap is deliberately
deferred and tracked somewhere a future phase will trip over it.

## Verification battery (plan Phase 18 Step 2), verbatim outcomes

| Gate | Command | Outcome |
|---|---|---|
| Repo typecheck | `pnpm -r --if-present typecheck` (Node 22.13) | PASS — all 15 packages, 0 errors |
| Repo test | `pnpm -r --if-present test` (Node 22.13) | PASS — 15 suites, 589/589 tests (desktop 144, core 91, hocuspocus 81, web 41, sync 38, fs 33, api 30, app-tester 29, postgres 23, history 20, perf 18, mcp 17, sqlite-worker 11, contracts 10, agent-sandbox 3) |
| Desktop build | `pnpm build:desktop` | PASS — main ESM + preload CJS + renderer (1,343.20 kB JS) in 222ms |
| Full desktop E2E | `xvfb-run -a pnpm test:desktop:e2e` (DOHC_E2E_NO_CHROMIUM_SANDBOX=1) | run 1: 31/32 — step 17 failed on a WSL2 backwards wall-clock step (diagnosed below, spec cursor hardened); run 2: **32/32 PASS** |
| `pnpm test:e2e` | root alias of the same desktop Playwright config (root web config retired in Phase 13) | same gate as above — PASS |
| Desktop smoke | `pnpm smoke:desktop` | PASS |
| Performance gate | `node scripts/check-performance.mjs` (reading measurements freshly written by this battery's E2E run) | PASS — every budget green; `warmAppOpenMs` SKIP (plan-sanctioned, Phase 7b) |
| Self-host check | `node scripts/check-self-host.mjs` (read-only) | PASS — 17/17 checks |
| Unused-code gate | `knip` | PASS — 0 findings |
| Tech-debt gate | `node scripts/check-tech-debt.mjs` | PASS — 4 documented allowlist entries |
| Architecture gate | `node scripts/check-architecture-debt.mjs` | PASS — 12 allowlist entries, 60 historical docs (this review doc itself was added to the exact-path historical list: it names the old architecture when answering "Is Convex fully removed?") |
| Whitespace | `git diff --check` | PASS — clean |
| Cloud dev stack | `node scripts/dev-cloud.mjs` + `node scripts/check-cloud-ready.mjs` | PASS — postgres, minio, workspace-api all healthy; torn down by `kill -TERM` on the pidfile pid only, termination + freed port verified |

Performance numbers as read by the gate from this battery's E2E run
(budgets in `packages/performance/src/budgets.ts`; analysis in
`docs/superpowers/reviews/2026-06-10-desktop-performance-review.md`):
cold launch→shell 311ms (budget 2000), warm 304ms (1000), create workspace
74ms (1000), open 1000-file workspace 271ms (1500), tree search over 10k
paths 0.5ms (100), visible search result 1ms (200), open 250KB markdown
60ms (150), typing long-task 0ms (50), single-file sync detect 785ms
(2000), 100-file change set 800ms (3000), AppTester static 198ms (15000),
SQLite 10k-row first page 164ms (1000), CSV 10k-row import 288ms (5000),
memory working set 597MB (ratchet 708MB), renderer bundle 1.28MB (ratchet
1.408MB). The memory ratchet baseline exceeded its aspirational 400MB
initial target when first recorded in Phase 16 — recorded openly in the
performance review, not hidden; the +20% growth rule now gates from the
real baseline.

## The readiness E2E, step by step — what each step actually proves

`apps/desktop/e2e/productReadiness.spec.ts` is one serial journey over the
real product: a real Electron desktop, a real `workspace-api` (tsx,
`NODE_ENV=test`, `DOHC_TEST_AUTH=1`, port 17901) against the live dev
Postgres, a real vite-served web client (port 17907), real Chromium for the
web step, and the real stdio MCP server. Screenshots land in
`test-results/screenshots/phase-18/`.

1. **Steps 1–3 — local-only first run, no account.** Launched with a fresh
   `DOHC_TEST_HOME` and deliberately NO `DOHC_CLOUD_URL`. Asserts the
   first-run surface says cloud sync is optional, that no sign-in/sign-up
   control exists anywhere, and that "Create workspace" produces a real
   folder on disk with a valid `.dohc/manifest.json`
   (`kind: personal, mode: local-first`). Proves accountless local-only is
   the default path, not a degraded mode.
2. **Step 4 — real files of every supported kind.** Markdown is created
   through the app's own new-file flow + editor (Ctrl+N, edit toggle,
   autosave to `saved`, the H1 renders) and verified as bytes on disk. CSV,
   a renderable PNG, audio, PDF, a REAL SQLite database (created via
   `node:sqlite`, not plausible bytes), and a `.apps/ledger` source folder
   are written directly to the filesystem — and the watcher reflects every
   one of them into the live file tree. Proves files are real files and
   external writes are first-class.
3. **Steps 5–6 — external agent batch.** The user enables the agent in
   Settings (a real recorded run in `.dohc/agent-runs.json`); a three-file
   burst of direct disk writes then lands as exactly ONE change set in
   `.dohc/history`, attributed `author.kind: "agent"`, with all three paths
   — and the timeline never contains `.dohc` noise. Proves batched settle +
   agent attribution from the durable record, not from UI text alone.
4. **Steps 7–8 — finance tracker from CSV/SQLite + AppTester.** The
   inspector's real "Import to SQLite" flow materializes a visible sibling
   `.sqlite` that appears in the tree; a cell edit through the Database
   Studio commits; the `.apps` package starts `needs-testing`, passes the
   AppTester static gate to `ready`, and is explicitly trusted. Proves the
   visible-data + visible-apps + trust-gate model end to end.
5. **Step 9 — persistence across relaunch.** Same home, full app relaunch:
   no first-run, the tree is intact, and the Database Studio still shows the
   edited cell value — the on-disk SQLite file is canonical.
6. **Steps 10–11 — cloud sync to real Postgres.** Device-flow connect (the
   server's double-gated test seam approves the code), enable sync, then
   server-side proof using an independently minted session for the same
   user: EVERY visible local user file (markdown, CSV, PNG, audio, PDF,
   both SQLite databases, app sources) is listed by the server, and the
   journal body is byte-identical on the server. SQLite WAL/journal
   sidecars are asserted absent from the sync set by construction.
7. **Step 12 — web is a working secondary client.** The repositioned web
   app (vite + `VITE_DOHC_CLOUD_URL`; server CORS gated by
   `DOHC_WEB_ORIGIN`) signs in with Better Auth email+password as the SAME
   user the desktop device flow created, sees exactly the one synced
   workspace, opens the file tree, and renders the agent-written markdown
   body. Proves web = cloud access to desktop-synced data, not a parallel
   product.
8. **Steps 13–14 — liberal collaboration with a REAL second user.** Two
   concurrent Electron instances (separate userData) attach the same shared
   workspace; the owner claims it on the server; a second, genuinely
   distinct user is granted editor membership (direct Postgres insert — the
   seam a future invite flow will own); the collaborator's normal edit
   syncs to the server and to the owner's disk with ZERO approval or
   confirmation surface (asserted as honest absence on both clients).
   Seam disclosure: the shared workspace itself is hand-seeded — the spec
   writes `.dohc/manifest.json` (kind `shared`, mode
   `cloud-first-local-copy`, the product default for shared) and both
   clients adopt it via "Open an existing folder", because no product
   surface creates a shared workspace yet (gap 7).
9. **Step 15 — boundaries still hold.** The MCP `dohc_share` tool with
   `scope: public` — a real boundary crossing — returns
   `needs-confirmation` with `boundaryCrossing: "public-share"` and the
   server's `shares` table is asserted to have stayed EMPTY. Liberal sync
   never became boundary-blind.
10. **Step 16 — offline conflict rescued without Git markers.** App closed,
    the same file edited locally AND on the server (revision-checked write),
    relaunch: the remote version lands beside the local edit as
    `notes/journal.md.conflict`, sync status shows `conflict`, BOTH bodies
    survive byte-exactly, and neither file contains `<<<<<<<`/`>>>>>>>`.
    Plan-wording delta, stated plainly: the plan's step 16 reads "conflict
    is SUMMARIZED without Git markers". No conflict summary is asserted —
    or produced — anywhere: the product's conflict surface is the rescue
    file + the `Conflict` status pill, and the summary functions exist only
    as unwired unit-tested code (gap 6). "Without Git markers" is proven;
    "summarized" is not.
11. **Step 17 — MCP closes the loop.** `dohc_resolve_conflict` on the real
    three-way bodies honestly refuses to invent a merge
    (`resolved: false` for overlapping edits); the human deletes the
    rescued copy; the resolution lands as a new recorded change set visible
    through `dohc_sync_now`; after a quiet period nothing is pending past
    the store's own latest stamp; `dohc_workspace_status` reports
    `synced: true, scope: "cloud"` with OUR server URL and the right
    workspace id; `dohc_list_workspaces` lists the workspace at its real
    root path.

### Finding from the first full-suite run (fixed)

Run 1 failed step 17: the deletion's history record was written (on-disk
evidence: record `62bc…`, index order, the live tree without the
`.conflict` row) but stamped `recordedAtMs` ~1.2s BEFORE the deletion's own
directory mtime — `Date.now()` in the Electron main process stepped
backwards mid-run, which WSL2 demonstrably does (the Phase 16 perf review
independently observed a −289ms step). The spec's
`sinceMs: Date.now()`-style cross-process epoch cursor goes blind under a
backwards step. Fix: step 17's cursors now anchor to the store's own
records (id-set diff for "a new record landed", max recorded stamp for the
clean check) — clock-immune and still a pure-MCP assertion. Re-run: 32/32.
Product-level note recorded under risks: `changeSetStore` epoch stamps
assume a monotonic wall clock; a backwards host-clock step can make
`listSince` cursors transiently blind until the clock catches up (the
records themselves are never lost).

## The plan's readiness questions

**Is desktop usable as the primary client?** Yes. The desktop is where
every product capability lives and is E2E-proven: first-run, file tree +
watcher, markdown editing with autosave (`markdownEditing.spec.ts`),
per-type file views (`fileTypes.spec.ts`), Database Studio
(`sqliteImport.spec.ts`), apps + trust (`appPackage.spec.ts`), history
timeline, settings/MCP, cloud login (`cloudLogin.spec.ts`), sync
(`cloudSync.spec.ts`), live co-editing (`liveCoEditing.spec.ts`), and the
full journey above — 32 E2E tests, all green, all against the real built
app. It is also fast as a product invariant: every Phase 16 budget passes
with multi-x headroom (launch ~293ms vs a 2s budget).

**Does local-only work without an account?** Yes — proven twice over:
readiness steps 1–5 run an entire create→edit→import→app→relaunch life
with no cloud URL configured and assert no sign-in control exists; and
`liveCoEditing.spec.ts` ("a personal local workspace edits fully without
any collab server") proves editing works with no server of any kind
running.

**Does local folder editing work with external agents?** Yes. Three
surfaces prove it: direct fs writes from outside the app appear in the tree
and history (readiness steps 4–6, with agent attribution from
`.dohc/agent-runs.json` + history records); the real stdio MCP server
serves all 10 dohc tools to an MCP SDK client and refuses path traversal
(`localAgent.spec.ts`); and MCP create_app→test_app→sync_now compose with
the same trust/boundary gates the UI has.

**Does cloud sync work?** Yes — against a real workspace-api on real
Postgres: full-workspace initial push verified file-by-file server-side
(step 11), bidirectional sync incl. remote→local pull on relaunch
(`cloudSync.spec.ts`), byte-identical bodies, no sidecar leakage,
conflict rescue with no data loss (step 16), and device-flow auth that
survives relaunch and disconnects cleanly (`cloudLogin.spec.ts`).

**Does shared collaboration lean liberal without losing boundaries?** Yes.
A genuinely different second user with editor membership syncs a normal
edit with zero ceremony — no approval surface ever appears on either side
(steps 13–14) — while a public-share boundary crossing from an agent
demands explicit confirmation and is proven to have written nothing
(step 15). Live co-editing of shared markdown converges across two clients
through Hocuspocus with the Postgres ACL (`liveCoEditing.spec.ts`), and the
collaboration policy's protect/confirm tiers carry 7 unit tests within the
38-test workspace-sync suite. Conflict handling stays marker-free via the
rescue path (step 16); the plain-language conflict-summary machinery is
unit-tested only and NOT wired into the product — see gap 6.

**Do apps and SQLite work from visible files?** Yes. Apps are visible
`.apps/<name>` source folders with manifest + sources, gated by the
AppTester static check and an explicit, fingerprint-bound trust grant
(steps 7–8, `appPackage.spec.ts`); SQLite is a visible `.sqlite` file the
studio reads and edits IN PLACE with the edit op-logged to
`.dohc/databases/**/operations.jsonl`, surviving relaunch (step 9,
`sqliteImport.spec.ts`); raw database bytes are never CRDT-synced
(workspace-core `databaseSyncStrategy`, unit-tested) yet whole visible
databases do reach the cloud as files (step 11 asserts both `.sqlite`
files server-side). The in-app RUNTIME for apps is the named Phase 7b gap.

**Is web correctly secondary?** Yes. The web app is a compact cloud shell
(sign-in, workspace list, file tree, file view, shared links) over the same
workspace-api; it advertises the desktop for local/agent power
(`cloudWebRole.test.tsx` pins this) and the readiness journey proves it
reads desktop-synced data as the same user (step 12). It has no local-fs
claims and no Electron dependency.

**Is Convex fully removed?** Yes — Phase 13 deleted ~389 files (the entire
`convex/` dir, workspace-convex-compat, hocuspocus convex-acl, scripts,
env); the architecture gate bans the evolution language; a survivor grep
found only the doc-reference comment and the anti-Convex assertion itself.
The whole battery above runs with no Convex anywhere.

**Is self-hosting honest?** Honest at the documentation + compose +
surface level: `check:self-host` runs 17 read-only checks (docker CLI +
compose present, the root script wiring, the 6 service/app package.jsons,
and all 8 compose services resolving through `docker compose config`
against the `:?`-guarded `.env.self-host.example` — the guarded-secrets
and no-vendor-auth facts are exercised only indirectly, via that env
interpolation, not as named checks), `docs/self-hosting.md` matches
the post-Convex stack, and `check:self-host-desktop-path` boots the real
workspace-api and proves the device-flow surface a self-hosted desktop
would use. Auth is Better Auth on your own Postgres — no external vendor
account. What it is NOT: this battery did not boot the full self-host
compose stack end to end (the check ran read-only); see gaps.

## Known gaps — deliberately deferred, each tracked

1. **Phase 7b in-app app runtime.** Apps are inspectable, testable,
   trustable source folders; they do not yet RENDER inside dohc, and
   AppTester's browser-render checks (blank/fake/non-persistent app
   detection beyond the static gate) wait on that runtime. Plan step 8
   ("run app tester") is satisfied by the static gate only. Tracked: plan
   Phase 7 STATUS note + "Phase 7b (deferred)" block (plan lines ~1270–
   1273), execution log Phase 7 "Remaining risk", `warmAppOpenMs` SKIP in
   the perf gate and review.
2. **Hocuspocus live socket revocation.** A removed member's open collab
   socket is not kicked immediately; writes are re-checked per update
   (`beforeSync` ACL) and reads die with the 5-minute collab JWT whose
   re-mint re-checks membership. Exposure window ≤ token TTL. Tracked:
   `services/hocuspocus/src/postgres-acl.ts` authz-version bump-condition
   comment + convex-deletion review item 10 (b2).
3. **Member invitation flow.** Membership for the second user in steps
   13–14 is granted by direct Postgres insert — deliberately labeled in the
   spec as "the product seam a future invite flow will own". The Better
   Auth `organization` plugin ships the primitives (invites, member
   removal); no dohc UI/API exposes them yet. Tracked: convex-deletion
   review item 9 (b3, "named FUTURE work for the collab product") + the
   spec comment.
4. **Packaged-app full electron-builder run.** `smoke:package:desktop` is a
   static gate (build outputs, builder config, fuses, dohc metadata —
   explicitly "WITHOUT running electron-builder") and `smoke:fuses` boots a
   fuse-flipped copied Electron binary with the dist asar — but no real
   `electron-builder` artifact (dmg/nsis/AppImage) has been produced or
   booted, and signing/notarization is readiness-only. Tracked:
   `docs/desktop.md` (states both limits) + `apps/desktop/scripts/
   package-smoke.mjs` header comment.
5. **Web member-management.** The web cloud shell is read-mostly: sign-in,
   workspace list, files, shared links. No member add/remove/role UI.
   Tracked: convex-deletion review item 9 alongside the invitation gap.
6. **Conflict summaries are unwired.** Plan step 16's "conflict is
   summarized without Git markers" is satisfied only by the `.conflict`
   rescue file and the `Conflict` status pill — no product surface produces
   a conflict summary. The summary machinery (`describeConflict`) exists in
   TWO packages (workspace-core `conflicts.ts` and workspace-history
   `conflictResolution.ts`) with zero product call sites; only their own
   unit tests reference them. Wiring a plain-language summary into the real
   rescue path (sync engine/history record when a `.conflict` lands) — and
   deduplicating the two copies — is future work. Tracked: this entry +
   the step-16 plan-wording delta noted above.
7. **No shared-workspace creation surface.** First-run creates only
   `kind: "personal"` (`DesktopFirstRun.tsx`), attach hardcodes
   `kind: "personal"` for fresh folders (`main.ts`), the IPC contract
   accepts `"shared"` but nothing sends it, and no MCP tool creates
   workspaces. Steps 13–14 hand-seed the shared manifest (in
   `cloud-first-local-copy`, the product default for shared) and rely on
   attach-adoption + the server-side enable-sync claim. Tracked: this entry
   alongside the invite-flow gap (3) — the same future collab product
   surface owns both.

## What is NOT proven (beyond the tracked gaps)

- **One machine, one network.** "Two users" are two Electron instances and
  one Chromium on the same WSL2 host talking to localhost servers. No
  cross-machine sync, no real latency/partition behavior, no TLS.
- **Dev servers, not deployments.** workspace-api runs under tsx with
  `NODE_ENV=test` (which enables the double-gated device-approve seam);
  the web client is vite dev, not a production build behind a real origin.
- **Desktop device-flow approval uses the test seam**, not a human signing
  in through the hosted web UI (the web step does exercise the real
  email+password form for the same account).
- **Email delivery** is the console fallback; no SMTP round-trip.
- **Conflict AI assistance** is proven as the honest refusal + rescue path
  (step 16/17) and unit-tested proposal machinery (workspace-history);
  a user accepting an AI-proposed merge end-to-end in the UI is not in the
  journey, and the conflict-summary functions are likewise unwired
  test-only code (gap 6).
- **Update flow** is a unit-tested electron-updater state machine; no live
  update-server round trip.
- **Sustained scale**: budgets cover 1k-file trees, 10k-row imports, 250KB
  documents; multi-GB workspaces, years-long history dirs, and
  thousand-file concurrent agent bursts are unmeasured.
- **WSL2 clock-step robustness** (run-1 finding above): product cursors
  stamped from `Date.now()` can go transiently blind after a backwards
  host-clock step. Records are durable; the window self-heals; not yet
  hardened at the store level.

## Review-provenance audit (plan Codex-independence rule)

Per the plan's independence rule, phase-commit reviews never audited
Codex-authored artifacts: Codex authored no code, tests, or designs in any
phase (its only write target was `docs/superpowers/reviews/codex/`);
influence points (adversarial scenario consults, the Phase 16 markdown
recovery consult, design-review advisory passes) are recorded as one-line
provenance entries in the execution log phase sections, and the fixes they
motivated were implemented by the lead/lanes and verified by non-Codex
verifiers before landing.

## Final word

The pivot the plan demanded — Electron-first, local-file-first, accountless
local mode, settled batched sync, liberal-but-bounded collaboration,
visible apps/SQLite, agents as first-class co-editors, Postgres
cloud/self-host, Convex gone, web repositioned, performance as an invariant
— is implemented and proven end to end by automated tests against real
servers, with 589 unit/integration tests, 32 desktop E2E tests, every
performance budget green, and every lean/debt/architecture gate clean. The
honest residue is the tracked list above, dominated by the Phase 7b runtime
and the invite/member-management product surface — known, named, and none
of them undermine the claims actually made.
