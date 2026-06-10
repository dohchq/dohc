# dohc Dual Backend, Filesystem, And Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the current Convex implementation working while building a Postgres-backed, file-native dohc runtime beside it, so dohc can become self-hostable, local-file capable, cloud-hosted, and powerful enough for agents to work with bash-like efficiency.

**Architecture:** Convex remains the production baseline while a shared dohc workspace contract is extracted and implemented by both Convex and Postgres adapters. Postgres becomes the candidate long-term core for self-hosted and cloud deployments; local filesystem projection and cloud sandboxes expose the same workspace as real files to agents, while writes still flow through dohc permissions, locks, review gates, provenance, app trust, and sync.

**Tech Stack:** React/TanStack app shell, existing Convex backend, Postgres, Drizzle ORM, Hocuspocus/Yjs, object storage via local filesystem/S3-compatible adapter, Node services, sandboxed shell workers, Vitest, Playwright, conformance test suites, Docker Compose for self-host/dev parity.

---

## AI Agent Execution Contract

Use this section as the operating contract for any AI agent implementing the plan.

### Required Read Order

Before editing code, read:

1. `AGENTS.md`
2. `apps/app/AGENTS.md`
3. `apps/app/convex/_generated/ai/guidelines.md` before touching Convex code
4. this plan from top to bottom
5. the execution log if it already exists

### Continuous Execution Mode

The implementing agent should assume the user is AFK.

Keep going phase by phase until:

- all phases are complete, or
- the same blocker remains after three concrete attempts, or
- an external secret/service/user decision is genuinely required, or
- continuing would require violating a non-negotiable.

Do not stop because:

- the plan is long.
- context is large.
- tests are slow.
- a phase is partially complete.
- implementation is difficult.
- there are many files.
- the current slice is "good enough."

If the runtime interrupts or compacts context:

1. read the execution log.
2. run `git status -sb`.
3. inspect the first incomplete phase.
4. run the nearest test for the last changed area.
5. continue from the first incomplete step.

Never restart from scratch unless the user explicitly asks.

### TDD Discipline

Every implementation phase must follow red-green-refactor:

1. write or update the failing test first.
2. run the test and record the failure.
3. implement the smallest production change.
4. run the targeted test and record the pass.
5. delete or simplify any now-obsolete code in the touched area.
6. run the relevant regression slice.
7. refactor only after tests are green.
8. update the execution log.
9. commit the phase.

If a named test file does not exist, create it. If a named helper does not exist, create it. Do not skip a test because the existing harness is incomplete.

Do not make tests pass by:

- weakening assertions.
- deleting coverage.
- skipping tests.
- loosening authorization checks.
- mocking away the behavior under test.
- accepting fake UI, fake persistence, or placeholder data.

### Tech Debt And Deletion Discipline

This undertaking should reduce long-term complexity, not just add a Postgres stack beside Convex.

Every phase must include a "delete or justify" pass:

1. list duplicate code paths introduced by the phase.
2. delete obsolete helpers, mocks, routes, tests, feature flags, or compatibility shims that are no longer needed.
3. merge duplicated logic into shared packages when both Convex and Postgres need it.
4. keep compatibility code only when a test proves it is still required.
5. record any retained debt in the execution log with an owner phase or deletion condition.

Deletion is valuable work. Prefer removing code when behavior is covered by tests and the removal does not weaken compatibility, auth, collaboration, or migration safety.

Do not delete:

- Convex backend support.
- migration compatibility required by existing users or tests.
- security checks.
- tests that still protect real behavior.
- review gates, lock checks, app trust checks, or provenance logs.

Actively look for code to remove in these areas:

- legacy `.views` product-language paths after `.apps` compatibility is proven.
- duplicate frontend file-type rendering paths.
- duplicate app/runtime protocol helpers.
- duplicate collection parsing utilities.
- old onboarding prompt fragments that conflict with file/app/database behavior.
- temporary AppTester probes that are superseded by permanent adversarial tests.
- dead scripts or dev reset paths that no longer match the supported dev stack.
- unused exports and generated wrappers around code that has moved into shared contracts.

Each phase commit should aim for one of these outcomes:

- net smaller code in the touched legacy area, or
- clear consolidation into a shared module, or
- a written execution-log reason why deletion is unsafe until a later phase.

### Review And Fix Loop

After each phase:

1. run the phase verification command.
2. inspect `git diff --stat`.
3. inspect deleted files/lines and confirm deletion did not remove required coverage.
4. inspect security-sensitive diffs manually.
5. update the execution log.
6. commit.

After every phase that touches auth, permissions, agents, app runtime, uploads, assets, SQLite, shell sandboxing, filesystem sync, or sharing, also run the relevant cross-cutting tests:

```bash
pnpm --filter @dohc/web test convex/authzBoundaries.test.ts convex/appSecurity.test.ts convex/appTrust.test.ts convex/agentApprovals.test.ts
pnpm --filter @dohc/hocuspocus test
pnpm --filter @dohc/sqlite-worker test
```

If CodeRabbit, GitHub review tools, or subagents are available, use them after major milestones:

- after Phase 5: dual-backend contract review.
- after Phase 8: filesystem projection review.
- after Phase 10: sandbox/security review.
- after Phase 12: apps/SQLite/runtime review.
- after Phase 15: full readiness review.
- after Phase 16: tech debt and deletion review.

Fix relevant findings before continuing. If a finding is not relevant, record why in the execution log.

### Stop And Block Protocol

Only stop as `blocked` after three concrete attempts against the same blocker.

The blocked report must include:

- exact blocker.
- incomplete phase and step.
- attempts made.
- files inspected.
- commands run.
- current failing tests.
- smallest required input or external service.

Do not frame blocked work as complete.

### Final Completion Contract

Do not send a final "done" response until:

- all phases are checked off.
- the execution log is complete.
- Convex mode passes required tests.
- Postgres mode passes required conformance tests.
- backend matrix tests have fresh results.
- the tech debt audit is complete.
- obsolete code is deleted, consolidated, or justified with deletion conditions.
- `pnpm check:debt` passes.
- `git diff --check` is clean.
- remaining risks are written plainly.

Final response must include:

- changed file summary.
- tests run.
- failing tests, if any.
- manual/browser smoke results.
- self-grade table.
- remaining risks.

## Copy-Paste Prompt For Implementing Agent

```text
You are implementing dohc's dual-backend, filesystem, and agent runtime architecture. Work from the repository root.

Outcome:
Implement docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.md. Keep Convex working while building the Postgres backend beside it. Add file-native uploads/views, agent-native data import, local filesystem projection, and a cloud shell sandbox. Reduce tech debt as you go: delete obsolete code when tests prove it is safe, consolidate duplicate logic into shared packages, and record retained compatibility code with deletion conditions. The result must be testable, secure, self-hostable in shape, and compatible with current Convex behavior.

Read first:
1. AGENTS.md
2. apps/app/AGENTS.md
3. apps/app/convex/_generated/ai/guidelines.md before editing Convex code
4. docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.md
5. docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md if it exists

Execution mode:
- Follow the plan phase by phase in order.
- Use TDD for every phase: failing test, confirmed failure, implementation, passing targeted test, regression slice, execution log, commit.
- After every phase, do a delete-or-justify pass: remove obsolete code, consolidate duplicates, or record why the old path must stay.
- Keep going while the user is AFK. Do not stop because the work is long, difficult, or partially complete.
- If interrupted or resumed, read the execution log and continue from the first incomplete phase.
- Preserve Convex. Do not remove Convex or make Postgres the production default until the readiness gate says it is safe.

Non-negotiables:
- Do not weaken authorization, ownership, sharing boundaries, locks, review gates, app trust, provenance, or workspace scoping.
- Browser callers are never trusted to provide user identity, workspace identity, or permissions.
- Shell and local filesystem writes must be captured as diffs and applied through dohc policy.
- Do not CRDT-sync raw SQLite bytes.
- Do not treat generated binary assets as markdown text.
- App manifests define maximum read/write scopes only; they are never permissions by themselves.
- App trust is per user and per manifest write key.

Verification:
- Run the targeted tests named in each phase.
- Run cross-cutting security/collaboration tests after touching auth, agents, apps, assets, SQLite, shell sandboxing, filesystem sync, or sharing.
- Run the Phase 15 backend comparison and Phase 16 tech debt audit before final response.
- Run `pnpm check:debt` before final response.
- If a test fails, fix the failure or prove an external blocker. Do not delete, weaken, or skip the test.

Stop only if:
- the same blocker remains after three concrete attempts, or
- a missing external service/secret is required, or
- a product/security decision is genuinely required from the user, or
- continuing would violate a non-negotiable.

Final response:
- If complete, include changed file summary, code deleted/consolidated, tests run, manual/browser smoke results, self-grade table, and remaining risks.
- If blocked, say `blocked`, list incomplete phases, attempts made, failing tests, and the smallest required input.
```

## Decision Summary

This plan does **not** remove Convex.

It creates a dual-backend path:

1. Convex stays available and tested.
2. Postgres is built beside Convex.
3. Shared contract tests compare both backends.
4. The frontend can run against either backend in development.
5. The product switches only after Postgres proves it can run the core flows with equal or better behavior.

The strategic direction is:

- dohc should feel like files to humans and agents.
- dohc Cloud should monetize reliable hosting, sync, backups, agents, storage, and collaboration.
- self-hosted dohc should use boring infrastructure: Postgres, object storage, workers, and a local or cloud shell runtime.
- local users should be able to work with a real folder like Obsidian while still benefiting from dohc sync, collaboration, permissions, apps, and agents.
- agents should get bash-grade workspace power without bypassing dohc authority.

## Non-Negotiables

- Do not weaken authorization, ownership, sharing boundaries, locks, review gates, app trust, or provenance.
- Browser callers must never provide trusted user identity, workspace identity, or permissions.
- Shell/sandbox writes are proposed workspace changes until dohc applies them through server-side policy.
- Local filesystem sync must not become an unmanaged overwrite path.
- App manifests define maximum read/write scopes only; they are not permissions by themselves.
- Do not CRDT-sync raw SQLite bytes.
- Binary assets, SQLite files, markdown sources, and app source files must all have durable provenance.
- Convex backend tests must continue to pass while the Postgres path is added.
- Postgres work must be gated by shared conformance tests, not by screenshots or manual inspection alone.

## Branch And Execution Strategy

- Start a new branch from the current integration base after PR 29 is merged or explicitly chosen as the base.
- Suggested branch: `codex/dual-backend-filesystem-agent-runtime`.
- Do not implement this in one giant commit.
- Commit after every passing vertical slice.
- Create an execution log at:
  - `docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md`

Each phase log entry must include:

- files changed
- code deleted or consolidated
- obsolete paths intentionally retained and why
- tests added
- commands run
- failures fixed
- remaining risk
- whether Convex still passes
- whether Postgres conformance for that slice passes

## Backend Modes

The application should support these modes during the migration:

```txt
DOHC_BACKEND=convex
DOHC_BACKEND=postgres
```

`convex` is the default until Postgres conformance is complete.

The mode is selected by server-side configuration. Client code can know which transport to call, but must not use the mode to skip auth or policy checks.

## Core Product Model

Both backends must represent the same product model:

```txt
User
Workspace
WorkspaceMember
Folder
Atom
AtomRevision
DocumentState
Asset
DatabaseFile
DatabaseOperation
Permission
Share
Lock
AppPackage
AppTrustGrant
AgentRun
AgentApproval
WorkspaceEvent
```

Atoms remain the human-readable source primitive. Assets represent binary or uploaded data. Database files represent first-class SQLite or structured database artifacts. Apps are workspace packages stored under `.apps`.

## Planned Package And Service Structure

Create these shared packages and services:

```txt
packages/workspace-contracts/
  src/domain.ts
  src/errors.ts
  src/backend.ts
  src/events.ts
  src/fsProjection.ts
  src/testHarness.ts
  src/index.ts

packages/workspace-postgres/
  src/db/client.ts
  src/db/schema.ts
  src/db/migrations/
  src/repositories/
  src/policy/
  src/services/
  src/testAdapter.ts
  src/index.ts

packages/workspace-convex-compat/
  src/testAdapter.ts
  src/contractMapping.ts
  src/index.ts

packages/workspace-fs/
  src/materialize.ts
  src/scan.ts
  src/diff.ts
  src/apply.ts
  src/metadata.ts
  src/index.ts

services/workspace-api/
  src/server.ts
  src/routes/
  src/auth/
  src/realtime/
  src/index.ts

services/agent-sandbox/
  src/server.ts
  src/sandbox/
  src/workspaceMount.ts
  src/diffCapture.ts
  src/approvals.ts
  src/index.ts

scripts/dev-postgres.mjs
scripts/reset-postgres-dev-data.mjs
docker-compose.dev.yml
```

Keep existing Convex files in `apps/app/convex/`. Do not move them during the first implementation wave.

---

## Phase 0: Baseline Lock And Migration Guardrails

**Files:**

- Create: `docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md`
- Modify: `package.json`
- Create: `scripts/check-dual-backend-baseline.mjs`
- Test: existing Convex and frontend tests

- [ ] **Step 1: Create the execution log**

Create `docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md` with:

```md
# Dual Backend, Filesystem, And Agent Runtime Execution Log

## Baseline

- Branch:
- Base commit:
- Convex baseline command:
- Convex baseline result:
- Postgres baseline command:
- Postgres baseline result:
- Current phase:
- Current step:
- Last successful commit:
- Last failing command:
- Last blocker:

## Phase Logs

### Phase N: Name

- Status: not started | in progress | complete | blocked
- Files changed:
- Code deleted or consolidated:
- Obsolete paths retained and why:
- Tests added:
- Commands run:
- Failing tests fixed:
- Cross-cutting regressions run:
- Convex status:
- Postgres status:
- Reviewer/subagent/CodeRabbit findings:
- Relevant findings fixed:
- Deferred findings with reason:
- Remaining risk:
- Next phase:
```

- [ ] **Step 2: Add a baseline script**

Create `scripts/check-dual-backend-baseline.mjs` that runs:

```js
import { spawnSync } from "node:child_process";

const commands = [
  ["pnpm", ["--filter", "@dohc/web", "typecheck"]],
  ["pnpm", ["--filter", "@dohc/web", "test"]],
  ["pnpm", ["--filter", "@dohc/app-tester", "test"]],
  ["pnpm", ["--filter", "@dohc/hocuspocus", "test"]],
  ["pnpm", ["--filter", "@dohc/sqlite-worker", "test"]],
];

for (const [cmd, args] of commands) {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
```

- [ ] **Step 3: Register the script**

Add this root script:

```json
"check:dual-backend-baseline": "node scripts/check-dual-backend-baseline.mjs"
```

- [ ] **Step 4: Run the baseline**

Run:

```bash
pnpm check:dual-backend-baseline
```

Expected:

- Existing Convex app behavior remains green.
- Any external-service failures are recorded in the execution log with the exact missing service.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/check-dual-backend-baseline.mjs docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md
git commit -m "Add dual backend baseline guard"
```

---

## Phase 1: Shared Workspace Contract

**Files:**

- Create: `packages/workspace-contracts/package.json`
- Create: `packages/workspace-contracts/tsconfig.json`
- Create: `packages/workspace-contracts/src/domain.ts`
- Create: `packages/workspace-contracts/src/errors.ts`
- Create: `packages/workspace-contracts/src/backend.ts`
- Create: `packages/workspace-contracts/src/events.ts`
- Create: `packages/workspace-contracts/src/index.ts`
- Create: `packages/workspace-contracts/src/backend.test.ts`
- Modify: root workspace/package configuration if needed

- [ ] **Step 1: Add the package**

Create `packages/workspace-contracts/package.json`:

```json
{
  "name": "@dohc/workspace-contracts",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vitest": "^2.1.9"
  }
}
```

- [ ] **Step 2: Define domain IDs and paths**

Create `packages/workspace-contracts/src/domain.ts`:

```ts
import { z } from "zod";

export const WorkspaceId = z.string().min(1);
export const UserId = z.string().min(1);
export const AtomId = z.string().min(1);
export const FolderId = z.string().min(1);
export const AssetId = z.string().min(1);
export const DatabaseId = z.string().min(1);

export const WorkspacePath = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/"), "workspace paths are relative")
  .refine((path) => !path.split("/").includes(".."), "workspace paths cannot contain ..");

export const AtomKind = z.enum(["markdown", "text", "csv", "json", "html", "app-source"]);
export type AtomKind = z.infer<typeof AtomKind>;

export const AssetKind = z.enum(["image", "audio", "video", "pdf", "csv", "json", "sqlite", "file"]);
export type AssetKind = z.infer<typeof AssetKind>;

export const WorkspaceFile = z.object({
  id: z.string(),
  workspaceId: WorkspaceId,
  path: WorkspacePath,
  kind: z.enum(["atom", "asset", "database"]),
  contentType: z.string(),
  revision: z.string(),
  updatedAt: z.number(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;
```

- [ ] **Step 3: Define backend errors**

Create `packages/workspace-contracts/src/errors.ts`:

```ts
export type WorkspaceErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "locked"
  | "review_required"
  | "invalid_path"
  | "invalid_manifest"
  | "unsupported_media_type";

export class WorkspaceError extends Error {
  constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}
```

- [ ] **Step 4: Define backend port interfaces**

Create `packages/workspace-contracts/src/backend.ts`:

```ts
import type { AssetKind, AtomKind, WorkspaceFile } from "./domain";

export type Actor = {
  userId: string;
  workspaceId: string;
};

export type CreateAtomInput = {
  path: string;
  kind: AtomKind;
  body: string;
};

export type WriteAtomInput = {
  path: string;
  expectedRevision: string;
  body: string;
};

export type SaveAssetInput = {
  path: string;
  kind: AssetKind;
  mediaType: string;
  bytes: Uint8Array;
};

export type WorkspaceBackend = {
  listFiles(actor: Actor): Promise<WorkspaceFile[]>;
  readText(actor: Actor, path: string): Promise<{ body: string; revision: string }>;
  createAtom(actor: Actor, input: CreateAtomInput): Promise<WorkspaceFile>;
  writeAtom(actor: Actor, input: WriteAtomInput): Promise<WorkspaceFile>;
  saveAsset(actor: Actor, input: SaveAssetInput): Promise<WorkspaceFile>;
  deleteFile(actor: Actor, path: string): Promise<void>;
};
```

- [ ] **Step 5: Write contract tests for path safety**

Create `packages/workspace-contracts/src/backend.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { WorkspacePath } from "./domain";

describe("WorkspacePath", () => {
  it("accepts relative workspace paths", () => {
    expect(WorkspacePath.parse("finance/transactions.csv")).toBe("finance/transactions.csv");
  });

  it("rejects absolute paths", () => {
    expect(() => WorkspacePath.parse("/finance/transactions.csv")).toThrow();
  });

  it("rejects path traversal", () => {
    expect(() => WorkspacePath.parse("finance/../private.md")).toThrow();
  });
});
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @dohc/workspace-contracts test
pnpm --filter @dohc/workspace-contracts typecheck
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add packages/workspace-contracts package.json pnpm-lock.yaml
git commit -m "Add shared workspace backend contracts"
```

---

## Phase 2: Shared Conformance Harness

**Files:**

- Create: `packages/workspace-contracts/src/testHarness.ts`
- Create: `packages/workspace-contracts/src/conformance.test.ts`
- Modify: `packages/workspace-contracts/src/index.ts`

- [ ] **Step 1: Define a reusable test adapter**

Create `packages/workspace-contracts/src/testHarness.ts`:

```ts
import type { Actor, WorkspaceBackend } from "./backend";

export type WorkspaceBackendTestAdapter = {
  name: string;
  setup(): Promise<{ backend: WorkspaceBackend; actor: Actor; otherActor: Actor }>;
  teardown(): Promise<void>;
};
```

- [ ] **Step 2: Define conformance cases**

Create `packages/workspace-contracts/src/conformance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { WorkspaceBackendTestAdapter } from "./testHarness";

export function runWorkspaceBackendConformance(adapter: WorkspaceBackendTestAdapter) {
  describe(`${adapter.name} workspace backend conformance`, () => {
    it("creates, reads, and lists a text file", async () => {
      const { backend, actor } = await adapter.setup();
      try {
        await backend.createAtom(actor, {
          path: "finance/transactions.csv",
          kind: "csv",
          body: "date,merchant,amount\n2026-06-01,Atome,26262\n",
        });

        const read = await backend.readText(actor, "finance/transactions.csv");
        expect(read.body).toContain("Atome");

        const files = await backend.listFiles(actor);
        expect(files.some((file) => file.path === "finance/transactions.csv")).toBe(true);
      } finally {
        await adapter.teardown();
      }
    });

    it("rejects cross-workspace reads", async () => {
      const { backend, actor, otherActor } = await adapter.setup();
      try {
        await backend.createAtom(actor, {
          path: "private/me.md",
          kind: "markdown",
          body: "# Me\n",
        });

        await expect(backend.readText(otherActor, "private/me.md")).rejects.toThrow();
      } finally {
        await adapter.teardown();
      }
    });

    it("rejects stale writes", async () => {
      const { backend, actor } = await adapter.setup();
      try {
        const created = await backend.createAtom(actor, {
          path: "notes/day.md",
          kind: "markdown",
          body: "# Day\n",
        });

        await backend.writeAtom(actor, {
          path: "notes/day.md",
          expectedRevision: created.revision,
          body: "# Day\nUpdated\n",
        });

        await expect(
          backend.writeAtom(actor, {
            path: "notes/day.md",
            expectedRevision: created.revision,
            body: "# Day\nStale\n",
          }),
        ).rejects.toThrow();
      } finally {
        await adapter.teardown();
      }
    });
  });
}
```

- [ ] **Step 3: Export the harness**

Update `packages/workspace-contracts/src/index.ts`:

```ts
export * from "./backend";
export * from "./domain";
export * from "./errors";
export * from "./events";
export * from "./testHarness";
export * from "./conformance.test";
```

- [ ] **Step 4: Run package tests**

```bash
pnpm --filter @dohc/workspace-contracts test
pnpm --filter @dohc/workspace-contracts typecheck
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/workspace-contracts
git commit -m "Add workspace backend conformance harness"
```

---

## Phase 3: Postgres Service Scaffold

**Files:**

- Create: `packages/workspace-postgres/package.json`
- Create: `packages/workspace-postgres/tsconfig.json`
- Create: `packages/workspace-postgres/src/db/client.ts`
- Create: `packages/workspace-postgres/src/db/schema.ts`
- Create: `packages/workspace-postgres/src/db/migrations/0001_initial.sql`
- Create: `packages/workspace-postgres/src/testAdapter.ts`
- Create: `packages/workspace-postgres/src/conformance.test.ts`
- Create: `packages/workspace-postgres/src/index.ts`
- Create: `docker-compose.dev.yml`
- Create: `scripts/dev-postgres.mjs`
- Create: `scripts/reset-postgres-dev-data.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the package**

Create `packages/workspace-postgres/package.json`:

```json
{
  "name": "@dohc/workspace-postgres",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dohc/workspace-contracts": "workspace:*",
    "drizzle-orm": "^0.45.0",
    "pg": "^8.13.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/pg": "^8.11.11",
    "typescript": "^5.7.2",
    "vitest": "^2.1.9"
  }
}
```

- [ ] **Step 2: Add local Postgres**

Create `docker-compose.dev.yml`:

```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: dohc
      POSTGRES_PASSWORD: dohc
      POSTGRES_DB: dohc_dev
    ports:
      - "54329:5432"
    volumes:
      - dohc_postgres_data:/var/lib/postgresql/data

  minio:
    image: minio/minio:RELEASE.2025-04-22T22-12-26Z
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: dohc
      MINIO_ROOT_PASSWORD: dohc-password
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - dohc_minio_data:/data

volumes:
  dohc_postgres_data:
  dohc_minio_data:
```

- [ ] **Step 3: Define schema**

Create `packages/workspace-postgres/src/db/schema.ts` with tables for:

```txt
users
workspaces
workspace_members
folders
atoms
atom_revisions
document_states
assets
database_files
database_operations
permissions
shares
locks
app_packages
app_trust_grants
agent_runs
agent_approvals
workspace_events
```

Required constraints:

- `(workspace_id, path)` unique for atoms, assets, and database files.
- every row includes `workspace_id`.
- revisions are monotonic strings or integers.
- deleted records use `deleted_at`, not hard delete, unless the operation is an explicit irreversible dev reset.
- database operation logs include `base_version` and `result_version`.

- [ ] **Step 4: Write migration**

Create `packages/workspace-postgres/src/db/migrations/0001_initial.sql` matching the schema.

Expected minimum indexes:

```sql
create index atoms_workspace_path_idx on atoms(workspace_id, path);
create index assets_workspace_path_idx on assets(workspace_id, path);
create index workspace_events_workspace_created_idx on workspace_events(workspace_id, created_at);
create index locks_workspace_target_idx on locks(workspace_id, target_kind, target_id);
create index database_operations_file_version_idx on database_operations(database_file_id, result_version);
```

- [ ] **Step 5: Add reset script**

Create `scripts/reset-postgres-dev-data.mjs` that:

```js
import pg from "pg";

const url = process.env.POSTGRES_URL ?? "postgres://dohc:dohc@localhost:54329/dohc_dev";
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(`
  truncate table
    agent_approvals,
    agent_runs,
    app_trust_grants,
    app_packages,
    database_operations,
    database_files,
    assets,
    document_states,
    atom_revisions,
    atoms,
    locks,
    shares,
    permissions,
    folders,
    workspace_events,
    workspace_members,
    workspaces,
    users
  restart identity cascade
`);
await client.end();
```

- [ ] **Step 6: Register scripts**

Add root scripts:

```json
"dev:postgres": "docker compose -f docker-compose.dev.yml up -d postgres minio",
"reset:postgres": "node scripts/reset-postgres-dev-data.mjs"
```

- [ ] **Step 7: Run scaffold checks**

```bash
pnpm dev:postgres
pnpm reset:postgres
pnpm --filter @dohc/workspace-postgres typecheck
```

Expected: Postgres and MinIO start locally; reset succeeds; TypeScript passes.

- [ ] **Step 8: Commit**

```bash
git add packages/workspace-postgres docker-compose.dev.yml scripts/dev-postgres.mjs scripts/reset-postgres-dev-data.mjs package.json pnpm-lock.yaml
git commit -m "Scaffold Postgres workspace backend"
```

---

## Phase 4: Postgres Metadata, Atom, And Permission Core

**Files:**

- Create: `packages/workspace-postgres/src/repositories/workspaces.ts`
- Create: `packages/workspace-postgres/src/repositories/atoms.ts`
- Create: `packages/workspace-postgres/src/repositories/events.ts`
- Create: `packages/workspace-postgres/src/policy/authorize.ts`
- Create: `packages/workspace-postgres/src/services/backend.ts`
- Modify: `packages/workspace-postgres/src/testAdapter.ts`
- Modify: `packages/workspace-postgres/src/conformance.test.ts`

- [ ] **Step 1: Write failing conformance test**

In `packages/workspace-postgres/src/conformance.test.ts`:

```ts
import { runWorkspaceBackendConformance } from "@dohc/workspace-contracts";
import { postgresTestAdapter } from "./testAdapter";

runWorkspaceBackendConformance(postgresTestAdapter);
```

Run:

```bash
pnpm --filter @dohc/workspace-postgres test src/conformance.test.ts
```

Expected: fail because the adapter is not implemented.

- [ ] **Step 2: Implement authorization policy**

Create `packages/workspace-postgres/src/policy/authorize.ts`:

```ts
import { WorkspaceError } from "@dohc/workspace-contracts";
import type { Actor } from "@dohc/workspace-contracts";

export async function assertWorkspaceMember(args: {
  actor: Actor;
  workspaceId: string;
  hasMembership: (userId: string, workspaceId: string) => Promise<boolean>;
}) {
  if (args.actor.workspaceId !== args.workspaceId) {
    throw new WorkspaceError("forbidden", "Actor workspace does not match target workspace");
  }
  const allowed = await args.hasMembership(args.actor.userId, args.workspaceId);
  if (!allowed) {
    throw new WorkspaceError("forbidden", "User is not a workspace member");
  }
}
```

- [ ] **Step 3: Implement atom create/read/list/write**

Implement `packages/workspace-postgres/src/services/backend.ts` as the first `WorkspaceBackend`.

Required behavior:

- create user/workspace fixtures through the test adapter.
- `createAtom` inserts `atoms`, `atom_revisions`, and `workspace_events` transactionally.
- `readText` denies non-members.
- `writeAtom` requires matching `expectedRevision`.
- stale writes throw `WorkspaceError("conflict", ...)`.
- all operations derive workspace from `Actor`, not from caller-supplied body fields.

- [ ] **Step 4: Run conformance**

```bash
pnpm --filter @dohc/workspace-postgres test src/conformance.test.ts
```

Expected: pass.

- [ ] **Step 5: Run baseline Convex tests**

```bash
pnpm --filter @dohc/web test convex/authzBoundaries.test.ts convex/atoms.test.ts convex/agent.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/workspace-postgres
git commit -m "Implement Postgres atom backend conformance"
```

---

## Phase 5: Convex Compatibility Adapter For Contract Tests

**Files:**

- Create: `packages/workspace-convex-compat/package.json`
- Create: `packages/workspace-convex-compat/tsconfig.json`
- Create: `packages/workspace-convex-compat/src/testAdapter.ts`
- Create: `packages/workspace-convex-compat/src/conformance.test.ts`
- Create: `packages/workspace-convex-compat/src/index.ts`

- [ ] **Step 1: Add the package**

Create a package that runs the same conformance tests through Convex test utilities.

Package name:

```json
"@dohc/workspace-convex-compat"
```

- [ ] **Step 2: Write failing Convex conformance**

Create `packages/workspace-convex-compat/src/conformance.test.ts`:

```ts
import { runWorkspaceBackendConformance } from "@dohc/workspace-contracts";
import { convexTestAdapter } from "./testAdapter";

runWorkspaceBackendConformance(convexTestAdapter);
```

Run:

```bash
pnpm --filter @dohc/workspace-convex-compat test src/conformance.test.ts
```

Expected: fail until the adapter maps to existing Convex functions.

- [ ] **Step 3: Implement the adapter**

Map the contract operations to existing Convex test helpers and Convex functions:

```txt
listFiles -> atoms/folders listing behavior
readText -> read atom body or canonical markdown projection
createAtom -> existing create atom mutation/tool path
writeAtom -> existing semantic write path with revision check
saveAsset -> fail with unsupported_media_type until Phase 6 maps assets
deleteFile -> existing trash/delete path
```

The adapter must use server-side test identity. It must not pass trusted user/workspace identity through user-controlled payload fields.

- [ ] **Step 4: Run both conformance suites**

```bash
pnpm --filter @dohc/workspace-convex-compat test
pnpm --filter @dohc/workspace-postgres test
```

Expected: both pass for the currently implemented contract surface.

- [ ] **Step 5: Commit**

```bash
git add packages/workspace-convex-compat package.json pnpm-lock.yaml
git commit -m "Add Convex workspace conformance adapter"
```

---

## Phase 6: Assets, Upload UI, And Type-Specific File Views

**Files:**

- Modify: `packages/workspace-contracts/src/backend.ts`
- Modify: `packages/workspace-contracts/src/conformance.test.ts`
- Modify: `packages/workspace-postgres/src/db/schema.ts`
- Modify: `packages/workspace-postgres/src/services/backend.ts`
- Modify: `packages/workspace-convex-compat/src/testAdapter.ts`
- Create: `apps/app/src/components/UploadFileButton.tsx`
- Create: `apps/app/src/components/FileTypeView.tsx`
- Modify: `apps/app/src/components/AtomView.tsx`
- Modify: `apps/app/src/components/FileTree.tsx`
- Create: `apps/app/src/__tests__/uploadFiles.test.tsx`
- Create: `apps/app/src/__tests__/fileTypeViews.test.tsx`
- Create: `apps/app/src/__tests__/renameShortName.test.tsx`

- [ ] **Step 1: Write failing UI tests**

`uploadFiles.test.tsx` must assert:

- the app exposes an upload button in the file/sidebar area.
- accepted file types include PNG, JPEG, PDF, M4A, CSV, TXT, JSON, SQLite, and generic files.
- upload success creates a visible workspace file.

`fileTypeViews.test.tsx` must assert:

- `.csv` opens a CSV/data view, not the markdown editor.
- `.txt` opens a plain text view.
- `.json` opens a JSON/code view.
- `.pdf` opens a PDF/file preview shell.
- image files open an image preview shell.
- audio files open an audio preview shell.

`renameShortName.test.tsx` must assert:

- renaming `finance/something.md` shows `something.md` in the input.
- the folder path remains implied.
- submitting `renamed.md` keeps the path under `finance/`.

- [ ] **Step 2: Run UI tests and confirm RED**

```bash
pnpm --filter @dohc/web test src/__tests__/uploadFiles.test.tsx src/__tests__/fileTypeViews.test.tsx src/__tests__/renameShortName.test.tsx
```

Expected: fail because upload UI and type-specific views are incomplete.

- [ ] **Step 3: Extend backend contract for assets**

Add:

```ts
export type ReadAssetOutput = {
  mediaType: string;
  kind: AssetKind;
  bytes: Uint8Array;
  revision: string;
};

export type WorkspaceBackend = {
  // existing methods
  readAsset(actor: Actor, path: string): Promise<ReadAssetOutput>;
  renameFile(actor: Actor, input: { fromPath: string; toName: string; expectedRevision: string }): Promise<WorkspaceFile>;
};
```

- [ ] **Step 4: Implement Postgres asset storage**

Postgres metadata stores:

- path
- media type
- size
- sha256
- object key
- revision
- workspace id

Bytes are stored through a blob adapter. The first implementation may use local filesystem storage under `.dohc-dev/blobs/` with the same interface that can later point to S3 or MinIO.

- [ ] **Step 5: Map Convex assets to the contract**

Update the Convex compatibility adapter so existing Convex storage-backed assets satisfy the same asset contract.

- [ ] **Step 6: Implement upload UI**

Create `UploadFileButton.tsx` with:

- native file picker.
- accepted file types.
- progress state.
- error state.
- no browser `alert` usage.
- post-upload navigation to the created file.

- [ ] **Step 7: Implement type-specific file views**

Create `FileTypeView.tsx`:

```ts
export type FileTypeViewProps = {
  path: string;
  mediaType: string;
  extension: string;
  body?: string;
  assetUrl?: string;
};
```

Rules:

- markdown uses the existing markdown editor.
- csv uses a table/data preview with raw text toggle.
- txt uses plain text editor.
- json uses formatted code preview/editor.
- html uses existing sandbox view.
- image uses image preview.
- audio uses audio controls.
- pdf uses object/embed preview with download fallback.
- sqlite uses Database Studio.

- [ ] **Step 8: Implement rename short-name behavior**

Update rename UI to split path:

```ts
const folderPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const fileName = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
```

The input edits `fileName` only. The submitted path becomes:

```ts
folderPath ? `${folderPath}/${newFileName}` : newFileName;
```

- [ ] **Step 9: Run tests**

```bash
pnpm --filter @dohc/web test src/__tests__/uploadFiles.test.tsx src/__tests__/fileTypeViews.test.tsx src/__tests__/renameShortName.test.tsx
pnpm --filter @dohc/workspace-postgres test
pnpm --filter @dohc/workspace-convex-compat test
```

Expected: pass.

- [ ] **Step 10: Commit**

```bash
git add packages apps/app/src
git commit -m "Add upload UI and type-specific file views"
```

---

## Phase 7: Agent-Native Files, Data Import, And Database Tools

**Files:**

- Modify: `packages/workspace-contracts/src/backend.ts`
- Create: `packages/workspace-contracts/src/dataImport.ts`
- Create: `packages/workspace-postgres/src/services/dataImport.ts`
- Modify: `apps/app/convex/agent.ts`
- Modify: `apps/app/convex/databaseFiles.ts`
- Modify: `apps/app/convex/databaseOps.ts`
- Create: `apps/app/convex/agentDataTools.test.ts`
- Create: `packages/workspace-postgres/src/services/dataImport.test.ts`
- Create: `services/sqlite-worker/src/importData.test.ts`
- Modify: `services/sqlite-worker/src/sqliteEngine.ts`

- [ ] **Step 1: Write failing tests for agent data import**

Create tests proving:

- agent can save a generated CSV file.
- agent can save a generated TXT file.
- agent can save a generated JSON file.
- agent can import uploaded CSV into SQLite.
- agent can import JSON array data into SQLite.
- agent can extract table-like PDF text into a source file and structured rows when extraction is available.
- agent cannot write imported private data into a shared folder without approval.

- [ ] **Step 2: Define data import contract**

Create `packages/workspace-contracts/src/dataImport.ts`:

```ts
export type ImportSource =
  | { kind: "asset"; path: string }
  | { kind: "atom"; path: string }
  | { kind: "inline"; name: string; mediaType: string; body: string };

export type ImportTarget =
  | { kind: "atom"; path: string; contentType: string }
  | { kind: "sqlite"; path: string; tableName: string }
  | { kind: "collection"; path: string };

export type ImportDataRequest = {
  source: ImportSource;
  target: ImportTarget;
  mode: "infer-schema" | "provided-schema";
  schema?: Record<string, "text" | "integer" | "real" | "boolean" | "datetime">;
};
```

- [ ] **Step 3: Add agent tools**

Add agent tools with server-derived identity:

```txt
save_file
upload_asset
inspect_file
import_data
query_database
write_database_rows
export_file
embed_asset
```

Rules:

- generated text files use atoms.
- generated binary files use assets.
- data imports can target CSV/JSON atoms, source-backed collections, or SQLite.
- database writes use operation logs and version checks.
- imports that cross privacy/sharing boundaries require approval.

- [ ] **Step 4: Extend SQLite worker**

Add import helpers:

- CSV to SQLite table.
- JSON array to SQLite table.
- JSONL to SQLite table.
- markdown table to SQLite table.

The worker must emit:

```txt
table schema
row count
source hash
operation log entry
materialized SQLite bytes
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @dohc/web test convex/agentDataTools.test.ts convex/databaseFiles.test.ts convex/databaseOps.test.ts
pnpm --filter @dohc/sqlite-worker test
pnpm --filter @dohc/workspace-postgres test src/services/dataImport.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/app/convex packages/workspace-contracts packages/workspace-postgres services/sqlite-worker
git commit -m "Add agent-native file and data import tools"
```

---

## Phase 8: Filesystem Projection

**Files:**

- Create: `packages/workspace-fs/package.json`
- Create: `packages/workspace-fs/tsconfig.json`
- Create: `packages/workspace-fs/src/metadata.ts`
- Create: `packages/workspace-fs/src/materialize.ts`
- Create: `packages/workspace-fs/src/scan.ts`
- Create: `packages/workspace-fs/src/diff.ts`
- Create: `packages/workspace-fs/src/apply.ts`
- Create: `packages/workspace-fs/src/fsProjection.test.ts`
- Create: `packages/workspace-fs/src/index.ts`

- [ ] **Step 1: Write failing projection tests**

Tests must prove:

- materializing a workspace creates normal files.
- `.dohc/manifest.json` records stable IDs, revisions, media types, and backend mode.
- scanning a changed folder creates a diff.
- applying a diff respects expected revisions.
- path traversal is rejected.
- binary files are represented as assets.
- SQLite files are not CRDT-synced as raw document text.

- [ ] **Step 2: Define metadata format**

Create `.dohc/manifest.json` shape:

```json
{
  "version": 1,
  "workspaceId": "workspace-id",
  "backend": "convex",
  "files": {
    "finance/transactions.csv": {
      "id": "atom-id",
      "kind": "atom",
      "contentType": "text/csv",
      "revision": "rev-1"
    },
    "uploads/receipt.png": {
      "id": "asset-id",
      "kind": "asset",
      "contentType": "image/png",
      "revision": "rev-2"
    }
  }
}
```

- [ ] **Step 3: Implement materialize**

`materializeWorkspace` takes a `WorkspaceBackend`, actor, and target directory.

It writes:

- atom bodies as files.
- asset bytes as files.
- database files as `.sqlite`, `.sqlite3`, or `.db`.
- manifest metadata under `.dohc/`.

- [ ] **Step 4: Implement scan and diff**

Diff operations:

```ts
type FsDiff =
  | { op: "create"; path: string; mediaType: string }
  | { op: "update"; path: string; expectedRevision: string }
  | { op: "delete"; path: string; expectedRevision: string }
  | { op: "rename"; fromPath: string; toPath: string; expectedRevision: string };
```

- [ ] **Step 5: Implement apply**

`applyFsDiff` calls backend operations and never mutates the backend directly.

Required policy:

- text updates use `writeAtom`.
- binary updates use `saveAsset`.
- stale revisions fail.
- locked files fail.
- review-required paths produce approval requests.

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @dohc/workspace-fs test
pnpm --filter @dohc/workspace-fs typecheck
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add packages/workspace-fs package.json pnpm-lock.yaml
git commit -m "Add workspace filesystem projection"
```

---

## Phase 9: Local Files Mode

**Files:**

- Create: `services/workspace-api/package.json`
- Create: `services/workspace-api/src/server.ts`
- Create: `services/workspace-api/src/routes/files.ts`
- Create: `services/workspace-api/src/routes/sync.ts`
- Create: `services/workspace-api/src/auth/session.ts`
- Create: `services/workspace-api/src/realtime/events.ts`
- Create: `packages/workspace-fs/src/watch.ts`
- Create: `packages/workspace-fs/src/syncClient.ts`
- Create: `packages/workspace-fs/src/localMode.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing local mode tests**

Tests must prove:

- a local folder can materialize from the backend.
- a local edit syncs back through backend revision checks.
- a remote backend update syncs into the folder.
- conflicting edits produce a conflict file or review item, not silent overwrite.
- local deletion of a shared/locked file requires approval.

- [ ] **Step 2: Add workspace API service**

The service exposes:

```txt
GET /workspaces/:workspaceId/files
GET /workspaces/:workspaceId/files/:path
POST /workspaces/:workspaceId/files/:path
POST /workspaces/:workspaceId/assets
POST /workspaces/:workspaceId/sync/apply
GET /workspaces/:workspaceId/events
```

The service uses the selected backend implementation.

- [ ] **Step 3: Implement local sync client**

`syncClient.ts`:

- materializes initial folder.
- watches file changes.
- batches diffs.
- applies through `/sync/apply`.
- records conflict state.
- never overwrites uncommitted local changes without conflict output.

- [ ] **Step 4: Add scripts**

Root scripts:

```json
"dev:workspace-api": "pnpm --filter @dohc/workspace-api dev",
"sync:local": "pnpm --filter @dohc/workspace-fs sync"
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @dohc/workspace-api test
pnpm --filter @dohc/workspace-fs test src/localMode.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add services/workspace-api packages/workspace-fs package.json pnpm-lock.yaml
git commit -m "Add local filesystem sync mode"
```

---

## Phase 10: Cloud Agent Sandbox With Bash-Like Power

**Files:**

- Create: `services/agent-sandbox/package.json`
- Create: `services/agent-sandbox/src/server.ts`
- Create: `services/agent-sandbox/src/sandbox/session.ts`
- Create: `services/agent-sandbox/src/sandbox/commands.ts`
- Create: `services/agent-sandbox/src/workspaceMount.ts`
- Create: `services/agent-sandbox/src/diffCapture.ts`
- Create: `services/agent-sandbox/src/approvals.ts`
- Create: `services/agent-sandbox/src/agentSandbox.test.ts`
- Modify: `apps/app/convex/agent.ts`
- Create: `apps/app/convex/agentSandboxIntegration.test.ts`

- [ ] **Step 1: Write failing sandbox tests**

Tests must prove:

- sandbox receives a projected workspace folder.
- sandbox can run `cat`, `rg`, `node`, `python`, and `sqlite3` in dev/test mode.
- sandbox changes are captured as diffs.
- diffs are applied through dohc backend policy.
- sandbox cannot read files outside the mounted workspace.
- sandbox cannot write shared/private boundary leaks without approval.
- sandbox cannot bypass app trust or locks.

- [ ] **Step 2: Implement sandbox session model**

Session fields:

```ts
type SandboxSession = {
  id: string;
  workspaceId: string;
  userId: string;
  backendMode: "convex" | "postgres";
  mountPath: string;
  status: "starting" | "running" | "applying" | "complete" | "failed";
};
```

- [ ] **Step 3: Implement command execution**

Allowed dev commands:

```txt
cat
head
tail
sed
rg
jq
node
python
sqlite3
pnpm
test_app
dohc
```

The production sandbox may use containers or a hardened runtime. The first implementation must still enforce:

- workspace-only mount.
- command timeout.
- output size limit.
- environment allowlist.
- no inherited host secrets.

- [ ] **Step 4: Implement diff capture and apply**

After each run:

1. scan workspace folder.
2. generate `FsDiff`.
3. show approval if needed.
4. apply through backend.
5. persist run provenance.

- [ ] **Step 5: Add agent prompt/tool integration**

The dohc agent can choose:

```txt
run_workspace_shell
apply_workspace_shell_diff
discard_workspace_shell_diff
```

The prompt must say:

- use shell for large data/file/app work.
- use dohc tools for permissions, approvals, sharing, app trust, and finalization.
- never claim shell changes are persisted until the diff is applied.

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @dohc/agent-sandbox test
pnpm --filter @dohc/web test convex/agentSandboxIntegration.test.ts convex/agentApprovals.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add services/agent-sandbox apps/app/convex package.json pnpm-lock.yaml
git commit -m "Add workspace shell sandbox for agents"
```

---

## Phase 11: Agent Output, Approvals, And Run UX

**Files:**

- Modify: `apps/app/src/components/Chat.tsx`
- Modify: `apps/app/src/components/AgentRunRail.tsx`
- Modify: `apps/app/src/components/NoticeCenter.tsx`
- Create: `apps/app/src/components/AgentActivityTimeline.tsx`
- Create: `apps/app/src/__tests__/agentOutputSeparation.test.tsx`
- Create: `apps/app/src/__tests__/agentApprovalResume.test.tsx`
- Modify: `apps/app/convex/agentApprovals.test.ts`
- Modify: `apps/app/convex/agent.ts`

- [ ] **Step 1: Write failing output tests**

Tests must prove:

- progress narration renders in a collapsible activity timeline.
- final answer renders as a separate assistant message.
- tool calls render as structured activity, not final prose.
- the final answer preserves markdown formatting.
- run duration covers the whole run lifecycle.
- duplicate user prompts are not rendered twice.

- [ ] **Step 2: Write failing approval tests**

Tests must prove:

- approval cards show `Allow`, `Always Allow`, and `Deny`.
- `Allow` resumes the paused agent run.
- `Always Allow` records a scoped policy grant.
- `Deny` records denial and stops the action.
- approval scope is action-specific and workspace/user-specific.

- [ ] **Step 3: Implement message event separation**

Message event kinds:

```txt
assistant_progress
tool_call
tool_result
approval_request
approval_result
assistant_final
run_error
```

Only `assistant_final` becomes the main final chat bubble.

- [ ] **Step 4: Implement activity timeline**

Display:

- progress text.
- files changed.
- tools used.
- tests run.
- approvals.
- errors.

Default collapsed after the run completes.

- [ ] **Step 5: Fix resume behavior**

Approval resolution must enqueue or resume the exact paused run step. It must not rely on the user typing "continue".

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @dohc/web test src/__tests__/agentOutputSeparation.test.tsx src/__tests__/agentApprovalResume.test.tsx convex/agentApprovals.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add apps/app/src apps/app/convex
git commit -m "Separate agent activity from final output"
```

---

## Phase 12: Apps And SQLite Against Both Backends

**Files:**

- Modify: `apps/app/src/apps/AppRuntimeHost.tsx`
- Modify: `apps/app/src/apps/sdkProtocol.ts`
- Modify: `apps/app/src/apps/virtualDohcAppSdk.ts`
- Modify: `apps/app/convex/appData.ts`
- Create: `packages/workspace-postgres/src/services/apps.ts`
- Create: `packages/workspace-postgres/src/services/databaseFiles.ts`
- Create: `packages/workspace-postgres/src/services/databaseOps.ts`
- Create: `packages/workspace-postgres/src/services/apps.test.ts`
- Create: `packages/workspace-postgres/src/services/databaseOps.test.ts`
- Modify: `services/app-tester/src/runAppTest.ts`
- Create: `services/app-tester/src/backendMatrix.test.ts`

- [ ] **Step 1: Write backend matrix tests**

AppTester must run the same fixture against:

```txt
backend=convex
backend=postgres
```

The finance tracker fixture must:

- add expenses.
- categorize transactions.
- mark reviewed.
- persist.
- reload.
- pass `test_app`.

- [ ] **Step 2: Port app data operations to the contract**

App runtime operations:

```txt
dohc.doc.get
dohc.doc.set
dohc.doc.append
dohc.collection.query
dohc.collection.insert
dohc.collection.update
dohc.database.tables
dohc.database.query
dohc.database.table.insert
dohc.database.table.update
dohc.asset.resolve
dohc.agent.run
dohc.patch.propose
```

Each operation must call a backend transport that enforces:

- authenticated user.
- workspace membership.
- app manifest maximum scope.
- per-user app trust.
- locks.
- review gates.
- source-scoped asset access.

- [ ] **Step 3: Implement Postgres apps services**

Postgres services must support:

- app package discovery under `.apps`.
- manifest validation.
- app source digest.
- per-user trust grants.
- app-scoped document reads/writes.
- app-scoped database operations.
- app-scoped asset resolution.

- [ ] **Step 4: Implement Postgres database services**

Database services must support:

- upload/ingest SQLite file.
- create SQLite database from data import.
- query tables.
- transactional row operations.
- operation logs.
- version conflicts.
- materialization to SQLite bytes.

- [ ] **Step 5: Run app and SQLite tests**

```bash
pnpm --filter @dohc/web test convex/appSecurity.test.ts convex/appTrust.test.ts convex/appData.test.ts convex/databaseFiles.test.ts convex/databaseOps.test.ts
pnpm --filter @dohc/workspace-postgres test src/services/apps.test.ts src/services/databaseOps.test.ts
pnpm --filter @dohc/app-tester test src/backendMatrix.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/app/src/apps apps/app/convex packages/workspace-postgres services/app-tester
git commit -m "Run apps and SQLite across Convex and Postgres"
```

---

## Phase 13: Frontend Backend Switch

**Files:**

- Create: `apps/app/src/backend/backendClient.ts`
- Create: `apps/app/src/backend/convexBackendClient.ts`
- Create: `apps/app/src/backend/postgresBackendClient.ts`
- Modify: `apps/app/src/routes/_app.tsx`
- Modify: `apps/app/src/components/FileTree.tsx`
- Modify: `apps/app/src/components/AtomView.tsx`
- Modify: `apps/app/src/components/Chat.tsx`
- Create: `apps/app/src/__tests__/backendSwitch.test.tsx`

- [ ] **Step 1: Write failing backend switch tests**

Tests must prove:

- default backend mode is Convex.
- `DOHC_BACKEND=postgres` routes file list/read/write/upload calls through the Postgres client.
- UI behavior is the same for common file flows.
- mode cannot be changed by browser-controlled URL query string.

- [ ] **Step 2: Add backend client abstraction**

`backendClient.ts` exports:

```ts
export type DohcBackendClient = {
  listFiles(): Promise<WorkspaceFile[]>;
  readText(path: string): Promise<{ body: string; revision: string }>;
  createTextFile(input: { path: string; body: string; contentType: string }): Promise<WorkspaceFile>;
  uploadFile(input: { file: File; path: string }): Promise<WorkspaceFile>;
  renameFile(input: { path: string; newName: string; expectedRevision: string }): Promise<WorkspaceFile>;
};
```

- [ ] **Step 3: Wire Convex client**

`convexBackendClient.ts` wraps the existing Convex calls without changing server behavior.

- [ ] **Step 4: Wire Postgres client**

`postgresBackendClient.ts` calls `services/workspace-api`.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @dohc/web test src/__tests__/backendSwitch.test.tsx src/__tests__/fileTypeViews.test.tsx src/__tests__/uploadFiles.test.tsx
pnpm --filter @dohc/web typecheck
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/app/src
git commit -m "Add frontend backend switch for Convex and Postgres"
```

---

## Phase 14: Self-Hosting And Cloud Packaging

**Files:**

- Create: `docs/self-hosting.md`
- Create: `docs/architecture/backend-modes.md`
- Create: `docs/architecture/local-files-and-cloud-sandbox.md`
- Modify: `README.md`
- Modify: `docker-compose.dev.yml`
- Create: `docker-compose.self-host.yml`
- Create: `.env.self-host.example`
- Create: `scripts/check-self-host.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write self-host smoke script**

Create `scripts/check-self-host.mjs` that verifies:

- Postgres is reachable.
- object storage is reachable.
- workspace API starts.
- web app starts.
- Hocuspocus starts.
- app tester starts.
- sqlite worker starts.

- [ ] **Step 2: Add self-host compose**

`docker-compose.self-host.yml` includes:

```txt
web
workspace-api
postgres
object-storage
hocuspocus
sqlite-worker
app-tester
agent-sandbox
```

- [ ] **Step 3: Document backend modes**

`docs/architecture/backend-modes.md` must explain:

- Convex remains supported during migration.
- Postgres is the candidate self-host/cloud core.
- shared conformance tests decide readiness.
- feature flags and environment variables.

- [ ] **Step 4: Document local files and cloud sandbox**

`docs/architecture/local-files-and-cloud-sandbox.md` must explain:

- dohc source of truth.
- filesystem projection.
- `.dohc/manifest.json`.
- local sync.
- cloud sandbox.
- why shell writes are applied through dohc policy.

- [ ] **Step 5: Document self-hosting**

`docs/self-hosting.md` must include:

- prerequisites.
- env vars.
- first boot.
- reset dev data.
- backup/restore model.
- upgrade model.
- security notes.

- [ ] **Step 6: Run smoke**

```bash
pnpm check:self-host
```

Expected: local self-host stack starts or reports exact missing Docker/service dependency.

- [ ] **Step 7: Commit**

```bash
git add README.md docs docker-compose.self-host.yml .env.self-host.example scripts/check-self-host.mjs package.json
git commit -m "Document self-hosted Postgres backend mode"
```

---

## Phase 15: End-To-End Comparison Gate

**Files:**

- Create: `apps/app/e2e/backendMatrix.spec.ts`
- Create: `docs/superpowers/reviews/2026-06-09-dual-backend-readiness-review.md`
- Modify: `docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md`

- [ ] **Step 1: Write Playwright backend matrix**

Create `apps/app/e2e/backendMatrix.spec.ts`.

The same test must run with:

```txt
DOHC_BACKEND=convex
DOHC_BACKEND=postgres
```

Flow:

1. create workspace.
2. upload wallet CSV.
3. ask agent to create finance tracker.
4. agent imports data into durable storage.
5. agent creates source files and `.apps/ledger`.
6. app tester passes.
7. user opens app.
8. user edits category.
9. reload preserves change.
10. collaborator sees permitted shared change.
11. unauthorized user cannot see private finance data.
12. local filesystem projection materializes files.
13. cloud shell can `rg`, inspect, and propose safe diff.

- [ ] **Step 2: Run Convex matrix**

```bash
DOHC_BACKEND=convex pnpm test:e2e apps/app/e2e/backendMatrix.spec.ts
```

Expected: pass.

- [ ] **Step 3: Run Postgres matrix**

```bash
DOHC_BACKEND=postgres pnpm test:e2e apps/app/e2e/backendMatrix.spec.ts
```

Expected: pass or record exact remaining gaps in the readiness review.

- [ ] **Step 4: Run full verification**

```bash
pnpm check:dual-backend-baseline
pnpm --filter @dohc/workspace-contracts test
pnpm --filter @dohc/workspace-postgres test
pnpm --filter @dohc/workspace-convex-compat test
pnpm --filter @dohc/workspace-fs test
pnpm --filter @dohc/workspace-api test
pnpm --filter @dohc/agent-sandbox test
DOHC_BACKEND=convex pnpm test:e2e apps/app/e2e/backendMatrix.spec.ts
DOHC_BACKEND=postgres pnpm test:e2e apps/app/e2e/backendMatrix.spec.ts
pnpm check:debt
git diff --check
```

Expected:

- Convex remains green.
- Postgres passes all conformance tests.
- backend matrix passes or has a short readiness review explaining blockers.

- [ ] **Step 5: Write readiness review**

`docs/superpowers/reviews/2026-06-09-dual-backend-readiness-review.md` must answer:

- Is Convex still production-safe?
- Is Postgres ready for development mode?
- Is Postgres ready for production mode?
- Which flows are equivalent?
- Which flows are better on Postgres?
- Which flows still depend on Convex?
- Can dohc Cloud be built on the Postgres path?
- Can self-hosting be documented honestly?

- [ ] **Step 6: Commit**

```bash
git add apps/app/e2e docs/superpowers/reviews docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md
git commit -m "Add dual backend readiness gate"
```

---

## Phase 16: Tech Debt Audit And Deletion Gate

**Files:**

- Create: `scripts/check-tech-debt.mjs`
- Create: `docs/superpowers/reviews/2026-06-09-dual-backend-tech-debt-audit.md`
- Modify: `package.json`
- Modify/delete: obsolete code identified by this phase
- Modify: `docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md`

- [ ] **Step 1: Create debt check script**

Create `scripts/check-tech-debt.mjs`.

The script must fail on:

```txt
TODO
TBD
temporary dual backend
remove after migration
legacy views TODO
skip because migration
dead code
```

Allowed matches must be listed in an allowlist inside the script with a reason and deletion condition.

- [ ] **Step 2: Register debt check**

Add root script:

```json
"check:debt": "node scripts/check-tech-debt.mjs"
```

- [ ] **Step 3: Run static debt scans**

Run:

```bash
pnpm check:debt
pnpm -r --if-present typecheck
```

Expected:

- no untracked TODO/TBD migration leftovers.
- no unused exports reported by TypeScript.
- failures are either fixed or recorded with exact deletion condition.

- [ ] **Step 4: Run touched-area deletion review**

Inspect:

```bash
git diff --stat main...HEAD
git diff --name-status main...HEAD
```

For each major area, answer in the audit:

- What new abstraction replaced older code?
- Which older code was deleted?
- Which older code remains only for compatibility?
- What test proves the compatibility path is still needed?
- What condition allows deleting it later?

- [ ] **Step 5: Delete obsolete code**

Delete or consolidate code in areas where tests prove the new path supersedes the old path.

Priority deletion targets:

- dead `.views` product-language UI once `.apps` compatibility tests cover migration behavior.
- duplicate collection parsing code now owned by shared adapters/contracts.
- duplicate app SDK protocol helpers.
- obsolete onboarding prompt branches that tell agents to create markdown-only fake dashboards.
- temporary adversarial scripts now covered by permanent AppTester tests.
- old upload/read paths that cannot handle binary assets.
- duplicate dev reset scripts that do not reset the new stack.

Do not delete Convex support. Do not delete compatibility shims that are still needed for existing data or tests.

- [ ] **Step 6: Run full verification after deletion**

Run:

```bash
pnpm check:dual-backend-baseline
pnpm check:debt
pnpm --filter @dohc/workspace-contracts test
pnpm --filter @dohc/workspace-postgres test
pnpm --filter @dohc/workspace-convex-compat test
pnpm --filter @dohc/workspace-fs test
pnpm --filter @dohc/workspace-api test
pnpm --filter @dohc/agent-sandbox test
DOHC_BACKEND=convex pnpm test:e2e apps/app/e2e/backendMatrix.spec.ts
DOHC_BACKEND=postgres pnpm test:e2e apps/app/e2e/backendMatrix.spec.ts
git diff --check
```

Expected:

- deleted code does not regress Convex.
- deleted code does not regress Postgres.
- debt check passes.
- backend matrix still passes or exact blockers are recorded.

- [ ] **Step 7: Write debt audit**

Create `docs/superpowers/reviews/2026-06-09-dual-backend-tech-debt-audit.md` with:

```md
# Dual Backend Tech Debt Audit

## Summary

## Code Deleted

## Code Consolidated

## Compatibility Code Retained

## Tests Proving Retained Code Is Needed

## Known Debt And Deletion Conditions

## Commands Run

## Remaining Risk
```

- [ ] **Step 8: Commit**

```bash
git add package.json scripts/check-tech-debt.mjs docs/superpowers/reviews/2026-06-09-dual-backend-tech-debt-audit.md docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md
git add -u
git commit -m "Audit and reduce dual backend tech debt"
```

---

## Acceptance Criteria

The plan is complete only when:

- Convex mode still passes existing app/backend/security/collaboration tests.
- Postgres mode passes shared workspace conformance tests.
- The frontend can run common file flows against Convex or Postgres by config.
- Users can upload PNG, JPEG, PDF, M4A, CSV, TXT, JSON, SQLite, and generic files.
- File views reflect file type instead of treating every text-backed path as markdown.
- Rename UI edits only the filename when inside a folder.
- Agents can save files, upload assets, import data, query/write databases, and embed assets through dohc-authorized paths.
- Agents can use a sandboxed shell over a projected workspace.
- Shell writes are captured as diffs and applied through dohc policy.
- Local filesystem projection works with stable metadata and conflict handling.
- App/SQLite behavior runs through backend contracts.
- Agent progress, tool activity, approvals, and final answers render separately.
- Self-hosting docs and compose files exist for the Postgres path.
- Backend matrix tests compare Convex and Postgres on the same real workflows.
- obsolete code introduced or superseded by the migration is deleted or explicitly justified.
- `pnpm check:debt` passes.
- the final tech debt audit names retained compatibility code and its deletion conditions.

## Release And Product Decision Gate

After Phase 16, do not automatically switch production to Postgres.

Make the decision with evidence:

```txt
Keep Convex default:
  if Postgres lacks realtime/collaboration parity, app trust parity, or stable self-host packaging.

Use Postgres for dev/self-host preview:
  if conformance passes but some production cloud requirements remain.

Make Postgres default:
  if backend matrix, security tests, app tests, sync tests, and self-host smoke are all green.
```

## Self-Review Checklist For Implementers

Before final response:

- [ ] No phase removed Convex support.
- [ ] No phase let browser callers provide trusted identity.
- [ ] No shell write bypassed backend policy.
- [ ] No local sync write bypassed revision checks.
- [ ] No binary asset was stored as raw markdown text.
- [ ] No SQLite raw bytes were CRDT-synced.
- [ ] No final answer claimed Postgres was production-ready without backend matrix evidence.
- [ ] Execution log contains every phase.
- [ ] `git diff --check` is clean.
- [ ] Final response lists tests run, failures, and remaining risks.

## Self-Grade Rubric Before Final

The implementation must score `2` in every row before it can be called complete.

| Area | 0 | 1 | 2 |
|---|---|---|---|
| Convex preservation | Convex broken or removed | Convex partially works | Convex remains default and passes required regressions |
| Postgres core | no real backend | partial metadata only | Postgres passes workspace conformance tests |
| Backend contract | ad hoc split behavior | partial shared types | Convex and Postgres run through shared conformance harness |
| File UX | uploads/views missing | partial upload or generic markdown views | upload UI and type-specific views work for text, data, media, SQLite |
| Agent data tools | markdown-only fallback | partial file/data import | agent can save files/assets, import data, query/write databases safely |
| Filesystem projection | absent | one-way export only | materialize, scan, diff, apply, conflicts, and metadata are tested |
| Shell sandbox | absent or unsafe | shell runs without policy integration | shell diffs apply only through dohc auth/lock/review policy |
| Output UX | progress mixed with final | partial separation | activity, tools, approvals, and final answer render separately |
| Apps/SQLite | Convex-only or fake persistence | partial backend support | apps and SQLite pass backend matrix tests |
| Self-hosting | undocumented | compose/docs incomplete | self-host docs and smoke checks exist |
| Tech debt | obsolete code accumulates | some cleanup but retained paths are vague | obsolete code deleted/consolidated; retained compatibility has tests and deletion conditions |
| Security | trust/auth bypass possible | partial checks | server-derived auth, scopes, trust, locks, review gates enforced |
| Collaboration | single-user only | partial sharing | permitted users see updates; unauthorized users denied |
