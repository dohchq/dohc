# Desktop Experience & Parity Execution Log

Plan: `2026-06-11-dohc-desktop-experience-parity.md` (all decisions DECIDED —
D-E1 rich collab, D-E2 t3code patterns, D-E3 all retired, D-E4 runtime in
scope, D-E5 graphite minimal, D-E6 ripgrep). Definition of done = the 8-gate
list in the plan's Standing rules (named E2E spec + FULL suite + perf/lean +
design review + codex review + fix commit, every phase).

## Resume Snapshot (overwrite in place — the ONLY mutable section)

- Phase/position: E5.0 SEARCH committed 24282cb; e3(fix) committed a94ac27;
  watcher de-flake e532d82. E4 IN PROGRESS, sub-laned: **E4a FOUNDATION =
  THIS commit** (round-trip core, desktop-only, NON-breaking — textarea editor
  still wired). E4a shipped apps/desktop/src/renderer/editor/{extensions.ts
  (VERBATIM copy of server dohc-markdown-extensions.ts), import-export.ts
  (VERBATIM copy of server import-export.ts, one import-path fixup),
  schema-contracts.ts (from editor-v2 ref)} + tests (import-export 7 incl
  idempotency/frontmatter-order/custom-node preservation, schema-contracts 5,
  schema-parity 1) = 13 green; deps @tiptap/core,/markdown,/starter-kit,
  /extension-table,/pm + y-prosemirror@^1.3.7 (match server ^3.23.6). PARITY
  GATE: byte-identity desktop extensions.ts === server file enforced in
  scripts/check-architecture-debt.mjs (scanEditorSchemaParity — renderer is
  sandboxed, can't node:fs; verified it fails on drift). Editor files kept in
  SERVER single-quote style (a mirror-of-source island; no desktop format
  gate) for easy parity diffing. CHECKLISTS DESCOPED from E4a (taskList is a
  schema change requiring a server touch -> deferred to E4c). FUTURE DEBT:
  dedupe the copied core into a shared @dohc/editor-core pkg (consumed by both
  hocuspocus + desktop as raw TS src, the monorepo convention) — deferred to
  avoid destabilizing live collab mid-E4. NEXT = **E4b EDITOR COMPONENT**:
  port plugins (wikilinkPlugin verbatim, inlineAtomPlugin + the inlineAtom
  parser EXTRACTED from deleted convex/inlineAtom.ts — only the text
  parseInlineAtoms path, DROP the mdast-util-from-markdown parseInlineAtomsFrom-
  Markdown family, +@tiptap/pm already added, floatingMenuPosition verbatim),
  MarkdownEditor.tsx (3043->~1300 strip per recon §1 STRIP list), WikilinkPicker,
  FileInspector WYSIWYG-default + source-toggle, BubbleMenu (NEW). THEN E4c
  COLLAB+SERVER: useCollabDoc body-fragment rework, plainText->rich server flip
  + migration arm + data-loss test, add taskList both sides, liveCoEditing
  update. THEN E4d GATES (editorWysiwyg.spec, perf tiptap-mount + 32KB-typing,
  design + codex review). Recon: docs/superpowers/recon/2026-06-11-e4-editor-
  port-digest.md; D-E1 rich collab, D-E3 retire formula/query VALUES (keep
  inert styling + schema nodes for round-trip). E5.0 = @vscode/ripgrep argv-spawn IPC (never shell; user globs
  FIRST then engine-level !.dohc/!.git/!node_modules LAST = last-match-wins,
  + hasIgnoredSegment parse-time backstop; 2MB/2000-match caps; PID-tracked
  cancellation + search-id stale-drop), streamed batches w/ preload shape
  validator, SearchView + quick-open ranking, 3 additive budget rows. e3(fix)
  = codex review (docs/superpowers/reviews/codex/e3-findings.md) all closed:
  P1 import exfil (lstat ORIGINAL source -> final-component symlink refused,
  handler count cap, .dohc containment on canonical realpath); movePath
  case-fold descendant (realpath isInside guard); deletePath lstat-first
  (trash the LINK not target) + NAME_MAX-safe trash names; export add() =
  open(O_NOFOLLOW)+fstat+bounded read (symlink-swap TOCTOU + grow-after-cap
  closed); zipWriter assertSafeEntryName (abs/drive/backslash/dotdot/empty-seg
  rejected). Move/trash TOCTOUs = documented accepted residuals (no renameat2
  in Node). ADVERSARIAL VERIFY (workflow e3fix-adversarial-verify, 57 agents,
  17 claims -> 16 refuted): ONE confirmed P2 = importDroppedPaths ANCESTOR-
  symlink (a real leaf under a symlinked dir still imports). DISPOSITION =
  accepted-residual + documented, NOT a guard: (a) grants compromised renderer
  nothing beyond the already-accepted residual (it can name ~/.ssh/id_rsa
  directly; ancestor symlink is just an alias to the same canonical path);
  (b) the recommended hasNoSymlinkedAncestor walk would FALSE-REJECT legit OS
  drags through SYSTEM symlinks (macOS /tmp->/private/tmp, /var->/private/var,
  incl. our own temp-dir tests on macOS) = silent import loss for zero gain;
  (c) the .dohc gate runs on canonical realpath so ancestor symlinks can't
  smuggle metadata past it (locked by a new test). Real future fix = visible
  import-confirm quarantine (deferred, product sign-off). WATCHER FLAKE FIXED
  e532d82 (root cause: shell DOM mounts before openWorkspace resolves the
  watcher-ready race; detected.md written into chokidar's ignoreInitial scan
  was swallowed -> added data-ready shell attr the perf-open helper gates on;
  rewrote 100-file assertion to poll cumulative count + assert 1-5 batch rows
  via change-set testid). FULL E2E 55/55, perf green. SYNC-WART (pinned, E5):
  offline-rename+concurrent-remote-edit-of-old-path -> spurious <old>.conflict
  + stale-revision push refusal; fix in E5 sharing phase. COMMITS: a5343a3/
  cab8525/6703984 (e5 server), 0c40626/c56c17f (e0-e1), 7a85b1f/ba808e4 (e2),
  3b9d327 (e3), 24282cb (e5.0), e532d82 (watcher de-flake), a94ac27 (e3 fix),
  e4a foundation=this.
- Branch: `claude/desktop-local-first-cloud-sync` (continuing the mega-branch;
  HEAD at start = 5df57e7 fix(dev) barrel leak). Commit convention `eN: …` +
  `eN(fix): …`.
- Toolchain: `pnpm` on PATH IS NOW 10.24.0 (user's global fixed 2026-06-11);
  corepack-cache fallback `node ~/.cache/node/corepack/v1/pnpm/10.24.0/bin/pnpm.cjs`.
  Desktop tests run on Node 25; @dohc/web tests need PATH prefix
  `$HOME/.local/share/nvm/v22.13.0/bin`. Desktop E2E:
  `DOHC_E2E_NO_CHROMIUM_SANDBOX=1 xvfb-run -a pnpm exec playwright test
  --config apps/desktop/playwright.config.ts`. WSL safety: never pattern-kill;
  TERM only own PIDs.
- Source-recovery anchors: rich web UX at `7277c39^`
  (`git show 7277c39^:apps/app/src/components/<X>.tsx`), editor-v2 at
  `7277c39`, t3code reference at `/home/ice/dev/oss-repos/t3code`
  (provider/Drivers+Layers, effect-acp, effect-codex-app-server).
- Gates baseline at start (all green): 15 suites/589 tests, desktop E2E 32/32
  (12 spec files incl. productReadiness), check:performance exit 0,
  check:lean green (knip 0 / debt 4 / arch 12+60).
- Current desktop surface (pre-E0): renderer = DesktopRoot / DesktopFirstRun /
  DesktopWorkspaceShell (flat file list, no tabs) / FileInspector (views +
  textarea editor + IncrementalMarkdownDocument) / CommandPalette /
  CloudLogin / NewFileDialog / Overlay / settings/DesktopSettings / collab/* /
  markdown/*; styles.css = warm paper tokens (to be replaced); theme.ts =
  light/dark flip on data-theme; window = STOCK chrome (no titleBarOverlay),
  bg #faf7f2; e2e harness = e2e/launch.ts (DOHC_TEST_HOME/PICK_PATH/
  USER_DATA), screenshot helper pattern in firstRunWorkspace.spec.ts.

## Environment (append-only)

- 2026-06-11: pnpm global = 10.24.0 (symlink → global/5/node_modules/pnpm,
  store v10). Node default 25.2.1 (nvm). Docker dev stack healthy (postgres
  :54329, minio, hocuspocus :1234). WSLg display works; xvfb for E2E.
- Codex: `/home/ice/.local/share/nvm/v25.2.1/bin/codex` exec, `-m gpt-5.5 -c
  model_reasoning_effort="xhigh"`, read-only sandbox. POLL the log file
  (detached nohup); do NOT watch via `pgrep -x codex` (VS Code app-servers
  match it forever — burned us once). Completion marker must be EOF-ANCHORED:
  `tail -c 150 <log> | grep -qE "tokens used[[:space:]]+[0-9,]+[[:space:]]*$"`
  — a bare grep for "tokens used" false-fires when codex READS our own logs
  containing that phrase (burned us 2026-06-11).

## Decision Ledger (append-only)

- DX-01 | Continue on mega-branch `claude/desktop-local-first-cloud-sync`
  (user runs the app from it; new branch adds friction, no isolation value
  while this is the only active plan) | 2026-06-11
- DX-02 | E0+E1 combined into one lane (titlebar/overlay colors depend on the
  new tokens; separate lanes would fight over styles.css + window files) |
  2026-06-11
- DX-03 | D-E2 AMENDED per t3code recon: Claude driver = @anthropic-ai/
  claude-agent-sdk (t3code's ACTUAL tested path — their effect-acp serves
  Cursor/Grok, not Claude; the SDK is the only subscription-tier probe:
  initializationResult().account.subscriptionType), Codex = app-server
  protocol, ACP = the GENERIC third driver (Gemini/Cursor/OpenCode…). Honors
  the user's intent (subscriptions first, tried-and-tested) over the literal
  "Claude via ACP" wording; user may veto. Two t3code quirks NOT to copy:
  hardcoded ACP permission optionIds (select by kind instead), unconditional
  authenticate before session/new. Spec: docs/superpowers/recon/
  2026-06-11-e6-agent-driver-spec.md | 2026-06-11

## Phase log (append-only)

### e3 codex review — DONE (findings recorded), e3(fix) PENDING E5.0
The xhigh/high full-diff codex passes OVERRAN the reasoning budget before
flushing findings (3 dead attempts at ~317K input tokens — not OOM; lesson:
for large diffs, SPLIT the review by file at effort=medium with "findings
ONLY, write list first"). The split worked: findings in docs/superpowers/
reviews/codex/e3-findings.md — 1 P1 (renderer-forged droppedPaths exfiltrates
/etc/passwd etc. into the synced workspace) + a P2 cluster (symlink-TOCTOU in
delete/move/export, zip-slip, case-only descendant bypass, dest-rename TOCTOU).
SEQUENCING: e3(fix) waits for E5.0 to land+commit (both append main.ts/
channels/preload — concurrent mutation would race the tree); the P1 is
defense-in-depth (needs a compromised renderer, which dohc's CSP+no-raw-HTML
makes hard), so the short wait is safe. WHEN E5.0 COMMITS: run e3(fix) lane
(lstat/no-follow hardening + handler-level path cap + zip-name validation +
case-fold descendant check; adversarial replay of the forged-path P1 and the
symlink swaps), commit e3(fix) -> THEN E4 editor lane.


### e5(server) — COMMITTED a5343a3 (2026-06-11)

Share CRUD (idempotent audience upsert, sharer/owner revoke, revoked→link
403 e2e-tested, /me/shares) + invitations (migration 0004, claim-on-EMAIL-
VERIFICATION after the lane review proved claim-on-signup = membership
hijack; verified-only gate for born-verified providers; stranger DELETEs
404-collapsed; re-invite revives at invited role). Gates: api 41 / pg 23 /
typechecks. CODEX REVIEW DONE + FIXED: e5-server(fix) = cab8525 closes all
6 findings ([P1] unverified-recipient resolution = pre-registration share/
membership theft → verified-only + oracle collapse; [P2] upsert capability
escalation → owner/creator pre-check; [P2] duplicate-audience race →
migration 0005 partial unique index + single ON CONFLICT; [P2] revoke/claim
race → conditional UPDATE + row-locked claim tx, both interleavings tested;
[P3] born-verified hook removed; [P3] authz-before-body + normalizeEmail).
Attack-replay verifier: all 6 dead (live pg_indexes probe + lock-ordering
tests). api 46 / pg 23. Residual noted (non-finding): narrow first-time-
create TOCTOU picks conflict-loser capability — benign, logged for E5
ShareDialog phase awareness. ShareDialog port contract recorded in the
lane report (workflow wv9hdbq26 output): capability "view"|"edit", atomId
preferred, 404-on-unknown-email = offer invite, /me/shares for shared-
with-me. Recon digests DONE: e4-editor-port-digest.md (server extension
file is canonical; D-E1 migration needs explicit plainText→rich arm
serializing the LIVE Y.Text; checklists need server+client task nodes
same-change; floating toolbar net-new; keep perf testids),
e6-agent-driver-spec.md (Claude = agent-sdk NOT acp per t3code truth —
DX-03; codex app-server method names; ACP = generic driver; reaper;
Windows deltas).

### e0-e1 (build lane wop1415aj) — BUILT, ALL GATES GREEN, awaiting lead commit (2026-06-11)

Graphite minimal (D-E5) + native chrome landed together. Tokens: styles.css
:root/[data-theme='dark'] rewritten (light #ffffff/#fafafa/#f4f4f5/#e4e4e7,
ink #18181b, accent=ink; dark #18181b/#1e1e20/#1c1c1e family); tokens.ts is
the data mirror for window chrome with tokens.test.ts as the parse-and-
compare duplication guard (vitest css:true needed for the ?raw import) plus
pure WCAG contrast math (ink/muted ≥4.5, subtle ≥3.0 on bg AND panel/panel-2,
BOTH modes). ONE spec deviation, recorded: subtle #a1a1aa fails the plan's
own 3.0:1 gate at 2.56:1 → light subtle = #8b8b93 (3.38:1 on bg, 3.08:1 on
panel-2 — the review found #909098 failed panel-2 at 2.88:1), dark = #71717a
(3.66:1). Desktop
dropped @dohc/brand (web keeps it); Inter bundled (@fontsource-variable);
13px UI / 15px document / 28px rows. Chrome: titleBarStyle hidden +
titleBarOverlay(40px, theme-synced via desktop:set-titlebar-theme IPC,
feature-detected) / hiddenInset+trafficLights on darwin; Titlebar.tsx drag
strip (glyph + relocated switcher + quick-open affordance + env(titlebar-
area-*) spacer) mounted in shell AND first-run; applicationMenu.ts
(File/Edit/View/Go/Help, registerAccelerator:false on renderer-owned keys,
MENU_COMMANDS tuple lives in channels.ts because the SANDBOXED preload
validates as a value — zod import there broke the preload bundle);
windowState.ts pure model (intersection-clamp, debounced saver) + test;
icon.svg→icon.png via scripts/render-icon.mjs; buildResources wired.
Shell: command registry is the single source (palette + menu), new
toggle-sidebar (Ctrl+B) + open-workspace commands (palette now 8), New
Folder aliases the new-file dialog until E3. launch.ts now gives EVERY
launch a fresh --user-data-dir (localStorage theme leaked across runs and
flaked theme assertions). Gates: unit 165/165 (21 files), typecheck clean,
desktop E2E 37/37 (visualLanguage + windowChrome new), check:performance
all PASS (cold 300ms, bundle 1.28MB), knip 0, tech-debt pass, arch-debt
passes for THIS lane (6 open findings are e5-server files + recon doc —
their lanes own them; the new plan/log paths were allowlisted as
historical). Screenshots: test-results/screenshots/e0-e1/ — 5 surfaces ×
light+dark × 1280x800+1536x960 (20 files). Windows-native checklist (snap
layouts, overlay hover, menu accelerators) PENDING user verification.
