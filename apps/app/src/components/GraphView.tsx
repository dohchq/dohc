import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { GraphNode, GraphEdge } from '../../convex/graph'
import { useActiveWorkspaceId } from '@/lib/active-workspace'

// graph-v1 1c — the knowledge graph. Cells (files) are nodes; an edge
// is a wikilink or a concrete formula reference. The view merges every
// graph slice visible from the currently selected workspace: owned
// files, files shared directly with that workspace, and workspace-wide
// shared files.
// ForceGraph2D (canvas) is lazy-loaded so the heavy renderer never
// reaches the SSR bundle and only loads when the graph is opened.

type FGNode = GraphNode & { id: string }
type FGData = { nodes: FGNode[]; links: GraphEdge[] }
const EMPTY_FG: FGData = { nodes: [], links: [] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ForceGraphComponent = ComponentType<any>

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

  // Build the renderer's graph from one or more scope results.
  //  • CLONE nodes AND links — react-force-graph/d3 mutate
  //    link.source/target (id → node object) in place; cloning keeps
  //    the Convex query cache objects pristine across re-renders.
  //  • Dedupe nodes by id (a cell shared to me both personally and via
  //    a workspace-wide share would otherwise appear twice).
  //  • Dedupe links UNDIRECTED (sorted endpoints) — the graph is
  //    visually undirected, so a↔b and a-formula-b shouldn't stack
  //    into doubled lines (codex P2).
  const buildFG = (graphs: Array<{ nodes: GraphNode[]; edges: GraphEdge[] }>): FGData => {
    const nodes: FGNode[] = []
    const seenN = new Set<string>()
    const links: GraphEdge[] = []
    const seenL = new Set<string>()
    for (const g of graphs) {
      for (const n of g.nodes) {
        if (seenN.has(n.id)) continue
        seenN.add(n.id)
        nodes.push({ ...n })
      }
      for (const e of g.edges) {
        const k = e.source < e.target
          ? `${e.source}|${e.target}`
          : `${e.target}|${e.source}`
        if (seenL.has(k)) continue
        seenL.add(k)
        links.push({ ...e })
      }
    }
    return { nodes, links }
  }

  const allReady = !!personal && !!shared && !!workspaceWide
  const ready = allReady

  const data: FGData = useMemo(() => {
    return allReady ? buildFG([personal!, shared!, workspaceWide!]) : EMPTY_FG
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personal, shared, workspaceWide])

  // ── theme-aware palette (concrete rgb so we can modulate alpha for
  // the hover dim/highlight). Re-read when the theme flips.
  // First-frame defaults in dohc graphite/muted; the effect below reads
  // the live CSS tokens (getComputedStyle normalizes hex → rgb) and
  // re-paints, so these only show for one frame and on theme flips.
  const [palette, setPalette] = useState({
    personal: '45,52,46',
    shared: '102,99,93',
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
        shared: read('--color-accent-2', '102,99,93'),
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
  const { degree, neighbors, nodeLinks } = useMemo(() => {
    const degree = new Map<string, number>()
    const neighbors = new Map<string, Set<string>>()
    const nodeLinks = new Map<string, Set<string>>()
    const push = (m: Map<string, Set<string>>, k: string, val: string) => {
      let s = m.get(k)
      if (!s) m.set(k, (s = new Set()))
      s.add(val)
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
    }
    return { degree, neighbors, nodeLinks }
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
  useEffect(() => {
    didFit.current = false
  }, [data])
  // `FG` is in the deps so this re-runs once the lazily-imported
  // component actually mounts (fgRef populated) — otherwise the tuning
  // could be dropped when data is ready before the import resolves
  // (codex P1).
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || !ready) return
    // compact layout: gentle repulsion (capped range so distant nodes
    // don't keep pushing apart) + short links → a readable cluster
    // rather than a sparse scatter that fit-to-view shrinks to dots.
    const charge = fg.d3Force?.('charge')
    charge?.strength?.(-32)
    charge?.distanceMax?.(260)
    fg.d3Force?.('link')?.distance?.(30)
    fg.d3ReheatSimulation?.()
  }, [FG, ready, data])

  return (
    <div className="flex h-screen flex-col bg-page">
      <div className="flex items-center gap-2 border-b border-rule px-4 py-2.5">
        <span className="text-[13px] font-semibold text-ink-strong">Graph</span>
        <span className="ml-auto text-[11.5px] text-ink-faint">
          {data.nodes.length} cells · {data.links.length} links
        </span>
      </div>

      <div ref={wrapRef} className="relative flex-1 overflow-hidden">
        {!FG || !ready || data.nodes.length === 0 ? (
          <div className="grid h-full place-items-center text-ink-faint text-sm">
            {ready && data.nodes.length === 0
              ? 'Nothing to show yet — add some {data} and [[links]], or have a file shared with you.'
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
            warmupTicks={20}
            cooldownTicks={120}
            d3VelocityDecay={0.28}
            onEngineStop={() => {
              // fit once per data set; preserve the user's pan/zoom on
              // later settles (e.g. after dragging a node).
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
            // tooltip — title + the cell's {} data atoms
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            nodeLabel={(node: any) => {
              const n = node as FGNode
              const atoms = n.atoms
                .slice(0, 8)
                .map((a) => `{${a.key}: ${a.value}}`)
                .join(' ')
              return `${n.title}${atoms ? `\n${atoms}` : ''}`
            }}
            // thin undirected links (no arrows); brighten the hovered
            // node's links, fade the rest.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            linkColor={(l: any) => {
              if (!hoverId) return `rgba(${palette.link},0.20)`
              return hiLinks.current.has(linkKey(l))
                ? `rgba(${palette.link},0.85)`
                : `rgba(${palette.link},0.04)`
            }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            linkWidth={(l: any) =>
              hoverId && hiLinks.current.has(linkKey(l)) ? 2 : 1
            }
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
              const rgb = n.kind === 'shared' ? palette.shared : palette.personal
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
      </div>
    </div>
  )
}
