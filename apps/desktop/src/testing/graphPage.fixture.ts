import { vi } from "vitest";
import type { DohcDesktopBridge, ChatFileMentionRecord } from "../ipc/bridgeContract";
import type { LinksEdgesResult } from "@dohc/workspace-contracts/links";

type SampleNode = {
  path: string;
  title: string;
  kind?: string;
  threadId?: string;
  filePath?: string;
  headingAnchor?: string;
  channelId?: string;
  channelWireId?: string;
  channelName?: string;
  channelSlug?: string;
  channelKind?: "channel" | "dm" | "agent";
  incoming?: number;
  outgoing?: number;
};
export function installGraphFixture(
  bridge: { -readonly [K in "linksEdges" | "chatFileMentionsPage"]: DohcDesktopBridge[K] },
  graph: {
    nodes: SampleNode[];
    edges: LinksEdgesResult["entries"] | { source: string; target: string; kind: "wikilink" | "markdown" }[];
    [key: string]: unknown;
  },
) {
  const files = graph.nodes.filter(node => !node.kind || node.kind === "file")
    .map(node => ({ objectId: node.path, path: node.path, title: node.title }));
  for (const node of graph.nodes) {
    if (node.kind === "heading" && node.filePath && !files.some(file => file.path === node.filePath))
      files.push({ objectId: node.filePath, path: node.filePath, title: node.filePath });
  }
  if (!files.length) files.push({ objectId: "a.md", path: "a.md", title: "A" });
  bridge.linksEdges = vi.fn(async () => ({
    versionId: "main", files, entries: graph.edges.map((edge, ordinal) => ({ ...edge, ordinal })),
    unchecked: [], complete: true, indexBuilding: false, mountsCovered: true, nextCursor: null,
  }));
  bridge.chatFileMentionsPage = vi.fn(async ({ subject }) => ({
    versionId: "main", subject: null, unchecked: [], complete: true, indexBuilding: false, mountsCovered: true, sharedChannelRowsUncovered: 0, nextCursor: null,
    entries: files.filter(file => !subject || ("path" in subject ? subject.path === file.path : subject.objectId === file.objectId)).flatMap(({ path }) => graph.nodes.filter(node => node.kind === "chat-thread").flatMap(node => {
      const headings: (SampleNode | undefined)[] = [
        undefined, ...graph.nodes.filter(row => row.kind === "heading" && row.filePath === path),
      ];
      return headings.map(heading => ({
        thread: { id: node.threadId!, title: node.title, createdAtMs: 1, updatedAtMs: 1 },
        attachment: {
          attachmentId: JSON.stringify([node.path,path,heading?.headingAnchor]), threadId: node.threadId!, messageId: "m", targetKind: "file",
          objectId: path, pathHint: path, createdAtMs: 1,
          ...(heading ? { headingText: heading.title, headingAnchor: heading.headingAnchor, headingOccurrence: 0 } : {}),
        },
        message: {
          id: "m", authorDisplayName: "Alice",
          preview: "Mention", createdAtMs: 1,
        },
        channelId: node.channelId, channelWireId: node.channelWireId, channelName: node.channelName,
        channelSlug: node.channelSlug, channelKind: node.channelKind,
      } satisfies ChatFileMentionRecord));
    })),
  }));
}
