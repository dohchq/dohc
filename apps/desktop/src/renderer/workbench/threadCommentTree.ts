import type { ChatMessageRecord } from "../../ipc/bridgeContract";

export interface ThreadCommentNode {
  message: ChatMessageRecord;
  replies: ThreadCommentNode[];
}

// Missing parents, self-links, and every comment whose ancestry reaches a
// cycle stay visible as roots. Preserve the message stream's sibling order.
export function buildThreadCommentTree(
  openingMessageId: string,
  comments: readonly ChatMessageRecord[],
): ThreadCommentNode[] {
  const nodes: ThreadCommentNode[] = comments.map((message) => ({
    message,
    replies: [],
  }));
  const byId = new Map(nodes.map((node) => [node.message.id, node]));
  const roots: ThreadCommentNode[] = [];
  const ancestry = new Map<string, "visiting" | "safe" | "cycle">();
  const path: string[] = [];

  const reachesCycle = (messageId: string): boolean => {
    const known = ancestry.get(messageId);
    if (known !== undefined) return known !== "safe";
    path.length = 0;
    let cursor: string | undefined = messageId;
    let cycle = false;
    while (cursor && cursor !== openingMessageId) {
      const known = ancestry.get(cursor);
      if (known !== undefined) {
        cycle = known !== "safe";
        break;
      }
      const node = byId.get(cursor);
      if (!node) break;
      ancestry.set(cursor, "visiting");
      path.push(cursor);
      cursor = node.message.parentMessageId;
    }
    for (const id of path) ancestry.set(id, cycle ? "cycle" : "safe");
    return cycle;
  };

  for (const node of nodes) {
    const parentId = node.message.parentMessageId;
    const parent =
      parentId && parentId !== openingMessageId ? byId.get(parentId) : undefined;
    if (parent && !reachesCycle(node.message.id)) {
      parent.replies.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
