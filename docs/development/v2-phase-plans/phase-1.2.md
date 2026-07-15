# Phase 1.2 Markdown Import/Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first executable markdown import/export foundation: legacy markdown enters v2 as structured frontmatter + a Tiptap/Yjs `Y.XmlFragment` body + Y.Doc update bytes, and can be exported back to deterministic markdown.

**Architecture:** This phase uses Tiptap's OSS `@tiptap/markdown` `MarkdownManager` for body parse/serialize, Tiptap's schema as the ProseMirror contract, and `y-prosemirror` to initialize the canonical `body` `Y.XmlFragment`. It does not mount the editor UI, start Hocuspocus, or make `atoms.body` derived at runtime yet.

**Tech Stack:** `@tiptap/markdown`, `@tiptap/starter-kit`, Tiptap table extensions, Yjs, `y-prosemirror`, Vitest, existing markdown fixtures.

---

## File Structure

- Create: `apps/app/src/editor-v2/dohc-markdown-extensions.ts` — OSS Tiptap markdown nodes/tokenizers for first-class dohc syntax.
- Create: `apps/app/src/editor-v2/import-export.ts` — markdown/Y.Doc import-export helpers.
- Create: `apps/app/src/editor-v2/import-export.test.ts` — fixture and frontmatter round-trip tests.
- Modify: `apps/app/package.json`, `pnpm-lock.yaml` — add OSS Tiptap/Yjs dependencies only.
- Modify: `docs/development/v2-phase-plans/phase-1.2.md` — track execution.
- Modify: `docs/development/v2-pivot-plan.md` — update status after verification.

---

### Task 1: Add Failing Import/Export Tests

**Files:**
- Create: `apps/app/src/editor-v2/import-export.test.ts`

- [x] **Step 1: Write failing tests**

Create tests for:

- frontmatter is stored outside body and exported back
- round-trip output is idempotent for every `tests/fixtures/markdown-corpus/*.md`
- custom dohc syntax tokens survive the first import/export foundation
- custom dohc syntax imports as first-class Tiptap nodes, not anonymous text
- exported update bytes can hydrate a fresh Y.Doc

- [x] **Step 2: Run focused test to verify red**

Run:

```bash
pnpm --filter @dohc/app exec vitest run src/editor-v2/import-export.test.ts
```

Actual: failed because `./import-export` did not exist.

---

### Task 2: Install OSS Dependencies

**Files:**
- Modify: `apps/app/package.json`
- Modify: `pnpm-lock.yaml`

- [x] **Step 1: Add dependencies**

Run:

```bash
pnpm --filter @dohc/app add @tiptap/core @tiptap/starter-kit @tiptap/markdown @tiptap/extension-table @tiptap/extension-table-row @tiptap/extension-table-cell @tiptap/extension-table-header yjs y-prosemirror
```

Actual: package install succeeded and no `@tiptap-pro/*`, Tiptap AI Toolkit, Comments, or Tracked Changes packages were added.

- [x] **Step 2: Verify paid package guardrail**

Run:

```bash
rg -n "@tiptap-pro|tiptap-pro|tiptap-ai|@tiptap/extension-ai|tracked-changes|@tiptap-pro/extension-comments" package.json pnpm-lock.yaml apps packages
```

Actual: no dependency hits.

---

### Task 3: Implement Import/Export Foundation

**Files:**
- Create: `apps/app/src/editor-v2/import-export.ts`

- [x] **Step 1: Implement helpers**

Implement:

- `markdownToYDoc(markdown: string): Y.Doc`
- `yDocToMarkdown(doc: Y.Doc): string`
- `roundTripMarkdown(markdown: string): string`
- `encodeDohcYDocUpdate(doc: Y.Doc): Uint8Array`
- `applyDohcYDocUpdate(update: Uint8Array): Y.Doc`
- `getDohcYDocFrontmatter(doc: Y.Doc): Record<string, unknown>`
- `getDohcYDocMeta(doc: Y.Doc): { schemaVersion: number }`
- `getDohcYDocBodyJSON(doc: Y.Doc): JSONContent`

Design:

- `frontmatter` Y.Map stores parsed YAML metadata.
- `meta` Y.Map stores `schemaVersion: 1`.
- `body` Y.XmlFragment stores the canonical ProseMirror tree, initialized through `y-prosemirror`.
- `wikilink` and `inlineAtom` import as dohc-owned Tiptap nodes through OSS markdown tokenizers/renderers.
- `yDocToMarkdown` serializes the `Y.XmlFragment` back through the Tiptap schema and `MarkdownManager`, then prepends deterministic YAML frontmatter.

- [x] **Step 2: Run focused test**

Run:

```bash
pnpm --filter @dohc/app exec vitest run src/editor-v2/import-export.test.ts
```

Actual: pass — 11 tests passed.

---

### Task 4: Verify Phase 1.2

**Files:**
- Modify: `docs/development/v2-pivot-plan.md`
- Modify: `docs/development/v2-phase-plans/phase-1.2.md`

- [x] **Step 1: Run full verification**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Actual: all pass on Node 24.14.0.

- [x] **Step 2: Update pivot plan status**

If verification passes, update `docs/development/v2-pivot-plan.md` status to:

```markdown
**Status:** Plan v1.6 — Phase 1.2 import/export foundation complete; ready for Hocuspocus persistence spike
```

- [x] **Step 3: Commit**

Run:

```bash
git add apps/app/package.json pnpm-lock.yaml apps/app/src/editor-v2/dohc-markdown-extensions.ts apps/app/src/editor-v2/import-export.ts apps/app/src/editor-v2/import-export.test.ts docs/development/v2-phase-plans/phase-1.2.md docs/development/v2-pivot-plan.md
git commit --no-gpg-sign -m "feat: add v2 markdown import export foundation"
```
