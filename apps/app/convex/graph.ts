// graph-v1 (Track-5 1c) — the knowledge graph data. A "cell" = a file
// (atom); its "atoms" = the inline {key: value} data inside it. Edges
// connect cells via wikilinks ([[…]]) and concrete formula references
// ({= … }). PURE-ish read: one atomIds scan + one capped atom scan,
// derived entirely from the bodies (the source of truth). Owner-
// scoped; the "company graph" (1c org layer) is a separate concern.
import { query } from './_generated/server'
import { requireWorkspace } from './auth'
import {
  parseInlineAtomsFromMarkdown,
  type InlineAtom,
} from './inlineAtom'
import {
  isNonDataAtom,
  extractFrontmatterId,
  deriveTitle,
  formulaConcreteFileId,
} from './atomId'
import { ownerAtomByFileId } from './atomShares'
import { viewerOrgIds } from './orgs'

const NOTE_SCAN_CAP = 5000
// Escape-TOLERANT wikilink matcher — Crepe stores a user-typed
// `[[a/b]]` as `\[\[a/b]]` (escaped opening brackets), so the bare
// `[[…]]` form alone misses every editor-authored link (codex
// completeness gap #1). Mirrors the cascade's regex in atoms.move.
const WIKILINK = /\\?\[\\?\[([^\\\]\n|]+)(?:\|[^\]\n]*)?\\?\]\\?\]/g

export type GraphNode = {
  /** UNIQUE node identity. Personal nodes use the fileId (unique in
   *  the own workspace); shared nodes use `<ownerWs>::<fileId>` —
   *  fileId is owner-NAMESPACED, so a bare fileId collides across
   *  owners (codex 1c review P1). Edges reference these ids. */
  id: string
  fileId: string
  title: string
  path: string
  atoms: Array<{ key: string; value: string }>
  kind: 'personal' | 'shared'
  /** for shared nodes — how to open it */
  shareId?: string
}
export type GraphEdge = {
  source: string
  target: string
  kind: 'link' | 'formula'
}

function valueAtoms(body: string): Array<{ key: string; value: string }> {
  return parseInlineAtomsFromMarkdown(body)
    .filter((x): x is Extract<InlineAtom, { kind: 'value' }> => x.kind === 'value')
    .map((x) => ({ key: x.key, value: String(x.value) }))
}

function leafOf(path: string): string {
  return path.replace(/\.[a-z0-9]+$/i, '').split('/').pop() ?? path
}

// My own cells + their atoms + the edges between them.
export const personalGraph = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> => {
    const ws = await requireWorkspace(ctx)
    const idRows = await ctx.db
      .query('atomIds')
      .withIndex('by_workspace_fileId', (q) => q.eq('workspaceId', ws))
      .collect()
    const pathToFileId = new Map<string, string>()
    for (const r of idRows) {
      if (r.state === 'bound' && r.path) pathToFileId.set(r.path, r.fileId)
    }
    const atoms = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', ws))
      .take(NOTE_SCAN_CAP + 1)

    const nodes: GraphNode[] = []
    const known = new Set<string>()
    for (const a of atoms) {
      const body = a.body ?? ''
      if (isNonDataAtom(a.path, body)) continue
      const fid = pathToFileId.get(a.path)
      if (!fid || extractFrontmatterId(body) !== fid) continue
      known.add(fid)
      nodes.push({
        id: fid, // unique within the own workspace
        fileId: fid,
        title: deriveTitle(body, a.path) ?? leafOf(a.path),
        path: a.path,
        atoms: valueAtoms(body),
        kind: 'personal',
      })
    }

    const edges: GraphEdge[] = []
    const seen = new Set<string>()
    const addEdge = (s: string, t: string, kind: 'link' | 'formula') => {
      if (s === t || !known.has(t)) return
      const k = `${s}->${t}:${kind}`
      if (seen.has(k)) return
      seen.add(k)
      edges.push({ source: s, target: t, kind })
    }
    for (const a of atoms) {
      const fid = pathToFileId.get(a.path)
      if (!fid || !known.has(fid)) continue
      const body = a.body ?? ''
      // wikilink edges
      WIKILINK.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = WIKILINK.exec(body)) !== null) {
        const raw = m[1].trim()
        const cand = pathToFileId.get(raw) ?? pathToFileId.get(`${raw}.md`)
        if (cand) addEdge(fid, cand, 'link')
      }
      // concrete formula-reference edges
      for (const atom of parseInlineAtomsFromMarkdown(body)) {
        if (atom.kind !== 'formula') continue
        const ref = formulaConcreteFileId(atom)
        if (ref) addEdge(fid, ref, 'formula')
      }
    }
    return { nodes, edges }
  },
})

// The "company" view (1c v1): cells shared WITH me, each rendered as
// a node with its atoms (resolved through the gated share path). The
// full org-wide graph needs the org/membership layer; this surfaces
// the cross-workspace data the viewer is actually entitled to see.
// Composite node id for a shared cell: fileId is owner-namespaced, so
// it MUST be qualified by the owner to be unique + to keep edges from
// crossing owners (codex 1c review P1).
const qualify = (ownerWs: string, fileId: string) => `${ownerWs}::${fileId}`

export const sharedGraph = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> => {
    const viewer = await requireWorkspace(ctx)
    // by_grantee already restricts to the viewer's OWN grants — so we
    // don't need resolveShareAccess per node (which re-collects all
    // grants → O(n²)); the index IS the authorization. Resolve each
    // owner atom ONCE + reuse for nodes + edges.
    const grants = await ctx.db
      .query('atomShares')
      .withIndex('by_grantee', (q) => q.eq('granteeWorkspaceId', viewer))
      .take(NOTE_SCAN_CAP)
    const nodes: GraphNode[] = []
    const known = new Set<string>()
    // per-owner path → qualified node id, for resolving wikilink
    // targets among the shared cells (full path + extensionless).
    const pathToNode = new Map<string, string>()
    const resolved: Array<{
      ownerWs: string
      fileId: string
      body: string
    }> = []
    for (const g of grants) {
      const atom = await ownerAtomByFileId(ctx, g.ownerWorkspaceId, g.fileId)
      if (!atom) continue
      // §6 unified — a shared view/skill atom's illustrative {k:v}
      // examples are not data (matches personalGraph + the resolver).
      if (isNonDataAtom(atom.path, atom.body)) continue
      const id = qualify(g.ownerWorkspaceId, g.fileId)
      known.add(id)
      pathToNode.set(`${g.ownerWorkspaceId}::${atom.path}`, id)
      pathToNode.set(
        `${g.ownerWorkspaceId}::${atom.path.replace(/\.[a-z0-9]+$/i, '')}`,
        id,
      )
      resolved.push({ ownerWs: g.ownerWorkspaceId, fileId: g.fileId, body: atom.body })
      nodes.push({
        id,
        fileId: g.fileId,
        title: deriveTitle(atom.body, atom.path) ?? leafOf(atom.path),
        path: atom.path,
        atoms: valueAtoms(atom.body),
        kind: 'shared',
        shareId: g._id,
      })
    }
    // Edges only WITHIN the same owner (a formula in owner A's cell
    // can only reference owner A's other cells) AND only when the
    // target is ALSO shared with the viewer — never reveal an
    // unshared owner cell or cross owners.
    const edges: GraphEdge[] = []
    const seen = new Set<string>()
    const addEdge = (sourceId: string, targetId: string, kind: 'link' | 'formula') => {
      if (targetId === sourceId || !known.has(targetId)) return
      const k = `${sourceId}->${targetId}:${kind}`
      if (seen.has(k)) return
      seen.add(k)
      edges.push({ source: sourceId, target: targetId, kind })
    }
    for (const r of resolved) {
      const sourceId = qualify(r.ownerWs, r.fileId)
      // formula-reference edges (concrete fileId, same owner)
      for (const inline of parseInlineAtomsFromMarkdown(r.body)) {
        if (inline.kind !== 'formula') continue
        const ref = formulaConcreteFileId(inline)
        if (ref) addEdge(sourceId, qualify(r.ownerWs, ref), 'formula')
      }
      // wikilink edges — resolve the target PATH among the shared
      // cells of the SAME owner (never reveals an unshared target).
      WIKILINK.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = WIKILINK.exec(r.body)) !== null) {
        const raw = m[1].trim()
        const targetId =
          pathToNode.get(`${r.ownerWs}::${raw}`) ??
          pathToNode.get(`${r.ownerWs}::${raw.replace(/\.[a-z0-9]+$/i, '')}`)
        if (targetId) addEdge(sourceId, targetId, 'link')
      }
    }
    return { nodes, edges }
  },
})

// sharing-v1 1c — the COMPANY graph: cells members explicitly shared
// TO an org the viewer belongs to (granteeOrgId). Private files never
// appear (opt-in only). Same gating as sharedGraph: each cell is
// resolved through the owner's index (ownerAtomByFileId), nodes are
// owner-qualified, edges only connect cells shared to the SAME org by
// the SAME owner — never reveals an unshared cell.
export const companyGraph = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> => {
    const viewer = await requireWorkspace(ctx)
    const orgIds = await viewerOrgIds(ctx, viewer)
    if (orgIds.size === 0) return { nodes: [], edges: [] }

    // org-share rows for every org the viewer belongs to (capped).
    const grants: Array<{
      _id: string
      ownerWorkspaceId: string
      fileId: string
    }> = []
    for (const orgId of orgIds) {
      const rows = await ctx.db
        .query('atomShares')
        .withIndex('by_org', (q) => q.eq('granteeOrgId', orgId))
        .take(NOTE_SCAN_CAP)
      for (const r of rows) {
        grants.push({
          _id: r._id,
          ownerWorkspaceId: r.ownerWorkspaceId,
          fileId: r.fileId,
        })
      }
    }

    const nodes: GraphNode[] = []
    const known = new Set<string>()
    const pathToNode = new Map<string, string>()
    const resolved: Array<{ ownerWs: string; fileId: string; body: string }> =
      []
    const seenNode = new Set<string>()
    for (const g of grants) {
      const id = qualify(g.ownerWorkspaceId, g.fileId)
      if (seenNode.has(id)) continue // a cell shared to >1 of my orgs
      const atom = await ownerAtomByFileId(ctx, g.ownerWorkspaceId, g.fileId)
      if (!atom) continue
      if (isNonDataAtom(atom.path, atom.body)) continue
      seenNode.add(id)
      known.add(id)
      pathToNode.set(`${g.ownerWorkspaceId}::${atom.path}`, id)
      pathToNode.set(
        `${g.ownerWorkspaceId}::${atom.path.replace(/\.[a-z0-9]+$/i, '')}`,
        id,
      )
      resolved.push({ ownerWs: g.ownerWorkspaceId, fileId: g.fileId, body: atom.body })
      nodes.push({
        id,
        fileId: g.fileId,
        title: deriveTitle(atom.body, atom.path) ?? leafOf(atom.path),
        path: atom.path,
        atoms: valueAtoms(atom.body),
        kind: 'shared',
        shareId: g._id, // opens via /shared/<orgShareId> (membership-gated)
      })
    }

    const edges: GraphEdge[] = []
    const seen = new Set<string>()
    const addEdge = (s: string, t: string, kind: 'link' | 'formula') => {
      if (t === s || !known.has(t)) return
      const k = `${s}->${t}:${kind}`
      if (seen.has(k)) return
      seen.add(k)
      edges.push({ source: s, target: t, kind })
    }
    for (const r of resolved) {
      const sourceId = qualify(r.ownerWs, r.fileId)
      for (const inline of parseInlineAtomsFromMarkdown(r.body)) {
        if (inline.kind !== 'formula') continue
        const ref = formulaConcreteFileId(inline)
        if (ref) addEdge(sourceId, qualify(r.ownerWs, ref), 'formula')
      }
      WIKILINK.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = WIKILINK.exec(r.body)) !== null) {
        const raw = m[1].trim()
        const targetId =
          pathToNode.get(`${r.ownerWs}::${raw}`) ??
          pathToNode.get(`${r.ownerWs}::${raw.replace(/\.[a-z0-9]+$/i, '')}`)
        if (targetId) addEdge(sourceId, targetId, 'link')
      }
    }
    return { nodes, edges }
  },
})
