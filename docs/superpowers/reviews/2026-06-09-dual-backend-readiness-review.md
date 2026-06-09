# Dual Backend Readiness Review

Date: 2026-06-09
Phase: Phase 15 - End-To-End Comparison Gate

## Verdict

Convex remains the production-safe default. Postgres is ready for development and self-host preview work, with shared conformance, app/SQLite service tests, frontend backend switching, filesystem projection, and sandbox inspection all passing. Postgres is not yet production-ready because realtime collaboration, operational hardening, migration strategy, cloud deployment automation, and production observability are not proven end to end.

The backend matrix now runs the same Playwright flow in both modes:

1. create a workspace.
2. upload wallet CSV data.
3. ask an agent to build a finance tracker.
4. import transactions into durable source-backed state.
5. create `finance/.apps/ledger` source files.
6. run app tester against the generated app.
7. open the app runtime.
8. edit a transaction category.
9. reload and preserve the edit.
10. show the permitted collaborator view.
11. deny an unauthorized viewer.
12. materialize local filesystem files.
13. run the workspace shell with `rg`, `cat`, and a proposed diff.

This is a deterministic comparison gate. It proves that the same user-visible workspace and agent-runtime flow can be exercised in both backend modes. It does not prove full hosted auth, production Convex deployment, production Postgres deployment, or live multi-user Yjs behavior.

## Evidence

- `pnpm check:dual-backend-baseline`: passed after fixing a pre-existing search-index audit failure in the generated-file atom writer.
- `pnpm --filter @dohc/workspace-contracts test`: passed.
- `pnpm --filter @dohc/workspace-postgres test`: passed.
- `pnpm --filter @dohc/workspace-convex-compat test`: passed.
- `pnpm --filter @dohc/workspace-fs test`: passed.
- `pnpm --filter @dohc/workspace-api test`: passed.
- `pnpm --filter @dohc/agent-sandbox test`: passed.
- `DOHC_BACKEND=convex pnpm test:e2e apps/app/e2e/backendMatrix.spec.ts`: passed.
- `DOHC_BACKEND=postgres pnpm test:e2e apps/app/e2e/backendMatrix.spec.ts`: passed.
- `pnpm check:debt`: failed because the script does not exist yet; Phase 16 owns this audit.
- `git diff --check`: passed.

## Answers

**Is Convex still production-safe?**

Yes. Convex remains the default backend, the full dual-backend baseline is green, and the matrix confirms the finance tracker flow still passes in Convex mode. The Phase 15 fix also tightened Convex by making generated-file atom inserts derive search fields while preserving CSV/TXT/JSON body fidelity.

**Is Postgres ready for development mode?**

Yes. Postgres passes the shared workspace conformance suite, app and SQLite service tests, workspace API tests, frontend backend-switch tests through the baseline, and the Playwright backend matrix. It is reasonable to use Postgres for local development, self-host preview, and continued parity work.

**Is Postgres ready for production mode?**

No. The current evidence is enough for development mode, not production. Remaining production gates include live collaboration parity, durable hosted object-storage behavior under load, operational migrations, backup/restore drills, auth/session integration in deployed environments, app trust and review-gate parity under real user sessions, and cloud observability.

**Which flows are equivalent?**

Workspace file listing, text reads/writes, uploads, generated text files, app discovery, source-backed app tests, SQLite-backed app/database operations, local filesystem projection, shell inspection/diff capture, and the finance tracker matrix are equivalent enough to keep building against both modes.

**Which flows are better on Postgres?**

Self-hosting shape, boring infrastructure, SQL-backed database operations, deterministic local reset, filesystem projection, and shell-based agent workflows are clearer on the Postgres path. It is easier to explain and operate for local/self-hosted deployments.

**Which flows still depend on Convex?**

Production app hosting remains Convex-first. Realtime collaboration, deployed auth behavior, existing workspace data, Convex action/mutation flows, current production-grade app trust enforcement, and many mature security/collaboration tests still depend on Convex as the source of truth.

**Can dohc Cloud be built on the Postgres path?**

Yes, but not as an immediate backend switch. The Postgres path has the right shape for dohc Cloud: shared contracts, SQL metadata, object storage, workspace API, Hocuspocus, app tester, sqlite worker, and sandbox service boundaries. It still needs production deployment work before becoming the cloud default.

**Can self-hosting be documented honestly?**

Yes. The self-hosting docs can say Postgres mode is a development/self-host preview with deterministic preflight checks and compose wiring. They should not claim production readiness yet.

## Remaining Gaps

- Add and pass `pnpm check:debt` in Phase 16.
- Run the matrix against a real hosted Postgres workspace API, not only deterministic fixtures and package services.
- Prove Hocuspocus/Yjs realtime collaboration over Postgres in browser e2e.
- Add production migration, backup, restore, and observability checks.
- Decide deletion conditions for retained Convex compatibility paths after Phase 16's debt review.
