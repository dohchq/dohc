import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import {
  FileText,
  GitFork,
  ListFilter,
  MessageSquare,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatFileMentionRecord } from "../../ipc/bridgeContract";
import type { LinksConnectionsResult } from "@dohc/workspace-contracts/links";
import {
  connectionTabPath,
  graphPathForTab,
  graphWalk,
  emptyGraph,
  withChatMentions,
  withConnections,
  type GraphData,
  type GraphEdge,
  type GraphNode,
} from "./graphData";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";
import { bridge } from "../bridge";
import { isChatMentionPageChanged, refusalCode } from "../../ipc/errorWords";
import { ipcErrorMessage } from "../ipcError";
import { EmptyState, IconButton, RetryRow } from "../ui/controls";
import { GROUP_HUES, GraphCanvas, LINK_STYLE } from "./GraphCanvas";
import type { ApprovalSurge, CanvasNode, GraphLink } from "./GraphCanvas";
import { APPROVAL_SURGE_MS } from "./graphVisuals";
import {
  DEFAULT_SETTINGS,
  GRAPH_KINDS,
  GraphSettings,
  HUE_TEXT,
  STRUCTURAL_KIND_HUE,
  ShapeMark,
  type GraphKind,
  type GraphSettingsValue,
} from "./GraphSettings";

type GraphState =
  | {
      workspaceId: string;
      chatMentionsEnabled: boolean;
      status: "loading";
      graph: GraphData | null;
      error: null;
    }
  | {
      workspaceId: string;
      chatMentionsEnabled: boolean;
      status: "ready";
      graph: GraphData;
      error: null;
    }
  | {
      workspaceId: string;
      chatMentionsEnabled: boolean;
      status: "error";
      graph: GraphData | null;
      error: string;
    };

type GraphVariant = "panel" | "page";

const EMPTY_GRAPH = emptyGraph();
const ROW_HEIGHT = 28;
const SEARCH_RESULTS = 8;

// Settings last for the session, one set per workspace and surface.
const sessionSettings = new Map<string, GraphSettingsValue>();
const PANEL_SETTINGS: GraphSettingsValue = { ...DEFAULT_SETTINGS, records: true };

export function graphKind(node: GraphNode): GraphKind {
  if (node.kind === "connection")
    return node.connection.kind === "document-collection" ? "collection" : node.connection.kind;
  if (node.kind === "chat-thread") return "chat";
  if (node.kind === "heading") return "heading";
  const display = fileKindForPath(node.path).displayKind;
  return display === "markdown" ? "page" : display === "drawing" ? "drawing" : "file";
}

const SHAPES = Object.fromEntries(GRAPH_KINDS.map(({ kind, shape }) => [kind, shape])) as Record<
  GraphKind,
  CanvasNode["shape"]
>;
const KIND_NAMES = Object.fromEntries(GRAPH_KINDS.map(({ kind, name }) => [kind, name])) as Record<
  GraphKind,
  string
>;

type GraphViewModel = {
  nodes: CanvasNode[];
  sources: GraphNode[];
  links: GraphLink[];
  index: Map<string, number>;
  // Before the local graph narrows them, for the header's counts.
  filteredNodeCount: number;
  filteredLinkCount: number;
  kindCounts: Record<GraphKind, number>;
  local: boolean;
};

function matchesSearch(node: GraphNode, query: string): boolean {
  return (
    node.title.toLocaleLowerCase().includes(query) || node.path.toLocaleLowerCase().includes(query)
  );
}

// The model follows a deferred search, so it can lag the box by a render.
// Suggestions are filtered again by the box's own text: every one shown
// matches what the person typed, and Enter can't open a stale result.
export function searchMatches(
  model: Pick<GraphViewModel, "nodes" | "sources">,
  value: string,
  limit = SEARCH_RESULTS,
) {
  const query = value.trim().toLocaleLowerCase();
  const matches: { node: CanvasNode; index: number }[] = [];
  if (!query) return matches;
  for (let index = 0; index < model.nodes.length && matches.length < limit; index++) {
    if (matchesSearch(model.sources[index]!, query))
      matches.push({ node: model.nodes[index]!, index });
  }
  return matches;
}

const linkStyle = (edge: GraphEdge) =>
  edge.approval === "requested"
    ? LINK_STYLE.pending
    : edge.kind.startsWith("chat-")
      ? LINK_STYLE.mention
      : edge.kind === "wikilink" ||
          edge.kind === "markdown" ||
          edge.kind === "heading-in-file" ||
          edge.kind === "record-in-collection"
        ? LINK_STYLE.prose
        : LINK_STYLE.structural;

export const detectApprovedEdges = (
  prev: ReadonlySet<string>,
  edges: LinksConnectionsResult["edges"],
): [string, string][] =>
  edges
    .filter(
      (e) =>
        e.kind === "app-uses-data" &&
        e.approval === "approved" &&
        prev.has(JSON.stringify([e.source, e.target])),
    )
    .map((e) => [e.source, e.target]);

function buildModel(
  graph: GraphData,
  settings: Pick<GraphSettingsValue, "hidden" | "orphans" | "depth">,
  search: string,
  localPath: string | null,
): GraphViewModel {
  const kindCounts = Object.fromEntries(GRAPH_KINDS.map(({ kind }) => [kind, 0])) as Record<
    GraphKind,
    number
  >;
  const query = search.trim().toLocaleLowerCase();
  const kept = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    const kind = graphKind(node);
    kindCounts[kind]++;
    if (settings.hidden.includes(kind)) continue;
    if (query && !matchesSearch(node, query)) continue;
    kept.set(node.path, node);
  }
  const degree = new Map<string, number>();
  let edges = graph.edges.filter((edge) => {
    if (edge.source === edge.target || !kept.has(edge.source) || !kept.has(edge.target))
      return false;
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    return true;
  });
  let paths = [...kept.keys()];
  if (!settings.orphans) paths = paths.filter((path) => degree.has(path) || path === localPath);
  const filteredNodeCount = paths.length;
  const filteredLinkCount = edges.length;

  const local = localPath !== null && kept.has(localPath);
  if (local) {
    const neighbours = new Map<string, string[]>();
    for (const edge of edges) {
      (neighbours.get(edge.source) ?? neighbours.set(edge.source, []).get(edge.source)!).push(
        edge.target,
      );
      (neighbours.get(edge.target) ?? neighbours.set(edge.target, []).get(edge.target)!).push(
        edge.source,
      );
    }
    const reached = new Set([localPath]);
    let ring = [localPath];
    for (let step = 0; step < settings.depth && ring.length; step++) {
      const next: string[] = [];
      for (const path of ring) {
        for (const neighbour of neighbours.get(path) ?? []) {
          if (!reached.has(neighbour)) {
            reached.add(neighbour);
            next.push(neighbour);
          }
        }
      }
      ring = next;
    }
    paths = paths.filter((path) => reached.has(path));
    edges = edges.filter((edge) => reached.has(edge.source) && reached.has(edge.target));
  }

  // Most-linked first: the layout seeds hubs at the centre, and labels show
  // for them first.
  paths.sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
  const index = new Map(paths.map((path, i) => [path, i]));
  const sources = paths.map((path) => kept.get(path)!);
  const linkDegree = new Uint32Array(paths.length);
  const links: GraphLink[] = [];
  for (const edge of edges) {
    const s = index.get(edge.source),
      t = index.get(edge.target);
    if (s === undefined || t === undefined) continue;
    links.push([s, t, linkStyle(edge)]);
    linkDegree[s]!++;
    linkDegree[t]!++;
  }
  const nodes = sources.map((node, i) => ({
    path: node.path,
    title: node.title,
    kind: KIND_NAMES[graphKind(node)],
    shape: SHAPES[graphKind(node)],
    degree: linkDegree[i]!,
    structural: node.kind === "connection",
    paused:
      node.kind === "connection" &&
      node.connection.kind === "automation" &&
      !node.connection.enabled,
  }));
  return { nodes, sources, links, index, filteredNodeCount, filteredLinkCount, kindCounts, local };
}

function groupsFor(model: GraphViewModel, groups: GraphSettingsValue["groups"]): Int16Array {
  const result = new Int16Array(model.nodes.length).fill(-1);
  const queries = groups
    .map((group) => ({ query: group.query.trim().toLocaleLowerCase(), hue: group.hue }))
    .filter((group) => group.query);
  if (!queries.length) {
    model.sources.forEach((node, i) => {
      result[i] = STRUCTURAL_KIND_HUE[graphKind(node)] ?? -1;
    });
    return result;
  }
  model.sources.forEach((node, i) => {
    const title = node.title.toLocaleLowerCase(),
      path = node.path.toLocaleLowerCase();
    const match = queries.find(
      (group) => title.includes(group.query) || path.includes(group.query),
    );
    if (match) result[i] = match.hue;
  });
  return result;
}

function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

function coverageNotice(graph: GraphData): string | null {
  const notices: string[] = [];
  if (!graph.mountsCovered) notices.push("Shared folders excluded");
  if (graph.unchecked.length) notices.push(`${graph.unchecked.length.toLocaleString()} unchecked`);
  return notices.length > 0 ? notices.join(" · ") : null;
}

function nodeSubtitle(node: GraphNode): string {
  return node.kind === "heading"
    ? node.filePath
    : node.kind === "chat-thread"
      ? "Chat thread"
      : node.kind === "connection"
        ? KIND_NAMES[graphKind(node)]
        : node.path;
}

// Shows its children only after 150 ms, so a fast answer never flashes.
function useDelayed(active: boolean): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), 150);
    return () => clearTimeout(timer);
  }, [active]);
  return active && shown;
}

const markTone = (hue: number, active = false) =>
  hue >= 0 ? HUE_TEXT[GROUP_HUES[hue]!] : active ? "text-ink" : "text-subtle";

function GraphRows(props: {
  model: GraphViewModel;
  groups: Int16Array;
  activePath: string | null;
  onOpen: (node: GraphNode) => void;
  onFocusNode: (index: number) => void;
  onPointNode: (index: number) => void;
}) {
  // Rows keep their places: sorted by title, never by which page is open.
  const order = useMemo(
    () =>
      props.model.sources
        .map((node, index) => ({ node, index }))
        .sort(
          (a, b) =>
            a.node.title.localeCompare(b.node.title) || a.node.path.localeCompare(b.node.path),
        ),
    [props.model],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 480 });
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () =>
      setViewport({ top: element.scrollTop, height: element.clientHeight || 480 });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - 8);
  const last = Math.min(order.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + 8);

  function moveFocus(from: number, delta: number) {
    const target = Math.max(0, Math.min(order.length - 1, from + delta));
    const element = scrollRef.current;
    if (!element) return;
    const top = target * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    setViewport({ top: element.scrollTop, height: element.clientHeight || viewport.height });
    requestAnimationFrame(() =>
      element.querySelector<HTMLElement>(`[data-row="${target}"]`)?.focus(),
    );
  }

  return (
    <div
      ref={scrollRef}
      data-testid="graph-rows"
      onScroll={(event) =>
        setViewport({
          top: event.currentTarget.scrollTop,
          height: event.currentTarget.clientHeight || viewport.height,
        })
      }
      className="min-h-0 flex-1 overflow-y-auto px-1 py-2"
    >
      <div style={{ height: order.length * ROW_HEIGHT, position: "relative" }}>
        {order.slice(first, last).map(({ node, index }, offset) => {
          const row = first + offset;
          const active = node.path === props.activePath;
          return (
            <button
              key={node.path}
              type="button"
              data-testid="graph-file-row"
              data-path={node.path}
              data-active={active ? "true" : "false"}
              data-row={row}
              title={nodeSubtitle(node)}
              style={{ position: "absolute", top: row * ROW_HEIGHT, left: 0, right: 0 }}
              onClick={() => props.onOpen(node)}
              onFocus={() => props.onFocusNode(index)}
              onBlur={() => props.onFocusNode(-1)}
              onMouseEnter={() => props.onPointNode(index)}
              onMouseLeave={() => props.onPointNode(-1)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  moveFocus(row, event.key === "ArrowDown" ? 1 : -1);
                }
              }}
              className={`dohc-focus-row flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-75 ${
                active
                  ? "bg-selected font-medium text-ink"
                  : "text-muted hover:bg-hover hover:text-ink"
              }`}
            >
              <ShapeMark
                shape={SHAPES[graphKind(node)]}
                className={markTone(props.groups[index] ?? -1, active)}
              />
              <span className="min-w-0 flex-1 truncate">{node.title}</span>
              <span className="text-[12px] tabular-nums text-subtle">
                {props.model.nodes[index]!.degree.toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GraphSearch(props: {
  value: string;
  model: GraphViewModel;
  groups: Int16Array;
  onChange: (value: string) => void;
  onOpen: (node: GraphNode) => void;
  onPointNode: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = useMemo(
    () => searchMatches(props.model, props.value),
    [props.model, props.value],
  );
  const shown = open && matches.length > 0;
  const activeMatch = shown ? matches[Math.min(active, matches.length - 1)] : undefined;
  // The combobox names the active option itself, so it only lights the node.
  const { onPointNode } = props;
  useEffect(() => {
    onPointNode(activeMatch ? activeMatch.index : -1);
  }, [activeMatch, onPointNode]);

  return (
    <div className="relative w-56 min-w-0 shrink">
      <Search
        size={13}
        aria-hidden
        className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-subtle"
      />
      <input
        data-testid="graph-search"
        role="combobox"
        aria-label="Search graph"
        aria-expanded={shown}
        aria-controls="graph-search-results"
        aria-activedescendant={activeMatch ? `graph-search-option-${activeMatch.index}` : undefined}
        placeholder="Search items"
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            setActive((current) =>
              Math.max(
                0,
                Math.min(matches.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)),
              ),
            );
          } else if (event.key === "Enter" && activeMatch) {
            event.preventDefault();
            props.onOpen(props.model.sources[activeMatch.index]!);
          } else if (event.key === "Escape") {
            if (props.value) {
              event.preventDefault();
              props.onChange("");
            }
          }
        }}
        className="h-7 w-full rounded-md border border-line bg-bg pl-7 pr-7 text-[13px] text-ink placeholder:text-subtle focus:border-ink"
      />
      {props.value.length > 0 ? (
        <button
          type="button"
          aria-label="Clear search"
          title="Clear search"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.onChange("")}
          className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-subtle transition-colors hover:bg-hover hover:text-ink"
        >
          <X size={12} aria-hidden />
        </button>
      ) : null}
      {shown ? (
        <ul
          id="graph-search-results"
          role="listbox"
          aria-label="Matching items"
          className="dohc-popover dohc-pop-in absolute right-0 top-8 z-20 w-72 rounded-lg border border-line bg-panel p-1"
        >
          {matches.map(({ node, index }, position) => (
            <li
              key={node.path}
              id={`graph-search-option-${index}`}
              role="option"
              aria-selected={activeMatch?.index === index}
              data-testid="graph-search-option"
              data-path={node.path}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(position)}
              onClick={() => props.onOpen(props.model.sources[index]!)}
              className={`flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] ${
                activeMatch?.index === index ? "bg-selected text-ink" : "text-muted"
              }`}
            >
              <ShapeMark
                shape={node.shape}
                className={markTone(props.groups[index] ?? -1, activeMatch?.index === index)}
              />
              <span className="min-w-0 flex-1 truncate">{node.title}</span>
              <span className="text-[12px] tabular-nums text-subtle">
                {node.degree.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function GraphView(props: {
  workspaceId: string;
  activePath: string | null;
  refreshKey: string;
  onOpenPath: (path: string, headingAnchor?: string) => void;
  onOpenChatThread?: (node: GraphNode) => void;
  chatMentionsAvailable?: boolean;
  variant?: GraphVariant;
  onError?: (message: string, error: unknown, retry: (() => void) | null) => void;
}) {
  const variant = props.variant ?? "panel";
  const [reloadNonce, setReloadNonce] = useState(0);
  const [includeChatMentions, setIncludeChatMentions] = useState(false);
  const chatMentionsEnabled = props.chatMentionsAvailable === true && includeChatMentions;
  const requestIdentity = useMemo(
    () => ({
      workspaceId: props.workspaceId,
      chatMentionsEnabled,
      refreshKey: props.refreshKey,
      reloadNonce,
    }),
    [chatMentionsEnabled, props.refreshKey, props.workspaceId, reloadNonce],
  );
  const requestIdentityRef = useRef(requestIdentity);
  useLayoutEffect(() => {
    requestIdentityRef.current = requestIdentity;
  }, [requestIdentity]);
  const [state, setState] = useState<GraphState>({
    workspaceId: props.workspaceId,
    chatMentionsEnabled,
    status: "loading",
    graph: null,
    error: null,
  });

  const load = useCallback(() => {
    setReloadNonce((nonce) => nonce + 1);
  }, []);

  const reportError = useRef(props.onError);
  reportError.current = props.onError;
  const [walking, setWalking] = useState(true);
  const completedRequest = useRef<typeof requestIdentity | null>(null);
  const [chatRows, setChatRows] = useState<{
    workspaceId: string;
    rows: ChatFileMentionRecord[];
    complete: boolean;
    mountsCovered: boolean;
  } | null>(null);
  const [chatWalking, setChatWalking] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    let resumePaint: (() => void) | undefined;
    let retries = 0;
    const current = () => active && requestIdentityRef.current === requestIdentity;
    const retry = () => {
      if (requestIdentityRef.current === requestIdentity) load();
    };
    setWalking(true);
    setState((previous) => ({
      workspaceId: props.workspaceId,
      chatMentionsEnabled,
      status: "loading",
      graph: previous.workspaceId === props.workspaceId ? previous.graph : null,
      error: null,
    }));
    const paint = () =>
      new Promise<void>((resolve) => {
        resumePaint = resolve;
        frame = requestAnimationFrame(() => {
          timer = setTimeout(resolve, 0);
        });
      });
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        resumePaint = resolve;
        timer = setTimeout(resolve, ms);
      });
    let hasDrawnGraph =
      state.workspaceId === props.workspaceId && (state.graph?.nodes.length ?? 0) > 0;
    let restarted = false;
    let busy = 0;
    const walk = async () => {
      let accumulator = graphWalk();
      let cursor: string | undefined;
      try {
        for (;;) {
          let page;
          try {
            page = await bridge().linksEdges({
              workspaceId: props.workspaceId,
              ...(cursor ? { cursor } : {}),
            });
          } catch (error) {
            if (!current()) return;
            if (cursor && !restarted && String(error).includes("links-edges-source-changed")) {
              restarted = true;
              accumulator = graphWalk();
              cursor = undefined;
              continue;
            }
            // The engine refuses while its store is busy, as it can be for
            // minutes while links drain after a launch. That clears by itself,
            // so the Graph keeps loading and asks again.
            if (refusalCode(error) === "OVERLOADED") {
              await wait(Math.min(250 * 2 ** busy++, 2000));
              if (!current()) return;
              continue;
            }
            throw error;
          }
          busy = 0;
          if (!current()) return;
          accumulator.append(page);
          cursor = page.nextCursor ?? undefined;
          // Paint initial data before continuing. Keep that snapshot stable while
          // gathering; refreshes replace the drawn graph only at the end.
          if (!hasDrawnGraph || !cursor) {
            const graph = accumulator.snapshot();
            setState({
              workspaceId: props.workspaceId,
              chatMentionsEnabled,
              status: "ready",
              graph,
              error: null,
            });
            if (!hasDrawnGraph && graph.nodes.length) {
              hasDrawnGraph = true;
              if (cursor) {
                await paint();
                if (!current()) return;
              }
            }
          }
          if (!cursor) break;
        }
        if (accumulator.snapshot().indexBuilding && retries < 5) {
          timer = setTimeout(
            () => {
              retries++;
              void walk();
            },
            Math.min(250 * 2 ** retries, 8000),
          );
        } else {
          completedRequest.current = requestIdentity;
          setWalking(false);
        }
      } catch (error) {
        if (!current()) return;
        setWalking(false);
        setState((previous) => ({
          ...previous,
          status: "error",
          error: ipcErrorMessage(error, "dohc could not load the graph."),
        }));
        reportError.current?.("dohc could not load the graph.", error, retry);
      }
    };
    void walk();
    return () => {
      active = false;
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      resumePaint?.();
    };
  }, [requestIdentity, load, props.workspaceId, chatMentionsEnabled]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    let resumePaint: (() => void) | undefined;
    const graph = state.workspaceId === props.workspaceId ? state.graph : null;
    if (!chatMentionsEnabled || !graph) {
      setChatRows(null);
      setChatWalking(false);
      return;
    }
    if (walking || completedRequest.current !== requestIdentity) return;
    const current = () => active && requestIdentityRef.current === requestIdentity;
    const retry = () => {
      if (requestIdentityRef.current === requestIdentity) load();
    };
    let retained = chatRows?.workspaceId === props.workspaceId && chatRows.rows.length > 0;
    let restarted = false;
    setChatWalking(true);
    const walk = async () => {
      const rows = new Map<string, ChatFileMentionRecord>();
      let complete = true,
        mountsCovered = true;
      let cursor: string | undefined;
      try {
        do {
          const page = await bridge().chatFileMentionsPage({
            workspaceId: props.workspaceId,
            ...(cursor ? { cursor } : {}),
          });
          if (!current()) return;
          for (const row of page?.entries ?? []) rows.set(row.attachment.attachmentId, row);
          complete &&= page?.complete ?? true;
          mountsCovered &&= page?.mountsCovered ?? true;
          cursor = page?.nextCursor ?? undefined;
          if (!retained || !cursor)
            setChatRows({
              workspaceId: props.workspaceId,
              rows: [...rows.values()],
              complete,
              mountsCovered,
            });
          if (cursor)
            await new Promise<void>((resolve) => {
              resumePaint = resolve;
              frame = requestAnimationFrame(() => {
                timer = setTimeout(resolve, 0);
              });
            });
          if (!current()) return;
        } while (cursor);
        setChatWalking(false);
      } catch (error) {
        if (!current()) return;
        if (isChatMentionPageChanged(error)) {
          setChatRows(null);
          retained = false;
          if (!restarted) {
            restarted = true;
            void walk();
            return;
          }
        }
        setChatWalking(false);
        reportError.current?.("dohc could not load chat mentions.", error, retry);
      }
    };
    void walk();
    return () => {
      active = false;
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      resumePaint?.();
    };
  }, [
    chatMentionsEnabled,
    walking,
    state.graph,
    state.workspaceId,
    props.workspaceId,
    requestIdentity,
    load,
  ]);

  const scopedState: GraphState =
    state.workspaceId === props.workspaceId && state.chatMentionsEnabled === chatMentionsEnabled
      ? state
      : {
          workspaceId: props.workspaceId,
          chatMentionsEnabled,
          status: "loading",
          graph: null,
          error: null,
        };
  const baseGraph = scopedState.graph ?? EMPTY_GRAPH;
  const mentionedGraph = useMemo(
    () =>
      chatMentionsEnabled && chatRows?.workspaceId === props.workspaceId
        ? {
            ...withChatMentions(baseGraph, chatRows.rows),
            complete: baseGraph.complete && chatRows.complete,
            mountsCovered: baseGraph.mountsCovered && chatRows.mountsCovered,
          }
        : baseGraph,
    [baseGraph, chatRows, chatMentionsEnabled, props.workspaceId],
  );

  const session = useWorkspaceSession();
  const connectionsQuery = useWorkspaceQuery(session, {
    key: `graph-connections\0${props.workspaceId}\0${props.refreshKey}\0${reloadNonce}`,
    load: async (signal) => {
      for (let busy = 0; ; busy++) {
        signal.throwIfAborted();
        try {
          return await bridge().linksConnections({ workspaceId: props.workspaceId });
        } catch (error) {
          if (refusalCode(error) !== "OVERLOADED" || signal.aborted) throw error;
          await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** busy, 2000)));
        }
      }
    },
  });
  const [heldConnections, holdConnections] = useState<{
    workspaceId: string;
    value: LinksConnectionsResult;
  } | null>(null);
  const freshConnections = connectionsQuery.value;
  useEffect(() => {
    if (freshConnections)
      holdConnections({ workspaceId: props.workspaceId, value: freshConnections });
  }, [freshConnections, props.workspaceId]);
  const surgeRef = useRef({ armed: false, prev: null as Set<string> | null, nonce: 0 });
  const [approvalSurge, setApprovalSurge] = useState<ApprovalSurge | null>(null);
  useEffect(() => {
    surgeRef.current.armed = false;
    surgeRef.current.prev = null;
    setApprovalSurge(null);
    return bridge().onLocalAppsChanged((event) => {
      if (event.workspaceId === props.workspaceId) surgeRef.current.armed = true;
    });
  }, [props.workspaceId]);
  useEffect(() => {
    if (!freshConnections || freshConnections.scope !== "workspace") return;
    const requested = new Set(
      freshConnections.edges
        .filter((e) => e.kind === "app-uses-data" && e.approval === "requested")
        .map((e) => JSON.stringify([e.source, e.target])),
    );
    const { armed, prev } = surgeRef.current;
    surgeRef.current.armed = false;
    surgeRef.current.prev = requested;
    if (!armed || !prev) return;
    const edges = detectApprovedEdges(prev, freshConnections.edges);
    if (edges.length > 0) setApprovalSurge({ nonce: ++surgeRef.current.nonce, edges });
  }, [freshConnections, props.workspaceId]);
  const connections =
    freshConnections ??
    (heldConnections?.workspaceId === props.workspaceId ? heldConnections.value : undefined);
  const connectionsError = connectionsQuery.error;
  const retryConnections = connectionsQuery.retry;
  useEffect(() => {
    if (connectionsError) surgeRef.current.armed = false;
    if (connectionsError)
      reportError.current?.(
        "dohc could not load how Collections and apps connect.",
        connectionsError,
        () => void retryConnections(),
      );
  }, [connectionsError, retryConnections]);

  const settingsKey = `${props.workspaceId}\0${variant}`;
  const defaults = variant === "panel" ? PANEL_SETTINGS : DEFAULT_SETTINGS;
  const [savedSettings, setSettingsState] = useState({
    key: settingsKey,
    value: sessionSettings.get(settingsKey) ?? defaults,
  });
  const settings =
    savedSettings.key === settingsKey
      ? savedSettings.value
      : (sessionSettings.get(settingsKey) ?? defaults);
  const graph = useMemo(
    () => withConnections(mentionedGraph, connections, settings.records),
    [mentionedGraph, connections, settings.records],
  );
  const shownPath = useMemo(() => {
    const path = graphPathForTab(props.activePath);
    if (!path || settings.records) return path;
    const record = connections?.records.find((entry) => entry.paths.includes(path));
    return record?.collection ?? path;
  }, [props.activePath, settings.records, connections]);
  const setSettings = useCallback(
    (next: GraphSettingsValue) => {
      sessionSettings.set(settingsKey, next);
      setSettingsState({ key: settingsKey, value: next });
    },
    [settingsKey],
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  // The side panel is the open page's local graph; with no page open in the
  // graph, it shows the whole workspace.
  const localPath = variant === "panel" ? shownPath : null;
  const model = useMemo(
    () =>
      buildModel(
        graph,
        { hidden: settings.hidden, orphans: settings.orphans, depth: settings.depth },
        variant === "page" ? deferredSearch : "",
        localPath,
      ),
    [graph, settings.hidden, settings.orphans, settings.depth, deferredSearch, localPath, variant],
  );
  const groups = useMemo(() => groupsFor(model, settings.groups), [model, settings.groups]);
  const activeIndex = shownPath === null ? -1 : (model.index.get(shownPath) ?? -1);
  const [focusIndex, setFocusIndex] = useState(-1);
  // A pointed node is lit without keyboard focus: a hovered row or the search's active option.
  const [pointIndex, setPointIndex] = useState(-1);
  useEffect(() => {
    setFocusIndex(-1);
    setPointIndex(-1);
  }, [model]);

  const openNode = useCallback(
    (node: GraphNode) => {
      if (node.kind === "chat-thread") props.onOpenChatThread?.(node);
      else if (node.kind === "heading") props.onOpenPath(node.filePath, node.headingAnchor);
      else if (node.kind === "connection") props.onOpenPath(connectionTabPath(node.connection));
      else props.onOpenPath(node.filePath);
    },
    [props],
  );
  const openIndex = useCallback(
    (index: number) => {
      const node = model.sources[index];
      if (node) openNode(node);
    },
    [model, openNode],
  );

  const loadingBlank = scopedState.status === "loading" && !scopedState.graph;
  const showLoading = useDelayed(loadingBlank);
  const gathering = (walking || chatWalking) && scopedState.graph !== null;
  const filtered =
    model.filteredNodeCount < graph.nodes.length || model.filteredLinkCount < graph.edges.length;
  const more = walking && scopedState.graph !== null ? "+" : "";
  const itemCount = filtered
    ? `${model.filteredNodeCount.toLocaleString()} of ${plural(graph.nodes.length, "item")}`
    : `${graph.nodes.length.toLocaleString()}${more} item${graph.nodes.length === 1 && !more ? "" : "s"}`;
  const linkCount = filtered
    ? `${model.filteredLinkCount.toLocaleString()} of ${plural(graph.edges.length, "link")}`
    : `${graph.edges.length.toLocaleString()}${more} link${graph.edges.length === 1 && !more ? "" : "s"}`;
  const counts = `${itemCount} · ${linkCount}`;
  const notice = coverageNotice(graph);
  const empty = !loadingBlank && graph.nodes.length === 0 && scopedState.status !== "error";
  useEffect(() => {
    if (!approvalSurge) return;
    if (loadingBlank || empty) return setApprovalSurge(null);
    const timer = setTimeout(() => setApprovalSurge(null), APPROVAL_SURGE_MS + 100);
    return () => clearTimeout(timer);
  }, [approvalSurge, loadingBlank, empty]);

  const canvas = (
    <GraphCanvas
      nodes={model.nodes}
      links={model.links}
      groups={groups}
      activeIndex={activeIndex}
      activePath={shownPath}
      focusIndex={focusIndex}
      pointIndex={pointIndex}
      display={settings.display}
      forces={settings.forces}
      approvalSurge={approvalSurge}
      surface={variant === "page" ? "bg" : "panel"}
      local={model.local}
      label={model.local ? "Links to and from the open page" : "Workspace graph"}
      className={variant === "page" ? "h-full w-full" : "h-72 w-full shrink-0"}
      onOpen={openIndex}
      onFocusChange={setFocusIndex}
    />
  );

  return (
    <div
      data-testid="graph-view"
      data-state={loadingBlank ? "loading" : scopedState.status}
      data-variant={variant}
      className={
        variant === "page" ? "flex min-h-0 flex-1 flex-col bg-bg" : "flex min-h-0 flex-1 flex-col"
      }
    >
      <div
        className={`flex h-9 shrink-0 items-center border-b border-line px-3 ${variant === "page" ? "gap-2" : "gap-1"}`}
      >
        {/* The side panel's own title names the Graph, so its row keeps the room for the counts. */}
        {variant === "page" ? (
          <GitFork size={13} aria-hidden className="shrink-0 text-subtle" />
        ) : model.local ? (
          <span
            data-testid="graph-local-badge"
            className="shrink-0 rounded bg-line/70 px-1.5 py-0.5 text-[10px] leading-none text-muted"
          >
            Local
          </span>
        ) : null}
        <span
          title={counts}
          className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[12px] tabular-nums text-muted"
        >
          <output data-testid="graph-doc-count" className="shrink-0">
            {itemCount}
          </output>
          <span aria-hidden className="text-subtle">
            ·
          </span>
          <output data-testid="graph-link-count" className="min-w-0 truncate">
            {linkCount}
          </output>
        </span>
        {notice && variant === "page" ? (
          <span
            data-testid="graph-unresolved-count"
            title={notice}
            className="inline-flex min-w-0 items-center gap-1 text-[12px] text-subtle"
          >
            <ListFilter size={12} aria-hidden className="shrink-0" />
            <span className="truncate">{notice}</span>
          </span>
        ) : notice ? (
          // The side panel has room for the counts only, so the notice is its icon.
          <span
            data-testid="graph-unresolved-count"
            role="img"
            aria-label={notice}
            title={notice}
            className="inline-flex shrink-0 text-subtle"
          >
            <ListFilter size={12} aria-hidden />
          </span>
        ) : null}
        {gathering ? (
          <p
            role="status"
            title="Gathering linked mentions…"
            className="min-w-0 truncate text-[12px] text-subtle"
          >
            Gathering linked mentions…
          </p>
        ) : null}
        <span className="ml-auto" />
        {variant === "page" ? (
          <GraphSearch
            value={search}
            model={model}
            groups={groups}
            onChange={setSearch}
            onOpen={openNode}
            onPointNode={setPointIndex}
          />
        ) : null}
        {props.chatMentionsAvailable ? (
          <IconButton
            data-testid="graph-chat-mentions-toggle"
            aria-label="Chat mentions"
            aria-pressed={includeChatMentions}
            title="Show chat and heading mentions"
            onClick={() => setIncludeChatMentions((value) => !value)}
            className="shrink-0 aria-pressed:bg-selected aria-pressed:text-ink"
          >
            <MessageSquare size={13} aria-hidden />
          </IconButton>
        ) : null}
        <IconButton
          aria-label="Refresh graph"
          title="Refresh graph"
          onClick={load}
          className="shrink-0"
        >
          <RefreshCw size={13} aria-hidden />
        </IconButton>
        <IconButton
          ref={settingsTriggerRef}
          data-testid="graph-settings-toggle"
          aria-label="Graph settings"
          aria-pressed={settingsOpen}
          title="Graph settings"
          onClick={() => setSettingsOpen((open) => !open)}
          className="shrink-0 aria-pressed:bg-selected aria-pressed:text-ink"
        >
          <SlidersHorizontal size={13} aria-hidden />
        </IconButton>
      </div>

      {empty ? (
        <EmptyState icon={FileText} title="Add a page to start a graph." />
      ) : (
        <div
          className={
            variant === "page"
              ? "relative flex min-h-0 flex-1"
              : "relative flex min-h-0 flex-1 flex-col"
          }
        >
          {loadingBlank ? (
            <div
              className={
                variant === "page"
                  ? "flex flex-1 items-center justify-center"
                  : "flex h-72 shrink-0 items-center justify-center"
              }
            >
              {showLoading ? (
                <p role="status" className="text-[12px] text-subtle">
                  Gathering linked mentions…
                </p>
              ) : null}
            </div>
          ) : (
            canvas
          )}
          {scopedState.status === "error" ? (
            <div className="absolute left-2 top-2">
              <RetryRow testId="graph-retry" onRetry={load} />
            </div>
          ) : null}
          {!loadingBlank &&
          model.nodes.length === 0 &&
          deferredSearch.trim() &&
          variant === "page" ? (
            <p className="absolute inset-x-0 top-1/2 text-center text-sm text-muted">
              {`No items match "${deferredSearch.trim()}".`}
            </p>
          ) : null}
          {settingsOpen ? (
            <GraphSettings
              value={settings}
              counts={model.kindCounts}
              local={variant === "panel"}
              triggerRef={settingsTriggerRef}
              onChange={setSettings}
              onClose={() => setSettingsOpen(false)}
            />
          ) : null}
          {variant === "panel" && !loadingBlank ? (
            <GraphRows
              model={model}
              groups={groups}
              activePath={shownPath}
              onOpen={openNode}
              onFocusNode={setFocusIndex}
              onPointNode={setPointIndex}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
