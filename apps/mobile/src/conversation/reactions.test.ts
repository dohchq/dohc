import { describe, expect, it } from "vitest";
import type { ChatWrite } from "../server/chatWrites";
import type { OutboxState } from "../server/outbox";
import type { ChatReaction } from "../server/workspaceReads";
import type { OutboxRecord } from "./conversationWrites";
import {
  confirmedReactions,
  nextReaction,
  reactionRecords,
  withLocalReactions,
  withReactions,
} from "./reactions";
import type { Message } from "./types";

const HERE = { origin: "https://dohc.example.com", accountId: "u-1", workspaceId: "ws-1" };

let sequence = 0;
function reacted(
  emoji: string,
  state: "added" | "removed",
  fields: Partial<OutboxRecord> = {},
  messageId = "m-1",
): OutboxRecord {
  sequence += 1;
  const write: ChatWrite = { operation: "react", args: { messageId, emoji, state } };
  return {
    ...HERE,
    operationId: `op-${sequence}`,
    messageId: null,
    sequence,
    dependsOn: null,
    target: { kind: "thread", id: "thread-1" },
    write,
    stage: "queued",
    attempted: false,
    withheld: false,
    pendingSinceMs: null,
    result: null,
    ...fields,
  };
}
const saved = {
  stage: "saved" as const,
  attempted: true,
  result: { kind: "saved" as const, threadId: null, messageId: null },
};
const refused = {
  stage: "refused" as const,
  attempted: true,
  result: {
    kind: "refused" as const,
    reason: "Couldn't send" as const,
    threadId: null,
    winnerMessageId: null,
  },
};

const by = (
  emoji: string,
  authorId: string,
  authorKind: "human" | "agent" = "human",
): ChatReaction => ({ emoji, authorId, authorKind, authorName: authorId, atMs: 0 });

describe("the server's reactions", () => {
  it("count each emoji once, in NFC and trimmed as the relay keeps it, and mark the account's own", () => {
    // "é" composed and decomposed are one emoji key after NFC.
    const decomposed = "é";
    expect(
      confirmedReactions(
        [by("👍", "u-2"), by(" 👍 ", "u-1"), by("é", "u-3"), by(decomposed, "u-4")],
        "u-1",
      ),
    ).toEqual([
      { emoji: "👍", count: 2, mine: true },
      { emoji: "é", count: 2 },
    ]);
  });

  it("never take an agent's reaction with the account's ID as the account's", () => {
    expect(confirmedReactions([by("👀", "u-1", "agent")], "u-1")).toEqual([
      { emoji: "👀", count: 1 },
    ]);
  });
});

describe("this phone's reactions over the server's", () => {
  const confirmed = [
    { emoji: "👍", count: 2, mine: true },
    { emoji: "🎉", count: 1 },
  ];

  it("show the latest one for each emoji, pending until saved, keeping everyone else's count", () => {
    const shown = withLocalReactions(
      confirmed,
      [
        reacted("👍", "removed", saved),
        reacted("🎉", "added", { stage: "sending", attempted: true }),
      ],
      "m-1",
    );
    expect(shown.reactions).toEqual([
      { emoji: "👍", count: 1 },
      { emoji: "🎉", count: 2, mine: true, pending: true },
    ]);
    expect(shown.busy).toBe(true);
    expect(shown.marks).toEqual([]);
  });

  it("follow the order they were made, so a later reaction wins", () => {
    const shown = withLocalReactions(
      [],
      [reacted("🚀", "added", saved), reacted("🚀", "removed", saved)],
      "m-1",
    );
    expect(shown.reactions).toEqual([]);
    expect(shown.busy).toBe(false);
  });

  it("add an emoji the server has none of", () => {
    expect(withLocalReactions(confirmed, [reacted("✅", "added")], "m-1").reactions).toEqual([
      ...confirmed,
      { emoji: "✅", count: 1, mine: true, pending: true },
    ]);
  });

  it("show the server's state again when one is refused, and keep it to discard", () => {
    const failed = reacted("🎉", "added", refused);
    const shown = withLocalReactions(confirmed, [failed], "m-1");
    expect(shown.reactions).toEqual(confirmed);
    expect(shown.marks).toEqual([
      { emoji: "🎉", mark: expect.objectContaining({ operationId: failed.operationId }) },
    ]);
    expect(shown.busy).toBe(false);
  });

  it("keep an earlier saved reaction when a later one is refused", () => {
    const shown = withLocalReactions(
      [],
      [reacted("✅", "added", saved), reacted("✅", "removed", refused)],
      "m-1",
    );
    expect(shown.reactions).toEqual([{ emoji: "✅", count: 1, mine: true }]);
  });

  it("show a withheld one pending, with its Send, and hold the message's reactions", () => {
    const withheld = reacted("🎉", "added", { withheld: true });
    const shown = withLocalReactions(confirmed, [withheld], "m-1");
    expect(shown.reactions[1]).toEqual({ emoji: "🎉", count: 2, mine: true, pending: true });
    expect(shown.marks.map(({ mark }) => mark.state.kind)).toEqual(["withheld"]);
    expect(shown.busy).toBe(true);
  });

  it("keep the chip of the account's sole reaction, at none and pending, while its removal isn't settled", () => {
    const sole = [{ emoji: "👍", count: 1, mine: true }];
    for (const fields of [
      {},
      { withheld: true },
      { stage: "sending" as const, attempted: true },
      { stage: "stalled" as const, attempted: true },
    ]) {
      const shown = withLocalReactions(sole, [reacted("👍", "removed", fields)], "m-1");
      expect(shown.reactions).toEqual([{ emoji: "👍", count: 0, pending: true }]);
      expect(shown.busy).toBe(true);
    }
    // Saved, it goes, as the server will show it.
    expect(withLocalReactions(sole, [reacted("👍", "removed", saved)], "m-1").reactions).toEqual(
      [],
    );
  });

  it("list one still sending, so it can be discarded from its message", () => {
    const stalled = reacted("👍", "removed", { stage: "stalled", attempted: true });
    const shown = withLocalReactions([{ emoji: "👍", count: 1, mine: true }], [stalled], "m-1");
    expect(shown.marks).toEqual([
      {
        emoji: "👍",
        mark: expect.objectContaining({
          operationId: stalled.operationId,
          state: { kind: "stalled" },
        }),
      },
    ]);
  });

  it("match an emoji typed in another Unicode form", () => {
    const shown = withLocalReactions(
      [{ emoji: "é", count: 1, mine: true }],
      [reacted("é", "removed", saved)],
      "m-1",
    );
    expect(shown.reactions).toEqual([]);
  });

  it("ignore another message's reactions", () => {
    const shown = withLocalReactions(confirmed, [reacted("🎉", "added", {}, "m-2")], "m-1");
    expect(shown).toEqual({ reactions: confirmed, marks: [], busy: false });
  });
});

describe("the outbox's reactions", () => {
  it("are only this account's, in this workspace, by message", () => {
    const mine = reacted("👍", "added");
    const other = reacted("👍", "added", {}, "m-2");
    const state: OutboxState = {
      status: "ready",
      records: [
        mine,
        other,
        reacted("👍", "added", { accountId: "u-2" }),
        reacted("👍", "added", { origin: "https://other.example.com" }),
        reacted("👍", "added", { workspaceId: "ws-2" }),
      ],
      aside: [],
      unreadable: [],
      deletion: "none",
    };
    const byMessage = reactionRecords(state, HERE);
    expect(byMessage.get("m-1")).toEqual([mine]);
    expect(byMessage.get("m-2")).toEqual([other]);
  });
});

describe("a tap on a reaction", () => {
  it("asks to remove the account's own, and to add any other, never a toggle", () => {
    const reactions = [
      { emoji: "👍", count: 2, mine: true },
      { emoji: "🎉", count: 1 },
    ];
    expect(nextReaction(reactions, "👍")).toBe("removed");
    expect(nextReaction(reactions, "🎉")).toBe("added");
    expect(nextReaction(undefined, "🚀")).toBe("added");
  });

  it("follows what shows, a pending reaction included", () => {
    const message: Message = {
      id: "m-1",
      threadId: "thread-1",
      author: { id: "a", name: "A", kind: "person" },
      at: "",
      minute: 0,
      body: [],
    };
    const shown = withReactions(message, [], [reacted("👍", "added", { stage: "sending" })]);
    expect(shown.reactionsBusy).toBe(true);
    expect(nextReaction(shown.reactions, "👍")).toBe("removed");
  });
});
