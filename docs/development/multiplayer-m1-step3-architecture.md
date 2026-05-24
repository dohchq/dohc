# M1 step 3 architecture v2 — markdown ↔ prosemirror projection

**Status**: PROPOSED v2 — pre-implementation. Seeking second codex review
pass before build. v1 (in git history at commit 608888a) was REVISED by
codex (see GSTACK REVIEW REPORT at the bottom of this doc for the v1
findings absorbed below).

**Context**:
- Builds on `multiplayer-and-h-followups-plan.md` + `transport-spike-result.md`.
- M1 step 1 (foundation: convex.config + prosemirror.ts + auth gates) is
  landed (5d8ffb5).
- M1 step 2 (Milkdown adapter + AtomEditor wiring behind opt-in flag) is
  landed (d792672 + dc2968f).
- Multiplayer is OFF on every callsite today (no `multiplayerDocId`
  prop passed anywhere). Branch state: 1013 tests passing.

This doc proposes the v2 architecture for M1 step 3, which closes the
loop so multiplayer docs feed back into dohc's existing read paths
(search, formulas, /r render, agent tools) WITHOUT silently corrupting
data on concurrent writes.

---

## The problem (unchanged from v1)

dohc stores doc content as **markdown text** in `atoms.body`. Every read
path in the system parses that markdown directly:

- `search.run` — FTS index built from `atoms.body` (`deriveSearchFields`)
- `formulaEval` — parses inline `{key: value}` atoms from `atoms.body`
- `queries.run` (DSL) — `docs.find("path")` returns digested `atoms.body`
- `/r/<atomId>` route — sanitizes `atoms.body` HTML, resolves formulas
- Agent tools — `read_atom` returns `atoms.body` verbatim
- Inline-atom parsers — `parseInlineAtomsFromMarkdown` operates on markdown

Multiplayer introduces a SECOND representation: **ProseMirror JSON
snapshots + step deltas** in `@convex-dev/prosemirror-sync`'s tables.
Without reconciliation, search/formulas/render/agent tools see stale
markdown while the live editor moves on.

---

## What changed from v1 (and why)

Codex's v1 review (verbatim in GSTACK REVIEW REPORT below) surfaced three
critical bugs:

1. **Race vs concurrent `atoms.upsert`**: an agent's `write_atom` call
   landing during a live collab session would be silently overwritten by
   the next periodic flush.
2. **Side-effect bypass**: v1 proposed `ctx.db.patch(atomId, {body:...})`
   which skips the full `upsertAtomImpl` chain (`atomCapture`,
   `reconcileAtomIdIndex`, `deriveSearchFields`, `scheduleMapRegen`).
3. **Wrong `create()` semantics**: v1 claimed `prosemirrorSync.create()`
   is broadly idempotent. It only silently-accepts on IDENTICAL content;
   throws on divergent races. Also: initial snapshot version is `1`,
   not `0`.

Plus terminology + lifecycle gaps. v2 fixes all eight. See "Changes from v1"
appendix at the bottom for a finding-by-finding map.

---

## Proposed v2 architecture

### Mental model: **eventual markdown projection**

`atoms.body` is the **persistent projection** of doc content. The
prosemirror-sync snapshot is **authoritative DURING an active edit
session**. The projection lags the snapshot by at most the flush window
(typically < 2s under the onSnapshot-driven model).

| State | Authoritative for content | Authoritative for read paths |
|---|---|---|
| At rest (no live editors) | `atoms.body` | `atoms.body` |
| Active edit session | prosemirror snapshot + deltas | `atoms.body` (projection; eventually consistent) |

This is **not** "canonical vs transient" — it's **"persistent vs live."**
Both stores carry truth; the projection is a debounced copy that lags by
design.

### Lifecycle (revised)

1. **Open (bootstrap with race-safety)**
   - Client mounts AtomEditor with `multiplayerDocId`.
   - AtomEditor gates rendering on `useCollabSync.bootstrap.ready` — the
     editor mounts AFTER the snapshot resolves (fixes the v1 step-2 bug
     where edits could happen before bootstrap).
   - If no snapshot exists for this docId, the FIRST client to open
     calls `bootstrapSnapshotFromAtomBody(docId, atomBodyHash)` (server
     mutation). The server:
     - Reads `atoms.body` (P1 access check fires)
     - Parses markdown → PM JSON via the shared parser
     - Calls `prosemirrorSync.submitSnapshot(docId, version: 1, content: pmJson)`
     - On `create-already-exists` with IDENTICAL content: success
       (another client got there first; both derived the same PM JSON)
     - On `create-already-exists` with DIFFERENT content: this is a
       deterministic-parser bug; fail loud
     - Records the initial `atomBodyHash → projectedVersion: 1` in the
       `collabSessions` table

2. **Edit** (collab steps flow through prosemirror-sync; `atoms.body`
   is untouched until the next projection)

3. **Projection (onSnapshot-driven, not cron)**
   - The component's `onSnapshot` callback fires when the editor
     debounces a fresh snapshot to the server (typically every few
     seconds during active typing).
   - `onSnapshot` schedules a debounced projection via
     `ctx.scheduler.runAfter(N, _projectSnapshotToBody, {docId, snapshotVersion})`
     where N is a small backoff (e.g. 1500ms) to coalesce bursts.
     If a prior projection is already scheduled at a higher version, the
     newer one supersedes it (cheap: just update the projection target).
   - `_projectSnapshotToBody` runs through the **compare-and-swap +
     side-effect-safe writer** (see next section).

4. **On idle (heartbeat presence model, not tab-close)**
   - Each editor sends a heartbeat presence ping every ~30s via a thin
     mutation (separate from the sync component) that touches
     `collabSessions.{docId, clientId}.lastSeenAt`.
   - A scheduled cleanup fn (every 5min) finds sessions with
     `lastSeenAt < now - 90s` and:
     - Runs a final projection at the latest known version
     - Removes the session row
     - If no sessions remain for a docId for >24h, schedules a snapshot
       prune (clears the prosemirror snapshot/deltas for that doc;
       `atoms.body` is now the only source)
   - Tab close is NOT the correctness mechanism. The heartbeat is.

### The compare-and-swap projection write (Option G)

New table:

```ts
collabSessions: defineTable({
  docId: v.string(),           // 'atom:<ws>:<atomId>' or 'share:<shareId>'
  clientId: v.string(),        // per-tab UUID
  lastSeenAt: v.number(),      // heartbeat timestamp
  // The body hash AT THE TIME this client opened the doc OR at the time
  // of the most recent projection that THIS client observed. Used as the
  // CAS witness for safe projection.
  baseBodyHash: v.string(),
  projectedVersion: v.number(), // last snapshot version we projected to atoms.body
  workspaceId: v.string(),
  atomId: v.optional(v.id('atoms')), // null for share: docs (resolved through resolveShareAccess)
})
.index('by_docId', ['docId'])
.index('by_docId_clientId', ['docId', 'clientId'])
.index('by_lastSeenAt', ['lastSeenAt'])
```

`_projectSnapshotToBody({docId, snapshotVersion})` flow:

```ts
// 1. Resolve atom + read CURRENT body
const parsed = parseDocId(docId)
if (parsed.kind !== 'atom') return   // shared atoms: defer (M2 follow-up)
const atom = await ctx.db.get(parsed.atomId)
if (!atom) return                     // doc deleted while session active
const currentBodyHash = await sha256Hex(atom.body)

// 2. CAS: do all live sessions agree the current body is what we last projected?
const sessions = await ctx.db.query('collabSessions')
  .withIndex('by_docId', q => q.eq('docId', docId)).collect()
if (sessions.length === 0) return     // no live editors; nothing to project
const expectedHash = sessions[0].baseBodyHash // all sessions should agree
const allAgree = sessions.every(s => s.baseBodyHash === expectedHash)
if (!allAgree || currentBodyHash !== expectedHash) {
  // SOMEONE wrote to atoms.body OUT-OF-BAND while collab was live.
  // Could be: an agent's write_atom, a /atoms/upsert from a non-multiplayer
  // tab, a manual restore from trash. Conflict policy below.
  await ctx.scheduler.runAfter(0, _handleCollabConflict, {docId, snapshotVersion})
  return  // do NOT silently overwrite
}

// 3. Get the snapshot + serialize to markdown
const schema = getCrepeSchema()
const { doc, version } = await prosemirrorSync.getDoc(ctx, docId, schema)
if (version <= sessions[0].projectedVersion) return  // already projected
const newMd = await serializeToMarkdown(doc)
const newBodyHash = await sha256Hex(newMd)

// 4. Route through the SHARED body-replacement helper (fires full side-effect chain)
await replaceAtomBodyForCollabProjection(ctx, {
  atomId: parsed.atomId,
  newBody: newMd,
  expectedCurrentBodyHash: expectedHash,  // second CAS — db read could have raced
  source: 'collab',
})

// 5. Update all session rows to the new hash + version
for (const s of sessions) {
  await ctx.db.patch(s._id, {
    baseBodyHash: newBodyHash,
    projectedVersion: version,
  })
}
```

### The shared body-replacement helper

Refactored out of `upsertAtomImpl` so it can be called from BOTH the
existing public/agent write surfaces AND the collab projection path,
with identical side effects:

```ts
// New: convex/atomWriter.ts
export async function replaceAtomBodyForCollabProjection(
  ctx: MutationCtx,
  args: {
    atomId: Id<'atoms'>
    newBody: string
    expectedCurrentBodyHash: string  // CAS — refuses to write if hash differs
    source: 'collab'
  },
): Promise<{ ok: true } | { ok: false, reason: 'hash-mismatch' }> {
  const atom = await ctx.db.get(args.atomId)
  if (!atom) return { ok: false, reason: 'hash-mismatch' }
  if (await sha256Hex(atom.body) !== args.expectedCurrentBodyHash) {
    return { ok: false, reason: 'hash-mismatch' }
  }
  // Locks still apply — a user-locked atom blocks collab projection
  // (rare; user explicitly froze it; surface the conflict).
  if (atom.systemLocked) throw new SystemLockError(atom.path, 'project')
  if (atom.userLocked) throw new UserLockError(atom.path, 'project')

  // Fire the FULL side-effect chain (this is what v1's ctx.db.patch missed):
  await applyAtomCapture(ctx, atom.workspaceId, atom.path, atom.body, args.newBody)
  await ctx.db.patch(args.atomId, {
    body: args.newBody,
    updatedAt: Date.now(),
    source: args.source,
    ...deriveSearchFields(atom.path, args.newBody),
  })
  await reconcileAtomIdIndex(ctx, atom.workspaceId, atom.path, args.newBody)
  await scheduleMapRegen(ctx, atom.workspaceId)
  return { ok: true }
}
```

And the existing `upsertAtomImpl` continues to do its `isUserEdit`-aware
work (lock check + user-overwrite guard + the same side-effect chain).
They share `applyAtomCapture / deriveSearchFields / reconcileAtomIdIndex /
scheduleMapRegen` but have different write-permission semantics.

### Conflict policy when a non-collab write lands during active collab

`_handleCollabConflict` fires when the CAS in step 2 detects the body
changed out-of-band. v1 didn't address this; v2 picks the most defensive
policy and surfaces it to the user:

1. **PAUSE the collab session for this doc** — flip a `frozen: true`
   flag on the `collabSessions` rows. The frontend reads this via a
   query and shows a banner: "Another writer changed this file; reload
   to continue editing collaboratively."
2. **Do NOT auto-merge**. The PM doc state can't easily merge against
   an arbitrary markdown overwrite; trying would corrupt one side.
3. **On user reload**: the frontend tears down the session, deletes the
   collab session row, and rebootstraps from the new `atoms.body` at
   a fresh version.

The conflict is rare — it requires an agent/non-collab write WHILE a
live multiplayer session is open. But it can happen (e.g. user opens
the doc in a non-multiplayer tab and saves) and silent corruption is
the wrong fail mode.

---

## What needs to be built

### 1. Markdown ↔ PM JSON serializer + parser (the hard part — needs proof)

Convex runtime is a sandboxed V8 environment (not Node). Codex correctly
flagged that v1 hand-waved this. v2 requires a real Convex-runtime
test BEFORE committing the architecture:

- **Step 1a (DECIDER)**: write a tiny `convex/_testRemarkRuntime.ts`
  internalQuery that imports `remark-parse` + `remark-stringify` +
  `mdast-util-from-markdown` + `mdast-util-to-markdown`. Push it to a
  Convex dev deploy. Run a roundtrip on a fixture markdown string.
  Either:
  - **It works**: adopt library-based serialization (lower risk than
    hand-rolling)
  - **It fails** (bundler / dynamic import / Node-only dep): fall back
    to a custom 200-LOC serializer for Crepe's 12-node schema. Document
    the failure mode + edge-case gaps (tables, escaping, wikilinks,
    inline atoms, frontmatter, code fences).
- **Step 1b**: build the chosen serializer with a deterministic-roundtrip
  test rig covering ALL of dohc's content shapes:
  - Plain paragraphs + headings
  - Inline atoms (`{key: value}`, `{:key value}`)
  - Formulas (`{= sum(...) }`)
  - Live totals (`{identifier}`)
  - Wikilinks (`[[path]]`)
  - Query blocks (` ```query ... ``` `)
  - ASCII sketches (` ```ascii ... ``` `)
  - Frontmatter (`---\nid: x\n---\n`)
  - Tables (Crepe schema)
  - HTML atoms (` ```html ... ``` `)
- **Step 1c**: cross-runtime determinism test — run the parser in both
  the browser (Vitest jsdom env) and Convex runtime (via convex-test);
  assert byte-identical PM JSON output. This is Codex's explicit
  requirement: bootstrap races depend on determinism.

### 2. The `collabSessions` table + heartbeat presence

- Schema as defined above
- `_recordCollabPresence({docId, clientId, baseBodyHash})` public
  mutation — gated by `checkRead` semantics (same as prosemirror-sync's
  read gate); client calls every ~30s while editing
- `_cleanupIdleSessions` internal mutation, scheduled every 5min via
  cron: removes rows with `lastSeenAt < now - 90s`, triggers final
  projection, optionally prunes snapshot+deltas for docs idle >24h

### 3. The projection writer

- `replaceAtomBodyForCollabProjection` in new `convex/atomWriter.ts`
- `_projectSnapshotToBody` internalMutation that does the full CAS +
  serialize + replace flow above
- `onSnapshot` callback in `convex/prosemirror.ts` schedules
  `_projectSnapshotToBody` debounced 1500ms

### 4. Conflict handling

- `_handleCollabConflict` flips `frozen: true` on session rows
- Frontend banner reads `useQuery(api.collab.sessionStatus, ...)`,
  shows a reload prompt when `frozen: true`
- Reload tears down + rebootstraps

### 5. AtomEditor bootstrap fix (resolves Codex finding #6)

Currently `useCollabSync` is called with `schema: null` and the editor
mounts from markdown defaultValue. v2:

- Pass the real Crepe schema to `useCollabSync` (need to construct it
  outside Crepe so it's available before mount — Crepe exposes
  `Crepe.getSchema()` or similar; verify in next investigation)
- Gate the editor render on `useCollabSync.bootstrap.ready` — show a
  small skeleton until snapshot resolves
- If the bootstrap derives a PM doc, mount Crepe FROM that doc (not
  from `defaultValue`). Crepe accepts initial state via... TBD; needs
  one more research pass before commit

---

## Open questions for codex (v2)

1. **Is the heartbeat presence model the right floor for "active session"?**
   Are there simpler signals we missed? (e.g., prosemirror-sync's own
   step-submission cadence could imply presence without a separate
   mutation — but cleanup would be harder.)

2. **The conflict policy ("freeze + reload") is the most defensive
   choice. Is there a saner policy we're missing?** Notion's analog
   (concurrent edit from another user) just shows the latest write
   and lets the editor reconcile; but Notion isn't trying to keep
   markdown in sync.

3. **The CAS uses sha256 of the body string. Is this the right witness,
   or should we use `atom.updatedAt` (a Convex-monotonic timestamp)?**
   updatedAt is cheaper but doesn't distinguish "same body, touched"
   from "different body" (e.g. a re-save with the same content).

4. **`collabSessions` cleanup cron at 5min — is that frequent enough?**
   Idle detection at 90s means a tab that hangs for >90s gets its
   session reaped, then the user's next edit goes through a fresh
   bootstrap. Acceptable; document the UX.

5. **Schema extraction for the open-time bootstrap**: Crepe builds the
   PM schema during `new Crepe(...)`. Can we extract the SAME schema
   instance outside Crepe to use in `useCollabSync` BEFORE mount?
   Or do we need to defer the schema-aware bootstrap until after Crepe
   mounts (re-creating the "schema:null + late-install" problem)?

6. **Should `replaceAtomBodyForCollabProjection` also fire the existing
   `userLocked` / `systemLocked` checks?** v2 keeps them in (a
   user-locked atom freezes even from collab). Is that the right
   policy? Or does a live multiplayer session imply implicit unlock?

7. **Bootstrap idempotency under racing inserts**: two clients open
   the same fresh doc, both compute the SAME PM JSON (parser is
   deterministic), both call `submitSnapshot(version:1, content)`.
   The package silently accepts identical content. But what if the
   parsers DIFFER by a single whitespace byte? Throws. Should the
   server-side bootstrap re-normalize / canonicalize the PM JSON
   before submitting?

---

## Implementation plan (revised — depends on Step 1a outcome)

### Step 1a: Convex-runtime serializer DECIDER (~0.5 day)

Push a Convex dev deploy with the test fn. Determines whether we use
remark or hand-roll. **This is the gate; nothing else proceeds until
this is answered.**

### Step 1b: Serializer + parser implementation (~2-3 days, depending on 1a)

Library path: 1 day. Hand-roll path: 2-3 days + ongoing maintenance.

### Step 1c: Cross-runtime determinism test rig (~0.5 day)

### Step 2: collabSessions table + heartbeat (~1 day)

### Step 3: Projection writer + CAS + shared helper (~1.5 days)

### Step 4: Conflict policy + frontend banner (~1 day)

### Step 5: AtomEditor bootstrap fix (~1 day, includes schema extraction
investigation)

### Step 6: End-to-end test rig (two simulated clients) (~1 day)

**Total**: ~8-10 days with library path; ~10-13 days with hand-roll.

This is significantly more than v1's 4-5 day estimate. The increase
comes from:
- Real Convex-runtime serializer proof (was hand-waved)
- collabSessions table + heartbeat (was missing)
- CAS-protected writer + shared helper (was unsafe ctx.db.patch)
- Conflict handling UX (was missing)
- Bootstrap fix (was inherited bug from M1 step 2)

---

## What's safe to ship today (unchanged)

The current state (after dc2968f):
- M1 foundation + adapter + AtomEditor wiring all landed
- Multiplayer flag is UNSET on every callsite
- Single-user behavior is byte-identical to pre-M1
- 1013 tests passing

No user sees multiplayer behavior until someone passes `multiplayerDocId`
to AtomEditor. The plumbing is dormant. **v2 of this architecture must
pass another /codex review pass before anyone approves the build.**

---

## Changes from v1 (Codex finding → v2 response)

| Codex finding | v2 response |
|---|---|
| 1. atoms.body canonical overstated | Reframed as "persistent projection"; snapshot is authoritative during active session |
| 2. ctx.db.patch bypasses side effects | New shared helper `replaceAtomBodyForCollabProjection` fires the full `upsertAtomImpl` chain |
| 3. Race vs concurrent atoms.upsert | New `collabSessions` table + CAS on body hash; conflict triggers freeze+reload, no silent overwrite |
| 4. getDoc callable from internalMutation | Confirmed; no action needed |
| 5. create() not broadly idempotent; version starts at 1 | Bootstrap handles `already-exists` with identical content as success; uses version 1 as initial |
| 6. AtomEditor bootstrap accepts pre-snapshot edits | Editor render gated on `useCollabSync.bootstrap.ready`; schema passed in real (not null) |
| 7. remark Convex-runtime feasibility hand-waved | Step 1a is a hard DECIDER gate: real Convex deploy test before anything else proceeds |
| 8. On-close flush unreliable | Replaced with heartbeat presence (90s expiry); cron cleanup; tab close is NOT correctness path |

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review (v1) | `/codex` against v1 of this doc | Independent 2nd opinion | 1 | REVISE | 8 findings (3 critical), all 8 absorbed in v2 |

**v1 review session**: 019e59a4-4cc8-73e3-a38b-f8ac690422f8

All 8 v1 findings have been addressed in this v2 (see "Changes from v1"
table above for the explicit map). v2 is pending a second `/codex` pass.

**UNRESOLVED (v2 questions for codex)**: 7 open design questions listed
above. Critical decision: Step 1a (Convex-runtime serializer feasibility)
gates the entire implementation plan.

**VERDICT**: v2 PROPOSED — awaiting second codex review pass before build.
