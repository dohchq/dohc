import {
  SHARE_OMITTED_CONNECTIONS,
  type LinksConnectionsResult,
} from "@dohc/workspace-contracts/links";
import { describe, expect, it } from "vitest";
import type { ChatFileMentionRecord } from "../../ipc/bridgeContract";
import {
  connectionTabPath,
  emptyGraph,
  graphPathForTab,
  graphWalk,
  withChatMentions,
  withConnections,
  type GraphData,
} from "./graphData";
import { chatTabPath, collectionTabPath, siteTabPath } from "./workbenchState";

describe("graph walk accumulation", () => {
  it("keeps snapshots immutable, deduplicates degrees and enriches targets", () => {
    const walk = graphWalk();
    const edge = { source: "a.md", target: "b.md", kind: "wikilink" as const, ordinal: 0 };
    const page = {
      versionId: "main",
      files: [{ path: "a.md", objectId: "a", title: "A" }],
      entries: [edge],
      complete: true,
      indexBuilding: false,
      mountsCovered: true,
      unchecked: [],
      nextCursor: "next",
    };
    walk.append(page);
    const first = walk.snapshot();
    walk.append({
      ...page,
      files: [{ path: "b.md", objectId: "b", title: "B" }],
      entries: [edge, { source: "b.md", target: "a.md", kind: "markdown", ordinal: 1 }],
    });
    const last = walk.snapshot();
    expect(first.nodes.find((n) => n.path === "b.md")).toMatchObject({
      title: "b.md",
      incoming: 1,
      outgoing: 0,
    });
    expect(last.nodes.find((n) => n.path === "b.md")).toMatchObject({
      title: "B",
      objectId: "b",
      incoming: 1,
      outgoing: 1,
    });
    expect(last.edges).toHaveLength(2);
  });
});

const files = (paths: string[]): GraphData => ({
  ...emptyGraph(),
  nodes: paths.map((path) => ({
    path,
    filePath: path,
    kind: "file" as const,
    title: path,
    incoming: 0,
    outgoing: 0,
  })),
});
const connections: LinksConnectionsResult = {
  scope: "workspace",
  nodes: [
    {
      id: "collection:Tasks",
      kind: "document-collection",
      path: "Tasks",
      title: "Tasks",
      recordCount: 1,
    },
    { id: "app:board", kind: "app", path: "board", title: "Board", entryPath: null },
  ],
  edges: [
    {
      source: "app:board",
      target: "collection:Tasks",
      kind: "app-uses-data",
      approval: "requested",
    },
  ],
  records: [{ collection: "collection:Tasks", paths: ["Tasks/one.md"] }],
  complete: true,
  mountsCovered: true,
};

describe("chat mentions", () => {
  it("draws a mentioned file the link walk never reached", () => {
    const mention = {
      attachment: { objectId: "pdf", pathHint: "report.pdf" },
      thread: { id: "t", title: "Report" },
    } as ChatFileMentionRecord;
    const graph = withChatMentions(files(["a.md"]), [mention]);
    expect(graph.nodes.find((node) => node.path === "report.pdf")).toMatchObject({
      kind: "file",
      incoming: 1,
    });
    expect(graph.edges).toEqual([
      { source: "chat-thread:t", target: "report.pdf", kind: "chat-mentions-file" },
    ]);
  });
});

describe("workspace connections", () => {
  const prose = {
    ...files(["Tasks/one.md", "notes.md"]),
    edges: [{ source: "notes.md", target: "Tasks/one.md", kind: "wikilink" as const }],
  };

  it("folds records into their Collection unless records are shown", () => {
    const folded = withConnections(prose, connections, false);
    expect(folded.nodes.map((node) => node.path).sort()).toEqual([
      "app:board",
      "collection:Tasks",
      "notes.md",
    ]);
    expect(folded.edges).toEqual([
      { source: "notes.md", target: "collection:Tasks", kind: "wikilink" },
      connections.edges[0],
    ]);
    const shown = withConnections(prose, connections, true);
    expect(shown.edges).toContainEqual({
      source: "Tasks/one.md",
      target: "collection:Tasks",
      kind: "record-in-collection",
    });
    expect(shown.nodes.some((node) => node.path === "Tasks/one.md")).toBe(true);
  });

  it("keeps the file graph as it is for a received share", () => {
    expect(withConnections(prose, SHARE_OMITTED_CONNECTIONS, false)).toBe(prose);
  });

  it("finds the node for an open tab, and opens each kind in its own tab", () => {
    expect(graphPathForTab("notes.md")).toBe("notes.md");
    expect(graphPathForTab(collectionTabPath("Tasks"))).toBe("collection:Tasks");
    expect(graphPathForTab(siteTabPath("board"))).toBe("app:board");
    expect(graphPathForTab(chatTabPath({ kind: "channel", id: "c1" }))).toBe("group:c1");
    expect(graphPathForTab(chatTabPath({ kind: "home" }))).toBeNull();
    for (const node of connections.nodes)
      expect(graphPathForTab(connectionTabPath(node))).toBe(node.id);
  });
});
