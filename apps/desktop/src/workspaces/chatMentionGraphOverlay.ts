import type {
  WorkspaceGraph,
  WorkspaceGraphEdgeKind,
} from "./workspaceGraph";

/**
 * One chat mention that the caller has already authorized for both the source
 * chat and target file. The overlay deliberately has no permission resolver;
 * main must omit every record the viewer may not see before calling it.
 */
export interface AuthorizedChatFileGraphMention {
  threadId: string;
  threadTitle: string;
  messageId: string;
  fileObjectId: string;
  filePath: string;
  channel?: {
    id: string;
    wireId?: string;
    name: string;
    slug: string;
    kind: "channel" | "dm" | "agent";
  };
  heading?: {
    // Preferred durable identity. Plain Markdown references may temporarily
    // fall back to anchor + duplicate occurrence until a section id exists.
    sectionId?: string;
    anchor: string;
    text: string;
    occurrence?: number;
  };
}

export type ChatMentionGraphNode =
  | {
      id: string;
      kind: "file";
      path: string;
      title: string;
      objectId?: string;
      incoming: number;
      outgoing: number;
    }
  | {
      id: string;
      kind: "chat-thread";
      threadId: string;
      title: string;
      channel?: AuthorizedChatFileGraphMention["channel"];
      incoming: number;
      outgoing: number;
    }
  | {
      id: string;
      kind: "heading";
      filePath: string;
      fileObjectId: string;
      sectionId?: string;
      anchor: string;
      occurrence: number;
      title: string;
      incoming: number;
      outgoing: number;
    };

export type ChatMentionGraphEdgeKind =
  | WorkspaceGraphEdgeKind
  | "chat-mentions-file"
  | "chat-mentions-heading"
  | "heading-in-file";

export interface ChatMentionGraphEdge {
  source: string;
  target: string;
  kind: ChatMentionGraphEdgeKind;
  // Present only on chat mention edges. Duplicate input rows collapse to one
  // message id so counts cannot be inflated by replay or repeated queries.
  mentionCount?: number;
  messageIds?: string[];
}

export interface WorkspaceGraphWithChatMentions
  extends Omit<WorkspaceGraph, "nodes" | "edges"> {
  nodes: ChatMentionGraphNode[];
  edges: ChatMentionGraphEdge[];
}

function stableText(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function fileNodeId(path: string): string {
  return `file:${encodeURIComponent(path)}`;
}

function threadNodeId(threadId: string): string {
  return `chat-thread:${encodeURIComponent(threadId)}`;
}

function headingNodeId(mention: AuthorizedChatFileGraphMention): string {
  const heading = mention.heading!;
  const fileIdentity = mention.fileObjectId || mention.filePath;
  const headingIdentity = heading.sectionId
    ? `section:${heading.sectionId}`
    : `anchor:${heading.anchor}:${heading.occurrence ?? 0}`;
  return `heading:${encodeURIComponent(fileIdentity)}:${encodeURIComponent(headingIdentity)}`;
}

function edgeKey(edge: Pick<ChatMentionGraphEdge, "source" | "target" | "kind">): string {
  return `${edge.source}\u0000${edge.target}\u0000${edge.kind}`;
}

function compareNode(a: ChatMentionGraphNode, b: ChatMentionGraphNode): number {
  const rank = { file: 0, heading: 1, "chat-thread": 2 } as const;
  return rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id);
}

function compareEdge(a: ChatMentionGraphEdge, b: ChatMentionGraphEdge): number {
  return (
    a.source.localeCompare(b.source) ||
    a.target.localeCompare(b.target) ||
    a.kind.localeCompare(b.kind)
  );
}

/**
 * Adds chat-thread and referenced-heading structure to an existing file graph.
 * With the toggle off it returns the exact base object unchanged. Mentions for
 * files absent from the authorized/capped base graph are skipped, preventing
 * the overlay from reintroducing a path the file graph intentionally omitted.
 */
export function addChatMentionsToWorkspaceGraph(
  base: WorkspaceGraph,
  mentions: readonly AuthorizedChatFileGraphMention[],
  enabled: false,
): WorkspaceGraph;
export function addChatMentionsToWorkspaceGraph(
  base: WorkspaceGraph,
  mentions: readonly AuthorizedChatFileGraphMention[],
  enabled: true,
): WorkspaceGraphWithChatMentions;
export function addChatMentionsToWorkspaceGraph(
  base: WorkspaceGraph,
  mentions: readonly AuthorizedChatFileGraphMention[],
  enabled: boolean,
): WorkspaceGraph | WorkspaceGraphWithChatMentions {
  if (!enabled) return base;

  const nodes = new Map<string, ChatMentionGraphNode>();
  const basePaths = new Set(base.nodes.map((node) => node.path));
  for (const node of base.nodes) {
    const id = fileNodeId(node.path);
    nodes.set(id, {
      id,
      kind: "file",
      path: node.path,
      title: node.title,
      incoming: 0,
      outgoing: 0,
    });
  }

  const edges = new Map<string, ChatMentionGraphEdge>();
  for (const edge of base.edges) {
    const converted: ChatMentionGraphEdge = {
      source: fileNodeId(edge.source),
      target: fileNodeId(edge.target),
      kind: edge.kind,
    };
    edges.set(edgeKey(converted), converted);
  }

  // Sets aggregate replayed/duplicate mention rows without depending on input
  // order. Node titles choose the lexical minimum when inconsistent snapshots
  // describe the same durable id, which also keeps output deterministic.
  const mentionMessages = new Map<string, Set<string>>();
  for (const mention of mentions) {
    if (!basePaths.has(mention.filePath)) continue;
    const fileId = fileNodeId(mention.filePath);
    const existingFile = nodes.get(fileId);
    if (existingFile?.kind === "file") {
      if (!existingFile.objectId || mention.fileObjectId < existingFile.objectId) {
        existingFile.objectId = mention.fileObjectId;
      }
    }

    const threadId = threadNodeId(mention.threadId);
    const threadTitle = stableText(mention.threadTitle);
    const existingThread = nodes.get(threadId);
    if (!existingThread) {
      nodes.set(threadId, {
        id: threadId,
        kind: "chat-thread",
        threadId: mention.threadId,
        title: threadTitle,
        ...(mention.channel ? { channel: mention.channel } : {}),
        incoming: 0,
        outgoing: 0,
      });
    } else if (
      existingThread.kind === "chat-thread" &&
      threadTitle.localeCompare(existingThread.title) < 0
    ) {
      existingThread.title = threadTitle;
    }

    let target = fileId;
    let kind: ChatMentionGraphEdgeKind = "chat-mentions-file";
    if (mention.heading) {
      target = headingNodeId(mention);
      kind = "chat-mentions-heading";
      const headingTitle = stableText(mention.heading.text);
      const existingHeading = nodes.get(target);
      if (!existingHeading) {
        nodes.set(target, {
          id: target,
          kind: "heading",
          filePath: mention.filePath,
          fileObjectId: mention.fileObjectId,
          ...(mention.heading.sectionId
            ? { sectionId: mention.heading.sectionId }
            : {}),
          anchor: mention.heading.anchor,
          occurrence: mention.heading.occurrence ?? 0,
          title: headingTitle,
          incoming: 0,
          outgoing: 0,
        });
      } else if (
        existingHeading.kind === "heading" &&
        headingTitle.localeCompare(existingHeading.title) < 0
      ) {
        existingHeading.title = headingTitle;
      }
      const belongs: ChatMentionGraphEdge = {
        source: target,
        target: fileId,
        kind: "heading-in-file",
      };
      edges.set(edgeKey(belongs), belongs);
    }

    const mentionEdge: ChatMentionGraphEdge = {
      source: threadId,
      target,
      kind,
    };
    const key = edgeKey(mentionEdge);
    const messages = mentionMessages.get(key) ?? new Set<string>();
    messages.add(mention.messageId);
    mentionMessages.set(key, messages);
    edges.set(key, mentionEdge);
  }

  for (const [key, messageIds] of mentionMessages) {
    const edge = edges.get(key)!;
    edge.messageIds = [...messageIds].sort((a, b) => a.localeCompare(b));
    edge.mentionCount = edge.messageIds.length;
  }

  for (const edge of edges.values()) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (source) source.outgoing += 1;
    if (target) target.incoming += 1;
  }

  return {
    ...base,
    nodes: [...nodes.values()].sort(compareNode),
    edges: [...edges.values()].sort(compareEdge),
  };
}
