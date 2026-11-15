import type { PhoneChatWake } from "@dohc/workspace-contracts/chat-wakes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerClient } from "../server/client";
import type { OutboxState } from "../server/outbox";
import { deferred, testServer, type Answer } from "../server/testServer";
import {
  createChatWakes,
  screenWant,
  wakeLine,
  type ChatWakes,
  type RetryGate,
} from "./chatWakeState";
import { blockedBy } from "./conversationWrites";

// Try again on a wake line: one request per press, its operation ID minted once and sent again only for the same wake
// generation, checked against the latest read and the screen's gate before every step and when it answers, and
// forgotten on background, leaving, a sign-in change and stop. The answer shows nothing of its own: the conversation's
// context is read again, and Try again waits for that read.

const wake = (sequence: number, fields: Partial<PhoneChatWake> = {}): PhoneChatWake => ({
  wakeId: `wake-${String(sequence).padStart(32, "0")}`,
  messageId: "m-1",
  threadId: "thread-1",
  generation: 1,
  state: "unclaimed",
  winnerLabel: null,
  agentName: "Nova",
  canRetry: true,
  ...fields,
});

const SOURCE = wake(1);
const UNCONFIRMED = wake(3, { state: "unconfirmed", winnerLabel: "Ice's Mac" });
/** The next generation as the reread shows it. */
const NEXT = wake(2, { generation: 2, state: "waiting", canRetry: false });

const context = (wakes: PhoneChatWake[], wakeCursor = "7"): Answer => ({
  status: 200,
  body: {
    ok: true,
    cursor: "0.1.1",
    result: {
      ok: true,
      conversation: { kind: "thread", threadId: "thread-1", groupKind: "group", nextBefore: null },
      mentions: [],
      wakes,
      wakeCursor,
    },
  },
});
/** The route's generation: its computer's label is one the reread never shows. */
const retried = (fields: Record<string, unknown> = {}): Answer => ({
  status: 200,
  body: {
    ok: true,
    cursor: "0.1.1",
    result: {
      ok: true,
      wake: {
        wakeId: NEXT.wakeId,
        workspaceId: "w1",
        messageId: "m-1",
        threadId: "thread-1",
        generation: 2,
        state: "claimed",
        prerequisiteMessageId: null,
        winnerLabel: "Reply Mac",
        ...fields,
      },
    },
  },
});
const refused: Answer = {
  status: 200,
  body: {
    ok: true,
    cursor: "0.1.1",
    result: { ok: false, refusal: "refused", reason: "Couldn't send" },
  },
};
const missing: Answer = {
  status: 200,
  body: { ok: true, cursor: "0.1.1", result: { ok: false, refusal: "missing", reason: "gone" } },
};

const CONTEXT = "/sync/w1/ops/chatContext";
const RETRY = "/sync/w1/ops/retryWake";
const THREAD = { kind: "thread", threadId: "thread-1" } as const;
const SHOWN = new Set(["thread-1"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const READY: OutboxState = {
  status: "ready",
  records: [],
  aside: [],
  unreadable: [],
  deletion: "none",
  unconfirmed: [],
};

const never = () => new Promise<Answer>(() => undefined);
const gate = (fields: Partial<RetryGate> = {}): RetryGate => ({
  allowed: () => true,
  confirm: async () => true,
  ...fields,
});

let stopping: ChatWakes | null = null;
afterEach(() => stopping?.stop());

function setup(...answers: (Answer | (() => Promise<Answer>))[]) {
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
  server.on("POST", CONTEXT, ...answers);
  for (const cursor of ["7", "8"])
    server.on("GET", `/sync/w1/ops/wakeChanges?since=${cursor}&hold=1000`, never);
  const callsTo = (path: string) => server.calls.filter((call) => call.path === path);
  const view = () => wakes.view("w1", THREAD);
  return {
    server,
    wakes,
    callsTo,
    endSignIn() {
      current = false;
      ending.abort();
    },
    /** Wants the thread, and waits for its first read. */
    async open() {
      const release = wakes.want("w1", THREAD, SHOWN);
      await vi.waitFor(() => expect(view()).not.toBeNull());
      return release;
    },
    /** Wants the thread as a screen does, and waits for its first read. */
    async show() {
      const held = screenWant();
      held.want(wakes, "w1", THREAD, SHOWN);
      await vi.waitFor(() => expect(view()).not.toBeNull());
      return held;
    },
    /** Waits for a read after this call to land, by the view it replaces. */
    async nextRead(start: () => void) {
      const before = view();
      start();
      await vi.waitFor(() => expect(view()).not.toBe(before));
    },
    lines: () => view()?.byMessage.get("m-1"),
    phase: (wakeId = SOURCE.wakeId) => wakes.retries("w1", THREAD).get(wakeId)?.phase,
  };
}

describe("Try again on a wake", () => {
  it("sends the operation ID and wake only, shows nothing of the answer, and reads the context again", async () => {
    const reread = deferred<Answer>();
    const { server, wakes, callsTo, open, lines, phase } = setup(
      context([SOURCE]),
      () => reread.promise,
    );
    server.on("POST", RETRY, retried());
    await open();
    const done = wakes.retry("w1", THREAD, SOURCE, gate());
    expect(phase()).toBe("sending");
    await done;
    expect(callsTo(CONTEXT)).toHaveLength(2);
    expect(callsTo(RETRY)[0]?.body).toEqual({
      operationId: expect.stringMatching(UUID),
      wakeId: SOURCE.wakeId,
    });
    // Until the read lands, the line stays as read, busy.
    expect(lines()).toEqual([SOURCE]);
    expect(phase()).toBe("sending");
    reread.resolve(context([NEXT], "8"));
    await vi.waitFor(() => expect(lines()).toEqual([NEXT]));
    expect(wakes.retries("w1", THREAD).size).toBe(0);
    expect(JSON.stringify(lines())).not.toContain("Reply Mac");
    // Nothing went to the outbox, or anywhere else.
    expect(new Set(server.paths().map((path) => path.split("?")[0]))).toEqual(
      new Set(["POST /sync/w1/ops/chatContext", "GET /sync/w1/ops/wakeChanges", `POST ${RETRY}`]),
    );
  });

  it("sends one request for a double tap, and the same ID and wake after a lost answer", async () => {
    const { server, wakes, callsTo, open, phase } = setup(context([SOURCE]));
    server.on("POST", RETRY, "offline", retried());
    await open();
    const done = wakes.retry("w1", THREAD, SOURCE, gate());
    await wakes.retry("w1", THREAD, SOURCE, gate());
    await done;
    expect(callsTo(RETRY)).toHaveLength(1);
    await vi.waitFor(() => expect(phase()).toBe("failed"));
    await wakes.retry("w1", THREAD, SOURCE, gate());
    expect(callsTo(RETRY)).toHaveLength(2);
    expect(callsTo(RETRY)[1]?.body).toEqual(callsTo(RETRY)[0]?.body);
  });

  it("asks before trying another computer, and Cancel sends nothing", async () => {
    const { server, wakes, callsTo, open, phase } = setup(context([UNCONFIRMED]));
    server.on("POST", RETRY, retried());
    await open();
    const confirm = vi.fn(async (_wake: PhoneChatWake) => false);
    await wakes.retry("w1", THREAD, UNCONFIRMED, gate({ confirm }));
    expect(confirm).toHaveBeenCalledWith(UNCONFIRMED);
    expect(callsTo(RETRY)).toHaveLength(0);
    expect(phase(UNCONFIRMED.wakeId)).toBeUndefined();
    // Confirmed this time: the ID is minted only now.
    await wakes.retry("w1", THREAD, UNCONFIRMED, gate());
    expect(callsTo(RETRY)).toHaveLength(1);
  });

  it("asks once for a second press while the alert shows", async () => {
    const { server, wakes, open } = setup(context([UNCONFIRMED]));
    server.on("POST", RETRY, never);
    await open();
    const answer = deferred<boolean>();
    const confirm = vi.fn(() => answer.promise);
    void wakes.retry("w1", THREAD, UNCONFIRMED, gate({ confirm }));
    void wakes.retry("w1", THREAD, UNCONFIRMED, gate({ confirm }));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<PhoneChatWake>]>([
    ["a newer generation", { wakeId: wake(2).wakeId, generation: 2 }],
    ["another state", { state: "queued" }],
    ["no other computer", { canRetry: false }],
  ])("sends nothing when a read during the alert shows %s", async (_case, change) => {
    const { server, wakes, callsTo, open, lines, phase } = setup(
      context([UNCONFIRMED]),
      context([{ ...UNCONFIRMED, ...change }]),
    );
    server.on("POST", RETRY, retried());
    await open();
    const answer = deferred<boolean>();
    const done = wakes.retry("w1", THREAD, UNCONFIRMED, gate({ confirm: () => answer.promise }));
    wakes.refresh("w1");
    await vi.waitFor(() => expect(lines()).toEqual([{ ...UNCONFIRMED, ...change }]));
    answer.resolve(true);
    await done;
    expect(callsTo(RETRY)).toHaveLength(0);
    expect(phase(UNCONFIRMED.wakeId)).toBeUndefined();
  });

  it.each<[string, OutboxState, boolean]>([
    ["writes are off", READY, false],
    ["the outbox is locked", { ...READY, status: "locked" }, true],
    ["a Sign out's delete is owed", { ...READY, deletion: "owed" }, true],
    ["a Sign out's delete failed", { ...READY, deletion: "failed" }, true],
  ])("sends nothing when %s", async (_case, state, enabled) => {
    const { server, wakes, callsTo, open, phase } = setup(context([SOURCE]));
    server.on("POST", RETRY, retried());
    await open();
    await wakes.retry(
      "w1",
      THREAD,
      SOURCE,
      gate({ allowed: () => blockedBy(state, enabled) === null }),
    );
    expect(callsTo(RETRY)).toHaveLength(0);
    expect(phase()).toBeUndefined();
  });

  it.each<[string, Partial<OutboxState>]>([
    ["the outbox locks", { status: "locked" }],
    ["a Sign out's delete is owed", { deletion: "owed" }],
    ["a Sign out's delete failed", { deletion: "failed" }],
  ])("sends nothing when, during the alert, %s", async (_case, change) => {
    const { server, wakes, callsTo, open, phase } = setup(context([UNCONFIRMED]));
    server.on("POST", RETRY, retried());
    await open();
    let state = READY;
    const answer = deferred<boolean>();
    const confirm = vi.fn(() => answer.promise);
    const done = wakes.retry(
      "w1",
      THREAD,
      UNCONFIRMED,
      gate({ allowed: () => blockedBy(state, true) === null, confirm }),
    );
    // The alert shows before the outbox changes.
    expect(confirm).toHaveBeenCalledWith(UNCONFIRMED);
    state = { ...READY, ...change };
    answer.resolve(true);
    await done;
    expect(callsTo(RETRY)).toHaveLength(0);
    expect(phase(UNCONFIRMED.wakeId)).toBeUndefined();
  });

  it.each<[string, Answer, Answer]>([
    ["queued", context([{ ...SOURCE, state: "queued" }]), refused],
    ["a successor", context([NEXT], "8"), retried()],
    ["a failed read", { status: 503 }, refused],
  ])("drops the answer when a read during the request shows %s", async (_case, read, answer) => {
    const late = deferred<Answer>();
    const { server, wakes, callsTo, open, nextRead, phase } = setup(context([SOURCE]), read);
    server.on("POST", RETRY, () => late.promise);
    await open();
    const done = wakes.retry("w1", THREAD, SOURCE, gate());
    expect(callsTo(RETRY)).toHaveLength(1);
    await nextRead(() => wakes.refresh("w1"));
    late.resolve(answer);
    await done;
    // Nothing of the answer: no failure shown, and no read started by it.
    expect(phase()).toBeUndefined();
    expect(callsTo(CONTEXT)).toHaveLength(2);
  });

  it("drops the answer when writes become blocked, or the screen goes, during the request", async () => {
    const late = deferred<Answer>();
    const { server, wakes, callsTo, open, phase } = setup(context([SOURCE]));
    server.on("POST", RETRY, () => late.promise);
    await open();
    let allowed = true;
    const done = wakes.retry("w1", THREAD, SOURCE, gate({ allowed: () => allowed }));
    expect(callsTo(RETRY)).toHaveLength(1);
    allowed = false;
    late.resolve(refused);
    await done;
    expect(phase()).toBeUndefined();
    expect(callsTo(CONTEXT)).toHaveLength(1);
  });

  it("keeps the line's state when the server refuses, says so, and Try again sends the same request", async () => {
    const { server, wakes, callsTo, open, lines, phase } = setup(context([SOURCE]));
    server.on("POST", RETRY, refused);
    await open();
    await wakes.retry("w1", THREAD, SOURCE, gate());
    await vi.waitFor(() => expect(phase()).toBe("failed"));
    expect(callsTo(CONTEXT)).toHaveLength(2);
    expect(wakeLine(lines()?.[0] ?? NEXT)?.text).toBe("Nova didn't start");
    await wakes.retry("w1", THREAD, SOURCE, gate());
    expect(callsTo(RETRY)).toHaveLength(2);
    expect(callsTo(RETRY)[1]?.body).toEqual(callsTo(RETRY)[0]?.body);
  });

  it("sends nothing again until the read after a failed request lands, and nothing once it shows another state", async () => {
    const reread = deferred<Answer>();
    const { server, wakes, callsTo, open, lines, phase } = setup(
      context([SOURCE]),
      () => reread.promise,
    );
    server.on("POST", RETRY, "offline", retried());
    await open();
    await wakes.retry("w1", THREAD, SOURCE, gate());
    // The request failed, and the read it started is on its way: the line stays busy, and Try again waits.
    expect(callsTo(CONTEXT)).toHaveLength(2);
    expect(phase()).toBe("sending");
    await wakes.retry("w1", THREAD, SOURCE, gate());
    expect(callsTo(RETRY)).toHaveLength(1);
    reread.resolve(context([{ ...SOURCE, state: "queued" }]));
    await vi.waitFor(() => expect(lines()?.[0]?.state).toBe("queued"));
    expect(phase()).toBeUndefined();
    await wakes.retry("w1", THREAD, SOURCE, gate());
    expect(callsTo(RETRY)).toHaveLength(1);
  });

  it("offers Try again after a failed request only once a read works", async () => {
    const { server, wakes, callsTo, open, nextRead, phase } = setup(
      context([SOURCE]),
      { status: 503 },
      context([SOURCE]),
    );
    server.on("POST", RETRY, "offline", retried());
    await open();
    await nextRead(() => void wakes.retry("w1", THREAD, SOURCE, gate()));
    // The read after it failed: the failure shows, and Try again still waits.
    expect(wakes.view("w1", THREAD)?.failed).toBe(true);
    expect(phase()).toBe("failed");
    await wakes.retry("w1", THREAD, SOURCE, gate());
    expect(callsTo(RETRY)).toHaveLength(1);
    await nextRead(() => wakes.refresh("w1"));
    await wakes.retry("w1", THREAD, SOURCE, gate());
    expect(callsTo(RETRY)).toHaveLength(2);
    expect(callsTo(RETRY)[1]?.body).toEqual(callsTo(RETRY)[0]?.body);
  });

  it("offers nothing more for a wake the server doesn't have, and reads again", async () => {
    const { server, wakes, callsTo, open, phase } = setup(context([SOURCE]));
    server.on("POST", RETRY, missing);
    await open();
    await wakes.retry("w1", THREAD, SOURCE, gate());
    expect(callsTo(CONTEXT)).toHaveLength(2);
    await vi.waitFor(() => expect(phase()).toBe("missing"));
    await wakes.retry("w1", THREAD, SOURCE, gate());
    expect(callsTo(RETRY)).toHaveLength(1);
  });

  it("fails a generation of another message", async () => {
    const { server, wakes, open, phase } = setup(context([SOURCE]));
    server.on("POST", RETRY, retried({ messageId: "m-2" }));
    await open();
    await wakes.retry("w1", THREAD, SOURCE, gate());
    await vi.waitFor(() => expect(phase()).toBe("failed"));
  });

  it("mints a new ID for a press on a newer generation", async () => {
    const newer = wake(2, { generation: 2 });
    const { server, wakes, callsTo, open, lines } = setup(context([SOURCE]), context([newer], "8"));
    server.on("POST", RETRY, retried());
    await open();
    await wakes.retry("w1", THREAD, SOURCE, gate());
    await vi.waitFor(() => expect(lines()).toEqual([newer]));
    await wakes.retry("w1", THREAD, newer, gate());
    expect(callsTo(RETRY)).toHaveLength(2);
    const [first, second] = callsTo(RETRY).map((call) => call.body as Record<string, string>);
    expect(second?.wakeId).toBe(newer.wakeId);
    expect(second?.operationId).not.toBe(first?.operationId);
  });

  describe("keeps the request through a new content read of the conversation", () => {
    it("during the alert", async () => {
      const { server, wakes, callsTo, show, nextRead } = setup(context([UNCONFIRMED]));
      server.on("POST", RETRY, retried());
      const held = await show();
      const answer = deferred<boolean>();
      const done = wakes.retry("w1", THREAD, UNCONFIRMED, gate({ confirm: () => answer.promise }));
      await nextRead(() => held.want(wakes, "w1", THREAD, new Set(["thread-1"])));
      answer.resolve(true);
      await done;
      expect(callsTo(RETRY)).toHaveLength(1);
      expect(callsTo(RETRY)[0]?.body).toEqual({
        operationId: expect.stringMatching(UUID),
        wakeId: UNCONFIRMED.wakeId,
      });
    });

    it("while it sends", async () => {
      const late = deferred<Answer>();
      const { server, wakes, callsTo, show, nextRead, phase } = setup(context([SOURCE]));
      server.on("POST", RETRY, () => late.promise);
      const held = await show();
      const done = wakes.retry("w1", THREAD, SOURCE, gate());
      await nextRead(() => held.want(wakes, "w1", THREAD, new Set(["thread-1"])));
      expect(callsTo(RETRY)[0]?.signal.aborted).toBe(false);
      expect(phase()).toBe("sending");
      late.resolve(refused);
      await done;
      // Its answer landed, and read the conversation again.
      expect(callsTo(CONTEXT)).toHaveLength(3);
    });

    it("after a failed request, sending the same ID again", async () => {
      const { server, wakes, callsTo, show, nextRead, phase } = setup(context([SOURCE]));
      server.on("POST", RETRY, "offline", retried());
      const held = await show();
      await wakes.retry("w1", THREAD, SOURCE, gate());
      await vi.waitFor(() => expect(phase()).toBe("failed"));
      await nextRead(() => held.want(wakes, "w1", THREAD, new Set(["thread-1"])));
      expect(phase()).toBe("failed");
      await wakes.retry("w1", THREAD, SOURCE, gate());
      expect(callsTo(RETRY)).toHaveLength(2);
      expect(callsTo(RETRY)[1]?.body).toEqual(callsTo(RETRY)[0]?.body);
    });

    it("but not once the screen lets the conversation go", async () => {
      const late = deferred<Answer>();
      const { server, wakes, callsTo, show } = setup(context([SOURCE]));
      server.on("POST", RETRY, () => late.promise);
      const held = await show();
      const done = wakes.retry("w1", THREAD, SOURCE, gate());
      held.release();
      expect(callsTo(RETRY)[0]?.signal.aborted).toBe(true);
      late.resolve(retried());
      await done;
      expect(callsTo(CONTEXT)).toHaveLength(1);
    });
  });

  it.each<[string, (opened: ReturnType<typeof setup>, release: () => void) => void]>([
    ["background", ({ wakes }) => wakes.pause()],
    ["leaving the conversation", (_, release) => release()],
    ["a sign-in change", ({ endSignIn }) => endSignIn()],
    ["a workspace change", ({ wakes }) => wakes.stop()],
  ])("drops a late answer after %s", async (_case, leave) => {
    const late = deferred<Answer>();
    const opened = setup(context([SOURCE]));
    const { server, wakes, callsTo, open, phase } = opened;
    server.on("POST", RETRY, () => late.promise);
    const release = await open();
    const done = wakes.retry("w1", THREAD, SOURCE, gate());
    expect(callsTo(RETRY)).toHaveLength(1);
    leave(opened, release);
    expect(callsTo(RETRY)[0]?.signal.aborted).toBe(true);
    late.resolve(retried());
    await done;
    expect(callsTo(CONTEXT)).toHaveLength(1);
    expect(phase()).toBeUndefined();
  });

  it("needs a fresh read after the background before another press sends", async () => {
    const reread = deferred<Answer>();
    const { server, wakes, callsTo, open, nextRead, phase } = setup(
      context([SOURCE]),
      () => reread.promise,
    );
    server.on("POST", RETRY, never);
    await open();
    void wakes.retry("w1", THREAD, SOURCE, gate());
    expect(callsTo(RETRY)).toHaveLength(1);
    wakes.pause();
    expect(phase()).toBeUndefined();
    // The wakes as read before the background stay on screen, but take no Try again until the read lands.
    await nextRead(() => {
      wakes.resume();
      void wakes.retry("w1", THREAD, SOURCE, gate());
      expect(callsTo(RETRY)).toHaveLength(1);
      reread.resolve(context([SOURCE]));
    });
    void wakes.retry("w1", THREAD, SOURCE, gate());
    expect(callsTo(RETRY)).toHaveLength(2);
    // A new press after the background is a new request.
    const [first, second] = callsTo(RETRY).map((call) => call.body as Record<string, string>);
    expect(second?.operationId).not.toBe(first?.operationId);
  });
});
