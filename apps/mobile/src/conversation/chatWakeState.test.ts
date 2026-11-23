import type { PhoneChatWake } from "@dohc/workspace-contracts/chat-wakes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerClient } from "../server/client";
import { deferred, testServer, type Answer } from "../server/testServer";
import { answerReply } from "../notices/noticeAnswers";
import type { ShownQuestion } from "../notices/noticeWrites";
import type { ChatMessage } from "../server/workspaceReads";
import { createChatWakes, wakeLine, wakeLines, wakeWords, type ChatWakes } from "./chatWakeState";

// The wakes of the conversations on screen: each wanted conversation reads its context, then one wait per workspace
// follows the account's wake changes from the earliest cursor read. Background, release, a sign-in change and stop
// abort what they started, and a late answer never lands.

const wake = (sequence: number, fields: Partial<PhoneChatWake> = {}): PhoneChatWake => ({
  wakeId: `wake-${String(sequence).padStart(32, "0")}`,
  messageId: "m-1",
  threadId: "thread-1",
  generation: 1,
  state: "waiting",
  winnerLabel: null,
  agentName: "Nova",
  canRetry: false,
  ...fields,
});

const stream = { kind: "stream", groupId: "g-1", groupKind: "group", canPost: true, canSend: true };
const thread = (threadId: string) => ({
  kind: "thread",
  threadId,
  groupKind: "group",
  nextBefore: null,
});
const context = (conversation: unknown, wakes: PhoneChatWake[], wakeCursor: string): Answer => ({
  status: 200,
  body: {
    ok: true,
    cursor: "0.1.1",
    result: { ok: true, conversation, mentions: [], wakes, wakeCursor },
  },
});
const MAYA = { kind: "person", handle: "maya", label: "Maya" } as const;
const NOVA = { kind: "agent", handle: "nova", label: "Nova", computers: ["Ice's Mac"] } as const;
const mentioning = (conversation: unknown, mentions: unknown[], wakeCursor: string): Answer => ({
  status: 200,
  body: {
    ok: true,
    cursor: "0.1.1",
    result: { ok: true, conversation, mentions, wakes: [], wakeCursor },
  },
});
const changes = (body: Record<string, unknown>): Answer => ({
  status: 200,
  body: { ok: true, ...body },
});

const CONTEXT = "/sync/w1/ops/chatContext";
const waitPath = (since: string) => `/sync/w1/ops/wakeChanges?since=${since}&hold=1000`;
const STREAM = { kind: "stream", groupId: "g-1" } as const;
const THREAD = { kind: "thread", threadId: "thread-1" } as const;
const SHOWN = new Set(["thread-1"]);

/** A route that never answers until its request aborts. */
const never = () => new Promise<Answer>(() => undefined);

let stopping: ChatWakes | null = null;
afterEach(() => stopping?.stop());

function setup() {
  const server = testServer();
  const ending = new AbortController();
  let current = true;
  const client = createServerClient({
    origin: server.origin,
    token: "tok",
    fetch: server.fetch,
    signal: ending.signal,
  });
  const wakes = createChatWakes({ signIn: { client, isCurrent: () => current }, holdMs: 1000 });
  stopping = wakes;
  return {
    server,
    wakes,
    endSignIn() {
      current = false;
      ending.abort();
    },
    callsTo: (path: string) => server.calls.filter((call) => call.path === path),
  };
}

describe("createChatWakes", () => {
  it("reads a wanted stream's wakes, waits from its cursor, and reads it again when a shown thread changes", async () => {
    const { server, wakes, callsTo } = setup();
    const change = deferred<Answer>();
    server.on(
      "POST",
      CONTEXT,
      context(stream, [wake(1), wake(2, { agentName: "Nova" })], "7"),
      context(stream, [wake(1, { state: "claimed", winnerLabel: "Ice's Mac" })], "8"),
    );
    server.on("GET", waitPath("7"), () => change.promise);
    server.on("GET", waitPath("8"), never);
    wakes.want("w1", STREAM, SHOWN);
    await vi.waitFor(() => expect(callsTo(waitPath("7"))).toHaveLength(1));
    // Two wakes of one message with one name stay two.
    expect(wakes.view("w1", STREAM)?.byMessage.get("m-1")).toEqual([wake(1), wake(2)]);
    change.resolve(changes({ cursor: "8", threads: ["thread-1"] }));
    await vi.waitFor(() =>
      expect(wakes.view("w1", STREAM)?.byMessage.get("m-1")?.[0]?.state).toBe("claimed"),
    );
    await vi.waitFor(() => expect(callsTo(waitPath("8"))).toHaveLength(1));
    expect(callsTo(CONTEXT)).toHaveLength(2);
  });

  it("takes the name only from the latest read", async () => {
    const { server, wakes } = setup();
    server.on(
      "POST",
      CONTEXT,
      context(thread("thread-1"), [wake(1, { agentName: "Nova" })], "7"),
      context(thread("thread-1"), [wake(1, { agentName: null })], "7"),
    );
    server.on("GET", waitPath("7"), never);
    const release = wakes.want("w1", THREAD, SHOWN);
    await vi.waitFor(() => expect(wakes.view("w1", THREAD)).not.toBeNull());
    expect(wakeLines(wakes.view("w1", THREAD)?.byMessage.get("m-1") ?? [])[0]?.text).toBe(
      "Nova is waiting for a computer",
    );
    // Wanted again, as when the thread's read changes: the new read has no name, and none is kept from before.
    wakes.want("w1", THREAD, SHOWN);
    release();
    await vi.waitFor(() =>
      expect(wakeLines(wakes.view("w1", THREAD)?.byMessage.get("m-1") ?? [])[0]?.text).toBe(
        "An agent is waiting for a computer",
      ),
    );
  });

  it("moves the cursor on an answer that names no thread it shows, without reading again", async () => {
    const { server, wakes, callsTo } = setup();
    server.on("POST", CONTEXT, context(thread("thread-1"), [wake(1)], "7"));
    server.on("GET", waitPath("7"), changes({ cursor: "9", threads: ["thread-2"] }));
    server.on("GET", waitPath("9"), changes({ cursor: "10", threads: [] }));
    server.on("GET", waitPath("10"), never);
    wakes.want("w1", THREAD, SHOWN);
    await vi.waitFor(() => expect(callsTo(waitPath("10"))).toHaveLength(1));
    expect(callsTo(CONTEXT)).toHaveLength(1);
  });

  it("reads every wanted context again on replace, and waits from its new cursor", async () => {
    const { server, wakes, callsTo } = setup();
    server.on(
      "POST",
      CONTEXT,
      context(thread("thread-1"), [wake(1)], "7"),
      context(thread("thread-1"), [], "3"),
    );
    server.on("GET", waitPath("7"), changes({ cursor: "3", replace: true }));
    server.on("GET", waitPath("3"), never);
    wakes.want("w1", THREAD, SHOWN);
    // The wake the server no longer has is gone.
    await vi.waitFor(() => expect(wakes.view("w1", THREAD)?.byMessage.size).toBe(0));
    expect(callsTo(waitPath("3"))).toHaveLength(1);
    expect(callsTo(CONTEXT)).toHaveLength(2);
  });

  it("starts the wait again from a context read older than it", async () => {
    const { server, wakes, callsTo } = setup();
    server.on("POST", CONTEXT, (call) =>
      (call.body as { group?: string }).group === "g-1"
        ? context(stream, [], "9")
        : context(thread("thread-1"), [], "5"),
    );
    server.on("GET", waitPath("9"), never);
    server.on("GET", waitPath("5"), never);
    wakes.want("w1", STREAM, SHOWN);
    await vi.waitFor(() => expect(callsTo(waitPath("9"))).toHaveLength(1));
    wakes.want("w1", THREAD, SHOWN);
    await vi.waitFor(() => expect(callsTo(waitPath("5"))).toHaveLength(1));
    expect(callsTo(waitPath("9"))[0]?.signal.aborted).toBe(true);
  });

  it("keeps the last wakes through a failed read, marked failed, until Try again reads them", async () => {
    const { server, wakes, callsTo } = setup();
    server.on(
      "POST",
      CONTEXT,
      context(thread("thread-1"), [wake(1)], "7"),
      { status: 503 },
      context(thread("thread-1"), [wake(1, { state: "unclaimed", canRetry: true })], "8"),
    );
    server.on("GET", waitPath("7"), changes({ cursor: "8", threads: ["thread-1"] }));
    server.on("GET", waitPath("8"), never);
    wakes.want("w1", THREAD, SHOWN);
    await vi.waitFor(() => expect(wakes.view("w1", THREAD)?.failed).toBe(true));
    expect(wakes.view("w1", THREAD)?.byMessage.get("m-1")).toEqual([wake(1)]);
    wakes.refresh("w1");
    await vi.waitFor(() => expect(wakes.view("w1", THREAD)?.failed).toBe(false));
    expect(wakes.view("w1", THREAD)?.byMessage.get("m-1")?.[0]?.state).toBe("unclaimed");
    expect(callsTo(CONTEXT)).toHaveLength(3);
  });

  it("marks what's shown failed when the wait fails", async () => {
    const { server, wakes } = setup();
    server.on("POST", CONTEXT, context(thread("thread-1"), [wake(1)], "7"));
    server.on("GET", waitPath("7"), "offline");
    wakes.want("w1", THREAD, SHOWN);
    await vi.waitFor(() => expect(wakes.view("w1", THREAD)?.failed).toBe(true));
    expect(wakes.view("w1", THREAD)?.byMessage.get("m-1")).toEqual([wake(1)]);
  });

  it("marks a first read that failed, and a failed wait after only a queued wake, with nothing to keep", async () => {
    const first = setup();
    first.server.on("POST", CONTEXT, "offline");
    first.wakes.want("w1", THREAD, SHOWN);
    await vi.waitFor(() => expect(first.wakes.view("w1", THREAD)?.failed).toBe(true));
    expect(first.wakes.view("w1", THREAD)?.byMessage.size).toBe(0);
    first.wakes.stop();

    const queued = setup();
    queued.server.on(
      "POST",
      CONTEXT,
      context(thread("thread-1"), [wake(1, { state: "queued" })], "7"),
    );
    queued.server.on("GET", waitPath("7"), "offline");
    queued.wakes.want("w1", THREAD, SHOWN);
    await vi.waitFor(() => expect(queued.wakes.view("w1", THREAD)?.failed).toBe(true));
    expect(wakeWords(queued.wakes.view("w1", THREAD)?.byMessage.get("m-1") ?? [], true)).toEqual([
      "dohc could not read this agent's state.",
    ]);
  });

  it("aborts in the background, drops the late answer, and reads again on return", async () => {
    const { server, wakes, callsTo } = setup();
    const first = deferred<Answer>();
    server.on("POST", CONTEXT, () => first.promise, context(thread("thread-1"), [wake(2)], "8"));
    server.on("GET", waitPath("8"), never);
    wakes.want("w1", THREAD, SHOWN);
    await vi.waitFor(() => expect(callsTo(CONTEXT)).toHaveLength(1));
    wakes.pause();
    expect(callsTo(CONTEXT)[0]?.signal.aborted).toBe(true);
    first.resolve(context(thread("thread-1"), [wake(1)], "7"));
    wakes.resume();
    await vi.waitFor(() =>
      expect(wakes.view("w1", THREAD)?.byMessage.get("m-1")).toEqual([wake(2)]),
    );
    expect(callsTo(waitPath("7"))).toHaveLength(0);
  });

  it("aborts the wait in the background", async () => {
    const { server, wakes, callsTo } = setup();
    server.on("POST", CONTEXT, context(thread("thread-1"), [], "7"));
    server.on("GET", waitPath("7"), never);
    wakes.want("w1", THREAD, SHOWN);
    await vi.waitFor(() => expect(callsTo(waitPath("7"))).toHaveLength(1));
    wakes.pause();
    expect(callsTo(waitPath("7"))[0]?.signal.aborted).toBe(true);
  });

  it("aborts the read and the wait once nobody wants the conversation", async () => {
    const { server, wakes, callsTo } = setup();
    const late = deferred<Answer>();
    server.on("POST", CONTEXT, context(thread("thread-1"), [], "7"), () => late.promise);
    server.on("GET", waitPath("7"), never);
    const release = wakes.want("w1", THREAD, SHOWN);
    await vi.waitFor(() => expect(callsTo(waitPath("7"))).toHaveLength(1));
    // A second read starts, then the screen leaves before it answers.
    const again = wakes.want("w1", THREAD, SHOWN);
    release();
    again();
    expect(callsTo(CONTEXT)[1]?.signal.aborted).toBe(true);
    expect(callsTo(waitPath("7"))[0]?.signal.aborted).toBe(true);
    late.resolve(context(thread("thread-1"), [wake(9)], "8"));
    await late.promise;
    expect(wakes.view("w1", THREAD)?.byMessage.size).toBe(0);
  });

  it("drops a late answer once the sign-in ends", async () => {
    const { server, wakes, endSignIn, callsTo } = setup();
    const late = deferred<Answer>();
    server.on("POST", CONTEXT, () => late.promise);
    wakes.want("w1", THREAD, SHOWN);
    await vi.waitFor(() => expect(callsTo(CONTEXT)).toHaveLength(1));
    endSignIn();
    expect(callsTo(CONTEXT)[0]?.signal.aborted).toBe(true);
    late.resolve(context(thread("thread-1"), [wake(1)], "7"));
    await late.promise;
    expect(wakes.view("w1", THREAD)).toBeNull();
  });

  it("stops everything for good, as a workspace switch does", async () => {
    const { server, wakes, callsTo } = setup();
    server.on("POST", CONTEXT, context(thread("thread-1"), [], "7"));
    server.on("GET", waitPath("7"), never);
    wakes.want("w1", THREAD, SHOWN);
    await vi.waitFor(() => expect(callsTo(waitPath("7"))).toHaveLength(1));
    wakes.stop();
    expect(callsTo(waitPath("7"))[0]?.signal.aborted).toBe(true);
    wakes.want("w1", STREAM, SHOWN);
    wakes.resume();
    expect(callsTo(CONTEXT)).toHaveLength(1);
  });

  it("keeps the read's mention candidates with its wakes, through a failed read", async () => {
    const { server, wakes } = setup();
    server.on("POST", CONTEXT, mentioning(thread("thread-1"), [MAYA, NOVA], "7"));
    server.on("GET", waitPath("7"), "offline");
    wakes.want("w1", THREAD, SHOWN);
    await vi.waitFor(() => expect(wakes.view("w1", THREAD)?.failed).toBe(true));
    expect(wakes.view("w1", THREAD)?.mentions).toEqual([MAYA, NOVA]);
  });

  it("drops a late answer's candidates after the screen moves to another conversation", async () => {
    const { server, wakes, callsTo } = setup();
    const late = deferred<Answer>();
    server.on("POST", CONTEXT, (call) =>
      (call.body as { threadId?: string }).threadId === "thread-1"
        ? late.promise
        : mentioning(stream, [NOVA], "7"),
    );
    server.on("GET", waitPath("7"), never);
    const release = wakes.want("w1", THREAD, SHOWN);
    await vi.waitFor(() => expect(callsTo(CONTEXT)).toHaveLength(1));
    wakes.want("w1", STREAM, SHOWN);
    release();
    await vi.waitFor(() => expect(wakes.view("w1", STREAM)?.mentions).toEqual([NOVA]));
    late.resolve(mentioning(thread("thread-1"), [MAYA], "6"));
    await late.promise;
    expect(wakes.view("w1", THREAD)).toBeNull();
    expect(wakes.view("w1", STREAM)?.mentions).toEqual([NOVA]);
  });

  it("drops a late answer's candidates once the workspace's wakes stop", async () => {
    const { server, wakes, callsTo } = setup();
    const late = deferred<Answer>();
    server.on("POST", CONTEXT, () => late.promise);
    wakes.want("w1", THREAD, SHOWN);
    await vi.waitFor(() => expect(callsTo(CONTEXT)).toHaveLength(1));
    wakes.stop();
    late.resolve(mentioning(thread("thread-1"), [MAYA], "7"));
    await late.promise;
    expect(wakes.view("w1", THREAD)).toBeNull();
  });

  it("keeps each workspace's wait apart", async () => {
    const { server, wakes, callsTo } = setup();
    server.on("POST", CONTEXT, context(thread("thread-1"), [], "7"));
    server.on("POST", "/sync/w2/ops/chatContext", context(thread("thread-1"), [wake(1)], "4"));
    server.on("GET", waitPath("7"), never);
    server.on("GET", "/sync/w2/ops/wakeChanges?since=4&hold=1000", never);
    wakes.want("w1", THREAD, SHOWN);
    wakes.want("w2", THREAD, SHOWN);
    await vi.waitFor(() =>
      expect(callsTo("/sync/w2/ops/wakeChanges?since=4&hold=1000")).toHaveLength(1),
    );
    await vi.waitFor(() => expect(callsTo(waitPath("7"))).toHaveLength(1));
    expect(wakes.view("w1", THREAD)?.byMessage.size).toBe(0);
    expect(wakes.view("w2", THREAD)?.byMessage.get("m-1")).toEqual([wake(1)]);
  });
});

describe("wakeLine", () => {
  it.each<[string, Partial<PhoneChatWake>, string, string | null]>([
    ["waiting", { state: "waiting" }, "Nova is waiting for a computer", null],
    [
      "claimed",
      { state: "claimed", winnerLabel: "Ice's Mac" },
      "Nova is starting on Ice's Mac",
      null,
    ],
    ["claimed with no computer", { state: "claimed" }, "Nova is starting on a computer", null],
    ["unclaimed", { state: "unclaimed", canRetry: true }, "Nova didn't start", null],
    [
      "unclaimed with no other computer",
      { state: "unclaimed" },
      "Nova didn't start",
      "No other computer can run this agent.",
    ],
    [
      "unconfirmed",
      { state: "unconfirmed", winnerLabel: "Studio Mac", canRetry: true },
      "Nova isn't confirmed on Studio Mac. It may have started.",
      null,
    ],
    [
      "unconfirmed with no computer or name",
      { state: "unconfirmed", agentName: null },
      "An agent isn't confirmed on a computer. It may have started.",
      "No other computer can run this agent.",
    ],
    ["an agent with no name", { agentName: null }, "An agent is waiting for a computer", null],
  ])("says %s", (_case, fields, text, note) => {
    expect(wakeLine(wake(1, fields))).toMatchObject({ text, note });
  });

  it("shows nothing for held, which the outbox already shows, or queued", () => {
    expect(wakeLine(wake(1, { state: "held" }))).toBeNull();
    expect(wakeLine(wake(1, { state: "queued" }))).toBeNull();
  });

  it("keeps one line per wake, even with the same name, and never asks for a mention", () => {
    const lines = wakeLines([wake(1, { state: "unclaimed" }), wake(2, { state: "unclaimed" })]);
    expect(lines.map((line) => line.wakeId)).toEqual([wake(1).wakeId, wake(2).wakeId]);
    expect(lines.map((line) => line.text)).toEqual(["Nova didn't start", "Nova didn't start"]);
    expect(JSON.stringify(lines)).not.toContain("Mention");
  });

  it("says a read failed, beside the lines it shows or alone when it has none", () => {
    expect(wakeWords([wake(1)], true)).toEqual([
      "Nova is waiting for a computer",
      "dohc could not read this agent's state.",
    ]);
    // A first read that failed, or a wait that failed after only a queued wake: nothing to keep, the failure still says so.
    expect(wakeWords([], true)).toEqual(["dohc could not read this agent's state."]);
    expect(wakeWords([wake(1, { state: "queued" })], true)).toEqual([
      "dohc could not read this agent's state.",
    ]);
    expect(wakeWords([wake(1, { state: "queued" })], false)).toEqual([]);
  });
});

describe("answerReply", () => {
  const message = (fields: Partial<ChatMessage>): ChatMessage => ({
    id: "q-1",
    threadId: "thread-1",
    authorKind: "agent",
    authorName: "Nova",
    body: "Which train?",
    createdAtMs: 1,
    parentMessageId: null,
    attachments: [],
    needsDecision: true,
    decisionState: "open",
    options: [],
    chosenOption: null,
    resolvedByMessageId: null,
    reactions: [],
    ...fields,
  });
  const shown = (question: ChatMessage, others: ChatMessage[]): ShownQuestion => ({
    target: { workspaceId: "w1", threadId: "thread-1", messageId: question.id, answer: true },
    question,
    byId: new Map([question, ...others].map((each) => [each.id, each])),
  });
  const reply = message({
    id: "r-1",
    authorKind: "human",
    needsDecision: false,
    decisionState: null,
  });

  it("is the chosen answer a read shows", () => {
    const question = message({ decisionState: "resolved", resolvedByMessageId: "r-1" });
    expect(answerReply(shown(question, [reply]))).toBe("r-1");
  });

  it("is nothing while the question is open, or when the read doesn't show the chosen answer", () => {
    expect(answerReply(shown(message({}), [reply]))).toBeNull();
    const question = message({ decisionState: "resolved", resolvedByMessageId: "r-2" });
    expect(answerReply(shown(question, [reply]))).toBeNull();
    expect(answerReply(null)).toBeNull();
  });
});
