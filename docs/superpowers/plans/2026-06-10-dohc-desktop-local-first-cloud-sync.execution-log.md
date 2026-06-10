# Desktop Local-First Cloud Sync Execution Log

## Resume Snapshot (overwrite in place — the ONLY mutable section)

- Phase/Step + TDD position: Phase 4 COMMITTED (ce6910a) — POST-PHASE-4 CHECKPOINT in flight (first major checkpoint: Electron security/IPC)
- Expected test state: workspace-core 40/40, desktop 37/37, E2E 4/4, smoke green — all committed
- Dirty files and intent: this log only
- Exact next action: checkpoint results return → triage confirmed findings (fix round, max 2) → transcribe valuable adversarial scenarios into owned tests → phase4(fix) commit if needed → checkpoint section in log → Phase 5 (watcher/batched-sync/history: recon fan-out + contracts-first, then 3 worktree lanes per parallelism map)
- Active background tasks: weh6pbxub (checkpoint workflow: 4 finders → per-finding verifiers), bmrbeuj0b (codex commit review phase-04 + checkpoint --base main, sequential xhigh → docs/superpowers/reviews/codex/{phase-04,checkpoint-phase-04}.md), bhdmd3rzd (adversarial scenario consult → adversarial-scenarios-phase-04.md)
- Open worktrees: none (verifier worktrees are self-cleaning)
- Pending reviews: codex phase-04 + checkpoint (in flight)
- Git state: 11 commits on branch; commits ce6910a/f630682/c2c288c/529c0d4/d9a5883/7781d02/f405074/67d692f/26f9f70/7df1553 atop e2de7a3

## Environment (append-only)

- Toolchain freeze: tests run under Node v22.13.0 via PATH prefix `/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH`. Shell default is Node v25.2.1 — Node 25 breaks 17 @dohc/web tests (verified 2026-06-10: AtomEditor.lifecycle suite 13/13 fail on 25, 13/13 pass on 22.13). Never run `nvm use`.
- pnpm 10.24.0 (packageManager pin).
- Codex: `/home/ice/.local/share/nvm/v25.2.1/bin/codex` (codex-cli 0.130.0, ChatGPT auth). Verified: `exec` read-only sandbox + `-m gpt-5.5 -c model_reasoning_effort="xhigh"` works (2026-06-10, 15.2K tokens). `gpt-5.5-fast` NOT available on this auth. Second install exists at `/mnt/c/Users/ice/.codex/bin/wsl/81645c5d269e0fb2/codex` (0.137.0-alpha.4, found by team audit) — using the verified 0.130.0; revisit only if review subcommand misbehaves.
- Display: WSL2 + WSLg (DISPLAY=:0, WAYLAND=wayland-0); xvfb-run available as fallback.
- Docker 29.5.2. Services healthy: dohc-v2-postgres, dohc-v2-minio, dohc-v2-hocuspocus (compose: docker-compose.dev.yml).
- WSL safety: never pattern-kill node/pnpm/vite/etc.; servers always background tasks; kill only tracked task ids.

### Codex Calls ledger (date | purpose | effort | duration | outcome)

- 2026-06-10 | preflight exec read-only smoke ("OK") | xhigh | ~1min | success
- 2026-06-10 | preflight gpt-5.5-fast probe | xhigh | ~10s | model rejected on ChatGPT auth (expected)
- 2026-06-10 | preflight -i image (arg-prompt form) | low | ~5s | FAILED: positional prompt not parsed with -i in detached-stdin context
- 2026-06-10 | preflight -i image (stdin `-` form) | low | ~1min | success — correctly described dohc avatar; -i capability VERIFIED
- 2026-06-10 | phase 0 review --commit+prompt (x2: 0.130 and 0.137 binaries) | high | ~5s each | FAILED: --commit rejects custom prompt; pattern corrected in plan
- 2026-06-10 | phase 0 review --commit 7df1553 promptless | high | ~7min | success — 3 P2 findings on baseline script, all confirmed real, all fixed

## Decision Ledger (append-only)

- D-01 | Better Auth inside workspace-api (Drizzle/pg, organization + deviceAuthorization plugins); WorkOS deferred as enterprise SSO path behind Better Auth | self-host needs vendor-free auth; WorkOS bridge stays open | pre-phase
- D-02 | Live co-editing (Yjs/Hocuspocus) in scope; hocuspocus convex-acl → postgres-acl | user decision | pre-phase
- D-03 | Single mega-branch `claude/desktop-local-first-cloud-sync`, green-milestone commits `phaseN(step M):`, no squash | user decision + resumability | pre-phase
- D-04 | Native orchestration replaces superpowers skill (lanes, judge panels, verifier fan-outs, checkpoint recipe) | skill unavailable; codified in plan | pre-phase
- D-05 | Codex = independent third-party reviewer with effort tiering, budget ledger, fallback chain; NEVER authors code/tests/designs | independence is the value; panel + team audit | pre-phase
- D-06 | Node 22.13.0 frozen for tests; codex by absolute path | Node 25 breaks 17 web tests; PATH drift | pre-phase
- D-07 | CRDT canonical while shared file open, filesystem canonical while closed; 6 named data-loss cases must be tested | team audit + plan amendment | pre-phase
- D-08 | dual-backend code lives in main at bc62bd2; stale local branch of same name must never be used | recon | pre-phase

## Reference Digests (append-only)

### Dual-backend branch digest (source: 2026-06-09 execution log + readiness review + tech-debt audit; digested 2026-06-10)

- All 9 packages/services mature and tested: workspace-contracts (conformance harness, 8 tests), workspace-postgres (Drizzle schema/migrations/repos/services, 12 tests, dev-ready, zero Convex coupling), workspace-fs (materialize/scan/diff/apply/syncClient/watch — watch is POLLING, 6 tests), workspace-api (HTTP handler + ResolveActor at src/auth/session.ts, 1 test, no production listener), agent-sandbox (allowlist shell, diff capture, 2+4 tests), sqlite-worker (11 tests; needs node:sqlite ⇒ Node 22.13+), app-tester (25 tests, backend matrix), hocuspocus (78 tests, Convex-coupled ACL), workspace-convex-compat (conformance-only consumer: workspace-contracts tests).
- Final sweep: 1619 web tests passed under Node 22.13. Postgres pkg tests need `--no-file-parallelism` (shared DB fixture).
- Production gates NOT done (this plan's work): hosted auth, live Yjs over Postgres, migration, deployment, observability.
- Known debt w/ deletion conditions: .views compat (until indexed discovery + regression tests), confirmTier/views/entities mode comments, dual-backend switch (until Postgres default), convex-compat (until Convex off production).
- Gotchas: pnpm install required after adding new packages (symlinks); MinIO image pinned; sync apply sequential (no idempotency keys yet); approval surfacing partial (errors not cards); upsertAtomImpl adds frontmatter — corrupts non-markdown bodies (use deriveSearchFields for text files); sandbox guards are arg-level, not namespace isolation.

### Convex usage map digest (source: apps/app/convex + repo grep; digested 2026-06-10)

- Auth: WorkOS AuthKit via `@convex-dev/workos-authkit`; client bridge apps/app/src/lib/use-auth-bridge.ts + ConvexProviderWithAuth in routes/__root.tsx; server auth.config.ts (WorkOS RS256 issuer, env WORKOS_CLIENT_ID); actor = ctx.auth.getUserIdentity() {subject, email, name, tokenIdentifier}; requireWorkspace(ctx, activeWorkspaceId) checks memberships.
- Convex function surface: ~40 modules — auth, schema (atoms/atomShares/atomLocks/memberships/orgs/workspaceAssets/databaseFiles/...), agent.ts (@convex-dev/agent tools), hocuspocusAuth.ts (ACL queries: checkAtomAccess/loadAtomBootstrap/setBodyCache/createAtom), atoms/atomAccess/atomShares, assets (storage upload URLs), databaseFiles/databaseOps, apps/appAgent/appTesting/appTrust, views/windows, trash, captures, crons (purges), search.
- Non-convex importers: apps/app/src/lib/convex-client.ts, use-auth-bridge.ts, routes/__root.tsx, components/Chat.tsx (+chat-optimistic), routes/r/$atomId.tsx (share SSR); services/hocuspocus/src/convex-acl.ts + server.ts (env HOCUSPOCUS_CONVEX_URL + HOCUSPOCUS_CONVEX_SERVER_TOKEN); packages/workspace-convex-compat/testAdapter.ts.
- convex-acl.ts exports createConvexAcl(): getWorkspaceAuthzVersion/canReadAtom/canWriteAtom/loadAtomBootstrap/setAtomBodyCache/createAtom — Postgres port must replicate these against workspace-postgres grants + Better Auth sessions.
- Env to delete in P13: CONVEX_DEPLOYMENT, VITE_CONVEX_URL, VITE_CONVEX_SITE_URL, WORKOS_*, HOCUSPOCUS_CONVEX_*; scripts: dev-sync.mjs convex parts, reset:dev.
- Convex guidelines key porting rules: server-derived identity only (never trust client identity args); index-based queries (no .filter); storage = Blob + signed URLs; crons via crons.interval/cron; validators on every function.

### t3code desktop renderer digest (source: /home/ice/dev/oss-repos/t3code/apps/desktop; digested 2026-06-10)

- Security posture matches ours exactly: contextIsolation+sandbox+no nodeIntegration (src/window/DesktopWindow.ts:190); `setWindowOpenHandler` denies ALL window.open, externals via shell.openExternal (DesktopWindow.ts:246-251); `will-navigate` blocks off-origin (252-266); single-instance lock early (src/electron/ElectronApp.ts:103). ADOPT all.
- Bridge: contextBridge.exposeInMainWorld("desktopBridge", ...), `desktop:`-prefixed channels (src/ipc/channels.ts), schema-validated codecs per method (src/ipc/DesktopIpc.ts:132-221 — they use Effect Schema; dohc uses zod per plan). Event listeners return unsubscribe fns. ADOPT shape, zod instead.
- Titlebar: platform-aware custom chrome — macOS hiddenInset + trafficLightPosition {16,18}; Win/Linux hidden + titleBarOverlay {height:40, theme-synced symbolColor} (DesktopWindow.ts:106-139). Window starts `show:false`, reveals on first load. min 840x620. ADOPT for Phase 3.
- Updates: electron-updater state machine idle→checking→available→downloading→downloaded→installing with reducer fns (src/updates/DesktopUpdates.ts) — ADOPT reducer-style state machine for Phase 14 tests.
- Smoke: scripts/smoke-test.mjs spawns Electron 8s, greps stderr for fatal patterns. ADOPT for Phase 2 smoke.
- REJECT: Effect-based layer architecture (overkill; plain TS + promises), sync IPC for hot data (async everything except immutable bootstrap), custom launcher plist patching (electron-builder instead), their no-Playwright gap (we add real Playwright Electron E2E).

### Component reuse map digest (source: docs/superpowers/reviews/2026-06-10-desktop-component-reuse-map.md; 2026-06-10)

- Counts: 20 reuse-as-is, 16 port-with-swap, 3 rebuild (Chat, WorkspaceSwitcher, WorkspaceManagementDialog), 3 skip (Onboarding, SharedAtomView, NotFoundPage). Exactly 18 files import convex/react|@convex-dev|@tanstack/react-router directly.
- Styling: Tailwind v4.2.4 CSS-first, NO tailwind.config — everything via `@theme inline` + `@custom-variant dark` (data-theme) in apps/app/src/styles.css (2,695 lines). Brand tokens: packages/brand/src/tokens.css (export `@dohc/brand/tokens.css`) — warm paper #f7f6f1, graphite #151515. TRAP/consolidation target (Phase 17): styles.css duplicates the brand palette instead of importing tokens.css.
- Desktop renderer needs: react, react-dom, tailwindcss, @tailwindcss/vite, @dohc/brand, @fontsource(s) — extract shared token layer rather than copy.
- Phase 3 pulls as-is: ActivityBar, SidebarChrome, Skeleton, NoticeCenter, AgentActivityTimeline, AgentRunRail, AgentModelPicker. Small swaps: FileTree (fully props-driven; only Convex via UploadFileButton import), CommandPalette (3 useQuery + extract OPEN_SKETCH_EVENT constant — else drags AtomEditor+Convex transitively). Rebuild WorkspaceSwitcher against bridge WorkspaceRegistryResult. Model shell layout/keyboard map on apps/app/src/routes/_app.tsx.
- Phase 6+: FileTypeView, DatabaseStudio, DatabaseTableGrid clean+props-driven (as-is); HtmlAtomFrame/SearchOverlay swaps; Chat transport rebuild in Phase 11 (useUIMessages is structurally Convex), presentational children reusable.
- Traps: AgentChatSidebar transitively renders WorkspaceSwitcher (Convex+router); UploadFileButton calls useMutation unconditionally (crashes without ConvexProvider); type-only Convex imports in DatabaseTableGrid/storageUpload need re-homing before Phase 13.

### Port-source file paths (verified present 2026-06-10)

- File-type views: apps/app/src/components/FileTypeView.tsx; Database Studio: DatabaseStudio.tsx, DatabaseTableGrid.tsx; tree: FileTree.tsx; upload: UploadFileButton.tsx; agent activity: AgentActivityTimeline.tsx, AgentRunRail.tsx (+ AgentChatSidebar.tsx).

## Gotchas (append-only)

- Node 25 breaks 17 @dohc/web tests; pin 22.13.0 via PATH (see Environment).
- workspace-postgres tests: shared local DB fixture, not file-parallel.
- pnpm 10 ignores postinstall — Electron needs onlyBuiltDependencies in pnpm-workspace.yaml BEFORE install (Phase 2).
- Root playwright.config.ts is web-only (testDir apps/app/e2e + webServer); desktop gets own config.
- check:debt bans the literal deferred-work marker tokens it scans for, in any file including docs — never write them, even when describing the rule itself (this line was rewritten once for exactly that reason).
- RED runs of path-handling tests can pollute the working tree (a not-yet-rejected relative path created real dirs under apps/desktop cwd). Inspect `git status --short` BEFORE every `git add` of a directory; never blind-add after running new filesystem tests.
- Package named @dohc/web already, but lives at apps/app (Phase 12 renames path).
- ECONNREFUSED from :5432/:9000/:1234 = environment failure, never a test failure.
- codex exec with `-i`: pass the prompt via stdin pipe + `-` arg (`echo "prompt" | codex exec -i img.png -`); positional prompt is silently dropped when stdin is detached.
- Pre-existing failures on main @ e2de7a3 (fail under BOTH Node 22.13 and 25; broke between dual-backend sweep and merge): apps/app/convex/agentSandboxIntegration.test.ts ("teaches the model when to use shell" — AGENT_SRC prompt strings), src/__tests__/agentApprovalResume.test.tsx ("returns explicit scoped approval decisions"), src/__tests__/searchWriteAudit.test.ts ("no atom-inserting convex file outside the known set"), src/__tests__/uploadFiles.test.tsx ("exposes an upload button in the file sidebar area"). 4 tests / 1618 passed. NOT fixed in Phase 0 — these are main's bugs; several die with Convex in Phase 13 anyway.

## Checkpoint 1 (post-Phase-4): Electron security & IPC — FIXES APPLIED (commit pending)

Range reviewed: git diff main...HEAD (11 commits). Three streams: workflow weh6pbxub (4 finders → 31 agents → 25 confirmed, 2 rejected); codex commit phase-04 (+2: UNC root, case-variant home) + checkpoint --base main (re-listed already-fixed Phase 3 items, stale); adversarial consult (26 scenarios).

Fix round (one disciplined grouped pass; re-verify wf_29173c80-3a2):
- HIGH symlink write-escape (createFile) → realpath parent + containment assert; regression test added.
- HIGH registry version-wipe + non-atomic write → read() throws on version!=1/corrupt (never collapses to empty); write() temp+rename atomic; parsed cache; tests added.
- HIGH malformed-manifest adoption → checkManifest (workspace-core) validates version/workspaceId/kind/mode; adopt only valid; refuse newer-version; corrupt/invalid blocked not overwritten; wx on fresh manifest; tests added.
- MED renderer-controlled arbitrary root (#4) → approvedRoots binding in main (only the default suggestion + real dialog picks, or descendants, are usable); pick seam double-gated.
- MED listFiles follows symlinks → skip all symlinks; test added.
- MED // leading-double-slash home bypass + UNC root + case-variant home → normalizeAbsolutePath collapses POSIX //, UNC-root regex, case-insensitive home compare; tests added.
- MED future-version manifest overwrite → folded into checkManifest newer-version refusal.
- LOW manifest no-wx → wx flag.
- code-size/lean: deleted createFileRecord+FileRecord (dead), deleted getVersion channel/handler/schema/preload/mock (consumer-less), single-sourced WORKSPACE_KINDS/MODES tuples (workspace-core) feeding zod enums, preload typed as DohcDesktopBridge (kills kind:string drift), listFiles identity-ternary removed, importFiles calls refreshFiles, Overlay component extracted (3 modals), e2e launchApp helper (4 sites), IPC string length caps.
- perf-structure correctness: registry parsed-data cache (no readFileSync per IPC), navigationPolicy module-memo, firstPaint fires on real content mount (not blank-frame rAF), memoized FileRow + stable onSelect, capped palette rows (50). DEFERRED to Phase 16: true windowing/virtualization of file tree + palette (logged); IPC launch-waterfall + per-create re-list merge (#24).
- Rejected by verifiers (2): setRemote/RemoteIdentity speculative (kept — Phase 9 consumer, logged); listFiles caps "unbounded" (Phase 16 perf gate owns depth/entry caps).
- DEFERRED with reason: test-bridge build-strip (preload env-only gate; handler is authoritative double-gate; build define → Phase 14); TOCTOU symlink swaps (#19,23 defense-in-depth vs static escapes now fixed); changeSet/conflicts still test-only (Phase 1-mandated, Phase 5/10 consume).
- Codex re-listed Phase-3 items in --base main (idempotent manifest, require-absolute, clear-state-on-switch) — all already fixed in c2c288c/phase4; confirmed not regressions.

Post-fix gate: workspace-core 47/47, desktop 42/42, typecheck, build, E2E 4/4, smoke — all green.

Re-verification (wf_29173c80-3a2): all 3 HIGH fixes confirmed FIXED with empirical proof — symlink verifier ran live tests (O_EXCL blocks final-segment symlink escape; realpath resolves relative targets); registry verifier confirmed read() throws before any write() so a real file is never clobbered, cache can't mask corruption; root verifier confirmed approvedRoots is renderer-unreachable except via dialog/default and legitimate create+attach still pass. One LOW residual flagged (mkdir-before-containment could create empty dirs outside via pre-planted symlink) — CLOSED: containment now checked against deepest-existing-ancestor BEFORE mkdir, plus post-mkdir re-check. CHECKPOINT 1 PASS.

## Checkpoint 1 (post-Phase-4): Electron security & IPC — original triage notes

Streams: workflow weh6pbxub (4 finders → per-finding verifiers); codex commit phase-04 + checkpoint --base main (bmrbeuj0b); adversarial scenario consult (DONE → docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md, 26 scenarios).

Consult high-value batches (await verifier confirmation before fixing; transcribe confirmed into owned tests):
- SYMLINK ESCAPES (15,18-23): lexical normalization doesn't resolve symlinks — a workspace root, subdirectory, or import path that's a symlink can escape the workspace/home guard. Coherent fix: realpath + containment assertion at root-choice (createWorkspaceFolder service boundary, not just main.ts) and at createFile/listFiles/import real-destination. Threat model justifies it: user opens a folder they were given; their agent operates on files.
- REGISTRY READ-TIME TRUST (8,9): findWorkspace returns persisted entries without revalidation — poisoned registry root="/" or duplicate-id → file ops mistargeted. Fix: revalidate entry root + reject duplicate-id at READ, not only register.
- REGISTRY JSON ROBUSTNESS (6,7): __proto__ pollution + non-array workspaces shape → fail closed. Fix: null-proto parse / shape guard / zod on read.
- IPC PAYLOAD CAPS (2,3): no length cap on relativePath/workspaceId → DoS. Fix: zod .max() bounds.
- SERVICE-BOUNDARY GUARD (14): createWorkspaceFolder only runs validateAttachedFolder, not the root-choice guard — guard belongs at the service, not only the handler.
- IPC-LEVEL SENDER/PAYLOAD TESTS (1,4,5,10,11,12): mostly covered behaviorally but no direct IPC-handler unit tests. Consider a thin handler test harness.
- Likely-rejects/low (24,26 already covered by canonicalization+separator normalization; 25 multi-process race is out of scope for single-instance-locked app; 19,23 TOCTOU are defense-in-depth, lower priority than the static symlink escapes).

## Phase Logs

### Phase 0: Baseline, Tooling, And Old-Plan Inventory

- Status: in progress
- Execution map: env preflight (done: services healthy, node/codex/display recorded) → execution log (this file) → baseline script Node-pinned → baseline background run → inventory doc from recon digests → commit → codex review (high tier, background)
- Resume notes: baseline launching; inventory doc next; commit after baseline result recorded.
- Files changed: AGENTS.md (product philosophy: three legs, git-for-everyday-people, fast-is-a-feature, less-code; pivot note), plan (all pre-execution amendments), package.json (+check:desktop-local-first-baseline), scripts/check-desktop-local-first-baseline.mjs (new, Node-pinned), this log (new), inventory doc (new), team audit doc (committed as-is)
- Code deleted or consolidated: none (docs/tooling phase)
- Net LOC delta (`git diff --shortstat`): recorded at commit
- Old paths retained and why: all — inventory classifies, later phases delete
- Dependencies added (name, size, justification): none
- Decisions made (D-NN ids): D-01..D-08 (pre-execution, recorded above)
- Tests added: none (baseline phase)
- Commands run: docker compose ps (healthy); node path checks; component path verification; `pnpm check:desktop-local-first-baseline` (Node-pinned, background) — @dohc/web typecheck PASS, web tests 1618/1623 PASS (4 pre-existing, recorded in Gotchas); continue-on-error sweep of remaining suites — workspace-contracts 10/10, workspace-postgres 14/14, workspace-fs 8/8, workspace-api 3/3, app-tester 25/25, sqlite-worker 11/11, agent-sandbox 3/3, check:debt PASS (after rewording two self-tripping doc lines), web typecheck PASS
- Failing tests fixed: n/a — 4 web failures are pre-existing on main @ e2de7a3, recorded not fixed (several die with Convex in Phase 13)
- Electron E2E/manual smoke: n/a (no desktop app yet)
- UI/UX screenshot/design review: n/a
- Performance measurements: n/a
- Security/collaboration regressions: n/a
- Reviewer/subagent findings: recon digests above; 4-lens plan panel + Codex-utilization panel + 2 team audits all folded into plan pre-execution
- Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-00.md): (1) baseline script fail-fasts on known web failures, can't reproduce recorded baseline at later gates — FIXED @ phase0(fix) commit (continue-on-error + summary + known-failure allowance that dies in Phase 13); (2) baseline omits @dohc/hocuspocus and @dohc/workspace-convex-compat suites — FIXED (both added); (3) pinned-Node path silently falls back to caller PATH on other machines — FIXED (existsSync check, DOHC_TEST_NODE_BIN override, hard error). Invocation gotcha discovered: `--commit` cannot combine with custom prompt (both codex versions) — plan updated with working pattern.
- Relevant findings fixed: all 3 codex P2s fixed in follow-up commit; plan-level findings fixed pre-execution
- Deferred findings with reason: none
- Remaining risk: baseline may surface pre-existing failures beyond the known Node issue — will be recorded verbatim, not fixed here
- Next phase: 1

### Phase 1: Local-First Workspace Core Contract

- Status: in progress (GREEN reached; verifiers running; commit pending)
- Execution map: tests-first for workspaceMode/paths/changeSet (written during Phase 0 review window) → pnpm install → RED recorded (3 files fail on missing modules) → implement 6 src modules → GREEN 28/28 + typecheck → verifier fan-out (test-quality worktree + claimed-vs-actual) → log → commit → codex review (high tier)
- Resume notes: if interrupted post-GREEN: verifiers wf_2b9debfd-c61; commit phase1 after pass.
- Files changed: packages/workspace-core/* (package.json, tsconfig.json, src: workspaceMode, metadata, paths, changeSet, conflicts, index + 3 test files), pnpm-lock.yaml (+12 lines, importer entry only)
- Code deleted or consolidated: none new; overlap with workspace-contracts recorded below
- Net LOC delta (`git diff --shortstat`): ~395 lines src+tests in new package; lockfile +12
- Old paths retained and why: workspace-contracts `WorkspacePath` (zod) + `composeRenamedPath` overlap workspace-core path validation — retained, live consumers in old API surface; consolidation owner = workspace-core per Phase 17 table (single path-validation owner). workspace-contracts domain types (AtomKind etc.) remain the old API's contract; workspace-core owns the NEW local-first model (modes/manifest/change sets) — no duplication between them today.
- Dependencies added (name, size, justification): none runtime; devDeps typescript/vitest/@types/node only (workspace conventions)
- Decisions made (D-NN ids): D-09 | workspace-core has zero runtime deps (no zod) — pure TS contract package; validation stays structural | smallest implementation; zod arrives only when IPC schemas need it (desktop-bridge) | phase 1
- Tests added: 31 (modes 4, paths 19, changeSet/conflicts 8) — covers all plan-required assertions incl. per-workspace-not-per-file mode, encoded/double-encoded/backslash traversal, reserved .dohc, .apps/.sqlite classification, 5 boundary crossings, marker-free conflict summaries
- Commands run: pnpm install (3.7s, links new package); workspace-core test (RED: 3 files fail missing modules → GREEN: 28/28); typecheck PASS — all under pinned Node 22.13
- Failing tests fixed: RED→GREEN by implementation only; no test weakened
- Electron E2E/manual smoke: n/a (pure contract package)
- UI/UX screenshot/design review: n/a
- Performance measurements: n/a (no measurable surface; tests run in 305ms)
- Security/collaboration regressions: path traversal coverage incl. %2e and backslash variants; boundary-crossing review gate asserted per crossing
- Reviewer/subagent findings: verifier workflow wf_2b9debfd-c61 — test-quality PASS (worktree revert: 0 tests pass without implementation; reason-specific assertions confirmed); claimed-vs-actual PASS (all plan files present, all claims re-verified independently, cheat scan clean). Finding 1: double-encoded traversal (%252e) passed single-pass decoding — FIXED pre-commit (decode-until-stable + 3 new traversal cases, 31/31). Finding 2 (note): repo .nvmrc pins 24.14.0 (not installed); our freeze is the documented 22.13.0 PATH prefix — consistent with engines, recorded.
- Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-01.md): (1) P1 case-insensitive .DOHC bypasses reserved guard on mac/Windows filesystems — FIXED (case-insensitive isReservedPath + tests); (2) P1 Windows drive-qualified paths (C:\...) pass absolute check, escape workspace after backslash normalization — FIXED (isAbsolutePathLike: POSIX + drive + UNC, checked raw and post-decode + tests); (3) P2 Windows absolute attached folders wrongly rejected — FIXED (same helper + tests). 35/35 green after fixes.
- Relevant findings fixed: verifier finding 1 + all 3 codex findings fixed in phase1(fix) commit
- Deferred findings with reason: none
- Remaining risk: API shapes may evolve when Phase 4 (registry) and Phase 5 (history) consume them — acceptable, contract-first by design
- Next phase: 2

### Phase 2: Electron Desktop Scaffold And Test Harness

- Status: in progress (all gates green; verifiers running; commit pending)
- Execution map: tests-first (security unit + launch E2E + dedicated playwright config, written during phase-01 review window) → pnpm-workspace onlyBuiltDependencies → install (electron 42.4.0 binary verified) → unit RED recorded (missing module) → implement (main/preload/window/security/channels/bridgeContract/launchMarks/renderer/electron.vite.config/vitest.config/smoke) → unit GREEN 7/7 + typecheck + build → E2E pass (first try, WSLg, no xvfb needed) → smoke pass → screenshot inspected → verifiers → commit → codex review (xhigh tier)
- Resume notes: verifiers wf_7528cd05-564 in flight; commit phase2 on pass.
- Files changed: apps/desktop/* (16 files), pnpm-workspace.yaml (onlyBuiltDependencies), root package.json (5 desktop scripts), pnpm-lock.yaml
- Code deleted or consolidated: none (greenfield scaffold)
- Net LOC delta (`git diff --shortstat`): recorded at commit (~600 lines apps/desktop incl. tests)
- Old paths retained and why: root playwright.config.ts untouched (web E2E keeps working — per plan/team audit)
- Dependencies added (name, size, justification): electron 42.4.0 (runtime), electron-vite 5 + vite 8 (build, repo is vite-native), electron-builder + @electron/fuses (Phase 14 packaging, installed now per plan), electron-updater (Phase 14), zod (IPC validation), vitest/typescript/@types/node pinned to repo standards (TS6→5.9, types25→22 corrected post-install)
- Decisions made (D-NN ids): D-10 | Phase 2 renderer is dependency-free TS+HTML placeholder; React arrives in Phase 3 via component reuse map | smallest first paint, Phase 3 owns the real shell | phase 2. D-11 | preload built CJS (sandboxed preload requirement); main ESM (import.meta.dirname) | electron-vite 5 + sandbox constraint | phase 2
- Tests added: 7 security unit tests (webPreferences trio, absolute preload, navigation policy, window.open deny + external routing + scheme restrictions); 1 Playwright Electron E2E (heading visible, screenshot at convention path, launch marks positive, perf JSON written); smoke script (8s fatal-stderr scan)
- Commands run: install+electron --version (42.4.0); test RED→GREEN 7/7; typecheck PASS; build PASS (main ESM/preload CJS/renderer); test:desktop:e2e PASS 534ms; smoke:desktop PASS — all pinned Node 22.13
- Failing tests fixed: RED→GREEN by implementation; vitest/e2e separation fixed via vitest.config include
- Electron E2E/manual smoke: E2E pass (no sandbox workarounds needed on WSLg — DOHC_E2E_NO_CHROMIUM_SANDBOX path exists but unused); smoke pass
- UI/UX screenshot/design review: screenshot inspected by lead — warm paper bg, centered graphite wordmark, muted subtitle, nonblank, no white flash (backgroundColor set pre-paint). Full Design Review Loop applies from Phase 3.
- Performance measurements: cold launch appReady 194ms / firstWindow 232ms / firstPaint 315ms (budget: shell <2000ms — 6x headroom); recorded to test-results/performance/desktop-performance.json
- Security/collaboration regressions: IPC sender-origin validation on all invoke handlers; zod-parsed results; test bridge gated on DOHC_DESKTOP_TEST; CSP in renderer; window.open denied universally
- Reviewer/subagent findings: verifiers wf_7528cd05-564 BOTH PASS. test-quality: deletion mutation fails suite; sandbox:false mutation caught at exact assertion; E2E flake-free (no sleeps). claimed-vs-actual: probed RUNTIME bridge surface without test env (Node unreachable, exact bridge shape, test bridge double-gated); re-ran full gate chain green. Findings fixed pre-commit: (1) origin prefix-match bypass (file:// allowed any local file; dev origin matched localhost:5173.evil.com) — FIXED with NavigationPolicy (exact http origins + bundle-scoped file prefix, deny-by-default incl. unparseable), assertTrustedSender now uses the same policy; (2) http:// scheme untested in window.open — test added; (3) single-instance lock didn't gate bootstrap — restructured; (4) bridgeContract comment overstated payload validation — corrected. 11/11 after fixes; full gate chain re-run green.
- Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-02.md; commit review + targeted security prompt, both xhigh): (1) MED ELECTRON_RENDERER_URL trusted without isPackaged/loopback guard — packaged app could loadURL + IPC-trust arbitrary origin — FIXED (validateDevServerUrl: unpackaged + loopback + http(s) only, unit-tested incl. packaged rejection); (2) MED only will-navigate enforced; redirects/subframes uncovered — FIXED (will-redirect + will-frame-navigate share the same policy; about:blank/javascript: unit cases added); (3) LOW test bridge env-only gating — FIXED (env flag AND !app.isPackaged); (4) LOW window.open shells any http(s) — could become phishing primitive if renderer renders user content — DEFERRED with reason: renderer content is fully app-controlled until Phase 6 file views; user-gesture/allowlist fix scheduled with Phase 6 (tracked); (5) INFO WindowOpenDecision over-shaped — FIXED (simplified to shouldOpenExternally boolean, less code). Codex confirmed solid: IPC sender validation on every handler, no Node/ipcRenderer leak, webPreferences trio, about:/javascript: denial.
- Relevant findings fixed: 4 verifier findings pre-commit + codex findings 1,2,3,5 in phase2(fix); 14/14 tests after
- Deferred findings with reason: desktopSmoke.test.ts realized as scripts/smoke-test.mjs (executable smoke beats a vitest stub; runs in every phase gate); codex finding 4 (window.open user-gesture/allowlist) deferred to Phase 6 when user content first renders
- Remaining risk: fuses configuration deferred to Phase 14 packaging (per plan); titlebar is default chrome until Phase 3
- Next phase: 3

### Phase 3: Native-Feeling Desktop Shell UX

- Status: in progress (design loop iteration 1 PASSED; verifiers running; commit pending)
- Execution map: reuse-map recon (artifact committed in phase2 fix) → renderer deps installed (react 19.2.6/tailwind 4/@dohc/brand/lucide, TS+types repinned to repo standards) → failing tests written (6 first-run component tests + 2-test native UX E2E) → RED recorded (incl. catching vitest glob missing .tsx — fixed) → bridge extensions (4 new validated channels) + workspaces service (registry w/ test-home seam, createWorkspaceFolder w/ workspace-core manifest, file ops via validateUserWritePath) → React shell (FirstRun/Shell/Palette/NewFileDialog/theme/styles on shared brand tokens) → ESM crash fixed (electron-vite must bundle workspace pkgs — externalizeDepsPlugin exclude) → GREEN 20/20 unit + 3/3 E2E + smoke → design loop (2 Claude judges gating + codex -i advisory) → 3 soft fixes → all green again
- Resume notes: verifiers wf_5ff43339-c71 in flight; commit phase3 on pass.
- Files changed: apps/desktop renderer (9 new React/TS files + styles.css), workspaces/ (3 new), ipc (channels+contract extended), main.ts/preload.ts (4 new handlers), electron.vite.config.ts, vitest.config.ts (.tsx glob), e2e/firstRunWorkspace.spec.ts, package.json deps, pnpm-lock
- Code deleted or consolidated: src/renderer/main.ts (replaced by main.tsx); redundant kind badge removed in design loop
- Net LOC delta: recorded at commit
- Old paths retained and why: web components NOT copied yet — Phase 3 shell is purpose-built per reuse map (smaller than porting); FileTree/CommandPalette ports deferred to when their features (virtualization, multi-command surface) are actually needed (reuse-before-write cuts both ways: this shell is ~400 lines total)
- Dependencies added: react/react-dom 19.2.6, lucide-react, @dohc/brand + @dohc/workspace-core (workspace), tailwindcss 4 + @tailwindcss/vite, @vitejs/plugin-react, testing-library trio + jsdom (dev)
- Decisions made: D-12 | Phase 3 ships minimal real bridge (registry/create/list/createFile), Phase 4 formalizes | first-run must create real folders to be honest | phase 3. D-13 | shell purpose-built, not ported: reuse map showed ports carry transitive web coupling; 400-line shell beats 16 swapped components for v1 | less code | phase 3
- Tests added: 7 component (first-run: suggest/choose/create/no-auth/cloud-optional/cloud-offer-truthful/no-marketing), 7 workspaceFiles unit (createFile validation/no-overwrite, listFiles ignores, copyIntoWorkspace basename/skip-existing — RED recorded for copyIntoWorkspace), 2 E2E expanded (adds: palette 5 commands incl. import+cloud, quick-open Ctrl+P file jump, switcher listbox, cloud panel honest copy + backdrop close, file-preview screenshot)
- Commands run: RED→GREEN cycles + full gate chain (all pinned Node 22.13)
- Failing tests fixed: ESM workspace-core load crash (bundling); vitest .tsx glob gap
- Electron E2E/manual smoke: 3/3 E2E + smoke green
- UI/UX screenshot/design review: Design Review Loop iteration 1 — Claude judges (gating): ALL 7 PASS, zero hard fails, pixel-sampled token verification (#f7f6f1/#100f0e/#151515/#f4f1ea exact). Codex -i advisory: shell screens all-pass ("strongest calibration hit"); 4 fails dispositioned: path truncation FIXED (wrap, never truncate), first-run card-feel REJECTED (Claude evidence: utilitarian tool card, no marketing), dark-mode-too-black REJECTED (faithful to final brand tokens — flagged to Ice as brand-level observation), palette modal-feel REJECTED (Raycast-calibrated). Claude soft fixes applied: clickable empty-state actions, redundant PERSONAL badge removed. Accent #2d342e green-cast note REJECTED (it IS the brand accent token).
- Performance measurements: launch marks pipeline intact (E2E re-verified); shell adds React — bundle size watch begins Phase 16 ratchet
- Security/collaboration regressions: all new channels sender-validated + zod-parsed payloads/results; file ops traversal-guarded via workspace-core
- Reviewer/subagent findings: verifiers wf_5ff43339-c71 — test-quality PASS (deletion mutation bites; manifest-content/keyboard-file/relaunch assertions all real, no sleeps; createFile traversal-proof incl. wx no-overwrite; listFiles skips ignored dirs, doesn't follow symlinks; doctored workspaceId fails closed). One tracked note → Phase 4: CreateLocalWorkspacePayload.rootPath is only z.string().min(1) — a compromised renderer could register "/" or $HOME as a workspace then enumerate/create-empty broadly; Phase 4 attachment rules MUST add root validation (validateAttachedFolder + reject root/home-itself). claimed-vs-actual initially killed by session limit; re-run via workflow resume (cached test-quality) — verdict FAIL on plan-completeness (every claim true, gates green, hunts clean, but 5 plan-required shell elements missing). HONORED: all 5 built in iteration 2 rather than deferred. Design loop iteration 2 judge: PASS, zero hard fails, all 10 plan shell elements verified present (code+screenshot evidence); 2 polish notes (offer-row gutter, Ctrl P hint) applied same-pass.
- Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-03.md): (1) P1 creating over an existing dohc workspace overwrote its manifest, severing workspaceId identity for sync/history — FIXED (adopt existing manifest, keep identity; unit-tested with recorded RED); (2) P2 rootPath accepted relative paths (created .dohc relative to process cwd) — FIXED (validateAttachedFolder in createWorkspaceFolder; also closes the verifier's tracked rootPath note at the absolute-path level — Phase 4 still adds root/home-itself rejection); (3) P2 stale files/selection leaked across workspace switch — FIXED (shell keyed by workspaceId, remount on switch). 30/30 unit + 3/3 E2E + smoke green after fixes.
- Relevant findings fixed: all 3 codex findings in phase3(fix) commit
- Deferred findings with reason: SUPERSEDED — claimed-vs-actual verifier correctly failed the deferral as gate-softening; all five missing plan elements built in iteration 2: workspace switcher (real listbox over registry), import action (real file-copy via dialog + copyIntoWorkspace, unit-tested incl. no-overwrite), cloud-sync offer (truthful surface in first-run + status bar + palette — explains, never gates), quick-open Ctrl+P (palette-pattern file jump, E2E-tested), file-preview screenshot (selected-state artifact). Also fixed from verifier nits: me.md catch narrowed to EEXIST-only. Flat path list (not hierarchical tree) remains v0 — hierarchy + virtualization with Phase 5/16. Verifier note on rootPath validation → Phase 4 requirement (recorded).
- Remaining risk: shell density will be rejudged when editor surface lands (Phase 6)
- Next phase: 4

### Phase 4: Local Workspace Registry And Folder Creation

- Status: in progress (all gates green; verifiers running; commit pending)
- Execution map: workspace-core validateWorkspaceRootChoice tests-first (RED 3) → impl (rejects "/", home-itself, drive roots, relative) → registryStore extracted as pure module, tests-first (RED: missing module; 5 tests: multi-attach, duplicate rejection w/ message, persistence across instances, local-only-no-remote, remote-identity-only-after-setRemote) → WorkspaceRegistry rewired as electron shim over store → attachWorkspaceFolder IPC (validated, adopts-or-creates) + DOHC_TEST_PICK_PATH dialog seam (test+unpackaged gated) → first-run "Open an existing folder" + component test → attach-preserves-identity E2E → 36/36 unit + 4/4 E2E + typecheck + build + smoke green
- Resume notes: verifiers wf_76209a51-999 in flight; commit phase4 on pass; then POST-PHASE-4 CHECKPOINT (Electron security/IPC review: finder fan-out + codex --base main + verify pipeline + adversarial scenario consult per plan).
- Files changed: packages/workspace-core/src/paths.{ts,test.ts} (+validateWorkspaceRootChoice), apps/desktop/src/workspaces/{registryStore.ts,registryStore.test.ts,WorkspaceRegistry.ts}, ipc/{channels,bridgeContract}.ts (+attach), main.ts (root-choice enforcement on create+attach, attach handler, pick seam), preload.ts, renderer/DesktopFirstRun.{tsx,test.tsx}, e2e/firstRunWorkspace.spec.ts (+attach test)
- Code deleted or consolidated: WorkspaceRegistry's inline persistence replaced by pure registryStore (was untestable electron-coupled code); registerWorkspace silent-skip became explicit duplicate rejection
- Net LOC delta: recorded at commit
- Old paths retained and why: none affected
- Dependencies added: none
- Decisions made: D-14 | registry naming keeps getWorkspaceRegistry/pickWorkspaceRoot (plan: listLocalWorkspaces/chooseWorkspaceRoot) — same surface, earlier names already shipped in phase2/3; renaming = churn without behavior | less code | phase 4
- Tests added: 3 workspace-core (root-choice), 5 registryStore, 1 first-run component (attach), 1 E2E (attach preserves manifest identity, file tree shows existing files)
- Commands run: RED→GREEN per module; full gate chain green (pinned Node)
- Failing tests fixed: none beyond planned REDs
- Electron E2E/manual smoke: 4/4 E2E + smoke green
- UI/UX screenshot/design review: not a design-loop phase; first-run gained one quiet secondary button (screenshot regenerates in E2E artifacts)
- Performance measurements: launch marks pipeline intact via E2E
- Security/collaboration regressions: closes tracked finding (workspace root cannot be "/", home, or drive root — enforced on BOTH create and attach paths); pick seam double-gated; duplicate attachment rejected
- Reviewer/subagent findings: verifiers wf_76209a51-999 — test-quality FAIL with two PROBE-CONFIRMED escapes, both FIXED pre-commit with pinning tests: (1) dot-segment disguises ("/home/ice/.", "/x/..") defeated the root guard — fixed via lexical normalizeAbsolutePath (drive/UNC-aware) + validateWorkspaceRootChoice returns canonical path used by ALL downstream fs/registry ops (also kills trailing-slash duplicate registrations); (2) attaching a copied workspace folder registered a duplicate workspaceId, silently mistargeting file IPC to the first root — fixed: register rejects identity duplicates with remediation message. Also added missing Windows drive-root test case. Mutation checks passed (store deletion + throw-removal both bite). claimed-vs-actual PASS (all plan Step 1/2/4 claims verified by re-run; metadata.ts divergence judged no-gap; D-14 naming accepted; registerWorkspace behavior change judged low-risk). Residuals tracked: symlink-variant duplicate roots (needs realpath — fs-touching, deferred to Phase 5 watcher work where fs identity matters), mixed separators cosmetic on Windows.
- Codex third-party review findings: pending post-commit (xhigh + targeted security prompt — high-risk phase)
- Relevant findings fixed: 2 verifier escapes + 1 test gap fixed pre-commit; 40/40 core + 37/37 desktop after
- Deferred findings with reason: registry uses userData JSON (plan mentions Electron safeStorage as an option — registry holds no secrets, paths only; safeStorage encryption adds keychain dependency for zero confidentiality gain; revisit when cloud tokens arrive in Phase 9)
- Remaining risk: same-workspaceId-two-roots edge (foreign manifest copy) — findWorkspace returns first match; harmless today (both roots valid), revisit with sync identity in Phase 9
- Next phase: 5
