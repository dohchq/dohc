# Transport spike result — @convex-dev/prosemirror-sync vs Yjs + y-websocket

Date: spike conducted as part of `feat/multiplayer-and-h-followups`.
Companion to: `docs/development/multiplayer-and-h-followups-plan.md` (PR #0 spike was scoped in §3 / Decision A+B).
Decision-driver: Plan agent's round-2 review identified `@convex-dev/prosemirror-sync` as a first-party Convex Component that may eliminate the need for the y-websocket Node service this doc originally proposed.

## TL;DR

**Decision: adopt `@convex-dev/prosemirror-sync`.** The spike confirms it covers every M1–M3 requirement with zero new infrastructure, native Convex auth, and a first-class server-side AI editing path. Trade-offs (no Milkdown-specific hook, no built-in cursor awareness, no offline support) are addressable in-tree and not blockers for v1 multiplayer.

Estimated effect on §8 timeline: **multiplayer arc drops from 7-10 weeks (hybrid Yjs+y-websocket) → 4-6 weeks** (prosemirror-sync). Net plan timeline: **10-12 weeks total**, down from 13-18.

---

## How the spike was conducted

1. Resolved the library via Context7 (`/get-convex/prosemirror-sync`, source rep High).
2. Read the package's documented API surface: `syncApi`, `prosemirrorSync.transform`, `prosemirrorSync.getDoc`, `useTiptapSync`, `useBlockNoteSync`, snapshot/step storage model, auth gate callbacks.
3. Read dohc's existing AtomEditor.tsx (~1100 lines) + Milkdown plugin integration patterns to validate adaptability.
4. Cross-referenced with Plan agent's M1–M4 architecture requirements + Codex's 2 BLOCKERS from the round-2 review.
5. Reviewed by reading the docs only — no exploratory code shipped (spike output is the decision doc).

---

## Findings

### ✅ Schema-agnostic — handles dohc's custom nodes

The package takes any ProseMirror schema via `prosemirrorSync.transform(ctx, id, **schema**, fn)` and `prosemirrorSync.getDoc(ctx, id, **schema**)`. The Tiptap/BlockNote hooks (`useTiptapSync` / `useBlockNoteSync`) are just convenience wrappers that wire the editor framework's schema; the underlying primitives don't care which framework produced the schema.

Implication: Milkdown's Crepe preset (which is a ProseMirror schema) works. The custom decorations dohc uses for inline atoms (`{key: value}`), formula widgets (`{= ... }`), query block widgets (`` ```query ``), wikilinks (`[[path]]`), and ASCII sketches all live in the SAME schema — they ride along.

### ✅ Native Convex auth — Codex BLOCKER 1 dissolved

```ts
const { getSnapshot, submitSnapshot, latestVersion, getSteps, submitSteps } =
  prosemirrorSync.syncApi({
    async checkRead(ctx: QueryCtx, id: string) {
      const ws = await requireWorkspace(ctx, /* activeWorkspaceId from arg */)
      // ... resolveShareAccess for cross-workspace docs
    },
    async checkWrite(ctx: MutationCtx, id: string) {
      // same gate, write permission
    },
    // ...
  })
```

Convex's own auth (via `requireWorkspace` + `resolveShareAccess`) gates every read/write step. The y-websocket plan's Codex BLOCKER 1 — *"plain y-websocket won't enforce role: 'view'"* — is moot here: there's no separate WS server enforcing nothing; auth lives in the same gates as every other Convex query/mutation. View-only callers literally can't submit steps because `checkWrite` throws.

### ✅ Server-side AI editing is FIRST-CLASS

`prosemirrorSync.transform(ctx, id, schema, fn)` is purpose-built for the M3 suggestion-insertion flow:

```ts
const finalDoc = await prosemirrorSync.transform(
  ctx, id, schema,
  (doc, version) => {
    const tr = EditorState.create({ doc }).tr
    tr.insertText(`AI suggestion: ${text}`, position)
    return tr
  },
  { clientId: 'dohc-agent' },  // per-call identity in the step log
)
```

Built-in OT retry on concurrent edits. Returns `null` to abort.

This is dramatically cleaner than the y-websocket alternative (open a node-side Yjs WS client, sync state, apply Yjs ops, close). No connection lifecycle to manage; no Convex action V8 isolate limits on long-lived I/O. The action calls `transform()` and gets back the resulting doc.

For M3 suggestion bubbles (Decision D in the multiplayer plan: suggestions are decorations + sidecar `atomSuggestions` rows, NOT custom PM nodes), the `transform()` path inserts decorations into the doc and writes the sidecar row in the same Convex transaction.

### ✅ `onSnapshot` callback solves the markdown-canonical problem

```ts
onSnapshot: async (ctx, id, snapshot, version) => {
  const doc = JSON.parse(snapshot)   // ProseMirror JSON
  const markdown = serializeDocToMarkdown(doc)   // Milkdown serializer
  await ctx.db.patch(atomId, { body: markdown, updatedAt: Date.now() })
}
```

This is the cleanest answer to Decision C (markdown canonical + parallel CRDT/sync store). Every time the package persists a snapshot (debounced + idle), we ALSO project to markdown and patch `atoms.body`. Search, queries, formulas, the `/r` route, agent `read_atom` — all keep reading `atoms.body` exactly like today.

The 1MB Convex `v.bytes()` cap concern (multiplayer plan §10 risk) is also moot: prosemirror-sync stores snapshots as JSON strings + delta steps; the `pruneSnapshots: true` option keeps only the initial + latest snapshot. No unbounded binary growth.

### ✅ Codex BLOCKER 2 (edit-loss-on-WS-crash) dissolved

The y-websocket plan's data-loss risk was: edits acked to clients but not yet snapshotted to Convex are lost if the WS process restarts. With prosemirror-sync, EVERY step is a Convex mutation (`submitSteps`) — it's persisted atomically as part of the same transaction that updates the version counter. No "in flight in-memory" window. Convex's durability is the guarantee.

### 🟡 No Milkdown-specific hook — adapter needed (~50-100 lines, contained)

The package ships `useTiptapSync` and `useBlockNoteSync`. Milkdown is also ProseMirror, but doesn't have its own hook. We write a thin adapter.

**Pattern (from reading `useTiptapSync`'s implementation expectations):**
```ts
function useMilkdownSync(syncApi, id, opts) {
  // 1. Subscribe to getSnapshot for initial content (Convex useQuery)
  const initial = useQuery(syncApi.getSnapshot, { id })
  // 2. Build the prosemirror-collab plugin with submitSteps + getSteps wiring
  const collabPlugin = useMemo(() => buildCollabPlugin(syncApi, id), [...])
  // 3. Return { isLoading, initialContent, plugin, create }
}
```

Inside Milkdown's `editor.action(ctx => ctx.update(prosePluginsCtx, plugins => [...plugins, collabPlugin]))` — the pattern AtomEditor already uses for wikilink + formula plugins (line 773 of AtomEditor.tsx).

The adapter is contained to ONE file. If it grows past ~200 lines, that's the signal to upstream a `useMilkdownSync` to the package or fork the Tiptap hook as a starting point.

### 🟡 No built-in cursor awareness — separate `atomPresence` table

prosemirror-sync syncs DOCUMENT state (steps + snapshots). It does NOT include presence/awareness (cursor positions, "X is editing" indicators).

This was already in the multiplayer plan's Phase M1+M2 work: a Convex `atomPresence` table that the editor writes to on open + heartbeats every 30s, expires after 90s. The file tree subscribes to show "Alex is editing this page" cross-session (the H-5 user-visible promise Jenny's audit flagged).

For IN-EDITOR cursor positions, a separate Convex query (`atomCursors` per atom, ephemeral, throttled) is the parallel. Plain ProseMirror's collab module is step-only; cursor sync is a small additional surface.

Net: this is NOT extra work vs the Yjs path. Yjs's awareness protocol would have provided cursors but NOT the persistent file-tree indicator (per Jenny's H-5 finding). Either path needs the Convex `atomPresence` table.

### ❌ No offline support — accept, defer

Yjs + IndexedDB persistence (`y-indexeddb`) supports offline-first editing: a user with no network can keep typing; on reconnect, edits sync. prosemirror-sync requires connectivity (Convex subscriptions are network-bound).

Multiplayer plan §1 ("Out of scope") already deferred Yjs IndexedDB. Adopting prosemirror-sync makes this a permanent v1 limitation (Yjs path could have added it later; prosemirror-sync can't easily). The team's call: prose users on flaky networks experience save failures (with the existing optimistic-path UX). Acceptable for v1.

### ❌ Smaller community than Yjs — acknowledged

Yjs has years of production usage at scale (Notion, Linear, Figma-style apps). prosemirror-sync is newer, smaller code base, fewer real-world deployments documented. Bus factor is real.

Mitigation: the package is OPEN SOURCE Convex code — if upstream stalls, we have visibility. The package is also a thin layer over the official `prosemirror-collab` module (which IS battle-tested). The piece that's small-community is the storage/auth wrapping, not the OT engine.

---

## Comparison table

| Requirement | prosemirror-sync | Yjs + y-websocket (original plan) |
|---|---|---|
| Schema-agnostic (Milkdown custom nodes) | ✅ | ✅ |
| Native Convex auth (per-message) | ✅ checkRead/checkWrite | ❌ Custom JWT validation on WS upgrade (Codex HIGH) |
| Server-side AI editing | ✅ `transform()` (OT retry built in) | 🟡 Node-side Yjs client from action (action V8 limits) |
| Markdown projection (canonical body sync) | ✅ `onSnapshot` callback | 🟡 WS server snapshots → Convex periodic |
| View-only role enforcement | ✅ `checkWrite` throws | ❌ Need custom WS server (Codex BLOCKER 1) |
| Edit-loss-on-crash | ✅ Each step = Convex mutation | ❌ In-memory until snapshot (Codex BLOCKER 2) |
| Cursor presence (in-editor) | 🟡 Separate Convex table | ✅ Yjs Awareness (but ephemeral; needs Convex sidecar for file-tree too — Jenny H-5) |
| File-tree "X is editing" | 🟡 atomPresence Convex table | 🟡 atomPresence Convex table (Awareness doesn't cover this) |
| Storage cap (1MB binary) | ✅ JSON snapshots + delta steps + `pruneSnapshots` | ❌ 1MB v.bytes() cap on Y.Doc binary |
| Horizontal scaling | ✅ Convex handles | 🟡 Sticky sessions / Redis pubsub (multiplayer plan §10) |
| Offline (IndexedDB) | ❌ Network-required | 🟡 Available via y-indexeddb (deferred anyway) |
| Deployment infra | ✅ Convex only | ❌ Node service + TLS + monitoring + autoscale (multiplayer plan §10) |
| Community / maturity | 🟡 First-party Convex, newer | ✅ Production-proven (Notion-class) |
| LOC for the adapter | ~50-100 (Milkdown hook) | ~200 (WS server) + ~100 (auth gate) + monitoring |

---

## Recommended M-track shape (revised)

Per the spike, the multiplayer plan §3 updates:

**M1 (combined into M2): Add prosemirror-sync component + Milkdown adapter + onSnapshot → markdown projection.**
- Install `@convex-dev/prosemirror-sync` + `prosemirror-collab`
- `convex/convex.config.ts` registers the component
- `convex/atomSync.ts` exposes `syncApi` with checkRead/checkWrite gated by `requireWorkspace` + `resolveShareAccess` (cross-workspace shares) + (post-P1) the access-mode resolver
- `apps/app/src/lib/useMilkdownSync.ts` adapter
- `AtomEditor.tsx` wires the adapter; sync extension joins existing plugins via `prosePluginsCtx`
- `onSnapshot` callback projects ProseMirror JSON → markdown via the existing Milkdown serializer → patches `atoms.body`
- Round-trip idempotency test corpus (multiplayer plan §3 M1 acceptance)
- Estimated: 1.5-2 weeks (down from M1+M2's 3-4 weeks under prosemirror-sync OR 5-6 under y-websocket)

**M2: Cursor presence + file-tree "X is editing".**
- New `atomPresence` Convex table (per the multiplayer plan §3 M1+M2)
- `atomCursors` Convex query for in-editor cursors (throttled, ephemeral)
- File-tree subscribes to `atomPresence` for the indicator
- Estimated: 1 week

**M3: AI as collaborator (chat-driven suggestion bubbles).**
- New `atomSuggestions` sidecar table (multiplayer plan §3 M3 Decision D)
- `suggest_in_doc` agent tool — privileged, Owner-gated in orgs
- Inside the tool: `prosemirrorSync.transform(ctx, atomId, schema, fn)` inserts the suggestion decoration mark + sidecar row in one transaction
- Suggestion decoration ProseMirror plugin + accept/reject UI
- Behavior migration feature flag
- Estimated: 3-4 weeks (down from 4-6 under y-websocket — the `transform()` API removes ~1 week of plumbing)

**Total M-track: 5.5-7 weeks** (down from 7-10 hybrid / 11-14 y-websocket).

---

## Updated timeline (replaces multiplayer plan §8)

| Phase | Previous estimate | Revised (prosemirror-sync) |
|---|---|---|
| R1 URL routing | 1-1.5 weeks | ✅ ~90% done |
| A1+A2 | 3-5 days | ✅ done |
| W1 | 2-3 days | ✅ done |
| P1 per-atom access | 3-4 weeks | 3-4 weeks (unchanged) |
| Transport spike | 1-2 days | ✅ this doc |
| M1+M2 combined | 3-4 weeks (psync) / 5-6 (y-ws) | **2.5-3 weeks** (further split possible) |
| M3 | 4-6 weeks | **3-4 weeks** |
| F1+F2 | hours | ✅ done |

**Single-PR total realistic: 9-11 weeks** (was 13-18 in the multiplayer plan, before the spike).

---

## Risk register changes

The following multiplayer plan §10 risks are **CLOSED** by adopting prosemirror-sync:
- ~~#6 WS/sync server crash loses acknowledged edits~~ (Codex BLOCKER 2)
- ~~#7 View-only role enforcement at the transport layer~~ (Codex BLOCKER 1)
- ~~#8 Convex `v.bytes()` 1MB cap on `ydocBinary`~~

The following **NEW** risks appear:
- **R-new-1:** Bus factor — prosemirror-sync is newer than Yjs; smaller community. Mitigation: open source, thin wrapper over battle-tested `prosemirror-collab`.
- **R-new-2:** Milkdown adapter (`useMilkdownSync`) is in-tree code we own. If the package adds breaking changes to its primitives, our adapter needs maintenance.
- **R-new-3:** No offline support. v1 limitation, accepted.

The following remain unchanged:
- #2 Markdown round-trip fidelity (still the M1 load-bearing risk — corpus test required)
- #3 Frontmatter + sourceMode (Decision C unchanged)
- #4 Suggestion-bubble UX in nested contexts
- #5 Cost / prompt-injection of `suggest_in_doc`
- #9 Markdown serializer non-idempotency
- #10 AI participation across workspaces (M4 cut from this plan)
- #11 WorkOS reconcile race (orthogonal to transport)
- #12 Schema/serializer version drift (still applies, slightly different shape)

---

## Decision

**Adopt `@convex-dev/prosemirror-sync` as the multiplayer transport.**

Next concrete step (M1 commit 1, future PR turn):
1. `pnpm add @convex-dev/prosemirror-sync prosemirror-collab` in `apps/app`
2. `convex/convex.config.ts` register the component
3. `convex/atomSync.ts` expose `syncApi` with auth gates (initially `requireWorkspace`-only; layer in access-mode + cross-workspace shares as P1 lands)
4. Round-trip idempotency test corpus (using Milkdown serializer)
5. Empty Milkdown adapter (returns the collab plugin); wire into `AtomEditor.tsx`'s `prosePluginsCtx`

The deviating cell from the comparison table — "Smaller community than Yjs" — is the only honest concern. We can adopt prosemirror-sync now and migrate to a different transport later if it becomes a maintenance burden; ProseMirror's collab module is the constant under either choice.
