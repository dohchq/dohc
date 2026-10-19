import type { LinksEdgesResult } from "@dohc/workspace-contracts/links";
import type { ChatFileMentionRecord } from "../../ipc/bridgeContract";

type NodeBase = { path: string; title: string; incoming: number; outgoing: number };
export type GraphNode = NodeBase & (
  | { kind: "file"; filePath: string; headingAnchor?: never; objectId?: string }
  | { kind: "heading"; filePath: string; headingAnchor: string }
  | { kind: "chat-thread"; threadId: string; channelId?: string; channelWireId?: string; channelName?: string; channelSlug?: string; channelKind?: "channel" | "dm" | "agent" }
);
export type GraphEdge = { source: string; target: string; kind: "wikilink" | "markdown" | "chat-mentions-file" | "chat-mentions-heading" | "heading-in-file" };
export type GraphData = { nodes: GraphNode[]; edges: GraphEdge[]; complete: boolean; indexBuilding: boolean; mountsCovered: boolean; unchecked: string[] };
export const emptyGraph = (): GraphData => ({ nodes: [], edges: [], complete: true, indexBuilding: false, mountsCovered: true, unchecked: [] });

export function degrees(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const byPath = new Map(nodes.map(node => [node.path, { ...node, incoming: 0, outgoing: 0 }]));
  for (const edge of edges) {
    const source = byPath.get(edge.source), target = byPath.get(edge.target);
    if (source && target) { source.outgoing++; target.incoming++; }
  }
  return [...byPath.values()];
}
export function appendPage(graph: GraphData, page: LinksEdgesResult): GraphData {
  const nodes = new Map(graph.nodes.map(node => [node.path, node]));
  for (const file of page.files) nodes.set(file.path, { ...file, kind: "file", filePath: file.path, incoming: 0, outgoing: 0 });
  for (const edge of page.entries) for (const path of [edge.source, edge.target]) {
    if (!nodes.has(path)) nodes.set(path, { path, filePath: path, kind: "file", title: path.split("/").at(-1) ?? path, incoming: 0, outgoing: 0 });
  }
  const edges = new Map(graph.edges.map(edge => [JSON.stringify([edge.source, edge.target, edge.kind]), edge]));
  for (const { source, target, kind } of page.entries) edges.set(JSON.stringify([source, target, kind]), { source, target, kind });
  const visible = [...edges.values()];
  return { nodes: degrees([...nodes.values()], visible), edges: visible, complete: graph.complete && page.complete,
    indexBuilding: graph.indexBuilding || page.indexBuilding, mountsCovered: graph.mountsCovered && page.mountsCovered,
    unchecked: [...new Set([...graph.unchecked, ...page.unchecked])] };
}
export function withChatMentions(graph: GraphData, mentions: ChatFileMentionRecord[]): GraphData {
  const nodes = new Map(graph.nodes.map(node => [node.path, node]));
  const edges = new Map(graph.edges.map(edge => [JSON.stringify([edge.source,edge.target,edge.kind]),edge]));
  const add = (edge: GraphEdge) => edges.set(JSON.stringify([edge.source,edge.target,edge.kind]),edge);
  for (const row of mentions) {
    const file = row.attachment.pathHint;
    if (!file || !nodes.has(file)) continue;
    const base = nodes.get(file);
    if (base?.kind !== "file" || (row.attachment.objectId && base.objectId !== row.attachment.objectId)) continue;
    const thread = "chat-thread:" + encodeURIComponent(row.thread.id);
    nodes.set(thread,{ path:thread,kind:"chat-thread",threadId:row.thread.id,title:row.thread.title,
      channelId:row.channelId,channelWireId:row.channelWireId,channelName:row.channelName,channelSlug:row.channelSlug,channelKind:row.channelKind,incoming:0,outgoing:0 });
    let target = file;
    if (row.attachment.headingAnchor && row.attachment.headingText) {
      target = "heading:" + JSON.stringify([base.objectId ?? file,row.attachment.headingAnchor,row.attachment.headingOccurrence ?? 0]);
      nodes.set(target,{path:target,kind:"heading",filePath:file,headingAnchor:row.attachment.headingAnchor,title:"#"+row.attachment.headingText,incoming:0,outgoing:0});
      add({source:target,target:file,kind:"heading-in-file"});
    }
    add({source:thread,target,kind:target === file ? "chat-mentions-file" : "chat-mentions-heading"});
  }
  const visible = [...edges.values()];
  return {...graph,nodes:degrees([...nodes.values()],visible),edges:visible};
}
