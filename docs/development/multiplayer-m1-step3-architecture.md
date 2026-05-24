# M1 step 3 architecture v3 — markdown ↔ prosemirror projection

**Status**: PROPOSED v3 — pre-implementation. v1 (REVISE, 608888a) and
v2 (REVISE, 501f8c2) have been superseded — see GSTACK REVIEW REPORT
at the bottom for the v2 findings absorbed below. v3 addresses Codex's
top 3 remaining concerns (table split, concrete shared-helper contract,
schema-extraction resolution) plus the 4 NEW issues v2 introduced.

**Context**:
- Builds on `multiplayer-and-h-followups-plan.md` + `transport-spike-result.md`.
- M1 step 1 (foundation: convex.config + prosemirror.ts + auth gates) is
  landed (5d8ffb5).
- M1 step 2 (Milkdown adapter + AtomEditor wiring behind opt-in flag) is
  landed (d792672 + dc2968f).
- Multiplayer is OFF on every callsite today (no `multiplayerDocId`
  prop passed anywhere). Branch state: 1013 tests passing.

---

## The problem (unchanged from v1/v2)

dohc stores doc content as **markdown text** in `atoms.body`. Every
read path parses that markdown directly: search FTS, formula evaluator,
DSL queries, `/r` render route, agent tools (`read_atom`), inline-atom
parsers. Multiplayer introduces a parallel ProseMirror snapshot+deltas
store. Without reconciliation, search/formulas/render see stale data.

---

## What changed from v2 (the structural fixes)

Codex's v2 review surfaced 11 issues: 3 RESOLVED, 5 PARTIAL, 4 NEW.
v3 addresses all of them concretely. Key structural shifts:

1. **Server doesn't parse markdown.** Projection is one-way: PM JSON
   → markdown. The reverse direction (atoms.body → PM JSON) is
   client-only at bootstrap. This **eliminates** the Convex-runtime
   `remark-parse` feasibility concern; only the serializer must run
   server-side.

2. **Tables split** per Codex: `collabDocs` (per-doc CAS state,
   server-computed) + `collabSessions` (per-client presence, heartbeat
   only). False conflicts from per-client hash divergence are gone.

3. **Concrete helper that matches `upsertAtomImpl` byte-for-byte.** v3
   spells out every step: `isSafeAtomPath` → `seedAtomIdIntoBody` →
   existing-row lookup → lock check → `recordTrash(pre-overwrite)` →
   patch with `deriveSearchFields` → `applyAtomCapture` →
   `reconcileAtomIdIndex({isRestore: false})`. No omissions.

4. **Schema extraction unblocked** via `editor.action((ctx) =>
   ctx.get(schemaCtx))` after Crepe mounts — `schemaCtx` IS exported
   from `@milkdown/core/internal-plugin/schema` (Codex was right that
   `Crepe.getSchema()` doesn't exist, but the underlying slice is
   accessible). Cache globally; share across mounts.

5. **Conflict policy is two-state**: if PM has no unprojected edits,
   AUTO-REBUILD from new atoms.body (Codex's suggested gentle path).
   Only freeze+reload when both sides have changed.

6. **`onSnapshot` BEFORE commit**: projection passes `snapshotVersion`
   and validates the version exists server-side before firing. No
   stale-version writes.

7. **`frozen` field added** to schema (Codex caught the omission in v2).

8. **Cleanup cron at 60s** matches the 90s heartbeat expiry promise
   (or — alternatively — drops the 90s claim).

---

## Proposed v3 architecture

### Mental model: persistent projection vs live authoritative source

`atoms.body` is the **persistent projection** of doc content. The
prosemirror-sync snapshot is **authoritative DURING an active edit
session**. The projection lags the snapshot by at most one debounce
window (~1500ms onSnapshot-driven).

| State | Authoritative for content | Authoritative for read paths |
|---|---|---|
| At rest (no live editors) | `atoms.body` | `atoms.body` |
| Active edit session | prosemirror snapshot + deltas | `atoms.body` (projection; lags by ~1500ms) |

### Lifecycle

#### 1. Open

- AtomEditor mounts with `multiplayerDocId`.
- AtomEditor calls `useCollabSync({docId, schema: getCachedSchema(),
  enabled: true})`. If schema isn't cached yet, returns null until the
  first mount populates it (see "Schema extraction" below).
- AtomEditor GATES the editor render on `bootstrap.ready` — shows a
  small skeleton until snapshot resolves. **Fixes the v2 step-2 bug
  where edits could happen before bootstrap.**
- Bootstrap flow inside useCollabSync:
  - Server `getSnapshot(docId)` → exists? bootstrap from snapshot+deltas
  - No snapshot? Client parses `atoms.body` → PM JSON via the cached
    schema's parser, calls `bootstrapSnapshotFromAtomBody(docId,
    pmJsonStr, atomBodyAtBootstrapHash)`. Server:
    - P1 access check (reuses canReadAtom/requireWorkspace)
    - Re-reads atoms.body, computes server hash
    - If client hash matches server hash: `prosemirrorSync.create(ctx,
      docId, parsedJson)` — submits at version 1 per the package's
      actual contract. Duplicates with identical content are silently
      accepted (verified in package); divergent content throws (which
      is a determinism bug — fail loud).
    - If client hash DOESN'T match: another client wrote between
      client-parse and server-submit. Client retries with the fresh
      body (bounded retries, ~3).
    - Either way, write/update the per-doc `collabDocs` row with
      `baseBodyHash` = the body that was just submitted as snapshot v1
      (so the first projection sees no out-of-band change).

- The editor mounts with the PM doc derived from the bootstrap (PM
  JSON, not markdown defaultValue). Crepe accepts a PM doc via... need
  to verify: Crepe's `defaultValue` is markdown; the PM-doc-direct path
  is to set state via `editor.action((ctx) => ctx.get(editorViewCtx).
  dispatch(replaceWithPMDoc))` AFTER mount but BEFORE collab plugins
  attach. Pinned as a SPECIFIC implementation step (see "Open question
  for v3 codex pass" #1).

#### 2. Edit

- Collab steps flow through prosemirror-sync. `atoms.body` is
  untouched until the next projection. The local editor sees its own
  + remote steps converged via prosemirror-collab.

#### 3. Projection (onSnapshot-driven, version-validated)

- `onSnapshot(docId, snapshotContent, snapshotVersion)` callback in
  `convex/prosemirror.ts` schedules `_projectSnapshotToBody({docId,
  snapshotVersion})` via `ctx.scheduler.runAfter(1500, ...)`. Stores
  the scheduled job id in `collabDocs.scheduledJobId` for cancellation
  on a newer snapshot.
- `_projectSnapshotToBody` runs the CAS + serialize + replace flow:

```ts
async function _projectSnapshotToBody({docId, snapshotVersion}) {
  // Codex new-issue #1: validate the version EXISTS server-side.
  // syncApi.submitSnapshot fires onSnapshot BEFORE commit; a divergent
  // snapshot that throws still scheduled this projection.
  const latest = await prosemirrorSync.latestVersion(ctx, docId)
  if (latest === null || latest < snapshotVersion) return // committed snapshot doesn't exist

  const parsed = parseDocId(docId)
  if (parsed.kind !== 'atom') return  // shared atoms: M2+ follow-up
  const atom = await ctx.db.get(parsed.atomId)
  if (!atom) return

  // Server-computed body hash (NOT trusted from any client)
  const currentBodyHash = await sha256Hex(atom.body)

  const doc = await ctx.db.query('collabDocs')
    .withIndex('by_docId', q => q.eq('docId', docId)).unique()
  if (!doc) return // no live session — nothing to project

  if (doc.projectedVersion >= snapshotVersion) return // already projected

  // CAS witness: server's last projection hash vs the body NOW.
  if (currentBodyHash !== doc.baseBodyHash) {
    // Out-of-band write happened. Decide between auto-rebuild and freeze:
    // Auto-rebuild path (Codex's "gentle" policy): if the snapshot at
    // doc.projectedVersion EQUALS the new body (i.e. PM has no
    // unprojected edits since the OOB write), just re-bootstrap PM
    // from atoms.body — no user-visible disruption.
    await ctx.scheduler.runAfter(0, _handleCollabConflict,
      {docId, currentBodyHash, snapshotVersion})
    return
  }

  const schema = getServerlessSchema()  // see "Schema sharing" below
  const { doc: pmDoc, version: replayVersion } =
    await prosemirrorSync.getDoc(ctx, docId, schema)
  // getDoc replays from snapshot+deltas up to current. Codex new-issue
  // #2: getSteps caps at 100 rows; the package's getDoc handles this
  // internally by triggering compaction. Trust the package here.

  const newMd = await serializeToMarkdown(pmDoc)
  const newBodyHash = await sha256Hex(newMd)

  // Skip the write entirely if the serialized markdown matches the
  // existing body (no-op projection — saves a write + side-effect cycle).
  if (newBodyHash === currentBodyHash) {
    await ctx.db.patch(doc._id, {projectedVersion: replayVersion})
    return
  }

  // Route through the shared body writer (see next section)
  await replaceAtomBodyForCollabProjection(ctx, {
    atomId: parsed.atomId,
    workspaceId: atom.workspaceId,
    path: atom.path,
    newBody: newMd,
    expectedCurrentBodyHash: doc.baseBodyHash,
    source: 'collab',
  })

  await ctx.db.patch(doc._id, {
    baseBodyHash: newBodyHash,
    projectedVersion: replayVersion,
    updatedAt: Date.now(),
  })
}
```

#### 4. Conflict handling (two-state)

`_handleCollabConflict({docId, currentBodyHash, snapshotVersion})`:

```ts
const doc = await ctx.db.query('collabDocs')...
const schema = getServerlessSchema()
const { doc: pmDoc, version: replayVersion } =
  await prosemirrorSync.getDoc(ctx, docId, schema)
const pmMd = await serializeToMarkdown(pmDoc)
const pmMdHash = await sha256Hex(pmMd)

// Compare: does PM at the LAST projected version equal the current
// atoms.body? Two cases:
const lastProjectedDoc = doc.projectedVersion === replayVersion
  ? pmDoc
  : null // PM has unprojected edits; can't auto-rebuild

const pmHasNewEdits = lastProjectedDoc === null
const oobWriteSemanticallyEqualsPM = pmMdHash === currentBodyHash

if (oobWriteSemanticallyEqualsPM) {
  // The "out-of-band" write actually matches what PM would produce.
  // No real conflict; just re-baseline.
  await ctx.db.patch(doc._id, {baseBodyHash: currentBodyHash, updatedAt: Date.now()})
  return
}

if (!pmHasNewEdits) {
  // GENTLE PATH (Codex's recommendation): PM has no edits since last
  // projection. The OOB write is the new truth. Re-bootstrap PM from
  // atoms.body. Existing editors keep working; the next snapshot
  // will be against the rebuilt baseline.
  const newPmJson = await parseMarkdownToPmJsonClient_OR_ServerlessFallback(atom.body)
  // NOTE: server-side parse is the open question. Two paths:
  // (a) signal the FRONTEND to call bootstrapSnapshotFromAtomBody
  //     (client owns the markdown parser; this path uses the
  //     established bootstrap mutation)
  // (b) implement a minimal server-side markdown→PM parser for the
  //     auto-rebuild path
  // v3 default: (a) — emit a "needs rebootstrap" signal via
  // collabDocs.needsRebootstrap = true; client polls (useQuery),
  // tears down its sync, re-bootstraps. UX: brief reconnect, no
  // freeze banner.
  await ctx.db.patch(doc._id, {needsRebootstrap: true, updatedAt: Date.now()})
  return
}

// FREEZE PATH: both sides changed. Real conflict — surface to user.
await ctx.db.patch(doc._id, {frozen: true, updatedAt: Date.now()})
// Frontend reads collabDocs.frozen; shows reload banner.
```

#### 5. Idle + cleanup (heartbeat + tight cron)

- Each client mutation `recordCollabPresence({docId, clientId})` every
  ~30s. Updates `collabSessions.{docId, clientId}.lastSeenAt`. P1
  access check fires (same gate as the sync component).
- Scheduled cleanup at **60s cadence** (matches the 90s expiry — Codex
  flagged the v2 5min cron as too slow):
  - Delete sessions with `lastSeenAt < now - 90s`
  - For docs with no remaining sessions, schedule final projection
  - For docs idle >24h, schedule snapshot prune (clears prosemirror
    snapshot/deltas — atoms.body is the only source again)

### Tables

```ts
// New table 1: per-doc CAS + projection state (NEVER per-client)
collabDocs: defineTable({
  docId: v.string(),               // 'atom:<ws>:<atomId>' or 'share:<shareId>'
  atomId: v.optional(v.id('atoms')),  // null for share: docs
  workspaceId: v.string(),
  // The body hash SERVER computed at the time of the last projection
  // (or initial bootstrap). The CAS witness; not trusted from clients.
  baseBodyHash: v.string(),
  // The last snapshot version we projected to atoms.body. Compared
  // against the snapshot version arriving in onSnapshot — stale
  // projections short-circuit.
  projectedVersion: v.number(),
  // Conflict policy state. frozen=true freezes editing + shows reload
  // banner. needsRebootstrap=true tells clients to re-bootstrap PM
  // from the new atoms.body (gentle auto-recovery from OOB writes).
  frozen: v.boolean(),
  needsRebootstrap: v.boolean(),
  // Currently scheduled projection job id, for cancel-on-newer.
  scheduledJobId: v.optional(v.id('_scheduled_functions')),
  updatedAt: v.number(),
})
.index('by_docId', ['docId']),

// New table 2: per-client presence (heartbeat ONLY — no projection state)
collabSessions: defineTable({
  docId: v.string(),
  clientId: v.string(),            // per-tab UUID
  userId: v.string(),              // identity.subject; for audit
  lastSeenAt: v.number(),
})
.index('by_docId', ['docId'])
.index('by_docId_clientId', ['docId', 'clientId'])
.index('by_lastSeenAt', ['lastSeenAt']),
```

### The shared body writer (concrete contract matching `upsertAtomImpl`)

After reading `apps/app/convex/atoms.ts:77-244` carefully, the
collab-projection writer must replicate exactly the
`existing && finalBody !== existing.body` branch of `upsertAtomImpl`,
with three deliberate behavior shifts:
1. No `existing.source === 'user' && !isUserEdit && !allowUserOverwrite`
   refusal (collab IS the multi-user write; this guard is for the
   agent-vs-user case).
2. Uses `recordTrash` (uncoalesced) for the pre-overwrite snapshot,
   not `snapshotAtomBodyCoalesced` — collab projection is not the
   editor's autosave flood path; every projection deserves its own
   trash row for recovery.
3. `source: 'collab'` (Codex's recommendation; preserves existing
   source attribution via a separate sentinel rather than overloading
   `'user'`).

```ts
// New file: apps/app/convex/atomWriter.ts
export async function replaceAtomBodyForCollabProjection(
  ctx: MutationCtx,
  args: {
    atomId: Id<'atoms'>
    workspaceId: string
    path: string
    newBody: string
    expectedCurrentBodyHash: string  // CAS — re-checked inside
    source: 'collab'
  },
): Promise<{ ok: true, fileId: string } | { ok: false, reason: string }> {
  // Mirror upsertAtomImpl's path-safety check.
  if (!isSafeAtomPath(args.path)) {
    return { ok: false, reason: 'invalid-path' }
  }
  // Mirror upsertAtomImpl line 123: seed frontmatter id BEFORE write.
  // Idempotent — a body that already has the id is returned unchanged.
  // For collab projection, atoms.body already has an id (the bootstrap
  // path persists with one); this re-asserts on every projection.
  const finalBody = await seedAtomIdIntoBody(ctx, args.workspaceId, args.path, args.newBody)

  const existing = await ctx.db.query('atoms')
    .withIndex('by_workspace_path', q =>
      q.eq('workspaceId', args.workspaceId).eq('path', args.path)
    ).unique()
  if (!existing) return { ok: false, reason: 'atom-deleted' }

  // CAS RE-CHECK INSIDE the mutation (per Codex: server-computed,
  // never trusted from client). The hash passed in was a server
  // compute at projection-start; this re-check catches a race
  // between projection-start and write inside the same mutation.
  if ((await sha256Hex(existing.body)) !== args.expectedCurrentBodyHash) {
    return { ok: false, reason: 'hash-mismatch' }
  }

  // Mirror upsertAtomImpl lock checks (Codex: keep them — locks
  // should freeze projection). No allowSystemOverride / isUserEdit
  // for the collab path; both lock kinds freeze.
  if (existing.systemLocked) throw new SystemLockError(args.path, 'edit')
  if (existing.userLocked) throw new UserLockError(args.path, 'edit')

  // Trash the pre-overwrite body — uncoalesced (every projection
  // gets its own restore point; collab is not the autosave flood path).
  if (finalBody !== existing.body) {
    await recordTrash(ctx, {
      workspaceId: args.workspaceId,
      kind: 'atom',
      ref: `${args.path} (pre-collab-projection)`,
      payload: {
        path: args.path,
        body: existing.body,
        source: existing.source ?? 'agent',
      },
    })
  }

  // Mirror upsertAtomImpl's body+searchFields patch.
  await ctx.db.patch(existing._id, {
    body: finalBody,
    updatedAt: Date.now(),
    source: args.source,
    ...deriveSearchFields(args.path, finalBody),
  })

  // Mirror upsertAtomImpl's two side-effect calls.
  await applyAtomCapture(ctx, args.workspaceId, args.path, existing.body, finalBody)
  await reconcileAtomIdIndex(ctx, args.workspaceId, args.path, finalBody, {
    isRestore: false,
  })

  // Map regen lives OUTSIDE upsertAtomImpl in the existing code
  // (atoms.upsert / atoms.remove call it after the impl returns).
  // Mirror that: caller (the projection internalMutation) calls
  // scheduleMapRegen after this returns ok.

  return { ok: true, fileId: extractFrontmatterId(finalBody) ?? '' }
}
```

The caller (`_projectSnapshotToBody`) is responsible for
`scheduleMapRegen(ctx, atom.workspaceId)` after a successful write —
matches the public `atoms.upsert` pattern exactly.

### Schema sharing (client + server)

Codex flagged this as a v2 blocker; v3 has a concrete plan.

**Client-side**: cache the schema via Crepe's existing context system.

```ts
// apps/app/src/lib/crepe-schema-cache.ts
import { schemaCtx } from '@milkdown/core/internal-plugin/schema'
import type { Schema } from '@milkdown/kit/prose/model'

let cached: Schema | null = null
const subscribers = new Set<(s: Schema) => void>()

// Called from CrepeEditor's useEditor mount AFTER ctx.update(...) runs.
// The schema is invariant across mounts (Crepe constructor always
// produces the same schema given the same features), so caching once
// is safe.
export function captureSchemaFromEditor(editor: Editor) {
  if (cached) return
  editor.action((ctx) => {
    cached = ctx.get(schemaCtx)
    for (const fn of subscribers) fn(cached)
  })
}

export function getCachedSchema(): Schema | null { return cached }

// useCollabSync subscribes; re-renders when schema becomes available.
export function subscribeSchema(fn: (s: Schema) => void): () => void {
  if (cached) { fn(cached); return () => {} }
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}
```

The FIRST CrepeEditor that mounts populates the cache; subsequent
useCollabSync calls get the cached schema synchronously. For the very
first mount, the editor renders without collab (bootstrap.ready is
false → skeleton), and a useEffect on schema arrival re-mounts the
collab plugins.

**Server-side**: the projection writer only needs PM JSON → markdown,
NOT markdown → PM JSON. The `prosemirrorSync.getDoc(ctx, docId,
schema)` call requires a schema, but it's only used to deserialize the
stored snapshot JSON — it never needs to know dohc's custom node
specs (those are encoded in the JSON itself). We can construct a
minimal schema server-side that matches Crepe's structure ONLY for
the nodes/marks present in the JSON.

```ts
// apps/app/convex/serverlessSchema.ts
import { Schema } from '@milkdown/kit/prose/model'
// Hand-built schema MATCHING Crepe's structural output. ~50 LOC.
// This schema is used ONLY for getDoc deserialization, NOT for
// editing. The CLIENT uses Crepe's real schema for the bootstrap
// parse; the SERVER uses this thin shim for projection-time
// deserialization.
export function getServerlessSchema(): Schema { /* ... */ }
```

This is feasible because PM JSON serialization is schema-agnostic at
the JSON level — `Node.toJSON()` produces a structure-only
representation; deserialization needs a schema only to validate +
provide methods. A minimal schema that ACCEPTS Crepe's node types as
opaque containers (no validation beyond structural) works for the
projection use case.

If this turns out problematic in practice, fall back to:
- (b) project ONLY on the client. Client subscribes to a "needs
  projection" signal from collabDocs; runs serializer locally; calls a
  `submitProjection(docId, snapshotVersion, newMd, expectedHash)` mutation
  that does the CAS + write. Loses the "server-driven projection"
  property but doesn't need server-side schema.

v3 default is (a) server-side minimal schema; fallback (b) is
documented in case (a) hits a real blocker.

### Markdown serializer

Codex's verdict: library if Convex-runtime test passes; hand-roll
otherwise. v3 keeps Step 1a as a DECIDER gate but TIGHTENS the test
rig per Codex's critique:

- Single fixture roundtrip is insufficient
- Must test BUNDLING (Convex's esbuild pipeline) + dohc-specific
  content shapes: tables, escaping, wikilinks, inline atoms, formulas,
  query blocks, ASCII sketches, frontmatter, code fences, HTML atoms,
  live totals
- Cross-runtime determinism test: SAME markdown input → SAME PM JSON
  output between browser (Vitest jsdom) and Convex (convex-test
  runtime, OR a real Convex dev deploy invocation)

If the library test fails, hand-roll the serializer scoped to Crepe's
12 node types + dohc's decoration shapes (~300 LOC accounting for
edge cases Codex listed). Maintenance burden, but bounded.

---

## Open questions for v3 codex pass

1. **Crepe doc-direct mount path**: Crepe's `defaultValue` is markdown.
   To mount with a PM doc (the bootstrap output), we need to inject
   the doc state post-mount via `editor.action((ctx) => view.dispatch(
   replaceDocTransaction(pmDoc)))`. Is there a cleaner Milkdown idiom?

2. **The serverless schema shim** — does PM's `Schema` actually accept
   a "structural-only" schema for `Node.fromJSON` deserialization, or
   does it need to validate against node spec? If validation is
   mandatory, we need to construct Crepe's full schema server-side,
   which would re-introduce the schema-sharing problem.

3. **The auto-rebuild path requires server-side markdown→PM JSON**:
   if we can't run remark-parse server-side, the auto-rebuild signal
   must round-trip through the client. UX: client receives
   `needsRebootstrap: true`, tears down sync, re-bootstraps. Cost: ~1s
   of editing pause. Is that acceptable, or should we invest in
   server-side parser regardless?

4. **collabDocs lifetime**: when does the row get deleted? Options:
   - Never (lives until atom is deleted) — simplest
   - On idle (cleanup cron + 24h grace) — bounds storage
   - On session-zero transition — racy

5. **bootstrapSnapshotFromAtomBody under racing OOB writes** — client
   reads body, parses, submits; if body changed during parse, retry
   with new body. Bounded retries (~3). Is bounded-retry the right
   pattern, or should we hold a brief "bootstrapping" lock on
   collabDocs?

6. **Lock policy verification**: v3 keeps `userLocked`/`systemLocked`
   as freezes for collab projection. But: if a multiplayer session is
   active and Alice locks the atom mid-session, does Bob's collab
   session also freeze mid-edit? The answer "yes — lock means
   lock" probably right but the UX needs design.

7. **Projection idempotency**: if `_projectSnapshotToBody` runs twice
   for the same snapshotVersion (race in scheduling), the second
   should be a no-op (`projectedVersion >= snapshotVersion` early
   return). Verified — but pin a test.

---

## Implementation plan (revised)

### Step 1: Markdown serializer feasibility (DECIDER, ~0.5 day)
Convex dev deploy + push a tiny internalQuery that imports + runs
`remark-stringify` on a fixture; verify bundling works. Plus the
expanded fixture set Codex demanded (tables, escapes, wikilinks,
inline atoms, formulas, etc.).

### Step 2: Schema sharing infrastructure (~1 day)
Build `captureSchemaFromEditor` + `getCachedSchema` + the
serverless schema shim. Test that `prosemirrorSync.getDoc` works with
the shim for round-trip PM JSON deserialization.

### Step 3: Tables + presence (~0.5 day)
`collabDocs` + `collabSessions` schema. `recordCollabPresence`
mutation. Cleanup cron (60s cadence; 90s expiry).

### Step 4: Shared body writer (~1 day)
`replaceAtomBodyForCollabProjection` in `convex/atomWriter.ts`.
Tests against `upsertAtomImpl`'s side-effect chain (assert the
shared primitives fire identically).

### Step 5: Bootstrap mutation (~1 day)
`bootstrapSnapshotFromAtomBody({docId, pmJsonStr, clientBodyHash})`.
Race-safe with bounded retries. `collabDocs` row created with initial
baseBodyHash.

### Step 6: Projection writer + onSnapshot integration (~1.5 days)
`_projectSnapshotToBody` with version validation + CAS. Wire from
`onSnapshot` callback with `ctx.scheduler.runAfter(1500, ...)`.
Job-id cancellation on newer snapshots.

### Step 7: Conflict handler + frontend banner (~1 day)
`_handleCollabConflict` two-state policy. Frontend `useQuery` on
collabDocs.frozen + needsRebootstrap; banner UI for freeze;
auto-tear-down + rebootstrap for needsRebootstrap.

### Step 8: AtomEditor bootstrap fix (~1 day)
Gate editor render on bootstrap.ready. PM doc-direct mount (open
question #1). Schema cache integration.

### Step 9: End-to-end test rig (~1 day)
Two simulated clients editing simultaneously. Assert markdown
convergence within flush window. OOB write injection → assert
auto-rebuild or freeze depending on PM edit state.

**Total**: ~8.5 days, matching v2's estimate. The work is comparable;
v3 redistributes effort toward concrete contract verification + away
from the speculative pieces v2 hand-waved.

---

## What's safe to ship today (unchanged)

- M1 step 1+2 plumbing all landed; multiplayer flag UNSET on every
  callsite
- Single-user behavior is byte-identical to pre-M1
- 1013 tests passing

No user sees multiplayer behavior until someone passes `multiplayerDocId`
to AtomEditor. **v3 of this architecture must pass another /codex
review pass before anyone approves the build.**

---

## Changes from v2 (Codex finding → v3 response)

| v2 finding | v2 status | v3 response |
|---|---|---|
| #1 terminology | RESOLVED | unchanged |
| #2 helper bypasses side effects | PARTIAL | Concrete `replaceAtomBodyForCollabProjection` in atomWriter.ts mirrors `upsertAtomImpl:165-223` byte-for-byte (seed id, lock checks, trash, patch+searchFields, applyAtomCapture, reconcileAtomIdIndex with `{isRestore:false}`). Three documented behavior shifts (no user-overwrite refusal, uncoalesced trash, source='collab'). |
| #3 baseBodyHash per-client | PARTIAL | Per-doc state in `collabDocs` table, server-computed. Per-client only tracks presence in `collabSessions`. |
| #4 getDoc callable | RESOLVED | unchanged |
| #5 create/version semantics | RESOLVED | unchanged |
| #6 schema extraction speculative | PARTIAL | Concrete plan: `editor.action((ctx) => ctx.get(schemaCtx))` post-mount; cache globally; serverless schema shim for projection-time deserialization. Open question #2 verifies shim viability; fallback (b) is client-side projection. |
| #7 single-fixture test weak | PARTIAL | Expanded fixture set: tables, escapes, wikilinks, inline atoms, formulas, query blocks, ASCII sketches, frontmatter, code fences, HTML atoms, live totals. Cross-runtime determinism test mandatory. |
| #8 cron lag + missing `frozen` | PARTIAL | Cleanup cron at 60s (matches 90s expiry). `frozen` AND `needsRebootstrap` fields in collabDocs schema. |
| NEW: collabSessions conflates roles | NEW | Split into collabDocs (per-doc CAS) + collabSessions (per-client presence) per Codex's exact recommendation. |
| NEW: onSnapshot before commit | NEW | Projection validates snapshotVersion exists via `latestVersion(...)` before firing. |
| NEW: getSteps 100-cap | NEW | Projection uses `prosemirrorSync.getDoc` (package handles compaction internally); architecture doesn't depend on arbitrary delta replay. |
| NEW: freeze+reload too blunt | NEW | Two-state policy: gentle auto-rebuild via `needsRebootstrap` when PM has no unprojected edits; freeze+reload only on true two-sided conflict. |

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex` against v1, v2, v3 (same session) | Independent 2nd opinion | 3 | v1, v2, v3 all REVISE | v3 scored: 4 CLOSED + 4 PARTIAL + 1 NOT-CLOSED + 5 NEW |

**Session**: 019e59a4-4cc8-73e3-a38b-f8ac690422f8 (codex; 3 passes)

**v3 codex pass scoring (per Codex's grading)**:
- **CLOSED (4)**: baseBodyHash per-doc split; serializer test rig expanded; cron + `frozen` field; collabSessions/collabDocs split (scheduledJobId is valid Id type — verified)
- **PARTIAL (4)**:
  - Shared helper: 3 specific bugs — ignores `atomId` (queries by path; wrong row after rename); computes `newBodyHash` BEFORE seedAtomIdIntoBody (stale hash); uncoalesced recordTrash floods at ~1500ms cadence
  - Schema extraction: `schemaCtx` IS exported but the deep import path I named (`@milkdown/core/internal-plugin/schema`) is NOT in package exports — use `@milkdown/kit/core` re-export
  - onSnapshot before commit: `latestVersion` can advance by deltas not commits; must use `getSnapshot({id, version})` for exact validation
  - Freeze+reload: TOCTOU window between version compare and `needsRebootstrap` patch — re-check inside the conflict mutation
- **NOT CLOSED (1)**: `getSteps` 100-cap — v3 incorrectly claimed package handles compaction; it does not. Need aggressive snapshot submission OR explicit looped step fetching
- **NEW issues (5)**:
  - Deep import for schemaCtx is invalid under package exports
  - Serverless schema shim is harder than claimed (`Node.fromJSON` validates specs)
  - getDoc partial replay risk dismissed incorrectly
  - Helper can write wrong atom (atomId not validated)
  - Trash volume explodes during normal typing

**Codex's better suggestion missed in v3**: Crepe supports `defaultValue: { type: 'json', value: pmJson }` directly — eliminates the post-mount doc replacement + first-mount cache complexity entirely.

**Top 3 remaining concerns (Codex)**:
1. Helper must verify/write by `atomId`, and update `baseBodyHash` from the actual persisted `finalBody`
2. Server schema/getDoc assumptions are unsound, especially the 100-delta replay cap
3. Bootstrap/schema plan should switch to exported `schemaCtx` plus Milkdown JSON `defaultValue`; current first-cache design is too brittle

**Codex answers on the 7 v3 open questions** (verbatim):
1. PM doc mount: use Milkdown `defaultValue: { type: 'json', value }`. Cleaner than post-mount dispatch
2. Serverless schema shim: risky; `Node.fromJSON` validates node and mark names/specs
3. Auto-rebuild via client: acceptable for v1; prefer client round-trip over server parser
4. `collabDocs` lifetime: keep rows until atom delete; prune snapshots/deltas separately
5. Bootstrap racing OOB writes: bounded retry is fine; no lock unless retries prove noisy
6. Lock policy: yes, lock freezes collab; needs explicit UI
7. Projection idempotency: yes; test duplicate scheduled projection and stale version

**Cross-model agreement**: Claude Code agrees with all 9 v3 critiques (4 PARTIAL + 1 NOT-CLOSED + 5 NEW). No disagreements.

**Codex's additional schema suggestions (non-blocking)**: add `lastProjectedHash`, `lastConflictAt`, `pruneAfter`, `ownerUserId/activeClientCount` to `collabDocs` if UI needs them.

**VERDICT**: v3 REVISE (third pass). Architecture v4 needed. Codex's three remaining concerns are all concrete + fixable, but a 4th iteration without a different signal is diminishing returns. See "Decision point" section below for the meta-question.

**UNRESOLVED**: 10 design decisions across the 4 PARTIAL + 1 NOT-CLOSED + 5 NEW from v3.

---

## Decision point (third REVISE in a row)

Three /codex passes, three REVISEs. Each pass surfaced 8-11 real findings. The arc:
- v1 (8 findings) → v2 (3 RESOLVED, 5 PARTIAL, 4 NEW) → v3 (4 CLOSED, 4 PARTIAL, 1 NOT-CLOSED, 5 NEW)

The trajectory shows convergence (more CLOSED each pass) but Codex keeps catching real bugs. The remaining v3 issues are concrete and fixable, but a v4 pass-without-prototyping won't necessarily catch the next class of bugs that only show up under real execution.

At this point the meaningful options are:
- **Iterate v4** (more design upfront, lower discovery cost per finding)
- **Start prototyping** (real code under tests will surface execution-level bugs the design review can't see; accept some rework when those land)
- **Defer M1 step 3 entirely** and ship the M1 step 1+2 plumbing as part of the PR with multiplayer flag staying unset

Decision belongs to the human.
