import { ProsemirrorSync } from '@convex-dev/prosemirror-sync'
import { components } from './_generated/api'
import type { QueryCtx, MutationCtx } from './_generated/server'
import { requireWorkspace } from './auth'
import { canReadAtom, canWriteAtomPath } from './atomAccess'
import { resolveShareAccess } from './atomShares'
import type { Id } from './_generated/dataModel'

// M1+M2 (multiplayer-and-h-followups §8) — the SINGLE sync surface
// for collaborative ProseMirror documents. Replaces the previously
// imagined y-websocket Node service per the transport spike
// (docs/development/transport-spike-result.md): native Convex auth
// here ⇒ no separate WS process to deploy, no second auth model to
// maintain, and `transform()` gives us a first-class server-side
// edit path for M3 (AI suggestions).
//
// DOC ID FORMAT (deliberately readable for debugging):
//   `atom:<workspaceId>:<atomDbId>`     ← canonical, workspace-scoped atom
//   `share:<shareId>`                   ← cross-workspace shared atom
//
// We embed the workspaceId in the doc id so checkRead/checkWrite
// can validate ownership without resorting to a side-table lookup
// (and so a malicious client can't poison the id by passing only
// the atomDbId — the workspace check fires in the same transaction).
// The shareId branch is its own namespace; resolveShareAccess gates it.

const COMPONENT_PREFIX_ATOM = 'atom:'
const COMPONENT_PREFIX_SHARE = 'share:'

type ParsedDocId =
  | { kind: 'atom'; workspaceId: string; atomId: Id<'atoms'> }
  | { kind: 'share'; shareId: Id<'atomShares'> }
  | { kind: 'invalid'; reason: string }

/** Parse the wire-format doc id into a structured discriminated
 *  union. Pure / total — never throws. The auth gates use this to
 *  pattern-match on kind. A malformed id collapses to 'invalid' and
 *  every gate denies. */
export function parseDocId(id: string): ParsedDocId {
  if (id.startsWith(COMPONENT_PREFIX_ATOM)) {
    const rest = id.slice(COMPONENT_PREFIX_ATOM.length)
    const colonAt = rest.indexOf(':')
    if (colonAt <= 0 || colonAt === rest.length - 1) {
      return { kind: 'invalid', reason: 'atom-id missing workspace or atom segment' }
    }
    const workspaceId = rest.slice(0, colonAt)
    const atomId = rest.slice(colonAt + 1)
    return { kind: 'atom', workspaceId, atomId: atomId as Id<'atoms'> }
  }
  if (id.startsWith(COMPONENT_PREFIX_SHARE)) {
    const shareId = id.slice(COMPONENT_PREFIX_SHARE.length)
    if (shareId.length === 0) {
      return { kind: 'invalid', reason: 'share-id missing share segment' }
    }
    return { kind: 'share', shareId: shareId as Id<'atomShares'> }
  }
  return { kind: 'invalid', reason: 'unknown id prefix' }
}

/** Build the canonical atom doc id from its parts. The frontend
 *  uses this to derive the id for useTiptapSync (and our Milkdown-
 *  side equivalent). Server-side, it's the inverse of parseDocId. */
export function atomDocId(workspaceId: string, atomId: Id<'atoms'>): string {
  return `${COMPONENT_PREFIX_ATOM}${workspaceId}:${atomId}`
}

/** Same for shared atoms (cross-workspace). */
export function shareDocId(shareId: Id<'atomShares'>): string {
  return `${COMPONENT_PREFIX_SHARE}${shareId}`
}

const prosemirrorSync = new ProsemirrorSync(components.prosemirrorSync)

// Re-export the bound component so server-side AI flows (M3) can
// call `prosemirrorSync.transform(ctx, id, schema, fn)` directly.
export { prosemirrorSync }

// The five required Convex query/mutation endpoints, gated by
// dohc's existing auth model. Auth-throw is the package's documented
// "deny" signal — the client receives a structured error.
export const {
  getSnapshot,
  submitSnapshot,
  latestVersion,
  getSteps,
  submitSteps,
} = prosemirrorSync.syncApi({
  // READ gate. Resolves the doc id, validates the active workspace
  // (the active-workspace check piggybacks on requireWorkspace —
  // same membership rules apply), then runs the P1 read filter for
  // the atom branch.
  //
  // Codex BLOCKER 1 dissolved here: view-only callers can READ but
  // not WRITE (the checkWrite below denies). Without this split,
  // the y-websocket plan had no per-role enforcement.
  async checkRead(ctx: QueryCtx, id: string) {
    const parsed = parseDocId(id)
    if (parsed.kind === 'invalid') throw new Error('Invalid document id.')
    if (parsed.kind === 'share') {
      const access = await resolveShareAccess(ctx, parsed.shareId)
      if (!access) throw new Error('Not authorized.')
      return // shared atom: resolveShareAccess gates BOTH read + write
    }
    // atom: validate workspace + atom-level access.
    const ws = await requireWorkspace(ctx, parsed.workspaceId)
    if (ws !== parsed.workspaceId) {
      // requireWorkspace would have thrown for a non-member; this
      // branch catches a workspace-id mismatch in case requireWorkspace
      // ever silently substitutes (it doesn't today, but the check
      // costs nothing and documents the invariant).
      throw new Error('Workspace mismatch.')
    }
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    if (!(await canReadAtom(ctx, parsed.atomId, viewerSubject))) {
      throw new Error('Not authorized.')
    }
  },

  // WRITE gate. For atoms: same as read, plus canWriteAtomPath
  // (private/restricted blocks writes). For shares: permission
  // must be 'edit'.
  async checkWrite(ctx: MutationCtx, id: string) {
    const parsed = parseDocId(id)
    if (parsed.kind === 'invalid') throw new Error('Invalid document id.')
    if (parsed.kind === 'share') {
      const access = await resolveShareAccess(ctx, parsed.shareId)
      if (!access) throw new Error('Not authorized.')
      if (access.permission !== 'edit') {
        throw new Error('View-only — cannot edit.')
      }
      return
    }
    const ws = await requireWorkspace(ctx, parsed.workspaceId)
    if (ws !== parsed.workspaceId) throw new Error('Workspace mismatch.')
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    // Resolve the atom's current path so canWriteAtomPath can run
    // its existence + folder-cascade check. The atom must exist
    // (collaborative editing on a non-existent doc is meaningless).
    const atom = await ctx.db.get(parsed.atomId)
    if (!atom) throw new Error('Atom not found.')
    if (atom.workspaceId !== parsed.workspaceId) {
      throw new Error('Workspace mismatch.')
    }
    if (
      !(await canWriteAtomPath(ctx, parsed.workspaceId, atom.path, viewerSubject))
    ) {
      throw new Error('Not authorized to edit this atom.')
    }
  },

  // SNAPSHOT hook. Called whenever the sync component persists a
  // fresh snapshot — i.e. when the editor's debounced flush
  // triggers. This is THE markdown-canonical bridge per the spike
  // §"Markdown canonical model": the prosemirror doc state lives in
  // the sync component, but our existing storage layer (atoms.body)
  // still holds markdown. On every snapshot we walk the doc back
  // to markdown and patch the atoms row, so all existing read paths
  // (search.run, evalFormulas, htmlAtoms render, agent tools) keep
  // working unchanged.
  //
  // CRITICAL: this MUST be fast + bounded. A bad serializer would
  // turn every keystroke into an O(doc) walk. The Milkdown adapter
  // (in M1 step 2) will produce a markdown string from the doc
  // JSON — we just patch ctx.db here.
  //
  // For v1 we STAGE this hook: the body update is wired in M1 step 3
  // when the Milkdown serializer is integrated. Today's body is the
  // empty placeholder; the snapshot hook below validates the doc id
  // and atom existence then no-ops on the markdown side.
  async onSnapshot(
    ctx: MutationCtx,
    id: string,
    _snapshot: string,
    _version: number,
  ) {
    const parsed = parseDocId(id)
    if (parsed.kind !== 'atom') return // shared atoms: no body roundtrip yet
    const atom = await ctx.db.get(parsed.atomId)
    if (!atom) return
    if (atom.workspaceId !== parsed.workspaceId) return
    // STAGED: when the Milkdown ↔ ProseMirror serializer lands in
    // M1 step 3, this is where:
    //   const md = prosemirrorJsonToMarkdown(JSON.parse(_snapshot))
    //   await ctx.db.patch(parsed.atomId, { body: md, updatedAt: Date.now() })
    // and the existing upsertAtomImpl side-effects (capture +
    // atomId reconcile) fire via a shared helper. Wiring without
    // the serializer would lose the markdown body — refused until
    // the serializer is proven round-trip-stable.
  },

  // Keep only the initial snapshot + the newest. The deltas table
  // grows linearly between snapshots; pruning keeps the cumulative
  // snapshot table bounded and snapshot replay fast.
  pruneSnapshots: true,
})
