# Folder Views Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `.views/` as dohc's folder-local, source-backed app/view layer so any folder can expose custom views over its text, live values, imports/exports, entities, agent workflows, and collaboration state.

**Architecture:** A view is a normal web app package stored as atoms under any folder's `.views/<view-name>/` directory. The code remains ordinary HTML/CSS/TypeScript/React, while all access to dohc goes through a typed capability SDK backed by server-side source resolution, workspace authorization, capture/review gates, imports/exports windows, and existing atom/entity/folder primitives. Views are projections and controls over dohc; they are never a second source of truth.

**Tech Stack:** TanStack Start + React 19, Convex, WorkOS auth, Y.Doc/Hocuspocus-backed atoms, Vitest, Playwright, esbuild for controlled TSX bundling, sandboxed iframes, `postMessage` RPC.

---

## Product Invariants

- `.views/` is a folder-local convention, not a new project type. Any folder can become a work scope by containing `.views/`.
- View source files are ordinary dohc atoms. Users and agents can inspect and edit them in Files.
- View code atoms are non-data atoms. Inline `{key: value}` examples inside `.views/` must never be captured, exported, imported, or used by live totals.
- A view's default data scope is the folder that contains `.views/`.
- Views compose existing primitives: atoms, folders, entities, `{}` live values, query blocks, imports/exports windows, agent chat, skills, locks, and shares.
- Views do not bypass workspace boundaries. Browser code never gets raw Convex access, cookies, same-origin powers, or direct cross-workspace reads.
- Dashboard/app code gets capabilities, not trust. Every SDK operation is authorized server-side.
- Markdown/Y.Doc content remains canonical. View writes must go through existing dohc write paths or explicit proposed patches; hidden app state is not canonical.

## Naming And Layout

Root workspace views:

```text
.views/
  home/
    src/App.tsx
    src/styles.css
```

Folder-local views:

```text
clients/acme/
  brief.md
  tasks.md
  logs.md
  .views/
    overview/
      src/App.tsx
    client-portal/
      view.json
      src/App.tsx
      src/styles.css
```

Optional `view.json`:

```json
{
  "title": "Client Portal",
  "entry": "src/App.tsx",
  "read": ["."],
  "write": [],
  "network": false,
  "agent": ["draft_weekly_update"]
}
```

Defaults when `view.json` is absent:

- `title`: title-cased view folder segment.
- `entry`: `src/App.tsx`.
- `read`: `["."]`.
- `write`: `[]`.
- `network`: `false`.
- `agent`: `[]`.

Data paths in `read` and `write` are scope-relative. Code paths such as `entry` are package-relative.

---

### Task 1: Define `.views/` Path Semantics And Non-Data Rules

**Files:**
- Create: `apps/app/convex/viewPaths.ts`
- Create: `apps/app/convex/viewPaths.test.ts`
- Create: `apps/app/src/lib/viewPaths.ts`
- Modify: `apps/app/convex/atomId.ts`
- Modify: `apps/app/src/lib/atomId.ts`
- Modify: `apps/app/convex/atomId.test.ts`

- [ ] **Step 1: Write failing path tests**

Add tests that lock these cases:

```ts
expect(parseViewPath('.views/home/src/App.tsx')).toMatchObject({
  scopePath: '',
  packageRoot: '.views/home',
  viewName: 'home',
  relativePath: 'src/App.tsx',
})

expect(parseViewPath('clients/acme/.views/overview/src/App.tsx')).toMatchObject({
  scopePath: 'clients/acme',
  packageRoot: 'clients/acme/.views/overview',
  viewName: 'overview',
  relativePath: 'src/App.tsx',
})

expect(parseViewPath('clients/.views/overview')).toBeNull()
expect(parseViewPath('clients/acme/views/overview/src/App.tsx')).toBeNull()
```

- [ ] **Step 2: Implement pure path helpers**

Create pure helpers:

```ts
export type ViewPathInfo = {
  scopePath: string
  packageRoot: string
  viewName: string
  relativePath: string
}

export function parseViewPath(path: string): ViewPathInfo | null
export function isViewPath(path: string): boolean
export function isViewPackageRoot(path: string): boolean
export function titleFromViewName(name: string): string
export function resolveScopeRelativePath(scopePath: string, rel: string): string | null
```

`resolveScopeRelativePath` must accept `.` and normal path segments, reject empty unsafe output, reject `..`, reject absolute paths, and normalize repeated slashes.

- [ ] **Step 3: Re-export client-safe helpers**

Mirror the existing `src/lib/atomId.ts` pattern by re-exporting only pure helpers from `apps/app/src/lib/viewPaths.ts`.

- [ ] **Step 4: Mark `.views/` atoms as non-data**

Update `isNonDataAtom(path, body)` in `apps/app/convex/atomId.ts` so any atom whose path contains a `.views` path segment is treated as non-data.

Expected effect: view source code never feeds `applyAtomCapture`, `windows.availableKeys`, `windows.resolve`, live totals, or query data scans.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm --filter @dohc/app test convex/viewPaths.test.ts convex/atomId.test.ts
```

Expected: tests pass and `.views/` code atoms are excluded from the live-data substrate.

- [ ] **Step 6: Commit**

```bash
git add apps/app/convex/viewPaths.ts apps/app/convex/viewPaths.test.ts apps/app/src/lib/viewPaths.ts apps/app/convex/atomId.ts apps/app/src/lib/atomId.ts apps/app/convex/atomId.test.ts
git commit -m "feat: define folder-local view path semantics"
```

---

### Task 2: Add Backend View Discovery And Manifest Defaults

**Files:**
- Create: `apps/app/convex/views.ts`
- Create: `apps/app/convex/views.test.ts`

- [ ] **Step 1: Write failing discovery tests**

Seed atoms:

```text
.views/home/src/App.tsx
clients/acme/.views/overview/src/App.tsx
clients/acme/.views/client-portal/view.json
clients/acme/.views/client-portal/src/App.tsx
clients/acme/tasks.md
```

Expect `api.views.list` to return:

```ts
[
  {
    packageRoot: '.views/home',
    scopePath: '',
    viewName: 'home',
    title: 'Home',
    entryPath: '.views/home/src/App.tsx',
    hasConfig: false,
  },
  {
    packageRoot: 'clients/acme/.views/overview',
    scopePath: 'clients/acme',
    viewName: 'overview',
    title: 'Overview',
    entryPath: 'clients/acme/.views/overview/src/App.tsx',
    hasConfig: false,
  },
  {
    packageRoot: 'clients/acme/.views/client-portal',
    scopePath: 'clients/acme',
    viewName: 'client-portal',
    title: 'Client Portal',
    entryPath: 'clients/acme/.views/client-portal/src/App.tsx',
    hasConfig: true,
  },
]
```

- [ ] **Step 2: Add malformed config tests**

Invalid `view.json` should not execute code and should return a calm diagnostic:

```ts
expect(view.configStatus).toEqual({
  ok: false,
  reason: 'invalid-json',
})
```

The view should still list with defaults so the user can open source and repair it.

- [ ] **Step 3: Implement `api.views.list`**

Implementation requirements:

- Derive `workspaceId` with `requireWorkspace(ctx, activeWorkspaceId)`.
- Query atoms by `by_workspace`.
- Filter every atom through `canReadAtom`.
- Discover package roots from paths containing `.views/<view-name>/`.
- Limit scans with the same posture as existing query/live systems: `.take(5000 + 1)`, set `truncated: true` if exceeded.
- Parse optional `view.json` as JSON only.
- Treat manifest values as requests, not authorization.

- [ ] **Step 4: Implement `api.views.get`**

Args:

```ts
{
  packageRoot: v.string(),
  activeWorkspaceId: v.optional(v.string())
}
```

Return one resolved view descriptor or `null`. It must fail closed when the package root is malformed, missing, unreadable, duplicated ambiguously, or outside the active workspace.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm --filter @dohc/app test convex/views.test.ts
```

Expected: discovery, defaults, invalid config, access filtering, and truncation tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/app/convex/views.ts apps/app/convex/views.test.ts
git commit -m "feat: discover folder-local views"
```

---

### Task 3: Add The Views Activity And Navigation

**Files:**
- Modify: `apps/app/src/components/ActivityBar.tsx`
- Create: `apps/app/src/components/ViewsSidebar.tsx`
- Create: `apps/app/src/components/ViewFrame.tsx`
- Modify: `apps/app/src/routes/_app.tsx`
- Create: `apps/app/src/routes/_app.w.$wsId.views.tsx`
- Create: `apps/app/src/routes/_app.w.$wsId.v.$viewRef.tsx`
- Create: `apps/app/src/__tests__/viewsShell.test.ts`
- Modify: `apps/app/src/__tests__/commandPalette.test.ts`

- [ ] **Step 1: Write failing shell tests**

Assert:

- Activity bar contains Agent, Files, Views, Graph.
- `/w/me/views` renders the Views activity.
- `/w/me/v/<encoded package root>` renders `ViewFrame`.
- Views list is grouped by `scopePath`, with root shown as `Workspace`.
- Files mode still opens view source atoms normally.

- [ ] **Step 2: Add `View` to app mode**

Change:

```ts
type View = 'agent' | 'atom' | 'views' | 'graph'
```

Update `viewFromPathname` to recognize `/views` and `/v/:viewRef`.

- [ ] **Step 3: Add stable URL encoding helper**

Use a URL-safe base64url encoding of `packageRoot` for `viewRef` in MVP:

```ts
export function encodeViewRef(packageRoot: string): string
export function decodeViewRef(ref: string): string | null
```

This is path-stable only until a folder is renamed. The plan intentionally accepts that for MVP because view packages are folder-local. A later rename-proof `viewId` can be added to `view.json` without breaking the source model.

- [ ] **Step 4: Implement `ViewsSidebar`**

Use `api.views.list`. Render grouped rows:

```text
Workspace
  Home

clients/acme
  Overview
  Client Portal
```

Each row opens `/w/$wsId/v/$viewRef`. Each row also exposes "Open source" to open the entry atom in Files.

- [ ] **Step 5: Wire the app shell**

In `_app.tsx`, render:

- `ViewsSidebar` on the left when `view === 'views'`.
- `ViewFrame` in main content when a view is selected.
- Existing FileTree/AtomView when `view === 'atom'`.
- Existing Agent and Graph paths unchanged.

- [ ] **Step 6: Add command palette entries**

Expose "Open view: <title>" entries from `api.views.list`, plus "Edit view source: <title>" entries that open the entry atom.

- [ ] **Step 7: Run targeted UI tests**

Run:

```bash
pnpm --filter @dohc/app test src/__tests__/viewsShell.test.ts src/__tests__/commandPalette.test.ts src/__tests__/brandNoLegacy.test.ts
```

Expected: tests pass, and no legacy product identity is introduced.

- [ ] **Step 8: Commit**

```bash
git add apps/app/src/components/ActivityBar.tsx apps/app/src/components/ViewsSidebar.tsx apps/app/src/components/ViewFrame.tsx apps/app/src/routes/_app.tsx apps/app/src/routes/_app.w.$wsId.views.tsx apps/app/src/routes/_app.w.$wsId.v.$viewRef.tsx apps/app/src/__tests__/viewsShell.test.ts apps/app/src/__tests__/commandPalette.test.ts
git commit -m "feat: add views activity shell"
```

---

### Task 4: Extract A Shared Workspace Source Resolver For Views

**Files:**
- Create: `apps/app/convex/viewData.ts`
- Create: `apps/app/convex/viewData.test.ts`
- Modify: `apps/app/convex/queries.ts` only where helper extraction reduces duplication without behavior changes.
- Modify: `apps/app/convex/windows.ts` only to expose imported/exported field summaries through narrow helpers, preserving existing behavior.

- [ ] **Step 1: Write resolver tests for local atoms**

For a view at `clients/acme/.views/overview`, default source `"."` resolves visible atoms under `clients/acme/`, excluding:

- atoms under `clients/acme/.views/`
- atoms the viewer cannot read
- atoms outside `clients/acme/`

Return compact rows:

```ts
{
  kind: 'atom',
  path: 'clients/acme/tasks.md',
  fileId: 'clients.acme.tasks',
  title: 'Tasks',
  updatedAt: 123,
  sourceRef: { kind: 'atom', path: 'clients/acme/tasks.md' }
}
```

Full bodies are opt-in through `getAtom`, not included in folder listings.

- [ ] **Step 2: Write resolver tests for inline fields**

Seed:

```md
# Log

{billable: 6}
{client: "acme"}
```

Expect:

```ts
await queryFields({ packageRoot, source: '.', keys: ['billable', 'client'] })
```

to return field rows with source path, key, value, and provenance. It must skip `.views/` source files.

- [ ] **Step 3: Write resolver tests for imports**

Use existing `windows.createWindow`, `grant`, and `windowsSharedWithMe` setup. Expect view data APIs to expose imported windows read-only:

```ts
{
  kind: 'import',
  windowId,
  name: 'contractor-hours',
  ownerWorkspaceId,
  view: { billable: 12 }
}
```

No ungranted window can appear.

- [ ] **Step 4: Implement read APIs**

Add public queries:

```ts
export const listSources = query(...)
export const getAtom = query(...)
export const queryFields = query(...)
export const listImports = query(...)
export const listExports = query(...)
export const previewExport = query(...)
```

All functions:

- Derive workspace from `requireWorkspace`.
- Validate `packageRoot` with `views.get` semantics.
- Enforce manifest read grants and actual user ACL.
- Return bounded, compact, typed data.
- Return fail-soft diagnostics instead of raw server errors.

- [ ] **Step 5: Keep exports/windows as the only cross-workspace data path**

`listImports` and `listExports` may call or share helpers with `windowsSharedWithMe`, `consentOverview`, and `previewWindow`. They must not introduce a new cross-workspace read primitive.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
pnpm --filter @dohc/app test convex/viewData.test.ts convex/windows.test.ts convex/r3InlineWindow.test.ts
```

Expected: view source resolution passes and existing imports/exports windows still pass.

- [ ] **Step 7: Commit**

```bash
git add apps/app/convex/viewData.ts apps/app/convex/viewData.test.ts apps/app/convex/queries.ts apps/app/convex/windows.ts
git commit -m "feat: expose view source resolver"
```

---

### Task 5: Add A Read-Only SDK Bridge Contract

**Files:**
- Create: `apps/app/src/views/sdkProtocol.ts`
- Create: `apps/app/src/views/sdkProtocol.test.ts`
- Create: `apps/app/src/views/ViewRuntimeHost.tsx`
- Modify: `apps/app/src/components/ViewFrame.tsx`

- [ ] **Step 1: Define protocol types**

Create a serializable RPC protocol:

```ts
type ViewRpcRequest =
  | { id: string; op: 'dohc.sources.list'; args: { source?: string } }
  | { id: string; op: 'dohc.atom.get'; args: { path: string } }
  | { id: string; op: 'dohc.fields.query'; args: { source?: string; keys?: string[] } }
  | { id: string; op: 'dohc.imports.list'; args: {} }
  | { id: string; op: 'dohc.exports.list'; args: {} }
  | { id: string; op: 'dohc.source.open'; args: { path: string } }

type ViewRpcResponse =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; error: { code: string; message: string } }
```

- [ ] **Step 2: Test message validation**

Reject messages with missing `id`, unknown ops, non-object args, or prototype-shaped payloads. The bridge must never pass arbitrary objects into Convex calls.

- [ ] **Step 3: Implement `ViewRuntimeHost`**

Responsibilities:

- Own the iframe ref.
- Listen only to messages from `iframe.contentWindow`.
- Attach `packageRoot` and `activeWorkspaceId` server-side through parent context, never from iframe requests.
- Call `viewData` Convex queries dynamically through `useConvex()`.
- Handle `dohc.source.open` in the parent by navigating to Files.

- [ ] **Step 4: Keep the bridge read-only**

For MVP, do not add direct write operations. Views can read, open source, and later trigger user-reviewed agent actions. This keeps the first security boundary tight.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm --filter @dohc/app test src/views/sdkProtocol.test.ts src/__tests__/viewsShell.test.ts
```

Expected: bridge validation and shell tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/app/src/views/sdkProtocol.ts apps/app/src/views/sdkProtocol.test.ts apps/app/src/views/ViewRuntimeHost.tsx apps/app/src/components/ViewFrame.tsx
git commit -m "feat: add read-only view SDK bridge"
```

---

### Task 6: Add The Sandboxed View Runtime

**Files:**
- Create: `apps/app/src/views/viewShell.ts`
- Create: `apps/app/src/views/viewShell.test.ts`
- Modify: `apps/app/src/views/ViewRuntimeHost.tsx`
- Modify: `apps/app/src/components/ViewFrame.tsx`
- Modify: `docs/security/authz-boundaries.md`

- [ ] **Step 1: Write sandbox contract tests**

Assert generated iframe markup uses:

```tsx
<iframe sandbox="allow-scripts" referrerPolicy="no-referrer" />
```

The runtime must not include `allow-same-origin`, `allow-forms`, `allow-top-navigation`, or `allow-popups`.

- [ ] **Step 2: Build fixed runtime shell**

The runtime shell is trusted code generated by dohc. It should include:

- UTF-8 meta tag.
- Inline CSS reset that matches warm paper/graphite enough to feel native.
- A root element `<div id="root"></div>`.
- A tiny inline SDK bootstrap that exposes `window.dohc`.
- No access token, workspace id authority, Convex URL, or cookie-derived data.

- [ ] **Step 3: Add CSP for view iframes**

For `srcDoc` MVP, use a fixed policy equivalent:

```text
default-src 'none';
script-src 'unsafe-inline';
style-src 'unsafe-inline';
img-src data: blob:;
font-src data:;
connect-src 'none';
base-uri 'none';
form-action 'none';
```

Document why the SDK uses `postMessage` and does not need network.

- [ ] **Step 4: Render graceful runtime states**

`ViewFrame` states:

- loading view descriptor
- missing view
- missing entry file
- invalid config
- build diagnostics
- runtime loaded

All states should include "Open source" when a source path exists.

- [ ] **Step 5: Update security docs**

Add a "Views" section to `docs/security/authz-boundaries.md`:

- view code runs in an opaque-origin sandbox
- no raw Convex/cookies
- SDK bridge validates op shape
- Convex still derives identity server-side
- imports/exports remain the only cross-workspace field-sharing path
- `.views/` is non-data

- [ ] **Step 6: Run targeted tests**

Run:

```bash
pnpm --filter @dohc/app test src/views/viewShell.test.ts src/views/sdkProtocol.test.ts src/__tests__/viewsShell.test.ts
```

Expected: runtime shell and bridge tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/app/src/views/viewShell.ts apps/app/src/views/viewShell.test.ts apps/app/src/views/ViewRuntimeHost.tsx apps/app/src/components/ViewFrame.tsx docs/security/authz-boundaries.md
git commit -m "feat: sandbox folder views"
```

---

### Task 7: Add Controlled TypeScript/React Bundling

**Files:**
- Modify: `apps/app/package.json`
- Create: `apps/app/src/views/buildViewBundle.ts`
- Create: `apps/app/src/views/buildViewBundle.test.ts`
- Create: `apps/app/src/views/virtualDohcSdk.ts`
- Modify: `apps/app/src/components/ViewFrame.tsx`

- [ ] **Step 1: Add direct bundler dependency**

Add `esbuild` as an app dependency, not only a transitive dev dependency:

```bash
pnpm --filter @dohc/app add esbuild
```

Expected: `apps/app/package.json` and lockfile update.

- [ ] **Step 2: Write bundling tests**

Given virtual files:

```ts
{
  'src/App.tsx': `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { dohc } from '@dohc/view'
    function App() {
      return <button onClick={() => dohc.source.open({ path: 'tasks.md' })}>Open</button>
    }
    createRoot(document.getElementById('root')!).render(<App />)
  `,
}
```

Expect a JS bundle string, no server-side execution, and a virtual `@dohc/view` module resolved by the bundler.

- [ ] **Step 3: Implement virtual filesystem bundling**

`buildViewBundle` accepts:

```ts
{
  entry: 'src/App.tsx',
  files: Array<{ relativePath: string; body: string }>,
}
```

It supports:

- relative imports within the view package
- CSS imports inlined into the shell
- `@dohc/view` virtual SDK
- `react` and `react-dom/client` resolved from app dependencies

It rejects:

- absolute imports outside the package
- Node builtins
- dynamic `import()` in MVP
- user-authored build plugins
- remote URLs

- [ ] **Step 4: Add bundle size and diagnostic caps**

If the source set or compiled bundle exceeds caps, return diagnostics instead of rendering:

```ts
{ ok: false, diagnostics: [{ code: 'bundle-too-large', message: 'This view is too large to render safely.' }] }
```

Start caps:

- max source files: 100
- max total source bytes: 512 KB
- max bundle bytes: 1 MB

- [ ] **Step 5: Feed bundle into `viewShell`**

`ViewFrame` fetches visible view source atoms through `api.views.getSourceFiles`, builds the bundle in the parent/client runtime for MVP, and injects the compiled JS into the sandbox shell.

This is acceptable for MVP because esbuild transforms code without executing it and the compiled output only runs inside the sandbox. A later server-side build cache can move this work out of the client.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
pnpm --filter @dohc/app test src/views/buildViewBundle.test.ts src/views/viewShell.test.ts src/__tests__/viewsShell.test.ts
pnpm --filter @dohc/app typecheck
```

Expected: bundle tests pass and TypeScript compiles.

- [ ] **Step 7: Commit**

```bash
git add apps/app/package.json pnpm-lock.yaml apps/app/src/views/buildViewBundle.ts apps/app/src/views/buildViewBundle.test.ts apps/app/src/views/virtualDohcSdk.ts apps/app/src/components/ViewFrame.tsx
git commit -m "feat: compile normal web views"
```

---

### Task 8: Expose The First `@dohc/view` SDK

**Files:**
- Create: `apps/app/src/views/virtualDohcSdk.test.ts`
- Modify: `apps/app/src/views/virtualDohcSdk.ts`
- Modify: `apps/app/src/views/buildViewBundle.ts`
- Modify: `apps/app/src/views/sdkProtocol.ts`
- Modify: `apps/app/src/views/ViewRuntimeHost.tsx`

- [ ] **Step 1: Define the framework-neutral SDK**

Initial SDK shape:

```ts
export const dohc = {
  sources: {
    list(args?: { source?: string }): Promise<SourceRow[]>
  },
  atom: {
    get(args: { path: string }): Promise<AtomSnapshot | null>
  },
  fields: {
    query(args?: { source?: string; keys?: string[] }): Promise<FieldRow[]>
  },
  imports: {
    list(): Promise<ImportWindow[]>
  },
  exports: {
    list(): Promise<ExportSummary[]>
  },
  source: {
    open(args: { path: string }): Promise<void>
  }
}
```

- [ ] **Step 2: Add light React helpers**

Expose `createDohcResource` or `useDohcQuery` from the same virtual module:

```ts
export function useDohcQuery<T>(
  key: string,
  loader: () => Promise<T>,
): { data: T | null; loading: boolean; error: string | null }
```

Keep it small. Do not turn the SDK into a state framework.

- [ ] **Step 3: Test SDK request/response behavior**

Use a fake bridge and assert:

- calls resolve values
- errors become `Error` objects with calm messages
- unknown operations reject
- concurrent calls preserve response IDs

- [ ] **Step 4: Document starter app code in the plan comments**

The default agent-generated view should look like:

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { dohc, useDohcQuery } from '@dohc/view'

function App() {
  const fields = useDohcQuery('fields', () =>
    dohc.fields.query({ source: '.', keys: ['status', 'next_action'] }),
  )

  if (fields.loading) return <main>Loading...</main>
  return (
    <main>
      <h1>Overview</h1>
      <pre>{JSON.stringify(fields.data, null, 2)}</pre>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm --filter @dohc/app test src/views/virtualDohcSdk.test.ts src/views/sdkProtocol.test.ts src/views/buildViewBundle.test.ts
```

Expected: SDK, protocol, and bundling tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/app/src/views/virtualDohcSdk.ts apps/app/src/views/virtualDohcSdk.test.ts apps/app/src/views/buildViewBundle.ts apps/app/src/views/sdkProtocol.ts apps/app/src/views/ViewRuntimeHost.tsx
git commit -m "feat: add dohc view SDK"
```

---

### Task 9: Make Imports/Exports A First-Class View Source

**Files:**
- Modify: `apps/app/convex/viewData.ts`
- Modify: `apps/app/convex/viewData.test.ts`
- Modify: `apps/app/src/components/SharingPanel.tsx`
- Create: `apps/app/src/__tests__/viewsImportsExports.test.ts`

- [ ] **Step 1: Add SDK-backed import/export tests**

Assert a view can call:

```ts
await dohc.imports.list()
await dohc.exports.list()
```

and receive the same information the current Imports/Exports panel shows, without gaining any new cross-workspace reads.

- [ ] **Step 2: Preserve consent semantics**

Test that an unconfirmed captured value appears as waiting in exports, but does not appear in an imported view until confirmed through `confirmWithheldFor`.

- [ ] **Step 3: Refactor `SharingPanel` carefully**

Keep the existing UI behavior, but extract presentational helpers where useful so future `.views/` system views can reuse:

- export summary cards
- import preview block
- waiting captured values digest
- "Export these N" action
- "Keep private" action

Do not rewrite the entire panel into a custom view in this task. The target is shared data contracts, not a risky UI churn pass.

- [ ] **Step 4: Add view diagnostics for sharing boundaries**

When a view tries to read an import that is absent or revoked, return:

```ts
{ ok: false, code: 'import-not-granted', message: 'This import is not available to this workspace.' }
```

No server exception details should cross the SDK boundary.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm --filter @dohc/app test convex/viewData.test.ts convex/windows.test.ts src/__tests__/viewsImportsExports.test.ts
```

Expected: imports/exports work through the SDK and existing window tests still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/app/convex/viewData.ts apps/app/convex/viewData.test.ts apps/app/src/components/SharingPanel.tsx apps/app/src/__tests__/viewsImportsExports.test.ts
git commit -m "feat: expose imports and exports to views"
```

---

### Task 10: Add Reviewed Write And Agent Action Capabilities

**Files:**
- Modify: `apps/app/convex/views.ts`
- Modify: `apps/app/convex/viewData.ts`
- Modify: `apps/app/convex/viewData.test.ts`
- Modify: `apps/app/src/views/sdkProtocol.ts`
- Modify: `apps/app/src/views/virtualDohcSdk.ts`
- Modify: `apps/app/src/views/ViewRuntimeHost.tsx`
- Modify: `apps/app/src/components/ViewFrame.tsx`

- [ ] **Step 1: Add write grant parsing**

`view.json` `write` remains default `[]`. A view with no write grant cannot call write SDK methods.

Valid write grants are scope-relative atom paths or folder prefixes:

```json
{
  "write": ["tasks.md", "logs/"]
}
```

- [ ] **Step 2: Add `dohc.agent.run` before direct document writes**

Initial action capability:

```ts
await dohc.agent.run({
  prompt: 'Draft a weekly update from this view.',
  sources: ['tasks.md', 'decisions.md']
})
```

Parent opens Agent with a pending prompt and source context. This gives views a powerful action path without letting sandboxed JS mutate documents directly.

- [ ] **Step 3: Add proposed patch capability**

Add:

```ts
await dohc.patch.propose({
  path: 'tasks.md',
  summary: 'Mark Launch checklist as done',
  patch: { kind: 'frontmatter', set: { status: 'done' } }
})
```

For MVP, this opens a parent-side review modal or Agent prompt. It must not silently raw-patch `atoms.body`.

- [ ] **Step 4: Enforce write gates server-side**

When direct writes are later enabled, they must call existing atom/entity/folder mutations and respect:

- `requireWorkspace`
- `canWriteAtomPath` / folder access
- user locks
- system locks
- skill-turn gates
- capture/review gates
- Y.Doc canonical-source direction

This task only adds proposed patches and agent handoff, so no direct raw write exists yet.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm --filter @dohc/app test convex/viewData.test.ts src/views/sdkProtocol.test.ts src/__tests__/viewsShell.test.ts src/__tests__/agentChatSidebar.test.ts
```

Expected: agent action handoff works and write requests without grants are rejected.

- [ ] **Step 6: Commit**

```bash
git add apps/app/convex/views.ts apps/app/convex/viewData.ts apps/app/convex/viewData.test.ts apps/app/src/views/sdkProtocol.ts apps/app/src/views/virtualDohcSdk.ts apps/app/src/views/ViewRuntimeHost.tsx apps/app/src/components/ViewFrame.tsx
git commit -m "feat: add reviewed view actions"
```

---

### Task 11: Teach Agents To Create `.views/` Correctly

**Files:**
- Modify: `apps/app/convex/agent.ts`
- Modify: `apps/app/convex/a1SystemPrompt.test.ts`
- Modify: `apps/app/src/__tests__/prepareStep.test.ts`
- Modify: `docs/product/spec.md`

- [ ] **Step 1: Update prompt tests**

Expect the system prompt to include:

- `.views/` is the convention for folder-local custom views.
- View source code is normal web code.
- Use TypeScript/React by default.
- Source data lives outside `.views/`.
- Do not store canonical user/work state in view-local JS state.
- Use `{}` live values, entities, imports/exports, and atoms as the substrate.
- Respect locks, shares, capture review, and skill-turn gates.

- [ ] **Step 2: Update agent instructions**

Add a concise section:

```text
Custom views:
- Create views under <folder>/.views/<name>/.
- Put normal app code in src/App.tsx and CSS beside it.
- Add view.json only when the view needs title/permissions beyond defaults.
- Keep data in normal workspace atoms/entities, not inside .views source code.
- .views files are interface code and are not live data.
```

- [ ] **Step 3: Add a creation pattern**

When asked for a dashboard/view, the agent should:

1. inspect the folder's source atoms
2. add or improve `{}` live values/entities when the view requires structured fields
3. create `.views/<name>/src/App.tsx`
4. add `view.json` only if the default read-only scope is insufficient
5. open the View activity for the user

- [ ] **Step 4: Run prompt tests**

Run:

```bash
pnpm --filter @dohc/app test convex/a1SystemPrompt.test.ts src/__tests__/prepareStep.test.ts
```

Expected: prompt contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/app/convex/agent.ts apps/app/convex/a1SystemPrompt.test.ts apps/app/src/__tests__/prepareStep.test.ts docs/product/spec.md
git commit -m "docs: teach agents folder-local views"
```

---

### Task 12: Improve File Tree, Source Editing, And DX

**Files:**
- Modify: `apps/app/src/components/FileTree.tsx`
- Modify: `apps/app/src/lib/path-tree.ts`
- Modify: `apps/app/src/lib/path-tree.test.ts`
- Modify: `apps/app/src/components/AtomView.tsx`
- Create: `apps/app/src/__tests__/viewSourceEditing.test.ts`

- [ ] **Step 1: Add tree labeling tests**

Assert `.views` labels as `Views` and nested view packages show clear source rows:

```ts
expect(nodeLabel(nodeFor('clients/acme/.views'))).toBe('Views')
expect(nodeLabel(nodeFor('clients/acme/.views/overview'))).toBe('overview')
```

- [ ] **Step 2: Keep source editable in Files**

TSX, JSON, CSS, and HTML atoms under `.views/` should open in raw/source-oriented mode by default, not rich Tiptap prose mode.

Implementation direction:

- Add source-mode defaults for paths ending `.tsx`, `.ts`, `.jsx`, `.js`, `.css`, `.json`.
- Keep the same autosave path and lock handling.
- Do not turn code atoms into HTML atoms.

- [ ] **Step 3: Add "Open rendered view" affordance**

When editing a `.views/<name>/...` source atom, show a small button near `source`:

```text
Open view
```

It navigates to `/w/$wsId/v/$viewRef`.

- [ ] **Step 4: Add diagnostics surface**

`ViewFrame` should display build/runtime diagnostics with:

- source path
- error message
- "Open source"
- "Ask dohc to fix this view"

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm --filter @dohc/app test src/lib/path-tree.test.ts src/__tests__/viewSourceEditing.test.ts src/__tests__/fileTreeShortcuts.test.ts
```

Expected: source files stay editable and view packages are understandable in Files.

- [ ] **Step 6: Commit**

```bash
git add apps/app/src/components/FileTree.tsx apps/app/src/lib/path-tree.ts apps/app/src/lib/path-tree.test.ts apps/app/src/components/AtomView.tsx apps/app/src/__tests__/viewSourceEditing.test.ts
git commit -m "feat: improve view source editing"
```

---

### Task 13: Performance And Safety Hardening

**Files:**
- Modify: `apps/app/convex/views.ts`
- Modify: `apps/app/convex/viewData.ts`
- Modify: `apps/app/src/views/buildViewBundle.ts`
- Modify: `apps/app/src/views/ViewRuntimeHost.tsx`
- Create: `apps/app/src/__tests__/viewsPerformanceGuards.test.ts`
- Modify: `docs/security/authz-boundaries.md`

- [ ] **Step 1: Add performance guard tests**

Test these hard limits:

- maximum views discovered per workspace read: 500
- maximum atoms scanned for discovery: 5000
- maximum source files per view bundle: 100
- maximum source bytes per view bundle: 512 KB
- maximum compiled bundle bytes: 1 MB
- maximum SDK result rows for list/query calls: 500 unless paginated

- [ ] **Step 2: Add batching guidance to SDK**

Prefer:

```ts
await dohc.fields.query({ source: '.', keys: ['status', 'next_action'] })
```

over per-file loops. Add SDK diagnostics when a view makes many sequential calls in one render frame.

- [ ] **Step 3: Add runtime timeout**

If iframe does not send `dohc.ready` within a short window, show:

```text
This view did not start. Open source or ask dohc to repair it.
```

- [ ] **Step 4: Add audit logging hook**

For view SDK operations that trigger agent actions or proposed patches, record a lightweight event with:

- workspace
- packageRoot
- operation
- target source
- timestamp

Keep read telemetry local/debug-only for MVP unless product requires durable read logs.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm --filter @dohc/app test src/__tests__/viewsPerformanceGuards.test.ts convex/views.test.ts convex/viewData.test.ts
pnpm --filter @dohc/app typecheck
```

Expected: limits are enforced and typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add apps/app/convex/views.ts apps/app/convex/viewData.ts apps/app/src/views/buildViewBundle.ts apps/app/src/views/ViewRuntimeHost.tsx apps/app/src/__tests__/viewsPerformanceGuards.test.ts docs/security/authz-boundaries.md
git commit -m "feat: harden view runtime limits"
```

---

### Task 14: End-To-End Verification

**Files:**
- Create: `tests/e2e/views.spec.ts`
- Modify: `docs/qa/playwright-checklist.md`
- Modify: `docs/product/spec.md`

- [ ] **Step 1: Add Playwright scenario**

Scenario:

1. Create folder `clients/acme`.
2. Create `clients/acme/tasks.md` with `{status: active}` and `{next_action: send proposal}`.
3. Create `clients/acme/.views/overview/src/App.tsx`.
4. Open Views activity.
5. Open `clients/acme / Overview`.
6. Assert the view renders field data.
7. Click "Open source" from the view.
8. Assert Files opens the source atom.

- [ ] **Step 2: Add imports/exports scenario**

If the e2e harness can seed two workspaces, verify:

1. Workspace A exports `billable`.
2. Workspace B imports it.
3. A view in Workspace B displays only the granted import.
4. Revoking the grant removes the import from the view.

If the harness cannot yet seed two workspaces, document the manual QA steps in `docs/qa/playwright-checklist.md` and keep the single-workspace e2e test automated.

- [ ] **Step 3: Update product docs**

Add concise product language:

```text
Views are folder-local app surfaces over dohc. They live in `.views/`, use normal web code, and talk to the workspace through dohc's source-backed SDK.
```

- [ ] **Step 4: Run full verification**

Run:

```bash
pnpm --filter @dohc/app test
pnpm --filter @dohc/app typecheck
pnpm test:e2e
```

Expected: all targeted and full checks pass, or any pre-existing failure is documented with exact failing command and reason.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/views.spec.ts docs/qa/playwright-checklist.md docs/product/spec.md
git commit -m "test: verify folder views runtime"
```

---

## Later Milestones

These are intentionally outside the first implementation slice, but the architecture above should not block them.

### Local Developer Workflow

- `dohc view dev <path>` for a local Vite-like loop against a mock or live workspace.
- Source maps and console forwarding from iframe to parent diagnostics.
- Export a view package as files.

### Package Ecosystem

- Allow selected npm packages through an allowlist first.
- Later support user-declared dependencies with install/build review.
- Never run user-authored Vite plugins in the trusted server process.

### Direct Writes

- Add typed write SDK methods only after proposed patches are solid:
  - `dohc.atom.proposePatch`
  - `dohc.entity.proposePatch`
  - `dohc.fields.proposeSet`
- Direct write methods must remain capability-gated and server-authorized.

### System Views

Dogfood `.views/` by gradually rebuilding internal panels as source-backed system views:

- Imports / Exports
- Agent review queue
- Workspace home
- Project/folder overview

Do this incrementally. Existing system panels should not be ripped out until the view runtime is stable.

---

## Self-Review Notes

- This plan keeps `.views/` as glue over existing primitives, not an alternative to atoms, live data, entities, imports/exports, or agent chat.
- The first executable slice is read-only custom views. Write power arrives later through reviewed patches and agent actions.
- Security-critical requirements are explicit: no `allow-same-origin`, no raw Convex in iframe code, no cross-workspace reads outside imports/exports windows, and `.views/` excluded from capture/live-data scans.
- Performance-critical requirements are explicit: source scans are capped, folder listings are compact, full atom bodies are opt-in, and SDK calls are designed to batch.
- The plan intentionally improves surrounding systems: file tree/source editing, command palette, agent prompt, imports/exports contracts, security docs, and e2e QA.
