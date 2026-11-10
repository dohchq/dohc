import { describe, expect, it } from "vitest";
import {
  FILES_GROUP,
  listFileChats,
  listGroups,
  listGroupsWithThreads,
  listGroupThreads,
  readChat,
  showChat,
  type ChatsHost,
} from "./chats";
import { MemoryChatStore, memoryHost, WORKSPACE_ID } from "./testing/memoryChatStore";

function tripStore() {
  const store = new MemoryChatStore();
  const trip = store.addChannel({ id: "channel-trip", name: "Trip", purpose: "Plan the trip" });
  return { store, trip };
}

function shownThread(result: Awaited<ReturnType<typeof showChat>>) {
  if ("stream" in result) throw new Error("expected a thread");
  return result;
}

const provisioning: Array<[string, (host: ChatsHost) => Promise<unknown>]> = [
  ["groups", (host) => listGroups(host)],
  ["groupsFull", (host) => listGroupsWithThreads(host)],
  ["threads", (host) => listGroupThreads(host, { group: "trip", reader: null })],
  ["show", (host) => showChat(host, { cwd: "/", actor: "human", target: "trip", peek: true })],
];

describe("General", () => {
  it.each(provisioning)("%s creates it in a writable workspace and reports it before any later read", async (_verb, run) => {
    const { store } = tripStore();
    const host = memoryHost(store);
    await run(host);
    expect(host.provisions).toEqual([{ workspaceId: WORKSPACE_ID, added: [expect.objectContaining({ id: "channel-general", slug: "general" })] }]);
    expect(store.log.slice(0, 4)).toEqual(["listChannels", "ensureGeneralChannel", "listChannels", "provisioned"]);
    await run(host);
    expect(host.provisions).toHaveLength(1);
  });

  it.each(provisioning)("%s leaves a read-only workspace without it", async (_verb, run) => {
    const { store } = tripStore();
    const host = memoryHost(store, { writable: false });
    await run(host);
    expect(store.log).not.toContain("ensureGeneralChannel");
    expect(host.provisions).toEqual([]);
    expect(store.channels.map((channel) => channel.slug)).toEqual(["trip"]);
  });

  it("is never created by chat or fileChats", async () => {
    const { store } = tripStore();
    store.addThread({ id: "thread-a", channelId: "channel-trip" });
    const host = memoryHost(store, { files: { "notes/a.md": "object-a" } });
    await readChat(host, { cwd: "/", actor: "agent", group: "trip" });
    await readChat(host, { cwd: "/", actor: "agent", threadId: "thread-a" });
    await listFileChats(host, "notes/a.md", "darwin");
    expect(store.log).not.toContain("ensureGeneralChannel");
    expect(host.provisions).toEqual([]);
  });

  it("is reported exactly once when a later enumeration fails", async () => {
    const { store } = tripStore();
    store.failing.set("listChannelThreads", new Error("The workspace engine stopped."));
    const full = memoryHost(store);
    expect(await listGroupsWithThreads(full)).toEqual({ ok: false, reason: "The workspace engine stopped." });
    expect(full.provisions).toHaveLength(1);
    expect(store.log.indexOf("provisioned")).toBeLessThan(store.log.indexOf("listChannelThreads"));

    const again = tripStore();
    again.store.failing.set("listThreads", new Error("The workspace engine stopped."));
    const show = memoryHost(again.store);
    await expect(showChat(show, { cwd: "/", actor: "human", target: "th_missing", peek: false }))
      .rejects.toThrow("The workspace engine stopped.");
    expect(show.provisions).toHaveLength(1);
  });
});

describe("group lists", () => {
  it("names a group by its wire id, or null when the lookup fails", async () => {
    const { store } = tripStore();
    store.wireIds.set("channel-trip", "wire-trip");
    const host = memoryHost(store, { writable: false });
    expect((await listGroups(host)).groups).toEqual([
      { id: "ch_trip", name: "Trip", slug: "trip", kind: "group", purpose: "Plan the trip", channelWireId: "wire-trip" },
    ]);
    store.failing.set("getChannelWireId", new Error("no mapping"));
    expect((await listGroups(host)).groups[0]?.channelWireId).toBeNull();
    const full = await listGroupsWithThreads(host);
    if (!full.ok) throw new Error(full.reason);
    expect(full.groups[0]).toMatchObject({ id: "channel-trip", channelWireId: null, kind: "group", threadCount: 0 });
  });

  it("names an agent's chat by its slug and gives CLI handles", async () => {
    const store = new MemoryChatStore();
    store.addChannel({ id: "channel-agent-nova", name: "My agent", slug: "nova", kind: "agent", agentId: "nova", type: "chat" });
    store.addChannel({ id: "dm-alex", name: "Alex", slug: "alex", kind: "dm" });
    const host = memoryHost(store, { writable: false });
    expect((await listGroups(host)).groups).toEqual([
      { id: "ch_agent-nova", name: "nova", slug: "nova", kind: "agent", channelWireId: null },
      { id: "dm-alex", name: "Alex", slug: "alex", kind: "dm", channelWireId: null },
    ]);
  });

  it("lists posts before the chat lane", async () => {
    const { store } = tripStore();
    const chat = store.addThread({ id: "thread-chat", channelId: "channel-trip", lane: "chat" });
    const post = store.addThread({ id: "thread-post", channelId: "channel-trip", lane: "posts" });
    chat.updatedAtMs = post.updatedAtMs + 10;
    store.addMessage({ id: "message-1", threadId: post.id });
    const host = memoryHost(store, { writable: false });
    const listed = await listGroupThreads(host, { group: "#trip", reader: null });
    expect(listed.threads.map((thread) => [thread.id, thread.lane])).toEqual([["th_post", "posts"], ["th_chat", "chat"]]);
    const full = await listGroupsWithThreads(host);
    if (!full.ok) throw new Error(full.reason);
    expect(full.groups[0]?.threads.map((thread) => [thread.id, thread.lane, thread.messageCount]))
      .toEqual([["thread-post", "posts", 1], ["thread-chat", "chat", 0]]);
  });

  it("counts unread for a person from the read cursor and for an agent from the engine", async () => {
    const { store } = tripStore();
    const forPerson = store.addThread({ id: "thread-person", channelId: "channel-trip" });
    const forAgent = store.addThread({ id: "thread-agent", channelId: "channel-trip" });
    for (const thread of [forPerson, forAgent]) {
      store.addMessage({ id: `message-${thread.id}-1`, threadId: thread.id });
      store.addMessage({ id: `message-${thread.id}-2`, threadId: thread.id });
    }
    store.addDecision(forPerson.id, { messageId: `message-${forPerson.id}-2`, state: "open" });
    store.readSequence.set(forPerson.id, 1);
    store.readSequence.set(forAgent.id, 2);
    store.agentUnread.add(forAgent.id);
    const host = memoryHost(store, { writable: false });

    const person = await listGroupThreads(host, { group: "trip", reader: null });
    expect(Object.fromEntries(person.threads.map((thread) => [thread.id, thread.unread])))
      .toEqual({ "th_person": true, "th_agent": false });
    expect(person.threads.find((thread) => thread.id === "th_person")).toMatchObject({ commentCount: 1, openDecisionCount: 1 });
    expect(store.agentReaders).toEqual([]);

    const reader = { kind: "run" as const, runId: "run-1" };
    const agent = await listGroupThreads(host, { group: "trip", reader });
    expect(Object.fromEntries(agent.threads.map((thread) => [thread.id, thread.unread])))
      .toEqual({ "th_person": false, "th_agent": true });
    expect(store.agentReaders).toEqual([reader]);
  });

  it("refuses a group name that matches none or several", async () => {
    const { store } = tripStore();
    store.addChannel({ id: "channel-trap", name: "Trap" });
    const host = memoryHost(store, { writable: false });
    await expect(listGroupThreads(host, { group: "ch_tr", reader: null }))
      .rejects.toThrow("dohc: ambiguous group prefix 'ch_tr': ch_trip, ch_trap");
    await expect(listGroupThreads(host, { group: "nowhere", reader: null }))
      .rejects.toThrow("dohc: no such group: nowhere");
  });

  it("uses every thread the store returns, and leaves retries to the store", async () => {
    const { store } = tripStore();
    for (let index = 0; index < 250; index += 1) store.addThread({ id: `thread-${index}`, channelId: "channel-trip" });
    const host = memoryHost(store, { writable: false });
    expect((await listGroupThreads(host, { group: "trip", reader: null })).threads).toHaveLength(250);

    store.log.length = 0;
    store.failing.set("listMessages", new Error("Transport closed."));
    expect(await readChat(host, { cwd: "/", actor: "agent", threadId: "thread-1" }))
      .toEqual({ ok: false, reason: "Transport closed." });
    expect(store.log.filter((method) => method === "listMessages")).toHaveLength(1);
  });
});

describe("fileChats", () => {
  it("lists a tracked file's chats under the file's path", async () => {
    const store = new MemoryChatStore();
    store.addThread({ id: "thread-file", linkedFile: { objectId: "object-a", pathHint: "notes/a.md", linkedAtMs: 1 } });
    const host = memoryHost(store, { files: { "notes/a.md": "object-a" } });
    const listed = await listFileChats(host, "./notes//a.md", "darwin");
    expect(listed).toEqual({
      ok: true,
      path: "notes/a.md",
      fileObjectId: "object-a",
      threads: [expect.objectContaining({ id: "thread-file", linkedPathHint: "notes/a.md" })],
    });
  });

  it("answers an untracked file with no chats, without asking the store", async () => {
    const store = new MemoryChatStore();
    const host = memoryHost(store);
    expect(await listFileChats(host, "notes/new.md", "darwin"))
      .toEqual({ ok: true, path: "notes/new.md", fileObjectId: null, threads: [] });
    expect(store.log).toEqual([]);
  });

  it("refuses a path under the platform's rules and words a failure", async () => {
    const store = new MemoryChatStore();
    const host = memoryHost(store, { files: { "a:b.md": "object-ab" } });
    expect(await listFileChats(host, "../escape.md", "darwin"))
      .toEqual({ ok: false, reason: "path rejected (traversal): ../escape.md" });
    expect(await listFileChats(host, "a:b.md", "win32"))
      .toEqual({ ok: false, reason: "path rejected (unsupported-name): a:b.md" });
    expect((await listFileChats(host, "a:b.md", "darwin")).ok).toBe(true);
    store.failing.set("listThreadsForFile", "not an error");
    expect(await listFileChats(host, "a:b.md", "darwin"))
      .toEqual({ ok: false, reason: "failed to list chats for: a:b.md" });
  });
});

describe("chat", () => {
  it("reads a thread with its decisions, dispatch state and projection under engine ids", async () => {
    const store = new MemoryChatStore();
    const thread = store.addThread({ id: "thread-file", title: "Brief", linkedFile: { objectId: "object-a", linkedAtMs: 1 } });
    store.addMessage({ id: "message-1", threadId: thread.id, body: "Which day?", authorOwnerDisplayName: "Sam Lee" });
    store.addMessage({ id: "message-2", threadId: thread.id, parentMessageId: "message-1", author: { kind: "agent", displayName: "Nova" } });
    store.addDecision(thread.id, { messageId: "message-1", state: "open", options: ["Fri", "Sat"] });
    const dispatch = { paused: "budget" as const, lastRun: null };
    const host = memoryHost(store, { files: { "notes/a.md": "object-a" }, dispatch });
    const read = await readChat(host, { cwd: "/", actor: "agent", threadId: thread.id });
    if (!read.ok || !("thread" in read)) throw new Error("expected a thread");
    expect(read.dispatch).toEqual(dispatch);
    expect(read.projection).toEqual({ path: "notes/a.md", readOnly: true, text: "The text of thread-file" });
    expect(store.projections.at(-1)?.linkedFileAccess).toEqual({ kind: "allowed", path: "notes/a.md" });
    expect(read.messages).toEqual([
      expect.objectContaining({ id: "message-1", authorKind: "human", authorOwnerDisplayName: "Sam Lee", needsDecision: true, decisionState: "open", options: ["Fri", "Sat"] }),
      expect.objectContaining({ id: "message-2", parentMessageId: "message-1", authorKind: "agent", needsDecision: false }),
    ]);
  });

  it("reads a file's thread without a known path, and refuses an unknown thread", async () => {
    const store = new MemoryChatStore();
    store.addThread({ id: "thread-file", linkedFile: { objectId: "object-gone", linkedAtMs: 1 } });
    const host = memoryHost(store);
    expect((await readChat(host, { cwd: "/", actor: "agent", threadId: "thread-file" })).ok).toBe(true);
    expect(store.projections.at(-1)?.linkedFileAccess).toEqual({ kind: "unknown" });
    store.messages.set("thread-orphan", []);
    expect(await readChat(host, { cwd: "/", actor: "agent", threadId: "thread-orphan" }))
      .toEqual({ ok: false, reason: "chat thread not found: thread-orphan" });
  });

  it("words a failed group read with the group it named", async () => {
    const { store } = tripStore();
    const host = memoryHost(store);
    expect(await readChat(host, { cwd: "/", actor: "agent", group: "nowhere" }))
      .toEqual({ ok: false, reason: "dohc: no such group: nowhere" });
    store.failing.set("listGroupStream", 7);
    expect(await readChat(host, { cwd: "/", actor: "agent", group: "trip" }))
      .toEqual({ ok: false, reason: "failed to read group: trip" });
  });
});

function streamStore() {
  const { store } = tripStore();
  const post = store.addThread({ id: "thread-post", channelId: "channel-trip", lane: "posts" });
  const chat = store.addThread({ id: "thread-chat", channelId: "channel-trip", lane: "chat" });
  store.addMessage({ id: "message-a", threadId: chat.id, createdAtMs: 10 });
  store.addMessage({ id: "message-p", threadId: post.id, createdAtMs: 20 });
  store.addMessage({ id: "message-b", threadId: chat.id, createdAtMs: 20 });
  store.addMessage({ id: "message-reply", threadId: post.id, createdAtMs: 25, author: { kind: "agent", displayName: "Nova" } });
  store.addMessage({ id: "message-c", threadId: chat.id, createdAtMs: 30 });
  return store;
}

describe("group streams", () => {
  it("pages show's stream in order under CLI handles, marking nothing read", async () => {
    const store = streamStore();
    const host = memoryHost(store, { writable: false });
    const first = await showChat(host, { cwd: "/", actor: "human", target: "#trip", peek: false, limit: 2 });
    if (!("stream" in first)) throw new Error("expected a stream");
    expect(first).not.toHaveProperty("read");
    expect(first.stream.group).toEqual({ id: "ch_trip", name: "Trip", slug: "trip", kind: "group", purpose: "Plan the trip" });
    expect(first.stream.items.map((item) => item.position)).toEqual([
      { createdAtMs: 20, lane: "chat", id: "msg_b" },
      { createdAtMs: 30, lane: "chat", id: "msg_c" },
    ]);
    expect(first.stream.nextBefore).toEqual({ createdAtMs: 20, lane: "chat", id: "msg_b" });
    const second = await showChat(host, { cwd: "/", actor: "human", target: "trip", peek: false, limit: 2, before: first.stream.nextBefore! });
    if (!("stream" in second)) throw new Error("expected a stream");
    expect(second.stream.items.map((item) => [item.position.lane, item.position.id, item.threadId])).toEqual([
      ["chat", "msg_a", "th_chat"],
      ["posts", "th_post", "th_post"],
    ]);
    expect(second.stream.items[1]?.post).toMatchObject({ replyCount: 1, lastReplyAtMs: 25 });
    expect(second.stream.items[1]?.message).toMatchObject({ id: "msg_p", author: { kind: "human", displayName: "Sam" } });
    expect(second.stream.nextBefore).toBeNull();
  });

  it("pages chat's stream in the same order under engine ids", async () => {
    const store = streamStore();
    const host = memoryHost(store);
    const page = await readChat(host, { cwd: "/", actor: "agent", group: "Trip", limit: 3 });
    if (!page.ok || !("stream" in page)) throw new Error("expected a stream");
    expect(page.stream.group).toEqual({ id: "channel-trip", name: "Trip", kind: "group" });
    expect(page.stream.items.map((item) => item.position.id)).toEqual(["thread-post", "message-b", "message-c"]);
    expect(page.stream.items[0]?.message).toMatchObject({ id: "message-p", threadId: "thread-post", authorKind: "human" });
    const rest = await readChat(host, { cwd: "/", actor: "agent", group: "trip", before: page.stream.nextBefore! });
    if (!rest.ok || !("stream" in rest)) throw new Error("expected a stream");
    expect(rest.stream.items.map((item) => item.position.id)).toEqual(["message-a"]);
  });

  it("refuses a page of a thread", async () => {
    const store = streamStore();
    const host = memoryHost(store, { writable: false });
    await expect(showChat(host, { cwd: "/", actor: "human", target: "th_post", peek: true, limit: 5 }))
      .rejects.toThrow("dohc: --before and --limit page a group's stream; name a group");
  });
});

describe("show", () => {
  // m1 opens the post; m2 and m3 are a branch under it; m4 is a newer sibling.
  function branchStore() {
    const { store } = tripStore();
    const thread = store.addThread({ id: "thread-plan", title: "Plan", channelId: "channel-trip" });
    store.addMessage({ id: "message-1", threadId: thread.id, createdAtMs: 100 });
    store.addMessage({ id: "message-2", threadId: thread.id, createdAtMs: 110, parentMessageId: "message-1" });
    store.addMessage({ id: "message-3", threadId: thread.id, createdAtMs: 120, parentMessageId: "message-2", author: { kind: "agent", displayName: "Nova" } });
    store.addMessage({ id: "message-4", threadId: thread.id, createdAtMs: 130, parentMessageId: "message-1" });
    store.addDecision(thread.id, { messageId: "message-4", state: "open" });
    return store;
  }

  it("counts the whole thread, shows the branch, and gives read places from the whole thread", async () => {
    const store = branchStore();
    const host = memoryHost(store, { writable: false });
    const shown = shownThread(await showChat(host, { cwd: "/", actor: "agent", target: "msg_2", peek: false }));
    expect(shown.thread.thread).toEqual({
      id: "th_plan",
      title: "Plan",
      group: { id: "ch_trip", name: "Trip", slug: "trip", kind: "group", purpose: "Plan the trip" },
      commentCount: 3,
      openDecisionCount: 1,
    });
    expect(shown.thread.messages.map((message) => [message.id, message.parentMessageId])).toEqual([
      ["msg_2", "msg_1"],
      ["msg_3", "msg_2"],
    ]);
    // A person's place moves by all four messages, an agent's to message-4,
    // though neither is in the branch shown.
    expect(shown.read).toEqual({
      threadId: "thread-plan",
      messageCount: 4,
      latest: { createdAtMs: 130, messageId: "message-4" },
    });
  });

  it("takes the greater message id as latest within one millisecond", async () => {
    const store = branchStore();
    store.addMessage({ id: "message-5", threadId: "thread-plan", createdAtMs: 130 });
    store.addMessage({ id: "message-0", threadId: "thread-plan", createdAtMs: 130 });
    const host = memoryHost(store, { writable: false });
    const shown = shownThread(await showChat(host, { cwd: "/", actor: "human", target: "thread-plan", peek: false }));
    expect(shown.thread.messages).toHaveLength(6);
    expect(shown.read).toEqual({ threadId: "thread-plan", messageCount: 6, latest: { createdAtMs: 130, messageId: "message-5" } });
  });

  it("gives an empty thread nothing to mark", async () => {
    const { store } = tripStore();
    store.addThread({ id: "thread-empty", channelId: "channel-trip" });
    const host = memoryHost(store, { writable: false });
    const shown = shownThread(await showChat(host, { cwd: "/", actor: "human", target: "th_empty", peek: false }));
    expect(shown.read).toEqual({ threadId: "thread-empty", messageCount: 0, latest: null });
    expect(shown.thread.thread.commentCount).toBe(0);
  });

  it("puts a thread no group lists in the files group, counting its own messages and decisions", async () => {
    const store = new MemoryChatStore();
    const thread = store.addThread({ id: "thread-file", title: "Brief", linkedFile: { objectId: "object-a", linkedAtMs: 1 } });
    store.addMessage({ id: "message-1", threadId: thread.id, attachments: [{ attachmentId: "x", threadId: thread.id, messageId: "message-1", targetKind: "file", objectId: "object-a", pathHint: "notes/a.md", createdAtMs: 1 }] });
    store.addMessage({ id: "message-2", threadId: thread.id });
    store.addDecision(thread.id, { messageId: "message-1", state: "open", options: ["Yes"] });
    store.addDecision(thread.id, { messageId: "message-2", state: "resolved", resolvedByMessageId: "message-2" });
    const dispatch = { paused: null, lastRun: { state: "failed" as const, failureReason: "no-reply", exitCode: 0 } };
    const host = memoryHost(store, { writable: false, dispatch });
    const shown = shownThread(await showChat(host, { cwd: "/", actor: "human", target: "th_file", peek: true }));
    expect(shown.thread.thread).toMatchObject({ group: FILES_GROUP, commentCount: 1, openDecisionCount: 1 });
    expect(shown.thread.dispatch).toEqual(dispatch);
    expect(shown.thread.messages[0]).toMatchObject({
      id: "msg_1",
      decisionState: "open",
      decisionOptions: ["Yes"],
      attachments: [{ objectId: "object-a", pathHint: "notes/a.md" }],
    });
  });

  it("refuses a target that names no thread or message, or several", async () => {
    const store = branchStore();
    const host = memoryHost(store, { writable: false });
    await expect(showChat(host, { cwd: "/", actor: "human", target: "th_nothing", peek: true }))
      .rejects.toThrow("dohc: no such thread or message: th_nothing");
    await expect(showChat(host, { cwd: "/", actor: "human", target: "msg_", peek: true }))
      .rejects.toThrow("dohc: ambiguous thread or message prefix 'msg_'");
  });
});
