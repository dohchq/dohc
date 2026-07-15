import { describe, expect, it } from "vitest";
import type { WorkspaceGraph } from "./workspaceGraph";
import {
  addChatMentionsToWorkspaceGraph,
  type AuthorizedChatFileGraphMention,
} from "./chatMentionGraphOverlay";

function baseGraph(): WorkspaceGraph {
  return {
    nodes: [
      { path: "docs/plan.md", title: "Plan", incoming: 1, outgoing: 0 },
      { path: "docs/source.md", title: "Source", incoming: 0, outgoing: 1 },
    ],
    edges: [
      { source: "docs/source.md", target: "docs/plan.md", kind: "markdown" },
    ],
    unresolvedLinks: 0,
    scannedFileCount: 2,
    omittedFileCount: 0,
    truncatedFileCount: 0,
  };
}

describe("addChatMentionsToWorkspaceGraph", () => {
  it("returns the base graph by identity when chat mentions are off", () => {
    const base = baseGraph();
    expect(addChatMentionsToWorkspaceGraph(base, [], false)).toBe(base);
  });

  it("adds whole-file and referenced-heading paths with aggregate mention metadata", () => {
    const mentions: AuthorizedChatFileGraphMention[] = [
      {
        threadId: "thread-1",
        threadTitle: "Pricing discussion",
        messageId: "message-2",
        fileObjectId: "object-plan",
        filePath: "docs/plan.md",
        channel: {
          id: "channel-shared",
          wireId: "wire-shared",
          name: "shared",
          slug: "shared",
          kind: "channel",
        },
        heading: {
          sectionId: "section-pricing",
          anchor: "pricing-assumptions",
          text: "Pricing assumptions",
        },
      },
      // Replay of the same source message must not inflate the edge count.
      {
        threadId: "thread-1",
        threadTitle: "Pricing discussion",
        messageId: "message-2",
        fileObjectId: "object-plan",
        filePath: "docs/plan.md",
        heading: {
          sectionId: "section-pricing",
          anchor: "pricing-assumptions",
          text: "Pricing assumptions",
        },
      },
      {
        threadId: "thread-1",
        threadTitle: "Pricing discussion",
        messageId: "message-3",
        fileObjectId: "object-plan",
        filePath: "docs/plan.md",
        heading: {
          sectionId: "section-pricing",
          anchor: "pricing-assumptions",
          text: "Pricing assumptions",
        },
      },
      {
        threadId: "thread-2",
        threadTitle: "Launch notes",
        messageId: "message-4",
        fileObjectId: "object-plan",
        filePath: "docs/plan.md",
      },
    ];

    const graph = addChatMentionsToWorkspaceGraph(baseGraph(), mentions, true);
    expect(graph.nodes.map((node) => node.kind)).toEqual([
      "file",
      "file",
      "heading",
      "chat-thread",
      "chat-thread",
    ]);
    expect(graph.nodes.filter((node) => node.kind === "heading")).toMatchObject([
      {
        title: "Pricing assumptions",
        sectionId: "section-pricing",
        filePath: "docs/plan.md",
        incoming: 1,
        outgoing: 1,
      },
    ]);
    expect(
      graph.nodes.find(
        (node) => node.kind === "chat-thread" && node.threadId === "thread-1",
      ),
    ).toMatchObject({ channel: { id: "channel-shared", wireId: "wire-shared" } });
    expect(graph.edges.map((edge) => edge.kind)).toEqual([
      "chat-mentions-heading",
      "chat-mentions-file",
      "markdown",
      "heading-in-file",
    ]);
    expect(
      graph.edges.find((edge) => edge.kind === "chat-mentions-heading"),
    ).toMatchObject({
      mentionCount: 2,
      messageIds: ["message-2", "message-3"],
    });
  });

  it("is independent of mention input order and skips files absent from the base graph", () => {
    const mentions: AuthorizedChatFileGraphMention[] = [
      {
        threadId: "thread-b",
        threadTitle: "Z title",
        messageId: "message-b",
        fileObjectId: "object-plan",
        filePath: "docs/plan.md",
        heading: { anchor: "scope", occurrence: 1, text: "Scope" },
      },
      {
        threadId: "thread-a",
        threadTitle: "A title",
        messageId: "message-a",
        fileObjectId: "object-hidden",
        filePath: "private/hidden.md",
      },
      {
        threadId: "thread-b",
        threadTitle: "A renamed title",
        messageId: "message-c",
        fileObjectId: "object-plan",
        filePath: "docs/plan.md",
        heading: { anchor: "scope", occurrence: 1, text: "Scope" },
      },
    ];
    const forward = addChatMentionsToWorkspaceGraph(baseGraph(), mentions, true);
    const reversed = addChatMentionsToWorkspaceGraph(
      baseGraph(),
      [...mentions].reverse(),
      true,
    );

    expect(reversed).toEqual(forward);
    expect(forward.nodes.some((node) => node.kind === "chat-thread" && node.threadId === "thread-a"))
      .toBe(false);
    expect(forward.nodes.find((node) => node.kind === "chat-thread")).toMatchObject({
      title: "A renamed title",
    });
  });

  it("keeps duplicate heading anchors distinct by occurrence", () => {
    const mentions: AuthorizedChatFileGraphMention[] = [0, 1].map((occurrence) => ({
      threadId: `thread-${occurrence}`,
      threadTitle: `Thread ${occurrence}`,
      messageId: `message-${occurrence}`,
      fileObjectId: "object-plan",
      filePath: "docs/plan.md",
      heading: { anchor: "notes", occurrence, text: "Notes" },
    }));
    const graph = addChatMentionsToWorkspaceGraph(baseGraph(), mentions, true);

    expect(graph.nodes.filter((node) => node.kind === "heading")).toHaveLength(2);
    expect(graph.edges.filter((edge) => edge.kind === "heading-in-file")).toHaveLength(2);
  });
});
