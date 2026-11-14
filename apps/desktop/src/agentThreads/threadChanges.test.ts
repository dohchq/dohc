import { describe, expect, it, vi } from "vitest";
import type { AgentSettings } from "../settings/userSettings";
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

// The settings file, and the settings in effect, which follow the file only
// in a turn of the settings queue: a save, or a reload after an edit in the
// file. `changeAgent` is such a turn.
function setup(agents: Record<string, AgentSettings> = { chief }) {
  const file = new Map(Object.entries(agents));
  let inEffect = new Map(file);
  const order: string[] = [];
  const steps: AgentThreadSteps = {
    setAside: vi.fn(async (workspaceId) => void order.push(`set aside ${workspaceId}`)),
    tellOfWorkspace: vi.fn(async (workspaceId, agent) => {
      order.push(`told ${agent.thread.id} of ${workspaceId}`);
    }),
    change: vi.fn(async (_workspaceId, agent) => {
      order.push(`introduced ${agent.thread.id} for ${(agent.workspaces ?? []).length} workspaces`);
    }),
  };
  const changes = createAgentThreadChanges({
    agents: async () => [...inEffect].map(([id, agent]) => ({ id, ...agent })),
    changeAgent: async (agentId, change, before) => {
      if (before) {
        const agent = inEffect.get(agentId);
        if (!agent) throw new Error("This agent is no longer in Settings.");
        await before(agent);
      }
      const agent = file.get(agentId);
      if (!agent) throw new Error("This agent is no longer in Settings.");
      const next = change(agent);
      if (next !== agent) order.push("saved");
      file.set(agentId, next);
      inEffect = new Map(file);
    },
    threads: steps,
  });
  return {
    changes,
    steps,
    order,
    saved: (id = "chief") => file.get(id)!,
    /** An edit in the file, which dohc has not read yet. */
    edit: (id: string, agent: AgentSettings) => void file.set(id, agent),
    /** dohc reads the file after an edit, and what it holds comes into effect. */
    reload: () => {
      inEffect = new Map(file);
    },
  };
}
const here = { workspaceId: "ws-b", agentId: "chief", assertCurrent: () => {} };
const moved = () => {
  throw new Error("Nothing was changed because this window changed workspaces.");
};
const both = { ...chief, workspaces: ["ws-a", "ws-b"] };

describe("changes to an agent's thread and workspaces", () => {
  it("turns a workspace on: sets aside, tells the thread, sets aside again, then saves the agent with it", async () => {
    const { changes, order, saved } = setup();

    await changes.setWorkspace({ ...here, on: true });

    expect(order).toEqual(["set aside ws-b", "told t-1 of ws-b", "set aside ws-b", "saved"]);
    expect(saved().workspaces).toEqual(["ws-a", "ws-b"]);
  });

  it("sets nothing aside once the workspace is on by an edit in the file", async () => {
    // The person adds the workspace in the file while the thread is told, and
    // dohc reads it. A message written from then on is the agent's to get.
    const { changes, steps, order, saved, edit, reload } = setup();
    vi.mocked(steps.tellOfWorkspace).mockImplementationOnce(async () => {
      order.push("told");
      edit("chief", both);
      reload();
    });

    await changes.setWorkspace({ ...here, on: true });

    expect(order).toEqual(["set aside ws-b", "told"]);
    expect(saved().workspaces).toEqual(["ws-a", "ws-b"]);
  });

  it("turns a workspace off from the file as it is, and takes away no other", async () => {
    const { changes, saved, edit, steps } = setup({ chief: both });
    // Another window added ws-c, and this one has not heard yet.
    edit("chief", { ...chief, workspaces: ["ws-a", "ws-b", "ws-c"] });

    await changes.setWorkspace({ ...here, on: false });
    expect(saved().workspaces).toEqual(["ws-a", "ws-c"]);
    // Off again changes nothing, and nothing is set aside or told either time.
    await changes.setWorkspace({ ...here, on: false });
    expect(saved().workspaces).toEqual(["ws-a", "ws-c"]);
    expect(steps.setAside).not.toHaveBeenCalled();
    expect(steps.tellOfWorkspace).not.toHaveBeenCalled();
  });

  it("does nothing for a workspace that is already on", async () => {
    const { changes, order } = setup({ chief: both });

    await changes.setWorkspace({ ...here, on: true });

    expect(order).toEqual([]);
  });

  it("does not say a workspace is on when only what dohc last read says so", async () => {
    // An edit in the file took the workspace away, and dohc has not read it yet.
    const { changes, order, saved, edit } = setup({ chief: both });
    edit("chief", chief);

    await expect(changes.setWorkspace({ ...here, on: true })).rejects.toThrow(
      "The settings file changed while dohc turned this workspace on for Chief. Try again.",
    );
    expect(order).toEqual([]);
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
      vi.mocked(steps.tellOfWorkspace).mockImplementationOnce(async () => edit("chief", edited));
      await expect(changes.setWorkspace({ ...here, on: true })).rejects.toThrow(words);
      expect(saved().workspaces).toEqual(["ws-a"]);
    }

    // A name with the same handle finds the same messages, so it is no refusal.
    for (const name of ["Chief!", "CHIEF"]) {
      const { changes, steps, saved, edit } = setup();
      vi.mocked(steps.tellOfWorkspace).mockImplementationOnce(async () =>
        edit("chief", { ...chief, name }),
      );
      await changes.setWorkspace({ ...here, on: true });
      expect(saved()).toMatchObject({ name, workspaces: ["ws-a", "ws-b"] });
    }
  });

  it("saves and sets aside nothing once the window shows another workspace", async () => {
    // Before its turn comes.
    for (const on of [true, false]) {
      const { changes, order, saved } = setup({ chief: on ? chief : both });
      await expect(changes.setWorkspace({ ...here, on, assertCurrent: moved })).rejects.toThrow(
        "this window changed workspaces",
      );
      expect(order).toEqual([]);
      expect(saved().workspaces).toEqual(on ? ["ws-a"] : ["ws-a", "ws-b"]);
    }
    // While the thread is told: nothing more is set aside, and nothing is saved.
    const { changes, steps, order, saved } = setup();
    let current = true;
    const assertCurrent = () => {
      if (!current) moved();
    };
    vi.mocked(steps.tellOfWorkspace).mockImplementationOnce(async () => {
      order.push("told");
      current = false;
    });
    await expect(changes.setWorkspace({ ...here, on: true, assertCurrent })).rejects.toThrow(
      "this window changed workspaces",
    );
    expect(order).toEqual(["set aside ws-b", "told"]);
    expect(saved().workspaces).toEqual(["ws-a"]);

    // While the new thread is introduced.
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
      chief: both,
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
    vi.mocked(steps.tellOfWorkspace).mockImplementationOnce(async (workspaceId, agent) => {
      order.push(`telling ${agent.thread.id} of ${workspaceId}`);
      await telling;
    });

    // A workspace is turned on, and before the thread has answered the person
    // changes the thread from another window, then turns the workspace off.
    const on = changes.setWorkspace({ ...here, on: true });
    const change = changes.changeThread({ ...here, workspaceId: "ws-a", threadId: "t-2" });
    const failing = changes.changeThread({ ...here, workspaceId: "ws-a", threadId: "t-2" });
    const off = changes.setWorkspace({ ...here, on: false });
    const begun = ["set aside ws-b", "telling t-1 of ws-b"];
    await vi.waitFor(() => expect(order).toEqual(begun));
    // Nothing else starts while the thread is told.
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(begun);
    told();
    await on;
    await change;
    await expect(failing).rejects.toThrow("already connected");
    await off;

    // The new thread is introduced for both workspaces, because the first change had landed.
    expect(order).toEqual([
      ...begun,
      "set aside ws-b",
      "saved",
      "introduced t-2 for 2 workspaces",
      "saved",
      "saved",
    ]);
    expect(saved()).toMatchObject({ thread: thread("t-2"), workspaces: ["ws-a"] });
  });
});
