# Phase 1.3 Live Provider Crash Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the Hocuspocus persistence foundation with a raw provider, real Postgres, restart replay, and fail-loud persistence behavior.

**Architecture:** Keep live provider tests out of the default unit suite. Add an explicit `test:integration` command that refuses to run without `HOCUSPOCUS_TEST_DATABASE_URL`, starts the Hocuspocus server on a random port, connects raw `@hocuspocus/provider` clients, writes through Yjs, restarts the server, and verifies replay from Postgres. Add local Docker Compose Postgres wiring for developers who have Docker enabled.

**Tech Stack:** `@hocuspocus/provider`, `@hocuspocus/server`, Yjs, Vitest, Postgres via `pg`, Docker Compose for local Postgres.

---

## File Structure

- Create: `docker-compose.dev.yml` — local Postgres for v2 integration work.
- Modify: `package.json` — root integration helper script.
- Modify: `services/hocuspocus/package.json` — service integration script.
- Create: `services/hocuspocus/vitest.integration.config.ts` — explicit `.integration.ts` discovery without adding the file to the normal unit suite.
- Create: `services/hocuspocus/scripts/require-integration-env.mjs` — fail if no real Postgres URL is provided.
- Create: `services/hocuspocus/src/integration/live-provider-crash.integration.ts` — raw provider integration tests.
- Create: `services/hocuspocus/Dockerfile` — production container image for the Hocuspocus service.
- Create: `.dockerignore` — keep local dependencies/build output out of Docker context.
- Modify: `services/hocuspocus/src/server.ts` — close the Postgres pool on server destroy.
- Modify: `docker-compose.dev.yml` — local Postgres plus Hocuspocus service wiring.
- Modify: `docs/development/v2-hocuspocus-persistence.md` — document how to run the crash gate.

---

### Task 1: Add Integration Harness

- [x] **Step 1: Add scripts and Docker Compose**

Add:

```bash
pnpm test:hocuspocus:integration
pnpm --filter @dohc/hocuspocus run test:integration
```

Expected: both commands require `HOCUSPOCUS_TEST_DATABASE_URL`.

- [x] **Step 2: Add local Postgres compose file**

Add `docker-compose.dev.yml` with a `postgres` service using container name `dohc-v2-postgres` on host port `54329`.

Expected URL:

```bash
postgres://dohc:dohc@127.0.0.1:54329/dohc_v2
```

---

### Task 2: Add Raw Provider Crash Tests

- [x] **Step 1: Write live integration tests**

Cover:

- raw provider authenticates with a 5-minute collab token
- provider writes text through Hocuspocus into Postgres
- server restart reloads the document from snapshot/update log
- broken persistence table causes the provider connection to close and leaves the update unacked

- [x] **Step 2: Keep normal tests hermetic**

Use `.integration.ts` extension so the default Vitest include pattern does not run this file.

---

### Task 3: Verify What Can Run Locally

- [x] **Step 1: Verify unit gates still run**

Run:

```bash
pnpm --filter @dohc/hocuspocus test
pnpm --filter @dohc/hocuspocus typecheck
pnpm --filter @dohc/hocuspocus build
```

Expected: all pass without a database.

- [x] **Step 2: Run live integration gate**

Run with a real Postgres URL:

```bash
HOCUSPOCUS_TEST_DATABASE_URL=postgres://dohc:dohc@127.0.0.1:54329/dohc_v2 pnpm test:hocuspocus:integration
```

Expected: restart replay and fail-loud tests pass.

Observed: passed locally against Docker Postgres after adding the integration-only Vitest config and making Hocuspocus pool shutdown idempotent.

---

### Task 4: Add Hocuspocus Container Wiring

- [x] **Step 1: Add service Dockerfile**

Add `services/hocuspocus/Dockerfile` using the root pnpm workspace lockfile, build the service, and run `node dist/server.js`.

- [x] **Step 2: Wire local compose service**

Extend `docker-compose.dev.yml` with a `hocuspocus` service that depends on healthy Postgres and exposes port `1234`.

- [x] **Step 3: Verify image build and service boot**

Run:

```bash
docker compose -f docker-compose.dev.yml build hocuspocus
docker compose -f docker-compose.dev.yml up -d hocuspocus
docker compose -f docker-compose.dev.yml ps
```

Expected: Postgres and Hocuspocus both healthy/running locally.

Observed: Docker image builds, Hocuspocus boots, and `/healthz` reports healthy through the compose healthcheck.
