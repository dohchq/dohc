import { describe, expect, it } from "vitest";
import type { ChatWrite } from "../server/chatWrites";
import type { OutboxState } from "../server/outbox";
import type { OutboxRecord } from "./conversationWrites";
import { fileCommentRows, recoveryRows, streamRows, threadRows } from "./outboxMessages";

const ME = { origin: "https://dohc.example.com", accountId: "u-1" };
const HERE = { ...ME, workspaceId: "ws-1" };

let sequence = 0;
function record(write: ChatWrite, fields: Partial<OutboxRecord> = {}): OutboxRecord {
  sequence += 1;
  return {
    ...HERE,
    operationId: `op-${sequence}`,
    messageId: `message-${sequence}`,
    sequence,
    dependsOn: null,
    target: { kind: "stream", id: "group-1" },
    write,
    stage: "queued",
    attempted: false,
    withheld: false,
    pendingSinceMs: null,
    result: null,
    ...fields,
  };
}
const send = (body: string, streamId = "group-1"): ChatWrite => ({
  operation: "send",
  args: { streamId, body },
});
const post = (body: string, title?: string): ChatWrite => ({
  operation: "post",
  args: { groupId: "group-1", body, ...(title ? { title } : {}) },
});
const reply = (body: string, threadId: string | null): ChatWrite => ({
  operation: "reply",
  args: { threadId, body },
});
const state = (
  records: OutboxRecord[],
  unreadable: string[] = [],
  unconfirmed: string[] = [],
): OutboxState => ({
  status: "ready",
  records,
  unreadable,
  deletion: "none",
  unconfirmed,
});

describe("a stream's outbox rows", () => {
  it("show only this account's writes to this workspace's stream", () => {
    const mine = record(send("Mine"));
    const rows = streamRows(
      state([
        mine,
        record(send("Other account"), { accountId: "u-2" }),
        record(send("Other server"), { origin: "https://other.example.com" }),
        record(send("Other workspace"), { workspaceId: "ws-2" }),
        record(send("Other chat", "group-2")),
        record({ operation: "react", args: { messageId: "m", emoji: "👍", state: "added" } }),
      ]),
      HERE,
      "group-1",
      new Set(),
    );
    expect(rows.map((row) => row.mark.body)).toEqual(["Mine"]);
    expect(rows[0]).toMatchObject({ messageId: mine.messageId, lane: "chat" });
  });

  it("put a post in the posts lane, with its title", () => {
    const [row] = streamRows(state([record(post("Body", "Plan"))]), HERE, "group-1", new Set());
    expect(row).toMatchObject({ lane: "posts", title: "Plan", mark: { body: "Body" } });
  });

  it("leave a message to the server's row once a read shows it, before the outbox hands it off", () => {
    const saved = record(send("Saved"), {
      stage: "saved",
      attempted: true,
      result: { kind: "saved", threadId: "t", messageId: "message-from-server" },
    });
    const pending = record(send("Pending"), { stage: "sending", attempted: true });
    expect(
      streamRows(state([saved, pending]), HERE, "group-1", new Set(["message-from-server"])).map(
        (row) => row.mark.body,
      ),
    ).toEqual(["Pending"]);
    // Saved, and no read shows it yet: it stays, so it never disappears and comes back.
    expect(
      streamRows(state([saved]), HERE, "group-1", new Set()).map((row) => row.mark.state),
    ).toEqual([{ kind: "saved" }]);
  });

  it("don't show a refused message twice when its message was published", () => {
    const refused = record(send("Partial"), {
      stage: "refused",
      attempted: true,
      result: { kind: "refused", reason: "Couldn't send", threadId: null, winnerMessageId: null },
    });
    expect(
      streamRows(state([refused]), HERE, "group-1", new Set([refused.messageId ?? ""])),
    ).toEqual([]);
  });

  it("say where each write stands", () => {
    const states = streamRows(
      state([
        record(send("a")),
        record(send("b"), { stage: "sending", attempted: true }),
        record(send("c"), { stage: "stalled", attempted: true }),
        record(send("d"), { withheld: true }),
        record(send("e"), {
          stage: "refused",
          attempted: true,
          result: { kind: "refused", reason: "too old", threadId: null, winnerMessageId: null },
        }),
        record(send("f"), {
          stage: "refused",
          attempted: true,
          result: { kind: "missing", reason: "gone" },
        }),
      ]),
      HERE,
      "group-1",
      new Set(),
    ).map((row) => row.mark.state);
    expect(states).toEqual([
      { kind: "waiting" },
      { kind: "sending" },
      { kind: "stalled" },
      { kind: "withheld" },
      { kind: "refused", reason: "too old" },
      { kind: "missing" },
    ]);
  });

  it("keep a withheld message's stored body and operation, for Send", () => {
    const withheld = record(send("Stored body"), { withheld: true });
    const [row] = streamRows(state([withheld]), HERE, "group-1", new Set());
    expect(row?.mark).toEqual({
      operationId: withheld.operationId,
      state: { kind: "withheld" },
      attempted: false,
      body: "Stored body",
    });
  });
});

describe("Messages on this phone", () => {
  it("list the account's unsaved messages in every workspace, and records that can't be read", () => {
    const here = record(send("Here"), { withheld: true });
    const there = record(send("There"), { workspaceId: "ws-2", stage: "stalled", attempted: true });
    const { rows, unreadable } = recoveryRows(
      state(
        [
          here,
          there,
          record(send("Saved"), {
            stage: "saved",
            result: { kind: "saved", threadId: null, messageId: null },
          }),
          record(send("Not mine"), { accountId: "u-2" }),
        ],
        ["handle-1"],
      ),
      ME,
    );
    expect(rows).toEqual([
      {
        workspaceId: "ws-1",
        streamId: "group-1",
        threadId: null,
        mark: expect.objectContaining({ body: "Here" }),
      },
      {
        workspaceId: "ws-2",
        streamId: "group-1",
        threadId: null,
        mark: expect.objectContaining({ body: "There" }),
      },
    ]);
    expect(unreadable).toEqual(["handle-1"]);
  });

  it("name a reply's or reaction's thread once it's known, so it opens there", () => {
    const { rows } = recoveryRows(
      state([
        record(reply("In a thread", "thread-1"), { target: { kind: "thread", id: "thread-1" } }),
        record(reply("Waiting", null), { target: null, dependsOn: "op-x" }),
        record(
          { operation: "react", args: { messageId: "m", emoji: "👍", state: "added" } },
          { messageId: null, target: { kind: "thread", id: "thread-2" } },
        ),
      ]),
      ME,
    );
    expect(rows.map((row) => [row.streamId, row.threadId])).toEqual([
      [null, "thread-1"],
      [null, null],
      [null, "thread-2"],
    ]);
  });

  it("list a saved reaction a read since shows otherwise, with what it asks for, and no other saved reaction", () => {
    const saved = (
      emoji: string,
      reaction: "added" | "removed",
      fields: Partial<OutboxRecord> = {},
    ) =>
      record(
        { operation: "react", args: { messageId: "m", emoji, state: reaction } },
        {
          messageId: null,
          target: { kind: "thread", id: "thread-2" },
          stage: "saved",
          attempted: true,
          result: { kind: "saved", threadId: "thread-2", messageId: null },
          ...fields,
        },
      );
    const doubted = saved(" 👍", "added");
    const waiting = saved("🎉", "removed");
    const another = saved("👀", "added", { accountId: "u-2" });
    const { rows } = recoveryRows(
      state([doubted, waiting, another], [], [doubted.operationId, another.operationId]),
      ME,
    );
    expect(rows).toEqual([
      {
        workspaceId: "ws-1",
        streamId: null,
        threadId: "thread-2",
        mark: expect.objectContaining({
          operationId: doubted.operationId,
          state: { kind: "saved" },
        }),
        reaction: {
          emoji: "👍",
          state: "added",
          mark: expect.objectContaining({ operationId: doubted.operationId }),
        },
      },
    ]);
  });
});

describe("replies on this phone", () => {
  it("wait in the stream under the outbox post or send they reply to, until they have a thread", () => {
    const parent = record(post("Plans"));
    const waiting = record(reply("Count me in", null), {
      target: null,
      dependsOn: parent.operationId,
    });
    const elsewhere = record(reply("Other chat", null), { target: null, dependsOn: "op-other" });
    const rows = streamRows(state([parent, waiting, elsewhere]), HERE, "group-1", new Set());
    expect(rows.map((row) => [row.lane, row.mark.body])).toEqual([
      ["posts", "Plans"],
      ["reply", "Count me in"],
    ]);
  });

  it("move to their thread once the outbox gives them one", () => {
    const parent = record(send("Lunch?"), {
      stage: "saved",
      attempted: true,
      result: { kind: "saved", threadId: "thread-1", messageId: "message-lunch" },
    });
    const bound = record(reply("Yes", "thread-1"), {
      target: { kind: "thread", id: "thread-1" },
      dependsOn: parent.operationId,
    });
    const all = state([parent, bound]);
    expect(streamRows(all, HERE, "group-1", new Set()).map((row) => row.mark.body)).toEqual([
      "Lunch?",
    ]);
    expect(threadRows(all, HERE, "thread-1", new Set()).map((row) => row.mark.body)).toEqual([
      "Yes",
    ]);
  });

  it("show in a thread only this account's, in this workspace, until a read shows them", () => {
    const mine = record(reply("Mine", "thread-1"));
    const shown = record(reply("Shown", "thread-1"));
    const rows = threadRows(
      state([
        mine,
        shown,
        record(reply("Other thread", "thread-2")),
        record(reply("Other account", "thread-1"), { accountId: "u-2" }),
        record(reply("Other workspace", "thread-1"), { workspaceId: "ws-2" }),
        record(send("A message", "thread-1")),
      ]),
      HERE,
      "thread-1",
      new Set([shown.messageId ?? ""]),
    );
    expect(rows.map((row) => row.mark.body)).toEqual(["Mine"]);
  });

  it("can wait for a post or send that isn't refused or missing, and for no reply", () => {
    const rows = streamRows(
      state([
        record(send("Waiting")),
        record(send("Withheld"), { withheld: true }),
        record(send("Saved"), {
          stage: "saved",
          result: { kind: "saved", threadId: "thread-9", messageId: null },
        }),
        record(send("Refused"), {
          stage: "refused",
          result: { kind: "refused", reason: "too old", threadId: null, winnerMessageId: null },
        }),
        record(send("Missing"), { stage: "refused", result: { kind: "missing", reason: "gone" } }),
      ]),
      HERE,
      "group-1",
      new Set(),
    );
    expect(rows.map((row) => [row.mark.body, row.replyable, row.threadId])).toEqual([
      ["Waiting", true, null],
      ["Withheld", true, null],
      ["Saved", true, "thread-9"],
      ["Refused", false, null],
      ["Missing", false, null],
    ]);
  });

  it("shows pending file comments until fileChats includes their saved threadId, and exposes filePath in recoveryRows", () => {
    const comment = (path: string, expectedObjectId: string, body: string) => ({
      operation: "comment" as const,
      args: { path, expectedObjectId, body },
    });
    const pending = record(comment("docs/plan.md", "obj-1", "Waiting comment"), {
      target: { kind: "file", id: "obj-1" },
    });
    const savedShown = record(comment("docs/plan.md", "obj-1", "Already listed"), {
      target: { kind: "file", id: "obj-1" },
      stage: "saved",
      attempted: true,
      result: { kind: "saved", threadId: "thread-listed", messageId: "msg-listed" },
    });
    const otherFile = record(comment("docs/other.md", "obj-2", "Other file"), {
      target: { kind: "file", id: "obj-2" },
    });
    const all = state([pending, savedShown, otherFile]);
    expect(
      fileCommentRows(all, HERE, "docs/plan.md", "obj-1", new Set(["thread-listed"])).map(
        (r) => r.mark.body,
      ),
    ).toEqual(["Waiting comment"]);
    expect(recoveryRows(all, { origin: HERE.origin, accountId: HERE.accountId }).rows).toEqual([
      expect.objectContaining({
        workspaceId: "ws-1",
        streamId: null,
        threadId: null,
        filePath: "docs/plan.md",
      }),
      expect.objectContaining({
        workspaceId: "ws-1",
        streamId: null,
        threadId: null,
        filePath: "docs/other.md",
      }),
    ]);
  });
});
