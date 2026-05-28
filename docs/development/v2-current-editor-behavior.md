# v2 Current Editor Behavior

## Preserve

- Formatted editor hides frontmatter from Crepe and rejoins it on save.
  - Current file: `apps/app/src/components/AtomView.tsx`
  - v2 target: Tiptap editor receives only the editable body while frontmatter is represented in Y.Doc metadata or a separate Y.Map.
- Source mode can edit the full markdown body, including frontmatter.
  - Current file: `apps/app/src/components/AtomView.tsx`
  - v2 target: import/export/admin projection editor with explicit "this edits projection/import source" semantics.
- Wikilink decorations and picker.
  - Current files: `apps/app/src/components/wikilinkPlugin.ts`, `apps/app/src/components/WikilinkPicker.tsx`
  - v2 target: Tiptap wikilink extension plus picker UI.
- Inline atom decorations.
  - Current files: `apps/app/src/components/inlineAtomPlugin.ts`, `apps/app/convex/inlineAtom.ts`
  - v2 target: Tiptap inline atom extension backed by the existing grammar tests.
- Query fences, formulas, live totals, and ASCII/code block display behavior.
  - Current file: `apps/app/src/components/AtomEditor.tsx`
  - v2 target: custom extensions/decorations that consume projected markdown or Y.Doc nodes.
- Read-only shared atom view.
  - Current files: `apps/app/src/components/SharedAtomView.tsx`, `apps/app/src/components/AtomEditor.tsx`
  - v2 target: Hocuspocus ACL plus read-only Tiptap editor state.

## Intentionally Drop

- Debounced full-body editor autosave as canonical content write.
  - Reason: Y.Doc becomes canonical; `atoms.body` is only a projection/cache.
- `baseBody` compare-and-swap as the collaboration model.
  - Reason: Yjs handles document merge; stale-write protection moves to authz, semantic operations, projection hashes, and suggestion witnesses.
- Crepe-specific markdown escaping assumptions as hidden editor behavior.
  - Reason: Tiptap projection must own deterministic markdown parse/render contracts explicitly.

## Needs Product Decision

- Whether HTML atoms remain a separate raw HTML document type or become a first-class Y.Doc subtype.
  - Decision needed before: Phase 1.1 schema specification.
- Whether source mode is a normal user editing mode in v2 or an advanced/admin import-export mode.
  - Decision needed before: Phase 1.4 editor port.
- Whether read-only users publish cursor/focus awareness.
  - Decision needed before: Phase 1.5 awareness.
