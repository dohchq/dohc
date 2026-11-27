import type {
  LinksConnectionEdge,
  LinksConnectionNode,
  LinksConnectionsResult,
  LinksEdgesResult,
} from "@dohc/workspace-contracts/links";
import type { ChatFileMentionRecord } from "../../ipc/bridgeContract";
import {
  chatTabPath,
  collectionTabPath,
  parseTab,
  siteTabPath,
  transactionalCollectionTabPath,
} from "./workbenchState";

export function graphPathForTab(path: string | null): string | null {
  const tab = parseTab(path);
  switch (tab?.kind) {
    case "file":
      return tab.path;
    case "collection":
      return tab.collectionPath && `collection:${tab.collectionPath}`;
    case "transactionalCollection":
      return `dataset:${tab.datasetPath}`;
    case "site":
      return tab.siteRoot && `app:${tab.siteRoot}`;
    case "chat":
      return tab.target.kind === "channel" ? `group:${tab.target.id}` : null;
    default:
      return null;
  }
}

export function connectionTabPath(node: LinksConnectionNode): string {
  switch (node.kind) {
    case "document-collection":
      return collectionTabPath(node.path);
    case "dataset":
      return node.firstTableId
        ? transactionalCollectionTabPath(node.path, node.firstTableId)
        : node.path;
    case "app":
      return siteTabPath(node.path);
    case "automation":
      return node.path;
    case "group":
      return chatTabPath({ kind: "channel", id: node.channelId });
  }
}

type NodeBase = { path: string; title: string; incoming: number; outgoing: number };
export type GraphNode = NodeBase &
  (
    | { kind: "file"; filePath: string; headingAnchor?: never; objectId?: string }
    | { kind: "heading"; filePath: string; headingAnchor: string }
    | {
        kind: "chat-thread";
        threadId: string;
        channelId?: string;
        channelWireId?: string;
        channelName?: string;
        channelSlug?: string;
        channelKind?: "channel" | "dm" | "agent";
      }
    | { kind: "connection"; connection: LinksConnectionNode }
  );
export type GraphEdge = {
  source: string;
  target: string;
  kind:
    | "wikilink"
    | "markdown"
    | "chat-mentions-file"
    | "chat-mentions-heading"
    | "heading-in-file"
    | "record-in-collection"
    | LinksConnectionEdge["kind"];
  approval?: LinksConnectionEdge["approval"];
};
export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  complete: boolean;
  indexBuilding: boolean;
  mountsCovered: boolean;
  unchecked: string[];
};
export const emptyGraph = (): GraphData => ({
  nodes: [],
  edges: [],
  complete: true,
  indexBuilding: false,
  mountsCovered: true,
  unchecked: [],
});

const fileNode = (path: string): GraphNode => ({
  path,
  filePath: path,
  kind: "file",
  title: path.split("/").at(-1) ?? path,
  incoming: 0,
  outgoing: 0,
});
const edgeKey = (edge: GraphEdge) => JSON.stringify([edge.source, edge.target, edge.kind]);

export function degrees(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const byPath = new Map(nodes.map((node) => [node.path, { ...node, incoming: 0, outgoing: 0 }]));
  for (const edge of edges) {
    const source = byPath.get(edge.source),
      target = byPath.get(edge.target);
    if (source && target) {
      source.outgoing++;
      target.incoming++;
    }
  }
  return [...byPath.values()];
}
// One accumulator per walk; published snapshots never share mutable nodes.
export function graphWalk() {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const unchecked = new Set<string>();
  let complete = true,
    indexBuilding = false,
    mountsCovered = true;
  const ensure = (path: string) => {
    let node = nodes.get(path);
    if (!node) {
      node = fileNode(path);
      nodes.set(path, node);
    }
    return node;
  };
  return {
    append(page: LinksEdgesResult) {
      for (const file of page.files) Object.assign(ensure(file.path), file);
      for (const { source, target, kind } of page.entries) {
        const key = JSON.stringify([source, target, kind]);
        if (edges.has(key)) continue;
        edges.set(key, { source, target, kind });
        ensure(source).outgoing++;
        ensure(target).incoming++;
      }
      for (const path of page.unchecked) unchecked.add(path);
      complete &&= page.complete;
      indexBuilding ||= page.indexBuilding;
      mountsCovered &&= page.mountsCovered;
    },
    snapshot(): GraphData {
      return {
        nodes: [...nodes.values()].map((node) => ({ ...node })),
        edges: [...edges.values()],
        complete,
        indexBuilding,
        mountsCovered,
        unchecked: [...unchecked],
      };
    },
  };
}
export function withChatMentions(graph: GraphData, mentions: ChatFileMentionRecord[]): GraphData {
  const nodes = new Map(graph.nodes.map((node) => [node.path, node]));
  const edges = new Map(graph.edges.map((edge) => [edgeKey(edge), edge]));
  const add = (edge: GraphEdge) => edges.set(edgeKey(edge), edge);
  for (const row of mentions) {
    const file = row.attachment.pathHint;
    if (!file) continue;
    const base = nodes.get(file) ?? fileNode(file);
    if (
      base.kind !== "file" ||
      (row.attachment.objectId && base.objectId && base.objectId !== row.attachment.objectId)
    )
      continue;
    nodes.set(file, base);
    const thread = "chat-thread:" + encodeURIComponent(row.thread.id);
    nodes.set(thread, {
      path: thread,
      kind: "chat-thread",
      threadId: row.thread.id,
      title: row.thread.title || row.channelName || "",
      channelId: row.channelId,
      channelWireId: row.channelWireId,
      channelName: row.channelName,
      channelSlug: row.channelSlug,
      channelKind: row.channelKind,
      incoming: 0,
      outgoing: 0,
    });
    let target = file;
    if (row.attachment.headingAnchor && row.attachment.headingText) {
      target =
        "heading:" +
        JSON.stringify([
          base.objectId ?? file,
          row.attachment.headingAnchor,
          row.attachment.headingOccurrence ?? 0,
        ]);
      nodes.set(target, {
        path: target,
        kind: "heading",
        filePath: file,
        headingAnchor: row.attachment.headingAnchor,
        title: "#" + row.attachment.headingText,
        incoming: 0,
        outgoing: 0,
      });
      add({ source: target, target: file, kind: "heading-in-file" });
    }
    add({
      source: thread,
      target,
      kind: target === file ? "chat-mentions-file" : "chat-mentions-heading",
    });
  }
  const visible = [...edges.values()];
  return { ...graph, nodes: degrees([...nodes.values()], visible), edges: visible };
}

export function withConnections(
  graph: GraphData,
  connections: LinksConnectionsResult | undefined,
  showRecords: boolean,
): GraphData {
  if (connections?.scope !== "workspace") return graph;
  const nodes = new Map(graph.nodes.map((node) => [node.path, node]));
  const collectionOf = new Map(
    connections.records.flatMap(({ collection, paths }) => paths.map((path) => [path, collection])),
  );
  const at = (path: string) => (showRecords ? path : (collectionOf.get(path) ?? path));
  if (!showRecords) for (const path of collectionOf.keys()) nodes.delete(path);
  for (const connection of connections.nodes)
    nodes.set(connection.id, {
      path: connection.id,
      kind: "connection",
      connection,
      title: connection.title,
      incoming: 0,
      outgoing: 0,
    });
  const edges = new Map<string, GraphEdge>();
  const add = (edge: GraphEdge) => {
    if (edge.source !== edge.target) edges.set(edgeKey(edge), edge);
  };
  for (const edge of graph.edges)
    add({ ...edge, source: at(edge.source), target: at(edge.target) });
  for (const edge of connections.edges) {
    if (!nodes.has(edge.target)) nodes.set(edge.target, fileNode(edge.target));
    add(edge);
  }
  if (showRecords)
    for (const [path, collection] of collectionOf)
      if (nodes.has(path)) add({ source: path, target: collection, kind: "record-in-collection" });
  const visible = [...edges.values()];
  return {
    ...graph,
    nodes: degrees([...nodes.values()], visible),
    edges: visible,
    complete: graph.complete && connections.complete,
    mountsCovered: graph.mountsCovered && connections.mountsCovered,
  };
}
