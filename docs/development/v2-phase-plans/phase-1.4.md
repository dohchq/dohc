# Phase 1.4 Tiptap Editor Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Milkdown/Crepe with a Tiptap editor backed by Y.Doc, Hocuspocus, and IndexedDB while preserving dohc's current markdown-first editing affordances.

**Architecture:** The browser creates a Y.Doc per atom, hydrates it from `y-indexeddb`, then syncs it with Hocuspocus using a Convex-minted 5-minute JWT. Hocuspocus bootstraps a missing Y.Doc from the existing Convex `atoms.body` cache on first load and persists that initialized state as a snapshot. `atoms.body` remains the pre-Phase-1.6 compatibility cache; the editor still reports markdown via Tiptap's OSS markdown serializer so the old autosave path can keep working until projection moves server-side.

**Tech Stack:** React, Tiptap OSS, `@tiptap/extension-collaboration`, `@hocuspocus/provider`, `y-indexeddb`, Yjs, Convex, Hocuspocus, Postgres, Vitest, Docker Compose.

---

## File Structure

- Create: `apps/app/src/editor-v2/hocuspocusProvider.ts` — browser provider adapter, doc-name encoding, env URL resolution, JWT refresh loop.
- Create: `apps/app/src/editor-v2/hocuspocusProvider.test.ts` — focused provider adapter unit tests.
- Modify: `apps/app/src/components/AtomEditor.tsx` — replace Crepe/Milkdown with Tiptap and collaboration support.
- Modify: `apps/app/src/components/inlineAtomPlugin.ts` — swap Milkdown ProseMirror imports for Tiptap ProseMirror imports.
- Modify: `apps/app/src/components/wikilinkPlugin.ts` — swap Milkdown ProseMirror imports for Tiptap ProseMirror imports.
- Modify: `apps/app/src/components/WikilinkPicker.tsx` — swap `TextSelection` import for Tiptap ProseMirror import.
- Modify: `apps/app/src/components/AtomView.tsx` — pass owner workspace + atom id into the editor collaboration adapter.
- Modify: `apps/app/src/components/SharedAtomView.tsx` — pass shared owner workspace + file id into the editor collaboration adapter.
- Modify: `apps/app/convex/hocuspocusAuth.ts` — add a server-token-gated bootstrap query for first-load markdown.
- Modify: `apps/app/convex/hocuspocusAuth.test.ts` — cover bootstrap query authorization and atom lookup.
- Modify: `services/hocuspocus/src/convex-acl.ts` — expose optional markdown bootstrap loading through the Convex ACL bridge.
- Modify: `services/hocuspocus/src/hooks.ts` — initialize missing documents from bootstrap markdown and persist a sequence-0 snapshot.
- Modify: `services/hocuspocus/src/persistence.ts` — expose a clear "has persisted document state" check.
- Modify: `services/hocuspocus/src/hooks.test.ts` / `services/hocuspocus/src/convex-acl.test.ts` / `services/hocuspocus/src/persistence.test.ts` — prove bootstrap behavior.
- Modify: `services/hocuspocus/package.json` — add Tiptap markdown import/export dependencies if the service needs to build Y.Docs from markdown.
- Modify: `apps/app/package.json` / `pnpm-lock.yaml` — remove Milkdown packages after the editor is fully ported.
- Modify: `apps/app/.env.example` — document `VITE_HOCUSPOCUS_URL`.
- Modify: `docs/development/v2-pivot-plan.md` and `docs/development/v2-hocuspocus-persistence.md` — record Phase 1.4 status and first-load bootstrap behavior.

## Task 1: Add Provider Adapter And Tests

- [x] **Step 1: Write `hocuspocusProvider.test.ts`**

Cover:
- document names encode/decode the same way as the Hocuspocus service: `workspace/<encoded>/atom/<encoded>`.
- `resolveHocuspocusUrl` reads `VITE_HOCUSPOCUS_URL` when present.
- localhost fallback returns `ws://127.0.0.1:1234` only for browser dev hosts.
- production without an explicit URL returns `null` instead of silently syncing to localhost.

Run:

```bash
pnpm --filter @dohc/app test -- src/editor-v2/hocuspocusProvider.test.ts
```

Expected: fail because the adapter does not exist yet.

- [x] **Step 2: Implement `hocuspocusProvider.ts`**

Implement:
- `encodeDohcHocuspocusDocumentName({ workspaceId, atomId })`.
- `resolveHocuspocusUrl({ envUrl, locationHref })`.
- `createDohcHocuspocusProvider({ url, documentName, ydoc, token, onStatus, onSynced, onAuthenticationFailed })`.
- `startHocuspocusTokenRefresh(provider, intervalMs = 240000)` which calls `provider.sendToken()` before the 5-minute token expires and returns a cleanup function.

Run:

```bash
pnpm --filter @dohc/app test -- src/editor-v2/hocuspocusProvider.test.ts
```

Expected: provider tests pass.

## Task 2: Server Bootstrap From Existing `atoms.body`

- [x] **Step 1: Write failing Convex bootstrap tests**

Add tests in `apps/app/convex/hocuspocusAuth.test.ts`:
- server token is required.
- readable owner atom returns `{ markdown }`.
- unknown atom returns `null`.

Run:

```bash
pnpm --filter @dohc/app test -- convex/hocuspocusAuth.test.ts
```

Expected: fail because the bootstrap query does not exist yet.

- [x] **Step 2: Implement Convex bootstrap query**

Add `hocuspocusAuth.loadAtomBootstrap` with args `{ serverToken, workspaceId, atomId }`.
The query must:
- reject when `serverToken !== HOCUSPOCUS_CONVEX_SERVER_TOKEN`.
- find the atom row where `workspaceId` and frontmatter `id` equal `atomId`.
- return `{ markdown: atom.body }` or `null`.

Run:

```bash
pnpm --filter @dohc/app test -- convex/hocuspocusAuth.test.ts
```

Expected: Convex bootstrap tests pass.

- [x] **Step 3: Add service-side bootstrap tests**

Add tests proving:
- `PostgresYDocStore.hasDocumentState(documentName)` is false when there is no snapshot/update and true when either exists.
- `onLoadDocument` calls the bootstrap loader only for missing documents.
- bootstrapped markdown is converted into a dohc Y.Doc and stored as a snapshot with `lastSeq: 0`.
- existing snapshots/updates skip bootstrap.

Run:

```bash
pnpm --filter @dohc/hocuspocus test
```

Expected: fail before implementation, then pass after implementation.

- [x] **Step 4: Implement service bootstrap**

Implement:
- `YDocPersistenceBackend.hasDocumentState(documentName)`.
- `PostgresYDocStore.hasDocumentState(documentName)`.
- optional `loadAtomBootstrap(input)` on `HocuspocusAcl`.
- Convex ACL bridge call to `hocuspocusAuth:loadAtomBootstrap`.
- a service-local markdown importer for bootstrap using the same Tiptap schema contracts as `apps/app/src/editor-v2/import-export.ts`.
- `onLoadDocument` first-load path:
  1. require read access,
  2. if persisted state exists, load it,
  3. otherwise load bootstrap markdown,
  4. convert markdown to Y.Doc,
  5. persist snapshot with `lastSeq: 0`,
  6. return the initialized doc.

Run:

```bash
pnpm --filter @dohc/hocuspocus test
pnpm --filter @dohc/app test -- convex/hocuspocusAuth.test.ts
```

Expected: tests pass.

## Task 3: Port Editor Shell To Tiptap

- [x] **Step 1: Swap ProseMirror imports in helper plugins**

Change `inlineAtomPlugin.ts`, `wikilinkPlugin.ts`, and `WikilinkPicker.tsx` to import from `@tiptap/pm/state` and `@tiptap/pm/view`.

Run:

```bash
pnpm --filter @dohc/app typecheck
```

Expected: any remaining Milkdown imports are surfaced.

- [x] **Step 2: Replace `CrepeEditor` with `TiptapAtomEditor`**

The new editor must:
- keep the existing `AtomEditor` props and ref methods.
- add optional `collab: { workspaceId: string; atomId: string }`.
- use `StarterKit.configure({ undoRedo: false })` when collaboration is enabled.
- use `Collaboration.configure({ document: ydoc, field: 'body' })` when collaboration is enabled.
- use `Markdown` support through the current Tiptap markdown extensions for local fallback and `editor.getMarkdown()` for `onChange`.
- use `IndexeddbPersistence(documentName, ydoc)` before Hocuspocus provider sync.
- show a small loading state until local persistence and remote auth/sync have reported readiness.
- keep ASCII sketch edit affordance, wikilink autocomplete/click, inline atom pills, formula widgets, live totals, and query block result widgets as ProseMirror plugins registered through a Tiptap extension.
- implement `insertCodeBlock` and `replaceCodeBlockAt` using Tiptap's editor view/state.

Run:

```bash
pnpm --filter @dohc/app typecheck
```

Expected: typecheck passes with no Milkdown/Crepe references.

- [x] **Step 3: Wire route collaboration props**

Update:
- `AtomView.tsx`: use `api.auth.whoami` for the owner workspace id and `extractFrontmatterId(row.body)` for atom id. Pass `collab` only when both exist.
- `SharedAtomView.tsx`: pass `collab={{ workspaceId: shared.ownerWorkspaceId, atomId: shared.fileId }}`.

Run:

```bash
pnpm --filter @dohc/app typecheck
```

Expected: route typecheck passes.

## Task 4: Remove Milkdown And Add Environment Docs

- [x] **Step 1: Remove Milkdown packages**

Run:

```bash
pnpm remove --filter @dohc/app @milkdown/crepe @milkdown/kit @milkdown/react
```

Then run:

```bash
rg -n "@milkdown|Milkdown|Crepe" apps packages services package.json pnpm-lock.yaml
```

Expected: no runtime/dependency references remain.

- [x] **Step 2: Document Hocuspocus browser URL**

Add `VITE_HOCUSPOCUS_URL=ws://127.0.0.1:1234` to `apps/app/.env.example`.

Run:

```bash
rg -n "VITE_HOCUSPOCUS_URL|HOCUSPOCUS" apps/app/.env.example docs/development/v2-hocuspocus-persistence.md docs/development/v2-pivot-plan.md
```

Expected: browser URL and first-load bootstrap are documented.

## Task 5: Integration Verification

- [x] **Step 1: Build and boot Hocuspocus**

Run:

```bash
docker compose -f docker-compose.dev.yml build hocuspocus
docker compose -f docker-compose.dev.yml up -d hocuspocus
docker compose -f docker-compose.dev.yml ps hocuspocus
```

Expected: service is healthy.

- [x] **Step 2: Run live provider integration**

Run:

```bash
HOCUSPOCUS_TEST_DATABASE_URL=postgres://dohc:dohc@127.0.0.1:54329/dohc_v2 pnpm test:hocuspocus:integration
```

Expected: integration tests pass.

- [x] **Step 3: Run full repo verification**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
rg -n "@tiptap-pro|tiptap-pro|tiptap-ai|@tiptap/extension-ai|tracked-changes|@tiptap-pro/extension-comments" package.json pnpm-lock.yaml apps packages services
git diff --check
```

Expected:
- typecheck/test/build/lint pass.
- paid Tiptap guard returns no output.
- diff check returns no whitespace errors.

## Task 6: Review, Docs, And Commit

- [x] **Step 1: Request code review**

Use `superpowers:requesting-code-review` with a reviewer subagent after tests pass.

- [x] **Step 2: Fix verified review findings**

Use `superpowers:receiving-code-review`; reproduce each finding before changing code and re-run focused tests after fixes.

- [x] **Step 3: Update phase docs**

Update:
- `docs/development/v2-pivot-plan.md` status line.
- `docs/development/v2-hocuspocus-persistence.md` bootstrap section.
- this checklist's completed boxes.

- [x] **Step 4: Commit**

Run:

```bash
git status --short
git add apps/app services/hocuspocus docs/development/v2-pivot-plan.md docs/development/v2-hocuspocus-persistence.md docs/development/v2-phase-plans/phase-1.4.md apps/app/.env.example package.json pnpm-lock.yaml
git commit --no-gpg-sign -m "feat: wire tiptap hocuspocus editor"
```

Expected: commit succeeds on `codex/v2-offline-first-phase-0`.
