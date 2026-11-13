import { afterEach, describe, expect, it, vi } from "vitest";
import { signalChatWrite } from "../workspaces/chatWriteSignals";
import { testAgent } from "../testing/agentSettings";
import { AgentsSettings } from "../settings/userSettings";
import {
  createAgentThreads,
  forwardProblemWords,
  type AgentThreadsDependencies,
} from "./agentThreads";
import { T3CodeError } from "./t3Code";
import type { T3CodeConnection } from "./t3CodeConnection";

const WORKSPACE = "ws-1";
type Chats = AgentThreadsDependencies["chats"];
type Sent = Parameters<T3CodeConnection["forward"]>[0];

const { launch: _launch, ...unlaunched } = testAgent();
const thread = { tool: "t3-code" as const, id: "t3-thread-1" };
const chief = { ...unlaunched, name: "Chief", enabled: true, thread, workspaces: [WORKSPACE] };

function setup(agents: Record<string, unknown>, unread: string[] = ["m1"]) {
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
    getThread: async () => ({ thread: { id: "thread-a", title: "Hello" } }),
  } as unknown as Chats;
  const forward = vi.fn(async (input: Sent) => {
    order.push(`sent ${input.forwardId.startsWith("dohc-intro-") ? "intro" : "message"}`);
    sent.push(input);
  });
  const agentThreads = createAgentThreads({
    cli: "dohc",
    t3Code: { forward } as unknown as T3CodeConnection,
    chats,
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
        elsewhere: { ...chief, name: "Elsewhere", workspaces: ["ws-2"] },
        paused: { ...chief, name: "Paused", enabled: false },
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
