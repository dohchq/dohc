import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createForwarding,
  forwardIdOf,
  type AgentThreadTool,
  type ForwardingDependencies,
  type ServedAgent,
} from "./forwarding";

const WORKSPACE = "ws-1";

type Chats = ForwardingDependencies["chats"];
type Request = Awaited<ReturnType<Chats["listAgentRequestsPage"]>>["requests"][number];
type Sent = Parameters<AgentThreadTool["forward"]>[0];

const agent: ServedAgent = {
  id: "chief",
  threadId: "t3-thread-1",
  whileBusy: "line",
  note: null,
  reader: {
    kind: "connected",
    agentId: "chief",
    handle: "chief",
    requesters: [],
    unattributedCounts: true,
  },
};

const request = (messageId: string, createdAtMs: number, over: Partial<Request> = {}): Request => ({
  threadId: "thread-a",
  messageId,
  channel: { id: "channel-1", kind: "agent", name: "Chief", slug: "chief", purpose: "" },
  author: { kind: "human", displayName: "Ice" },
  body: `body of ${messageId}`,
  createdAtMs,
  ...over,
});

const after = (
  row: { createdAtMs: number; messageId: string },
  place: { createdAtMs: number; messageId: string } | undefined,
) =>
  !place ||
  row.createdAtMs > place.createdAtMs ||
  (row.createdAtMs === place.createdAtMs && row.messageId > place.messageId);

/** Chats that keep each agent's read place in a thread the way the engine does: it only moves forward. */
function fakeChats(requests: Request[]) {
  const read = new Map<string, { createdAtMs: number; messageId: string }>();
  const place = (reader: ServedAgent["reader"], threadId: string) =>
    `${reader.agentId}
${threadId}`;
  const marks: string[] = [];
  let failMark = false;
  let beforeThread: () => Promise<void> = async () => {};
  const chats = {
    listAgentRequestsPage: async (input: Parameters<Chats["listAgentRequestsPage"]>[0]) => {
      const rows = requests
        .filter(
          (row) =>
            after(row, read.get(place(input.reader as ServedAgent["reader"], row.threadId))) &&
            after(row, input.after),
        )
        .sort((a, b) => a.createdAtMs - b.createdAtMs || a.messageId.localeCompare(b.messageId));
      const limit = input.limit ?? 50;
      return { requests: rows.slice(0, limit), more: rows.length > limit };
    },
    markThreadReadByAgent: async (input: Parameters<Chats["markThreadReadByAgent"]>[0]) => {
      if (failMark) throw new Error("the engine is busy");
      const key = place(input.reader as ServedAgent["reader"], input.threadId);
      if (after(input.upTo, read.get(key))) read.set(key, input.upTo);
      marks.push(input.upTo.messageId);
    },
    getThread: async (input: Parameters<Chats["getThread"]>[0]) => {
      await beforeThread();
      return {
        messageCount: 7,
        thread: {
          id: input.threadId,
          title: `title of ${input.threadId}`,
          ...(input.threadId === "thread-file"
            ? { linkedFile: { pathHint: "plans/release.md" } }
            : {}),
        },
      };
    },
  };
  return {
    chats: chats as unknown as Chats,
    marks,
    failMarks: (fail: boolean) => {
      failMark = fail;
    },
    /** Runs before each read of a chat thread settles. */
    holdThread: (hold: () => Promise<void>) => {
      beforeThread = hold;
    },
  };
}

function setup(requests: Request[], over: Partial<ForwardingDependencies> = {}) {
  const store = fakeChats(requests);
  const sent: Sent[] = [];
  const problems: Array<[string, string | null, unknown]> = [];
  const tool = {
    forward: vi.fn(async (input: Sent): Promise<{ runId: string | null } | void> => {
      sent.push(input);
    }),
  };
  const forwarding = createForwarding({
    cli: { program: "dohc", notes: [] },
    workspace: async () => ({ name: "Launch", agents: [agent] }),
    chats: store.chats,
    tool,
    onProblem: (...problem) => void problems.push(problem),
    retryAfterMs: [1_000, 5_000],
    ...over,
  });
  return { ...store, sent, problems, tool, forwarding };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("forwarding", () => {
  it("gives each unread message to the agent's thread once, oldest first", async () => {
    const { forwarding, sent, marks } = setup([request("m2", 20), request("m1", 10)]);

    await forwarding.wake(WORKSPACE);
    await forwarding.wake(WORKSPACE);

    expect(sent.map((message) => message.forwardId)).toEqual([
      forwardIdOf(WORKSPACE, "chief", "m1"),
      forwardIdOf(WORKSPACE, "chief", "m2"),
    ]);
    expect(sent.every((message) => message.threadId === "t3-thread-1")).toBe(true);
    expect(sent[0]!.how).toBe("line");
    expect(marks).toEqual(["m1", "m2"]);
  });

  it("tells what follows a forward which work the message started, before it marks the message read", async () => {
    const order: string[] = [];
    const seen: unknown[] = [];
    const { forwarding, tool, marks } = setup([request("m1", 10)], {
      onForwarded: (forwarded) => {
        order.push(`forwarded ${marks.length}`);
        seen.push({ ...forwarded, agent: forwarded.agent.id });
      },
    });
    tool.forward.mockResolvedValueOnce({ runId: "run-7" });

    await forwarding.wake(WORKSPACE);

    expect(seen).toEqual([
      {
        workspaceId: WORKSPACE,
        agent: "chief",
        chatThreadId: "thread-a",
        messageId: "m1",
        afterOrder: 6,
        runId: "run-7",
      },
    ]);
    expect(order).toEqual(["forwarded 0"]);
    expect(marks).toEqual(["m1"]);
  });

  it("does not wait for what follows a forward", async () => {
    const { forwarding, marks } = setup([request("m1", 10), request("m2", 20)], {
      // A ledger write that never ends.
      onForwarded: (() => new Promise<void>(() => {})) as () => void,
    });

    await forwarding.wake(WORKSPACE);

    expect(marks).toEqual(["m1", "m2"]);
  });

  it("marks a message read even when what follows a forward fails", async () => {
    const { forwarding, marks, problems } = setup([request("m1", 10)], {
      onForwarded: () => {
        throw new Error("the ledger is damaged");
      },
    });

    await forwarding.wake(WORKSPACE);

    expect(marks).toEqual(["m1"]);
    expect(problems).toEqual([]);
  });

  it("says who wrote the message, where, and how to reply there", async () => {
    const { forwarding, sent } = setup([request("m1", 10)]);

    await forwarding.wake(WORKSPACE);

    expect(sent[0]!.message).toBe(
      [
        'From "Ice" in dohc. Workspace "Launch", your own chat, chat thread "title of thread-a".',
        "",
        "body of m1",
        "",
        "Reply in that chat thread, with your text on stdin: dohc chat reply th_a --workspace ws-1 --agent-id chief -",
        "Read it first when this message points at something you were not sent, such as a file: dohc chat show th_a --workspace ws-1 --agent-id chief --peek",
      ].join("\n"),
    );
  });

  it("names a Group and a file's chat, and steers when the agent is set to", async () => {
    const { forwarding, sent } = setup(
      [
        request("m1", 10, {
          channel: { id: "c", kind: "channel", name: "launch", slug: "launch", purpose: "" },
        }),
        request("m2", 20, { threadId: "thread-file", channel: null }),
      ],
      {
        workspace: async () => ({
          name: "Launch",
          agents: [{ ...agent, whileBusy: "steer", note: "Post decisions here." }],
        }),
      },
    );

    await forwarding.wake(WORKSPACE);

    expect(sent[0]!.message).toContain('Group "launch", chat thread "title of thread-a".');
    expect(sent[1]!.message).toContain(`a file's chat, chat thread "title of thread-file".`);
    expect(sent[1]!.message).not.toContain("plans/release.md");
    expect(sent[0]!.message).toContain('Note from "Ice": Post decisions here.');
    expect(sent[0]!.message).not.toContain("Attached");
    expect(sent.map((message) => message.how)).toEqual(["steer", "steer"]);
  });

  it("forwards every page of a long backlog", async () => {
    const backlog = Array.from({ length: 120 }, (_, index) => request(`m${index}`, index));
    const { forwarding, sent } = setup(backlog);

    await forwarding.wake(WORKSPACE);

    expect(sent).toHaveLength(120);
    expect(new Set(sent.map((message) => message.forwardId)).size).toBe(120);
  });

  it("leaves a message unread when the tool did not take it, and tries again under the same id", async () => {
    vi.useFakeTimers();
    const { forwarding, sent, tool, problems, marks } = setup([request("m1", 10)]);
    const down = new Error("T3 Code is not running");
    tool.forward.mockRejectedValueOnce(down);

    await forwarding.wake(WORKSPACE);

    expect(sent).toEqual([]);
    expect(marks).toEqual([]);
    expect(problems).toEqual([[WORKSPACE, "chief", down]]);

    await vi.advanceTimersByTimeAsync(1_000);
    await forwarding.wake(WORKSPACE);

    expect(tool.forward).toHaveBeenCalledTimes(2);
    expect(tool.forward.mock.calls[0]![0].forwardId).toBe(tool.forward.mock.calls[1]![0].forwardId);
    expect(marks).toEqual(["m1"]);
    expect(problems.at(-1)).toEqual([WORKSPACE, "chief", null]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits longer after each failure", async () => {
    vi.useFakeTimers();
    const { forwarding, tool } = setup([request("m1", 10)]);
    tool.forward.mockRejectedValue(new Error("down"));

    await forwarding.wake(WORKSPACE);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tool.forward).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(tool.forward).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tool.forward).toHaveBeenCalledTimes(3);
    forwarding.stop();
  });

  it("marks a message read on the next try, without sending it again, when the tool took it and the read marker failed", async () => {
    const { forwarding, sent, marks, failMarks } = setup([request("m1", 10)], {
      retryAfterMs: [60_000],
    });
    failMarks(true);

    await forwarding.wake(WORKSPACE);
    expect(marks).toEqual([]);
    failMarks(false);
    await forwarding.wake(WORKSPACE);
    await forwarding.wake(WORKSPACE);

    expect(sent.map((message) => message.forwardId)).toEqual([
      forwardIdOf(WORKSPACE, "chief", "m1"),
    ]);
    expect(marks).toEqual(["m1"]);
    forwarding.stop();
  });

  it("sends a message again under the same id after a restart, when it was never marked read", async () => {
    const before = setup([request("m1", 10)], { retryAfterMs: [60_000] });
    before.failMarks(true);
    await before.forwarding.wake(WORKSPACE);
    before.forwarding.stop();

    // A new forwarder does not know the tool took it. The tool tells by the id.
    const after = setup([], { retryAfterMs: [60_000], chats: before.chats });
    await after.forwarding.wake(WORKSPACE);

    expect([...before.sent, ...after.sent].map((message) => message.forwardId)).toEqual([
      forwardIdOf(WORKSPACE, "chief", "m1"),
      forwardIdOf(WORKSPACE, "chief", "m1"),
    ]);
    after.forwarding.stop();
  });

  it("does not give the next thread a message the last one took, and goes on to the messages after it", async () => {
    let agents: ServedAgent[] = [agent];
    const { forwarding, sent, marks, failMarks } = setup([request("m1", 10)], {
      retryAfterMs: [60_000],
      workspace: async () => ({ name: "Launch", agents }),
    });
    // The first thread takes m1, and its read marker fails.
    failMarks(true);
    await forwarding.wake(WORKSPACE);
    expect(sent.map((message) => [message.threadId, message.forwardId])).toEqual([
      ["t3-thread-1", forwardIdOf(WORKSPACE, "chief", "m1")],
    ]);

    // The person points the agent at another thread. The tool would refuse
    // m1's id there, and every message after m1 would wait behind it.
    failMarks(false);
    agents = [{ ...agent, threadId: "t3-thread-new" }];
    await forwarding.wake(WORKSPACE, true);

    expect(sent).toHaveLength(1);
    expect(marks).toEqual(["m1"]);
    forwarding.stop();
  });

  it("gives an agent nothing more once it is turned off or pointed at another thread", async () => {
    let agents: ServedAgent[] = [agent];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { forwarding, sent, tool } = setup(
      [request("m1", 10), request("m2", 20), request("m3", 30)],
      { workspace: async () => ({ name: "Launch", agents }) },
    );
    tool.forward.mockImplementationOnce(async (input) => {
      await held;
      sent.push(input);
    });

    const first = forwarding.wake(WORKSPACE);
    await vi.waitFor(() => expect(tool.forward).toHaveBeenCalledTimes(1));
    agents = [{ ...agent, threadId: "t3-thread-new" }];
    const changed = forwarding.wake(WORKSPACE, true);
    release();
    await Promise.all([first, changed]);

    expect(sent.map((message) => message.threadId)).toEqual([
      "t3-thread-1",
      "t3-thread-new",
      "t3-thread-new",
    ]);

    agents = [];
    await forwarding.wake(WORKSPACE);
    expect(sent).toHaveLength(3);
  });

  it("keeps forwarding while chat writes keep coming", async () => {
    const { forwarding, sent, holdThread } = setup([request("m1", 10), request("m2", 20)]);
    // Each read of a chat thread meets another chat write, twenty times over.
    let reads = 0;
    holdThread(async () => {
      reads += 1;
      if (reads <= 20) void forwarding.wake(WORKSPACE);
    });

    await forwarding.wake(WORKSPACE);

    expect(sent.map((message) => message.forwardId)).toEqual([
      forwardIdOf(WORKSPACE, "chief", "m1"),
      forwardIdOf(WORKSPACE, "chief", "m2"),
    ]);
    // No write sent it back to read a chat thread again.
    expect(reads).toBe(2);
  });

  it("forwards a message that arrives while it works, without a second copy of the first", async () => {
    const requests = [request("m1", 10)];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { forwarding, sent, tool } = setup(requests);
    tool.forward.mockImplementationOnce(async (input) => {
      await held;
      sent.push(input);
    });

    const first = forwarding.wake(WORKSPACE);
    await vi.waitFor(() => expect(tool.forward).toHaveBeenCalledTimes(1));
    requests.push(request("m2", 20));
    const second = forwarding.wake(WORKSPACE);
    release();
    await Promise.all([first, second]);

    expect(sent.map((message) => message.forwardId)).toEqual([
      forwardIdOf(WORKSPACE, "chief", "m1"),
      forwardIdOf(WORKSPACE, "chief", "m2"),
    ]);
  });

  it("forwards messages written at the same moment, each once, across pages", async () => {
    const sameMoment = Array.from({ length: 120 }, (_, index) =>
      request(`m${String(index).padStart(3, "0")}`, 10),
    );
    const { forwarding, sent } = setup(sameMoment);

    await forwarding.wake(WORKSPACE);

    expect(sent.map((message) => message.forwardId)).toEqual(
      sameMoment.map((row) => forwardIdOf(WORKSPACE, "chief", row.messageId)),
    );
  });

  it("gives two agents the same message, each in its own thread", async () => {
    const other: ServedAgent = {
      ...agent,
      id: "scout",
      threadId: "t3-thread-2",
      reader: { ...agent.reader, agentId: "scout", handle: "scout" },
    };
    const { forwarding, sent } = setup([request("m1", 10), request("m2", 20)], {
      workspace: async () => ({ name: "Launch", agents: [agent, other] }),
    });

    await forwarding.wake(WORKSPACE);
    await forwarding.wake(WORKSPACE);

    expect(sent.map((message) => [message.threadId, message.forwardId])).toEqual([
      ["t3-thread-1", forwardIdOf(WORKSPACE, "chief", "m1")],
      ["t3-thread-1", forwardIdOf(WORKSPACE, "chief", "m2")],
      ["t3-thread-2", forwardIdOf(WORKSPACE, "scout", "m1")],
      ["t3-thread-2", forwardIdOf(WORKSPACE, "scout", "m2")],
    ]);
  });

  it("goes on to the next agent and tries again when the problem cannot be reported", async () => {
    vi.useFakeTimers();
    const other: ServedAgent = {
      ...agent,
      id: "scout",
      threadId: "t3-thread-2",
      reader: { ...agent.reader, agentId: "scout", handle: "scout" },
    };
    const { forwarding, tool } = setup([request("m1", 10)], {
      workspace: async () => ({ name: "Launch", agents: [agent, other] }),
      onProblem: () => {
        throw new Error("the window is gone");
      },
    });
    tool.forward.mockRejectedValueOnce(new Error("down"));

    await forwarding.wake(WORKSPACE);
    expect(tool.forward.mock.calls.map(([input]) => input.threadId)).toEqual([
      "t3-thread-1",
      "t3-thread-2",
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    await forwarding.wake(WORKSPACE);
    expect(tool.forward.mock.calls.map(([input]) => input.threadId)).toEqual([
      "t3-thread-1",
      "t3-thread-2",
      "t3-thread-1",
    ]);
  });

  it("sends nothing new when it is stopped while it reads the chat thread", async () => {
    const { forwarding, tool, holdThread, marks } = setup([request("m1", 10)]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reading!: () => void;
    const started = new Promise<void>((resolve) => (reading = resolve));
    holdThread(() => {
      reading();
      return held;
    });

    const work = forwarding.wake(WORKSPACE);
    await started;
    forwarding.stop();
    release();
    await work;

    expect(tool.forward).not.toHaveBeenCalled();
    expect(marks).toEqual([]);
  });

  it("keeps one agent's failure from holding another agent's messages", async () => {
    const other: ServedAgent = {
      ...agent,
      id: "scout",
      threadId: "t3-thread-2",
      reader: { ...agent.reader, agentId: "scout", handle: "scout" },
    };
    const { forwarding, tool, problems } = setup([request("m1", 10)], {
      workspace: async () => ({ name: "Launch", agents: [agent, other] }),
      retryAfterMs: [60_000],
    });
    tool.forward.mockImplementation(async (input) => {
      if (input.threadId === "t3-thread-1") throw new Error("this thread is gone");
    });

    await forwarding.wake(WORKSPACE);

    expect(tool.forward.mock.calls.map(([input]) => input.threadId)).toEqual([
      "t3-thread-1",
      "t3-thread-2",
    ]);
    expect(problems.map(([, agentId]) => agentId)).toEqual(["chief"]);
    forwarding.stop();
  });

  it("takes back an agent's problem once the agent no longer serves the workspace", async () => {
    let agents: ServedAgent[] = [agent];
    const { forwarding, tool, problems } = setup([request("m1", 10)], {
      workspace: async () => ({ name: "Launch", agents }),
      retryAfterMs: [60_000],
    });
    const down = new Error("down");
    tool.forward.mockRejectedValue(down);

    await forwarding.wake(WORKSPACE);
    agents = [];
    await forwarding.wake(WORKSPACE, true);

    expect(problems).toEqual([
      [WORKSPACE, "chief", down],
      [WORKSPACE, "chief", null],
    ]);
    forwarding.stop();
  });

  it("takes back a workspace's problems and stops trying when the workspace leaves", async () => {
    vi.useFakeTimers();
    const { forwarding, tool, problems } = setup([request("m1", 10)]);
    const down = new Error("down");
    tool.forward.mockRejectedValue(down);

    await forwarding.wake(WORKSPACE);
    expect(vi.getTimerCount()).toBe(1);
    forwarding.leave(WORKSPACE);

    expect(vi.getTimerCount()).toBe(0);
    expect(problems).toEqual([
      [WORKSPACE, "chief", down],
      [WORKSPACE, "chief", null],
    ]);
  });

  it("ends work for a workspace that leaves while a message is on its way", async () => {
    vi.useFakeTimers();
    const { forwarding, tool, problems, marks } = setup([request("m1", 10), request("m2", 20)]);
    let fail!: (error: Error) => void;
    let onItsWay!: () => void;
    const sending = new Promise<void>((resolve) => (onItsWay = resolve));
    tool.forward.mockImplementationOnce(() => {
      onItsWay();
      return new Promise<undefined>((_resolve, reject) => (fail = reject));
    });

    const work = forwarding.wake(WORKSPACE);
    await sending;
    forwarding.leave(WORKSPACE);
    fail(new Error("down"));
    await work;

    // Nothing is reported, no other message goes out, and nothing waits to try again.
    expect(problems).toEqual([]);
    expect(tool.forward).toHaveBeenCalledTimes(1);
    expect(marks).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    // The workspace comes back: its messages go out as for any workspace.
    await forwarding.wake(WORKSPACE);
    expect(tool.forward).toHaveBeenCalledTimes(3);
    expect(marks).toEqual(["m1", "m2"]);
  });

  it("keeps each workspace's messages in that workspace", async () => {
    // Two workspaces hold a message with the same id, in a chat thread with
    // the same id, for an agent with the same id.
    const stores = {
      "ws-1": fakeChats([request("m1", 10, { body: "from one" })]),
      "ws-2": fakeChats([request("m1", 10, { body: "from two" })]),
    };
    const asked: string[] = [];
    const store = (workspaceId: string) => {
      asked.push(workspaceId);
      return stores[workspaceId as keyof typeof stores].chats;
    };
    const sent: Sent[] = [];
    const forwarding = createForwarding({
      cli: { program: "dohc", notes: [] },
      workspace: async (workspaceId) => ({ name: workspaceId, agents: [agent] }),
      chats: {
        listAgentRequestsPage: (input) => store(input.workspaceId).listAgentRequestsPage(input),
        markThreadReadByAgent: (input) => store(input.workspaceId).markThreadReadByAgent(input),
        getThread: (input) => store(input.workspaceId).getThread(input),
      },
      tool: { forward: async (input) => void sent.push(input) },
      onProblem: () => {},
    });

    await forwarding.wake("ws-1");

    expect(new Set(asked)).toEqual(new Set(["ws-1"]));
    expect(sent.map((message) => message.forwardId)).toEqual([forwardIdOf("ws-1", "chief", "m1")]);
    expect(sent[0]!.message).toContain("from one");
    expect(sent[0]!.message).toContain("--workspace ws-1 ");
    expect(stores["ws-1"].marks).toEqual(["m1"]);
    expect(stores["ws-2"].marks).toEqual([]);

    await forwarding.wake("ws-2");

    expect(sent[1]!.forwardId).toBe(forwardIdOf("ws-2", "chief", "m1"));
    expect(sent[1]!.forwardId).not.toBe(sent[0]!.forwardId);
    expect(sent[1]!.message).toContain("from two");
    expect(sent[1]!.message).toContain("--workspace ws-2 ");
    expect(stores["ws-2"].marks).toEqual(["m1"]);
  });

  it("sets a backlog aside without forwarding it", async () => {
    const backlog = [
      ...Array.from({ length: 70 }, (_, index) => request(`m${index}`, index)),
      request("n1", 500, { threadId: "thread-b" }),
    ];
    const { forwarding, sent, marks } = setup(backlog);

    await forwarding.setAside(WORKSPACE, agent);
    await forwarding.wake(WORKSPACE);

    expect(sent).toEqual([]);
    expect(marks).toEqual(["m69", "n1"]);
  });

  it("does nothing for a workspace this computer no longer has, and reports one it cannot read", async () => {
    const gone = setup([request("m1", 10)], { workspace: async () => null });
    await gone.forwarding.wake(WORKSPACE);
    expect(gone.sent).toEqual([]);
    expect(gone.problems).toEqual([]);

    const unreadable = new Error("settings are damaged");
    const broken = setup([request("m1", 10)], {
      workspace: async () => {
        throw unreadable;
      },
      retryAfterMs: [60_000],
    });
    await broken.forwarding.wake(WORKSPACE);
    expect(broken.problems).toEqual([[WORKSPACE, null, unreadable]]);
    broken.forwarding.stop();
  });

  it("sends nothing and waits for nothing once stopped", async () => {
    vi.useFakeTimers();
    const { forwarding, tool } = setup([request("m1", 10)]);
    tool.forward.mockRejectedValue(new Error("down"));

    await forwarding.wake(WORKSPACE);
    expect(vi.getTimerCount()).toBe(1);
    forwarding.stop();
    expect(vi.getTimerCount()).toBe(0);
    await forwarding.wake(WORKSPACE);

    expect(tool.forward).toHaveBeenCalledTimes(1);
  });
});
