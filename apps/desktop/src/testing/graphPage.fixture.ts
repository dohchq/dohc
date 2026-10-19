import { vi } from "vitest";
import type { DohcDesktopBridge, ChatFileMentionRecord } from "../ipc/bridgeContract";
import type { LinksEdgesResult } from "@dohc/workspace-contracts/links";

type SampleNode = { path: string; title: string; kind?: string; threadId?: string; filePath?: string; headingAnchor?: string; channelId?: string; channelWireId?: string; channelName?: string; channelSlug?: string; channelKind?: "channel" | "dm" | "agent"; incoming?: number; outgoing?: number };
export function installGraphFixture(bridge: { -readonly [K in "linksEdges" | "listChatFileMentions"]: DohcDesktopBridge[K] }, graph: { nodes: SampleNode[]; edges: LinksEdgesResult["entries"] | {source:string;target:string;kind:"wikilink"|"markdown"}[]; [key: string]: unknown }) {
  const files = graph.nodes.filter(node => !node.kind || node.kind === "file").map(node => ({ objectId: node.path, path: node.path, title: node.title }));
  if (!files.length) files.push({ objectId: "a.md", path: "a.md", title: "A" });
  bridge.linksEdges = vi.fn(async () => ({ versionId:"main", files, entries:graph.edges.map((edge,ordinal)=>({...edge,ordinal})), unchecked:[],complete:true,indexBuilding:false,mountsCovered:true,nextCursor:null }));
  bridge.listChatFileMentions = vi.fn(async ({ path }) => ({
    mentions: graph.nodes.filter(node => node.kind === "chat-thread").map(node => ({
      thread: {id:node.threadId!,title:node.title,createdAtMs:1,updatedAtMs:1},
      attachment: {attachmentId:node.path,threadId:node.threadId!,messageId:"m",targetKind:"file",objectId:path,pathHint:path,createdAtMs:1},
      message: { id:"m",threadId:node.threadId!,authorKind:"human",authorDisplayName:"Alice",body:"Mention",createdAtMs:1,
        presentation:{group:"Alice",hue:null,self:false} },
      channelId:node.channelId,channelWireId:node.channelWireId,channelName:node.channelName,channelSlug:node.channelSlug,channelKind:node.channelKind,
    } satisfies ChatFileMentionRecord)),
  }));
}
