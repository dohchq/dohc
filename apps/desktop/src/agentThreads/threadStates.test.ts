import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForwardLedger, ForwardRow } from "./forwardLedger";
import type { T3CodeRun, T3CodeThreadState } from "./t3Code";
import { createThreadStates, type ThreadStatesDependencies } from "./threadStates";

const WORKSPACE = "ws-1";
type Forwarded = Parameters<ReturnType<typeof createThreadStates>["forwarded"]>[0];

const forwarded = (over: Partial<Forwarded> = {}): Forwarded => ({
  workspaceId: WORKSPACE,
  agentId: "chief",
  chatThreadId: "thread-a",
  toolThreadId: "t3-1",
  messageId: "m1",
  afterOrder: 3,
  forwardedAtMs: 1_000,
  runId: "run-1",
  ...over,
});

const run = (id: string, state: T3CodeRun["state"], over: Partial<T3CodeRun> = {}): T3CodeRun => ({
  id,
  state,
  requestedAtMs: 1_100,
  startedAtMs: state === "in-line" ? null : 1_200,
  endedAtMs: state === "ended" ? 1_900 : null,
  ...over,
});

const thread = (runs: T3CodeRun[], over: Partial<T3CodeThreadState> = {}): T3CodeThreadState => ({
  title: "Chief of Staff",
  working: runs.some((entry) => entry.state === "working"),
  waitingOnPerson: false,
  closed: false,
  runs,
  ...over,
});

/** A ledger in memory that keeps what was saved, in order. */
function memoryLedger(start: ForwardRow[] = []) {
  let rows = [...start];
  const saved: ForwardRow["reminder"]["state"][] = [];
  const same = (a: ForwardRow, b: Pick<ForwardRow, "workspaceId" | "agentId" | "chatThreadId">) =>
    a.workspaceId === b.workspaceId && a.agentId === b.agentId && a.chatThreadId === b.chatThreadId;
  const ledger: ForwardLedger = {
    list: async () => [...rows],
    put: async (row) => {
      saved.push(row.reminder.state);
      rows = [...rows.filter((other) => !same(other, row)), row];
    },
    remove: async (row) => {
      rows = rows.filter((other) => !(same(other, row) && other.messageId === row.messageId));
    },
    removeWhere: async (match) => {
      rows = rows.filter((row) => !match(row));
    },
  };
  return { ledger, saved, rows: () => rows };
}

function setup(over: Partial<ThreadStatesDependencies> = {}, start: ForwardRow[] = []) {
  const store = memoryLedger(start);
  // The chat thread's messages after the forwarded one, by who wrote them.
  const chat: Array<{ authorAgentId?: string }> = [];
  let now = 5_000;
  let state = thread([run("run-1", "in-line")]);
  const sent: Array<{ threadId: string; message: string; forwardId: string }> = [];
  const forward = vi.fn(async (input: (typeof sent)[number]) => {
    sent.push(input);
    return { runId: "run-remind" };
  });
  const read = vi.fn(async () => state);
  const changes: string[] = [];
  const errors: unknown[] = [];
  const states = createThreadStates({
    ledger: store.ledger,
    tool: { thread: read, forward },
    chats: {
      listMessagesPage: async (input) => {
        const from = (input.afterMessageOrder ?? -1) - 3;
        return {
          messages: chat.slice(Math.max(0, from)) as never,
          nextAfterMessageOrder: null,
        };
      },
    },
    reminder: async () => "REMINDER",
    onChange: (workspaceId) => void changes.push(workspaceId),
    onError: (error) => void errors.push(error),
    nowMs: () => now,
    pollMs: 4_000,
    ...over,
  });
  return {
    ...store,
    states,
    chat,
    sent,
    forward,
    read,
    changes,
    errors,
    at: (ms: number) => {
      now = ms;
    },
    tool: (next: T3CodeThreadState) => {
      state = next;
    },
  };
}

const line = (states: ReturnType<typeof createThreadStates>) => states.lines(WORKSPACE)[0] ?? null;

afterEach(() => {
  vi.useRealTimers();
});

describe("what an agent thread is doing with a forwarded message", () => {
  it("is in line, then working, then waiting on the person, each since its own start", async () => {
    const { states, tool, at, changes } = setup();

    await states.forwarded(forwarded());
    await states.check();
    expect(line(states)).toEqual({
      agentId: "chief",
      chatThreadId: "thread-a",
      state: "in-line",
      sinceMs: 1_100,
    });

    tool(thread([run("run-1", "working")]));
    await states.check();
    expect(line(states)).toMatchObject({ state: "working", sinceMs: 1_200 });

    at(7_000);
    tool(thread([run("run-1", "working")], { waitingOnPerson: true }));
    await states.check();
    expect(line(states)).toMatchObject({ state: "waiting-in-tool", sinceMs: 7_000 });
    // The same state at a later look keeps the time it began.
    at(9_000);
    await states.check();
    expect(line(states)).toMatchObject({ state: "waiting-in-tool", sinceMs: 7_000 });
    expect(changes.every((workspaceId) => workspaceId === WORKSPACE)).toBe(true);
    states.stop();
  });

  it("takes the line away once the agent replies in that chat thread", async () => {
    const { states, chat, rows, forward } = setup();
    await states.forwarded(forwarded());
    await states.check();
    expect(line(states)).not.toBeNull();

    // Another person's message is no reply.
    chat.push({});
    await states.check();
    expect(line(states)).not.toBeNull();

    chat.push({ authorAgentId: "chief" });
    await states.check();

    expect(line(states)).toBeNull();
    expect(rows()).toEqual([]);
    expect(forward).not.toHaveBeenCalled();
    states.stop();
  });

  it("reminds the thread once when its work ends with no reply, and records that first", async () => {
    const { states, tool, sent, saved, forward } = setup();
    await states.forwarded(forwarded());
    tool(thread([run("run-1", "ended")]));

    await states.check();

    expect(sent).toEqual([
      {
        threadId: "t3-1",
        message: "REMINDER",
        how: "line",
        forwardId: expect.stringMatching(/^remind-dohc-[0-9a-f]{64}$/),
      },
    ]);
    // Saved as none when forwarded, recorded before the reminder went, sent after.
    expect(saved).toEqual(["none", "recorded", "sent"]);
    expect(line(states)).toMatchObject({ state: "in-line" });

    // The reminder's own work goes on: no second reminder.
    tool(thread([run("run-remind", "working"), run("run-1", "ended")]));
    await states.check();
    expect(line(states)).toMatchObject({ state: "working" });

    // It ends with nothing posted: the chat says so, and nothing more is sent.
    tool(thread([run("run-remind", "ended", { endedAtMs: 8_000 }), run("run-1", "ended")]));
    await states.check();
    await states.check();
    expect(line(states)).toMatchObject({ state: "silent", sinceMs: 8_000 });
    expect(forward).toHaveBeenCalledTimes(1);
    states.stop();
  });

  it("never sends a second reminder after a restart between recording it and sending it", async () => {
    const stopped: ForwardRow = { ...forwarded(), reminder: { state: "recorded" } };
    const { states, tool, forward } = setup({}, [stopped]);
    tool(thread([run("run-1", "ended")]));

    await states.check();
    await states.check();

    expect(forward).not.toHaveBeenCalled();
    expect(line(states)).toMatchObject({ state: "silent" });
    states.stop();
  });

  it("stays recorded, and sends no second reminder, when the tool did not take the first", async () => {
    const { states, tool, forward, rows, errors } = setup();
    await states.forwarded(forwarded());
    tool(thread([run("run-1", "ended")]));
    const down = new Error("down");
    forward.mockRejectedValueOnce(down);

    await states.check();
    await states.check();

    expect(forward).toHaveBeenCalledTimes(1);
    expect(rows()[0]!.reminder).toEqual({ state: "recorded" });
    expect(errors).toEqual([down]);
    expect(line(states)).toMatchObject({ state: "silent" });
    states.stop();
  });

  it("drops a row whose agent no longer serves the workspace, with no reminder", async () => {
    const { states, tool, forward, rows } = setup({ reminder: async () => null });
    await states.forwarded(forwarded());
    tool(thread([run("run-1", "ended")]));

    await states.check();

    expect(forward).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(line(states)).toBeNull();
    states.stop();
  });

  it("counts work the tool does not list yet as in line, and work pushed off its list as over", async () => {
    const { states, tool, forward, at } = setup();
    // The tool has not listed the message's work yet: every listed run is older.
    await states.forwarded(forwarded({ runId: "run-new", forwardedAtMs: 4_000 }));
    tool(thread([run("run-0", "ended", { requestedAtMs: 900 })]));
    await states.check();
    expect(line(states)).toMatchObject({ state: "in-line" });
    expect(forward).not.toHaveBeenCalled();

    // Newer work is listed and this run is not: it was pushed off the list.
    tool(thread([run("run-later", "ended", { requestedAtMs: 4_500 })]));
    await states.check();
    expect(forward).toHaveBeenCalledTimes(1);

    // Work that stays unlisted for ten minutes is over too.
    const second = setup();
    await second.states.forwarded(forwarded({ runId: "run-lost", forwardedAtMs: 4_000 }));
    second.tool(thread([]));
    await second.states.check();
    expect(second.forward).not.toHaveBeenCalled();
    second.at(4_000 + 10 * 60_000);
    await second.states.check();
    expect(second.forward).toHaveBeenCalledTimes(1);
    at(0);
    states.stop();
    second.states.stop();
  });

  it("goes by the thread itself when the tool gave no id for the work", async () => {
    const { states, tool, forward } = setup();
    await states.forwarded(forwarded({ runId: null }));
    tool(thread([run("run-x", "working")]));
    await states.check();
    expect(line(states)).toMatchObject({ state: "working", sinceMs: 1_000 });

    tool(thread([run("run-x", "ended")]));
    await states.check();
    expect(forward).toHaveBeenCalledTimes(1);
    states.stop();
  });

  it("lets a newer message in the same chat thread take the older one's place", async () => {
    const { states, tool, rows } = setup();
    await states.forwarded(forwarded());
    tool(thread([run("run-2", "in-line"), run("run-1", "working")]));
    await states.check();
    expect(line(states)).toMatchObject({ state: "working" });

    await states.forwarded(forwarded({ messageId: "m2", runId: "run-2", forwardedAtMs: 2_000 }));
    await states.check();

    expect(rows().map((row) => row.messageId)).toEqual(["m2"]);
    expect(states.lines(WORKSPACE)).toHaveLength(1);
    expect(line(states)).toMatchObject({ state: "in-line" });
    states.stop();
  });

  it("asks the tool once for a thread that serves two chat threads", async () => {
    const { states, read } = setup();
    await states.forwarded(forwarded());
    await states.forwarded(forwarded({ chatThreadId: "thread-b", messageId: "m9" }));
    read.mockClear();

    await states.check();

    expect(read).toHaveBeenCalledTimes(1);
    expect(states.lines(WORKSPACE)).toHaveLength(2);
    states.stop();
  });

  it("looks again every few seconds while a message is in line or in work, and stops when none is", async () => {
    vi.useFakeTimers();
    const { states, read, chat } = setup();
    await states.forwarded(forwarded());
    await states.check();
    read.mockClear();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(read).toHaveBeenCalledTimes(1);

    chat.push({ authorAgentId: "chief" });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(states.lines(WORKSPACE)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    states.stop();
  });

  it("keeps the line and waits longer when the tool cannot be asked", async () => {
    vi.useFakeTimers();
    const { states, read, errors } = setup();
    await states.forwarded(forwarded());
    await states.check();
    const down = new Error("T3 Code is not running");
    read.mockRejectedValue(down);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(errors).toEqual([down]);
    expect(line(states)).toMatchObject({ state: "in-line" });
    read.mockClear();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(26_000);
    expect(read).toHaveBeenCalledTimes(1);
    states.stop();
  });

  it("forgets a workspace's rows, and looks at nothing once stopped", async () => {
    vi.useFakeTimers();
    const { states, rows, changes, read } = setup();
    await states.forwarded(forwarded());
    await states.forwarded(forwarded({ workspaceId: "ws-2" }));
    await states.check();
    changes.length = 0;

    await states.forget((row) => row.workspaceId === WORKSPACE);

    expect(rows().map((row) => row.workspaceId)).toEqual(["ws-2"]);
    expect(states.lines(WORKSPACE)).toEqual([]);
    expect(changes).toEqual([WORKSPACE]);

    states.stop();
    read.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    await states.check();
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
