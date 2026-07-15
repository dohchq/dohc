# Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start the v2 offline-first pivot cleanly by freezing the baseline, proving the editor choice, exporting/capturing markdown fixtures, and mapping the migration surface before Phase 1.1 schema work starts.

**Architecture:** Phase 0 does not ship runtime v2 code. It creates the evidence and guardrails for the Y.Doc-canonical architecture: Tiptap OSS-only as the default editor layer, Hocuspocus OSS/self-hosted as the sync server, Convex as metadata/agent backend, and `atoms.body` as a projection/cache.

**Tech Stack:** Superpowers, Git worktrees, pnpm, Vitest, TypeScript, Convex, Tiptap OSS, Y.js, Hocuspocus OSS, markdown fixtures.

---

## Controller Notes

- Working branch: `codex/v2-offline-first-phase-0`.
- Worktree: `/home/ice/.config/superpowers/worktrees/dohc/codex-v2-offline-first-phase-0`.
- Source plan: `docs/development/v2-pivot-plan.md`.
- Predecessor evaluation: `docs/development/tiptap-hocuspocus-evaluation.md`.
- Phase 0 should not add paid/pro/private Tiptap packages.
- Phase 0 should not start the editor rewrite. If the editor-choice spike fails, stop before Phase 1.1 implementation.
- Current status: Phase 0 baseline is green on Node 24.14.0. Node 18 was the root cause of the sanitizer dependency-format failure and is now documented as unsupported.

## File Structure

- Create: `docs/development/v2-phase-plans/phase-0.md` — this execution plan.
- Create: `docs/development/v2-phase-0-baseline.md` — branch, install, typecheck, and test baseline evidence.
- Create: `docs/development/v2-phase-0-inventory.md` — codebase inventory from explorer agents.
- Create: `docs/development/v2-editor-choice.md` — Tiptap OSS-only vs Lexical decision record.
- Create: `docs/development/v2-current-editor-behavior.md` — current Milkdown/Crepe behavior to preserve or intentionally drop.
- Create: `docs/development/v2-corpus-export.md` — user corpus export procedure and manifest format.
- Create: `tests/fixtures/markdown-corpus/*.md` — hostile markdown fixtures.
- Create: `tests/fixtures/user-corpus-backup/README.md` — instructions for ignored/private exported user atoms.
- Modify: `docs/development/v2-pivot-plan.md` — keep Phase 0 status and decision gates current.

## Parallel Explorer Prompts

- [x] **Explorer A: atoms.body inventory**

Read-only prompt: inventory every important `atoms.body` read/write/render/search/AI-context path and return Phase 0 implications.

- [x] **Explorer B: editor migration surface**

Read-only prompt: inventory Milkdown, Crepe, ProseMirror sync, editor components, markdown conversion, and collaborative editing hooks.

- [x] **Explorer C: baseline/test/doc conventions**

Read-only prompt: inventory package scripts, Vitest config, Convex test patterns, CI/config, and docs conventions.

---

### Task 1: Baseline The Isolated Branch

**Files:**
- Create: `docs/development/v2-phase-0-baseline.md`

- [x] **Step 1: Confirm branch and worktree**

Run:

```bash
pwd
git status --short --branch
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
```

Expected:

```text
/home/ice/.config/superpowers/worktrees/dohc/codex-v2-offline-first-phase-0
## codex/v2-offline-first-phase-0
codex/v2-offline-first-phase-0
103a46ff9ef746bc4c82fbcb00bfd07a80c7bae8
```

- [x] **Step 2: Install dependencies**

Run:

```bash
pnpm install --frozen-lockfile
```

Expected:

```text
Lockfile is up to date
Done
```

If install fails, record the exact error in `docs/development/v2-phase-0-baseline.md` and stop before any code work.

- [x] **Step 3: Run baseline typecheck**

Run:

```bash
pnpm typecheck
```

Expected:

```text
No TypeScript errors
```

If it fails, record the failing files and messages in `docs/development/v2-phase-0-baseline.md`. Do not fix unrelated baseline failures inside Phase 0 unless the failure blocks all later characterization tests.

- [x] **Step 4: Run baseline tests**

Run:

```bash
pnpm test
```

Expected for a clean baseline:

```text
Vitest suites pass
```

Actual Phase 0 result: `pnpm test` failed on Node 18.19.1 in `apps/app/src/lib/htmlSanitize.test.ts` with `ERR_REQUIRE_ESM` from `html-encoding-sniffer` requiring `@exodus/bytes/encoding-lite.js` through `jsdom`. The supported Node runtime is now documented, and the full test suite passes on Node 24.14.0.

- [x] **Step 5: Write baseline evidence**

Created `docs/development/v2-phase-0-baseline.md` with the actual command results, base commit, failure stack summary, and baseline risks.

---

### Task 2: Capture Codebase Inventory

**Files:**
- Create: `docs/development/v2-phase-0-inventory.md`

- [x] **Step 1: Merge explorer results**

Merged the three explorer results into `docs/development/v2-phase-0-inventory.md`.

- [x] **Step 2: Run local spot-check searches**

Run:

```bash
rg -n "atoms\\.body|body:" apps packages
rg -n "@milkdown|Crepe|prosemirror-sync|collab" apps packages
```

Expected: results agree with the explorer inventory. If a local search finds a missing category, update the inventory before marking this task done.

---

### Task 3: Prove The Editor Choice

**Files:**
- Create: `docs/development/v2-editor-choice.md`
- Modify: `docs/development/v2-pivot-plan.md` if the decision changes

- [x] **Step 1: Document the decision frame**

Create `docs/development/v2-editor-choice.md` with:

```markdown
# v2 Editor Choice

**Decision:** Tiptap OSS-only remains the default for Phase 1.

## Non-Negotiables

- Y.Doc is canonical.
- Markdown export/import must be deterministic.
- No Tiptap Cloud, Tiptap AI Toolkit, Tiptap Comments, Tiptap Tracked Changes, or closed/pro/private Tiptap packages in core.
- Hocuspocus must be self-hosted outside Tiptap's platform.
- dohc AI edits must use repo-owned semantic operations, not a vendor AI toolkit.

## Why Tiptap First

- ProseMirror-compatible path from the current editor stack.
- First-class Y.js collaboration extension.
- Markdown extension APIs are the shortest path to a deterministic projection layer.

## Why Lexical Remains The Escape Hatch

- Lexical is excellent for custom text-first interfaces.
- It may be better if Tiptap's markdown APIs cannot represent dohc constructs without paid/pro dependencies.
- It adds custom glue risk for Yjs, markdown import/export, and mobile/desktop parity.

## Stop/Go Test

Tiptap passes if Phase 1.1 can specify every dohc construct as an OSS Tiptap extension with deterministic markdown parse/render behavior. Tiptap fails if any required construct needs paid/pro/private Tiptap features or hidden non-markdown state.
```

- [x] **Step 2: Verify package guardrail**

Run:

```bash
rg -n "@tiptap-pro|tiptap-pro|tiptap-ai|@tiptap/extension-ai|@tiptap-pro|tracked-changes|comments" package.json pnpm-lock.yaml apps packages
```

Expected: no required core dependency on paid/pro Tiptap packages. Existing docs may mention these as forbidden examples.

- [x] **Step 3: Update main plan if needed**

If the decision changes to Lexical, update `docs/development/v2-pivot-plan.md` before any Phase 1.1 work. Expected if staying with Tiptap: no architecture change needed beyond the OSS-only guardrails already present.

---

### Task 4: Extract Current Editor Behavior

**Files:**
- Create: `docs/development/v2-current-editor-behavior.md`

- [x] **Step 1: Inventory current editor UI behaviors**

Run:

```bash
rg -n "AtomEditor|Crepe|Milkdown|toolbar|slash|placeholder|markdown|wikilink|suggestion" apps/app/src apps/app/convex
```

Expected: locate editor shell, markdown helpers, suggestion UI, and collab behavior.

- [x] **Step 2: Write behavior preservation doc**

Created `docs/development/v2-current-editor-behavior.md` with concrete preserve/drop/product-decision items.

---

### Task 5: Build The Hostile Markdown Fixture Corpus

**Files:**
- Create: `tests/fixtures/markdown-corpus/wikilinks.md`
- Create: `tests/fixtures/markdown-corpus/frontmatter.md`
- Create: `tests/fixtures/markdown-corpus/lists-tables.md`
- Create: `tests/fixtures/markdown-corpus/math-code.md`
- Create: `tests/fixtures/markdown-corpus/inline-atoms.md`

- [x] **Step 1: Add wikilink fixture**

Create `tests/fixtures/markdown-corpus/wikilinks.md`:

```markdown
# Wikilinks

Bare link: [[Project Alpha]]

Aliased link: [[Project Alpha|alpha notes]]

Escaped brackets: \[[not a wikilink]]

Nested punctuation: [[Research/AI-native, draft (v2)]]

Adjacent text before[[InlineTarget]]after.
```

- [x] **Step 2: Add frontmatter fixture**

Create `tests/fixtures/markdown-corpus/frontmatter.md`:

```markdown
---
title: "Phase 0: Offline-first"
tags:
  - dohc
  - v2
pinned: true
count: 3
---

# Body After Frontmatter

The body starts after YAML and must not lose frontmatter keys.
```

- [x] **Step 3: Add lists/tables fixture**

Create `tests/fixtures/markdown-corpus/lists-tables.md`:

```markdown
# Lists And Tables

1. First item
   - Nested bullet
   - Second nested bullet with [[Link]]
2. Second item

| Name | Status | Notes |
|---|---:|---|
| Alpha | 1 | keeps alignment |
| Beta | 2 | has `inline code` |
```

- [x] **Step 4: Add math/code fixture**

Create `tests/fixtures/markdown-corpus/math-code.md`:

````markdown
# Math And Code

Inline math $E = mc^2$ should survive.

$$
\int_0^1 x^2 dx = \frac{1}{3}
$$

```ts
export const value = "[[not a wikilink inside code]]";
```

````

- [x] **Step 5: Add inline atom fixture**

Create `tests/fixtures/markdown-corpus/inline-atoms.md`:

```markdown
# Inline Atoms

Reference inline atom: {{atom:atom_123 title="Alpha"}}

Mixed paragraph with {{atom:atom_456}} and [[Related Note]].
```

---

### Task 6: Define User Corpus Export

**Files:**
- Create: `docs/development/v2-corpus-export.md`
- Create: `tests/fixtures/user-corpus-backup/README.md`

- [x] **Step 1: Document export manifest**

Create `docs/development/v2-corpus-export.md`:

```markdown
# v2 Corpus Export

## Purpose

Phase 0 exports the current user's atoms before v2 writes exist. The export is used for markdown-to-Y.Doc round-trip tests and as a rollback backup.

## Output Layout

Private exports live under `tests/fixtures/user-corpus-backup/` and should not include secrets in committed fixtures.

Each exported atom should have:

- `atomId`
- `path`
- `title`
- `bodyHash`
- `bodyLength`
- `updatedAt`
- `markdownFile`

## Manifest Shape

```json
{
  "exportedAt": "2026-05-25T00:00:00.000Z",
  "workspaceId": "user_...",
  "atoms": [
    {
      "atomId": "atom_...",
      "path": "Notes/Example.md",
      "title": "Example",
      "bodyHash": "sha256:...",
      "bodyLength": 1234,
      "updatedAt": 0,
      "markdownFile": "atoms/atom_....md"
    }
  ]
}
```

## Privacy Rule

Commit only synthetic fixtures unless Ice explicitly chooses to commit real notes.
```

- [x] **Step 2: Add private corpus README**

Create `tests/fixtures/user-corpus-backup/README.md`:

```markdown
# User Corpus Backup

This directory is reserved for Phase 0 markdown exports from the current dohc workspace.

Do not commit private user notes by default. Commit only this README and synthetic fixtures unless Ice explicitly approves committing a sanitized export.
```

---

### Task 7: Phase 0 Stop/Go Gate

**Files:**
- Modify: `docs/development/v2-pivot-plan.md`
- Modify: `docs/development/v2-phase-plans/phase-0.md`

- [x] **Step 1: Confirm deliverables**

Run:

```bash
test -f docs/development/v2-phase-0-baseline.md
test -f docs/development/v2-phase-0-inventory.md
test -f docs/development/v2-editor-choice.md
test -f docs/development/v2-current-editor-behavior.md
test -f docs/development/v2-corpus-export.md
find tests/fixtures/markdown-corpus -type f -name '*.md' | sort
```

Expected: all docs exist and at least five hostile markdown fixture files are listed.

- [x] **Step 2: Run verification**

Run:

```bash
pnpm typecheck
pnpm test
```

Expected: `pnpm typecheck` passes and `pnpm test` passes on the supported Node runtime.

- [x] **Step 3: Update status**

In `docs/development/v2-pivot-plan.md`, update the status line to:

```markdown
**Status:** Plan v1.4 — Phase 0 complete; ready for Phase 1.1 schema specification
```

Only do this after the stop/go gate passes.
