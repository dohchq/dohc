# M1 step 3 architecture — markdown ↔ prosemirror roundtrip

**Status**: PROPOSED — pre-implementation. Seeking codex review before
build.

**Context**:
- Builds on `multiplayer-and-h-followups-plan.md` + `transport-spike-result.md`.
- M1 step 1 (foundation: convex.config + prosemirror.ts + auth gates) is
  landed (5d8ffb5).
- M1 step 2 (Milkdown adapter + AtomEditor wiring behind opt-in flag) is
  landed (d792672 + dc2968f).
- Multiplayer is OFF on every callsite today (no `multiplayerDocId`
  prop passed anywhere). Branch state: 1013 tests passing.

This doc proposes the architecture for M1 step 3, which closes the loop
so multiplayer docs feed back into dohc's existing read paths (search,
formulas, /r render, agent tools).

---

## The problem

dohc stores doc content as **markdown text** in `atoms.body`. Every read
path in the system parses that markdown directly:

- `search.run` — FTS index built from `atoms.body` (`deriveSearchFields`)
- `formulaEval` — parses inline `{key: value}` atoms from `atoms.body`
- `queries.run` (DSL) — `docs.find("path")` returns digested `atoms.body`
- `/r/<atomId>` route — sanitizes `atoms.body` HTML, resolves formulas
- Agent tools — `read_atom` returns `atoms.body` verbatim
- Inline-atom parsers — `parseInlineAtomsFromMarkdown` operates on markdown

Multiplayer (via `@convex-dev/prosemirror-sync`) introduces a SECOND
representation: **ProseMirror JSON snapshots + step deltas**. When Bob
types in the live editor, those keystrokes flow as PM steps into the
sync component's tables. They do NOT touch `atoms.body`.

Without reconciliation:
- Alice's search misses Bob's edits (FTS reads stale markdown)
- `{= sum(salary) }` aggregates over stale inline values
- The `/r` render route shows stale HTML
- The agent's `read_atom` returns the pre-edit body
- Bob's freshly-typed `[[link]]` doesn't surface in the wikilink picker

## What other tools do

- **Google Docs** unified storage from day one: there's no "markdown
  body" — everything (search, suggestions, sharing) reads from the same
  live op-log.
- **Notion** uses block-tree JSON as its canonical model. Markdown is
  a one-shot export format, not a runtime read path.

dohc is structurally different — we built markdown-first because the
AI agent reads/writes markdown natively (the `read_atom` tool returns
the literal body; `write_atom` accepts markdown). Replacing the
canonical model means rewriting search, formulas, the render route, the
inline-atom parser, and the agent tools — many weeks of work.

## Proposed architecture

**`atoms.body` (markdown) is the single canonical source. The
prosemirror-sync snapshot is a TRANSIENT collaboration buffer.**

```
At rest:    atoms.body (markdown) — the doc IS this
Active:     atoms.body  ←─── periodic flush ─── prosemirror snapshot+deltas
                                                     │
                                                     ▼ live editor
On close:   atoms.body ←── final flush ── snapshot pruned
```

### Lifecycle

1. **Open**: when a doc opens in multiplayer mode, parse `atoms.body`
   (markdown) → PM JSON via Milkdown's parser. If the sync component
   has no snapshot for this docId, submit the PM JSON as the initial
   snapshot at version 0. If it DOES have a snapshot (another tab is
   already editing), use the existing snapshot; bootstrap the local
   editor from `getDoc(...)`.

2. **Edit**: collab via prosemirror-sync. Steps + snapshots accumulate
   in the sync component's tables. `atoms.body` is untouched.

3. **Periodic flush** (every ~10s, server-side scheduled fn): for every
   doc with active deltas since last flush, call
   `prosemirrorSync.getDoc(...)` → serialize PM JSON → markdown →
   `ctx.db.patch(atomId, { body: md, ... })`. Marks the doc as
   "synced through version N." Search/formulas/render see updates
   within the flush window.

4. **On close** (last editor disconnects + grace period): one final
   flush + optionally clear the snapshot for the doc. Markdown is
   canonical again; next open re-bootstraps from atoms.body.

### What's TRANSIENT vs PERMANENT

- **Permanent**: `atoms.body` (markdown). The doc lives here at rest,
  and every non-editor read path goes through here.
- **Transient**: the prosemirror-sync snapshot + deltas. They exist
  only for the duration of an active edit session. The on-close flush
  ensures markdown is up-to-date; subsequent flushes-after-rest can
  recycle the snapshot.

This means the "what's the source of truth" question has a single
clear answer at any moment: **whichever is fresher, and the system
flushes to markdown often enough that the gap is small.**

---

## What needs to be built

### 1. Server-side markdown serializer (the hard part)

Convex runtime is a sandboxed V8 environment (not Node). The Milkdown
serializer uses `remark-stringify`, which is mostly pure JS but has
some DOM-touching corners.

Two paths:
- **(a)** Use `remark-stringify` directly (it should run in V8 — no DOM
  deps in the core path). Pre-load the schema as JSON.
- **(b)** Build a minimal custom serializer for Crepe's schema
  (~12 node types: paragraph, heading 1-6, code_block, blockquote,
  ordered_list, bullet_list, list_item, horizontal_rule, image, link,
  text, hardbreak, table). Smaller surface, easier to maintain.

**Open question for codex**: which path? (a) reuses a battle-tested
library but introduces a server-side dependency; (b) is a 200-line
file we own but might miss edge cases the canonical Milkdown
serializer handles.

### 2. Markdown → PM JSON parser (open-time bootstrap)

Same considerations as the serializer. Milkdown uses `remark-parse`
+ a schema transformer. Mostly pure JS.

**Determinism requirement**: when two clients open the same doc
simultaneously, BOTH must derive the EXACT same PM JSON at version
0 — else they'd disagree about the starting state and rebase wildly.
Need a test rig that asserts deterministic output across:
- Multiple browser engines (we ship to evergreen modern; should be fine)
- Server (Convex V8) vs browser (the markdown parser runs in both
  during bootstrap)

### 3. The scheduled flush function

Convex supports scheduled functions via `crons.ts` or one-shot scheduling
via `ctx.scheduler.runAfter(...)`. Pattern:

```ts
// convex/multiplayer.ts
export const _flushSnapshotToMarkdown = internalMutation({
  args: { docId: v.string() },
  handler: async (ctx, { docId }) => {
    const parsed = parseDocId(docId)
    if (parsed.kind !== 'atom') return
    const schema = getCrepeSchema()
    const { doc, version } = await prosemirrorSync.getDoc(ctx, docId, schema)
    const md = serializeToMarkdown(doc) // <-- the server serializer
    // ...workspace + access checks already done at the sync layer
    await ctx.db.patch(parsed.atomId, {
      body: md,
      updatedAt: Date.now(),
      // ...trigger the existing capture + fileId reconcile chain
    })
    // Could also track "lastSyncedVersion" to skip flushes when nothing changed.
  },
})

// Triggered:
// - From `onSnapshot` in prosemirror.ts: schedule a flush 10s out
//   (debounced — cancel + reschedule on each new snapshot).
// - From an idle-detection mechanism: when no edits for 30s, force
//   a final flush.
```

### 4. The on-open bootstrap

When `multiplayerDocId` is set on AtomEditor mount, the client needs
to check: does a snapshot exist? If yes, use the bootstrap path
(useCollabSync handles this today). If NO, the FIRST client to open
the doc needs to seed the initial snapshot from `atoms.body`. This
needs to be transactional — two clients racing to seed must converge
on the same initial snapshot.

The package provides `prosemirrorSync.create(ctx, id, content)` which
is idempotent (errors if a snapshot already exists). So the bootstrap
flow is:
1. Server: receive a `bootstrapSnapshotFromAtomBody(docId)` mutation
2. Parse `atoms.body` → PM JSON
3. Call `prosemirrorSync.create(ctx, docId, pmJson)` — if it throws
   "already exists," another client got there first; that's fine, our
   bootstrap was redundant.

---

## Trade-offs vs alternatives I considered

### Option A — "scheduled fn writes atoms.body" (this one, basically)
- Pros: clean canonical model; existing read paths unchanged
- Cons: ~10s lag for search/formulas/render
- This is what I'm proposing.

### Option B — "client dual-write on save"
- Pros: no server serializer needed
- Cons: race conditions when two clients save near-simultaneously —
  one client's `atoms.upsert` overwrites the other's markdown with a
  stale version. Collab keeps the live editor correct but the
  *markdown copy* gets briefly inconsistent.
- Rejected because the markdown is the source of truth for the agent —
  the agent reading stale data could make bad decisions (e.g., delete
  a doc thinking it's empty).

### Option C — "freeze markdown while editing"
- Pros: zero serializer work
- Cons: search/formulas stale for HOURS during an active session.
  For an AI-OS where the agent's context comes from search, this is
  unacceptable.

### Option D — "defer; multiplayer docs disappear from search/formulas"
- Pros: shortest path to "it works for the editor"
- Cons: punts the problem; eventually requires rewriting every read
  path to be snapshot-aware.

### Option E — "read-through (computed markdown on read)"
- Idea: search etc. call `getAtomBody(...)` which checks "is there
  a fresher snapshot? if so derive markdown from it, else return
  atoms.body."
- Pros: zero staleness — reads always see the freshest content
- Cons: every search query triggers a serialization for every active
  doc in the result set. Expensive. Caching helps but cache invalidation
  is hard.
- Could be a Phase-2 improvement over Option A: start with the
  scheduled flush (eventual consistency); upgrade to read-through if
  the staleness becomes a problem.

### Option F — "atoms.body as the snapshot store"
- Idea: custom `getSnapshot` returns markdown directly (parsed to PM
  JSON inline). The sync component's snapshot table never has its
  own copy.
- Pros: ZERO sync between markdown and snapshot — they're the same
  thing
- Cons: every `getSnapshot` call serializes markdown → PM JSON. Fine
  for first-open, terrible for the steady-state collab loop. The sync
  package's pruneSnapshots assumes snapshots are cheap; making them
  expensive breaks the perf model.
- Rejected.

---

## Open questions for codex

1. **Is "atoms.body canonical, snapshot transient" actually viable
   given how prosemirror-sync's components keep snapshots around?**
   With `pruneSnapshots: true` we keep the initial + newest snapshot;
   the deltas table is what really grows. If we periodically flush
   AND set up a job to clear stale snapshots, is there a leak path
   I'm missing?

2. **The bootstrap determinism requirement** — markdown→PM JSON must
   be deterministic across browsers AND across browser vs Convex V8
   runtime. Are there known footguns with `remark-parse` here? Should
   we test cross-runtime via a CI integration test?

3. **Periodic flush timing** — 10s feels arbitrary. Should it be
   adaptive (faster when active, slower when idle)? Should it be a
   true cron (every X seconds) or a debounced-from-onSnapshot
   approach (schedule N seconds after each snapshot, cancel + reschedule
   on the next one)?

4. **Is there an Option G I'm missing?** Particularly around the
   read-through (Option E) — is there a path where caching makes it
   the right answer?

5. **Markdown serializer choice** — go with `remark-stringify`
   (battle-tested, but server-side dep) or hand-roll for our 12-node
   subset (200 LOC we own)?

6. **What's the right grace period for the on-close flush?** If the
   user closes the tab, we want to be SURE the final markdown is
   written. But editors might reconnect (network blip). 30 seconds?
   60 seconds? Tied to a "all clients disconnected" signal vs a
   pure timer?

7. **Storage of edit attribution** — when the periodic flush writes
   `atoms.body`, what `source` do we set? It's been edited by many
   people in arbitrary order; "user" is closest but loses fidelity.
   Should we add a multi-author source value?

---

## Implementation plan (if approved)

Sub-commits, each independently testable:

1. **Serializer + parser** (~2 days)
   - Build PM JSON ↔ markdown roundtrip. Determinism test rig.
   - Server can call both; tests assert roundtrip stability for our
     12-node schema + inline-atom decoration spans.

2. **Bootstrap mutation** (~0.5 day)
   - `bootstrapSnapshotFromAtomBody(docId)` — idempotent.
   - Client calls it on first multiplayer mount if no snapshot exists.

3. **Periodic flush + scheduling** (~1 day)
   - `_flushSnapshotToMarkdown` internalMutation.
   - Wire from `onSnapshot` to schedule a flush (debounced 10s).
   - Tests: snapshot → wait → atoms.body updated.

4. **Lifecycle: on-close flush** (~0.5 day)
   - Idle-detection (no edits for 30s) triggers final flush.
   - Optional: clear snapshot for docs idle > 24h to keep tables clean.

5. **End-to-end test** (~0.5 day)
   - Two-client simulated edit → verify markdown converges within
     flush window.

Total: ~4-5 days, plus codex review time.

---

## What's safe to ship today

The current state (after dc2968f):
- M1 foundation + adapter + AtomEditor wiring all landed
- Multiplayer flag is UNSET on every callsite
- Single-user behavior is byte-identical to pre-M1
- 1013 tests passing

No user sees multiplayer behavior until someone passes `multiplayerDocId`
to AtomEditor. The plumbing is dormant. Whoever reviews this doc and
agrees on the M1 step 3 architecture can then approve the build.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex` (consult, against this doc) | Independent 2nd opinion | 1 | REVISE | 8 findings (3 critical), 0 fixed yet |

**CODEX VERDICT: REVISE** — directionally viable, not safe to implement as written.

**Critical findings (must address before build):**

1. **Race vs concurrent `atoms.upsert`** — periodic flush would clobber a concurrent agent / user write that lands during a live collab session. No conflict detection in the proposal.
2. **Side-effect bypass** — proposed `ctx.db.patch(atomId, {body:...})` skips `atomCapture` (trash), `reconcileAtomIdIndex` (fileId), `deriveSearchFields` (FTS), and `scheduleMapRegen`. Must route through a shared helper that fires the full `upsertAtomImpl` chain.
3. **Bootstrap + version semantics wrong** — `prosemirrorSync.create()` is NOT broadly idempotent (only on identical content); throws on divergent races. Initial snapshot version is `1`, not `0` as the proposal said.

**Other findings:**

4. `getDoc()` IS callable from internal mutation — proposal's caution unnecessary.
5. Current `AtomEditor` bootstrap passes `schema: null` and late-installs collab plugins — first edits can happen before sync bootstrap. Step 3 must fix this before enabling multiplayer.
6. `remark-parse`/`remark-stringify` Convex-runtime feasibility hand-waved — needs a real Convex-side import + roundtrip test.
7. "On-close final flush" is unreliable — browser disconnect is not a dependable server signal without a heartbeat/presence model.
8. Terminology fix: snapshot is authoritative during a live session; call atoms.body an "eventual markdown projection" not "canonical truth."

**Codex's Option G (recommended):** introduce `atomBodyRevisions` / `collabSessions` table with `baseBodyHash` + `projectedVersion`. Flush only if `atoms.body` still matches the session base — else pause + surface conflict instead of overwriting.

**Codex's answers on the 7 open questions:**
1. Viability — yes IF snapshots treated as durable active-session projection (not disposable); needs explicit stale-session cleanup
2. Determinism — must test cross-runtime (Convex V8), not just cross-browser
3. Flush timing — debounced from `onSnapshot`, not cron; track `lastProjectedVersion`
4. Option G as above (revisions table + body-hash compare-and-swap)
5. Serializer — library only if Convex runtime test passes; hand-roll likely to miss table/escape/wikilink/frontmatter edge cases
6. Grace period — heartbeat expiry (60-90s after last presence), not tab-close events
7. Attribution — `source: 'collab'` (or preserve existing + `lastEditedVia: 'collab'`); multi-author audit belongs in a separate table

**Cross-model agreement:** Claude Code agrees with all 8 of Codex's findings — no disagreements to flag. Three of the critical findings (race with concurrent writes, side-effect bypass, bootstrap version semantics) are gaps I missed; Codex's Option G is the right architectural fix.

**VERDICT: REVISE before build.** Required next steps:
- Add a shared internal body-replacement helper that fires the full `upsertAtomImpl` side-effect chain
- Add conflict detection (body-hash compare-and-swap or revisions table)
- Fix the bootstrap so the editor doesn't accept edits before sync bootstrap completes
- Treat initial snapshot version as `1`
- Write a Convex-runtime test for serializer/parser import + roundtrip
- Define non-collab-write-during-collab policy (reject? pause collab? rebuild snapshot? surface conflict?) — anything except silent overwrite

UNRESOLVED: 8 decisions (3 critical) before this architecture is safe to implement.
