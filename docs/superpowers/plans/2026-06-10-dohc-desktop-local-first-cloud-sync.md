# dohc Desktop Local-First Cloud Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pivot dohc from a web-first Convex workspace into an Electron-first, local-file-first workspace that syncs to dohc Cloud or self-hosted Postgres, lets local Codex/Claude Code work directly on files, and preserves dohc's collaboration, apps, SQLite, provenance, and agent-testing strengths.

**Architecture:** Workspaces are real folders on disk. The desktop app is the primary product surface and runs a local dohc core that watches folders, batches changes, maintains `.dohc/` metadata, serves the React renderer, exposes MCP/tools to local agents, and syncs with dohc Cloud/self-hosted Postgres when enabled. The existing dual-backend branch is treated as a completed prototype: keep/port the useful Postgres, filesystem, app, SQLite, sandbox, upload, and AppTester pieces; delete Convex and web-first compatibility paths once equivalent local-first tests prove the replacement.

**Tech Stack:** Electron, React/TanStack Start renderer, TypeScript, Vite/electron-vite or equivalent Electron Vite build tooling, Playwright Electron automation, Vitest, Postgres, Drizzle ORM, Hocuspocus/Yjs where collaborative text needs CRDTs, local filesystem storage, S3-compatible object storage for cloud/self-host, SQLite worker/AppTester services, MCP server for Codex/Claude integration, Docker Compose for self-host/dev.

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

- renderer idle CPU should return near idle after sync/app/test operations finish.
- no unbounded polling loops.
- large file indexing must be incremental or worker-backed.
- sync, import, AppTester, and SQLite work must not block the Electron renderer.
- desktop memory after opening a 1,000-file workspace should be measured and recorded; regressions over 20% require investigation.

Every phase touching UI, filesystem watching, sync, database import, app runtime, or agent tooling must add or update a performance check.

## AI Agent Execution Contract

The implementing agent should assume the user is AFK and keep going until completion or a real blocker.

### Required Read Order

Before editing code, read:

1. `AGENTS.md`
2. `apps/app/AGENTS.md` if touching current app code
3. `apps/app/convex/_generated/ai/guidelines.md` before deleting or porting Convex code
4. `docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md`
5. `docs/superpowers/reviews/2026-06-09-dual-backend-readiness-review.md`
6. `docs/superpowers/reviews/2026-06-09-dual-backend-tech-debt-audit.md`
7. this plan from top to bottom

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
- What could still regress?
- Which command proves this phase is safe?

If any answer is weak, fix before moving on.

### Major Review Checkpoints

Use CodeRabbit/subagents/manual review if available:

- after Phase 4: Electron security and IPC review.
- after Phase 7: local workspace/sync review.
- after Phase 9: cloud sync/collaboration review.
- after Phase 11: MCP/agent-power review.
- after Phase 13: Convex deletion review.
- after Phase 16: performance review.
- after Phase 17: codebase excellence/deletion review.
- after Phase 18: full product readiness review.

Fix relevant findings before continuing. If a finding is rejected, record why.

### Stop Conditions

Stop only if:

- the same blocker remains after three concrete attempts.
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

- Start after the completed dual-backend branch is merged or explicitly chosen as base.
- Suggested branch: `codex/desktop-local-first-cloud-sync`.
- Create an execution log at:
  - `docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md`
- Commit after every phase.
- Do not squash phase commits during implementation; traceability matters.

Execution log template:

```md
# Desktop Local-First Cloud Sync Execution Log

## Baseline

- Branch:
- Base commit:
- Old dual-backend commit:
- Current phase:
- Current step:
- Last successful commit:
- Last failing command:
- Last blocker:

## Phase Logs

### Phase N: Name

- Status: not started | in progress | complete | blocked
- Execution map:
- Files changed:
- Code deleted or consolidated:
- Old paths retained and why:
- Tests added:
- Commands run:
- Failing tests fixed:
- Electron E2E/manual smoke:
- Performance measurements:
- Security/collaboration regressions:
- Reviewer/subagent/CodeRabbit findings:
- Relevant findings fixed:
- Deferred findings with reason:
- Remaining risk:
- Next phase:
```

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

- [ ] **Step 5: Run baseline**

```bash
pnpm check:desktop-local-first-baseline
```

Expected: pass, or execution log records exact pre-existing failures.

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
- Create: `apps/desktop/src/smoke/desktopSmoke.test.ts`
- Create: `apps/desktop/e2e/desktopLaunch.spec.ts`
- Create: `apps/desktop/scripts/smoke-test.mjs`
- Modify: `package.json`
- Modify: `playwright.config.ts`

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

- [ ] **Step 5: Add root scripts**

```json
"dev:desktop": "pnpm --filter @dohc/desktop dev",
"build:desktop": "pnpm --filter @dohc/desktop build",
"test:desktop": "pnpm --filter @dohc/desktop test",
"test:desktop:e2e": "playwright test apps/desktop/e2e",
"smoke:desktop": "node apps/desktop/scripts/smoke-test.mjs"
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @dohc/desktop test
pnpm build:desktop
pnpm test:desktop:e2e
```

Expected: pass. If the environment lacks a display server, run under `xvfb-run` and record that in the execution log.

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
git add apps/desktop package.json pnpm-lock.yaml playwright.config.ts docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
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

- [ ] **Step 3: Implement desktop-first shell**

Reuse current React components where sensible, but change UX that feels web-first.

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

- [ ] **Step 4: Run visual smoke**

```bash
pnpm test:desktop:e2e apps/desktop/e2e/firstRunWorkspace.spec.ts
```

Expected:

- screenshot saved.
- nonblank desktop shell.
- no overlapping text.
- first workspace created.

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

- [ ] **Step 6: Wire desktop sync status**

Desktop shell shows:

- synced
- syncing
- local changes
- conflict
- cloud disconnected

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

Port useful file-type view code from the old branch into desktop renderer.

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

## Phase 9: Postgres Cloud Sync And Self-Hosted Server

**Files:**

- Modify: `services/workspace-api/src/server.ts`
- Modify: `packages/workspace-postgres`
- Create: `packages/workspace-sync/src/cloudSync.ts`
- Create: `packages/workspace-sync/src/cloudSync.test.ts`
- Create: `apps/desktop/e2e/cloudSync.spec.ts`
- Modify: `docker-compose.dev.yml`
- Modify: `docker-compose.self-host.yml`
- Modify: `docs/self-hosting.md`

- [ ] **Step 1: Write failing cloud sync tests**

Tests must assert:

- local-first personal workspace can sync after login.
- local-only workspace works without login.
- shared/team workspace creates cloud-first local working copy.
- normal allowed edits auto-sync.
- permission changes/public sharing require explicit confirmation.
- another collaborator sees synced updates.

- [ ] **Step 2: Implement sync protocol**

Sync protocol carries:

- workspace manifest.
- file content hashes.
- change sets.
- asset blobs.
- database operation logs.
- provenance.
- conflict summaries.

- [ ] **Step 3: Implement Postgres sync backend**

Use `workspace-postgres` as the only cloud/self-host backend for new architecture.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @dohc/workspace-sync test
pnpm --filter @dohc/workspace-postgres test
pnpm --filter @dohc/workspace-api test
pnpm test:desktop:e2e apps/desktop/e2e/cloudSync.spec.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/workspace-sync packages/workspace-postgres services/workspace-api apps/desktop docker-compose.dev.yml docker-compose.self-host.yml docs/self-hosting.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Add Postgres cloud sync for desktop workspaces"
```

---

## Phase 10: Liberal Collaboration And AI-Assisted Conflicts

**Files:**

- Create: `packages/workspace-sync/src/collaborationPolicy.ts`
- Create: `packages/workspace-sync/src/collaborationPolicy.test.ts`
- Create: `packages/workspace-history/src/conflictResolution.ts`
- Create: `packages/workspace-history/src/conflictResolution.test.ts`
- Create: `apps/desktop/e2e/collaboration.spec.ts`
- Modify: desktop sync UI

- [ ] **Step 1: Write failing liberal policy tests**

Tests must assert:

- edit access allows normal user edits.
- edit access allows normal agent edits.
- no approval is required for ordinary file edits.
- explicit protected folder blocks or proposes changes.
- boundary crossings require confirmation.

- [ ] **Step 2: Write failing conflict tests**

Tests must assert:

- safe markdown changes auto-merge.
- unmergeable conflict preserves both versions.
- conflict summary is human-readable.
- AI resolution proposal can be stored.
- user can apply, keep both, or dismiss.
- no Git conflict markers are inserted by default.

- [ ] **Step 3: Implement collaboration policy**

Policy should lean liberal:

```txt
allowed edit -> sync
explicit protected target -> propose/review
boundary crossing -> confirm
conflict -> AI-assisted resolution
permission denied -> keep local unsynced and explain
```

- [ ] **Step 4: Run collaboration E2E**

```bash
pnpm --filter @dohc/workspace-sync test
pnpm --filter @dohc/workspace-history test
pnpm test:desktop:e2e apps/desktop/e2e/collaboration.spec.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/workspace-sync packages/workspace-history apps/desktop docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Add liberal collaboration and AI conflicts"
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
- Modify: desktop settings UI

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

If not safe in one phase, keep path temporarily but rename product/package surfaces to `@dohc/web` and record deletion condition.

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
| app trust | local app trust + cloud sync tests | pass |
| uploads/assets | desktop file type + workspace sync tests | pass |
| onboarding/setup | desktop first-run tests | pass |
```

- [ ] **Step 2: Run tests before deletion**

```bash
pnpm check:desktop-local-first-baseline
```

Expected: pass.

- [ ] **Step 3: Delete Convex**

Remove Convex-specific packages, scripts, generated API files, env examples, and compatibility package.

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
git add -A docs/superpowers/reviews/2026-06-10-convex-deletion-review.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
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
- CI environment multipliers require explicit `PERF_BUDGET_MULTIPLIER`.
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

If any measurement is over budget, optimize before moving on.

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
- `pnpm check:lean` passes.
- tech debt audit proves obsolete code was deleted, consolidated, or justified with deletion conditions.

## Self-Grade Rubric Before Final

The implementation must score `2` in every row before it can be called complete.

| Area | 0 | 1 | 2 |
|---|---|---|---|
| Desktop | absent | launches but incomplete | Electron desktop is primary usable client |
| Native UX | web shell in Electron | partial desktop polish | native-feeling first-run/workspace shell with tested shortcuts/layout |
| Performance | unmeasured or slow | partial measurements | explicit budgets pass for launch, file tree, sync, apps, SQLite, imports |
| Local files | projection only | partial folder support | real local folders are the main workspace surface |
| Accountless local | login required | partial local-only | local-only works with no account |
| Sync | manual/noisy | partial batching | settled batched sync with history and conflict tests |
| Collaboration | restrictive or unsafe | partial liberal policy | edit access syncs freely; real boundary crossings guarded |
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
- Create branch: codex/desktop-local-first-cloud-sync.

Outcome:
Implement docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md fully. Pivot dohc to Electron-first and local-file-first. Cut Convex after replacement tests prove the behavior. Keep/port the useful Postgres, filesystem, app, SQLite, sandbox, upload, AppTester, and agent-output pieces from the completed old plan.

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

Testing:
- Install and use Electron E2E tooling, including Playwright Electron automation.
- Run targeted tests in every phase.
- Run Electron screenshots/smokes for desktop phases.
- Add/update performance measurements for phases that touch desktop UX, file trees, sync, apps, SQLite, imports, or agents.
- Run security/collaboration regressions after touching auth, sync, sharing, sandbox, IPC, apps, SQLite, or agents.
- Run Phase 16 performance verification before cleanup.
- Run Phase 17 cleanup/deletion verification before final readiness.
- Run full Phase 18 verification before final response.
- Run `pnpm check:performance` before final response.
- Run `pnpm check:lean` before final response.
- Do not skip, delete, or weaken tests to move forward.

Stop only if:
- same blocker remains after three concrete attempts.
- missing external secret/service is genuinely required.
- user decision is genuinely required.
- continuing would violate a non-negotiable.

Final response:
- If complete, include changed file summary, deleted/consolidated code, commits, tests, Electron smoke screenshots/results, performance measurements, self-host smoke, self-grade table, and remaining risks.
- If blocked, say blocked and list incomplete phases, attempts, files inspected, commands run, failing tests, and smallest required input.
```
