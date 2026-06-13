import { FileText, GitFork, RefreshCw, Unlink } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceGraphResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

type WorkspaceGraphNode = WorkspaceGraphResult["nodes"][number];

type GraphState =
  | { status: "loading"; graph: WorkspaceGraphResult | null; error: null }
  | { status: "ready"; graph: WorkspaceGraphResult; error: null }
  | { status: "error"; graph: WorkspaceGraphResult | null; error: string };

type GraphPoint = WorkspaceGraphNode & {
  x: number;
  y: number;
  radius: number;
};

const EMPTY_GRAPH: WorkspaceGraphResult = {
  nodes: [],
  edges: [],
  unresolvedLinks: 0,
  scannedFileCount: 0,
  omittedFileCount: 0,
  truncatedFileCount: 0,
};

const MAP_WIDTH = 320;
const MAP_HEIGHT = 220;
const MAP_NODE_LIMIT = 36;
const MAP_EDGE_LIMIT = 120;

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

function layoutGraph(
  nodes: WorkspaceGraphNode[],
  activePath: string | null,
): GraphPoint[] {
  const ordered = [...nodes].sort(compareGraphNodes(activePath)).slice(0, MAP_NODE_LIMIT);
  if (ordered.length === 0) return [];
  if (ordered.length === 1) {
    return [
      {
        ...ordered[0],
        x: MAP_WIDTH / 2,
        y: MAP_HEIGHT / 2,
        radius: 12,
      },
    ];
  }

  const radiusX = 118;
  const radiusY = 76;
  const hasActiveNode =
    activePath !== null && ordered.some((node) => node.path === activePath);
  if (!hasActiveNode) {
    return ordered.map((node, index) => {
      const angle =
        ordered.length === 2
          ? index * Math.PI
          : -Math.PI / 2 + (Math.PI * 2 * index) / ordered.length;
      return {
        ...node,
        x: MAP_WIDTH / 2 + Math.cos(angle) * radiusX,
        y: MAP_HEIGHT / 2 + Math.sin(angle) * radiusY,
        radius: Math.min(12, 6 + degree(node) * 0.75),
      };
    });
  }

  const center = ordered[0];
  const ring = ordered.slice(1);
  return [
    {
      ...center,
      x: MAP_WIDTH / 2,
      y: MAP_HEIGHT / 2,
      radius: Math.min(15, 8 + degree(center)),
    },
    ...ring.map((node, index) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / ring.length;
      return {
        ...node,
        x: MAP_WIDTH / 2 + Math.cos(angle) * radiusX,
        y: MAP_HEIGHT / 2 + Math.sin(angle) * radiusY,
        radius: Math.min(12, 6 + degree(node) * 0.75),
      };
    }),
  ];
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
  onOpenPath: (path: string) => void;
}) {
  const points = useMemo(
    () => layoutGraph(props.graph.nodes, props.activePath),
    [props.graph.nodes, props.activePath],
  );
  const byPath = useMemo(
    () => new Map(points.map((point) => [point.path, point])),
    [points],
  );
  const edges = props.graph.edges
    .filter((edge) => byPath.has(edge.source) && byPath.has(edge.target))
    .slice(0, MAP_EDGE_LIMIT);

  return (
    <svg
      data-testid="graph-map"
      viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
      role="img"
      aria-label="Workspace graph"
      className="h-56 w-full shrink-0 border-y border-line bg-bg"
    >
      <rect width={MAP_WIDTH} height={MAP_HEIGHT} className="fill-bg" />
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
            className={
              edge.kind === "wikilink"
                ? "stroke-line"
                : "stroke-match/70"
            }
            strokeWidth={edge.kind === "wikilink" ? 1 : 1.4}
          />
        );
      })}
      {points.map((node) => {
        const active = node.path === props.activePath;
        return (
          <g
            key={node.path}
            data-testid="graph-node"
            data-path={node.path}
            role="button"
            tabIndex={0}
            aria-label={node.path}
            className="cursor-pointer outline-none"
            onClick={() => props.onOpenPath(node.path)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onOpenPath(node.path);
              }
            }}
          >
            <circle
              cx={node.x}
              cy={node.y}
              r={node.radius}
              className={active ? "fill-ink stroke-ink" : "fill-panel stroke-muted"}
              strokeWidth={active ? 2 : 1.25}
            />
            <text
              x={node.x}
              y={node.y + node.radius + 11}
              textAnchor="middle"
              stroke="var(--dohc-bg)"
              strokeWidth={3}
              paintOrder="stroke"
              className={active ? "fill-ink text-[9px]" : "fill-muted text-[9px]"}
            >
              {node.title.length > 18 ? `${node.title.slice(0, 17)}…` : node.title}
            </text>
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
  onOpenPath: (path: string) => void;
}) {
  const [reloadNonce, setReloadNonce] = useState(0);
  const [state, setState] = useState<GraphState>({
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
      status: "loading",
      graph: current.graph,
      error: null,
    }));
    void bridge()
      .readWorkspaceGraph({ workspaceId: props.workspaceId })
      .then((graph) => {
        if (!cancelled) setState({ status: "ready", graph, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState((current) => ({
          status: "error",
          graph: current.graph,
          error: error instanceof Error ? error.message : "Graph failed to load",
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [props.workspaceId, props.refreshKey, reloadNonce]);

  const graph = state.graph ?? EMPTY_GRAPH;
  const rows = useMemo(
    () => [...graph.nodes].sort(compareGraphNodes(props.activePath)),
    [graph.nodes, props.activePath],
  );
  const notice = graphStatus(graph);

  return (
    <div
      data-testid="graph-view"
      data-state={state.status === "loading" && !state.graph ? "loading" : state.status}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <GitFork size={13} aria-hidden className="text-subtle" />
        <output data-testid="graph-doc-count" className="text-[11px] text-muted">
          {graph.nodes.length} doc{graph.nodes.length === 1 ? "" : "s"}
        </output>
        <span aria-hidden className="text-subtle">
          ·
        </span>
        <output data-testid="graph-link-count" className="text-[11px] text-muted">
          {graph.edges.length} link{graph.edges.length === 1 ? "" : "s"}
        </output>
        <button
          type="button"
          aria-label="Refresh graph"
          title="Refresh graph"
          onClick={load}
          className="ml-auto grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>

      {state.status === "error" ? (
        <div className="border-b border-line px-3 py-2 text-[11px] text-danger">
          {state.error}
        </div>
      ) : null}

      {state.status === "loading" && !state.graph ? (
        <div className="flex flex-1 items-center justify-center px-4 text-xs text-muted">
          Building graph…
        </div>
      ) : graph.nodes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
          <FileText size={18} aria-hidden className="text-subtle" />
          <span className="text-xs text-muted">No markdown files</span>
        </div>
      ) : (
        <>
          <GraphMap
            graph={graph}
            activePath={props.activePath}
            onOpenPath={props.onOpenPath}
          />
          {notice ? (
            <div
              data-testid="graph-unresolved-count"
              className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-[11px] text-subtle"
            >
              <Unlink size={12} aria-hidden />
              {notice}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((node) => {
              const active = node.path === props.activePath;
              return (
                <button
                  key={node.path}
                  type="button"
                  data-testid="graph-file-row"
                  data-path={node.path}
                  data-active={active ? "true" : "false"}
                  onClick={() => props.onOpenPath(node.path)}
                  className={`flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left hover:bg-line/40 ${
                    active ? "bg-line/50 text-ink" : "text-muted"
                  }`}
                >
                  <span className="grid size-6 shrink-0 place-items-center rounded border border-line bg-panel text-[10px] font-semibold text-subtle">
                    {degree(node)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-ink">{node.title}</span>
                    <span className="block truncate font-mono text-[10px] text-subtle">
                      {node.path}
                    </span>
                  </span>
                  <span className="font-mono text-[10px] text-subtle">
                    {node.incoming}/{node.outgoing}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
