# v2 Phase 0 Codebase Inventory

## Branch Reality

Phase 0 is running from `main`, not the multiplayer branch. Active code has Milkdown/Crepe and Convex markdown persistence. It does not currently import `@convex-dev/prosemirror-sync`, `@tiptap/*`, `@hocuspocus/*`, or `yjs`.

## atoms.body Paths

### Writes

- `apps/app/convex/schema.ts` — `atoms.body` is the required persisted string field.
- `apps/app/convex/atoms.ts` — central write chokepoint through `upsertAtomImpl`, `upsert`, `_upsertInternal`, `_upsertSystem`, `move`, `setIcon`, migration/repair helpers, and shared edit handling.
- `apps/app/convex/folders.ts` — folder move/remove carries bodies, rewrites wikilinks, snapshots changed bodies, and reapplies capture/index logic.
- `apps/app/convex/trash.ts` — trash stores and restores atom body verbatim.
- `apps/app/convex/agent.ts` — AI `write_atom` and `save_skill` write markdown bodies.
- `apps/app/src/components/AtomView.tsx` — main editor draft state, debounced autosave, source-mode commit, and frontmatter edits call Convex body writes.
- `apps/app/src/components/SharedAtomView.tsx` — shared edits save full body with `baseBody` compare-and-swap.

### Reads And Transforms

- `apps/app/convex/atomId.ts` — body/frontmatter identity, title/icon extraction, type classification, and wikilink/reference collection.
- `apps/app/src/lib/frontmatter.ts` — client YAML parse/rebuild for properties/title/icon.
- `apps/app/convex/inlineAtom.ts` — markdown parser for inline atoms with code/html/autolink skipping and byte caps.
- `apps/app/convex/atomCapture.ts` — diffs prior/new body to record value-atom captures and fail-closed sentinels.
- `apps/app/convex/captures.ts` — re-parses atom body for capture flows.
- `apps/app/convex/formulaEval.ts` and `apps/app/convex/liveTotals.ts` — scan bodies for value atoms/formulas.
- `apps/app/convex/graph.ts` — derives graph nodes, titles, inline atoms, wikilink edges, and formula edges.
- `apps/app/convex/loop.ts` — reads bodies for goals, summaries, wikilinks, duplicate detection, and generated maps.
- `apps/app/convex/htmlAtoms.ts` — validates HTML atom identity, strips frontmatter, and returns raw HTML rest.
- `apps/app/convex/atomShares.ts` — validates body ID and returns raw body for shared editor.

### Render, Search, Export, AI Context

- `apps/app/src/components/AtomEditor.tsx` — Crepe/Milkdown editor receives markdown rest, emits markdown updates, and owns inline decorations.
- `apps/app/src/components/AtomView.tsx` — routes body to source editor, HTML iframe, or formatted editor; strips/rejoins frontmatter.
- `apps/app/src/components/HtmlAtomFrame.tsx` and `apps/app/src/routes/r/$atomId.tsx` — render sanitized HTML atom bodies and resolve formulas in DOM text.
- `apps/app/src/components/Markdown.tsx`, `Chat.tsx`, and `Onboarding.tsx` — render markdown strings.
- `apps/app/convex/queries.ts` — `vault.find` strips frontmatter and returns capped body digests; query blocks evaluate from markdown.
- `apps/app/src/lib/shareText.ts` — exports skill body as share text.
- `apps/app/convex/agent.ts` — `read_atom` returns raw body for normal atoms, inert previews for skills; `run_skill` passes skill body as model instructions.

## Editor And Collaboration Stack

### Current Stack

- `apps/app/package.json` — depends on `@milkdown/crepe`, `@milkdown/kit`, and `@milkdown/react`.
- `apps/app/src/components/AtomEditor.tsx` — constructs `Crepe`, installs Milkdown/ProseMirror plugins, and listens to `markdownUpdated`.
- `apps/app/src/components/inlineAtomPlugin.ts` — inline atom decoration plugin using Milkdown's ProseMirror exports.
- `apps/app/src/components/wikilinkPlugin.ts` — wikilink decoration/autocomplete plugin using Milkdown's ProseMirror exports.
- `apps/app/src/components/WikilinkPicker.tsx` — reaches into ProseMirror selection/view APIs.
- `apps/app/src/components/SharedAtomView.tsx` — not CRDT collaboration; debounced full-body save with CAS.

### Replace

- `apps/app/src/components/AtomEditor.tsx` — replace Crepe/Milkdown shell with Tiptap editor, Yjs binding, Hocuspocus provider, and custom extensions.
- `apps/app/src/components/inlineAtomPlugin.ts` and `apps/app/src/components/wikilinkPlugin.ts` — port to Tiptap extensions or generic ProseMirror plugins through Tiptap-compatible imports.
- `apps/app/src/components/WikilinkPicker.tsx` — preserve UI but replace editor selection/view coupling.
- `apps/app/src/components/AtomView.tsx` — remove editor-origin full-body authority; make it coordinate projection/source/admin flows.
- `apps/app/src/components/SharedAtomView.tsx` — replace shared CAS editing with Hocuspocus room auth plus Yjs semantics.
- `apps/app/package.json` and `pnpm-lock.yaml` — remove Milkdown stack and add Tiptap/Yjs/Hocuspocus stack during Phase 1 implementation.

### Preserve

- `apps/app/convex/inlineAtom.ts` — grammar/parser logic informs custom extension and projection tests.
- `apps/app/convex/atomId.ts` and `apps/app/src/lib/frontmatter.ts` — frontmatter behavior is load-bearing and must be characterized before migrating.
- Atom metadata, `atomIds`, `atomShares`, WorkOS/Convex auth scaffolding — survive the editor/transport pivot.
- Formula/live-total/query evaluators — remain projection consumers with lag-aware semantics.
- `apps/app/src/components/Markdown.tsx` — still renders projected markdown outside the editor.
- Source highlighting/raw source editor — preserve as import/export/admin projection UI, not primary document authority.

## Phase 1.1 Inputs

- Frontmatter is currently load-bearing for IDs, titles, icons, skill/html classification, and share provenance.
- HTML atoms bypass markdown editing and must not be forced through a normal markdown/Y.Doc body model without an explicit schema rule.
- Capture/window logic treats markdown parser behavior as a security boundary; projection drift can leak or hide values.
- Shared editing CAS needs a replacement conflict/auth model under Y.Doc.
- AI skill execution depends on exact body text; projection lag changes model context.

## Characterization Test Targets

- `apps/app/convex/atoms.test.ts` — id seeding, snapshots, capture side effects, and atomId reconciliation.
- `apps/app/src/lib/frontmatter.test.ts` — byte-exact frontmatter split/rejoin behavior.
- `apps/app/convex/atomShares.test.ts` — stale shared body rejection and ID mutation prevention.
- `apps/app/convex/captures.test.ts` and `apps/app/convex/r3InlineWindow.test.ts` — code skipping, byte caps, fail-closed sentinels, and cross-desk withholding.
- `apps/app/convex/queries.test.ts` — search/query digest behavior over projected markdown.
- `apps/app/convex/htmlAtoms.test.ts` and `apps/app/src/lib/htmlSanitize.test.ts` — HTML atom behavior and sanitizer baseline.
- `apps/app/convex/agent.test.ts` and skill tests — raw body/inert preview/skill body execution contracts.
- `apps/app/convex/folderLocks.test.ts` and `apps/app/convex/atoms.test.ts` — wikilink cascade rewrites including Crepe-escaped links.
