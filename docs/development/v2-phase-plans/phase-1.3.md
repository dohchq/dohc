# Phase 1.3 Hocuspocus Persistence Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-hosted Hocuspocus service foundation with auth hooks, ACL rechecks, crash-safe Y.Doc update logging, snapshot compaction, and admin/health endpoints.

**Architecture:** Hocuspocus v4 runs as a separate Node workspace package under `services/hocuspocus`. `beforeSync` writes replayable Yjs sync payloads to an append-only Postgres log before Hocuspocus applies them; `onStoreDocument` stores compact snapshots later. `beforeHandleMessage` is intentionally not used for durability because it sees the raw transport envelope, not a replayable Yjs update. Auth is a 5-minute HS256 JWT plus an injected ACL adapter so Convex can be wired in Phase 1.4+ without making Convex the document owner.

**Tech Stack:** `@hocuspocus/server`, `@hocuspocus/provider` for later raw-client smoke scripts, Yjs, custom Postgres persistence via `pg`, `jose`, Vitest, TypeScript.

---

## File Structure

- Modify: `pnpm-workspace.yaml` — include `services/*`.
- Modify: `package.json` — add `dev:hocuspocus` script.
- Create: `services/hocuspocus/package.json` — service package scripts/deps.
- Create: `services/hocuspocus/tsconfig.json` — TS config.
- Create: `services/hocuspocus/src/auth.ts` — mint/verify 5-minute collab JWTs.
- Create: `services/hocuspocus/src/doc-name.ts` — encode/decode Hocuspocus document names.
- Create: `services/hocuspocus/src/persistence.ts` — Postgres update log + snapshot store.
- Create: `services/hocuspocus/src/hooks.ts` — Hocuspocus config hooks.
- Create: `services/hocuspocus/src/admin.ts` — health/admin request handlers and revocation registry.
- Create: `services/hocuspocus/src/server.ts` — env-driven server entrypoint.
- Create: `services/hocuspocus/src/*.test.ts` — unit coverage for auth, doc names, persistence, hooks/admin.
- Create: `docs/development/v2-hocuspocus-persistence.md` — exact hook boundary and durability model.
- Modify: `docs/development/v2-pivot-plan.md` — update status after verification.

---

### Task 1: Add Failing Service Tests

**Files:**
- Create: `services/hocuspocus/src/auth.test.ts`
- Create: `services/hocuspocus/src/doc-name.test.ts`
- Create: `services/hocuspocus/src/persistence.test.ts`
- Create: `services/hocuspocus/src/hooks.test.ts`
- Create: `services/hocuspocus/src/admin.test.ts`

- [x] **Step 1: Write failing tests**

Cover:

- collab tokens expire within 5 minutes and reject wrong secrets
- document names round-trip workspace/atom ids with special characters
- persistence load replays latest snapshot + later updates in sequence
- persistence append uses a monotonic per-document sequence and stores actor/socket metadata
- persistence failure in `beforeSync` throws before the update can be applied
- `onAuthenticate` rejects unreadable docs, marks read-only docs, and returns typed context
- `beforeHandleMessage` does not persist raw transport envelopes
- `beforeSync` rechecks write ACL and appends Yjs payload bytes
- malformed Yjs sync payloads are rejected before they can enter the update log
- snapshots use the highest contiguous applied update sequence, not merely the latest logged sequence
- admin health returns JSON; `disconnect-by-workspace-user` records the revocation target

- [x] **Step 2: Run focused tests to verify red**

Run:

```bash
pnpm --filter @dohc/hocuspocus test
```

Expected: fail because `@dohc/hocuspocus` package and implementation files do not exist yet.

---

### Task 2: Install OSS Dependencies And Workspace Package

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`
- Create: `services/hocuspocus/package.json`
- Create: `services/hocuspocus/tsconfig.json`
- Modify: `pnpm-lock.yaml`

- [x] **Step 1: Add the workspace package and dependencies**

Run:

```bash
pnpm add --filter @dohc/hocuspocus @hocuspocus/server @hocuspocus/provider yjs pg jose
pnpm add --filter @dohc/hocuspocus -D @types/pg tsx typescript vitest
```

Expected: dependencies install with no Tiptap Pro/Cloud/AI packages.

- [x] **Step 2: Verify paid package guardrail**

Run:

```bash
rg -n "@tiptap-pro|tiptap-pro|tiptap-ai|@tiptap/extension-ai|tracked-changes|@tiptap-pro/extension-comments" package.json pnpm-lock.yaml apps packages services
```

Expected: no dependency hits.

---

### Task 3: Implement Auth, Doc Names, And Persistence Core

**Files:**
- Create: `services/hocuspocus/src/auth.ts`
- Create: `services/hocuspocus/src/doc-name.ts`
- Create: `services/hocuspocus/src/persistence.ts`

- [x] **Step 1: Implement JWT auth helpers**

Implement:

- `mintCollabToken(payload, secret, now?)`
- `verifyCollabToken(token, secret, now?)`
- `COLLAB_TOKEN_TTL_SECONDS = 300`

- [x] **Step 2: Implement doc-name helpers**

Implement:

- `encodeDocName({ workspaceId, atomId })`
- `decodeDocName(documentName)`

Format: `workspace/<encoded workspaceId>/atom/<encoded atomId>`.

- [x] **Step 3: Implement Postgres/Yjs persistence**

Implement:

- `ensureYDocPersistenceSchema(client)`
- `PostgresYDocStore.loadDocument(documentName): Promise<Y.Doc>`
- `PostgresYDocStore.appendUpdate({ documentName, update, actorId, socketId }): Promise<{ seq }>`
- `PostgresYDocStore.storeSnapshot(documentName, doc): Promise<{ snapshotId, lastSeq }>`

Use `hocuspocus_ydoc_counters`, `hocuspocus_ydoc_updates`, and `hocuspocus_ydoc_snapshots`.

- [x] **Step 4: Run focused service tests**

Run:

```bash
pnpm --filter @dohc/hocuspocus test
```

Expected: auth/doc-name/persistence tests pass; hooks/admin may still fail until Task 4.

---

### Task 4: Implement Hocuspocus Hooks And Admin Surface

**Files:**
- Create: `services/hocuspocus/src/hooks.ts`
- Create: `services/hocuspocus/src/admin.ts`
- Create: `services/hocuspocus/src/server.ts`

- [x] **Step 1: Implement hook factory**

Implement `createHocuspocusHooks({ jwtSecret, acl, store, logger })` with:

- `onAuthenticate`: verify token, decode document name, require read access, set `connection.readOnly` when write is denied, return typed context.
- `onLoadDocument`: require read access, load Y.Doc from store.
- `beforeHandleMessage`: no durable write; it receives the raw transport envelope.
- `beforeSync`: require write access for Yjs sync payload bytes, append the update before allowing Hocuspocus to apply it.
- `onStoreDocument`: store a compact snapshot.
- `onChange`: log only; projection wiring stays Phase 1.6.

- [x] **Step 2: Implement admin/health handlers**

Implement:

- `GET /healthz` returns `{ ok: true, service: 'dohc-hocuspocus' }`
- `POST /admin/disconnect-by-workspace-user` accepts `{ workspaceId, userId }`, records the revocation in the registry, and returns `{ ok: true, disconnected: number }`

- [x] **Step 3: Implement server entrypoint**

Read env:

- `HOCUSPOCUS_PORT` default `1234`
- `HOCUSPOCUS_DATABASE_URL` required outside tests
- `HOCUSPOCUS_JWT_SECRET` required outside tests
- `HOCUSPOCUS_ADMIN_TOKEN` required for admin POSTs

- [x] **Step 4: Run focused service tests**

Run:

```bash
pnpm --filter @dohc/hocuspocus test
```

Expected: all service tests pass.

---

### Task 5: Document The Durability Boundary

**Files:**
- Create: `docs/development/v2-hocuspocus-persistence.md`
- Modify: `docs/development/v2-phase-plans/phase-1.3.md`

- [x] **Step 1: Write persistence spike notes**

Document:

- Hocuspocus docs say `beforeHandleMessage` runs directly before handling messages, but local Hocuspocus v4 source shows its `update` is the raw transport envelope.
- Hocuspocus docs/source say `beforeSync` runs before a sync message is handled and exposes the y-protocols `type` and replayable `payload`.
- Hocuspocus docs say `onStoreDocument` is debounced, so it is not enough for ack-safe durability by itself.
- dohc uses `beforeSync` for eager update-log writes and `onStoreDocument` for compact snapshots.
- If `appendUpdate` fails, the hook throws, so the connection is closed before the update is applied.
- This phase still needs a later live provider kill-test with real Postgres before Phase 1.4 client integration.

- [x] **Step 2: Run docs guardrail**

Run:

```bash
rg -n "beforeHandleMessage|onStoreDocument|append-only|ack" docs/development/v2-hocuspocus-persistence.md
```

Expected: all four concepts appear.

---

### Task 6: Full Verification And Commit

**Files:**
- Modify: `docs/development/v2-pivot-plan.md`
- Modify: `docs/development/v2-phase-plans/phase-1.3.md`

- [x] **Step 1: Run full verification**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

Expected: all pass on Node 24.14.0. Lint may remain the app placeholder plus service package script.

- [x] **Step 2: Update pivot plan status**

If verification passes, update `docs/development/v2-pivot-plan.md` status to:

```markdown
**Status:** Plan v1.7 — Phase 1.3 Hocuspocus persistence spike foundation complete; ready for live provider crash test
```

- [ ] **Step 3: Commit**

Run:

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml services/hocuspocus docs/development/v2-hocuspocus-persistence.md docs/development/v2-phase-plans/phase-1.3.md docs/development/v2-pivot-plan.md
git commit --no-gpg-sign -m "feat: add hocuspocus persistence spike foundation"
```
