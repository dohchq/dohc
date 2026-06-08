# Dual Backend, Filesystem, And Agent Runtime Execution Log

## Baseline

- Branch: `codex/dual-backend-filesystem-agent-runtime`
- Base commit: `dca4670`
- Convex baseline command: `pnpm check:dual-backend-baseline`
- Convex baseline result: pass with `PATH=/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH`
- Postgres baseline command: not available before Phase 3
- Postgres baseline result: not started; Postgres package does not exist before Phase 3
- Current phase: Phase 3 - Postgres Service Scaffold
- Current step: not started
- Last successful commit: Phase 2 commit, `Add workspace backend conformance harness`
- Last failing command: `npm exec --yes pnpm@10.24.0 -- check:dual-backend-baseline` under `/usr/bin/node` v18.19.1
- Last blocker: none

## Phase Logs

### Phase 0: Baseline Lock And Migration Guardrails

- Status: complete
- Files changed:
  - `apps/app/src/components/WorkspaceManagementDialog.tsx`
  - `apps/app/src/components/WorkspaceSwitcher.tsx`
  - `apps/app/src/router.tsx`
  - `apps/app/src/routes/__root.tsx`
  - `apps/app/src/routes/_app.tsx`
  - `docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.md`
  - `docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md`
  - `package.json`
  - `scripts/check-dual-backend-baseline.mjs`
- Code deleted or consolidated: none
- Obsolete paths retained and why: Convex remains the default backend while the Postgres path is built beside it.
- Tests added: none; this phase adds a baseline command that runs existing suites.
- Commands run:
  - `git fetch --all --prune`
  - `git merge-base --is-ancestor origin/codex/apps-sdk-sqlite-agent-testing origin/main; printf 'ancestor_exit=%s\n' "$?"`
  - `git checkout -b codex/dual-backend-filesystem-agent-runtime origin/main`
  - `pnpm check:dual-backend-baseline` (failed: `pnpm` not on default PATH)
  - `npm exec --yes pnpm@10.24.0 -- --filter @dohc/web typecheck` (failed before route typing fix)
  - `npm exec --yes pnpm@10.24.0 -- --filter @dohc/web typecheck` (passed after route typing fix; Node 18 warning only)
  - `npm exec --yes pnpm@10.24.0 -- check:dual-backend-baseline` (failed under Node 18: `node:sqlite` unavailable and sanitizer dependency CJS/ESM error)
  - `PATH=/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH pnpm check:dual-backend-baseline` (passed)
- Failing tests fixed: fixed pre-existing TanStack Router type errors by using params reducer functions and explicit router/root route types.
- Cross-cutting regressions run: `pnpm check:dual-backend-baseline`
- Convex status: pass; `@dohc/web` typecheck and 189 web test files passed under Node 22.13.0.
- Postgres status: not started
- Reviewer/subagent/CodeRabbit findings: none
- Relevant findings fixed: none
- Deferred findings with reason: none
- Remaining risk: baseline requires Node 20.19+/22.13+/24+; default shell currently exposes Node 18, so commands in this session should use the Node 22 PATH prefix until the shell profile is fixed.
- Next phase: Phase 1 - Shared Workspace Contract

### Phase 1: Shared Workspace Contract

- Status: complete
- Execution map: add a new `packages/workspace-contracts` package under the existing `packages/*` workspace glob; define only shared domain validators, backend port types, event types, and path-safety tests. No Convex or app runtime behavior changes in this phase.
- Files changed:
  - `packages/workspace-contracts/package.json`
  - `packages/workspace-contracts/tsconfig.json`
  - `packages/workspace-contracts/src/backend.test.ts`
  - `packages/workspace-contracts/src/backend.ts`
  - `packages/workspace-contracts/src/domain.ts`
  - `packages/workspace-contracts/src/errors.ts`
  - `packages/workspace-contracts/src/events.ts`
  - `packages/workspace-contracts/src/index.ts`
  - `pnpm-lock.yaml`
- Code deleted or consolidated: none; this phase creates the shared contract surface that later phases consolidate around.
- Obsolete paths retained and why: existing Convex domain shapes remain untouched until the compatibility adapter and conformance harness prove parity.
- Tests added: `packages/workspace-contracts/src/backend.test.ts`
- Commands run:
  - `PATH=/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH pnpm --filter @dohc/workspace-contracts test` (RED: failed to load missing `./domain`)
  - `PATH=/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH pnpm --filter @dohc/workspace-contracts test` (passed: 1 file, 3 tests)
  - `PATH=/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH pnpm --filter @dohc/workspace-contracts typecheck` (passed)
  - `PATH=/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH pnpm install --lockfile-only` (passed; existing app peer warnings only)
  - `PATH=/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH pnpm --filter @dohc/workspace-contracts test` (passed after lockfile update)
  - `PATH=/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH pnpm --filter @dohc/workspace-contracts typecheck` (passed after lockfile update)
- Failing tests fixed: path-safety test now passes by implementing `WorkspacePath`.
- Cross-cutting regressions run: not required; this phase only adds a standalone shared package and does not touch auth, agents, apps, assets, SQLite, filesystem sync, shell sandboxing, sharing, or permissions behavior.
- Convex status: preserved; no Convex code touched after Phase 0 baseline.
- Postgres status: not started
- Reviewer/subagent/CodeRabbit findings: none
- Relevant findings fixed: none
- Deferred findings with reason: none
- Remaining risk: contract is intentionally minimal until Phase 2 conformance cases and backend adapters exercise it.
- Next phase: Phase 2 - Shared Conformance Harness

### Phase 2: Shared Conformance Harness

- Status: complete
- Execution map: add the reusable `WorkspaceBackendTestAdapter`, exported `runWorkspaceBackendConformance` cases, and a small in-memory harness self-test in the contracts package so the conformance function is exercised before real Convex/Postgres adapters import it.
- Files changed:
  - `packages/workspace-contracts/src/testHarness.ts`
  - `packages/workspace-contracts/src/conformance.ts`
  - `packages/workspace-contracts/src/conformance.test.ts`
  - `packages/workspace-contracts/src/index.ts`
- Code deleted or consolidated: moved reusable conformance logic out of a collected test-only module shape and into `conformance.ts`; the collected `conformance.test.ts` now only self-tests the harness with an in-memory adapter.
- Obsolete paths retained and why: existing backend-specific tests remain in place until the Convex/Postgres adapters run through this shared conformance surface.
- Tests added: `packages/workspace-contracts/src/conformance.test.ts`
- Commands run:
  - `PATH=/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH pnpm --filter @dohc/workspace-contracts test` (RED: missing `./conformance.test`)
  - `PATH=/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH pnpm --filter @dohc/workspace-contracts test` (failed: Vitest collected helper-only `conformance.test.ts` with no tests)
  - `PATH=/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH pnpm --filter @dohc/workspace-contracts test` (passed: 2 files, 6 tests)
  - `PATH=/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH pnpm --filter @dohc/workspace-contracts typecheck` (passed)
- Failing tests fixed: implemented the conformance harness and corrected the helper/test file split so Vitest has real tests to collect.
- Cross-cutting regressions run: not required; this phase only adds contract-level tests.
- Convex status: preserved; no Convex code touched in this phase.
- Postgres status: not started
- Reviewer/subagent/CodeRabbit findings: none
- Relevant findings fixed: none
- Deferred findings with reason: none
- Remaining risk: real backend adapters have not yet implemented the contract, so the harness is currently validated only by the memory self-test.
- Next phase: Phase 3 - Postgres Service Scaffold
