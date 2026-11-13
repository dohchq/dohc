import { describe, expect, it } from "vitest";
import {
  answerDecision,
  answerOutcome,
  answerWithReply,
  postToGroup,
  reactToMessage,
  replyInThread,
  sendToStream,
} from "./chatWrites";
import { MemoryChatStore, memoryWriteHost, WORKSPACE_ID } from "./testing/memoryChatStore";

// `findMessage` gives the host the hook a filtered store's host provides.
function trip(options: { findMessage?: boolean } = {}) {
  const store = new MemoryChatStore();
  const group = store.addChannel({ id: "channel-trip", name: "Trip" });
  const dm = store.addChannel({ id: "channel-ada", name: "Ada", kind: "dm" });
  const { host, commands } = memoryWriteHost(store, options);
  return { store, group, dm, host, commands };
}

// A post with a question in it, read back as the engine stores it.
function asked(store: MemoryChatStore, options?: readonly string[]) {
  store.addThread({ id: "thread-plan", channelId: "channel-trip", lane: "posts" });
  const question = store.addMessage({ id: "question", threadId: "thread-plan", body: "Which day?" });
  store.addDecision("thread-plan", { messageId: question.id, state: "open", ...(options ? { options } : {}) });
  store.log.length = 0;
  return question;
}

describe("post and send", () => {
  it("starts a post thread in a Group", async () => {
    const { host, commands } = trip();
    const posted = await postToGroup(host, { channelId: "channel-trip", title: "Plan", body: "Where to?\r\n", threadId: "thread-new" });
    expect(posted).toMatchObject({ threadId: "thread-new", thread: { lane: "posts", title: "Plan" }, message: { body: "Where to?" } });
    expect(commands).toEqual([{ start: { channelId: "channel-trip", lane: "posts", title: "Plan", threadId: "thread-new", body: "Where to?" } }]);
  });

  it("sends into a Group's chat lane and returns the running thread, not the one proposed", async () => {
    const { host } = trip();
    const first = await sendToStream(host, { channelId: "channel-trip", body: "Who drives?", threadId: "thread-first" });
    const second = await sendToStream(host, { channelId: "channel-trip", body: "I can.", threadId: "thread-second" });
    expect(first.threadId).toBe("thread-first");
    expect(second.threadId).toBe("thread-first");
    expect(second.message.threadId).toBe("thread-first");
  });

  it("starts an empty DM's conversation, then joins it", async () => {
    const { host, commands } = trip();
    const opened = await sendToStream(host, { channelId: "channel-ada", body: "Hi Ada" });
    const joined = await sendToStream(host, { channelId: "channel-ada", body: "Are you there?", threadId: "thread-proposed" });
    expect(joined.threadId).toBe(opened.threadId);
    expect(joined.threadId).not.toBe("thread-proposed");
    expect(commands.map((command) => (command as { start: { lane: string } }).start.lane)).toEqual(["chat", "chat"]);
  });

  it.each([
    ["an empty body", { body: " \r\n" }, "The message is empty. Enter a message."],
    ["a body over 64 KiB", { body: "界".repeat(30_000) }, "The message is longer than 64 KiB. Shorten it."],
    ["thirteen choices", { body: "Pick", options: Array.from({ length: 13 }, (_, index) => `Choice ${index}`) }, "A poll has at most twelve choices."],
    ["a repeated choice", { body: "Pick", options: ["Monday", " Monday "] }, "Each choice appears once."],
    ["a blank choice", { body: "Pick", options: ["Monday", "  "] }, "Each choice is one line of at most 200 characters."],
    ["a two-line choice", { body: "Pick", options: ["Mon\nday"] }, "Each choice is one line of at most 200 characters."],
    ["a long choice", { body: "Pick", options: ["x".repeat(201)] }, "Each choice is one line of at most 200 characters."],
  ] as const)("refuses %s before the host is asked", async (_case, message, reason) => {
    const { store, host } = trip();
    await expect(postToGroup(host, { channelId: "channel-trip", ...message })).rejects.toThrow(reason);
    await expect(sendToStream(host, { channelId: "channel-trip", ...message })).rejects.toThrow(reason);
    await expect(replyInThread(host, { threadId: "thread-plan", ...message })).rejects.toThrow(reason);
    expect(store.log).toEqual([]);
  });

  it("passes a poll's choices as given and marks a decision only when asked", async () => {
    const { host, commands } = trip();
    await postToGroup(host, { channelId: "channel-trip", body: "When?", options: [" Monday ", "Tuesday"] });
    await postToGroup(host, { channelId: "channel-trip", body: "Ready?", needsDecision: true });
    await postToGroup(host, { channelId: "channel-trip", body: "Hello", needsDecision: false, options: [] });
    expect(commands).toEqual([
      { start: { channelId: "channel-trip", lane: "posts", body: "When?", options: [" Monday ", "Tuesday"] } },
      { start: { channelId: "channel-trip", lane: "posts", body: "Ready?", needsDecision: true } },
      { start: { channelId: "channel-trip", lane: "posts", body: "Hello" } },
    ]);
  });

  it("counts choices apart as the engine does: U+FEFF stays, so these two differ", async () => {
    const { host, commands } = trip();
    await postToGroup(host, { channelId: "channel-trip", body: "When?", options: ["Monday", "﻿Monday"] });
    expect(commands).toEqual([{ start: { channelId: "channel-trip", lane: "posts", body: "When?", options: ["Monday", "﻿Monday"] } }]);
    await expect(postToGroup(host, { channelId: "channel-trip", body: "When?", options: ["Monday", "Monday\u0085"] }))
      .rejects.toThrow("Each choice appears once.");
  });
});

describe("reply", () => {
  it("replies under a parent with the caller's ids, leaving the parent to the engine without the hook", async () => {
    const { store, host, commands } = trip();
    const question = asked(store);
    const sent = await replyInThread(host, {
      threadId: "thread-plan", parentMessageId: question.id, body: "Monday", messageId: "message-fixed", idempotencyKey: "reply-key",
    });
    expect(sent).toMatchObject({ id: "message-fixed", threadId: "thread-plan", parentMessageId: "question" });
    expect(store.log).toEqual(["admit", "reply"]);
    expect(commands).toEqual([{ reply: {
      threadId: "thread-plan", parentMessageId: "question", body: "Monday", messageId: "message-fixed", idempotencyKey: "reply-key",
    } }]);
  });

  it("finds the parent through the host's hook, and refuses one from another thread, or none, before the host writes", async () => {
    const { store, host } = trip({ findMessage: true });
    asked(store);
    store.addThread({ id: "thread-other", channelId: "channel-trip" });
    store.addMessage({ id: "elsewhere", threadId: "thread-other" });
    store.log.length = 0;
    await replyInThread(host, { threadId: "thread-plan", parentMessageId: "question", body: "Monday" });
    expect(store.log).toEqual(["getMessage", "admit", "reply"]);
    store.log.length = 0;
    await expect(replyInThread(host, { threadId: "thread-plan", parentMessageId: "elsewhere", body: "Hi" }))
      .rejects.toThrow("dohc: no such message in this thread: elsewhere");
    await expect(replyInThread(host, { threadId: "thread-plan", parentMessageId: "missing", body: "Hi" }))
      .rejects.toThrow("message-not-found");
    expect(store.log).toEqual(["getMessage", "getMessage"]);
  });
});

describe("answer", () => {
  it("replies, then resolves with this reply, each stage under its own key", async () => {
    const { store, host, commands } = trip();
    asked(store, ["Monday", "Tuesday"]);
    const outcome = await answerDecision(host, {
      threadId: "thread-plan", body: "Monday", idempotencyKey: "reply-key",
      resolves: { messageId: "question", chosenOption: " Monday ", idempotencyKey: "decision-key" },
    });
    expect(outcome).toMatchObject({ state: "resolved", message: { body: "Monday" }, decision: { resolvedByMessageId: outcome.message.id, chosenOption: "Monday" } });
    expect(store.log).toEqual(["admit", "listThreadDecisions", "reply", "resolve"]);
    expect(commands).toEqual([
      { reply: { threadId: "thread-plan", body: "Monday", idempotencyKey: "reply-key" } },
      { resolve: {
        threadId: "thread-plan", messageId: "question", resolvedByMessageId: outcome.message.id,
        chosenOption: "Monday", idempotencyKey: "decision-key",
      } },
    ]);
  });

  it("reads the question once, using the one its caller already read", async () => {
    const { store, host } = trip();
    asked(store, ["Monday", "Tuesday"]);
    const [question] = await store.listThreadDecisions(WORKSPACE_ID, "thread-plan");
    store.log.length = 0;
    await expect(answerDecision(host, { threadId: "thread-plan", body: "Friday", question, resolves: { messageId: "question", chosenOption: "Friday" } }))
      .rejects.toThrow("Pick one of the poll's choices.");
    expect(store.log).toEqual([]);
    const outcome = await answerDecision(host, { threadId: "thread-plan", body: "Monday", question, resolves: { messageId: "question", chosenOption: "Monday" } });
    expect(outcome).toMatchObject({ state: "resolved" });
    expect(store.log).toEqual(["admit", "reply", "resolve"]);
    await expect(answerDecision(host, { threadId: "thread-plan", body: "Monday", question, resolves: { messageId: "other" } }))
      .rejects.toThrow("dohc: no such question in this thread: other");
  });

  it("keeps the reply and names the winner when another reply answered first", async () => {
    const { store, host } = trip();
    asked(store);
    store.addMessage({ id: "earlier", threadId: "thread-plan", body: "Friday" });
    store.decisions.get("thread-plan")![0]!.state = "resolved";
    store.decisions.get("thread-plan")![0]!.resolvedByMessageId = "earlier";
    const outcome = await answerDecision(host, { threadId: "thread-plan", body: "Monday", resolves: { messageId: "question" } });
    expect(outcome).toMatchObject({ state: "lost", winnerMessageId: "earlier", decision: { resolvedByMessageId: "earlier" } });
    expect(store.messages.get("thread-plan")!.map((message) => message.id)).toEqual(["question", "earlier", outcome.message.id]);
  });

  it("keeps the reply and says why when the resolve fails", async () => {
    const { store, host } = trip();
    asked(store);
    const answer = host.answer;
    host.answer = (command, checkTargets, use) => answer(command, checkTargets, (stages) => use({
      ...stages, resolve: async () => { throw new Error("Your server session changed. Try again."); },
    }));
    const outcome = await answerDecision(host, { threadId: "thread-plan", body: "Monday", resolves: { messageId: "question" } });
    expect(outcome).toMatchObject({ state: "failed", message: { body: "Monday" }, failure: { message: "Your server session changed. Try again." } });
  });

  it.each([
    ["no choice for a poll", ["Monday", "Tuesday"], undefined, "Pick one of the poll's choices."],
    ["a choice the poll lacks", ["Monday", "Tuesday"], "Friday", "Pick one of the poll's choices."],
    ["a choice for a bare question", undefined, "Monday", "This question has no choices to pick from."],
  ] as const)("refuses %s before the reply", async (_case, options, chosenOption, reason) => {
    const { store, host } = trip();
    asked(store, options);
    await expect(answerDecision(host, {
      threadId: "thread-plan", body: "Monday", resolves: { messageId: "question", ...(chosenOption ? { chosenOption } : {}) },
    })).rejects.toThrow(reason);
    expect(store.log).toEqual(["admit", "listThreadDecisions"]);
    expect(store.messages.get("thread-plan")).toHaveLength(1);
  });

  // The engine trims with Rust's str::trim, Unicode White_Space only: it keeps U+FEFF and strips U+0085.
  it("trims a choice as the engine does, so a choice it stored with U+FEFF still answers", async () => {
    const { store, host } = trip();
    asked(store, ["﻿Monday", "Tuesday"]);
    const outcome = await answerDecision(host, {
      threadId: "thread-plan", body: "Monday", resolves: { messageId: "question", chosenOption: "﻿Monday\u0085" },
    });
    expect(outcome).toMatchObject({ state: "resolved", decision: { chosenOption: "﻿Monday" } });
  });

  it("refuses a question the thread doesn't have before the reply", async () => {
    const { store, host } = trip();
    asked(store);
    await expect(answerDecision(host, { threadId: "thread-plan", body: "Monday", resolves: { messageId: "missing" } }))
      .rejects.toThrow("dohc: no such question in this thread: missing");
    expect(store.log).not.toContain("reply");
  });

  describe("with a reply that saved", () => {
    it("resolves with that reply and posts nothing", async () => {
      const { store, host } = trip();
      asked(store, ["Monday", "Tuesday"]);
      store.addMessage({ id: "mine", threadId: "thread-plan", body: "Monday" });
      const outcome = await answerWithReply(host, { threadId: "thread-plan", messageId: "question", replyId: "mine", chosenOption: "Monday" });
      expect(outcome).toMatchObject({ state: "resolved", message: { id: "mine" }, decision: { resolvedByMessageId: "mine" } });
      expect(store.log).not.toContain("reply");
      expect(store.messages.get("thread-plan")).toHaveLength(2);
    });

    it("needs no open question, and names the winner when another reply answered", async () => {
      const { store, host } = trip();
      asked(store);
      store.addMessage({ id: "earlier", threadId: "thread-plan" });
      store.addMessage({ id: "mine", threadId: "thread-plan" });
      Object.assign(store.decisions.get("thread-plan")![0]!, { state: "resolved", resolvedByMessageId: "earlier" });
      await expect(answerWithReply(host, { threadId: "thread-plan", messageId: "question", replyId: "mine" }))
        .resolves.toMatchObject({ state: "lost", message: { id: "mine" }, winnerMessageId: "earlier" });
      // The same reply already won: a retry finds it resolved.
      Object.assign(store.decisions.get("thread-plan")![0]!, { resolvedByMessageId: "mine" });
      await expect(answerWithReply(host, { threadId: "thread-plan", messageId: "question", replyId: "mine" }))
        .resolves.toMatchObject({ state: "resolved" });
    });

    it("finds the question and the reply through the host's hook before it resolves", async () => {
      const { store, host } = trip({ findMessage: true });
      asked(store);
      store.addThread({ id: "thread-other", channelId: "channel-trip", lane: "posts" });
      store.addMessage({ id: "elsewhere", threadId: "thread-other" });
      store.addMessage({ id: "mine", threadId: "thread-plan" });
      await expect(answerWithReply(host, { threadId: "thread-plan", messageId: "question", replyId: "elsewhere" }))
        .rejects.toThrow("no such message in this thread: elsewhere");
      await expect(answerWithReply(host, { threadId: "thread-plan", messageId: "elsewhere", replyId: "mine" }))
        .rejects.toThrow("no such message in this thread: elsewhere");
      expect(store.log).not.toContain("resolve");
    });
  });

  it("writes no reply when its host never checked the question", async () => {
    const { store, host } = trip();
    asked(store, ["Monday", "Tuesday"]);
    const answer = host.answer;
    host.answer = (command, _checkTargets, use) => answer(command, async () => undefined, use);
    await expect(answerDecision(host, { threadId: "thread-plan", body: "Monday", resolves: { messageId: "question", chosenOption: "Monday" } }))
      .rejects.toThrow("The question wasn't checked before the reply.");
    expect(store.log).not.toContain("reply");
    expect(store.messages.get("thread-plan")).toHaveLength(1);
  });

  it("judges the winner by the decision alone", () => {
    const message = { id: "mine", workspaceId: WORKSPACE_ID, threadId: "thread", body: "Monday", createdAtMs: 1, author: { kind: "human" as const, displayName: "Sam" }, attachments: [] };
    const decision = { workspaceId: WORKSPACE_ID, threadId: "thread", messageId: "question", state: "resolved" as const, atMs: 2 };
    expect(answerOutcome(message, { ...decision, resolvedByMessageId: "mine" })).toMatchObject({ state: "resolved" });
    expect(answerOutcome(message, { ...decision, resolvedByMessageId: "other" })).toMatchObject({ state: "lost", winnerMessageId: "other" });
    expect(answerOutcome(message, { ...decision, state: "open" })).toMatchObject({ state: "failed" });
  });
});

describe("react", () => {
  it("sets exactly the state asked for, with the caller's key, leaving the message to the engine without the hook", async () => {
    const { store, host, commands } = trip();
    asked(store);
    await reactToMessage(host, { threadId: "thread-plan", messageId: "question", emoji: "👍", state: "added", idempotencyKey: "react-1" });
    await reactToMessage(host, { threadId: "thread-plan", messageId: "question", emoji: "👍", state: "added", idempotencyKey: "react-1" });
    await reactToMessage(host, { threadId: "thread-plan", messageId: "question", emoji: "👍", state: "removed", idempotencyKey: "react-2" });
    expect(commands).toEqual([
      { react: { threadId: "thread-plan", messageId: "question", emoji: "👍", state: "added", idempotencyKey: "react-1" } },
      { react: { threadId: "thread-plan", messageId: "question", emoji: "👍", state: "added", idempotencyKey: "react-1" } },
      { react: { threadId: "thread-plan", messageId: "question", emoji: "👍", state: "removed", idempotencyKey: "react-2" } },
    ]);
    expect(store.log).not.toContain("getMessage");
  });

  it("refuses a toggle, and through the host's hook a message from another thread, before the host writes", async () => {
    const { store, host } = trip({ findMessage: true });
    asked(store);
    const toggle = "toggle" as unknown as "added";
    await expect(reactToMessage(host, { threadId: "thread-plan", messageId: "question", emoji: "👍", state: toggle }))
      .rejects.toThrow("A reaction is added or removed.");
    await expect(reactToMessage(host, { threadId: "thread-other", messageId: "question", emoji: "👍", state: "added" }))
      .rejects.toThrow("dohc: no such message in this thread: question");
    expect(store.log).toEqual(["getMessage"]);
  });
});
