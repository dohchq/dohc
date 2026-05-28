# v2 Phase 0 Baseline

**Date:** 2026-05-25
**Branch:** `codex/v2-offline-first-phase-0`
**Base commit:** `103a46ff9ef746bc4c82fbcb00bfd07a80c7bae8`
**Worktree:** `/home/ice/.config/superpowers/worktrees/dohc/codex-v2-offline-first-phase-0`

## Commands

| Command | Result | Notes |
|---|---|---|
| `pwd` | pass | Confirmed worktree path. |
| `git status --short --branch` | pass | Branch is `codex/v2-offline-first-phase-0`; docs/fixture files are intentionally untracked during Phase 0 setup. |
| `pnpm install --frozen-lockfile` | pass | Lockfile up to date; installed 615 packages; pnpm warned that `esbuild` build scripts are ignored until approved. |
| `pnpm typecheck` on Node 18.19.1 | pass | Root recursive typecheck completed; `apps/app` ran `tsc --noEmit` successfully. |
| `pnpm test` on Node 18.19.1 | fail | 51 test files passed, 1 failed. 725 tests passed, 1 skipped. Failure is `src/lib/htmlSanitize.test.ts`, caused by `ERR_REQUIRE_ESM` in `html-encoding-sniffer` requiring `@exodus/bytes/encoding-lite.js` through `jsdom`/`isomorphic-dompurify`. |
| `pnpm exec vitest run src/lib/htmlSanitize.test.ts` from `apps/app` on Node 18.19.1 | fail | Focused repro confirmed the same import-time failure before test collection. |
| `pnpm env use --global 24.14.0` | pass | Installed and activated Node 24.14.0 through pnpm env. |
| `pnpm exec vitest run src/lib/htmlSanitize.test.ts` from `apps/app` on Node 24.14.0 | pass | 32 tests passed. |
| `pnpm install --frozen-lockfile` on Node 24.14.0 | pass | Lockfile remained up to date; pnpm adjusted installed packages for the supported runtime. |
| `pnpm typecheck` on Node 24.14.0 | pass | Root recursive typecheck completed successfully. |
| `pnpm test` on Node 24.14.0 | pass | 55 test files passed. 784 tests passed, 1 live eval skipped. |
| `pnpm build` on Node 24.14.0 | pass | Vite + Nitro production build completed successfully. |
| `pnpm lint` on Node 24.14.0 | pass-with-placeholder | Script exits 0, but only prints `lint not configured yet`. |

## Test Failure Detail

`apps/app/src/lib/htmlSanitize.test.ts` fails before collecting tests:

```text
Error: require() of ES Module .../node_modules/@exodus/bytes/encoding-lite.js
from .../node_modules/html-encoding-sniffer/lib/html-encoding-sniffer.js not supported.
```

The stack reaches `apps/app/src/lib/htmlSanitize.ts`, whose top-level server-only sanitizer import pulls in `isomorphic-dompurify`, then `jsdom`, then `html-encoding-sniffer`.

## Root Cause Evidence

- Node: `v18.19.1`.
- `isomorphic-dompurify@3.14.0` depends on `jsdom@29.1.1`.
- `jsdom@29.1.1` depends on `html-encoding-sniffer@6.0.0`.
- `html-encoding-sniffer@6.0.0` depends on `@exodus/bytes@1.15.1`.
- The failing boundary is CommonJS `require()` in `html-encoding-sniffer` trying to load ESM-only `@exodus/bytes/encoding-lite.js`.

## Known Baseline Risks

- Node 18 is not supported by the current sanitizer stack. Root `package.json`, `.node-version`, `.nvmrc`, and `docs/development/local-dev.md` now document the supported Node range.
- `pnpm test` prints expected stderr from some passing Convex scheduler tests and skips the live Anthropic eval without `ANTHROPIC_API_KEY`.
- No CI workflow was found during Phase 0 inventory, so local verification is currently the source of truth.
- `lint` is a placeholder script: `echo 'lint not configured yet'`.
- Playwright is mentioned in planning docs, but no Playwright dependency/script exists yet.
- `pnpm dev` requires real Convex and WorkOS environment values.
