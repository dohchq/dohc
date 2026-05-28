# Phase 1.6 Server-Owned `atoms.body` Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move markdown cache writes out of the browser/editor path. Y.Doc remains canonical; `atoms.body` becomes a derived cache updated by Hocuspocus projection.

**Architecture:** Hocuspocus debounces Y.Doc changes, serializes the live Y.Doc to markdown, stores a durable projection job in Postgres, and flushes that job through a secret-protected Convex mutation. Convex patches only cache fields (`body`, search fields, projection metadata, last editor) and never treats the markdown as canonical for collaborative edits.

---

## File Structure

- Modify: `apps/app/convex/schema.ts` — add projection metadata fields to `atoms`.
- Modify: `apps/app/convex/hocuspocusAuth.ts` — add server-token-gated `setBodyCache` mutation.
- Modify: `apps/app/convex/atoms.ts` — add internal cache setter used by the bridge.
- Create: `apps/app/convex/bodyCacheProjection.test.ts` — Convex cache mutation tests.
- Modify: `apps/app/src/lib/authzBoundary.test.ts` — allowlist the server-token-gated projection bridge.
- Modify: `services/hocuspocus/src/persistence.ts` — add durable projection job queue.
- Modify: `services/hocuspocus/src/persistence.test.ts` — queue persistence/order/stale-skip tests.
- Modify: `services/hocuspocus/src/convex-acl.ts` — add Convex mutation client for body cache writes.
- Modify: `services/hocuspocus/src/convex-acl.test.ts` — bridge call tests.
- Create: `services/hocuspocus/src/projection.ts` — debounce, serialize, hash, enqueue, flush.
- Modify: `services/hocuspocus/src/hooks.ts` — call projection worker from `onChange`.
- Modify: `services/hocuspocus/src/hooks.test.ts` — onChange/debounce/failure queue tests.
- Modify: `services/hocuspocus/src/server.ts` — start projection retry loop and flush pending jobs on boot.

## Task 1: Convex Body Cache Mutation

- [x] **Step 1: Write failing Convex tests**

Cover:
- wrong server token rejects.
- owner atom lookup by fileId is required.
- mutation patches `atoms.body`, search fields, `updatedAt`, `lastEditedByUserId`, and projection metadata.
- mismatched projected frontmatter `id` is rejected.

Run:

```bash
pnpm --filter @dohc/app exec vitest run convex/bodyCacheProjection.test.ts src/lib/authzBoundary.test.ts
```

Expected before implementation: fails because the mutation/fields do not exist.

- [x] **Step 2: Implement schema + bridge mutation**

Add projection fields and a server-token-gated `hocuspocusAuth.setBodyCache` wrapper around an internal atom cache setter.

Run the same tests until green.

## Task 2: Durable Projection Queue

- [x] **Step 1: Write failing queue tests**

Cover:
- projection jobs persist with monotonically increasing ids.
- newer jobs for the same document skip older pending/failed jobs.
- failed jobs retain retry metadata.
- succeeded jobs are not retried.

Run:

```bash
pnpm --filter @dohc/hocuspocus exec vitest run src/persistence.test.ts
```

Expected before implementation: fails because projection job APIs do not exist.

- [x] **Step 2: Implement Postgres + memory queue APIs**

Add `hocuspocus_projection_jobs` and `PostgresYDocStore` helpers for enqueue/list/mark-success/mark-failure.

Run the queue tests until green.

## Task 3: Convex Projection Bridge

- [x] **Step 1: Write failing adapter test**

Prove `createConvexAcl().setAtomBodyCache` calls `hocuspocusAuth:setBodyCache` as a Convex mutation with the server token and projection metadata.

Run:

```bash
pnpm --filter @dohc/hocuspocus exec vitest run src/convex-acl.test.ts
```

Expected before implementation: fails because the adapter method does not exist.

- [x] **Step 2: Implement adapter**

Extend `HocuspocusAcl` and Convex HTTP client typing to call the mutation.

Run adapter tests until green.

## Task 4: Hocuspocus Projection Worker

- [x] **Step 1: Write failing hook tests**

Cover:
- `onChange` debounces before enqueueing.
- queued projection jobs include markdown, schema version, state vector, projection hash, sequence, and last editor.
- Convex writer failure leaves a retryable job.

Run:

```bash
pnpm --filter @dohc/hocuspocus exec vitest run src/hooks.test.ts
```

Expected before implementation: fails because `onChange` only logs.

- [x] **Step 2: Implement projection worker and hook wiring**

Use `yDocToMarkdown`, SHA-256, Yjs state vector, and the durable projection queue. Start a retry loop in the real server.

Run:

```bash
pnpm --filter @dohc/hocuspocus exec vitest run src/hooks.test.ts src/persistence.test.ts src/convex-acl.test.ts
pnpm --filter @dohc/hocuspocus run typecheck
```

Expected after implementation: tests and Hocuspocus typecheck pass.

## Verification

- [x] Convex projection tests pass.
- [x] Hocuspocus queue/bridge/hook tests pass.
- [x] Hocuspocus typecheck passes.
- [x] App typecheck passes after Phase 1.9 removed the legacy Milkdown/Crepe files.

## Rollback Notes

- Existing Y.Doc update persistence is independent; rollback removes projection worker/queue and leaves `atoms.body` stale until admin rebuild.
- Projection metadata fields are optional and safe to leave in schema during rollback.
- If Convex projection fails, editing continues because Y.Doc update durability remains canonical.
