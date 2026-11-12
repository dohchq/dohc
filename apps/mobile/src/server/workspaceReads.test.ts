import { describe, expect, it } from "vitest";
import { createServerClient } from "./client";
import { testServer } from "./testServer";
import { readStream, readThread } from "./workspaceReads";

// The phone's chat reads keep what later controls need: a reply's parent, attachments, a question or poll with its
// answer, and reactions, each checked before it is kept. A message that fails a check fails the whole read.

const answered = (result: unknown) => ({ status: 200, body: { ok: true, result, cursor: "0.1.1" } });

const raw = (more: Record<string, unknown> = {}) => ({
  id: "message-2", threadId: "thread-1", authorKind: "human", authorDisplayName: "Maya Chen", body: "Alfama", createdAtMs: 5,
  attachments: [], needsDecision: false, ...more,
});

const poll = raw({
  id: "message-1", authorKind: "agent", authorDisplayName: "Nova", body: "Alfama or Baixa?", needsDecision: true, decisionState: "resolved",
  options: ["Alfama", "Baixa"], chosenOption: "Alfama", resolvedByMessageId: "message-2",
  attachments: [{ objectId: "object-plan", pathHint: "docs/plan.md" }, { pathHint: "docs/gone.md" }],
  reactions: [{ emoji: "👍", authorId: "user-maya", authorKind: "human", authorDisplayName: "Maya Chen", atMs: 7 }],
});
const answer = raw({ parentMessageId: "message-1" });

const kept = {
  poll: {
    id: "message-1", threadId: "thread-1", authorKind: "agent", authorName: "Nova", body: "Alfama or Baixa?", createdAtMs: 5,
    parentMessageId: null, needsDecision: true, decisionState: "resolved", options: ["Alfama", "Baixa"], chosenOption: "Alfama",
    resolvedByMessageId: "message-2",
    attachments: [{ objectId: "object-plan", pathHint: "docs/plan.md" }, { objectId: null, pathHint: "docs/gone.md" }],
    reactions: [{ emoji: "👍", authorId: "user-maya", authorKind: "human", authorName: "Maya Chen", atMs: 7 }],
  },
  answer: {
    id: "message-2", threadId: "thread-1", authorKind: "human", authorName: "Maya Chen", body: "Alfama", createdAtMs: 5,
    parentMessageId: "message-1", needsDecision: false, decisionState: null, options: [], chosenOption: null, resolvedByMessageId: null,
    attachments: [], reactions: [],
  },
};

function serve(result: unknown) {
  const server = testServer();
  server.on("POST", "/sync/ws-a/ops/chat", answered(result));
  const client = createServerClient({ origin: server.origin, token: "tok", fetch: server.fetch, signal: new AbortController().signal });
  return client;
}

const thread = (...messages: unknown[]) => ({
  ok: true, thread: { id: "thread-1", title: "Stay", createdAtMs: 1, updatedAtMs: 1 }, dispatch: { paused: null, lastRun: null },
  messages, projection: { path: "p", readOnly: true, text: "" },
});
const stream = (...messages: unknown[]) => ({
  ok: true,
  stream: { group: { id: "channel-1", name: "Trip", kind: "group" }, items: messages.map(message => ({ message })), nextBefore: null, readPosition: null },
});

describe("a chat read's messages", () => {
  it("keep a thread's parents, attachments, decisions and reactions", async () => {
    const read = await readThread(serve(thread(poll, answer)), "ws-a", "thread-1", new AbortController().signal);
    expect(read.value).toEqual({ kind: "thread", id: "thread-1", title: "Stay", messages: [kept.poll, kept.answer] });
  });

  it("keep the same in a stream's items", async () => {
    const read = await readStream(serve(stream(poll, answer)), "ws-a", "channel-1", new AbortController().signal);
    expect(read.value).toMatchObject({ kind: "stream", items: [{ message: kept.poll }, { message: kept.answer }] });
  });

  it("fail the whole read when any message's new fields don't check", async () => {
    const broken: Array<[label: string, message: unknown]> = [
      ["a parent that isn't an ID", raw({ parentMessageId: 7 })],
      ["no attachments", raw({ attachments: undefined })],
      ["an attachment that isn't an object", raw({ attachments: ["docs/plan.md"] })],
      ["no needsDecision", raw({ needsDecision: undefined })],
      ["a decision state on a message that asks none", raw({ decisionState: "open" })],
      ["a question with no state", raw({ needsDecision: true })],
      ["an unknown state", raw({ needsDecision: true, decisionState: "closed" })],
      ["an empty choice", raw({ needsDecision: true, decisionState: "open", options: ["Alfama", ""] })],
      ["a chosen option that isn't text", raw({ needsDecision: true, decisionState: "resolved", chosenOption: 1 })],
      ["a winning reply that isn't an ID", raw({ needsDecision: true, decisionState: "resolved", resolvedByMessageId: "" })],
      ["reactions that aren't a list", raw({ reactions: {} })],
      ["a reaction by an automation", raw({ reactions: [{ emoji: "👍", authorId: "a", authorKind: "automation", authorDisplayName: "Bot", atMs: 1 }] })],
      ["a reaction with no time", raw({ reactions: [{ emoji: "👍", authorId: "a", authorKind: "human", authorDisplayName: "Maya" }] })],
    ];
    for (const [label, message] of broken) {
      await expect(readThread(serve(thread(poll, message)), "ws-a", "thread-1", new AbortController().signal), label)
        .rejects.toMatchObject({ problem: "invalid" });
      await expect(readStream(serve(stream(poll, message)), "ws-a", "channel-1", new AbortController().signal), label)
        .rejects.toMatchObject({ problem: "invalid" });
    }
  });
});
