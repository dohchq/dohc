# Phase 1.9 V1 Cleanup + Final QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the old Milkdown/Crepe and Convex prosemirror-sync collaboration stack so the repo has one v2 document architecture.

## Tasks

- [x] Remove `@convex-dev/prosemirror-sync` from app dependencies and Convex component config.
- [x] Delete v1 collaboration modules:
  - `collabBootstrap`
  - `collabPresence`
  - `collabProjection`
  - `collabProjectionSerializer`
  - `prosemirror`
  - `pmToMdast`
  - `markdownRoundtrip`
  - `atomWriter`
- [x] Delete orphaned client Milkdown/Crepe helpers:
  - `collab-sync.ts`
  - `crepe-schema-cache.ts`
- [x] Drop `collabDocs` and `collabSessions` schema tables.
- [x] Remove the old collab presence cron and FileTree Convex presence query.
- [x] Delete v1-only tests whose subject no longer exists.
- [x] Regenerate Convex API bindings.
- [x] Verify no active app/generated/manifest/lockfile references remain for Milkdown, Crepe, prosemirror-sync, `collabDocs`, or `collabSessions`.
- [x] Repair workspace/authz tripwires uncovered by the broad app suite.

## Verification

Focused cleanup checks:

```bash
rg -n "@convex-dev/prosemirror-sync|collabPresence|collabDocs|collabSessions|collabBootstrap|collabProjection|prosemirrorSync|pmToMdast|markdownRoundtrip|collab-sync|crepe-schema-cache|@milkdown|Milkdown|Crepe|atomWriter" apps/app package.json pnpm-lock.yaml -S
pnpm --filter @dohc/app exec convex codegen
pnpm --filter @dohc/app run typecheck
pnpm --filter @dohc/app exec vitest run src/__tests__/activeWorkspaceWires.test.ts src/lib/authzBoundary.test.ts convex/phaseBC.test.ts
```

Final branch checks before merge:

```bash
pnpm --filter @dohc/hocuspocus run test
pnpm --filter @dohc/app run test
pnpm --filter @dohc/hocuspocus run typecheck
pnpm --filter @dohc/app run typecheck
```

## Rollback Notes

- This is not a soft rollback phase. If v1 collaboration code is needed again, restore it from git history onto a separate branch.
- Keep generated API bindings in sync with deleted Convex modules.
- A one-week dogfood gate and staging QA are still required before calling v2 shipped on `main`.
