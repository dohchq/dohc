import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentSettings } from "../settings/userSettings";
import { createAgentThreadChanges, type AgentThreadSteps } from "./threadChanges";

const thread = (id: string) => ({ tool: "t3-code" as const, id });
const chief: AgentSettings = {
  name: "Chief",
  hue: "olive",
  changesFiles: true,
  enabled: true,
  timeoutMinutes: 30,
  thread: thread("t-1"),
  workspaces: ["ws-a"],
};

// The settings file and what dohc last read of it, which can be older.
function setup(agents: Record<string, AgentSettings> = { chief }) {
  const file = new Map(Object.entries(agents));
  let read: Agent[] | null = null;
  const order: string[] = [];
  const steps: AgentThreadSteps = {
    serve: vi.fn(async (workspaceId, agent, save) => {
      order.push(`told ${agent.thread.id} of ${workspaceId}`);
      await save();
    }),
    change: vi.fn(async (_workspaceId, agent) => {
      order.push(`introduced ${agent.thread.id} for ${(agent.workspaces ?? []).length} workspaces`);
    }),
  };
  const changes = createAgentThreadChanges({
    agents: async () => read ?? [...file].map(([id, agent]) => ({ id, ...agent })),
    changeAgent: async (agentId, change) => {
      const agent = file.get(agentId);
      if (!agent) throw new Error("This agent is no longer in Settings.");
      const next = change(agent);
      if (next !== agent) order.push("saved");
      file.set(agentId, next);
    },
    threads: steps,
  });
  return {
    changes,
    steps,
    order,
    saved: (id = "chief") => file.get(id)!,
    edit: (id: string, agent: AgentSettings) => void file.set(id, agent),
    // dohc has not read the file since: it still holds these agents.
    lastRead: (agents: Record<string, AgentSettings>) => {
      read = Object.entries(agents).map(([id, agent]) => ({ id, ...agent }));
    },
  };
}
const here = { workspaceId: "ws-b", agentId: "chief", assertCurrent: () => {} };
const moved = () => {
  throw new Error("Nothing was changed because this window changed workspaces.");
};

describe("changes to an agent's thread and workspaces", () => {
  it("turns a workspace on: tells the thread, then adds the workspace to the agent as saved", async () => {
    const { changes, order, saved, steps } = setup();

    await changes.setWorkspace({ ...here, on: true });

    expect(order).toEqual(["told t-1 of ws-b", "saved"]);
    expect(saved().workspaces).toEqual(["ws-a", "ws-b"]);
    expect(steps.serve).toHaveBeenCalledOnce();
  });

  it("turns a workspace off from the file as it is, and takes away no other", async () => {
    const { changes, saved, lastRead, steps } = setup({
      chief: { ...chief, workspaces: ["ws-a", "ws-b", "ws-c"] },
    });
    // dohc last read the agent before another window added ws-c.
    lastRead({ chief: { ...chief, workspaces: ["ws-a", "ws-b"] } });

    await changes.setWorkspace({ ...here, on: false });
    expect(saved().workspaces).toEqual(["ws-a", "ws-c"]);
    // Off again changes nothing, and the thread is told nothing either time.
    await changes.setWorkspace({ ...here, on: false });
    expect(saved().workspaces).toEqual(["ws-a", "ws-c"]);
    expect(steps.serve).not.toHaveBeenCalled();
  });

  it("sets nothing aside a second time for a workspace that is already on in the file", async () => {
    const on = { ...chief, workspaces: ["ws-a", "ws-b"] };
    const { changes, steps, order } = setup({ chief: on });

    await changes.setWorkspace({ ...here, on: true });

    expect(steps.serve).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("does not say a workspace is on when only what dohc last read says so", async () => {
    // An edit in the file took the workspace away, and dohc has not read it yet.
    const { changes, steps, saved, lastRead } = setup();
    lastRead({ chief: { ...chief, workspaces: ["ws-a", "ws-b"] } });

    await expect(changes.setWorkspace({ ...here, on: true })).rejects.toThrow(
      "The settings file changed while dohc turned this workspace on for Chief. Try again.",
    );
    expect(steps.serve).not.toHaveBeenCalled();
    expect(saved().workspaces).toEqual(["ws-a"]);
  });

  it("adds no workspace when the agent changed while its thread was told", async () => {
    const cases: Array<[AgentSettings, string]> = [
      [{ ...chief, thread: thread("t-2") }, "was connected to another thread"],
      // The messages set aside were found by the old handle.
      [{ ...chief, name: "Planner" }, "was renamed"],
    ];
    for (const [edited, words] of cases) {
      const { changes, steps, saved, edit } = setup();
      vi.mocked(steps.serve).mockImplementationOnce(async (_workspaceId, _agent, save) => {
        edit("chief", edited);
        await save();
      });
      await expect(changes.setWorkspace({ ...here, on: true })).rejects.toThrow(words);
      expect(saved().workspaces).toEqual(["ws-a"]);
    }

    // A name that keeps its handle finds the same messages, so it is no refusal.
    const { changes, steps, saved, edit } = setup();
    vi.mocked(steps.serve).mockImplementationOnce(async (_workspaceId, _agent, save) => {
      edit("chief", { ...chief, name: "Chief!" });
      await save();
    });
    await changes.setWorkspace({ ...here, on: true });
    expect(saved()).toMatchObject({ name: "Chief!", workspaces: ["ws-a", "ws-b"] });
  });

  it("saves nothing once the window shows another workspace", async () => {
    // Before its turn comes, and again before each save.
    for (const on of [true, false]) {
      const { changes, steps, saved } = setup({
        chief: { ...chief, workspaces: ["ws-a", "ws-b"] },
      });
      await expect(
        changes.setWorkspace({ ...here, workspaceId: "ws-b", on, assertCurrent: moved }),
      ).rejects.toThrow("this window changed workspaces");
      expect(steps.serve).not.toHaveBeenCalled();
      expect(saved().workspaces).toEqual(["ws-a", "ws-b"]);
    }
    const { changes, steps, saved } = setup();
    let current = true;
    const assertCurrent = () => {
      if (!current) moved();
    };
    vi.mocked(steps.serve).mockImplementationOnce(async (_workspaceId, _agent, save) => {
      current = false;
      await save();
    });
    await expect(changes.setWorkspace({ ...here, on: true, assertCurrent })).rejects.toThrow(
      "this window changed workspaces",
    );
    expect(saved().workspaces).toEqual(["ws-a"]);

    const change = setup();
    current = true;
    vi.mocked(change.steps.change).mockImplementationOnce(async () => {
      current = false;
    });
    await expect(
      change.changes.changeThread({ ...here, workspaceId: "ws-a", threadId: "t-2", assertCurrent }),
    ).rejects.toThrow("this window changed workspaces");
    expect(change.saved().thread).toEqual(thread("t-1"));
  });

  it("changes the thread: introduces the new one, then saves the agent with it", async () => {
    const { changes, order, saved } = setup({
      chief: { ...chief, workspaces: ["ws-a", "ws-b"] },
      other: { ...chief, name: "Other", thread: thread("t-9"), workspaces: ["ws-a"] },
    });
    const change = { ...here, workspaceId: "ws-a" };

    await changes.changeThread({ ...change, threadId: "t-2" });
    expect(order).toEqual(["introduced t-2 for 2 workspaces", "saved"]);
    expect(saved()).toMatchObject({ thread: thread("t-2"), workspaces: ["ws-a", "ws-b"] });

    await expect(changes.changeThread({ ...change, threadId: "t-2" })).rejects.toThrow(
      "Chief is already connected to this thread.",
    );
    await expect(changes.changeThread({ ...change, threadId: "t-9" })).rejects.toThrow(
      "Other is already connected to this thread.",
    );
    // From a workspace the agent does not forward from, there is no thread to change.
    await expect(
      changes.changeThread({ ...change, workspaceId: "ws-z", threadId: "t-3" }),
    ).rejects.toThrow("This agent has no thread for this workspace.");
    expect(saved().thread).toEqual(thread("t-2"));
  });

  it("does not save a thread over one the agent was given meanwhile", async () => {
    const { changes, steps, saved, edit } = setup();
    vi.mocked(steps.change).mockImplementationOnce(async () => {
      edit("chief", { ...chief, thread: thread("t-7") });
    });

    await expect(
      changes.changeThread({ ...here, workspaceId: "ws-a", threadId: "t-2" }),
    ).rejects.toThrow("was connected to another thread meanwhile");
    expect(saved().thread).toEqual(thread("t-7"));
  });

  it("makes one change at a time, and a change that fails does not stop the next", async () => {
    const { changes, steps, order, saved } = setup();
    let told!: () => void;
    const telling = new Promise<void>((resolve) => (told = resolve));
    vi.mocked(steps.serve).mockImplementationOnce(async (workspaceId, agent, save) => {
      order.push(`telling ${agent.thread.id} of ${workspaceId}`);
      await telling;
      await save();
    });

    // A workspace is turned on, and before the thread has answered the person
    // changes the thread from another window, then turns the workspace off.
    const on = changes.setWorkspace({ ...here, on: true });
    const change = changes.changeThread({ ...here, workspaceId: "ws-a", threadId: "t-2" });
    const failing = changes.changeThread({ ...here, workspaceId: "ws-a", threadId: "t-2" });
    const off = changes.setWorkspace({ ...here, on: false });
    await vi.waitFor(() => expect(order).toEqual(["telling t-1 of ws-b"]));
    // Nothing else starts while the thread is told.
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["telling t-1 of ws-b"]);
    told();
    await on;
    await change;
    await expect(failing).rejects.toThrow("already connected");
    await off;

    // The new thread is introduced for both workspaces, because the first change had landed.
    expect(order).toEqual([
      "telling t-1 of ws-b",
      "saved",
      "introduced t-2 for 2 workspaces",
      "saved",
      "saved",
    ]);
    expect(saved()).toMatchObject({ thread: thread("t-2"), workspaces: ["ws-a"] });
  });
});
