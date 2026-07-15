# Phase 1.1 Schema Specification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define dohc v2's canonical document model before any editor swap: Y.Doc field shape, markdown-expressible construct list, extension contracts, schema versioning, and stop/go risks.

**Architecture:** Phase 1.1 creates docs and compile-only TypeScript contracts. It does not mount Tiptap, install Hocuspocus, migrate data, or change runtime editing behavior.

**Tech Stack:** TypeScript, Vitest, Tiptap OSS design contracts, Y.Doc/Y.XmlFragment design, markdown projection fixtures.

---

## Source References

- Tiptap Markdown is currently Beta and supports extension-level `parseMarkdown`, `renderMarkdown`, and custom tokenizers.
- Tiptap collaboration can bind to a raw Yjs fragment such as `new Y.Doc().getXmlFragment('body')`.
- Yjs `Y.XmlFragment` is a shared collection of XML nodes and can live as a top-level type inside a Y.Doc.

## File Structure

- Create: `docs/development/v2-schema-spec.md` — canonical schema spec and stop/go decisions.
- Create: `apps/app/src/editor-v2/schema-contracts.ts` — compile-only schema metadata and extension contract types.
- Create: `apps/app/src/editor-v2/schema-contracts.test.ts` — coverage for required constructs and OSS-only guardrails.
- Modify: `docs/development/v2-phase-plans/phase-1.1.md` — track completion.
- Modify: `docs/development/v2-pivot-plan.md` — update status after Phase 1.1 verification passes.

---

### Task 1: Add Failing Schema Contract Tests

**Files:**
- Create: `apps/app/src/editor-v2/schema-contracts.test.ts`

- [x] **Step 1: Write the failing test**

Create `apps/app/src/editor-v2/schema-contracts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  DOHC_V2_CONSTRUCTS,
  DOHC_V2_SCHEMA_VERSION,
  DOHC_V2_YDOC_FIELDS,
  FIRST_CLASS_V2_CONSTRUCTS,
  assertDohcV2SchemaCompleteness,
} from './schema-contracts'

describe('dohc v2 schema contracts', () => {
  it('pins schema version and canonical Y.Doc fields', () => {
    expect(DOHC_V2_SCHEMA_VERSION).toBe(1)
    expect(DOHC_V2_YDOC_FIELDS).toEqual(['body', 'frontmatter', 'meta'])
  })

  it('covers every required markdown construct before implementation starts', () => {
    expect(() => assertDohcV2SchemaCompleteness()).not.toThrow()
    expect(DOHC_V2_CONSTRUCTS.map((c) => c.name)).toEqual([
      'paragraph',
      'heading',
      'bulletList',
      'orderedList',
      'listItem',
      'codeBlock',
      'blockquote',
      'horizontalRule',
      'table',
      'wikilink',
      'inlineAtom',
      'math',
      'htmlAtom',
      'frontmatter',
    ])
  })

  it('keeps AI-native custom constructs first-class and markdown-expressible', () => {
    expect(FIRST_CLASS_V2_CONSTRUCTS).toEqual([
      'wikilink',
      'inlineAtom',
    ])
    for (const name of FIRST_CLASS_V2_CONSTRUCTS) {
      const spec = DOHC_V2_CONSTRUCTS.find((c) => c.name === name)
      expect(spec?.canonical).toBe('tiptap-node')
      expect(spec?.markdown.parse).toBe('custom-extension')
      expect(spec?.markdown.render).toBe('custom-extension')
      expect(spec?.markdown.lossless).toBe(true)
    }
  })

  it('keeps paid Tiptap features out of core schema contracts', () => {
    for (const spec of DOHC_V2_CONSTRUCTS) {
      expect(spec.requiresPaidTiptap).toBe(false)
    }
  })

  it('models frontmatter outside the editable body fragment', () => {
    const frontmatter = DOHC_V2_CONSTRUCTS.find((c) => c.name === 'frontmatter')
    expect(frontmatter?.canonical).toBe('y-map')
    expect(frontmatter?.yjsField).toBe('frontmatter')
    expect(frontmatter?.editableBodyNode).toBe(false)
  })
})
```

- [x] **Step 2: Run test to verify red**

Run:

```bash
pnpm --filter @dohc/app exec vitest run src/editor-v2/schema-contracts.test.ts
```

Expected: fail because `./schema-contracts` does not exist.

Actual: failed because `./schema-contracts` did not exist.

---

### Task 2: Add Compile-Only Schema Contracts

**Files:**
- Create: `apps/app/src/editor-v2/schema-contracts.ts`

- [x] **Step 1: Implement the minimal contract module**

Create `apps/app/src/editor-v2/schema-contracts.ts` with exported constants, literal types, and `assertDohcV2SchemaCompleteness()`.

- [x] **Step 2: Run focused test**

Run:

```bash
pnpm --filter @dohc/app exec vitest run src/editor-v2/schema-contracts.test.ts
```

Expected: pass.

Actual: passed 5 tests.

---

### Task 3: Write The Schema Spec

**Files:**
- Create: `docs/development/v2-schema-spec.md`

- [x] **Step 1: Create schema spec doc**

Create `docs/development/v2-schema-spec.md` with:

- canonical Y.Doc shape
- construct table
- extension contract rules
- markdown projection rules
- schema versioning rules
- explicit stop/go gates
- source links to Tiptap Markdown, Tiptap Collaboration, and Yjs XmlFragment docs

- [x] **Step 2: Cross-check doc and TypeScript names**

Run:

```bash
rg -n "wikilink|inlineAtom|frontmatter|schemaVersion" docs/development/v2-schema-spec.md apps/desktop/src/renderer/editor/schema-contracts.ts
```

Expected: both files use the same names and field spelling.

---

### Task 4: Verify Phase 1.1

**Files:**
- Modify: `docs/development/v2-pivot-plan.md`
- Modify: `docs/development/v2-phase-plans/phase-1.1.md`

- [x] **Step 1: Run full verification**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Expected: all pass on Node 24.14.0.

Actual: `pnpm typecheck`, `pnpm test`, and `pnpm build` passed on Node 24.14.0. Test run: 56 files passed, 789 tests passed, 1 live eval skipped.

- [x] **Step 2: Update pivot plan status**

If verification passes, update `docs/development/v2-pivot-plan.md` status to:

```markdown
**Status:** Plan v1.5 — Phase 1.1 schema contracts complete; ready for Phase 1.2 import/export
```

- [ ] **Step 3: Commit**

Run:

```bash
git add docs/development/v2-schema-spec.md docs/development/v2-phase-plans/phase-1.1.md docs/development/v2-pivot-plan.md apps/app/src/editor-v2/schema-contracts.ts apps/app/src/editor-v2/schema-contracts.test.ts
git commit --no-gpg-sign -m "docs: define v2 schema contracts"
```
