import { afterEach, describe, expect, it, vi } from "vitest";
import { signalChatWrite } from "../workspaces/chatWriteSignals";
import { testAgent } from "../testing/agentSettings";
import { AgentsSettings } from "../settings/userSettings";
import {
  createAgentThreads,
  forwardProblemWords,
  type AgentThreadsDependencies,
} from "./agentThreads";
import type { ForwardLedger, ForwardRow } from "./forwardLedger";
import { T3CodeError, type T3CodeThreadState } from "./t3Code";
import type { T3CodeConnection } from "./t3CodeConnection";

const WORKSPACE = "ws-1";
type Chats = AgentThreadsDependencies["chats"];
type Sent = Parameters<T3CodeConnection["forward"]>[0];

const { launch: _launch, ...unlaunched } = testAgent();
const thread = { tool: "t3-code" as const, id: "t3-thread-1" };
const chief = { ...unlaunched, name: "Chief", enabled: true, thread, workspaces: [WORKSPACE] };

const otherThread = (id: string) => ({ ...thread, id });

function setup(
  agents: Record<string, unknown>,
  unread: string[] = ["m1"],
  cli: AgentThreadsDependencies["cli"] = { program: "dohc", notes: [] },
) {
  let settings = AgentsSettings.parse(agents);
  const sent: Sent[] = [];
  const order: string[] = [];
  const readers: unknown[] = [];
  let left = [...unread];
  const chats = {
    listAgentRequestsPage: async (input: Parameters<Chats["listAgentRequestsPage"]>[0]) => {
      readers.push(input.reader);
      return {
        requests: left.map((messageId, index) => ({
          threadId: "thread-a",
          messageId,
          channel: { id: "c", kind: "agent", name: "Chief", slug: "chief", purpose: "" },
          author: { kind: "human", displayName: "Ice" },
          body: `body of ${messageId}`,
          createdAtMs: index + 1,
        })),
        more: false,
      };
    },
    markThreadReadByAgent: async (input: Parameters<Chats["markThreadReadByAgent"]>[0]) => {
      order.push(`read ${input.upTo.messageId}`);
      left = left.filter((messageId) => messageId > input.upTo.messageId);
    },
    getThread: async () => ({ thread: { id: "thread-a", title: "Hello" }, messageCount: 4 }),
    // What was posted in the chat thread after the forwarded message.
    listMessagesPage: async () => ({ messages: replies, nextAfterMessageOrder: null }),
  } as unknown as Chats;
  const replies: Array<{ authorAgentId?: string }> = [];
  // What the tool says the thread is doing.
  const tool: { state: T3CodeThreadState } = {
    state: {
      title: "Chief",
      working: true,
      activeRunId: null,
      waitingOnPerson: false,
      questionId: null,
      closed: false,
      runs: [],
    },
  };
  let saved: ForwardRow[] = [];
  const ledger: ForwardLedger = {
    list: async () => [...saved],
    put: async (row) => {
      saved = [
        ...saved.filter(
          (other) =>
            !(
              other.workspaceId === row.workspaceId &&
              other.agentId === row.agentId &&
              other.chatThreadId === row.chatThreadId
            ),
        ),
        row,
      ];
    },
    remove: async (row) => {
      saved = saved.filter((other) => other.messageId !== row.messageId);
    },
    removeWhere: async (match) => {
      saved = saved.filter((row) => !match(row));
    },
  };
  const lineChanges: string[] = [];
  const forward = vi.fn(async (input: Sent): Promise<{ runId: string | null } | void> => {
    order.push(
      `sent ${input.forwardId.startsWith("dohc-intro-") ? "intro" : input.forwardId.startsWith("remind-") ? "reminder" : "message"}`,
    );
    sent.push(input);
    return { runId: `run-${sent.length}` };
  });
  const forget = vi.fn(async () => {});
  const agentThreads = createAgentThreads({
    cli,
    t3Code: {
      forward,
      forget,
      thread: async () => tool.state,
      run: async (_threadId: string, runId: string) =>
        tool.state.runs.find((entry) => entry.id === runId)?.state ?? "in-line",
    } as unknown as T3CodeConnection,
    chats,
    ledger,
    onLines: (workspaceId) => void lineChanges.push(workspaceId),
    nowMs: () => 9_000,
    readSettings: async () => ({ agents: settings }),
    workspace: (workspaceId) =>
      workspaceId === WORKSPACE
        ? { name: "Launch", requesters: ["account-1"], unattributedCounts: true }
        : null,
    onProblem: () => {},
  });
  return {
    agentThreads,
    sent,
    order,
    readers,
    forward,
    forget,
    replies,
    tool,
    lineChanges,
    rows: () => saved,
    save: (next: Record<string, unknown>) => {
      settings = AgentsSettings.parse(next);
    },
    arrive: (messageId: string) => {
      left.push(messageId);
      signalChatWrite(WORKSPACE);
    },
  };
}

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});
const started = <T extends { agentThreads: { stop(): void } }>(made: T): T => {
  stops.push(() => made.agentThreads.stop());
  return made;
};
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("agent threads", () => {
  it("forwards a watched workspace's messages to each agent that serves it, as that agent reads", async () => {
    const { agentThreads, sent, readers } = started(
      setup({
        chief,
        elsewhere: {
          ...chief,
          name: "Elsewhere",
          thread: otherThread("t3-thread-2"),
          workspaces: ["ws-2"],
        },
        paused: { ...chief, name: "Paused", thread: otherThread("t3-thread-3"), enabled: false },
        started: testAgent({ name: "Started", enabled: true }),
      }),
    );

    agentThreads.watch(WORKSPACE);

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ threadId: "t3-thread-1", how: "line" });
    expect(sent[0]!.message).toContain("--workspace ws-1 --agent-id chief");
    expect(readers[0]).toEqual({
      kind: "connected",
      agentId: "chief",
      handle: "Chief",
      requesters: ["account-1"],
      unattributedCounts: true,
    });
  });

  it("forwards what a chat write brings, with the note and the busy choice from Settings", async () => {
    const { agentThreads, sent, arrive } = started(
      setup({ chief: { ...chief, whileBusy: "steer", note: "Post decisions here." } }, []),
    );
    agentThreads.watch(WORKSPACE);

    arrive("m7");

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.how).toBe("steer");
    expect(sent[0]!.message).toContain('Note from "Ice": Post decisions here.');
  });

  it("stops forwarding to an agent turned off in Settings, and starts again when it is on", async () => {
    const { agentThreads, sent, save, arrive } = started(setup({ chief }, []));
    agentThreads.watch(WORKSPACE);

    save({ chief: { ...chief, enabled: false } });
    agentThreads.settingsChanged();
    arrive("m1");
    await settled();
    expect(sent).toEqual([]);

    save({ chief });
    agentThreads.settingsChanged();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it("connects a thread: sets the backlog aside, then introduces dohc", async () => {
    const { agentThreads, order, sent } = started(setup({}, ["m1", "m2"]));

    await agentThreads.connect(WORKSPACE, { id: "chief", name: "Chief", thread });

    expect(order).toEqual(["read m2", "sent intro"]);
    expect(sent[0]).toMatchObject({ threadId: "t3-thread-1", how: "line" });
    expect(sent[0]!.message).toContain('their agent "Chief"');
  });

  it("does not connect a thread T3 Code will not let dohc message, or a workspace that is gone", async () => {
    const { agentThreads, forward } = started(setup({}, []));
    const refused = new T3CodeError("needs-more-access", "This thread runs with more access.");
    forward.mockRejectedValueOnce(refused);

    await expect(
      agentThreads.connect(WORKSPACE, { id: "chief", name: "Chief", thread }),
    ).rejects.toBe(refused);
    await expect(
      agentThreads.connect("ws-gone", { id: "chief", name: "Chief", thread }),
    ).rejects.toThrow("no longer has this workspace");
  });

  it("drops dohc's sign-in when the last agent with a thread is removed", async () => {
    const { agentThreads, forget, save } = started(
      setup({ chief, other: { ...chief, name: "Other", thread: otherThread("t3-thread-2") } }, []),
    );
    agentThreads.watch(WORKSPACE);
    await settled();

    save({ chief });
    agentThreads.settingsChanged();
    await settled();
    expect(forget).not.toHaveBeenCalled();

    save({ started: testAgent({ name: "Started" }) });
    agentThreads.settingsChanged();
    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(1));

    // Nothing more to drop while no agent has a thread.
    agentThreads.settingsChanged();
    await settled();
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it("drops a sign-in no agent needs when dohc starts, and keeps one a person just allowed", async () => {
    const { agentThreads, forget } = started(setup({}, []));

    agentThreads.watch(WORKSPACE);
    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(1));

    // The person allows dohc, and a setting is saved before they add the agent.
    agentThreads.watch("ws-other");
    agentThreads.settingsChanged();
    await settled();
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it("lets no older look at the agents overwrite a newer one", async () => {
    const { agentThreads, forget, save } = started(setup({ chief }, []));
    agentThreads.watch(WORKSPACE);
    await settled();
    // The drop for the removed agent is still going when the agent comes back.
    let release!: () => void;
    forget.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    save({});
    agentThreads.settingsChanged();
    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
    save({ chief });
    agentThreads.settingsChanged();
    release();
    await settled();

    save({});
    agentThreads.settingsChanged();

    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(2));
  });

  it("connects nothing when dohc cannot name its program in a command", async () => {
    const { agentThreads, forward, order } = started(
      setup({}, ["m1"], { program: null, refused: "&", notes: [] }),
    );

    await expect(
      agentThreads.connect(WORKSPACE, { id: "chief", name: "Chief", thread }),
    ).rejects.toThrow(
      `dohc can't connect a thread from where it is installed. The path of its folder has "&", which a command can't carry safely. Install dohc in a folder whose path has none.`,
    );

    expect(forward).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("forwards nothing for a workspace that left this computer, and tries again only for one it watches", async () => {
    const { agentThreads, sent, arrive } = started(setup({ chief }, []));
    agentThreads.watch(WORKSPACE);
    await settled();

    agentThreads.unwatch(WORKSPACE);
    arrive("m1");
    agentThreads.retry(WORKSPACE);
    agentThreads.settingsChanged();
    await settled();
    expect(sent).toEqual([]);

    agentThreads.watch(WORKSPACE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it("shows what the thread is doing with a forwarded message, until the agent replies", async () => {
    const { agentThreads, sent, tool, replies, rows, lineChanges } = started(setup({ chief }));
    tool.state = {
      ...tool.state,
      runs: [
        { id: "run-1", state: "working", requestedAtMs: 100, startedAtMs: 200, endedAtMs: null },
      ],
    };

    agentThreads.watch(WORKSPACE);

    await vi.waitFor(() =>
      expect(agentThreads.lines(WORKSPACE)).toEqual([
        // The run began before the message went, so its time counts from the message.
        {
          agentId: "chief",
          chatThreadId: "thread-a",
          state: "working",
          sinceMs: 9_000,
          forwardedAtMs: 9_000,
          questionId: null,
        },
      ]),
    );
    expect(sent).toHaveLength(1);
    expect(rows()).toMatchObject([
      {
        workspaceId: WORKSPACE,
        agentId: "chief",
        chatThreadId: "thread-a",
        toolThreadId: "t3-thread-1",
        messageId: "m1",
        afterOrder: 3,
        forwardedAtMs: 9_000,
        runId: "run-1",
      },
    ]);
    expect(lineChanges).toContain(WORKSPACE);

    // The agent posts in the chat thread: the write takes the line away.
    replies.push({ authorAgentId: "chief" });
    signalChatWrite(WORKSPACE);
    await vi.waitFor(() => expect(agentThreads.lines(WORKSPACE)).toEqual([]));
    expect(rows()).toEqual([]);
  });

  it("reminds the thread once, in its own words for that chat thread, when its work ends in silence", async () => {
    const { agentThreads, sent, tool, order } = started(setup({ chief }));
    tool.state = {
      ...tool.state,
      working: false,
      runs: [{ id: "run-1", state: "ended", requestedAtMs: 100, startedAtMs: 200, endedAtMs: 300 }],
    };

    agentThreads.watch(WORKSPACE);

    await vi.waitFor(() => expect(order).toEqual(["sent message", "read m1", "sent reminder"]));
    expect(sent[1]).toMatchObject({ threadId: "t3-thread-1", how: "line" });
    expect(sent[1]!.message).toContain('you finished without replying in chat thread "Hello"');
    expect(sent[1]!.message).toContain("chat reply th_a --workspace ws-1 --agent-id chief -");
  });

  it("takes the line away when its agent is turned off, and sends that thread no reminder", async () => {
    const { agentThreads, tool, save, order, rows } = started(setup({ chief }));
    tool.state = {
      ...tool.state,
      runs: [
        { id: "run-1", state: "working", requestedAtMs: 100, startedAtMs: 200, endedAtMs: null },
      ],
    };
    agentThreads.watch(WORKSPACE);
    await vi.waitFor(() => expect(agentThreads.lines(WORKSPACE)).toHaveLength(1));

    save({ chief: { ...chief, enabled: false } });
    agentThreads.settingsChanged();

    await vi.waitFor(() => expect(agentThreads.lines(WORKSPACE)).toEqual([]));
    expect(rows()).toEqual([]);
    expect(order).toEqual(["sent message", "read m1"]);
  });

  it("does not remind a thread whose agent stopped serving the workspace before its work ended", async () => {
    const { agentThreads, tool, save, order, rows } = started(setup({ chief }));
    tool.state = {
      ...tool.state,
      runs: [
        { id: "run-1", state: "working", requestedAtMs: 100, startedAtMs: 200, endedAtMs: null },
      ],
    };
    agentThreads.watch(WORKSPACE);
    await vi.waitFor(() => expect(agentThreads.lines(WORKSPACE)).toHaveLength(1));

    // The settings file changes under dohc, and no save tells it: the agent is off.
    save({ chief: { ...chief, enabled: false } });
    tool.state = {
      ...tool.state,
      working: false,
      runs: [{ id: "run-1", state: "ended", requestedAtMs: 100, startedAtMs: 200, endedAtMs: 300 }],
    };
    signalChatWrite(WORKSPACE);

    await vi.waitFor(() => expect(rows()).toEqual([]));
    expect(agentThreads.lines(WORKSPACE)).toEqual([]);
    expect(order).toEqual(["sent message", "read m1"]);
  });

  it("forgets a workspace's lines when the workspace leaves this computer", async () => {
    const { agentThreads, tool, rows } = started(setup({ chief }));
    tool.state = {
      ...tool.state,
      runs: [
        { id: "run-1", state: "working", requestedAtMs: 100, startedAtMs: 200, endedAtMs: null },
      ],
    };
    agentThreads.watch(WORKSPACE);
    await vi.waitFor(() => expect(agentThreads.lines(WORKSPACE)).toHaveLength(1));

    agentThreads.unwatch(WORKSPACE);

    await vi.waitFor(() => expect(rows()).toEqual([]));
    expect(agentThreads.lines(WORKSPACE)).toEqual([]);
  });

  it("forwards nothing after it stops", async () => {
    const { agentThreads, sent, arrive } = setup({ chief }, []);
    agentThreads.watch(WORKSPACE);
    agentThreads.stop();

    arrive("m1");
    await settled();

    expect(sent).toEqual([]);
  });
});

describe("forwardProblemWords", () => {
  it("says whose messages wait, why, and what happens next", () => {
    expect(
      forwardProblemWords(
        "Chief",
        new T3CodeError("not-running", "T3 Code is not running on this computer."),
      ),
    ).toBe(
      "Messages for Chief are waiting. T3 Code is not running on this computer. dohc tries again by itself.",
    );
    expect(
      forwardProblemWords(
        "Chief",
        new T3CodeError("not-allowed", "dohc is not allowed in T3 Code."),
      ),
    ).toBe(
      "Messages for Chief are waiting. dohc is not allowed in T3 Code. Open the agent in Settings to allow dohc.",
    );
    // An error dohc did not word for a person stays out of the notice.
    expect(forwardProblemWords(null, new Error("EACCES: /secret/path"))).toBe(
      "Messages for your agents are waiting. dohc could not give them to the agent's thread. dohc tries again by itself.",
    );
  });
});
