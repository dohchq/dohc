# Phase 1.3 Convex ACL Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Hocuspocus's temporary dev allow-all ACL with a Convex-backed token and document access bridge.

**Architecture:** Convex remains the source of truth for WorkOS identity, ownership, shares, org membership, and lock metadata. Convex mints short-lived HS256 collab JWTs for authenticated app clients; Hocuspocus verifies those JWTs and calls a secret-protected Convex query before loading or accepting writes for an atom Y.Doc.

**Tech Stack:** Convex actions/queries, `jose`, `ConvexHttpClient`, Hocuspocus hooks, Vitest, Docker Compose.

---

## File Structure

- Create: `apps/app/convex/hocuspocusAuth.ts` — server-token-gated ACL query for Hocuspocus.
- Create: `apps/app/convex/hocuspocusAuth.test.ts` — Convex ACL coverage for owner, shares, orgs, locks, and server-token rejection.
- Modify: `apps/app/convex/auth.ts` — add authenticated `getCollabToken` action.
- Create: `apps/app/convex/authCollabToken.test.ts` — token minting coverage.
- Modify: `apps/app/package.json` — add `jose`.
- Create: `services/hocuspocus/src/convex-acl.ts` — Hocuspocus ACL adapter backed by `ConvexHttpClient`.
- Create: `services/hocuspocus/src/convex-acl.test.ts` — adapter unit tests.
- Modify: `services/hocuspocus/src/server.ts` — choose Convex ACL when Convex env vars exist, otherwise require explicit dev ACL.
- Modify: `services/hocuspocus/package.json` — add `convex`.
- Modify: `docs/development/v2-hocuspocus-persistence.md` — document production ACL env vars and local dev behavior.
- Modify: `docs/development/v2-pivot-plan.md` — update Phase 1.3 status after verification.

## Task 1: Convex ACL Query

- [x] **Step 1: Write failing ACL tests**

Create `apps/app/convex/hocuspocusAuth.test.ts` with tests that call `api.hocuspocusAuth.checkAtomAccess`.

Cover:

- missing or wrong `serverToken` rejects
- owner can read/write an unlocked atom by fileId
- owner can read but cannot write a `systemLocked` atom
- person `view` share can read but not write
- person `edit` share can read/write unless the atom is `userLocked` or `systemLocked`
- org share allows a member and denies a stranger

Run:

```bash
pnpm --filter @dohc/app test convex/hocuspocusAuth.test.ts
```

Expected before implementation: FAIL because `api.hocuspocusAuth.checkAtomAccess` does not exist.

- [x] **Step 2: Implement `checkAtomAccess`**

Create `apps/app/convex/hocuspocusAuth.ts` as a public query with args:

```ts
{
  serverToken: v.string(),
  userId: v.string(),
  workspaceId: v.string(),
  atomId: v.string(),
  authzVersion: v.number(),
}
```

Behavior:

- reject unless `serverToken === process.env.HOCUSPOCUS_CONVEX_SERVER_TOKEN`
- return `{ workspaceAuthzVersion: 1, canRead: false, canWrite: false }` when the owner atom cannot be resolved
- owner access: `userId === workspaceId` can read; can write only when `systemLocked !== true`
- person shares: match `ownerWorkspaceId`, `granteeWorkspaceId`, and `fileId`
- org shares: match owner/fileId and require `isMember(ctx, granteeOrgId, userId)`
- shared writes require `permission === 'edit'` and both `systemLocked !== true` and `userLocked !== true`

- [x] **Step 3: Verify Convex ACL tests pass**

Run:

```bash
pnpm --filter @dohc/app test convex/hocuspocusAuth.test.ts
```

Expected: PASS.

Observed: PASS.

## Task 2: Convex Collab Token Minting

- [x] **Step 1: Add `jose` to the app package**

Run:

```bash
pnpm --filter @dohc/app add jose
```

Expected: `apps/app/package.json` and `pnpm-lock.yaml` update.

- [x] **Step 2: Write failing token tests**

Create `apps/app/convex/authCollabToken.test.ts` with tests that:

- unauthenticated `api.auth.getCollabToken` rejects
- authenticated `api.auth.getCollabToken` returns a JWT signed by `process.env.HOCUSPOCUS_JWT_SECRET`
- decoded JWT has `sub`, `ws`, `actorKind: "user"`, `authzVersion: 1`, and a 5 minute expiry
- shared-doc tokens keep `sub` as the caller but set `ws` to the requested owner workspace

Run:

```bash
pnpm --filter @dohc/app test convex/authCollabToken.test.ts
```

Expected before implementation: FAIL because `getCollabToken` does not exist.

- [x] **Step 3: Implement `getCollabToken`**

Modify `apps/app/convex/auth.ts` to import `action` and `SignJWT`, then add:

- `COLLAB_TOKEN_TTL_SECONDS = 5 * 60`
- `getCollabToken = action({ args: { workspaceId?: string }, handler })`

Behavior:

- call `requireWorkspace(ctx)` so unauthenticated callers fail
- set `sub` to the authenticated caller workspace
- set `ws` to `args.workspaceId ?? callerWorkspaceId` so shared owner docs can authenticate before Convex ACL decides access
- require `process.env.HOCUSPOCUS_JWT_SECRET`
- sign HS256 token with claims `{ sub, ws, actorKind: "user", authzVersion: 1 }`
- set `iat` and `exp` to a 5 minute window

- [x] **Step 4: Verify token tests pass**

Run:

```bash
pnpm --filter @dohc/app test convex/authCollabToken.test.ts
```

Expected: PASS.

Observed: PASS.

## Task 3: Hocuspocus Convex ACL Adapter

- [x] **Step 1: Add Convex dependency to the service**

Run:

```bash
pnpm --filter @dohc/hocuspocus add convex
```

Expected: `services/hocuspocus/package.json` and `pnpm-lock.yaml` update.

- [x] **Step 2: Write failing adapter tests**

Create `services/hocuspocus/src/convex-acl.test.ts`.

Cover:

- adapter calls Convex `hocuspocusAuth:checkAtomAccess` with server token, identity, workspace, atom id, and authz version
- `getWorkspaceAuthzVersion` returns the Convex response version
- `canReadAtom` maps to `canRead`
- `canWriteAtom` maps to `canWrite`
- adapter caches nothing for now, so revocation checks remain live on every call

Run:

```bash
pnpm --filter @dohc/hocuspocus test src/convex-acl.test.ts
```

Expected before implementation: FAIL because `convex-acl.ts` does not exist.

- [x] **Step 3: Implement adapter**

Create `services/hocuspocus/src/convex-acl.ts` with:

- `createConvexAcl({ convexUrl, serverToken, client })`
- a default `ConvexHttpClient` when `client` is not provided
- an untyped function reference created with `makeFunctionReference<'query'>('hocuspocusAuth:checkAtomAccess')`
- no cache in Phase 1.3, so every access check hits Convex

- [x] **Step 4: Verify adapter tests pass**

Run:

```bash
pnpm --filter @dohc/hocuspocus test src/convex-acl.test.ts
```

Expected: PASS.

Observed: PASS.

## Task 4: Server Wiring And Docs

- [x] **Step 1: Wire ACL selection in `server.ts`**

Modify `services/hocuspocus/src/server.ts`:

- if `HOCUSPOCUS_CONVEX_URL` and `HOCUSPOCUS_CONVEX_SERVER_TOKEN` exist, use the Convex ACL adapter
- otherwise require `HOCUSPOCUS_ALLOW_DEV_ACL=true`
- update the dev ACL error so it points to the new production env vars

- [x] **Step 2: Verify service gates**

Run:

```bash
pnpm --filter @dohc/hocuspocus typecheck
pnpm --filter @dohc/hocuspocus test
pnpm --filter @dohc/hocuspocus build
```

Expected: PASS.

Observed: PASS.

- [x] **Step 3: Verify Docker image still builds and boots**

Run:

```bash
docker compose -f docker-compose.dev.yml build hocuspocus
docker compose -f docker-compose.dev.yml up -d hocuspocus
docker compose -f docker-compose.dev.yml ps
```

Expected: Postgres and Hocuspocus healthy with local dev ACL.

Observed: Docker image builds; compose Postgres and Hocuspocus are healthy locally.

- [x] **Step 4: Update docs**

Update:

- `docs/development/v2-hocuspocus-persistence.md` with `HOCUSPOCUS_CONVEX_URL`, `HOCUSPOCUS_CONVEX_SERVER_TOKEN`, and `HOCUSPOCUS_ALLOW_DEV_ACL=true` local-only notes.
- `docs/development/v2-pivot-plan.md` status line to say Docker exists and Convex ACL bridge is implemented if all gates pass.

## Task 5: Final Verification And Commit

### Review Follow-Up: Live Revocation Disconnects

- [x] **Step 1: Verify the review finding**

Reviewer found that already-connected read-only clients would keep receiving
updates after a share/org revocation. Verified: Hocuspocus checked read access
on auth/load and write access before writes, but no Convex mutation called the
existing Hocuspocus admin disconnect endpoint.

- [x] **Step 2: Write failing revocation tests**

Added coverage for:

- Hocuspocus admin disconnects current sockets without sticky denial.
- Convex internal admin action posts to `/admin/disconnect-by-workspace-user`.
- `atomShares.unshareAtom` schedules disconnects for person shares.
- Org share revocation schedules member disconnects, excluding the owner.
- `orgs.leaveOrg` schedules disconnects from affected owner workspaces.

- [x] **Step 3: Implement revocation scheduling**

Added `apps/app/convex/hocuspocusAdmin.ts`, changed share/org revocation paths to
schedule the internal action when `HOCUSPOCUS_ADMIN_URL` and
`HOCUSPOCUS_ADMIN_TOKEN` are configured, and made the Hocuspocus in-memory
registry non-sticky so re-share can reconnect through fresh Convex ACL.
If `HOCUSPOCUS_JWT_SECRET` is configured, missing admin disconnect env is a hard
error so live revocation cannot silently degrade.

- [x] **Step 4: Verify focused revocation gates**

Observed: `pnpm --filter @dohc/app test convex/hocuspocusAdmin.test.ts` and
`pnpm --filter @dohc/hocuspocus test src/admin.test.ts src/hooks.test.ts`
passed.

- [x] **Step 1: Run focused gates**

```bash
pnpm --filter @dohc/app test convex/hocuspocusAuth.test.ts convex/authCollabToken.test.ts
pnpm --filter @dohc/hocuspocus test src/convex-acl.test.ts
pnpm --filter @dohc/hocuspocus typecheck
pnpm --filter @dohc/hocuspocus build
```

Expected: PASS.

Observed: PASS.

- [x] **Step 2: Run integration gate against Docker Postgres**

```bash
HOCUSPOCUS_TEST_DATABASE_URL=postgres://dohc:dohc@127.0.0.1:54329/dohc_v2 pnpm test:hocuspocus:integration
```

Expected: PASS.

Observed: PASS.

- [x] **Step 3: Run full repository gates**

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
git diff --check
```

Expected: PASS.

Observed: PASS. `pnpm test` keeps the known Convex-test scheduled rollback stderr and skips the live Anthropic eval without `ANTHROPIC_API_KEY`, but exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/app/convex/_generated/api.d.ts apps/app/convex/atomShares.ts apps/app/convex/auth.ts apps/app/convex/authCollabToken.test.ts apps/app/convex/hocuspocusAdmin.ts apps/app/convex/hocuspocusAdmin.test.ts apps/app/convex/hocuspocusAuth.ts apps/app/convex/hocuspocusAuth.test.ts apps/app/convex/orgs.ts apps/app/package.json apps/app/src/lib/authzBoundary.test.ts services/hocuspocus/package.json services/hocuspocus/src/admin.ts services/hocuspocus/src/admin.test.ts services/hocuspocus/src/convex-acl.ts services/hocuspocus/src/convex-acl.test.ts services/hocuspocus/src/hooks.ts services/hocuspocus/src/hooks.test.ts services/hocuspocus/src/server.ts pnpm-lock.yaml docs/development/v2-hocuspocus-persistence.md docs/development/v2-pivot-plan.md docs/development/v2-phase-plans/phase-1.3-convex-acl-bridge.md docs/security/authz-boundaries.md
git commit --no-gpg-sign -m "feat: wire hocuspocus convex acl bridge"
```

Expected: clean commit on `codex/v2-offline-first-phase-0`.
