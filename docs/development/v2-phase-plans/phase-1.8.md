# Phase 1.8 Agent Semantic API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move agent-authored document edits onto Hocuspocus semantic operations so Y.Doc remains canonical and `atoms.body` remains a projection cache.

**Architecture:** Convex keeps orchestration, auth context, suggestions, and tool definitions. Hocuspocus owns semantic document mutation, update durability, idempotent retries, and live Y.Doc application.

## Tasks

- [x] Add Hocuspocus semantic routes:
  - `POST /apply/replaceRange`
  - `POST /apply/insertText`
  - `POST /apply/insertAfterHeading`
  - `POST /apply/createAnchorsForText`
  - `POST /apply/createAtom`
- [x] Recheck write ACLs on semantic edits before mutating Y.Doc.
- [x] Make operation retries idempotent through operation keys scoped to the document or create path.
- [x] Persist successful semantic edit updates before applying them to live Hocuspocus docs.
- [x] Store audit metadata in semantic operation responses: operation, workspace, atom/path, actor, anchor summary, and timestamp.
- [x] Route `acceptSuggestion` through `/apply/replaceRange`; do not splice `atoms.body`.
- [x] Replace active agent write tools with semantic tools:
  - `create_atom`
  - `propose_replace_text`
  - `insert_after_heading`
  - `rewrite_section` (routes substantial rewrites through reviewed suggestions)
- [x] Retire `write_atom` and `suggest_in_doc` as always-refusing v1 tools.
- [x] Route brand-new atom creation and `save_skill` through Hocuspocus semantic create so canonical Y.Doc state is initialized.

## Verification

Focused checks:

```bash
pnpm --filter @dohc/hocuspocus exec vitest run src/semantic-api.test.ts src/persistence.test.ts src/convex-acl.test.ts
pnpm --filter @dohc/hocuspocus run typecheck
pnpm --filter @dohc/app exec vitest run convex/v2AtomSuggestions.test.ts convex/hocuspocusAuth.test.ts convex/p1AgentWriteAccess.test.ts src/__tests__/prepareStep.test.ts src/__tests__/skillTurnGateApplied.test.ts
pnpm --filter @dohc/app run typecheck
```

## Rollback Notes

- Keep `write_atom` retired even during rollback; reintroducing a full-body agent overwrite reopens parser-drift and lost-merge risks.
- If semantic API deployment fails, suggestion accept should fail closed and leave rows pending/stale rather than falling back to markdown splicing.
- `atoms.body` can be rebuilt from Y.Doc projection after recovery.
