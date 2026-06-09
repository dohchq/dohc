# Backend Modes

dohc currently supports two backend modes during the migration to a
self-hostable core.

## Convex Mode

Convex remains the production baseline. It continues to own the current app
server functions, auth-derived workspace scoping, sharing boundaries, app trust
checks, locks, review gates, and agent approval behavior.

Use Convex mode when:

- running the current hosted app.
- validating compatibility with existing workspaces.
- testing behavior that still lives in `apps/app/convex`.

Frontend default:

```bash
DOHC_BACKEND=convex
```

If no backend mode is set, the app defaults to Convex.

## Postgres Mode

Postgres is the candidate core for self-hosted and cloud-hosted dohc. The goal
is not to remove Convex early. The goal is to prove that the same workspace
contract can be served by a durable SQL backend, object storage, Hocuspocus,
SQLite services, app testing, and agent sandbox tooling.

Use Postgres mode when:

- testing self-host packaging.
- validating local file sync and filesystem projection.
- proving backend-neutral app and SQLite behavior.
- preparing cloud deployments that should not depend on Convex.

Frontend switch:

```bash
DOHC_BACKEND=postgres
VITE_DOHC_BACKEND=postgres
```

`DOHC_BACKEND` is server/configuration controlled. Browser URL query strings
must not change backend mode.

## Readiness

Readiness is decided by shared tests, not confidence:

- `@dohc/workspace-contracts` defines the common backend contract.
- `@dohc/workspace-postgres` implements the Postgres adapter and service
  tests.
- `@dohc/workspace-convex-compat` proves Convex compatibility against shared
  conformance cases.
- AppTester and future Playwright backend matrix tests compare user flows
  across modes.

Until the readiness gate passes, Convex remains supported and Postgres remains
the migration candidate.

## Environment Variables

Core mode variables:

```bash
DOHC_BACKEND=convex|postgres
VITE_DOHC_BACKEND=convex|postgres
POSTGRES_URL=postgres://...
WORKSPACE_API_BASE_URL=http://127.0.0.1:1786
HOCUSPOCUS_ADMIN_TOKEN=...
HOCUSPOCUS_JWT_SECRET=...
SQLITE_WORKER_TOKEN=...
APP_TESTER_TOKEN=...
```

Security rule: client callers never provide user identity or workspace
authorization. Backend services derive actor identity server-side and scope
every operation to a workspace.
