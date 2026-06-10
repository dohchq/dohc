# Dual Backend Tech Debt Audit

Date: 2026-06-09
Phase: Phase 16 - Tech Debt Audit And Deletion Gate

## Summary

The dual-backend branch adds substantial new Postgres, filesystem, app-testing, and sandbox infrastructure, but the debt audit found no untracked migration placeholders after adding `pnpm check:debt`. Convex support remains intentionally retained as the production default. Postgres is documented and verified as development/self-host preview, not production default.

No additional source deletion was safe in Phase 16 beyond the consolidations already completed earlier in the branch. The remaining compatibility paths are still covered by existing tests and have explicit deletion conditions below.

## Code Deleted

- The old chat inline work-trace rendering path was removed in Phase 11. `AgentWorkTrace`, `ToolTraceDetails`, `ToolPayloadBlock`, and the old `agentWorkTraceSummary` helper/test were replaced by `AgentActivityTimeline` plus main-bubble final-answer rendering.
- No Convex backend support was deleted.
- No `.views` compatibility code was deleted because views discovery/source editing tests still cover existing data and workflows.

## Code Consolidated

- Workspace backend operations are consolidated behind `@dohc/workspace-contracts`.
- Convex and Postgres are both exercised through the shared backend conformance harness.
- Postgres atom, asset, app, database, data-import, and event behavior is grouped under `packages/workspace-postgres`.
- Filesystem projection, diff scan, diff apply, local sync, and shell mount behavior share `@dohc/workspace-fs`.
- Agent shell execution and diff capture share `@dohc/agent-sandbox`.
- Frontend file operations are routed through `apps/app/src/backend/*` instead of scattering backend-mode decisions through UI components.
- App database table operations now use explicit `dohc.database.table.*` SDK protocol operations instead of overloaded collection operations.

## Compatibility Code Retained

- `apps/app/convex/*`: retained because Convex is still the production-safe default and current deployed data/runtime behavior depends on it.
- `packages/workspace-convex-compat`: retained because it proves Convex behavior against the backend contract while Postgres matures.
- `.views` discovery/runtime code: retained for existing view packages and source editing. It can be deleted only when `.apps` migration behavior and indexed package discovery fully replace it.
- Convex route hooks in `apps/app/src/routes/_app.tsx`: retained because Convex remains the default mode; only `DOHC_BACKEND=postgres` switches common file flows to the Postgres client.
- App/runtime trust and review-gate Convex paths: retained until Postgres proves equivalent deployed auth/session, app trust, and review-gate behavior.
- Existing historical implementation plans under `docs/superpowers/plans`: retained as branch provenance. The debt checker allowlists exact historical marker text with deletion conditions.

## Tests Proving Retained Code Is Needed

- `pnpm check:dual-backend-baseline` proves Convex app/backend/security/collaboration behavior remains required and green.
- `pnpm --filter @dohc/workspace-convex-compat test` proves Convex still maps to the shared backend contract.
- `pnpm --filter @dohc/web test src/__tests__/backendSwitch.test.tsx` proves Convex remains the default while Postgres is selected only by config.
- `pnpm --filter @dohc/web test convex/appSecurity.test.ts convex/appTrust.test.ts convex/agentApprovals.test.ts` is included in the baseline and continues to cover Convex trust/review gates.
- `pnpm --filter @dohc/web test src/__tests__/viewsShell.test.ts src/__tests__/viewSourceEditing.test.ts` is included in the baseline and covers retained `.views` behavior.
- `DOHC_BACKEND=convex pnpm test:e2e apps/app/e2e/backendMatrix.spec.ts` and `DOHC_BACKEND=postgres pnpm test:e2e apps/app/e2e/backendMatrix.spec.ts` prove the same finance-tracker workflow can run in both backend modes.

## Known Debt And Deletion Conditions

- `docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.md`: quoted debt-marker terms are allowed only because they define the active Phase 16 scan. Delete the allowlist entry when the plan is archived or removed.
- `docs/superpowers/plans/2026-06-06-dohc-apps-sdk-sqlite-and-agent-testing.md`: historical placeholder-scan text is allowed. Delete the allowlist entry when historical plans move out of repo-wide debt scans.
- `apps/app/convex/confirmTier.ts`: the comment says the helper is wired and reviewed, not obsolete. Delete the allowlist entry if confirm-tier policy moves into a shared package.
- `apps/app/convex/views.ts`: the bounded workspace scan remains until a prefix-aware view index replaces it. Delete after indexed view package discovery exists and views regression tests cover the replacement.
- `apps/app/convex/entities.ts`: the mode-specific unreachable-branch comment remains until entity create/update helpers are split.

## Commands Run

- `pnpm check:debt` before Phase 16: failed because the command did not exist.
- `pnpm check:debt` after adding the script: failed until generated/temp paths and checker self-matches were excluded.
- `pnpm check:debt`: passed with 7 documented allowlist entries.
- `pnpm -r --if-present typecheck`: passed.
- `git diff --stat main...HEAD`: reviewed branch-wide touched areas.
- `git diff --name-status main...HEAD`: reviewed added/modified/deleted areas.

## Remaining Risk

- The debt checker is intentionally phrase-based. It catches explicit migration placeholders, not semantic duplication.
- Postgres remains development/self-host preview, not production default.
- `.views` compatibility remains until indexed discovery and app migration coverage make deletion safe.
- Historical plan documents still require narrow allowlist entries while they live inside the repo scan scope.
