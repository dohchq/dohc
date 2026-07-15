import { FileText, GitFork, RefreshCw, Unlink } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { WorkspaceGraphResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

type WorkspaceGraphNode = WorkspaceGraphResult["nodes"][number];

type GraphState =
  | {
      workspaceId: string;
      status: "loading";
      graph: WorkspaceGraphResult | null;
      error: null;
    }
  | {
      workspaceId: string;
      status: "ready";
      graph: WorkspaceGraphResult;
      error: null;
    }
  | {
      workspaceId: string;
      status: "error";
      graph: WorkspaceGraphResult | null;
      error: string;
    };

type GraphPoint = WorkspaceGraphNode & {
  x: number;
  y: number;
  radius: number;
};

type ForceNode = GraphPoint & {
  index: number;
  vx: number;
  vy: number;
  dragging: boolean;
};

type VisibleGraphEdge = WorkspaceGraphResult["edges"][number];

const EMPTY_GRAPH: WorkspaceGraphResult = {
  nodes: [],
  edges: [],
  unresolvedLinks: 0,
  scannedFileCount: 0,
  omittedFileCount: 0,
  truncatedFileCount: 0,
};

type GraphVariant = "panel" | "page";

const GRAPH_LAYOUT: Record<
  GraphVariant,
  {
    width: number;
    height: number;
    nodeLimit: number;
    edgeLimit: number;
    pairwiseLimit: number;
    labelLimit: number;
  }
> = {
  panel: {
    width: 260,
    height: 420,
    nodeLimit: 2000,
    edgeLimit: 10000,
    pairwiseLimit: 160,
    labelLimit: 80,
  },
  page: {
    width: 1200,
    height: 760,
    nodeLimit: 2000,
    edgeLimit: 10000,
    pairwiseLimit: 280,
    labelLimit: 180,
  },
};

function degree(node: Pick<WorkspaceGraphNode, "incoming" | "outgoing">): number {
  return node.incoming + node.outgoing;
}

function compareGraphNodes(activePath: string | null) {
  return (a: WorkspaceGraphNode, b: WorkspaceGraphNode) => {
    if (a.path === activePath) return -1;
    if (b.path === activePath) return 1;
    return degree(b) - degree(a) || a.path.localeCompare(b.path);
  };
}

function graphRadius(node: WorkspaceGraphNode, variant: GraphVariant): number {
  return variant === "page"
    ? Math.min(24, 9 + degree(node) * 0.9)
    : Math.min(24, 12 + degree(node) * 1.15);
}

function requestGraphFrame(callback: FrameRequestCallback): number {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(callback);
  }
  return Number(globalThis.setTimeout(() => callback(performance.now()), 16));
}

function cancelGraphFrame(handle: number): void {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(handle);
  }
  globalThis.clearTimeout(handle);
}

function initialGraphNode(
  node: WorkspaceGraphNode,
  index: number,
  count: number,
  activePath: string | null,
  variant: GraphVariant,
  previous: ForceNode | undefined,
): ForceNode {
  const layout = GRAPH_LAYOUT[variant];
  const radius = graphRadius(node, variant);
  if (previous) {
    return {
      ...node,
      index,
      radius,
      x: Math.min(layout.width - radius - 16, Math.max(radius + 16, previous.x)),
      y: Math.min(layout.height - radius - 16, Math.max(radius + 16, previous.y)),
      vx: previous.vx,
      vy: previous.vy,
      dragging: false,
    };
  }

  const centerX = layout.width / 2;
  const centerY = layout.height / 2;
  if (count === 1 || node.path === activePath) {
    return {
      ...node,
      index,
      radius,
      x: centerX,
      y: centerY,
      vx: 0,
      vy: 0,
      dragging: false,
    };
  }
  const ringCount = activePath ? Math.max(1, count - 1) : count;
  const ringIndex = activePath ? Math.max(0, index - 1) : index;
  const angle =
    ringCount === 2
      ? ringIndex * Math.PI
      : -Math.PI / 2 + (Math.PI * 2 * ringIndex) / ringCount;
  const spreadX = variant === "page" ? 350 : 88;
  const spreadY = variant === "page" ? 235 : 158;
  return {
    ...node,
    index,
    radius,
    x: centerX + Math.cos(angle) * spreadX,
    y: centerY + Math.sin(angle) * spreadY,
    vx: 0,
    vy: 0,
    dragging: false,
  };
}

function snapshotNodes(nodes: ForceNode[]): GraphPoint[] {
  return nodes.map(
    ({ index: _index, vx: _vx, vy: _vy, dragging: _dragging, ...node }) =>
      node,
  );
}

function visibleEdges(
  graph: WorkspaceGraphResult,
  nodes: ForceNode[],
  variant: GraphVariant,
): VisibleGraphEdge[] {
  const paths = new Set(nodes.map((node) => node.path));
  return graph.edges
    .filter((edge) => paths.has(edge.source) && paths.has(edge.target))
    .slice(0, GRAPH_LAYOUT[variant].edgeLimit);
}

function useForceGraph(
  graph: WorkspaceGraphResult,
  activePath: string | null,
  variant: GraphVariant,
) {
  const layout = GRAPH_LAYOUT[variant];
  const ordered = useMemo(
    () =>
      [...graph.nodes]
        .sort(compareGraphNodes(activePath))
        .slice(0, layout.nodeLimit),
    [graph.nodes, activePath, layout.nodeLimit],
  );
  const [points, setPoints] = useState<GraphPoint[]>([]);
  const nodesRef = useRef<ForceNode[]>([]);
  const edgesRef = useRef<VisibleGraphEdge[]>([]);
  const frameRef = useRef<number | null>(null);
  const alphaRef = useRef(0);
  const activePathRef = useRef(activePath);
  const variantRef = useRef(variant);

  const step = useCallback(() => {
    const nodes = nodesRef.current;
    const edges = edgesRef.current;
    const currentLayout = GRAPH_LAYOUT[variantRef.current];
    const currentActivePath = activePathRef.current;
    const byPath = new Map(nodes.map((node) => [node.path, node]));
    const dragging = nodes.some((node) => node.dragging);
    const alpha = dragging ? Math.max(alphaRef.current, 0.22) : alphaRef.current;
    const centerX = currentLayout.width / 2;
    const centerY = currentLayout.height / 2;
    const hasActive =
      currentActivePath !== null && nodes.some((node) => node.path === currentActivePath);

    for (const node of nodes) {
      if (node.dragging) continue;
      const active = node.path === currentActivePath;
      const centerStrength = active ? 0.09 : hasActive ? 0.006 : 0.014;
      node.vx += (centerX - node.x) * centerStrength * alpha;
      node.vy += (centerY - node.y) * centerStrength * alpha;

      if (hasActive && !active) {
        const ringIndex = Math.max(0, node.index - 1);
        const ringCount = Math.max(1, nodes.length - 1);
        const angle = -Math.PI / 2 + (Math.PI * 2 * ringIndex) / ringCount;
        const ringX =
          centerX + Math.cos(angle) * (variantRef.current === "page" ? 360 : 88);
        const ringY =
          centerY + Math.sin(angle) * (variantRef.current === "page" ? 240 : 158);
        node.vx += (ringX - node.x) * 0.004 * alpha;
        node.vy += (ringY - node.y) * 0.004 * alpha;
      }
    }

    for (const edge of edges) {
      const source = byPath.get(edge.source);
      const target = byPath.get(edge.target);
      if (!source || !target) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const desired =
        variantRef.current === "page"
          ? edge.kind === "wikilink"
            ? 150
            : 116
          : edge.kind === "wikilink"
            ? 94
            : 74;
      const force = (distance - desired) * 0.018 * alpha;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      if (!source.dragging) {
        source.vx += fx;
        source.vy += fy;
      }
      if (!target.dragging) {
        target.vx -= fx;
        target.vy -= fy;
      }
    }

    const pairwiseLimit = Math.min(
      nodes.length,
      GRAPH_LAYOUT[variantRef.current].pairwiseLimit,
    );
    for (let i = 0; i < pairwiseLimit; i += 1) {
      const a = nodes[i]!;
      for (let j = i + 1; j < pairwiseLimit; j += 1) {
        const b = nodes[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.1) {
          dx = (j % 3) + 0.25;
          dy = (i % 5) + 0.5;
          distance = Math.hypot(dx, dy);
        }
        const nx = dx / distance;
        const ny = dy / distance;
        const charge =
          ((variantRef.current === "page" ? 2800 : 1400) * alpha) /
          Math.max(80, distance * distance);
        if (!a.dragging) {
          a.vx -= nx * charge;
          a.vy -= ny * charge;
        }
        if (!b.dragging) {
          b.vx += nx * charge;
          b.vy += ny * charge;
        }
        const minDistance =
          a.radius + b.radius + (variantRef.current === "page" ? 34 : 28);
        if (distance < minDistance) {
          const push = ((minDistance - distance) / distance) * 0.38 * alpha;
          if (!a.dragging) {
            a.vx -= dx * push;
            a.vy -= dy * push;
          }
          if (!b.dragging) {
            b.vx += dx * push;
            b.vy += dy * push;
          }
        }
      }
    }

    let maxVelocity = 0;
    for (const node of nodes) {
      if (node.dragging) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx *= 0.84;
      node.vy *= 0.84;
      node.x = Math.min(
        currentLayout.width - node.radius - 18,
        Math.max(node.radius + 18, node.x + node.vx),
      );
      node.y = Math.min(
        currentLayout.height - node.radius - 28,
        Math.max(node.radius + 18, node.y + node.vy),
      );
      maxVelocity = Math.max(maxVelocity, Math.abs(node.vx), Math.abs(node.vy));
    }

    setPoints(snapshotNodes(nodes));
    alphaRef.current = dragging ? 0.28 : alphaRef.current * 0.982;
    if (dragging || alphaRef.current > 0.008 || maxVelocity > 0.018) {
      frameRef.current = requestGraphFrame(step);
      return;
    }
    frameRef.current = null;
  }, []);

  const restart = useCallback(
    (boost = 0.7) => {
      alphaRef.current = Math.max(alphaRef.current, boost);
      if (frameRef.current === null) frameRef.current = requestGraphFrame(step);
    },
    [step],
  );

  useEffect(() => {
    activePathRef.current = activePath;
    variantRef.current = variant;
  }, [activePath, variant]);

  useEffect(() => {
    const previous = new Map(nodesRef.current.map((node) => [node.path, node]));
    const nodes = ordered.map((node, index) =>
      initialGraphNode(
        node,
        index,
        ordered.length,
        activePath,
        variant,
        previous.get(node.path),
      ),
    );
    nodesRef.current = nodes;
    edgesRef.current = visibleEdges(graph, nodes, variant);
    setPoints(snapshotNodes(nodes));
    restart(0.86);
  }, [activePath, graph, ordered, restart, variant]);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelGraphFrame(frameRef.current);
      frameRef.current = null;
    };
  }, []);

  const setNodePosition = useCallback(
    (path: string, x: number, y: number, dragging: boolean) => {
      const node = nodesRef.current.find((entry) => entry.path === path);
      if (!node) return;
      node.dragging = dragging;
      node.x = Math.min(layout.width - node.radius - 18, Math.max(node.radius + 18, x));
      node.y = Math.min(layout.height - node.radius - 28, Math.max(node.radius + 18, y));
      node.vx = 0;
      node.vy = 0;
      setPoints(snapshotNodes(nodesRef.current));
      restart(dragging ? 0.55 : 0.32);
    },
    [layout.height, layout.width, restart],
  );

  const releaseNode = useCallback(
    (path: string) => {
      const node = nodesRef.current.find((entry) => entry.path === path);
      if (!node) return;
      node.dragging = false;
      restart(0.34);
    },
    [restart],
  );

  return {
    points,
    edges: edgesRef.current,
    setNodePosition,
    releaseNode,
    restart,
  };
}

function graphStatus(graph: WorkspaceGraphResult): string | null {
  const notices: string[] = [];
  if (graph.unresolvedLinks > 0) {
    notices.push(`${graph.unresolvedLinks} unresolved`);
  }
  if (graph.omittedFileCount > 0) {
    notices.push(`${graph.omittedFileCount} omitted`);
  }
  if (graph.truncatedFileCount > 0) {
    notices.push(`${graph.truncatedFileCount} truncated`);
  }
  return notices.length > 0 ? notices.join(" · ") : null;
}

function GraphMap(props: {
  graph: WorkspaceGraphResult;
  activePath: string | null;
  variant: GraphVariant;
  onOpenPath: (path: string, headingAnchor?: string) => void;
  onOpenChatThread?: (node: WorkspaceGraphNode) => void;
}) {
  const layout = GRAPH_LAYOUT[props.variant];
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{
    path: string;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);
  const { points, edges, setNodePosition, releaseNode } = useForceGraph(
    props.graph,
    props.activePath,
    props.variant,
  );
  const byPath = useMemo(
    () => new Map(points.map((point) => [point.path, point])),
    [points],
  );

  function openNode(path: string) {
    const node = byPath.get(path);
    if (!node) return;
    if (node.kind === "chat-thread") {
      props.onOpenChatThread?.(node);
      return;
    }
    const targetPath = node.filePath ?? node.path;
    if (node.headingAnchor) props.onOpenPath(targetPath, node.headingAnchor);
    else props.onOpenPath(targetPath);
  }

  function pointFromPointer(event: React.PointerEvent<SVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    const width = rect?.width && rect.width > 0 ? rect.width : layout.width;
    const height = rect?.height && rect.height > 0 ? rect.height : layout.height;
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    return {
      x: ((event.clientX - left) / width) * layout.width,
      y: ((event.clientY - top) / height) * layout.height,
    };
  }

  function moveDrag(event: React.PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const point = pointFromPointer(event);
    const moved =
      Math.abs(event.clientX - drag.startClientX) > 3 ||
      Math.abs(event.clientY - drag.startClientY) > 3;
    drag.moved ||= moved;
    setNodePosition(drag.path, point.x, point.y, true);
  }

  function endDrag(event: React.PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const shouldOpen = !drag.moved;
    releaseNode(drag.path);
    dragRef.current = null;
    const svg = svgRef.current;
    if (
      typeof svg?.hasPointerCapture === "function" &&
      typeof svg.releasePointerCapture === "function" &&
      svg.hasPointerCapture(event.pointerId)
    ) {
      svg?.releasePointerCapture(event.pointerId);
    }
    if (shouldOpen) openNode(drag.path);
  }

  return (
    <svg
      ref={svgRef}
      data-testid="graph-map"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label="Workspace graph"
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={
        props.variant === "page"
          ? "min-h-0 w-full flex-1 touch-none bg-panel"
          : "h-96 w-full shrink-0 touch-none border-y border-line bg-panel"
      }
    >
      <rect width={layout.width} height={layout.height} className="fill-panel" />
      {edges.map((edge) => {
        const source = byPath.get(edge.source)!;
        const target = byPath.get(edge.target)!;
        return (
          <line
            key={`${edge.source}:${edge.target}:${edge.kind}`}
            data-testid="graph-edge"
            x1={source.x}
            y1={source.y}
            x2={target.x}
            y2={target.y}
            pathLength={1}
            className={
              edge.kind === "wikilink"
                ? "dohc-graph-edge stroke-line"
                : "dohc-graph-edge stroke-match/70"
            }
            strokeWidth={
              props.variant === "page"
                ? edge.kind === "wikilink"
                  ? 1.4
                  : 2
                : edge.kind === "wikilink"
                  ? 1
                  : 1.4
            }
          />
        );
      })}
      {points.map((node, index) => {
        const active = node.path === props.activePath;
        const showLabel = active || index < layout.labelLimit;
        return (
          <g
            key={node.path}
            data-testid="graph-node"
            data-path={node.path}
            data-kind={node.kind ?? "file"}
            role="button"
            tabIndex={0}
            aria-label={`Open or focus ${node.path}`}
            data-active={active ? "true" : "false"}
            className="dohc-graph-node outline-none"
            style={{ animationDelay: `${Math.min(index, 24) * 18}ms` }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const point = pointFromPointer(event);
              dragRef.current = {
                path: node.path,
                startClientX: event.clientX,
                startClientY: event.clientY,
                moved: false,
              };
              setNodePosition(node.path, point.x, point.y, true);
              const svg = svgRef.current;
              if (typeof svg?.setPointerCapture === "function") {
                svg?.setPointerCapture(event.pointerId);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openNode(node.path);
              }
            }}
          >
            <title>{`Open or focus ${node.path}`}</title>
            <circle
              cx={node.x}
              cy={node.y}
              r={node.radius + (props.variant === "page" ? 8 : 9)}
              className="dohc-graph-node-halo"
            />
            <circle
              cx={node.x}
              cy={node.y}
              r={node.radius}
              className="dohc-graph-node-dot"
              data-active={active ? "true" : "false"}
              strokeWidth={active ? 2 : 1.25}
            />
            {showLabel ? (
              <text
                x={node.x}
                y={node.y + node.radius + (props.variant === "page" ? 18 : 17)}
                textAnchor="middle"
                stroke="var(--dohc-panel)"
                strokeWidth={props.variant === "page" ? 4 : 3}
                paintOrder="stroke"
                data-active={active ? "true" : "false"}
                className={
                  active
                    ? props.variant === "page"
                      ? "fill-ink text-[13px]"
                      : "fill-ink text-[11px]"
                    : props.variant === "page"
                      ? "fill-muted text-[12px]"
                      : "fill-muted text-[11px]"
                }
              >
                {node.title.length > (props.variant === "page" ? 28 : 22)
                  ? `${node.title.slice(0, props.variant === "page" ? 27 : 21)}…`
                  : node.title}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function GraphView(props: {
  workspaceId: string;
  activePath: string | null;
  refreshKey: string;
  onOpenPath: (path: string, headingAnchor?: string) => void;
  onOpenChatThread?: (node: WorkspaceGraphNode) => void;
  chatMentionsAvailable?: boolean;
  variant?: GraphVariant;
}) {
  const variant = props.variant ?? "panel";
  const [reloadNonce, setReloadNonce] = useState(0);
  const [includeChatMentions, setIncludeChatMentions] = useState(false);
  const chatMentionsEnabled =
    props.chatMentionsAvailable === true && includeChatMentions;
  const [state, setState] = useState<GraphState>({
    workspaceId: props.workspaceId,
    status: "loading",
    graph: null,
    error: null,
  });

  const load = useCallback(() => {
    setReloadNonce((nonce) => nonce + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({
      workspaceId: props.workspaceId,
      status: "loading",
      graph:
        current.workspaceId === props.workspaceId ? current.graph : null,
      error: null,
    }));
    void bridge()
      .readWorkspaceGraph({
        workspaceId: props.workspaceId,
        includeChatMentions: chatMentionsEnabled,
      })
      .then((graph) => {
        if (!cancelled) {
          setState({
            workspaceId: props.workspaceId,
            status: "ready",
            graph,
            error: null,
          });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState((current) => ({
          workspaceId: props.workspaceId,
          status: "error",
          graph:
            current.workspaceId === props.workspaceId ? current.graph : null,
          error: error instanceof Error ? error.message : "Graph failed to load",
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [chatMentionsEnabled, props.workspaceId, props.refreshKey, reloadNonce]);

  const scopedState: GraphState =
    state.workspaceId === props.workspaceId
      ? state
      : {
          workspaceId: props.workspaceId,
          status: "loading",
          graph: null,
          error: null,
        };
  const graph = scopedState.graph ?? EMPTY_GRAPH;
  const rows = useMemo(
    () => [...graph.nodes].sort(compareGraphNodes(props.activePath)),
    [graph.nodes, props.activePath],
  );
  const notice = graphStatus(graph);

  return (
    <div
      data-testid="graph-view"
      data-state={
        scopedState.status === "loading" && !scopedState.graph
          ? "loading"
          : scopedState.status
      }
      data-variant={variant}
      className={
        variant === "page"
          ? "flex min-h-0 flex-1 flex-col bg-bg"
          : "flex min-h-0 flex-1 flex-col"
      }
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <GitFork size={13} aria-hidden className="text-subtle" />
        <output data-testid="graph-doc-count" className="font-mono text-[11px] text-muted">
          {graph.nodes.length} doc{graph.nodes.length === 1 ? "" : "s"}
        </output>
        <span aria-hidden className="text-subtle">
          ·
        </span>
        <output data-testid="graph-link-count" className="font-mono text-[11px] text-muted">
          {graph.edges.length} link{graph.edges.length === 1 ? "" : "s"}
        </output>
        {notice ? (
          <span
            data-testid="graph-unresolved-count"
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-subtle"
          >
            <Unlink size={12} aria-hidden />
            {notice}
          </span>
        ) : null}
        {props.chatMentionsAvailable ? (
          <button
            type="button"
            data-testid="graph-chat-mentions-toggle"
            aria-pressed={includeChatMentions}
            title="Show chat and heading mentions"
            onClick={() => setIncludeChatMentions((value) => !value)}
            className={`ml-auto rounded-md border px-2 py-1 text-[10px] transition-colors ${
              includeChatMentions
                ? "border-accent/50 bg-accent/10 text-accent"
                : "border-line text-subtle hover:bg-line/40 hover:text-ink"
            }`}
          >
            Chat mentions
          </button>
        ) : (
          <span className="ml-auto" />
        )}
        <button
          type="button"
          aria-label="Refresh graph"
          title="Refresh graph"
          onClick={load}
          className="grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink"
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>

      {scopedState.status === "error" ? (
        <div className="border-b border-line px-3 py-2 text-[11px] text-danger">
          {scopedState.error}
        </div>
      ) : null}

      {scopedState.status === "loading" && !scopedState.graph ? (
        <div className="flex flex-1 items-center justify-center px-4 text-xs text-muted">
          Building graph…
        </div>
      ) : graph.nodes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
          <FileText size={18} aria-hidden className="text-subtle" />
          <span className="text-xs text-muted">No markdown files</span>
        </div>
      ) : (
        <div
          className={
            variant === "page"
              ? "flex min-h-0 flex-1"
              : "flex min-h-0 flex-1 flex-col"
          }
        >
          <GraphMap
            graph={graph}
            activePath={props.activePath}
            variant={variant}
            onOpenPath={props.onOpenPath}
            onOpenChatThread={props.onOpenChatThread}
          />
          {variant === "page" ? null : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                {rows.map((node) => {
                  const active = node.path === props.activePath;
                  return (
                    <button
                      key={node.path}
                      type="button"
                      data-testid="graph-file-row"
                      data-path={node.path}
                      data-active={active ? "true" : "false"}
                      onClick={() =>
                        node.kind === "chat-thread"
                          ? props.onOpenChatThread?.(node)
                          : node.kind === "heading"
                            ? props.onOpenPath(node.filePath, node.headingAnchor)
                            : props.onOpenPath(node.filePath ?? node.path)
                      }
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-75 ${
                        active
                          ? "bg-line text-ink"
                          : "text-muted hover:bg-panel-2 hover:text-ink"
                      }`}
                    >
                      <span className="grid size-6 shrink-0 place-items-center rounded-full border border-line bg-panel-2 font-mono text-[10px] text-subtle">
                        {degree(node)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-ink">
                          {node.title}
                        </span>
                        <span className="block truncate font-mono text-[10px] text-subtle">
                          {node.kind === "heading"
                            ? node.filePath
                            : node.kind === "chat-thread"
                              ? "Chat thread"
                              : node.path}
                        </span>
                      </span>
                      <span className="font-mono text-[10px] text-subtle">
                        {node.incoming}/{node.outgoing}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
