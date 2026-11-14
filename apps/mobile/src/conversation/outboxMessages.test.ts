import { describe, expect, it } from "vitest";
import type { ChatWrite } from "../server/chatWrites";
import type { OutboxState } from "../server/outbox";
import type { OutboxRecord } from "./conversationWrites";
import { recoveryRows, streamRows } from "./outboxMessages";

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
const state = (records: OutboxRecord[], unreadable: string[] = []): OutboxState => ({
  status: "ready",
  records,
  aside: unreadable,
  unreadable,
  deletion: "none",
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
      { workspaceId: "ws-1", streamId: "group-1", mark: expect.objectContaining({ body: "Here" }) },
      {
        workspaceId: "ws-2",
        streamId: "group-1",
        mark: expect.objectContaining({ body: "There" }),
      },
    ]);
    expect(unreadable).toEqual(["handle-1"]);
  });
});
