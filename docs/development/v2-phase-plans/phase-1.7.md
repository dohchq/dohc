# Phase 1.7 Y.RelativePosition Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move suggestion anchors from markdown offsets to Y.RelativePosition so suggestions survive concurrent Y.Doc edits and refuse stale semantic intent.

**Architecture:** Hocuspocus owns Y.Doc-relative anchor resolution and replacement. Convex stores encoded anchors and semantic witnesses. Accept/reject state stays in Convex; document mutation happens through Hocuspocus semantic operations.

---

## File Structure

- Create: `services/hocuspocus/src/suggestions.ts` — relative-position encode/decode, text-range helpers, stale-intent validation, replacement apply.
- Create: `services/hocuspocus/src/suggestions.test.ts` — anchor survival/stale/needs-review tests.
- Modify: `services/hocuspocus/src/import-export.ts` — export schema/body helpers used by suggestion operations.
- Modify: `services/hocuspocus/package.json` / `pnpm-lock.yaml` — add direct `@tiptap/pm` dependency for ProseMirror model primitives.
- Modify: `apps/app/convex/schema.ts` — add `anchorStart`, `anchorEnd`, witness diagnostics, and v2 statuses.
- Modify: `apps/app/convex/atomSuggestions.ts` — create/list/reject v2 anchor shape and remove raw body-splice acceptance path.
- Create: `apps/app/convex/v2AtomSuggestions.test.ts` — Convex CRUD tests for v2 suggestion rows.

## Task 1: Hocuspocus RelativePosition Primitives

- [x] **Step 1: Write failing service tests**

Cover:
- anchors encode/decode through concurrent inserts before the range.
- stale text at the resolved anchor returns `stale-intent`.
- prefix/suffix match with changed exact text returns `needs-review`.
- valid replacement mutates the Y.Doc body.

Run:

```bash
pnpm --filter @dohc/hocuspocus exec vitest run src/suggestions.test.ts
```

Expected before implementation: fails because `suggestions.ts` does not exist.

- [x] **Step 2: Implement relative-position helpers**

Use `initProseMirrorDoc`, `absolutePositionToRelativePosition`, and `relativePositionToAbsolutePosition` against the `body` Y.XmlFragment. Keep replacements constrained to text surfaces for now.

Run service tests until green.

## Task 2: Convex V2 Suggestion Rows

- [x] **Step 1: Write failing Convex tests**

Cover:
- `_createSuggestion` stores `anchorStart`/`anchorEnd` and optional witness diagnostics.
- `listPending` returns anchors, not markdown offsets.
- reject remains Convex-only and preserves audit fields.

Run:

```bash
pnpm --filter @dohc/app exec vitest run convex/v2AtomSuggestions.test.ts
```

Expected before implementation: fails because schema/functions still use `rangeFrom`/`rangeTo`.

- [x] **Step 2: Implement schema + CRUD**

Make legacy offset columns optional/deprecated, add anchor fields, keep `expectedText`, and add `expectedPrefix`, `expectedSuffix`, `createdFromProjectionHash`, `stale`, and `needs-review` statuses.

Run Convex tests until green.

## Task 3: Disable Raw Markdown Accept

- [x] **Step 1: Write failing accept test**

Prove `acceptSuggestion` no longer patches `atoms.body` directly.

- [x] **Step 2: Disable raw accept pending the Hocuspocus-backed path**

Accept should call the semantic operation introduced here/expanded in Phase 1.8, then patch suggestion status from the structured result. Until the HTTP route is fully wired, raw `atoms.body` splice must remain disabled.

## Verification

- [x] Hocuspocus suggestion tests pass.
- [x] Convex v2 suggestion CRUD tests pass.
- [x] Hocuspocus typecheck passes.
- [x] App typecheck passes after Phase 1.9 legacy cleanup.

## Rollback Notes

- Existing legacy suggestions can be invalidated; there are no important in-flight user suggestions.
- The old `rangeFrom`/`rangeTo` fields remain optional only until Phase 1.9 cleanup deletes v1 tests and UI code.
