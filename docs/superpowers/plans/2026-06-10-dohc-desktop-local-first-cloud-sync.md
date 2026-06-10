# dohc Desktop Local-First Cloud Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. If those skills are unavailable, use native orchestration instead: a lead agent implements phases sequentially, fans out parallel subagent review workflows at every major checkpoint (security, UX/screenshot, performance, deletion-safety), runs long test suites in the background, and self-paces with scheduled wakeups so execution continues unattended. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pivot dohc from a web-first Convex workspace into an Electron-first, local-file-first workspace that syncs to dohc Cloud or self-hosted Postgres, lets local Codex/Claude Code work directly on files, and preserves dohc's collaboration, apps, SQLite, provenance, and agent-testing strengths.

**Product thesis:** Files are local and owned, but they are not *just* local files — they are building blocks people share and build on together. dohc brings git-grade building-collaboration (change sets, history, attribution, review at real boundaries, AI-assisted merge) to everyday people, the way git brought it to engineers. Local-first accountless use is the free trust wedge; dohc Cloud is the paid collaboration engine. Without the collaboration layer, dohc is arguably an Obsidian clone — with it, it is a new category. Collaboration surfaces are first-class product, never sync plumbing.

What separates dohc from Obsidian-class tools is three legs, and the combination is the moat: (1) agents are first-class workers with infrastructure — change sets, provenance, attribution, review gates, MCP tools, tested apps — not bolted-on plugins with folder access; (2) work primitives beyond notes — real SQLite databases, data imports, and source-backed apps a user's agent can build and dohc can test; (3) git-grade collaboration. Local files, markdown, speed, and a command palette are table stakes adopted from Obsidian, not differentiation — every phase should protect all three legs, and users' agents (not a plugin marketplace) are dohc's ecosystem.

**Architecture:** Workspaces are real folders on disk. The desktop app is the primary product surface and runs a local dohc core that watches folders, batches changes, maintains `.dohc/` metadata, serves the React renderer, exposes MCP/tools to local agents, and syncs with dohc Cloud/self-hosted Postgres when enabled. The existing dual-backend branch is treated as a completed prototype: keep/port the useful Postgres, filesystem, app, SQLite, sandbox, upload, and AppTester pieces; delete Convex and web-first compatibility paths once equivalent local-first tests prove the replacement.

**Tech Stack:** Electron, React/TanStack Start renderer, TypeScript, Vite/electron-vite or equivalent Electron Vite build tooling, Playwright Electron automation, Vitest, Postgres, Drizzle ORM, Better Auth (inside workspace-api, Drizzle adapter on the same Postgres) for cloud/self-host authentication, Hocuspocus/Yjs for live collaborative text in shared workspaces, local filesystem storage, S3-compatible object storage for cloud/self-host, SQLite worker/AppTester services, MCP server for Codex/Claude integration, Docker Compose for self-host/dev.

---

## Research Basis

Use these references while implementing:

- Electron security checklist and context isolation: `https://www.electronjs.org/docs/latest/tutorial/security`
- Electron context isolation: `https://www.electronjs.org/docs/latest/tutorial/context-isolation`
- Electron sandboxing: `https://www.electronjs.org/docs/latest/tutorial/sandbox`
- Electron fuses: `https://www.electronjs.org/docs/tutorial/fuses`
- Electron IPC: `https://www.electronjs.org/docs/latest/tutorial/ipc`
- Playwright Electron automation: `https://playwright.dev/docs/api/class-electron`
- electron-vite guide and CLI: `https://electron-vite.org/guide/`, `https://electron-vite.org/guide/cli`
- Electron Forge Vite plugin if the implementer chooses Forge instead of electron-vite: `https://www.electronforge.io/config/plugins/vite`
- electron-builder signing and updates: `https://www.electron.build/docs/features/code-signing/`, `https://www.electron.build/docs/features/auto-update/`
- Chromium performance APIs for renderer marks/measures: `https://developer.mozilla.org/docs/Web/API/Performance`
- React profiler for targeted render-cost investigation: `https://react.dev/reference/react/Profiler`
- Local reference implementation: `/home/ice/dev/oss-repos/t3code/apps/desktop`
- Better Auth docs (Drizzle adapter, organization plugin, device authorization, SSO): `https://www.better-auth.com/docs`
- Hocuspocus server/provider docs: `https://tiptap.dev/docs/hocuspocus`
- Yjs docs: `https://docs.yjs.dev`

Important lessons from the references:

- Keep `contextIsolation: true`, `nodeIntegration: false`, and renderer sandboxing enabled.
- Expose only narrow, validated preload APIs through `contextBridge`.
- Treat IPC as an untrusted boundary; validate every payload and sender.
- Use Playwright's Electron launcher to drive real desktop E2E tests.
- For packaging, signed/notarized builds and update metadata matter; unsigned dev builds are fine, unsigned release builds are not.
- `electron-vite` is a good fit for a Vite/React codebase, but Electron Forge + Vite is acceptable if it better fits repo conventions.
- t3code's desktop package is a useful pattern: explicit desktop package, main/preload separation, desktop bridge contract, desktop auth/bootstrap, update tests, smoke tests, and release artifact scripts.
- Desktop performance must be measured inside the real Electron app, not inferred from unit tests.
- Native-feeling performance requires startup, first paint, file-tree rendering, search, sync, app open, and database operations to have explicit budgets.

## Strategic Decisions Already Made

- Cut Convex in the new architecture.
- Use Postgres for dohc Cloud and self-hosted sync/collaboration.
- Use Better Auth (running inside workspace-api on the Drizzle/Postgres stack) for dohc Cloud and self-host authentication: email/password plus the device authorization flow for desktop login and the organization plugin for teams. Self-hosters get working auth with no external vendor account. WorkOS is deferred as an optional enterprise SSO/SCIM provider plugged in behind Better Auth when a business customer requires it.
- Live real-time co-editing (Yjs/Hocuspocus) for markdown/text in shared workspaces is in scope for this plan. Raw SQLite bytes and binary assets are still never CRDT-synced. Hocuspocus ACL must be ported off Convex to Postgres.
- Collaboration is the business model: local-first accountless use is the free wedge; dohc Cloud monetizes shared building — team workspaces, sync, live co-editing, change-set history, attribution, and AI-assisted merge. The history/attribution/catch-up surfaces are user-facing product, required even in local-only mode so sharing adds zero new concepts.
- Build Electron desktop first.
- Keep web, but make it secondary: cloud access, shared links, mobile-friendly access, and users without desktop.
- Local-only use works with no account.
- dohc Cloud login is required only for cloud sync, hosted agents, sharing, backups, teams, and multi-device cloud features.
- Personal workspaces default to local-first.
- Shared/team workspaces default to cloud-first with an always-available local working copy.
- Cloud-only workspaces remain optional for web/mobile/shared-link use.
- Sync is automatic but settled/batched, not immediate per filesystem event.
- dohc builds its own AI-native sync/history/change-set model instead of using Git as the default.
- Git integration may be added later as optional export/mirror/integration.
- Apps are visible source folders under `.apps/<name>/`, with internal build/cache.
- User-meaningful SQLite databases can be visible `.sqlite` files; hidden managed databases are allowed only for internal cache/app internals.
- Collaboration is liberal by default: if the user has edit access, they and their agent can edit. Interrupt only on real boundary crossings.
- Federation between dohc Cloud and separate self-hosted instances is deferred.
- License choice is deferred, but the architecture must be open-source/self-host ready.

## What The Completed Old Plan Gives Us

The completed `2026-06-09-dohc-dual-backend-filesystem-agent-runtime.md` branch provides useful substrate:

- `packages/workspace-contracts`
- `packages/workspace-postgres`
- `packages/workspace-fs`
- `services/workspace-api`
- `services/agent-sandbox`
- uploads and file-type views
- AppTester and app quality gates
- app/SQLite runtime and operation-log ideas
- agent output/activity separation
- backend matrix patterns
- tech debt/deletion audit patterns

This plan should port, promote, or reuse those pieces where they fit.

This plan should delete:

- Convex backend support.
- `packages/workspace-convex-compat`.
- dual-backend switching that exists only to compare Convex and Postgres.
- web-first atom/tool paths that duplicate local-file-first behavior.
- `.views` product-language paths once `.apps` compatibility/migration tests prove safe deletion.
- stale onboarding and agent prompt fragments that assume dohc is a cloud notes app.

## Non-Negotiables

- Do not weaken authorization, ownership, sharing boundaries, locks, review gates, app trust, provenance, or workspace scoping.
- Do not make local sync an unmanaged overwrite path.
- Do not turn shared/team collaboration into a restrictive permission maze. If a user has edit access, normal edits sync automatically.
- Boundary crossings still need guardrails: public publishing, external sharing, permission changes, bulk deletes, app trust/install, private-to-shared moves, and unmergeable overwrites.
- Renderer code must never get raw Node/Electron access.
- Preload APIs must be narrow and validated.
- Desktop shell/MCP capabilities must be powerful but workspace-scoped by default.
- Local-only personal workspace edits should not require approval.
- Shared/team normal edits should not require approval if the user has edit access.
- Do not CRDT-sync raw SQLite bytes.
- Do not store generated binary assets as markdown text.
- User-meaningful work must remain inspectable as files, assets, apps, or databases.
- Reduce tech debt while implementing. Delete obsolete code when tests prove it is safe.
- Performance is a product invariant. The desktop app must feel native and fast; do not accept slow startup, janky typing, sluggish file trees, expensive sync loops, or slow agent/app/database flows as "good enough."

## UI/UX Direction

dohc Desktop should preserve the current dohc feel: simple, clean, muted, warm, and work-focused. The evolution should make it feel more native and capable, not louder.

Take inspiration from:

- Obsidian: local files, calm sidebar, fast command palette, keyboard-first navigation, no heavy chrome.
- Codex/Claude Code: agent work feels active, inspectable, and powerful without decorative UI.
- t3code: desktop-first shell, local agent/runtime affordances, useful status surfaces, app-like polish.
- Linear/Raycast-level restraint: dense but readable controls, crisp typography, responsive interactions.

Do:

- keep warm paper + graphite as the product base.
- keep spacing compact and calm.
- make the file tree, command palette, editor, app runtime, sync status, and agent activity feel like native desktop surfaces.
- use subtle dividers, hover states, and active states.
- prefer icons plus short labels for commands.
- preserve keyboard shortcuts and quick switching.
- make local/cloud/sync state obvious without banners everywhere.
- make first launch immediately usable: create/open a workspace, not a marketing page.
- use screenshots and E2E checks to verify layout, text fit, and nonblank rendering.

Do not:

- add marketing-style hero sections to the desktop app.
- add gradient/orb decoration.
- make card-heavy dashboards for core workspace UI.
- make one-note purple/blue/dark-slate palettes.
- hide real files behind abstract product terms.
- ship a web page inside Electron without desktop affordances.
- make agent progress one giant paragraph.
- let text overflow, wrap badly, or occlude controls.

UI quality bar:

- default desktop shell should feel boring in the best way: obvious, fast, and trustworthy.
- every primary screen should be usable at 1280x800 and 1536x960.
- empty states should offer the next real action, not explain the product.
- file/app/database/media views should feel like different file types, not markdown with costumes.
- sync/conflict/agent activity should be inspectable but not noisy.

Native app feel requirements (what separates a legit desktop app from a website in a frame):

- custom titlebar integrated with the shell: draggable regions, platform-correct window controls, no default browser chrome.
- window state persists across launches: size, position, maximized state, last workspace.
- real menus: application menu and right-click context menus on files, folders, tabs, and editor selections — not web dropdowns pretending.
- keyboard-first everywhere: every primary action reachable without the mouse; platform-correct modifiers; visible focus states for keyboard users only.
- no web artifacts: no text-selection cursor on chrome, no image/link dragging, no pull-to-refresh or rubber-band on static surfaces, no FOUC or white flash on launch (background color set before first paint), no browser zoom on ctrl+scroll unless intentional.
- typography tuned for UI density: UI font stack for chrome, content font for documents; crisp rendering; no document-scale headings inside tool surfaces.
- one spacing grid (4px base) and one restrained token set: current dohc warm paper + graphite, one accent, subtle radii, shadows only for true elevation (menus, palette, dialogs).
- system theme (light/dark) followed without flashing or interrupting running work.
- resize behaves natively: panels reflow without jank, sidebar widths persist, no layout shift on font load.
- interactions acknowledge instantly: hover/active states under 50ms, skeletons only where real latency exists.

### Design Review Loop (required for every UI phase)

Phases 3, 6, 7 (app runtime UI), 9 (login UI), 10 (collab/conflict UI), 11 (settings/agent UI), and 18 must run this loop before their phase commit:

1. Before first implementation in Phase 3: recon the t3code renderer (`/home/ice/dev/oss-repos/t3code/apps/desktop`) and record which layout, titlebar, panel, and status-surface patterns to adopt or reject.
2. Capture screenshots of every new/changed surface at 1280x800 and 1536x960, light and dark, via the Playwright Electron tests.
3. Run a dedicated design-review subagent over the screenshots with this rubric, each item scored pass/fail:
   - looks like a native desktop app, not a web page in Electron.
   - clean, professional, calm: would not look out of place next to Obsidian, Linear, or Raycast.
   - consistent with dohc's warm paper + graphite identity; no palette drift.
   - spacing, alignment, and type hierarchy are deliberate; nothing cramped, floating, or misaligned.
   - no text overflow, truncation surprises, or occluded controls.
   - empty/loading/error states designed, not defaulted.
   - no marketing chrome, gradients/orbs, or card-heavy dashboard syndrome.
4. Fix every fail and re-run the loop. Maximum 3 iterations per UI phase. Hard items (text overflow, occluded controls, blank render, marketing chrome, palette drift from tokens) block the phase unconditionally. Soft aesthetic items still failing after 3 iterations become explicit deferred findings with screenshots in the execution log, re-judged at the Phase 18 readiness review.
5. A UI phase is not complete while any hard rubric item fails.
6. Screenshot convention (established by the Phase 2 launch E2E): tests write to `test-results/screenshots/phase-<NN>/<surface>--<width>x<height>--<light|dark>.png`. The design-review brief is fixed: "Review every PNG under `test-results/screenshots/phase-<NN>/` against the rubric; output per-file, per-item pass/fail with the failing region described." Include 2-3 reference screenshots from earlier passing phases to anchor consistency across fresh-context judges.

## Performance Budgets

These budgets are initial targets for the implementation. If a target is impossible in CI due to hardware/display limitations, the agent must record the local measured number, explain the environment, and keep a tighter relative regression budget.

Desktop UX budgets:

- cold desktop launch to first visible shell: under 2.0s on the local dev machine.
- warm launch to first visible shell: under 1.0s.
- first local workspace creation: under 1.0s for an empty workspace.
- open existing workspace with 1,000 files: under 1.5s to interactive file tree.
- file tree filter/search over 10,000 paths: under 100ms for the query operation and under 200ms to visible result.
- open markdown file under 250KB: under 150ms after click.
- typing latency in markdown editor: no sustained frame over 16ms during normal typing; no long task over 50ms.
- file watcher settle and detect single markdown save: under 2.0s.
- batch 100 changed files into one change set: under 3.0s without blocking the renderer.
- open `.apps/<name>` runtime after build cache warm: under 1.0s.
- run AppTester static+browser smoke for a small app: under 15s in CI/dev.
- open SQLite table with 10,000 rows: under 1.0s to first page.
- import 10,000-row CSV to SQLite: under 5.0s in local dev.

Resource budgets:

- renderer idle CPU should return near idle (~0%) after sync/app/test operations finish.
- no unbounded polling loops.
- large file indexing must be incremental or worker-backed.
- sync, import, AppTester, and SQLite work must not block the Electron renderer.
- desktop memory after opening a 1,000-file workspace: initial target under 400MB working set, measured and recorded; regressions over 20% require investigation.
- initial renderer JS loaded before first shell paint: initial target under 3MB; the build must print bundle size, and unexplained growth over 10% between phases fails the performance check.
- no memory growth across repeated workspace open/close cycles (leak check).

Performance engineering rules (anti-bloat):

dohc Desktop is the antithesis of Notion-class bloated Electron apps. Slowness is a bug, not polish debt. These rules apply to every phase, not just Phase 16:

- dependency discipline: every new dependency is justified in the execution log — what it does, its size and transitive cost, and the alternative considered. Prefer the platform/stdlib. No kitchen-sink UI kits.
- first-paint discipline: only code needed to paint the shell loads at startup. Everything else is lazy-loaded or deferred to idle. No blocking IPC round trips before first paint. Window background color is set before first paint (no white flash).
- the renderer renders; it does not compute: parsing, scanning, hashing, indexing, imports, SQLite, and app builds run in main-process services or workers. A renderer long task over 50ms on a hot path is a bug.
- virtualize every unbounded surface: file tree, tables, search results, history, agent activity.
- IPC is batched and coalesced: no per-keystroke or per-file-event round trips.
- animations use transform/opacity only; nothing that forces layout on a hot path.
- React hot paths are profiled: no full-tree re-renders on keystroke, file event, or sync tick.
- measure first, optimize second: every optimization records before/after numbers in the execution log.

Continuous enforcement (do not defer performance to Phase 16):

- Phase 2 ships the minimal measurement harness with the scaffold: launch/first-paint marks and a measurements JSON written by the Playwright Electron tests.
- Every subsequent phase that adds a measurable surface (file tree, editor, sync, apps, SQLite, imports, agents) adds its marks and measurements in that phase and records the numbers in the execution log.
- Phase 16 formalizes budgets into the hard `check:performance` gate and ratchets existing measurements — it must not be the first time a number is seen.
- A phase that makes a previously recorded measurement materially worse must fix it in that phase, not defer it.

Every phase touching UI, filesystem watching, sync, database import, app runtime, or agent tooling must add or update a performance check.

## Code Size And Deletion Rules

The fewer lines delivered, the better. This pivot must shrink the codebase, not grow a second product beside the old one. Code deletion is highly valued work.

- Deletion is part of every phase's definition of done, not a Phase 17 sweep. When a replacement lands with passing tests, the replaced path dies in the same phase. Phase 17 is the final audit, not where deletion starts.
- Reuse before write: before creating any new helper, module, or component, search for an existing one to promote or extend — the dual-backend substrate and current app are large. Duplication discovered later is a phase bug, not acceptable drift.
- Smallest implementation that passes the tests: no speculative abstraction, no config options nobody asked for, no wrapper layers around single call sites, no manager/factory/registry indirection without at least two real consumers today.
- Track net LOC per phase: record `git diff --shortstat` for every phase commit in the execution log. Product-surface phases may be net-positive; integration, repositioning, and deletion phases (12, 13, 17) must be strongly net-negative. Unexplained growth is a review finding to fix.
- Track branch-total LOC versus main at every major checkpoint. Deleting Convex, the compat package, dual-backend switching, and web-first duplicates should offset much of the new desktop/sync/auth code; record the honest number and justify the trend.
- Codex per-phase reviews must be prompted to flag over-engineering, orphaned/unreachable code, and simplification opportunities — not just bugs.
- Never record deferred work as code comments — the debt gate (`check:debt`) fails on the literal deferred-work marker tokens it scans for, and the failure surfaces phases later, far from its cause. Deferred work goes in the execution log's deferred-findings list with a completion condition. Adding entries to the check-tech-debt or knip allowlists for code this branch authored is forbidden; allowlists are for pre-existing/historical paths only, and every addition must be named in that phase's Codex review prompt.

## AI Agent Execution Contract

The implementing agent should assume the user is AFK and keep going until completion or a real blocker.

### Required Read Order (Tiered For Finite Context)

The lead reads inline, once per fresh context:

1. `AGENTS.md` (auto-injected) and `apps/app/AGENTS.md` (short)
2. `docs/superpowers/reviews/2026-06-09-dual-backend-readiness-review.md` and `...-tech-debt-audit.md` (short)
3. This plan's front matter (top through "Planned Repository Shape") and ONLY the current phase's section

The lead delegates to read-only digest subagents (Phase 0, digests stored in the execution log's Reference Digests section, ≤25 lines each):

- `docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md` (95KB)
- `apps/app/convex/_generated/ai/guidelines.md` (20KB) — required before deleting or porting Convex code
- the t3code renderer (`/home/ice/dev/oss-repos/t3code/apps/desktop`)
- external reference URLs (Electron security/fuses, Better Auth, Hocuspocus, Yjs)

Resumed contexts read digests, never sources; go to a source only when the digest is demonstrably insufficient for the immediate task, and update the digest afterward. The lead never WebFetches or bulk-reads reference material inline.

Governance exception (hard rule): digests may summarize historical plans, reviews, and reference repos. They may NOT replace direct reading of active governance files before editing code under those rules — `AGENTS.md`, `apps/app/AGENTS.md`, and `apps/app/convex/_generated/ai/guidelines.md` (before any Convex edit/port/deletion) are read directly by whoever edits the governed code, lead or lane.

### Continuous TDD Loop

For every phase:

1. inspect existing implementation.
2. write the smallest execution map into this plan's execution log.
3. write or update failing tests first.
4. run the tests and record the failure.
5. implement the smallest production change.
6. run targeted tests and record the pass.
7. run relevant regression/security/collaboration/Electron E2E tests.
8. perform a delete-or-justify pass.
9. inspect `git diff --stat` and security-sensitive diffs.
10. run a user-level smoke for the phase where applicable.
11. update the execution log.
12. commit the phase.
13. run independent third-party review of the phase commit (`codex exec review -m gpt-5.5 --commit <phase-sha>` at the effort tier specified in the Codex third-party review section: xhigh for high-risk phases 2, 4, 5, 9, 10, 11, 13, 16, 17, 18; high for low-risk phases 0, 1, 12, 14, 15); record findings in the execution log; fix or explicitly reject every finding; land fixes as follow-up commits.

If a named test/helper does not exist, create it.

Do not stop because:

- the work is long.
- the context is large.
- tests are slow.
- implementation is hard.
- code deletion is uncomfortable.
- the current slice is "mostly working."

### Per-Phase Self-Review Loop

After every phase, the agent must answer in the execution log:

- What user-visible flow works now?
- What did I test at unit/integration/E2E level?
- What did I delete or consolidate?
- What old code did I keep and why?
- Could this phase have shipped with less code? What did I deliberately not build?
- What could still regress?
- Which command proves this phase is safe?

If any answer is weak, fix before moving on.

### Orchestration, Loops, And Third-Party Review

Execution uses native multi-agent orchestration. This is required, not optional:

- A lead agent implements phases sequentially (phases are dependency-ordered) and owns the execution log and all commits.
- Recon fan-out: before heavy phases (0, 5, 9, 10, 16), the lead fans out parallel read-only subagents to digest prior art, reference repos, and current docs instead of reading everything inline.
- Design judge panels: before implementing the sync protocol (Phase 9) and the conflict/co-editing model (Phase 10), generate at least 3 independent designs and score them with parallel judges against concrete failure scenarios: concurrent edit, offline rename, half-written file, watcher storm, clock skew, partial upload, reconnect-after-divergence. Each candidate is a doc with fixed sections: data model, message/protocol flow, behavior under each named failure scenario, estimated LOC and new dependencies, what it deletes. Judges receive identical briefs (candidate docs + Non-Negotiables + sync payload list + settle windows + perf budgets) and output a scored matrix (scenario × design, 0-2) plus a one-paragraph verdict. The winning design goes to `docs/architecture/` (losing designs and fatal flaws included); the Decision Ledger gets a one-line entry.
- Per-phase verification workflow: after the lead believes a phase is complete, fan out parallel verifier subagents before the phase commit: claimed-vs-actual completion check, test-quality check (do the tests actually fail without the implementation?), and UI screenshot review for UI phases.
- Checkpoint review workflows: at each major checkpoint below, run a multi-agent adversarial review with distinct lenses (security, collaboration/authz, performance, deletion-safety, data-loss) where each finding is independently verified before being accepted as real.
- Loops: the lead self-paces with scheduled wakeups and keeps executing while the user is AFK. Long test suites, builds, and dev servers run in the background; the lead never blocks the session foreground on a slow suite.

Codex third-party review (required):

- Tool: `codex exec review` (Codex CLI, verified installed and authenticated in this environment).
- Model: always pass `-m gpt-5.5` (verified working on this account; `gpt-5.5-fast` is not available under ChatGPT-account auth and adds output speed, not review depth). Do not modify the user's global `~/.codex/config.toml`.
- Effort tiering: checkpoint `--base main` reviews, per-phase reviews for security/sync/data-loss/deletion phases (2, 4, 5, 9, 10, 11, 13), design red-teams, the Phase 13 pre-deletion audit, and recovery consults run at `model_reasoning_effort="xhigh"`. Per-phase reviews for low-risk phases (0, 1, 12, 14, 15), adversarial scenario consults, and screenshot judging run at `"high"`. Remaining phases default to xhigh.
- For Phases 5, 8, and 10, the review prompt must additionally ask: "name any silent-data-loss scenario the tests do not cover" — scenario-completeness is a different question than code correctness.
- After every phase commit: run `codex exec review -m gpt-5.5 --commit <phase-sha>` at the phase's effort tier (see Effort tiering below). VERIFIED CONSTRAINT (0.130.0 and 0.137.0-alpha both): `--commit` cannot be combined with a custom prompt — commit-scoped reviews run with Codex's default review instructions, which is acceptable. For high-risk phases (2, 4, 5, 9, 10, 11, 13), follow with a targeted plain `codex exec` read-only call prompting the phase's specific risk areas plus over-engineering/orphaned-code/simplification findings against `git show <phase-sha>`. Record findings in the execution log.
- At every major checkpoint: run `codex exec review -m gpt-5.5 -c model_reasoning_effort="xhigh" --base main` (checkpoints are always xhigh) over the cumulative branch diff with targeted questions for that checkpoint's risk area (e.g., IPC validation at Phase 4, merge/data-loss at Phase 10, deletion completeness at Phase 13).
- Accountability: every Codex finding is either fixed (with a test where applicable) or explicitly rejected with reasoning in the execution log. Fixes land as follow-up commits in the same phase; do not amend or squash.
- Codex runs read-only as a reviewer; it must not edit the repo. The lead implements fixes.
- Pipelining: Codex reviews ALWAYS run as background tasks with stdout redirected to `docs/superpowers/reviews/codex/phase-NN.md`, launched immediately after the phase commit. While a review runs, the lead performs only read-only next-phase work (recon fan-outs, execution-map drafting, failing-test design — no commits, no shared-file mutation). A triage subagent reads the output file, dedupes, verifies each finding against actual code, and returns ≤15 numbered one-line actionable findings; the lead reads the raw transcript only when a triaged finding is ambiguous. Findings are triaged before the next phase's first commit.
- Re-review cap: follow-up fix commits get at most ONE targeted re-review per phase; residue rolls into the next checkpoint's cumulative `--base main` review.
- Invoke codex by the absolute path recorded in the execution log Environment section (PATH drift in fresh shells must not break the gate). If codex is temporarily unavailable, mark the phase "codex review pending," continue, and retry via self-paced wakeups (~10/30/60 min, max 3); a pending review is never silently dropped — the acceptance criteria remain the backstop.
- The gate is "independent third-party review," not one vendor binary. Phase 0 preflight verifies `codex` + `gpt-5.5` availability and records the result. If the exact tool/model is unavailable to the runner (different machine, CI, auth limits), the gate is satisfied by the first available fallback, recorded per phase in the execution log: (1) another available Codex model at the highest reasoning effort, (2) CodeRabbit review, (3) an independent adversarial verifier-subagent panel using the Checkpoint Review Recipe plus manual reviewer signoff. A runner without the preferred tool can therefore still complete every phase and the acceptance criteria.

Codex hard rules (independence and budget):

- Independence rule: Codex never reviews an artifact Codex authored or materially shaped. Codex authors no code, no tests, and no candidate designs in this repo — its only write target is its own transcript under `docs/superpowers/reviews/codex/`. Codex is never assigned an implementation lane, utility module, script, or migration, in any worktree or phase: commit-scoped reviews must never audit their own author, and ChatGPT usage limits are reserved for judgment, not keystrokes. Where Codex consults influence landed work (adversarial scenarios, recovery diagnoses, design-review findings), the phase log records provenance in one line each; the Phase 18 readiness review audits that no phase-commit review covered Codex-originated artifacts beyond triaged review findings.
- Budget rule: mandatory calls (phase-commit reviews, the single re-review, checkpoint reviews) have absolute priority. Discretionary calls (design red-teams, adversarial scenario consults, recovery consults, pre-deletion audit, screenshot passes) are capped at ONE per phase, must not launch while a mandatory review is pending or deferred for cap reasons, get zero retries, and are always skippable — nothing in the acceptance criteria depends on them. If any call hits a usage limit, all discretionary use suspends until the next mandatory call succeeds (recorded in the Resume Snapshot). Degradation order when limits bite, cut from the top: screenshot judging → adversarial scenario consults → pre-deletion audit → design red-teams → recovery consults → low-risk phase reviews (fallback chain) → never the high-risk phase or checkpoint reviews.
- Call ledger: the execution log Environment section gains an append-only Codex Calls table (date | purpose | effort | duration | outcome). Every codex invocation of any kind is logged.
- Discretionary-call hardening: same invocation discipline as the mandatory gate — absolute codex path, background task registered in the Resume Snapshot, stdout to `docs/superpowers/reviews/codex/`, hard timebox stated at launch (20 min recovery consult, 30 min screenshot pass, 45 min design red-team), terminated via the tracked task id on timeout, never pattern kills. Flag experiments (`--output-schema`, `-i`, session resume) happen on discretionary calls only — never change the mandatory review invocation mid-run.

Discretionary Codex uses (adopted set — nothing else without a Decision Ledger entry):

1. Design red-team (Phases 9 and 10; 2 calls, xhigh, 45-min timebox): after the judges select a winning design and BEFORE implementation lanes launch, run `codex exec` (read-only sandbox) over the winning doc in `docs/architecture/` plus the Non-Negotiables and the named failure scenarios, prompted for data-loss holes, ordering/idempotency flaws, hand-waved failure scenarios, and simpler alternatives. Findings go through the standard triage→verify→fix-or-reject pipeline before lane briefs are issued; the design doc gains a Red-team Findings section. While it runs the lead does only read-only phase prep. On failure/timeout, fold the design questions into that phase's commit-review prompt and proceed. Codex never authors judge-panel candidates — all candidates are Claude subagents; cross-model input enters only here, post-verdict.
2. Adversarial scenario consult (post-Phase-4 checkpoint: IPC validation; Phase 10: the six data-loss cases; post-Phase-11 checkpoint: MCP path scoping; 3 calls, high effort): `codex exec` read-only, prompted to ENUMERATE concrete attack/loss scenarios (inputs, sequence, expected invariant violation) — output is scenario descriptions, never test files or repo writes. The lead transcribes chosen scenarios into owned tests under normal TDD (recorded RED required), discards duplicates per the code-size rules, and logs which landed scenarios were Codex-origin. A scenario asserting behavior that contradicts the plan's contracts is rejected with reasoning, never satisfied by weakening the implementation.
3. Recovery consult (rare; see Recovery Protocol): one bounded fresh-model diagnosis before any blocked declaration or Phase 16 deferral.
4. Pre-deletion audit (Phase 13, 1 call, xhigh): see Phase 13 Step 2.5.
5. Advisory screenshot pass (Phases 3 and 18 only; 2 calls, high effort, via `-i` attachments; conditional on the Phase 0 `-i` preflight): score ≤8 representative PNGs against the Design Review Loop rubric verbatim. Strictly advisory — the Claude design-review subagent remains the sole gating judge. Hard-item disagreements are re-examined once by the lead against the actual pixels before the phase commit; soft-item disagreements become deferred findings for the Phase 18 re-judge. On `-i` error or timeout, skip silently.

### Parallel Lane Contract

Intra-phase implementation fan-outs are allowed only under these rules:

- Only the lead runs `pnpm add`/`pnpm install` and touches `pnpm-lock.yaml`/root `package.json`. Before fanning out, the lead scaffolds new package stubs and installs declared dependencies once; lanes never modify the lockfile.
- Lanes never write the execution log or this plan. Each lane returns a structured report (files changed, tests added, RED output, GREEN output, deletions, open questions) that the lead merges into the log.
- Every lane brief is self-contained (lanes share no conversation memory): phase goal, exact files owned, the TDD requirement (failing test recorded before implementation), file-ownership boundary, exact test commands, relevant Non-Negotiables. Never reference "as discussed above."
- File-mutating lanes are worktree-isolated. The lead merges lanes, regenerates the lockfile once if needed, runs the phase's combined test commands, then commits.

Per-phase parallelism map:

```txt
Phase 0:  fan out read-only explorers (one per required digest + one per existing package classification); baseline runs in background.
Phase 1:  none — single lead lane (tiny phase, shared scaffolding).
Phase 2:  none — single lead lane (coupled security posture). t3code recon fan-out may start here.
Phase 3:  implementation single-lane (shared shell/CSS). Fan out only read-only work: t3code recon, screenshot capture, design judges.
Phase 5:  lead defines watcher-event/change-set contracts first, then 3 worktree TDD lanes: A=workspace-fs watch/scan/diff, B=workspace-sync batchedSync, C=workspace-history changeSetStore. Lead-owned tail: shell wiring (shared DesktopWorkspaceShell.tsx).
Phase 6:  lead writes failing fileTypes E2E + scaffolds FileInspector as dispatch table with one file per view; optional 2-4 lanes by affinity (text/data, media, SQLite studio, app affordance). Skip fan-out if moving fast single-lane.
Phase 9:  start `pnpm dev:postgres` in background at phase start. After judge panel: Lane A=Better Auth (services/workspace-api), Lane B=sync protocol+backend (workspace-sync, workspace-postgres; stub actor shape from fixed ResolveActor contract), Lane C=compose/docs. Lane D (CloudLogin + E2E) starts after Lane A lands — dependency-ordered. cloudSync E2E runs last against background dev server.
Phase 10: after judge panel: Lane A=collaborationPolicy (workspace-sync), Lane B=conflictResolution (workspace-history), Lane C=postgres-acl (hocuspocus). Lead-owned tail: useCollabDoc, sync UI, both E2E specs (two-client E2E in background).
Phase 12: none — global rename is single-agent by nature.
Phase 13: Step 1 fans out one read-only verifier per ported-test-map row (locate test, run it, confirm it fails when implementation is stubbed). Steps 3-5 deletion is explicitly single-agent (global lockfile/import surgery). Post-deletion battery in background.
Phase 14: optional 2 lanes: A=update state machine, B=builder config+smoke+docs. Packaging build in background.
Phase 15: fan out one doc-writer per document (5 lanes, self-contained briefs incl. product-shape bullets + thesis + phase outcomes). Lead writes the check script; smokes in background.
Phase 16: measurement runs require quiescence (below). Optimization fixes MAY lane per disjoint target; authoritative re-measure on merged tree, quiesced.
Phase 17: discovery findings partitioned across read-only classifiers; consolidation rows lane per owner package when duplicate sites are disjoint. Verification battery sequential-in-background.
Phase 18: none — the readiness E2E is one intentionally sequential flow.
```

### Background/Foreground Rules

ALWAYS background (registered in Resume Snapshot, with completion notification): docker compose stacks; workspace-api/hocuspocus/web dev servers (never foreground — WSL safety); the baseline script; full `pnpm -r` test/typecheck; full `pnpm test:desktop:e2e`; electron-builder packaging; `pnpm check:self-host`; Phase 17/18 verification batteries; all `codex exec review` runs; the two-client liveCoEditing E2E.

ALWAYS foreground: the TDD inner loop's targeted commands — single-package vitest runs, single-spec Playwright runs, single-package typechecks. The red/green cycle needs immediate feedback.

Phase-end full regression goes background while the lead does the delete-or-justify pass and log update; the commit waits for the background green.

Measurement quiescence: before any measured performance run (Phase 2 launch marks onward, especially performance.spec.ts), drain or pause all background tasks, parallel subagents, and Codex reviews; verify no docker build/test suite is running; record the quiesced state in the log. Perf measurement owns the machine.

### Checkpoint Review Recipe

1. Lead computes `git diff --stat main...HEAD` and writes a 10-line range summary into the log.
2. Fan out one read-only finder per relevant lens (security, authz/collab, data-loss/deletion-safety, performance, over-engineering/code-size). Each brief is self-contained: repo path, branch, diff command, lens definition copied from Non-Negotiables, output format per finding: {claim, evidence file:line, severity, repro command, proposed fix}. Cap 10 highest-confidence findings per finder.
3. Launch the Codex `--base main` review in parallel (background); merge its findings into the same pipeline.
4. Lead dedupes; one fresh verifier per candidate finding, given ONLY the finding text and repo (not the finder's reasoning), must confirm by repro or exact code citation. Unconfirmed → rejected-with-reason. Verifiers are always Claude subagents; Codex participates in checkpoints only as a finder via the `--base main` review, and Codex findings are verified by non-Codex verifiers like any other finding.
5. Fix confirmed findings with targeted tests; re-run affected suites.
6. Stop rule: max 2 rounds, or stop early when a round yields zero new confirmed medium+ findings.

### Verifier Task Contracts (per-phase, before phase-closing commit)

- Claimed-vs-actual: input = phase plan section + commit range + log entry; method = re-run every command the log claims passed, check every checkbox against the diff; output = table of claim / evidence command / verdict (confirmed | unsupported | contradicted).
- Test-quality: method = disposable `git worktree add`, revert all non-test files in the phase range there, run the phase's test commands, expect failure; output = list of tests that still pass without the implementation (each is a finding). NEVER mutate the lead's checkout.
- Screenshot review: input = the Design Review Loop rubric + the fixed artifact glob `test-results/screenshots/phase-<NN>/`; output = per-rubric-item pass/fail with offending screenshot path.

### Recovery Protocol

- Flaky test: re-run the single failing spec in isolation once to classify. Pass-on-retry = flake — deflake in the same phase by replacing sleeps/races with event-driven waits (performance marks, IPC signals); max 3 attempts, then quarantine the spec with a log entry and a mandatory item at the next checkpoint. NEVER add Playwright `retries:`, broaden timeouts beyond 2x, or weaken assertions to mask flake.
- External service down (Postgres, minio, hocuspocus): the lead is authorized to start/restart via the documented compose commands (background, per WSL safety — no pattern kills). Not a blocker. An ECONNREFUSED/timeout from a service port is an environment failure, never a test failure; fix the environment, never the test.
- Electron launch failure on this machine: the fix is ALWAYS environmental, never webPreferences (see Phase 2).
- Toolchain freeze: Phase 0 records `node -v`, `pnpm -v`, and `command -v codex` in the Environment section. Tests must run under the Node version that reproduces the dual-backend green sweep (22.13.0 verified — Node 25 breaks 17 web tests); pin via PATH prefix in scripts, do not run `nvm use` mid-run. Codex is invoked by absolute path.
- Fresh-model consult (required before declaring blocked): when the same blocker survives three concrete attempts, or a Phase 16 metric is still over budget after its 3 optimization attempts, the lead writes a self-contained brief to `docs/superpowers/reviews/codex/blocker-<phase>-<slug>.md` (symptom, exact failing command, path to full output, files inspected, the three attempts and why each failed) and makes ONE `codex exec` consult — read-only sandbox, xhigh, 20-minute timebox, backgrounded — asking for the most likely root cause and the smallest concrete fix or next experiment. Rules: this is attempt 4-of-4, never a counter reset; any proposed diagnosis must be independently confirmed by the lead via repro or exact code citation before any code change; if Codex is unavailable or the timebox expires, proceed directly to the blocked report (zero retries). The diagnosis file is attached to any blocked report. This consult is exempt from the per-phase review budget but logged in the call ledger.

### Major Review Checkpoints

Use Codex third-party review plus multi-agent adversarial review workflows (and manual review if the user is present):

- after Phase 4: Electron security and IPC review.
- after Phase 7: local workspace/sync review.
- after Phase 9: cloud sync/collaboration review.
- after Phase 10: merge/data-loss and live co-editing review.
- after Phase 11: MCP/agent-power review.
- after Phase 13: Convex deletion review.
- after Phase 16: performance review.
- after Phase 17: codebase excellence/deletion review.
- after Phase 18: full product readiness review.

Fix relevant findings before continuing. If a finding is rejected, record why.

### Stop Conditions

Stop only if:

- the same blocker remains after three concrete attempts plus the Recovery Protocol fresh-model consult.
- a missing external secret/service is genuinely required.
- a product/security decision is genuinely required from the user.
- continuing would violate a non-negotiable.

Blocked report must include:

- exact blocker.
- incomplete phase and step.
- attempts made.
- files inspected.
- commands run.
- current failing tests.
- smallest required input.

## Branch And Execution Strategy

- The dual-backend plan is MERGED into main at bc62bd2 (PR #30). All "old plan" code lives in the current working tree. Never check out, diff against, or port from the stale local branch `codex/dual-backend-filesystem-agent-runtime`.
- Branch: `claude/desktop-local-first-cloud-sync`.
- Create an execution log at:
  - `docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md`
- Commit at every green-test milestone within a phase, message prefix `phaseN(step M): ...`; the final phase commit closes the phase. Git is the primary resume substrate — never leave hours of work in a dirty tree.
- Do not amend or squash phase commits during implementation; traceability matters.

Execution log template:

```md
# Desktop Local-First Cloud Sync Execution Log

## Resume Snapshot (overwrite in place — the ONLY mutable section)

- Phase/Step + TDD position: (e.g., "Phase 5 Step 3, tests written, expected RED")
- Expected test state: (exact command + which assertions should currently fail/pass)
- Dirty files and intent:
- Exact next action: (one imperative sentence)
- Active background tasks: (id, command, expected artifact path)
- Open worktrees: (path, purpose, merged?)
- Pending reviews: (codex/verifier in flight)

## Environment (append-only)

- Toolchain freeze: node version, pnpm version, absolute codex path
- Services state, display server, quirks

## Decision Ledger (append-only, one line each)

- D-NN | decision | why | phase

## Reference Digests (append-only, ≤25 lines each, source path + date)

## Gotchas (append-only one-liners, incl. learned file locations)

## Phase Logs

### Phase N: Name

- Status: not started | in progress | complete | blocked
- Execution map:
- Resume notes: (one sentence: what is half-done, exact next command)
- Files changed:
- Code deleted or consolidated:
- Net LOC delta (`git diff --shortstat`):
- Old paths retained and why:
- Dependencies added (name, size, justification):
- Decisions made (D-NN ids):
- Tests added:
- Commands run:
- Failing tests fixed:
- Electron E2E/manual smoke:
- UI/UX screenshot/design review:
- Performance measurements: (compact table rows, not prose)
- Security/collaboration regressions:
- Reviewer/subagent findings: (numbered one-liners, status: fixed @ sha | rejected: reason)
- Codex third-party review findings: (one-liners + pointer to docs/superpowers/reviews/codex/phase-NN.md)
- Relevant findings fixed:
- Deferred findings with reason:
- Remaining risk:
- Next phase:
```

Log update cadence and hygiene (mandatory):

- Update the Resume Snapshot at every TDD-step transition, before launching anything long-running (codex review, full suite, fan-out, worktree), and immediately after every commit. Register background tasks and worktrees in the snapshot BEFORE launching; clear entries on completion/merge. On resume, reconcile the snapshot against `git status`, `git worktree list`, and on-disk artifacts before doing anything else.
- The log is append-only except the Resume Snapshot.
- No raw command output, stack traces, or codex transcripts over ~10 lines — write full output to `test-results/` or `docs/superpowers/reviews/codex/phase-NN.md` and link the path.
- Soft cap ~80 lines per phase section; overflow goes to a per-phase appendix file.
- The resume read-set is: Resume Snapshot + Environment + Decision Ledger + Gotchas + Reference Digests + the current phase's section ONLY.

## Planned Repository Shape

Target shape after this plan:

```txt
apps/
  desktop/                  # Electron main/preload/app shell, desktop-first product
  web/                      # Web/cloud/shared-link client; may be renamed from apps/app
  mobile-web/               # optional later; not required in this plan

packages/
  workspace-core/           # local-first workspace model, modes, paths, change sets
  workspace-fs/             # existing package promoted: watch/materialize/scan/diff/apply
  workspace-postgres/       # existing package promoted: cloud/self-host store
  workspace-sync/           # local <-> cloud sync engine
  workspace-history/        # dohc-native change sets/provenance/conflict summaries
  desktop-bridge-contracts/ # typed preload IPC contract and zod schemas
  mcp/                      # dohc MCP server for Codex/Claude Code

services/
  workspace-api/            # cloud/self-host API over Postgres
  hocuspocus/               # collaborative text where needed
  sqlite-worker/            # SQLite import/materialization/query
  app-tester/               # app quality/runtime testing
  agent-sandbox/            # hosted/cloud sandbox; desktop local agents use folder+MCP first

docs/
  architecture/
  self-hosting.md
  desktop.md
```

The implementer may keep `apps/app` temporarily, but the plan should end with a clear `apps/desktop` and `apps/web` split or a documented reason why a safe rename must wait.

---

## Phase 0: Baseline, Tooling, And Old-Plan Inventory

**Files:**

- Create: `docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md`
- Create: `docs/superpowers/reviews/2026-06-10-old-plan-port-delete-inventory.md`
- Create: `scripts/check-desktop-local-first-baseline.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write execution log**

Create the execution log using the template above.

- [ ] **Step 2: Write old-plan inventory**

Create `docs/superpowers/reviews/2026-06-10-old-plan-port-delete-inventory.md` with:

```md
# Old Plan Port/Delete Inventory

## Keep And Promote

## Port With Changes

## Delete After Replacement

## Delete Immediately

## Tests To Preserve

## Tests To Rewrite

## Remaining Questions
```

Minimum classifications:

- Keep/promote: `workspace-postgres`, `workspace-fs`, `workspace-api`, `agent-sandbox`, `sqlite-worker`, `app-tester`, `workspace-contracts` concepts.
- Port with changes: uploads/file-type views, app runtime, agent output separation, backend matrix.
- Delete after replacement: Convex backend, Convex compat package, dual-backend switch, web-first atom tools, `.views` compatibility.
- Rewrite: backend matrix should become desktop/local/cloud matrix.

- [ ] **Step 3: Add baseline check**

Create `scripts/check-desktop-local-first-baseline.mjs`:

```js
import { spawnSync } from "node:child_process";

const env = {
  ...process.env,
  PATH: process.env.PATH ?? "",
};

const commands = [
  ["pnpm", ["--filter", "@dohc/web", "typecheck"]],
  ["pnpm", ["--filter", "@dohc/web", "test"]],
  ["pnpm", ["--filter", "@dohc/workspace-contracts", "test"]],
  ["pnpm", ["--filter", "@dohc/workspace-postgres", "test"]],
  ["pnpm", ["--filter", "@dohc/workspace-fs", "test"]],
  ["pnpm", ["--filter", "@dohc/workspace-api", "test"]],
  ["pnpm", ["--filter", "@dohc/app-tester", "test"]],
  ["pnpm", ["--filter", "@dohc/sqlite-worker", "test"]],
  ["pnpm", ["--filter", "@dohc/agent-sandbox", "test"]],
  ["pnpm", ["check:debt"]],
];

for (const [cmd, args] of commands) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: true, env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
```

- [ ] **Step 4: Register script**

Add:

```json
"check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs"
```

- [ ] **Step 5: Environment preflight, then run baseline**

Preflight first: start `pnpm dev:postgres` as a background task and poll readiness (bounded, ~60s max); record `node -v`, `pnpm -v`, and `command -v codex` in the execution log Environment section (toolchain freeze — tests run under Node 22.13.0 via PATH prefix; Node 25 breaks 17 web tests); record display server state. The baseline script must pin the test Node via PATH.

Codex capability preflight (one cheap call each, recorded in Environment): verify `codex exec review` works; verify plain `codex exec` completes under a read-only sandbox; verify `-i` correctly describes a known test PNG. If optional capabilities (`codex exec`, `-i`) fail, disable only the discretionary uses needing them. If `codex exec review` or the preferred model itself fails, the review gate is NOT disabled — it switches to the independent-review fallback chain from the Codex third-party review section, recorded in the execution log.

```bash
pnpm check:desktop-local-first-baseline
```

Run as a background task. Expected: pass, or execution log records exact pre-existing failures. An ECONNREFUSED from Postgres is an environment failure — fix services, do not record it as a pre-existing test failure.

The Step 2 inventory may fan out read-only explorer subagents (one per existing package/service, one per digest doc) per the parallelism map; the inventory must record exact file paths for app runtime, upload, and file-type code so later phases cite paths, not memories.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/check-desktop-local-first-baseline.mjs docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md docs/superpowers/reviews/2026-06-10-old-plan-port-delete-inventory.md
git commit -m "Inventory old plan for desktop local-first pivot"
```

---

## Phase 1: Local-First Workspace Core Contract

**Files:**

- Create: `packages/workspace-core/package.json`
- Create: `packages/workspace-core/tsconfig.json`
- Create: `packages/workspace-core/src/workspaceMode.ts`
- Create: `packages/workspace-core/src/paths.ts`
- Create: `packages/workspace-core/src/metadata.ts`
- Create: `packages/workspace-core/src/changeSet.ts`
- Create: `packages/workspace-core/src/conflicts.ts`
- Create: `packages/workspace-core/src/index.ts`
- Create: `packages/workspace-core/src/workspaceMode.test.ts`
- Create: `packages/workspace-core/src/paths.test.ts`
- Create: `packages/workspace-core/src/changeSet.test.ts`

- [ ] **Step 1: Write failing workspace mode tests**

Tests must assert:

```ts
expect(defaultWorkspaceMode("personal")).toBe("local-first");
expect(defaultWorkspaceMode("shared")).toBe("cloud-first-local-copy");
expect(defaultWorkspaceMode("cloud-only")).toBe("cloud-only");
```

Also assert workspace mode is per-workspace, not per-file.

- [ ] **Step 2: Write failing path tests**

Tests must assert:

- `~/dohc` is the default root suggestion.
- attached folders are allowed.
- `.dohc/manifest.json` is reserved.
- path traversal is rejected.
- `.apps/<name>/app.json` is a visible app source path.
- `.sqlite`, `.sqlite3`, and `.db` are visible database files.

- [ ] **Step 3: Write failing change-set tests**

Tests must assert:

- one agent run editing many files groups into one change set.
- normal allowed edits do not require approval.
- boundary crossings require review: public share, permission change, bulk delete, app trust/install, private-to-shared move.
- conflicts produce human-readable summaries, not Git markers.

- [ ] **Step 4: Implement workspace core**

Implement:

```ts
export type WorkspaceMode = "local-first" | "cloud-first-local-copy" | "cloud-only";
export type WorkspaceKind = "personal" | "shared" | "cloud-only";
export type ChangeSetKind = "user-edit" | "agent-run" | "import" | "sync" | "app-build";
export type BoundaryCrossing =
  | "public-share"
  | "external-export"
  | "permission-change"
  | "bulk-delete"
  | "app-trust"
  | "private-to-shared"
  | "unmergeable-overwrite";
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @dohc/workspace-core test
pnpm --filter @dohc/workspace-core typecheck
```

Expected: pass.

- [ ] **Step 6: Delete-or-justify**

Record in the execution log which old workspace contract types move into `workspace-core` and which remain temporarily in `workspace-contracts`.

- [ ] **Step 7: Commit**

```bash
git add packages/workspace-core package.json pnpm-lock.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Add local-first workspace core contract"
```

---

## Phase 2: Electron Desktop Scaffold And Test Harness

**Files:**

- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/preload.ts`
- Create: `apps/desktop/src/ipc/channels.ts`
- Create: `apps/desktop/src/ipc/bridgeContract.ts`
- Create: `apps/desktop/src/window/createMainWindow.ts`
- Create: `apps/desktop/src/security/electronSecurity.ts`
- Create: `apps/desktop/src/security/electronSecurity.test.ts`
- Create: `apps/desktop/src/performance/launchMarks.ts`
- Create: `apps/desktop/src/smoke/desktopSmoke.test.ts`
- Create: `apps/desktop/e2e/desktopLaunch.spec.ts`
- Create: `apps/desktop/scripts/smoke-test.mjs`
- Create: `apps/desktop/playwright.config.ts`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml` (onlyBuiltDependencies allowlist)

Root `playwright.config.ts` is NOT modified in this phase — it stays pointed at the web app so `pnpm test:e2e` keeps working.

- [ ] **Step 1: Install Electron desktop tooling**

Install current packages compatible with the repo's Node/Vite constraints:

```bash
pnpm add -D --filter @dohc/desktop electron electron-vite electron-builder @electron/fuses playwright @playwright/test
```

If workspace filtering cannot target a new package before creation, create `apps/desktop/package.json` first, then install.

Also add:

```bash
pnpm add --filter @dohc/desktop electron-updater zod
```

Expected dependency intent:

- `electron`: desktop runtime.
- `electron-vite`: build/dev main, preload, renderer entries.
- `electron-builder`: package/sign/update artifacts.
- `@electron/fuses`: harden packaged app features.
- `playwright` and `@playwright/test`: launch and test Electron windows.
- `electron-updater`: future update flow tests.
- `zod`: validate IPC payloads.

Install preconditions (verified landmines on this repo/host):

- pnpm 10 ignores dependency postinstall scripts by default and the repo has no allowlist. BEFORE installing, add to `pnpm-workspace.yaml`: `onlyBuiltDependencies: [electron, esbuild, electron-winstaller]` (extend for native deps later). After install, verify the Electron binary with `pnpm --filter @dohc/desktop exec electron --version` (under xvfb-run if needed) BEFORE writing any test. If it fails, run `pnpm approve-builds` and record in the log. Same applies in Phase 8 if native SQLite deps are added (plus electron-rebuild for the Electron ABI).
- Desktop E2E gets its own `apps/desktop/playwright.config.ts` (testDir `./e2e`, `workers: 1` — Electron instances can't parallelize on one display, NO webServer block, ~60s per-test timeout). Root script becomes `"test:desktop:e2e": "playwright test --config apps/desktop/playwright.config.ts"`. The root `playwright.config.ts` (testDir `./apps/app/e2e`, web dev-server bootstrap) must remain untouched so `pnpm test:e2e` keeps working.

- [ ] **Step 2: Write failing Electron security tests**

`apps/desktop/src/security/electronSecurity.test.ts` must assert:

- `nodeIntegration` is false.
- `contextIsolation` is true.
- `sandbox` is true.
- preload path is absolute.
- renderer cannot navigate to arbitrary external URLs.
- `window.open` external targets are denied or opened through safe shell handler.

- [ ] **Step 3: Write failing desktop launch E2E**

`apps/desktop/e2e/desktopLaunch.spec.ts` must launch Electron using Playwright:

```ts
import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";

test("launches dohc desktop and renders the first-run shell", async () => {
  const app = await electron.launch({
    args: ["apps/desktop/dist/main.js"],
    cwd: process.cwd(),
    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
  });
  const page = await app.firstWindow();
  await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();
  await page.screenshot({ path: "test-results/desktop-launch.png" });
  await app.close();
});
```

If the build output path differs, update the test after implementing `electron-vite` build. The RED failure should be missing desktop app/build output.

- [ ] **Step 4: Implement minimal Electron main/preload**

Use secure defaults:

```ts
new BrowserWindow({
  show: false,
  webPreferences: {
    preload: absolutePreloadPath,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  },
});
```

Expose only:

```ts
window.dohcDesktop.getVersion()
window.dohcDesktop.pickWorkspaceRoot()
window.dohcDesktop.getWorkspaceRegistry()
```

through `contextBridge`.

Also ship the minimal performance measurement harness required by the Continuous enforcement rules: marks for app-ready, first window, and first renderer paint in `launchMarks.ts`, exposed through a test-only bridge so the launch E2E writes `test-results/performance/desktop-performance.json` from day one. Later phases append their own marks to the same file; Phase 16 turns it into the hard gate.

- [ ] **Step 5: Add root scripts**

```json
"dev:desktop": "pnpm --filter @dohc/desktop dev",
"build:desktop": "pnpm --filter @dohc/desktop build",
"test:desktop": "pnpm --filter @dohc/desktop test",
"test:desktop:e2e": "playwright test --config apps/desktop/playwright.config.ts",
"smoke:desktop": "node apps/desktop/scripts/smoke-test.mjs"
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @dohc/desktop test
pnpm build:desktop
pnpm test:desktop:e2e
```

Expected: pass. If the environment lacks a display server, run under `xvfb-run` and record that in the execution log.

WSL2 sandbox rule: if Electron fails to launch on this machine, the fix is ALWAYS environmental, never webPreferences. Allowed: install missing system libraries (record them), run under xvfb-run, or pass `--no-sandbox` as a LAUNCH ARGUMENT in the Playwright harness only, gated on `DOHC_E2E_NO_CHROMIUM_SANDBOX=1` and recorded in the log. Forbidden: `sandbox: false`, `contextIsolation: false`, `nodeIntegration: true` in product code, or deleting/weakening the security tests. The security unit test asserts the webPreferences object as configured, so it passes regardless of host sandbox capability.

- [ ] **Step 7: Review against t3code**

Compare against:

```txt
/home/ice/dev/oss-repos/t3code/apps/desktop/src/main.ts
/home/ice/dev/oss-repos/t3code/apps/desktop/src/preload.ts
/home/ice/dev/oss-repos/t3code/apps/desktop/src/electron
```

Record which patterns were reused and which were intentionally avoided.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop package.json pnpm-lock.yaml pnpm-workspace.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Scaffold secure Electron desktop app"
```

---

## Phase 3: Native-Feeling Desktop Shell UX

**Files:**

- Create: `apps/desktop/src/renderer/DesktopRoot.tsx`
- Create: `apps/desktop/src/renderer/DesktopFirstRun.tsx`
- Create: `apps/desktop/src/renderer/DesktopWorkspaceShell.tsx`
- Create: `apps/desktop/src/renderer/nativeChrome.ts`
- Create: `apps/desktop/src/renderer/desktop.css`
- Create: `apps/desktop/src/renderer/DesktopFirstRun.test.tsx`
- Create: `apps/desktop/e2e/firstRunWorkspace.spec.ts`
- Modify: current React app exports if reused from `apps/app/src`

- [ ] **Step 1: Write failing first-run tests**

Tests must assert first launch:

- suggests `~/dohc`.
- allows choosing another folder.
- creates `personal` workspace.
- does not require login.
- offers "Enable dohc Cloud sync" but does not force it.
- looks and behaves like a desktop app, not a web onboarding page.

- [ ] **Step 2: Write failing native UX E2E**

Playwright Electron test must assert:

- app opens with a framelike desktop shell.
- sidebar/file tree is immediately usable.
- keyboard shortcuts work: new file, command palette, quick open.
- theme follows system but does not interrupt running agent/sync work.
- text does not overflow at 1280x800 and 1536x960.
- screenshot comparison or screenshot artifact exists for first-run, workspace shell, command palette, and file preview.
- app chrome uses muted dohc styling and does not render marketing/landing-page UI.
- agent activity renders as a timeline/panel, not as one giant final paragraph.

- [ ] **Step 3: Implement desktop-first shell**

Reuse current React components per the component reuse map: the Phase 3 recon must produce `docs/superpowers/reviews/2026-06-10-desktop-component-reuse-map.md`, classifying each candidate in `apps/app/src/components/` as (a) reuse as-is, (b) port with data-layer swap, or (c) rebuild — using the mechanical criterion: a component is reusable only if it has no imports from `convex/react`, `apps/app/convex/_generated`, or web router internals; otherwise its data access must be lifted to props fed by the typed desktop bridge. Implementer briefs cite this artifact, never "where sensible". Change UX that feels web-first.

Desktop shell must include:

- workspace switcher.
- local sync status.
- file tree.
- editor/preview/app area.
- agent/activity panel.
- command palette.
- upload/import action.
- cloud sync connect button.

Avoid landing-page UI. First screen should be the usable workspace.

Visual style requirements:

- preserve dohc's current simple muted styling.
- use warm paper/graphite foundations.
- keep sidebar density close to Obsidian/t3code rather than a SaaS dashboard.
- use restrained hover/active states.
- keep cards only for repeated items, modals, and genuinely framed tools.
- make command palette and file switcher keyboard-first.
- keep text readable and compact; no hero-sized type inside tool surfaces.
- no decorative gradients/orbs/bokeh.
- no AI-generated marketing copy inside the app shell.

- [ ] **Step 4: Run visual smoke**

```bash
pnpm test:desktop:e2e apps/desktop/e2e/firstRunWorkspace.spec.ts
```

Expected:

- screenshot saved.
- nonblank desktop shell.
- no overlapping text.
- first workspace created.
- first-run and workspace shell screenshots look native, muted, and consistent with dohc.
- command palette and file tree are visibly usable.

- [ ] **Step 5: Delete-or-justify**

Identify web-only onboarding UI that should not exist in desktop. Delete it if not needed for web/cloud-only; otherwise isolate it under web-only code.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop apps/app/src docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Add native desktop workspace shell"
```

---

## Phase 4: Local Workspace Registry And Folder Creation

**Files:**

- Create: `apps/desktop/src/workspaces/WorkspaceRegistry.ts`
- Create: `apps/desktop/src/workspaces/WorkspaceRegistry.test.ts`
- Create: `apps/desktop/src/workspaces/createWorkspaceFolder.ts`
- Create: `apps/desktop/src/workspaces/createWorkspaceFolder.test.ts`
- Modify: `apps/desktop/src/ipc/bridgeContract.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/renderer/DesktopFirstRun.tsx`
- Modify: `packages/workspace-core/src/metadata.ts`

- [ ] **Step 1: Write failing registry tests**

Tests must assert:

- default root is suggested as `${home}/dohc`.
- multiple attached folders are supported.
- duplicate folder attachment is rejected.
- local-only workspace does not require account.
- shared/cloud workspaces record remote identity only after sync is enabled.

- [ ] **Step 2: Write failing folder creation tests**

Tests must assert creating `personal` writes:

```txt
~/dohc/personal/
  .dohc/manifest.json
  .context/me.md
```

Manifest includes:

```json
{
  "version": 1,
  "workspaceId": "...",
  "mode": "local-first",
  "kind": "personal"
}
```

- [ ] **Step 3: Implement registry and folder creation**

Use Electron safe storage or app user data path for the registry. Visible workspace content lives where the user chose.

- [ ] **Step 4: Wire IPC**

Expose validated desktop bridge methods:

```ts
listLocalWorkspaces()
createLocalWorkspace(input)
attachWorkspaceFolder(input)
chooseWorkspaceRoot()
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @dohc/desktop test src/workspaces
pnpm test:desktop:e2e apps/desktop/e2e/firstRunWorkspace.spec.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop packages/workspace-core docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Add local workspace registry"
```

---

## Phase 5: File Watcher, Batched Sync, And Local-First History

**Files:**

- Modify: `packages/workspace-fs/src/watch.ts`
- Modify: `packages/workspace-fs/src/scan.ts`
- Modify: `packages/workspace-fs/src/diff.ts`
- Create: `packages/workspace-sync/package.json`
- Create: `packages/workspace-sync/tsconfig.json`
- Create: `packages/workspace-sync/src/batchedSync.ts`
- Create: `packages/workspace-sync/src/batchedSync.test.ts`
- Create: `packages/workspace-history/package.json`
- Create: `packages/workspace-history/src/changeSetStore.ts`
- Create: `packages/workspace-history/src/changeSetStore.test.ts`
- Modify: `apps/desktop/src/renderer/DesktopWorkspaceShell.tsx`

- [ ] **Step 1: Install watcher dependency**

```bash
pnpm add --filter @dohc/workspace-fs chokidar
```

- [ ] **Step 2: Write failing batched sync tests**

Tests must assert:

- single markdown save syncs after settle delay.
- 18 app-file writes group into one change set.
- temp files are ignored.
- SQLite WAL/journal writes do not sync raw transient files.
- generated app build output under `.dohc/cache` does not sync as user content.

- [ ] **Step 3: Write failing history tests**

Tests must assert:

- change set records user/agent/import/sync kind.
- provenance points to source prompt/import/agent run where available.
- human summary is generated or stored.
- no Git conflict markers appear in user files.
- the history store exposes an ordered change-set timeline queryable by the desktop UI: kind, author (human or agent), plain-language summary, files touched.

- [ ] **Step 4: Implement batched sync**

Use settled windows:

```txt
markdown/text: 500ms-2s
app folders: group until quiet for 2s
SQLite files: wait for WAL/journal settle or explicit import operation
bulk changes: group as one change set
```

- [ ] **Step 5: Implement local history store**

Store history under:

```txt
.dohc/history/
.dohc/changes/
```

Do not require Git.

- [ ] **Step 6: Wire desktop sync status and history surface**

Desktop shell shows:

- synced
- syncing
- local changes
- conflict
- cloud disconnected

Also wire the workspace history surface — the "git log for everyday people":

- a change-set timeline panel showing each change set's kind, author (human or agent), plain-language summary, and files touched.
- clicking a change set reveals what changed.
- this surface exists from this phase onward, in local-only mode with no account — so when sharing arrives later, collaboration adds zero new concepts.

- [ ] **Step 7: Run tests**

```bash
pnpm --filter @dohc/workspace-fs test
pnpm --filter @dohc/workspace-sync test
pnpm --filter @dohc/workspace-history test
pnpm test:desktop:e2e apps/desktop/e2e/firstRunWorkspace.spec.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add packages/workspace-fs packages/workspace-sync packages/workspace-history apps/desktop package.json pnpm-lock.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Add batched local sync and change history"
```

---

## Phase 6: Real File UX For Text, Data, Media, Apps, And Databases

**Files:**

- Modify: `apps/desktop/src/renderer/DesktopWorkspaceShell.tsx`
- Create: `apps/desktop/src/renderer/FileInspector.tsx`
- Create: `apps/desktop/src/renderer/FileInspector.test.tsx`
- Create: `apps/desktop/e2e/fileTypes.spec.ts`
- Modify: existing file-type view code from `apps/app/src/components/FileTypeView.tsx`
- Modify: app runtime and Database Studio code as needed

- [ ] **Step 1: Write failing file-type E2E**

Create a local workspace with:

```txt
notes/today.md
data/transactions.csv
data/config.json
uploads/receipt.png
uploads/contract.pdf
uploads/voice.m4a
finance/wallet.sqlite
finance/.apps/ledger/app.json
```

Test must assert:

- markdown opens as document/editor.
- CSV opens as data/table view with raw toggle.
- JSON opens as code/data view.
- image opens as image preview.
- PDF opens as file preview/download/open-external.
- audio opens with audio controls.
- SQLite opens Database Studio.
- `.apps/ledger` opens app package/source/runtime affordance.

- [ ] **Step 2: Implement FileInspector**

Port file-type view code from the current working tree (the dual-backend work is merged — never the stale branch): `apps/app/src/components/FileTypeView.tsx`, Database Studio components, and related media views, per the exact paths recorded in the Phase 0 inventory. Porting criterion: strip Convex/web data hooks; data arrives via the typed desktop bridge. FileInspector is a thin dispatch table with one file per view type (keeps later lanes conflict-free).

- [ ] **Step 3: Implement upload/import**

Desktop can add files by:

- drag/drop.
- file picker.
- agent-created file.
- copying into folder externally.

All paths should converge through workspace watcher/history.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @dohc/desktop test src/renderer/FileInspector.test.tsx
pnpm test:desktop:e2e apps/desktop/e2e/fileTypes.spec.ts
```

Expected: pass.

- [ ] **Step 5: Delete-or-justify**

Delete duplicate web-only file-type rendering paths if desktop/web can share `FileInspector`. Otherwise document why web-specific variants remain.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop apps/app/src docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Add native file type UX"
```

---

## Phase 7: Apps As Local Source Folders

**Files:**

- Modify: app runtime packages from old branch
- Create: `packages/workspace-core/src/apps.ts`
- Create: `packages/workspace-core/src/apps.test.ts`
- Create: `apps/desktop/e2e/localApps.spec.ts`
- Modify: `services/app-tester/src/runAppTest.ts`
- Modify: `apps/desktop/src/renderer/DesktopWorkspaceShell.tsx`

- [ ] **Step 1: Write failing app source tests**

Tests must assert:

```txt
finance/.apps/ledger/
  app.json
  src/App.tsx
  src/style.css
```

is discovered as a local app package.

Also assert:

- build output goes to `.dohc/cache/apps/ledger`.
- app source remains visible/editable.
- app manifest scopes are maximum scopes, not permissions.
- app trust is required for broad workspace writes.
- app tester runs before "ready" state.

- [ ] **Step 2: Write failing desktop app E2E**

Flow:

1. create local app folder.
2. edit `src/App.tsx`.
3. run app tester.
4. open app in desktop.
5. use a persistent control.
6. reload and confirm persistence.

- [ ] **Step 3: Implement local app discovery/build cache**

Use old `.apps` work, but pivot source discovery to local filesystem first.

- [ ] **Step 4: Run AppTester**

```bash
pnpm --filter @dohc/app-tester test
pnpm test:desktop:e2e apps/desktop/e2e/localApps.spec.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/workspace-core apps/desktop services/app-tester docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Run local apps from visible source folders"
```

---

## Phase 8: Visible SQLite And Data Import

**Files:**

- Modify: `services/sqlite-worker/src/sqliteEngine.ts`
- Create: `packages/workspace-core/src/databases.ts`
- Create: `packages/workspace-core/src/databases.test.ts`
- Create: `apps/desktop/e2e/sqliteImport.spec.ts`
- Modify: `apps/desktop/src/renderer/FileInspector.tsx`
- Modify: `services/app-tester` if needed

- [ ] **Step 1: Write failing SQLite import E2E**

Flow:

1. drop `wallet_records.csv` into `imports/`.
2. agent or import UI creates `finance/wallet.sqlite`.
3. user opens Database Studio.
4. app queries transactions.
5. edit category.
6. reload desktop.
7. query persists.

- [ ] **Step 2: Write failing raw-byte safety tests**

Tests must assert:

- SQLite WAL/journal files are not synced as standalone user files.
- database operation logs are recorded for structured row edits.
- raw SQLite bytes are not CRDT-synced.
- visible SQLite file materializes only after safe close/import/materialization point.

- [ ] **Step 3: Implement visible SQLite rules**

Visible database files are allowed for user data. `.dohc/databases` is allowed for hidden internal/cache databases only.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @dohc/sqlite-worker test
pnpm --filter @dohc/workspace-core test src/databases.test.ts
pnpm test:desktop:e2e apps/desktop/e2e/sqliteImport.spec.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/workspace-core services/sqlite-worker apps/desktop docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Support visible SQLite data files"
```

---

## Phase 9: Better Auth, Postgres Cloud Sync, And Self-Hosted Server

**Files:**

- Create: `services/workspace-api/src/auth/betterAuth.ts`
- Create: `services/workspace-api/src/auth/betterAuth.test.ts`
- Modify: `services/workspace-api/src/auth/session.ts`
- Create: `apps/desktop/src/renderer/CloudLogin.tsx`
- Create: `apps/desktop/e2e/cloudLogin.spec.ts`
- Modify: `services/workspace-api/src/server.ts`
- Modify: `packages/workspace-postgres`
- Create: `packages/workspace-sync/src/cloudSync.ts`
- Create: `packages/workspace-sync/src/cloudSync.test.ts`
- Create: `apps/desktop/e2e/cloudSync.spec.ts`
- Modify: `docker-compose.dev.yml`
- Modify: `docker-compose.self-host.yml`
- Modify: `docs/self-hosting.md`

- [ ] **Step 1: Write failing Better Auth tests**

`services/workspace-api/src/auth/betterAuth.test.ts` must assert:

- email/password signup and login work against Postgres via the Drizzle adapter.
- device authorization flow issues a usable desktop session (request device code, approve in browser-session context, poll succeeds, token works against the API).
- organization plugin supports create/invite/role for team workspaces.
- session validation middleware rejects missing/invalid/expired tokens with `unauthorized`.
- `ResolveActor` resolves a Better Auth session to the same actor shape existing authz checks use.
- local-only desktop flows never require auth.
- no WorkOS/Convex auth dependency remains in workspace-api.

- [ ] **Step 2: Implement Better Auth in workspace-api**

- Mount Better Auth (Drizzle adapter, provider `pg`) inside workspace-api on the existing Postgres instance.
- Enable `organization` and `deviceAuthorization` plugins.
- Wire `ResolveActor` to Better Auth sessions; keep all downstream authz unchanged.
- Email delivery: SMTP env config with console fallback for dev/self-host; production provider deferred.
- Document the WorkOS-behind-Better-Auth enterprise SSO/SCIM upgrade path in `docs/architecture/dohc-cloud.md`.

- [ ] **Step 3: Implement desktop device-flow login**

- `CloudLogin.tsx` shows the device code, opens the verification URL in the system browser (via safe shell handler), polls for approval, and stores the session token with Electron `safeStorage`.
- Login is only reachable from "Enable dohc Cloud sync"; local-only use never sees it.
- `apps/desktop/e2e/cloudLogin.spec.ts` drives the flow against the local dev server with a test-approved device code.
- Test seam (required — do not improvise): workspace-api under `DOHC_TEST_AUTH=1` (dev/test only, asserted absent in production builds) exposes a test-only approval route (e.g., `POST /test/device/approve`) backed by a seeded test user; the desktop app under `DOHC_DESKTOP_TEST=1` surfaces the verification URL/code via the test bridge instead of opening the system browser. The E2E reads the code from the bridge, approves via the API as the seeded user, asserts polling succeeds and the stored token authenticates a real API request. Mocking the entire device flow client-side is a test-quality failure the verifier must flag.
- Service bring-up: add root scripts `dev:cloud` (compose up postgres/minio + workspace-api dev server as background tasks; hocuspocus added in Phase 10) and `check:cloud-ready` (bounded readiness poll of postgres/object storage/API — and hocuspocus when enabled — printing the exact remediation command for any unreachable service). The desktop Playwright config gets a helper that fails fast naming the bring-up command. Every cloud/collab E2E command block in Phases 9, 10, 15, and 18 starts with `pnpm dev:cloud && pnpm check:cloud-ready`.

- [ ] **Step 4: Write failing cloud sync tests**

Tests must assert:

- local-first personal workspace can sync after login.
- local-only workspace works without login.
- shared/team workspace creates cloud-first local working copy.
- normal allowed edits auto-sync.
- permission changes/public sharing require explicit confirmation.
- another collaborator sees synced updates.

- [ ] **Step 5: Implement sync protocol**

Sync protocol carries:

- workspace manifest.
- file content hashes.
- change sets.
- asset blobs.
- database operation logs.
- provenance.
- conflict summaries.

- [ ] **Step 6: Implement Postgres sync backend**

Use `workspace-postgres` as the only cloud/self-host backend for new architecture.

- [ ] **Step 7: Run tests**

```bash
pnpm --filter @dohc/workspace-api test src/auth
pnpm --filter @dohc/workspace-sync test
pnpm --filter @dohc/workspace-postgres test
pnpm --filter @dohc/workspace-api test
pnpm dev:cloud
pnpm check:cloud-ready
pnpm test:desktop:e2e apps/desktop/e2e/cloudLogin.spec.ts
pnpm test:desktop:e2e apps/desktop/e2e/cloudSync.spec.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add packages/workspace-sync packages/workspace-postgres services/workspace-api apps/desktop docker-compose.dev.yml docker-compose.self-host.yml docs/self-hosting.md docs/architecture/dohc-cloud.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Add Better Auth and Postgres cloud sync for desktop workspaces"
```

---

## Phase 10: Liberal Collaboration, Live Co-Editing, And AI-Assisted Conflicts

**Files:**

- Create: `packages/workspace-sync/src/collaborationPolicy.ts`
- Create: `packages/workspace-sync/src/collaborationPolicy.test.ts`
- Create: `packages/workspace-history/src/conflictResolution.ts`
- Create: `packages/workspace-history/src/conflictResolution.test.ts`
- Create: `services/hocuspocus/src/postgres-acl.ts`
- Create: `services/hocuspocus/src/postgres-acl.test.ts`
- Create: `apps/desktop/src/renderer/collab/useCollabDoc.ts`
- Create: `apps/desktop/e2e/collaboration.spec.ts`
- Create: `apps/desktop/e2e/liveCoEditing.spec.ts`
- Modify: desktop sync UI

- [ ] **Step 1: Write failing liberal policy tests**

Tests must assert:

- edit access allows normal user edits.
- edit access allows normal agent edits.
- no approval is required for ordinary file edits.
- explicit protected folder blocks or proposes changes.
- boundary crossings require confirmation.
- collaborator edits appear in the shared workspace history timeline with correct attribution: which human, and which agent acting for whom.
- returning to a shared workspace after time away surfaces a plain-language catch-up of change sets since the user last looked.

- [ ] **Step 2: Write failing conflict tests**

Tests must assert:

- safe markdown changes auto-merge.
- unmergeable conflict preserves both versions.
- conflict summary is human-readable.
- AI resolution proposal can be stored.
- user can apply, keep both, or dismiss.
- no Git conflict markers are inserted by default.

- [ ] **Step 3: Write failing Hocuspocus Postgres ACL tests**

`services/hocuspocus/src/postgres-acl.test.ts` must assert:

- edit access resolved from workspace-postgres grants allows document writes.
- read-only access allows connect/read but rejects writes.
- no access rejects the connection.
- Better Auth session tokens are accepted as the connection credential.
- no Convex import or Convex env var remains in the ACL path.

- [ ] **Step 4: Write failing two-client live co-editing E2E**

`apps/desktop/e2e/liveCoEditing.spec.ts` must launch two Electron clients on the same shared workspace markdown doc and assert:

- concurrent edits from both clients converge to identical content.
- remote presence/cursor is visible while the peer edits.
- a client that disconnects, edits offline, and reconnects converges without data loss and without Git markers.
- local-first personal workspaces work fully without Hocuspocus running.
- typing latency stays within the existing typing budget while co-editing is active; propagation time between clients is measured and recorded.

- [ ] **Step 5: Implement live co-editing**

- Port `services/hocuspocus/src/convex-acl.ts` to `postgres-acl.ts` (workspace-postgres grants + Better Auth sessions). Mark `convex-acl.ts` for deletion in Phase 13.
- Wire the desktop markdown editor to Yjs/Hocuspocus via `useCollabDoc.ts` for shared cloud-first workspaces only.
- Canonical-state model (default, adopted): the CRDT doc is canonical while a shared text file has an active editor session; the filesystem is canonical while closed. The CRDT materializes back to the file on settle through the same batched sync/change-set path. The Phase 10 judge-panel design doc must define, and the implementation must TEST, each of these data-loss cases:
  - active canonical state while a shared text file is open (and what "open" means across two clients).
  - a base version/hash recorded for every materialization.
  - watcher suppression for self-materialized writes (no materialize → watch → materialize loops).
  - conflict behavior when the on-disk file changes outside Yjs while the doc is open (external agent edit during a live session).
  - offline edit + reconnect convergence without loss.
  - rename/delete of a file with an active Yjs doc.
  - Every case above gets an explicit data-loss test; "preserves both versions" is the floor, silent loss is never acceptable.
- CRDT applies to markdown/text only — never raw SQLite bytes or binary assets.

- [ ] **Step 6: Implement collaboration policy**

Policy should lean liberal:

```txt
allowed edit -> sync
explicit protected target -> propose/review
boundary crossing -> confirm
conflict -> AI-assisted resolution
permission denied -> keep local unsynced and explain
```

- [ ] **Step 7: Run collaboration E2E**

```bash
pnpm --filter @dohc/workspace-sync test
pnpm --filter @dohc/workspace-history test
pnpm --filter @dohc/hocuspocus test src/postgres-acl.test.ts
pnpm dev:cloud
pnpm check:cloud-ready
pnpm test:desktop:e2e apps/desktop/e2e/collaboration.spec.ts
pnpm test:desktop:e2e apps/desktop/e2e/liveCoEditing.spec.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add packages/workspace-sync packages/workspace-history services/hocuspocus apps/desktop docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Add liberal collaboration, live co-editing, and AI conflicts"
```

---

## Phase 11: Local Agent Integration And MCP

**Files:**

- Create: `packages/mcp/package.json`
- Create: `packages/mcp/src/server.ts`
- Create: `packages/mcp/src/tools.ts`
- Create: `packages/mcp/src/tools.test.ts`
- Create: `apps/desktop/src/agents/AgentIntegration.ts`
- Create: `apps/desktop/src/agents/AgentIntegration.test.ts`
- Create: `apps/desktop/e2e/localAgent.spec.ts`
- Create: `apps/desktop/src/renderer/settings/DesktopSettings.tsx` (+ test) — a single settings surface reachable from the command palette and app menu, following the Design Review Loop rubric; created here because Phase 11 is its first consumer (no earlier phase builds settings)

- [ ] **Step 1: Write failing MCP tests**

MCP tools must include:

```txt
dohc.list_workspaces
dohc.workspace_status
dohc.sync_now
dohc.create_app
dohc.test_app
dohc.import_data
dohc.query_database
dohc.share
dohc.resolve_conflict
dohc.open_in_dohc
```

Tests must assert tools operate on allowed workspace paths and reject path traversal.

- [ ] **Step 2: Write failing local agent E2E**

Flow:

1. create local workspace.
2. open workspace folder path.
3. simulate external agent writing files.
4. dohc detects and syncs changes.
5. MCP `test_app` runs against local app.
6. MCP `sync_now` reports clean state.

- [ ] **Step 3: Implement MCP server**

Desktop runs/advertises a local MCP server for Codex/Claude Code configuration. It should be optional and clearly user-controlled.

- [ ] **Step 4: Add setup docs and UI**

Desktop settings show:

- workspace path.
- MCP server status.
- copyable MCP config snippet.
- agent usage examples.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @dohc/mcp test
pnpm --filter @dohc/desktop test src/agents
pnpm test:desktop:e2e apps/desktop/e2e/localAgent.spec.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp apps/desktop docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Add local agent MCP integration"
```

---

## Phase 12: Web App Repositioning

**Files:**

- Rename or split: `apps/app` -> `apps/web` if safe
- Modify: `apps/web/package.json`
- Modify: web routes/components as needed
- Create: `apps/web/src/__tests__/cloudWebRole.test.ts`
- Modify: root scripts

- [ ] **Step 1: Write failing web role tests**

Tests must assert web supports:

- cloud workspace access.
- shared links.
- mobile-friendly viewing/editing.
- cloud-only workspace.
- no local filesystem claims.
- prompts user to install desktop for local folders/agent filesystem power.

- [ ] **Step 2: Split or rename web app**

If safe, rename `apps/app` to `apps/web` and update package names/imports.

The rename is "safe" iff after `git mv apps/app apps/web` plus updating pnpm-workspace.yaml, root scripts, tsconfig path aliases, and playwright config: (1) `grep -rn 'apps/app'` over `*.{ts,tsx,json,yml,yaml,mjs}` (excluding docs/ and node_modules) returns zero hits, (2) `pnpm -r --if-present typecheck && pnpm --filter @dohc/web test` passes, (3) `pnpm test:e2e` passes. If any condition fails after one focused fix pass, keep the path, record the failing condition verbatim in the execution log as the deletion condition, and move on. (Note: the package is already named `@dohc/web` while living at `apps/app`.)

- [ ] **Step 3: Update web UX**

Web should not feel like the primary local-files client. It should clearly be dohc Cloud/web access.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @dohc/web test
pnpm --filter @dohc/web typecheck
pnpm test:e2e
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps package.json pnpm-lock.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Reposition web app for cloud access"
```

---

## Phase 13: Convex Deletion And Ported Test Gate

**Files:**

- Delete: `apps/web/convex` or `apps/app/convex`
- Delete: `packages/workspace-convex-compat`
- Delete/modify: Convex scripts and generated API files
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `docs/superpowers/reviews/2026-06-10-convex-deletion-review.md`

- [ ] **Step 1: Create ported test map**

The review must list every important Convex-era behavior and its replacement test:

```md
| Convex-era behavior | Replacement package/test | Status |
|---|---|---|
| atom create/read/write | workspace-core/workspace-sync/workspace-postgres tests | pass |
| authz boundaries | workspace-api + sync policy tests | pass |
| auth/login (WorkOS via Convex) | Better Auth tests + desktop cloudLogin E2E | pass |
| hocuspocus ACL (convex-acl) | postgres-acl tests + live co-editing E2E | pass |
| app trust | local app trust + cloud sync tests | pass |
| uploads/assets | desktop file type + workspace sync tests | pass |
| onboarding/setup | desktop first-run tests | pass |
```

- [ ] **Step 2: Run tests before deletion**

```bash
pnpm check:desktop-local-first-baseline
```

Expected: pass.

- [ ] **Step 2.5: Cross-model pre-deletion audit**

Run in background, registered in the Resume Snapshot (1 call, xhigh): `codex exec` (read-only sandbox) reading the Convex sources (`apps/app/convex` or `apps/web/convex`), `packages/workspace-convex-compat`, and `services/hocuspocus/src/convex-acl.ts` in full against the ported test map, asked to list (a) every user-visible or security-relevant behavior implemented in Convex code with NO row in the map, and (b) every map row whose named replacement test does not actually cover the behavior — with file:line citations. The triage subagent verifies each claimed gap; confirmed gaps get a map row plus a replacement test before Step 3 runs. Step 3 MUST NOT start while this audit is in flight. This hunts unknown-unknowns the diff-shaped reviews cannot see: a behavior missing from the map appears in no diff.

- [ ] **Step 3: Delete Convex**

Remove Convex-specific packages, scripts, generated API files, env examples, and compatibility package. This includes `services/hocuspocus/src/convex-acl.ts` (replaced by `postgres-acl.ts` in Phase 10) and the `@convex-dev/workos-authkit` dependency (replaced by Better Auth in Phase 9).

Do not delete product behavior; delete only after replacement tests exist.

- [ ] **Step 4: Run tests after deletion**

```bash
pnpm -r --if-present typecheck
pnpm -r --if-present test
pnpm test:desktop:e2e
pnpm check:debt
git diff --check
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
# Full reviewed stage — the deletion touches sources, packages, lockfile, env examples
git status --short   # paste this into the execution log so deletion scope is inspectable
git add -A
git status --short   # verify nothing unexpected remains unstaged
git commit -m "Delete Convex after local-first replacements"
```

---

## Phase 14: Packaging, Updates, Signing Readiness, And Smoke Tests

**Files:**

- Create: `apps/desktop/electron-builder.yml` or builder config
- Create: `apps/desktop/src/updates/*`
- Create: `apps/desktop/src/updates/updateMachine.test.ts`
- Create: `apps/desktop/scripts/package-smoke.mjs`
- Modify: `package.json`
- Modify: CI docs/config if present
- Create: `docs/desktop.md`

- [ ] **Step 1: Write failing packaging smoke**

Smoke must assert:

- desktop build exists.
- main/preload/renderer build outputs exist.
- Electron fuses are configured for release builds.
- unsigned release build is not silently treated as production-signed.
- package metadata uses `dohc`.

- [ ] **Step 2: Implement builder config**

Use `electron-builder` for initial packaging because:

- t3code uses it successfully.
- docs cover code signing and auto-update.
- it supports macOS/Windows/Linux artifacts.

Release signing secrets are not required for local dev, but CI/release config must fail safely if production signing is requested without credentials.

- [ ] **Step 3: Implement update state machine tests**

Do not require live update server. Test state transitions and user-visible messaging.

- [ ] **Step 4: Run package smoke**

```bash
pnpm build:desktop
pnpm smoke:desktop
pnpm --filter @dohc/desktop test src/updates
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop docs/desktop.md package.json docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Add desktop packaging and update readiness"
```

---

## Phase 15: Self-Host, Cloud Naming, And Open-Source Readiness

**Files:**

- Modify: `docs/self-hosting.md`
- Create: `docs/architecture/desktop-local-first.md`
- Create: `docs/architecture/dohc-cloud.md`
- Create: `docs/architecture/workspace-sync.md`
- Modify: `README.md`
- Modify: `docker-compose.self-host.yml`
- Create: `scripts/check-self-host-desktop-path.mjs`
- Modify: `package.json`

- [ ] **Step 1: Document product shape**

Docs must state:

- `dohc` is the product.
- `dohc Desktop` is the primary local-first client.
- `dohc Cloud` is managed sync/hosting/collaboration.
- self-hosted dohc runs the cloud/sync/collab server.
- local-only works with no account.
- federation is deferred.
- the collaboration thesis: dohc brings git-grade building-collaboration (change sets, history, attribution, AI-assisted merge) to everyday people. dohc Cloud is the paid engine for shared building — this is why dohc is not an Obsidian clone, and why the history/attribution/catch-up surfaces are core product.

- [ ] **Step 2: Write self-host check**

Check:

- Postgres starts.
- object storage starts.
- workspace API starts.
- web starts.
- Hocuspocus starts if enabled.
- app tester starts.
- sqlite worker starts.
- desktop can connect to local self-host endpoint.

- [ ] **Step 3: Run docs/smoke**

```bash
pnpm dev:cloud
pnpm check:cloud-ready
pnpm check:self-host
pnpm check:self-host-desktop-path
```

Expected: pass or exact Docker/service blocker recorded.

- [ ] **Step 4: Commit**

```bash
git add README.md docs docker-compose.self-host.yml scripts/check-self-host-desktop-path.mjs package.json docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Document desktop local-first cloud shape"
```

---

## Phase 16: Performance Budgets And Native-Speed Gate

**Files:**

- Create: `packages/performance/package.json`
- Create: `packages/performance/tsconfig.json`
- Create: `packages/performance/src/budgets.ts`
- Create: `packages/performance/src/measurements.ts`
- Create: `packages/performance/src/assertBudget.ts`
- Create: `packages/performance/src/assertBudget.test.ts`
- Create: `apps/desktop/e2e/performance.spec.ts`
- Create: `apps/desktop/src/performance/desktopMarks.ts`
- Create: `apps/desktop/src/performance/desktopMarks.test.ts`
- Create: `scripts/check-performance.mjs`
- Create: `docs/superpowers/reviews/2026-06-10-desktop-performance-review.md`
- Modify: `package.json`
- Modify: execution log

- [ ] **Step 1: Add performance package and budgets**

Create `packages/performance/src/budgets.ts` with named budgets matching the Performance Budgets section:

```ts
export const performanceBudgets = {
  coldLaunchToShellMs: 2000,
  warmLaunchToShellMs: 1000,
  createEmptyWorkspaceMs: 1000,
  openThousandFileWorkspaceMs: 1500,
  fileTreeSearchTenThousandPathsMs: 100,
  fileTreeSearchVisibleResultMs: 200,
  openMarkdown250KbMs: 150,
  typingLongTaskMs: 50,
  singleFileSyncDetectMs: 2000,
  hundredFileChangeSetMs: 3000,
  warmAppOpenMs: 1000,
  appTesterSmallAppMs: 15000,
  sqliteTenThousandRowsFirstPageMs: 1000,
  csvTenThousandRowsImportMs: 5000,
} as const;
```

- [ ] **Step 2: Write failing budget tests**

`packages/performance/src/assertBudget.test.ts` must assert:

- passing measurements under budget pass.
- over-budget measurements fail with a helpful message.
- CI environment multipliers require explicit `PERF_BUDGET_MULTIPLIER`, capped at 3.0, with a per-budget written justification naming the hardware constraint. Multipliers never apply to relative-regression ratchets (the 20% memory and 10% bundle rules) — those are environment-independent.
- any edit to `budgets.ts` after its first commit must be named explicitly in that commit's Codex review prompt ("budget X changed from A to B because C").
- missing measurements fail.

- [ ] **Step 3: Instrument desktop**

Add performance marks around:

- Electron app ready.
- first window created.
- first renderer paint.
- first workspace shell interactive.
- workspace folder creation.
- file tree loaded.
- file tree search complete.
- markdown file opened.
- sync batch started/completed.
- app runtime opened.
- SQLite first page rendered.

Marks must be available to Playwright Electron tests through a safe test-only bridge.

- [ ] **Step 4: Write desktop performance E2E**

`apps/desktop/e2e/performance.spec.ts` must measure:

1. cold launch to visible shell.
2. warm launch to visible shell.
3. create empty workspace.
4. open generated 1,000-file workspace.
5. search generated 10,000-path file tree.
6. open 250KB markdown file.
7. batch 100 changed files.
8. open warm cached app.
9. open 10,000-row SQLite table first page.
10. import 10,000-row CSV.

The test should save measurements to:

```txt
test-results/performance/desktop-performance.json
```

and attach screenshots for the launch/file-tree/database states.

- [ ] **Step 5: Add performance script**

Create `scripts/check-performance.mjs` that:

- reads `test-results/performance/desktop-performance.json`.
- checks every required measurement.
- compares each number to `packages/performance` budgets.
- prints a clear table.
- fails on missing or over-budget metrics.

Add root script:

```json
"check:performance": "node scripts/check-performance.mjs"
```

- [ ] **Step 6: Fix performance issues**

If any measurement is over budget, optimize before moving on. Exit rule: per over-budget metric, maximum 3 optimization attempts with recorded before/after numbers; after the third failed attempt, run the Recovery Protocol fresh-model consult (one Codex diagnosis of the hot path) before deferral; if still over, record the gap as a deferred finding for the Phase 16 checkpoint review rather than looping — but a metric that regressed relative to an earlier phase's recorded number is never deferrable.

Expected optimization areas:

- lazy-load heavy renderer panels.
- virtualize large file trees/tables.
- move scan/index/import work off the renderer thread.
- debounce and batch file watcher work.
- cache app builds.
- page SQLite data.
- avoid duplicate markdown parsing.
- remove unnecessary React re-renders.
- avoid sync polling loops.

Record every optimization in the execution log with before/after numbers.

- [ ] **Step 7: Write performance review**

Create `docs/superpowers/reviews/2026-06-10-desktop-performance-review.md`:

```md
# Desktop Performance Review

## Verdict

## Environment

## Measurements

| Budget | Target | Measured | Pass |
|---|---:|---:|---|

## Optimizations Made

## Regressions Prevented By Tests

## Remaining Performance Risks
```

- [ ] **Step 8: Run performance verification**

```bash
pnpm --filter @dohc/performance test
pnpm --filter @dohc/desktop test src/performance
pnpm test:desktop:e2e apps/desktop/e2e/performance.spec.ts
pnpm check:performance
```

Expected: pass. If CI hardware makes a hard budget unrealistic, record local environment and use an explicit multiplier with explanation. Do not silently loosen budgets.

- [ ] **Step 9: Commit**

```bash
git add packages/performance apps/desktop scripts/check-performance.mjs docs/superpowers/reviews/2026-06-10-desktop-performance-review.md package.json pnpm-lock.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Add desktop performance budgets"
```

---

## Phase 17: Evolution Cleanup And Codebase Excellence Gate

**Files:**

- Create: `docs/architecture/codebase-map.md`
- Create: `docs/superpowers/reviews/2026-06-10-desktop-local-first-tech-debt-audit.md`
- Create: `knip.json`
- Create: `scripts/check-architecture-debt.mjs`
- Modify: `scripts/check-tech-debt.mjs`
- Modify: `package.json`
- Modify/delete: obsolete code identified by this phase
- Modify: execution log

- [ ] **Step 1: Install unused-code tooling**

Install `knip` for unused files, exports, and dependency detection:

```bash
pnpm add -D -w knip
```

Add root scripts:

```json
"check:unused": "knip",
"check:architecture-debt": "node scripts/check-architecture-debt.mjs",
"check:lean": "pnpm check:unused && pnpm check:debt && pnpm check:architecture-debt"
```

- [ ] **Step 2: Configure unused-code scan**

Create `knip.json` with monorepo-aware project entries for:

```txt
apps/desktop
apps/web or apps/app if rename is deferred
packages/*
services/*
scripts
```

Allowlist only:

- generated route/tree files that are regenerated by framework tooling.
- config entrypoints used by external CLIs.
- migration files loaded by runtime path.
- public package exports intentionally consumed outside the repo.

Every allowlist entry must include a short comment in the debt audit with a deletion or verification condition.

- [ ] **Step 3: Write architecture debt checker**

Create `scripts/check-architecture-debt.mjs`.

It must fail on shipping-source references to:

```txt
convex
workspace-convex-compat
DOHC_BACKEND=convex
dual-backend
.views as product language
@dohc/view as product language
legacy onboarding dashboard language
markdown-only fake dashboard language
```

The checker may allow historical plan/review docs only by exact path allowlist.

It must also fail when:

- desktop imports from web-only code without going through shared packages.
- renderer imports Node/Electron modules.
- preload exposes unvalidated IPC passthrough.
- local-first packages import Convex.
- multiple packages implement the same file-type detection table.
- multiple packages implement separate workspace path validators.

- [ ] **Step 4: Create codebase map**

Create `docs/architecture/codebase-map.md`.

It must describe the final intended module boundaries:

```txt
apps/desktop        Electron main/preload/renderer only
apps/web            cloud/shared-link/web client only
packages/workspace-core
packages/workspace-fs
packages/workspace-sync
packages/workspace-history
packages/workspace-postgres
packages/mcp
services/workspace-api
services/app-tester
services/sqlite-worker
services/hocuspocus
```

For each module, write:

- what it owns.
- what it must not import.
- what can import it.
- which tests prove it.

- [ ] **Step 5: Run cleanup discovery**

Run:

```bash
pnpm check:unused
pnpm check:debt
pnpm check:architecture-debt
git diff --stat main...HEAD
git diff --name-status main...HEAD
```

Expected:

- checks may fail on first run.
- execution log records every failure.
- each failure is either fixed or explicitly allowlisted with a deletion condition.

- [ ] **Step 6: Delete aggressively but safely**

Delete or consolidate as much as tests allow.

Priority deletion targets:

- Convex packages, generated files, scripts, env vars, docs, and runtime imports.
- `packages/workspace-convex-compat`.
- dual-backend switch code.
- Convex-only tests once replacement tests prove the behavior.
- duplicated backend clients.
- duplicated file tree/path utilities.
- duplicated file-type detection tables.
- duplicated upload/import code.
- stale `.views` runtime/product language after `.apps` tests cover replacement.
- web-first onboarding/setup code that conflicts with desktop first-run.
- old agent tools that duplicate MCP/local-file workflows.
- dead scripts from the old dev stack.
- stale docs that describe the old web-first/Convex architecture as current.

Keep only:

- compatibility/migration code backed by active tests.
- historical docs clearly marked historical.
- security checks.
- review gates.
- app trust checks.
- provenance/history code.

- [ ] **Step 7: Consolidate architecture**

For every duplicated helper, choose one owner package:

```txt
workspace path validation -> packages/workspace-core
file type detection -> packages/workspace-core
filesystem scan/diff/apply -> packages/workspace-fs
sync policy -> packages/workspace-sync
change sets/conflicts -> packages/workspace-history
database file rules -> packages/workspace-core + sqlite-worker
MCP tool schemas -> packages/mcp
IPC schemas -> desktop-bridge-contracts or apps/desktop/src/ipc
```

Move logic to the owner, update imports, and delete the duplicates.

- [ ] **Step 8: Write tech debt audit**

`docs/superpowers/reviews/2026-06-10-desktop-local-first-tech-debt-audit.md` must include:

```md
# Desktop Local-First Tech Debt Audit

## Standard

This branch should leave dohc in a lean, coherent state that a top-tier engineer would want to work in.

## Code Deleted

## Code Consolidated

## Dependencies Removed

## Convex Deletion Evidence

## Web-First Code Retained And Why

## Compatibility Code Retained And Deletion Conditions

## Allowlisted Unused/Architecture Findings

## Tests That Prove Behavior Survived

## Commands Run

## Remaining Risk
```

- [ ] **Step 9: Run post-cleanup verification**

```bash
pnpm dev:cloud
pnpm check:cloud-ready
pnpm -r --if-present typecheck
pnpm -r --if-present test
pnpm build:desktop
pnpm test:desktop:e2e
pnpm smoke:desktop
pnpm check:performance
pnpm test:e2e
pnpm check:self-host
pnpm check:lean
git diff --check
```

Expected: pass. Fix cleanup regressions before continuing.

- [ ] **Step 10: Commit**

```bash
git add -A docs/architecture/codebase-map.md docs/superpowers/reviews/2026-06-10-desktop-local-first-tech-debt-audit.md knip.json scripts/check-architecture-debt.mjs scripts/check-tech-debt.mjs package.json pnpm-lock.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Clean up desktop local-first evolution"
```

---

## Phase 18: Final E2E Product Readiness Matrix

**Files:**

- Create: `apps/desktop/e2e/productReadiness.spec.ts`
- Create: `docs/superpowers/reviews/2026-06-10-desktop-local-first-readiness-review.md`
- Modify: execution log

- [ ] **Step 1: Write final product readiness E2E**

The test must run this full flow:

1. launch Electron desktop.
2. create local-only personal workspace with no account.
3. verify real folder exists on disk.
4. create markdown, CSV, image fixture, audio fixture, PDF fixture, SQLite, and app files.
5. point simulated local agent at the folder and modify files.
6. dohc detects batched changes.
7. create finance tracker app from CSV/SQLite.
8. run app tester.
9. reload app and verify persistence.
10. enable cloud sync.
11. sync to Postgres cloud/self-host dev server.
12. open web client and see synced files.
13. create shared workspace.
14. collaborator edits normal file and syncs without approval.
15. boundary-crossing action asks for confirmation.
16. conflict is summarized without Git markers.
17. MCP reports workspace clean.

- [ ] **Step 2: Run full verification**

```bash
pnpm dev:cloud
pnpm check:cloud-ready
pnpm -r --if-present typecheck
pnpm -r --if-present test
pnpm build:desktop
pnpm test:desktop:e2e
pnpm smoke:desktop
pnpm check:performance
pnpm test:e2e
pnpm check:self-host
pnpm check:lean
git diff --check
```
Expected: pass. If any external service is unavailable, record exact blocker and rerun after service is started.

- [ ] **Step 3: Write readiness review**

`docs/superpowers/reviews/2026-06-10-desktop-local-first-readiness-review.md` must answer:

- Is desktop usable as the primary client?
- Does local-only work without account?
- Does local folder editing work with external agents?
- Does cloud sync work?
- Does shared collaboration lean liberal without losing boundaries?
- Do apps and SQLite work from visible files?
- Is web correctly secondary?
- Is Convex fully removed?
- Is self-hosting honest?

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/productReadiness.spec.ts docs/superpowers/reviews/2026-06-10-desktop-local-first-readiness-review.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Verify desktop local-first product readiness"
```

---

## Acceptance Criteria

The plan is complete only when:

- dohc Desktop launches and is usable as the primary client.
- local-only workspace works with no account.
- user can choose `~/dohc` or attach arbitrary folders.
- personal workspace defaults to local-first.
- shared/team workspace defaults to cloud-first with local working copy.
- local files are real files on disk.
- external Codex/Claude Code-style agents can edit the folder and dohc reflects changes.
- dohc MCP tools expose sync/share/app/import/test/status capabilities.
- sync is automatic, settled, batched, and avoids half-written files.
- dohc-native history/change sets exist without Git as default.
- conflicts are AI-assisted/human-readable and do not use Git markers by default.
- normal shared edits sync without approval when the user has edit access.
- real boundary crossings ask for confirmation.
- dohc Cloud login works from desktop via the Better Auth device authorization flow; self-host gets working auth with no external vendor account.
- two desktop clients can live co-edit shared workspace markdown through Hocuspocus/Yjs with convergence, presence, and offline-reconnect safety; the Hocuspocus ACL has no Convex dependency.
- workspace history is a visible first-class surface: a change-set timeline with kind, human/agent attribution, plain-language summaries, and files touched — working in local-only mode and in shared workspaces.
- returning to a shared workspace surfaces a plain-language catch-up of what changed since the user last looked.
- apps are visible `.apps/<name>` source folders.
- user-meaningful SQLite databases can be visible `.sqlite` files.
- uploads/import/export support CSV, TXT, JSON, PNG/JPEG/WebP/GIF/SVG, PDF, audio, video, SQLite, and generic files.
- app testing catches blank/fake/non-persistent apps.
- Postgres powers cloud/self-host sync.
- web is retained as cloud/shared/mobile-friendly access, not the local-first center.
- Convex is removed after replacement tests pass.
- self-host docs and smoke checks exist.
- Electron E2E tests, screenshots, and smoke tests pass.
- performance budgets are measured and pass.
- a dedicated evolution cleanup phase deletes or consolidates obsolete code before final readiness.
- every phase commit received an independent third-party review and every checkpoint received a cumulative third-party review (Codex gpt-5.5 xhigh preferred; a recorded fallback reviewer otherwise), with all findings fixed or explicitly rejected in the execution log.
- `pnpm check:lean` passes.
- tech debt audit proves obsolete code was deleted, consolidated, or justified with deletion conditions.

## Self-Grade Rubric Before Final

The implementation must score `2` in every row before it can be called complete.

| Area | 0 | 1 | 2 |
|---|---|---|---|
| Desktop | absent | launches but incomplete | Electron desktop is primary usable client |
| Native UX | web shell in Electron | partial desktop polish | native-feeling muted dohc shell with tested screenshots, shortcuts, layout, and no marketing chrome |
| Performance | unmeasured or slow | partial measurements | explicit budgets pass for launch, file tree, sync, apps, SQLite, imports |
| Local files | projection only | partial folder support | real local folders are the main workspace surface |
| Accountless local | login required | partial local-only | local-only works with no account |
| Sync | manual/noisy | partial batching | settled batched sync with history and conflict tests |
| Auth | absent or vendor-locked | login works but untested edge cases | Better Auth email/device-flow/orgs tested for cloud and self-host with no vendor dependency |
| Collaboration | restrictive or unsafe | partial liberal policy | edit access syncs freely; live co-editing converges with presence and offline-reconnect tests; change-set history with human/agent attribution and catch-up surfaces visible and tested; real boundary crossings guarded |
| Apps | hidden/static | visible but untested | visible `.apps` source folders with tested persistent runtime |
| SQLite/data | markdown fallback | partial imports | visible SQLite/data imports tested end to end |
| Agents/MCP | absent | folder only | local agents edit files and MCP exposes dohc-aware tools |
| Cloud/self-host | unclear | dev only | Postgres sync server and self-host smoke documented/tested |
| Web role | still primary/local-confused | partially repositioned | web clearly serves cloud/shared/mobile access |
| Convex removal | still required | partially removed | Convex deleted after replacement tests pass |
| Security | renderer/IPC unsafe | partial hardening | context isolation, sandbox, validated IPC, fuses/signing readiness tested |
| E2E proof | unit-only | partial flows | desktop product readiness E2E passes |
| Tech debt | old code accumulates | cleanup incomplete | obsolete code deleted/consolidated with audit evidence |

## Final Response Requirements

Final response must include:

- changed file summary.
- code deleted/consolidated.
- commits made.
- tests run.
- failing tests, if any.
- Electron screenshots/manual smoke results.
- UI/UX screenshot/design review notes.
- performance measurements and budget result.
- self-host smoke result.
- self-grade table.
- remaining risks.

Do not send a final "done" response until all phases are complete, the execution log is complete, the self-grade rubric is all `2`, and full verification passes.

## Copy-Paste Prompt For Implementing Agent

```text
Please branch out and fully execute the desktop local-first dohc plan.

Work in /home/ice/dev/dohc.

Branching:
- Start after the completed dual-backend branch is merged or explicitly chosen as base.
- Create branch: claude/desktop-local-first-cloud-sync.

Outcome:
Implement docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md fully. Pivot dohc to Electron-first and local-file-first. Cut Convex after replacement tests prove the behavior. Keep/port the useful Postgres, filesystem, app, SQLite, sandbox, upload, AppTester, and agent-output pieces from the completed old plan. Auth is Better Auth inside workspace-api (WorkOS deferred as the enterprise SSO path behind it). Live co-editing via Hocuspocus/Yjs for shared workspace markdown is in scope, with the Hocuspocus ACL ported from Convex to Postgres.

Read first:
1. AGENTS.md
2. apps/app/AGENTS.md if touching current app code
3. apps/app/convex/_generated/ai/guidelines.md before deleting or porting Convex code
4. docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md
5. docs/superpowers/reviews/2026-06-09-dual-backend-readiness-review.md
6. docs/superpowers/reviews/2026-06-09-dual-backend-tech-debt-audit.md
7. docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md
8. docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md if it exists

Execution mode:
- Work phase by phase in order.
- Use strict TDD: failing test, confirmed failure, implementation, passing targeted test, regression tests, E2E/smoke where relevant, delete-or-justify, execution log, commit.
- Use native multi-agent orchestration per the plan's Orchestration section: recon fan-outs before heavy phases, design judge panels before Phases 9 and 10, per-phase verifier subagents before each commit, multi-agent adversarial reviews at checkpoints, background long-running tasks, and self-paced loops while AFK.
- After every phase commit and at every checkpoint, run independent third-party review using the effort tier from the plan's Codex third-party review section: xhigh for checkpoints and high-risk phases (2, 4, 5, 9, 10, 11, 13, 16, 17, 18); high for low-risk phases (0, 1, 12, 14, 15) and advisory screenshot/scenario passes. If preferred Codex gpt-5.5 is unavailable, use the fallback chain and record the reviewer in the execution log. Fix or explicitly reject every finding.
- Role split: the lead implementation agent owns code, tests, commits, and the execution log; Codex is used only as read-only independent reviewer/red-team/consultant, and all Codex findings are verified by non-Codex verifiers before fixes land.
- For UI phases, inspect screenshots and explicitly record whether the UI feels native, muted, fast, and consistent with dohc.
- Keep going while I am AFK.
- Do not stop because work is long, difficult, slow, or partially complete.
- If interrupted/resumed, read the execution log, inspect git status, run nearest test for last changed area, and continue from first incomplete phase.

Non-negotiables:
- Electron renderer must not get raw Node/Electron access.
- IPC/preload APIs must be narrow and validated.
- Local-only personal workspace works with no account.
- Normal edits sync automatically when user has edit access.
- Guard only real boundary crossings.
- Do not CRDT-sync raw SQLite bytes.
- Do not store binary assets as markdown text.
- Delete Convex only after replacement tests prove behavior.
- Reduce tech debt; deletion is valuable work.
- Performance is a product invariant. The app must feel native and fast. Do not accept slow startup, sluggish file trees, janky typing, slow sync, slow app opens, or slow SQLite/import flows.
- Preserve dohc's current simple, clean, muted style. Take inspiration from Obsidian, Codex, t3code, Linear, and Raycast. Do not add marketing heroes, decorative gradients/orbs, card-heavy dashboards, or loud palettes.

Testing:
- Install and use Electron E2E tooling, including Playwright Electron automation.
- Run targeted tests in every phase.
- Run Electron screenshots/smokes for desktop phases and check layout, text fit, command palette, file tree, first-run, file views, and agent activity UI.
- Add/update performance measurements for phases that touch desktop UX, file trees, sync, apps, SQLite, imports, or agents.
- Run security/collaboration regressions after touching auth, sync, sharing, sandbox, IPC, apps, SQLite, or agents.
- Run Phase 16 performance verification before cleanup.
- Run Phase 17 cleanup/deletion verification before final readiness.
- Run full Phase 18 verification before final response.
- Run `pnpm check:performance` before final response.
- Run `pnpm check:lean` before final response.
- Do not skip, delete, or weaken tests to move forward.

Stop only if:
- the same blocker remains after three concrete attempts plus the Recovery Protocol fresh-model consult.
- missing external secret/service is genuinely required.
- user decision is genuinely required.
- continuing would violate a non-negotiable.

Final response:
- If complete, include changed file summary, deleted/consolidated code, commits, tests, Electron smoke screenshots/results, UI/UX review notes, performance measurements, self-host smoke, self-grade table, and remaining risks.
- If blocked, say blocked and list incomplete phases, attempts, files inspected, commands run, failing tests, and smallest required input.
```
