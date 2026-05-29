import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { GraphNode, GraphEdge } from '../../convex/graph'
import { useActiveWorkspaceId } from '@/lib/active-workspace'
import { forceCollide } from 'd3-force-3d'

// graph-v1 1c — the knowledge graph. Cells (files) are nodes; an edge
// is a wikilink or a concrete formula reference. The view merges every
// graph slice visible from the currently selected workspace: owned
// files, files shared directly with that workspace, and workspace-wide
// shared files.
// ForceGraph2D (canvas) is lazy-loaded so the heavy renderer never
// reaches the SSR bundle and only loads when the graph is opened.

type FGNode = GraphNode & { id: string; origin: 'personal' | 'shared' | 'workspace' }
type FGData = { nodes: FGNode[]; links: GraphEdge[] }
const EMPTY_FG: FGData = { nodes: [], links: [] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ForceGraphComponent = ComponentType<any>

// ── floating: a settled graph looks dead, so we keep the engine ticking
// forever (cooldownTicks/Time → Infinity in the JSX below) and add this gentle,
// never-settling drift. forceFloat nudges each node's velocity along two slow,
// incommensurate sine waves per axis with a per-node phase, so the whole
// constellation bobs organically "in space" instead of pulsing in unison. The
// motion is mean-zero — it oscillates, it never accumulates — and collide (which
// is alpha-independent) still guarantees no overlap, so nodes drift close but
// never touch or wander off. Held/dragged nodes (fx/fy set) are skipped so a
// drag stays crisp. FLOAT_ACCEL is the only knob: raise it for more drift.
const FLOAT_ACCEL = 0.02
type SimNode = { vx: number; vy: number; fx?: number | null; fy?: number | null }
function forceFloat() {
  let nodes: SimNode[] = []
  let tick = 0
  return Object.assign(
    () => {
      tick += 1
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]
        if (n.fx != null || n.fy != null) continue
        const p = i * 1.7 // per-node phase offset → unsynchronised drift
        n.vx += FLOAT_ACCEL * (Math.sin(tick * 0.02 + p) + 0.5 * Math.sin(tick * 0.012 + p * 1.7))
        n.vy += FLOAT_ACCEL * (Math.cos(tick * 0.018 + p) + 0.5 * Math.cos(tick * 0.01 + p * 1.7))
      }
    },
    {
      initialize: (n: SimNode[]) => {
        nodes = n
      },
    },
  )
}

// Legend row: a fixed-width swatch column keeps every label left-aligned, with
// the live per-type count right-aligned in mono so the legend doubles as a
// census of what's currently on screen.
function LegendRow({
  swatch,
  label,
  count,
}: {
  swatch: ReactNode
  label: string
  count: number
}) {
  return (
    <div className="flex h-[18px] items-center gap-2">
      <span className="flex w-4 shrink-0 justify-center">{swatch}</span>
      <span className="flex-1 truncate text-[11px] leading-tight text-ink-dim">
        {label}
      </span>
      <span className="font-mono text-[9.5px] tabular-nums text-ink-dim">{count}</span>
    </div>
  )
}

export function GraphView({
  onOpenAtom,
  onOpenShared,
}: {
  onOpenAtom: (path: string) => void
  onOpenShared: (shareId: string) => void
}) {
  const activeWorkspaceId = useActiveWorkspaceId()
  const personal = useQuery(api.graph.personalGraph, { activeWorkspaceId })
  const shared = useQuery(api.graph.sharedGraph, { activeWorkspaceId })
  const workspaceWide = useQuery(api.graph.companyGraph, { activeWorkspaceId })

  // lazy + client-only load of the canvas renderer
  const [FG, setFG] = useState<ForceGraphComponent | null>(null)
  useEffect(() => {
    let alive = true
    void import('react-force-graph-2d').then((m) => {
      if (alive) setFG(() => m.default as unknown as ForceGraphComponent)
    })
    return () => {
      alive = false
    }
  }, [])

  // size the canvas to its container
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // Build the renderer's graph from the scope results, each tagged with the
  // sharing ORIGIN that colours its nodes (Yours / Shared with you / Public in
  // workspace). The backend only knows kind: 'personal' | 'shared' (both the
  // direct-share and workspace-wide slices emit 'shared'), so origin is stamped
  // HERE, per slice.
  //  • CLONE nodes AND links — react-force-graph/d3 mutate link.source/target
  //    (id → node object) in place; cloning keeps the Convex cache pristine.
  //  • Dedupe nodes by id; FIRST slice wins, so precedence is
  //    personal > shared > workspace (a cell shared to me directly AND
  //    workspace-wide reads as the more specific "Shared with you").
  //  • One edge per UNDIRECTED pair. When a pair has both a wikilink and a data
  //    reference, the data (formula) edge WINS — the import/export relationship
  //    is the meaningful one to surface and, unlike a wikilink, it carries
  //    direction. Formula edges are flipped to EXPORTER→IMPORTER here (the
  //    backend stores source = the cell holding the {= } = the importer; target
  //    = the referenced cell = the exporter), so the rendered arrow + particles
  //    point the way data actually flows. degree/neighbours/hover-keys all read
  //    this same orientation — no separate render-time swap.
  const buildFG = (
    graphs: Array<{ origin: FGNode['origin']; nodes: GraphNode[]; edges: GraphEdge[] }>,
  ): FGData => {
    const nodes: FGNode[] = []
    const seenN = new Set<string>()
    const linkByPair = new Map<string, GraphEdge>()
    for (const g of graphs) {
      for (const n of g.nodes) {
        if (seenN.has(n.id)) continue
        seenN.add(n.id)
        nodes.push({ ...n, origin: g.origin })
      }
      for (const e of g.edges) {
        const pair =
          e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`
        const existing = linkByPair.get(pair)
        // keep the first edge for a pair, but UPGRADE a wikilink to a formula.
        // (A mutual data dependency — A {= B} and B {= A} — collapses to one
        //  undirected edge, so only one direction's arrow shows; it's still a
        //  real dependency, just not annotated as bidirectional.)
        if (existing && !(existing.kind === 'link' && e.kind === 'formula')) continue
        linkByPair.set(
          pair,
          e.kind === 'formula'
            ? { source: e.target, target: e.source, kind: 'formula' }
            : { source: e.source, target: e.target, kind: 'link' },
        )
      }
    }
    return { nodes, links: [...linkByPair.values()] }
  }

  const allReady = !!personal && !!shared && !!workspaceWide
  const ready = allReady

  const data: FGData = useMemo(() => {
    return allReady
      ? buildFG([
          { origin: 'personal', ...personal! },
          { origin: 'shared', ...shared! },
          { origin: 'workspace', ...workspaceWide! },
        ])
      : EMPTY_FG
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personal, shared, workspaceWide])

  // ── theme-aware palette (concrete rgb so we can modulate alpha for
  // the hover dim/highlight). Re-read when the theme flips.
  // First-frame defaults in dohc graphite/muted; the effect below reads
  // the live CSS tokens (getComputedStyle normalizes hex → rgb) and
  // re-paints, so these only show for one frame and on theme flips.
  const [palette, setPalette] = useState({
    personal: '45,52,46', // --color-accent (Yours)
    shared: '56,104,166', // --color-folder-blue (Shared with you)
    workspace: '179,112,47', // --color-folder-orange (Public in workspace)
    dataEdge: '102,99,93', // --color-accent-2 (import/export edges)
    label: '139,134,123',
    labelStrong: '10,10,10',
    link: '139,134,123',
  })
  useEffect(() => {
    const host = wrapRef.current
    if (!host) return
    const probe = document.createElement('span')
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    host.appendChild(probe)
    const read = (v: string, fb: string) => {
      probe.style.color = `var(${v})`
      const m = getComputedStyle(probe).color.match(/(\d+)\D+(\d+)\D+(\d+)/)
      return m ? `${m[1]},${m[2]},${m[3]}` : fb
    }
    const refresh = () =>
      setPalette({
        personal: read('--color-accent', '45,52,46'),
        shared: read('--color-folder-blue', '56,104,166'),
        workspace: read('--color-folder-orange', '179,112,47'),
        dataEdge: read('--color-accent-2', '102,99,93'),
        label: read('--color-ink-faint', '139,134,123'),
        labelStrong: read('--color-ink-strong', '10,10,10'),
        link: read('--color-ink-faint', '139,134,123'),
      })
    refresh()
    // explicit theme toggle (data-theme attr) …
    const obs = new MutationObserver(refresh)
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    // … and "system" mode following the OS (no attr change, vars flip)
    const mql = window.matchMedia?.('(prefers-color-scheme: dark)')
    mql?.addEventListener?.('change', refresh)
    return () => {
      obs.disconnect()
      mql?.removeEventListener?.('change', refresh)
      probe.remove()
    }
  }, [])

  // ── degree (node size) + adjacency (hover highlight). idOf handles
  // links whose source/target force-graph has rebound to node objects.
  const idOf = (e: unknown): string =>
    typeof e === 'object' && e !== null
      ? (e as { id: string }).id
      : (e as string)
  const linkKey = (l: { source: unknown; target: unknown; kind: string }) =>
    `${idOf(l.source)}->${idOf(l.target)}:${l.kind}`
  const { degree, neighbors, nodeLinks, counts, titleById } = useMemo(() => {
    const degree = new Map<string, number>()
    const neighbors = new Map<string, Set<string>>()
    const nodeLinks = new Map<string, Set<string>>()
    const titleById = new Map<string, string>()
    // live census → drives the adaptive legend rows + counts
    const counts = { personal: 0, shared: 0, workspace: 0, link: 0, formula: 0 }
    const push = (m: Map<string, Set<string>>, k: string, val: string) => {
      let s = m.get(k)
      if (!s) m.set(k, (s = new Set()))
      s.add(val)
    }
    for (const n of data.nodes) {
      titleById.set(n.id, n.title)
      counts[n.origin] += 1
    }
    for (const l of data.links) {
      const s = idOf(l.source)
      const t = idOf(l.target)
      const k = `${s}->${t}:${l.kind}`
      degree.set(s, (degree.get(s) ?? 0) + 1)
      degree.set(t, (degree.get(t) ?? 0) + 1)
      push(neighbors, s, t)
      push(neighbors, t, s)
      push(nodeLinks, s, k)
      push(nodeLinks, t, k)
      if (l.kind === 'formula') counts.formula += 1
      else counts.link += 1
    }
    return { degree, neighbors, nodeLinks, counts, titleById }
  }, [data])
  // node radius scales with connection count (the Obsidian "hub" look),
  // sqrt so a few very-linked nodes don't dwarf everything.
  const radiusOf = (id: string) => 5 + 2.5 * Math.sqrt(degree.get(id) ?? 0)
  // a small graph shows ALL labels (like Obsidian) — no need to zoom in
  const smallGraph = data.nodes.length <= 40

  // ── hover → highlight the node + its neighbours, dim the rest ──
  const hiNodes = useRef(new Set<string>())
  const hiLinks = useRef(new Set<string>())
  const [hoverId, setHoverId] = useState<string | null>(null)
  const handleHover = (node: { id?: string } | null) => {
    const id = node?.id ?? null
    const hn = new Set<string>()
    const hl = new Set<string>()
    if (id) {
      hn.add(id)
      for (const nb of neighbors.get(id) ?? []) hn.add(nb)
      for (const lk of nodeLinks.get(id) ?? []) hl.add(lk)
    }
    hiNodes.current = hn
    hiLinks.current = hl
    setHoverId(id) // re-render → canvas repaints with the new highlight
    // explicit repaint too — after the engine cools the wrapper stops
    // its render loop, so nudge it (version-robust; codex).
    fgRef.current?.refresh?.()
  }

  // ── physics: a touch more spacing than the defaults + fit-to-view ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null)
  // re-fit the view ONCE per data change (not on every engine stop —
  // that would fight a user who panned/zoomed after a drag).
  const didFit = useRef(false)
  // count animated ticks → fit-to-view once the layout has settled. When
  // floating the engine never "stops", so we can't fit on onEngineStop alone.
  const tickCount = useRef(0)
  // prefers-reduced-motion users get the old settle-and-freeze behaviour, no
  // perpetual float. Lazy-init reads the query synchronously (the renderer is
  // client-only, so window exists here) to avoid a first-frame flash.
  const [reduceMotion, setReduceMotion] = useState(
    () =>
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const mql = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mql) return
    const update = () => setReduceMotion(mql.matches)
    mql.addEventListener?.('change', update)
    return () => mql.removeEventListener?.('change', update)
  }, [])
  useEffect(() => {
    didFit.current = false
    tickCount.current = 0
  }, [data])
  // `FG` is in the deps so this re-runs once the lazily-imported
  // component actually mounts (fgRef populated) — otherwise the tuning
  // could be dropped when data is ready before the import resolves
  // (codex P1).
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || !ready) return
    // "Opposite magnets" layout — three forces balanced so nodes get close
    // but never overlap or clump into an unreadable blob:
    //  • charge  — gentle long-range repulsion (the magnet field). collide
    //    now owns non-overlap, so charge only has to keep clusters distinct.
    //    distanceMin floors the near-field impulse so near-coincident nodes
    //    on load don't rocket apart; distanceMax caps the reach so it stays
    //    a cohesive cluster, not a sparse scatter that fit-to-view shrinks
    //    to dots.
    //  • link    — springs whose REST LENGTH is radius-aware (rS + rT + 16),
    //    so every connected pair settles at the SAME ~16px edge gap whether
    //    leaf or hub (the old flat distance let big hubs swallow neighbours).
    //  • collide — the hard non-overlap core ("never stick"): radius + 6, so
    //    any two nodes keep a ~12px edge gap. Its radius uses
    //    the SAME radiusOf as the renderer so physics and visuals never drift.
    const charge = fg.d3Force?.('charge')
    charge?.strength?.(-45)
    charge?.distanceMin?.(6)
    charge?.distanceMax?.(320)
    // idOf normalises source/target — d3 rebinds them from id strings to
    // node objects in place, and radiusOf needs the id string.
    fg.d3Force?.('link')?.distance?.(
      (l: { source: unknown; target: unknown }) =>
        radiusOf(idOf(l.source)) + radiusOf(idOf(l.target)) + 16,
    )
    // collide isn't created by default — register it (re-set on every data
    // change so it closes over the fresh `degree` map).
    fg.d3Force?.(
      'collide',
      forceCollide<FGNode>()
        .radius((n) => radiusOf(n.id) + 6)
        .strength(0.9)
        .iterations(2),
    )
    // floating: register the gentle drift force (see forceFloat above). The
    // engine is kept ticking forever via the cooldownTicks/Time props below,
    // so the graph keeps bobbing while collide holds the spacing. Reduced-
    // motion users get no float — the engine settles and stops instead.
    fg.d3Force?.('float', reduceMotion ? null : forceFloat())
    fg.d3ReheatSimulation?.()
  }, [FG, ready, data, reduceMotion])

  return (
    <div className="flex h-screen flex-col bg-page">
      <div className="flex items-center gap-2 border-b border-rule px-4 py-2.5">
        <span className="text-[13px] font-semibold text-ink-strong">Graph</span>
        <span className="ml-auto text-[11.5px] text-ink-faint">
          {data.nodes.length} cells · {data.links.length} connections
        </span>
      </div>

      <div ref={wrapRef} className="relative flex-1 overflow-hidden">
        {!FG || !ready || data.nodes.length === 0 ? (
          <div className="grid h-full place-items-center text-ink-faint text-sm">
            {ready && data.nodes.length === 0
              ? 'Nothing to show yet — add some {data} and [[links]], or wait for a cell to be shared with you.'
              : 'loading graph…'}
          </div>
        ) : (
          <FG
            ref={fgRef}
            graphData={data}
            width={size.w || undefined}
            height={size.h || undefined}
            backgroundColor="transparent"
            nodeRelSize={4}
            warmupTicks={30}
            // float forever: never stop the engine, so the graph keeps gently
            // drifting. Reduced-motion users settle and stop at 160 ticks like
            // a static layout.
            cooldownTicks={reduceMotion ? 160 : Infinity}
            cooldownTime={reduceMotion ? 15000 : Infinity}
            d3VelocityDecay={0.32}
            onEngineTick={() => {
              // the floating engine never stops, so fit-to-view here once the
              // layout has settled (~160 ticks) instead of on engine stop.
              if (didFit.current) return
              tickCount.current += 1
              if (tickCount.current >= 160) {
                didFit.current = true
                fgRef.current?.zoomToFit?.(400, 56)
              }
            }}
            onEngineStop={() => {
              // reduced-motion path + safety net: fit once per data set.
              if (didFit.current) return
              didFit.current = true
              fgRef.current?.zoomToFit?.(400, 56)
            }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onNodeHover={(n: any) => handleHover(n)}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onNodeClick={(node: any) => {
              const n = node as FGNode
              if (n.kind === 'shared' && n.shareId) onOpenShared(n.shareId)
              else onOpenAtom(n.path)
            }}
            // tooltip — sharing origin + title + the cell's {} data atoms
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            nodeLabel={(node: any) => {
              const n = node as FGNode
              const origin =
                n.origin === 'personal'
                  ? 'Yours'
                  : n.origin === 'shared'
                    ? 'Shared with you'
                    : 'Public in workspace'
              const atoms = n.atoms
                .slice(0, 8)
                .map((a) => `{${a.key}: ${a.value}}`)
                .join(' ')
              return `${origin}\n${n.title}${atoms ? `\n${atoms}` : ''}`
            }}
            // edge tooltip — names the relationship; data edges read
            // exporter → importer (the direction the value flows).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            linkLabel={(l: any) => {
              if (l.kind !== 'formula') return 'Wikilink'
              const ex = titleById.get(idOf(l.source)) ?? ''
              const im = titleById.get(idOf(l.target)) ?? ''
              return `Import / Export\n${ex} → ${im}`
            }}
            // Two connection types, obviously different:
            //  • wikilink ([[ ]]) — faint, thin, UNDIRECTED hairline.
            //  • import/export ({= }) — a touch darker + heavier + a DIRECTED
            //    arrow (and, on hover, flowing particles) so data dependencies
            //    read as "pipes", not "threads". Brighten the hovered node's
            //    connections, fade the rest.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            linkColor={(l: any) => {
              const isData = l.kind === 'formula'
              const c = isData ? palette.dataEdge : palette.link
              if (!hoverId) return `rgba(${c},${isData ? 0.42 : 0.2})`
              return hiLinks.current.has(linkKey(l))
                ? `rgba(${c},${isData ? 0.95 : 0.85})`
                : `rgba(${c},${isData ? 0.06 : 0.04})`
            }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            linkWidth={(l: any) => {
              const hi = !!hoverId && hiLinks.current.has(linkKey(l))
              const isData = l.kind === 'formula'
              return hi ? (isData ? 2.5 : 2) : isData ? 1.5 : 1
            }}
            // directed arrow on import/export edges only (data flows
            // exporter → importer; endpoints are pre-swapped in buildFG).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            linkDirectionalArrowLength={(l: any) => (l.kind === 'formula' ? 4 : 0)}
            linkDirectionalArrowRelPos={1}
            linkDirectionalArrowColor={() => `rgb(${palette.dataEdge})`}
            // a "live data" flourish: particles travel the hovered data edge.
            // Hover-only (0 at idle) keeps the perpetual-float engine cheap;
            // off entirely under reduced-motion.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            linkDirectionalParticles={(l: any) =>
              !reduceMotion &&
              l.kind === 'formula' &&
              hoverId &&
              hiLinks.current.has(linkKey(l))
                ? 2
                : 0
            }
            linkDirectionalParticleWidth={2.2}
            linkDirectionalParticleColor={() => `rgb(${palette.dataEdge})`}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            nodeCanvasObject={(
              node: any,
              ctx: CanvasRenderingContext2D,
              scale: number,
            ) => {
              const n = node as FGNode & { x: number; y: number }
              const r = radiusOf(n.id)
              const hovering = hoverId !== null
              const isHi = hiNodes.current.has(n.id)
              const dim = hovering && !isHi
              const rgb =
                n.origin === 'personal'
                  ? palette.personal
                  : n.origin === 'shared'
                    ? palette.shared
                    : palette.workspace
              // node circle — drawn in world space so it scales with
              // zoom (Obsidian-style). Dim when another node is focused.
              ctx.globalAlpha = dim ? 0.12 : 1
              ctx.beginPath()
              ctx.arc(n.x, n.y, r, 0, 2 * Math.PI)
              ctx.fillStyle = `rgb(${rgb})`
              ctx.fill()
              // ring around the focused node
              if (hovering && n.id === hoverId) {
                ctx.globalAlpha = 0.9
                ctx.lineWidth = 1.5 / scale
                ctx.strokeStyle = `rgb(${rgb})`
                ctx.beginPath()
                ctx.arc(n.x, n.y, r + 2, 0, 2 * Math.PI)
                ctx.stroke()
              }
              // label — fades in with zoom; always shown for the
              // highlighted set, hidden for the dimmed rest.
              let labelAlpha =
                isHi || smallGraph
                  ? 1
                  : Math.max(0, Math.min(1, (scale - 0.45) / 0.5))
              if (dim) labelAlpha = 0
              if (labelAlpha > 0.02) {
                ctx.globalAlpha = labelAlpha
                ctx.font = `${11 / scale}px 'Aptos', ui-sans-serif, system-ui, sans-serif`
                ctx.textAlign = 'center'
                ctx.textBaseline = 'top'
                ctx.fillStyle =
                  n.id === hoverId
                    ? `rgb(${palette.labelStrong})`
                    : `rgb(${palette.label})`
                ctx.fillText(n.title, n.x, n.y + r + 1)
              }
              ctx.globalAlpha = 1
            }}
            // hit area matches the drawn circle
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            nodePointerAreaPaint={(
              node: any,
              color: string,
              ctx: CanvasRenderingContext2D,
            ) => {
              const n = node as FGNode & { x: number; y: number }
              ctx.globalAlpha = 1
              ctx.fillStyle = color
              ctx.beginPath()
              ctx.arc(n.x, n.y, radiusOf(n.id) + 2, 0, 2 * Math.PI)
              ctx.fill()
            }}
          />
        )}

        {/* Legend — always on, but adaptive: only rows present in the current
            graph render, so a solo personal user sees just "Yours" + "Wikilink".
            DOM reads CSS tokens directly so it flips with the theme for free. */}
        {ready && data.nodes.length > 0 && (
          <div
            className="pointer-events-none absolute bottom-3 left-3 select-none rounded-[10px] border border-rule shadow-sm backdrop-blur-[2px]"
            style={{
              maxWidth: 190,
              padding: '10px 12px',
              background: 'color-mix(in srgb, var(--color-surface) 92%, transparent)',
            }}
            aria-label="Graph legend"
          >
            {counts.personal + counts.shared + counts.workspace > 0 && (
              <>
                <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-dim">
                  Cells
                </div>
                {counts.personal > 0 && (
                  <LegendRow
                    label="Yours"
                    count={counts.personal}
                    swatch={
                      <span
                        className="size-2 rounded-full"
                        style={{ background: 'var(--color-accent)' }}
                      />
                    }
                  />
                )}
                {counts.shared > 0 && (
                  <LegendRow
                    label="Shared with you"
                    count={counts.shared}
                    swatch={
                      <span
                        className="size-2 rounded-full"
                        style={{ background: 'var(--color-folder-blue)' }}
                      />
                    }
                  />
                )}
                {counts.workspace > 0 && (
                  <LegendRow
                    label="Public in workspace"
                    count={counts.workspace}
                    swatch={
                      <span
                        className="size-2 rounded-full"
                        style={{ background: 'var(--color-folder-orange)' }}
                      />
                    }
                  />
                )}
              </>
            )}

            {counts.link + counts.formula > 0 &&
              counts.personal + counts.shared + counts.workspace > 0 && (
                <div className="my-1.5 border-t border-rule" />
              )}

            {counts.link + counts.formula > 0 && (
              <>
                <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-dim">
                  Connections
                </div>
                {counts.link > 0 && (
                  <LegendRow
                    label="Wikilink"
                    count={counts.link}
                    swatch={
                      <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden="true">
                        <line
                          x1="0"
                          y1="4"
                          x2="16"
                          y2="4"
                          stroke="var(--color-ink-faint)"
                          strokeWidth="1"
                          strokeOpacity="0.6"
                        />
                      </svg>
                    }
                  />
                )}
                {counts.formula > 0 && (
                  <LegendRow
                    label="Import / Export"
                    count={counts.formula}
                    swatch={
                      <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden="true">
                        <line
                          x1="0"
                          y1="4"
                          x2="11"
                          y2="4"
                          stroke="var(--color-accent-2)"
                          strokeWidth="1.5"
                        />
                        <path d="M10 1 L15 4 L10 7 Z" fill="var(--color-accent-2)" />
                      </svg>
                    }
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
