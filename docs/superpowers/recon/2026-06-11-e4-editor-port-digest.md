# E4 recon digest — porting the Tiptap WYSIWYG editor to the desktop

Sources: `git show 7277c39^:apps/app/src/components/AtomEditor.tsx` (3,043 lines)
and siblings; `git show 7277c39:apps/app/src/editor-v2/*`; live
`services/hocuspocus/src/*`; live `apps/desktop/src/renderer/*`. Plan contract:
`docs/superpowers/plans/2026-06-11-dohc-desktop-experience-parity.md` Phase E4
(lines 206–256), decisions D-E1/D-E3 (lines 445–447).

## 1. AtomEditor anatomy

**Tiptap extensions** (`AtomEditor.tsx:2362-2418`): `StarterKit.configure({
codeBlock:false, undoRedo: collab?false:undefined, trailingNode:false })`,
`CodeBlockLowlight.configure({ lowlight: createLowlight(common) })`,
`...dohcMarkdownExtensions`, `TableKit`, `Markdown.configure({ indentation:
{style:'space', size:2} })`, `Placeholder` ("Type '/' for commands"),
`TrailingNode` (non-collab only), `Collaboration.configure({ document: ydoc,
field: 'body' })`, `CollaborationCaret` (custom caret/selection renderers,
`:481-513`), plus one `Extension.create({name:'dohcDecorations'})` (`:2278-2360`)
registering the ProseMirror plugins below.

**Slash commands**: data-driven — `SLASH_COMMANDS` table of 12 items with
aliases (`:141-226`); pure `filterSlashCommands` / `findSlashCommandMatch`
(`:228-245`, unit-tested in `AtomEditor.slashCommands.test.ts`);
`makeSlashCommandPlugin` (`:589-673`) tracks `/query` state + keyboard nav in
`handleKeyDown`; React `SlashCommandMenu` (`:1833`) positioned by
`resolveFloatingMenuPosition`; execution via `editor.chain().deleteRange(...)`
switch (`:2539-2596`). Items: heading 1–3, bulleted/numbered list, quote,
code-block, divider, table, wikilink — plus `ascii-sketch` and `query-block`
(both STRIP, below).

**Wikilink plugin** (`wikilinkPlugin.ts`, 314 lines, pure): decoration-only —
`[[path]]` stays literal text; pill widget + `font-size:0` inline hide;
Obsidian-style source-mode toggle when the cursor is inside the range
(`:197-240`); autocomplete detection feeds `WikilinkPicker.tsx` (236 lines).
**Backend need: a live file list** — `WikilinkFile { path, title?, fileId? }`
held in a ref (`AtomEditor.tsx:2801-2821`). On desktop this is
`bridge().listWorkspaceFiles` (`apps/desktop/src/ipc/bridgeContract.ts:430`) —
no new IPC; title can fall back to path leaf (picker already handles null
title). Click handling: a separate `handleClick` plugin matching
`[data-wikilink-target]` → `onOpenWikilink(target)` (`:2287-2305`) — wire to
the shell's open-path.

**Inline-atom plugin** (`inlineAtomPlugin.ts`, 122 lines, pure): decoration
styling of `{key:n}`/`{ident}`/`{= expr}` text via `parseInlineAtoms` from
`lib/inlineAtom` (port that parser). No backend need by itself.

**Floating menu** (`floatingMenuPosition.ts`, 52 lines, pure viewport math).
Note: there is NO BubbleMenu/selection-format toolbar in the old code — the
plan's "floating selection toolbar" line item is NEW work (Tiptap v3
`@tiptap/react` BubbleMenu or the `dohc-code-block-toolbar` widget pattern at
`:1328-1415` as precedent). Block gutter controls (+ / drag-handle widgets,
`:675-777`) and code-block chrome (language select + copy toolbar,
`:1206-1515`) are pure and port as-is.

**Convex-coupled — STRIP list** (all resolver wiring `:2841-2946`):
- `useAction(api.auth.getCollabToken)` (`:2769`) → already replaced by
  `bridge().collabToken` in `useCollabDoc.ts`.
- `useQuery(api.liveTotals.resolveMany)` + `liveTotalKey` tick (`:2847-2860`,
  `:1517-1531`, `:2645-2652`).
- `useQuery(api.formulaEval.evalFormulas/evalFormulasShared)` + `formulaKey`,
  `makeAtomPillPlugin` value chips (`:2878-2898`, `:1533-1777`).
- `useQuery(api.queries.evalQueryBlocks)` + `makeQueryBlockPlugin` rendered
  results (`:2915-2946`, `:1071-1204`) and the `query-block` slash item.
  Formula/query/live-total VALUES are retired per D-E3; keep the inert
  `inlineAtomPlugin` styling + the `DohcFormula`/`DohcQueryBlock` schema nodes
  (round-trip fidelity), drop all evaluation.
- ASCII sketcher: `makeAsciiBlockPlugin` (`:291-319`), `OPEN_SKETCH_EVENT`,
  `ascii-sketch` slash item, `asciiSketchMetadata` import — retired per D-E3.
- `shareId`/`disableReactiveResolvers` props, `useActiveWorkspaceId`,
  `convex/_generated` imports.
- `IndexeddbPersistence` + `editor-v2/indexeddbState` (`:2120-2183`): the
  desktop's offline copy is the file on disk (useCollabDoc comment, `:35-37`).
- Client-seed bootstrap probing `fetchHocuspocusCapabilities` /
  `fetchHocuspocusDocumentState` (`:2074-2118`): the live server always has
  `atomBootstrap`; main's collabToken IPC already gates availability.

**Keep**: frontmatter→`Y.Map('frontmatter')` sync `syncYMapFromRecord`
(`:321-367`, `:2261-2276`) — required so the server projection re-emits
frontmatter; `editorReadiness.ts` gating; presence avatars (`:2029-2053`).

## 2. The markdown round-trip

Two coordinated serializers, BOTH on `@tiptap/markdown`:
- **In-editor**: `editor.getMarkdown()` in `onUpdate` (`AtomEditor.tsx:2441-2450`),
  guarded by `lastMarkdownRef` so unchanged serialization never fires onChange.
- **Doc-level**: `editor-v2/import-export.ts` — `MarkdownManager({ extensions:
  [...dohcMarkdownExtensions, StarterKit, TableKit], indentation: space/2 })` +
  `getSchema(extensions)`; `markdownToYDoc` parses frontmatter OUT first
  (`lib/frontmatter`), writes `Y.Map('frontmatter')` + `Y.Map('meta')`
  (schemaVersion 1) + `prosemirrorJSONToYXmlFragment` into
  `XmlFragment('body')`; `yDocToMarkdown` re-emits `---yaml---` with priority
  key order id,title,icon then alpha (`import-export.ts:126-144`), `yaml.dump
  lineWidth:-1`. The live server file is the same code + `plainTextToYDoc` /
  `PLAIN_TEXT_FIELD` (`services/hocuspocus/src/import-export.ts:50-62`).

**Frontmatter survival**: never enters the ProseMirror doc; YAML map ↔ Y.Map;
malformed YAML stays in the body verbatim (test `import-export.test.ts:117-131`).

**Fidelity gaps**: (a) round-trip is IDEMPOTENT (`once === twice`), not
byte-identical to arbitrary input — first pass normalizes (list markers,
escaping, frontmatter key order). The desktop must therefore only write on
real edits (the `lastMarkdownRef` guard) to meet the "byte-stable on disk"
gate. (b) **Tasks/checklists: NOT in the schema** — StarterKit v3 has no
taskList; `- [ ]` parses as a plain bullet list and re-serializes WITHOUT the
checkbox = data alteration. Plan demands checklists ⇒ add
`@tiptap/extension-list` task nodes to BOTH desktop and server extension
arrays in the same change, or descope. (c) Raw HTML passthrough: no HTML node;
inline HTML is at risk of being dropped/escaped (corpus has no fixture —
add one before enabling autosave-over-existing-files). (d) Math: preserved as
plain text only (`schema-contracts.ts:299-313`, phase1Scope
'preserve-as-text'). (e) Tables: GFM semantics survive, alignment formatting
may normalize (`schema-contracts.ts:219-233`).

**Existing tests to port/reuse**: `editor-v2/import-export.test.ts` (215
lines: corpus idempotency, frontmatter ordering, wikilink/atom/formula/query
preservation, escaped-pipe wikilinks, query fence info strings, update-bytes
hydration) and `editor-v2/schema-contracts.test.ts` (pins version 1, fields
`['body','frontmatter','meta']`, 16 constructs). The corpus fixtures are still
LIVE at `tests/fixtures/markdown-corpus/` (5 files) and already exercised by
`services/hocuspocus/src/import-export.test.ts`.

## 3. Collab plan for D-E1 (plainText → rich)

**Extension parity (the schema contract).** Server
(`services/hocuspocus/src/import-export.ts:23-27` +
`dohc-markdown-extensions.ts`): `[DohcWikilink, DohcInlineAtom, DohcFormula,
DohcQueryBlock] + StarterKit + TableKit`. Old client editor-v2 list: same
PLUS `DohcMediaAsset` (diff verified — the server copy dropped mediaAsset and
its `parseAssetHref` dep). **Rule: the desktop array must equal the server's
four custom nodes + StarterKit + TableKit.** Do not port DohcMediaAsset unless
it is added server-side in the same change. `CodeBlockLowlight` is safe
client-side (extends `codeBlock`, same node name + `language` attr, adds only
decorations); Placeholder/TrailingNode/Collaboration/Caret are schema-neutral.
Gate: a parity test that `getSchema(desktopExtensions).spec` equals the
server's (`getDohcProseMirrorSchema`, `import-export.ts:106-108`).

**Binding.** `Collaboration.configure({ document: ydoc, field: 'body' })` —
the same `Y.Doc` the existing `HocuspocusProvider` in `useCollabDoc.ts`
connects (document name `workspace/<id>/atom/<id>`, `doc-name.ts:11`). Token
flow (`bridge().collabToken`, 4-min refresh, synced-not-connected gating) is
unchanged.

**useCollabDoc changes** (`apps/desktop/src/renderer/collab/useCollabDoc.ts`):
- Drop `doc.getText("plainText")`, `replaceText` (whole-text transact), and
  the `text`/`setText` API. Expose `{ ydoc, provider, synced, status,
  peerCount }`; Tiptap's Collaboration binding does the editing.
- Settle path: on the existing 800ms debounce, serialize doc→markdown with the
  ported `yDocToMarkdown` (frontmatter map + body fragment) instead of
  `yText.toString()`, then the SAME gates: `shouldMaterialize` →
  `writeWorkspaceText` → `recordMaterialization` (`collabSession.ts:51-98`).
  collabSession.ts is untouched — it is pure text-level logic (D-07 invariants:
  self-write suppression, 3-way `mergeMarkdown`, `.conflict` rescue,
  `.recovered` lifecycle). `reconcileExternalEdit`'s `merge-into-doc` arm now
  re-imports merged markdown into the body fragment (parse via MarkdownManager
  → replace fragment in one transaction) instead of `replaceText`.

**Server-side migration.** Today `loadAtomBootstrap` returns
`plainText: true` for EVERY atom (`postgres-acl.ts:89-104` — comment: the only
live editor is the desktop textarea). `bootstrapMarkdownToYDoc`
(`hooks.ts:195-211`) ORs that flag with `isPlainTextAtomPath`. Flip: stop
returning `plainText: true` for `.md` atoms (keep path-based plain-text for app
source). **Caveat: flipping the flag alone does NOT migrate existing docs** —
`onLoadDocument` re-bootstraps only when the store has no state or
`isUninitializedCanonicalDoc` (`hooks.ts:502-533`), and a live plainText doc
has meta + content, so it loads as-is. Add an explicit migration arm: on load,
if `getDohcYDocMeta(doc).contentKind === 'plain-text'`
(`import-export.ts:82-104`) and the bootstrap is now rich, serialize the
CURRENT plainText Y.Text (not stale `atoms.body` — the 500ms projection
debounce, `projection.ts:33`, can hold unprojected edits), `markdownToYDoc`
it, and `store.storeSnapshot` like the repair path at `hooks.ts:519-533`.
**Data-loss test to write** (in `hooks.test.ts` + `liveCoEditing.spec.ts`):
seed a plainText doc, edit past projection, flip the flag, reopen → rich doc's
`yDocToMarkdown` equals the pre-migration plainText (byte-compare); then
two-client convergence + no conflict markers (phase-10 invariants); plus
mid-session shape mismatch (one old plainText client, one rich) is rejected,
not merged.

## 4. Dependencies for apps/desktop

Old `apps/app` pins at `7277c39^` and the live server agree exactly — add to
`apps/desktop/package.json` (server: `services/hocuspocus/package.json`):

| Package | Version | Note |
|---|---|---|
| @tiptap/core, /react, /starter-kit, /markdown, /extension-table, /pm | ^3.23.6 | MUST match server's ^3.23.6 (schema + markdown parity; pnpm dedupes to one copy) |
| @tiptap/extension-collaboration, /extension-collaboration-caret, /extensions | ^3.23.6 | client-only (caret optional first pass) |
| @tiptap/extension-code-block-lowlight + lowlight | ^3.23.6 / ^3.3.0 | client-only, schema-equivalent to codeBlock |
| y-prosemirror | ^1.3.7 | client markdownToYDoc/yDocToMarkdown (matches server) |
| @emoji-mart/react / @emoji-mart/data / emoji-mart | ^1.1.1 / ^1.2.1 / ^5.6.0 | only if EmojiPicker ports (lazy-loaded) |

Already present in desktop: `@hocuspocus/provider ^4.1.0`, `yjs ^13.6.30`,
`y-protocols ^1.0.7`, `js-yaml ^4.1.1`, `react ^19.2.6`, `lucide-react`,
`react-markdown ^9.1.0`. Do NOT add `y-indexeddb` (file is the offline copy).
Renovate/upgrade rule: bump @tiptap in desktop + hocuspocus in the SAME PR.

## 5. Performance plan vs budgets

Budgets (`packages/performance/src/budgets.ts`): `openMarkdown250KbMs: 150`,
`typingLongTaskMs: 50`.
- **Read path unchanged**: `IncrementalMarkdownDocument` (threshold 32KB,
  `renderer/markdown/IncrementalMarkdownDocument.tsx:14`) stays the default
  markdown view; the `markdown-open` measure (`FileInspector.tsx:194-199`)
  keeps measuring it. Tiptap mounts only on Edit (plan E4: explicit Edit
  affordance above ~size threshold; if mount >1s on the 250KB fixture,
  lazy-load the editor chunk via dynamic import and record numbers).
- **typingLongTaskMs risks** (each is O(doc) per keystroke in the old code):
  (1) `editor.getMarkdown()` in `onUpdate` on EVERY transaction
  (`AtomEditor.tsx:2441`) — move serialization to the 800ms settle debounce;
  keep onUpdate cheap (dirty flag only). (2) Decoration plugins that rebuild
  whole-doc on `docChanged` (wikilink also on `selectionSet`,
  `wikilinkPlugin.ts:275`; inlineAtom; block controls re-map but rebuild on
  change) — acceptable at human doc sizes, but cap or incrementalize before
  enabling Tiptap >32KB. (3) CodeBlockLowlight on large fences. (4) Initial
  `MarkdownManager.parse` on mount (the mount-time measure, not typing).
- **Perf E2E**: `e2e/performance.spec.ts:343-363` types into
  `markdown-editor` (textarea) after `markdown-edit-toggle` with a
  PerformanceObserver longtask probe. Keep both testids on the new surface (or
  point them at the Tiptap contenteditable) so the metric stays comparable;
  ADD: tiptap-mount-on-edit duration on the 250KB fixture, and a typing run
  inside a 32KB-doc Tiptap session (the new worst default case).

## 6. File-by-file port plan — `apps/desktop/src/renderer/editor/`

| New file | Source (git show) | Strip / change |
|---|---|---|
| `extensions.ts` | COPY live `services/hocuspocus/src/dohc-markdown-extensions.ts` (not the old client one) | nothing — verbatim parity; export the array + a schema-parity test |
| `import-export.ts` (+ `.test.ts`) | `7277c39:apps/app/src/editor-v2/import-export.ts` | drop DohcMediaAsset import path; inline server's `parseFrontmatter`; reuse live corpus fixtures |
| `schema-contracts.ts` (+ `.test.ts`) | `editor-v2/schema-contracts.ts` | verbatim (no mediaAsset construct exists in it) |
| `wikilinkPlugin.ts` (+ `.test.ts`) | `components/wikilinkPlugin.ts` | verbatim |
| `inlineAtomPlugin.ts` (+ `.test.ts`) | `components/inlineAtomPlugin.ts` | drop `featureFlags` re-export; port `lib/inlineAtom` parser to `editor/inlineAtom.ts` |
| `floatingMenuPosition.ts` | `components/floatingMenuPosition.ts` | verbatim (52 lines) |
| `WikilinkPicker.tsx` | `components/WikilinkPicker.tsx` | restyle to desktop tokens; files from `listWorkspaceFiles` |
| `EmojiPicker.tsx` | `components/EmojiPicker.tsx` | optional/deferred (emoji-mart deps) |
| `MarkdownEditor.tsx` | `components/AtomEditor.tsx` (3,043 lines) | est. ~1,100–1,400 lines after strip: remove all §1 STRIP items (~1,200 lines: resolvers+pill/query plugins ~700, ascii ~200, indexeddb/bootstrap-probe ~150, convex plumbing ~150); keep slash menu, block controls, code-block chrome, wikilink wiring, collab presence; props become `{ value, onChange, workspaceId, path, knownFiles, onOpenWikilink, collab? }` |
| `collab/useCollabDoc.ts` | live file | rework per §3 (body fragment, expose ydoc) |
| `FileInspector.tsx` MarkdownView | live file | default WYSIWYG ≤ threshold; Source toggle (Cmd/Ctrl+/) keeps the textarea; autosave loop serializes via getMarkdown on settle |
| `e2e/editorWysiwyg.spec.ts` | new | typing, slash, tables, wikilink picker, source toggle, byte-stable disk write |
| `e2e/liveCoEditing.spec.ts` | live file | update to rich doc + plainText→rich migration data-loss test |

Slash items shipped: heading1-3, lists, quote, code-block, divider, table,
wikilink (+ todo once taskList lands per §2b). Retired items (`ascii-sketch`,
`query-block`) stay out of `SLASH_COMMANDS`.
