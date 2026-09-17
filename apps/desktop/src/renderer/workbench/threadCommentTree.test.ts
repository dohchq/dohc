import { describe, expect, it } from "vitest";
import type { ChatMessageRecord } from "../../ipc/bridgeContract";
import { buildThreadCommentTree, type ThreadCommentNode } from "./threadCommentTree";

const comment = (id: string, parentMessageId?: string): ChatMessageRecord =>
  ({ id, parentMessageId }) as ChatMessageRecord;
const ids = (nodes: ThreadCommentNode[]) => nodes.map(node => node.message.id);

describe("thread comment tree", () => {
  it("preserves chronological roots and siblings even when a parent appears later", () => {
    const tree = buildThreadCommentTree("opening", [
      comment("child-a", "parent"),
      comment("root-a", "opening"),
      comment("child-b", "parent"),
      comment("parent", "opening"),
      comment("root-b"),
    ]);
    expect(ids(tree)).toEqual(["root-a", "parent", "root-b"]);
    expect(ids(tree[1]!.replies)).toEqual(["child-a", "child-b"]);
  });

  it("keeps missing-parent comments as roots with their valid descendants attached", () => {
    const tree = buildThreadCommentTree("opening", [
      comment("orphan", "missing"),
      comment("child", "orphan"),
      comment("grandchild", "child"),
    ]);
    expect(ids(tree)).toEqual(["orphan"]);
    expect(ids(tree[0]!.replies)).toEqual(["child"]);
    expect(ids(tree[0]!.replies[0]!.replies)).toEqual(["grandchild"]);
  });

  it("keeps cycles, self-links, and all their descendants as separate roots", () => {
    const comments = [
      comment("descendant-first", "cycle-a"),
      comment("cycle-a", "cycle-b"),
      comment("cycle-b", "cycle-a"),
      comment("descendant-later", "descendant-first"),
      comment("self", "self"),
      comment("self-descendant", "self"),
    ];
    const tree = buildThreadCommentTree("opening", comments);
    expect(ids(tree)).toEqual(comments.map(message => message.id));
    expect(tree.every(node => node.replies.length === 0)).toBe(true);
  });

  it("handles long parent chains iteratively", () => {
    const comments = Array.from({ length: 5000 }, (_, i) =>
      comment(String(i), i === 0 ? "opening" : String(i - 1)),
    );
    const tree = buildThreadCommentTree("opening", [...comments].reverse());
    expect(ids(tree)).toEqual(["0"]);
    let node = tree[0]!;
    for (let i = 1; i < comments.length; i++) {
      expect(node.replies.length).toBe(1);
      node = node.replies[0]!;
      expect(node.message).toBe(comments[i]);
    }
    expect(node.replies).toEqual([]);
  });
});
