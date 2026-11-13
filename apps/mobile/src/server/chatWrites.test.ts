import { describe, expect, it } from "vitest";
import { readChatWrite, readWriteAnswer, sendWrite } from "./chatWrites";
import { createServerClient, ServerError } from "./client";
import { testServer } from "./testServer";

const route = (result: unknown, cursor: unknown = "0.1.1") => ({ ok: true, result, cursor });

describe("a write's answer", () => {
  it("reads saved and pending, with their IDs when given", () => {
    expect(readWriteAnswer(route({ ok: true, state: "saved", threadId: "thread-1", messageId: "message-1" })))
      .toEqual({ kind: "saved", threadId: "thread-1", messageId: "message-1" });
    // A reaction's answer names no message.
    expect(readWriteAnswer(route({ ok: true, state: "saved" }))).toEqual({ kind: "saved", threadId: null, messageId: null });
    expect(readWriteAnswer(route({ ok: true, state: "pending", threadId: "thread-1" }))).toEqual({ kind: "pending", threadId: "thread-1", messageId: null });
  });

  it("reads each refusal on the closed list, with its thread and winner", () => {
    for (const reason of ["already answered", "The message it replies to wasn't sent", "This workspace changed on your server", "Couldn't send", "too old"]) {
      expect(readWriteAnswer(route({ ok: false, refusal: "refused", reason }))).toEqual({ kind: "refused", reason, threadId: null, winnerMessageId: null });
    }
    expect(readWriteAnswer(route({ ok: false, refusal: "refused", reason: "already answered", threadId: "thread-1", winnerMessageId: "message-9" })))
      .toEqual({ kind: "refused", reason: "already answered", threadId: "thread-1", winnerMessageId: "message-9" });
    expect(readWriteAnswer(route({ ok: false, refusal: "missing", reason: "Thread not found" }))).toEqual({ kind: "missing", reason: "Thread not found" });
  });

  it("refuses anything else, so the write is asked again rather than settled", () => {
    for (const body of [
      route({ ok: false, refusal: "refused", reason: "engine exploded" }),
      route({ ok: false, refusal: "refused" }),
      route({ ok: true, state: "stalled" }),
      route({ ok: true, state: "saved", messageId: 7 }),
      route({ ok: true, state: "saved", threadId: "" }),
      route({ ok: false, refusal: "missing" }),
      route({ ok: true, state: "saved" }, "not-a-cursor"),
      { ok: true, result: { ok: true, state: "saved" } },
      { ok: false, error: "nope" },
      null,
    ]) expect(readWriteAnswer(body)).toBeNull();
  });
});

describe("sending a write", () => {
  it("posts its operation ID and exact arguments to the workspace's route, with the Bearer token", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws%201/ops/reply", { status: 200, body: route({ ok: true, state: "saved", threadId: "thread-1", messageId: "message-1" }) });
    const client = createServerClient({ origin: server.origin, token: "tok", fetch: server.fetch, signal: new AbortController().signal });
    const write = { operation: "reply", args: { threadId: "thread-1", body: "Yes", resolves: { messageId: "message-0", chosenOption: "Friday" } } } as const;

    await expect(sendWrite(client, "ws 1", "op-1", write, new AbortController().signal))
      .resolves.toEqual({ kind: "saved", threadId: "thread-1", messageId: "message-1" });
    expect(server.calls[0]).toMatchObject({
      method: "POST", headers: { authorization: "Bearer tok" },
      body: { operationId: "op-1", threadId: "thread-1", body: "Yes", resolves: { messageId: "message-0", chosenOption: "Friday" } },
    });
  });

  it("never sends a reply that doesn't know its thread yet", async () => {
    const server = testServer();
    const client = createServerClient({ origin: server.origin, token: "tok", fetch: server.fetch, signal: new AbortController().signal });
    const error = await sendWrite(client, "ws-1", "op-1", { operation: "reply", args: { threadId: null, body: "Hi" } }, new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ServerError);
    expect(server.calls).toHaveLength(0);
  });
});

describe("checking a write", () => {
  it("keeps only the route's fields", () => {
    expect(readChatWrite({ operation: "post", args: { groupId: "group-1", body: "Hi", agentId: "a-1", attachments: [] } }))
      .toEqual({ operation: "post", args: { groupId: "group-1", body: "Hi" } });
    expect(readChatWrite({ operation: "react", args: { messageId: "message-1", emoji: "👍", state: "added", actor: "x" } }))
      .toEqual({ operation: "react", args: { messageId: "message-1", emoji: "👍", state: "added" } });
  });

  it("refuses a write the route would refuse", () => {
    for (const write of [
      { operation: "post", args: { groupId: "group-1", body: "" } },
      { operation: "send", args: { body: "Hi" } },
      { operation: "reply", args: { body: "Hi" } },
      { operation: "react", args: { messageId: "message-1", emoji: "👍", state: "toggle" } },
      { operation: "post", args: { groupId: "group-1", body: "Hi", options: Array.from({ length: 13 }, (_, i) => `${i}`) } },
      { operation: "markRead", args: { threadId: "thread-1", messageId: "message-1" } },
    ]) expect(readChatWrite(write)).toBeNull();
  });
});
