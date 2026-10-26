import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ActiveAgentRun } from "./activeAgentRun";
import {
  agentRunsFileName,
  AgentIntegrationState,
  createAgentIntegration as createPhysicalAgentIntegration,
} from "./AgentIntegration";
import { createInMemoryAgentIntegration as createAgentIntegration } from "./AgentIntegration.testSupport";
import { createTestScratch } from "../workspaces/testTemp";

const historyRead = vi.hoisted(() => ({ failure: null as Error | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (historyRead.failure && String(args[0]).endsWith(agentRunsFileName("install-local"))) {
        return Promise.reject(historyRead.failure);
      }
      return actual.readFile(...args);
    },
  };
});

// Holds the first attribution clear (end A's) until the test releases it.
// "queued" settles capture calls in order like workspaceEngineCapture's
// enqueueResult; "independent" lets later calls settle around the held one.
function heldClearRace(root: string, order: "queued" | "independent") {
  const state = new AgentIntegrationState();
  const ids = ["run-a", "run-b"];
  const clearHeld = Promise.withResolvers<void>();
  const releaseClear = Promise.withResolvers<void>();
  const laterCaptureCalled = Promise.withResolvers<void>();
  let holding = false;
  let queue = Promise.resolve();
  let slot = null as ActiveAgentRun | null;
  function capture(run: ActiveAgentRun | null): Promise<void> {
    const hold = run === null && !holding;
    if (hold) holding = true;
    else if (holding) laterCaptureCalled.resolve();
    const task = async () => {
      if (!hold) return;
      clearHeld.resolve();
      await releaseClear.promise;
    };
    if (order === "independent") return task();
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  }
  async function clear(runId: string) {
    if (slot?.agentRunId !== runId) return;
    await capture(null);
    if (slot?.agentRunId === runId) slot = null;
  }
  const integration = createPhysicalAgentIntegration({
    localPersonId: () => "person-local",
    installId: () => "install-local",
    workspaceIds: () => ["ws"],
    createId: () => ids.shift() ?? "run-extra",
    acquire: () => ({
      attachmentId: Symbol.for("test-held-clear-attachment"),
      workspaceId: "ws",
      rootPath: root,
      state,
      assertCurrent: () => undefined,
      setAgentRun: async (run) => {
        const owned = state.activeRun?.id;
        if (owned) await clear(owned);
        if (!run) return;
        if (slot) throw new Error("Another agent run is already active in this workspace.");
        slot = run;
        await capture(run);
      },
      release: () => undefined,
    }),
  });
  return {
    integration,
    state,
    slot: () => slot,
    clearHeld: clearHeld.promise,
    laterCaptureCalled: laterCaptureCalled.promise,
    releaseClear: () => releaseClear.resolve(),
  };
}

// This installation's run history in a workspace.
const runsFolder = (root: string) => join(root, ".dohc", "agent-runs");
const runsPath = (root: string) => join(runsFolder(root), agentRunsFileName("install-local"));

async function withWorkspace<T>(
  fn: (input: { root: string; setSlot: (r: ActiveAgentRun | null) => void; slots: Array<ActiveAgentRun | null> }) => Promise<T>,
): Promise<T> {
  const root = await createTestScratch("dohc-agent-test-");
  const slots: Array<ActiveAgentRun | null> = [];
  try {
    return await fn({ root, setSlot: (r) => slots.push(r), slots });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("AgentIntegration", () => {
  it("persists a run record, sets then clears the watcher slot", async () => {
    await withWorkspace(async ({ root, setSlot, slots }) => {
      const integration = createAgentIntegration({
        rootFor: () => root,
        setAgentRun: (_id, run) => setSlot(run),
      });

      const run = await integration.startAgentRun("ws");
      expect(run).toMatchObject({ status: "running", agentId: "dohc-mcp", onBehalfOf: "person-local" });
      // The watcher slot now carries this run's attribution.
      expect(slots.at(-1)).toEqual({ agentId: "dohc-mcp", onBehalfOf: "person-local", agentRunId: run.id, depth: 0 });

      // The record is durable and inspectable on disk.
      const persisted = JSON.parse(await readFile(runsPath(root), "utf8"));
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ id: run.id, status: "running" });

      await integration.endAgentRun("ws", run.id);
      // Slot cleared back to local user.
      expect(slots.at(-1)).toBeNull();
      const after = JSON.parse(await readFile(runsPath(root), "utf8"));
      expect(after[0]).toMatchObject({ status: "complete" });
      expect(after[0].endedAt).toBeTypeOf("number");
    });
  });

  it("stamps the run record id and startedAt from injected createId/now seams", async () => {
    await withWorkspace(async ({ root, setSlot }) => {
      const integration = createAgentIntegration({
        rootFor: () => root,
        setAgentRun: (_id, run) => setSlot(run),
        now: () => 1_700_000_000_000,
        createId: () => "run_fixed_0001",
      });
      const run = await integration.startAgentRun("ws");
      expect(run).toMatchObject({ id: "run_fixed_0001", startedAt: 1_700_000_000_000 });
      const persisted = JSON.parse(await readFile(runsPath(root), "utf8"));
      expect(persisted[0]).toMatchObject({ id: "run_fixed_0001", startedAt: 1_700_000_000_000 });
    });
  });

  it("reports the active run, then the completed run, in status", async () => {
    await withWorkspace(async ({ root, setSlot }) => {
      const integration = createAgentIntegration({
        rootFor: () => root,
        setAgentRun: (_id, run) => setSlot(run),
      });

      const run = await integration.startAgentRun("ws");
      expect(await integration.getAgentRunStatus("ws")).toMatchObject({
        activeRun: { id: run.id },
      });

      await integration.endAgentRun("ws", run.id, "complete");
      expect(await integration.getAgentRunStatus("ws")).toMatchObject({
        activeRun: null,
        lastRun: { id: run.id, status: "complete" },
      });
    });
  });

  it("ending a non-active run never clears a newer active run's slot", async () => {
    await withWorkspace(async ({ root, setSlot, slots }) => {
      const integration = createAgentIntegration({
        rootFor: () => root,
        setAgentRun: (_id, run) => setSlot(run),
      });
      const a = await integration.startAgentRun("ws");
      const b = await integration.startAgentRun("ws");
      // End the older run A: B still owns the workspace, so its attribution
      // slot must stay set (not silently cleared to local).
      await integration.endAgentRun("ws", a.id);
      expect(slots.at(-1)).toEqual({ agentId: "dohc-mcp", onBehalfOf: "person-local", agentRunId: b.id, depth: 0 });
      expect(await integration.getAgentRunStatus("ws")).toMatchObject({
        activeRun: { id: b.id },
      });
    });
  });

  it.each([
    ["invalid JSON", "[{"],
    ["null", "null"],
    ["object", "{}"],
    ["invalid record", '[{"id":"bad-start","startedAt":"yesterday","status":"complete"}]'],
    ["mixed valid and invalid records", JSON.stringify([
      { id: "run-valid", startedAt: 1, endedAt: 2, agentId: "dohc-mcp", onBehalfOf: "person-local", status: "failed", incarnation: "process-1" },
      { id: "bad-status", startedAt: 3, agentId: "dohc-mcp", onBehalfOf: "person-local", status: "done", incarnation: "process-1" },
    ])],
  ])("preserves history and keeps an active run stoppable when history contains %s", async (_label, source) => {
    await withWorkspace(async ({ root, setSlot }) => {
      const setAgentRun = vi.fn((_id: string, run: ActiveAgentRun | null) => setSlot(run));
      const onRunEnded = vi.fn();
      const integration = createAgentIntegration({
        rootFor: () => root,
        setAgentRun,
        onRunEnded,
      });
      const run = await integration.startAgentRun("ws");
      const path = runsPath(root);
      await writeFile(path, source);
      const bytes = await readFile(path);
      setAgentRun.mockClear();
      await expect(integration.startAgentRun("ws")).rejects.toThrow(/agent run history/);
      await expect(integration.getAgentRunStatus("ws")).resolves.toMatchObject({
        activeRun: { id: run.id, status: "running" },
      });
      expect(setAgentRun).not.toHaveBeenCalled();
      await expect(integration.endAgentRun("ws", run.id)).rejects.toThrow(/agent run history/);
      await expect(integration.getAgentRunStatus("ws")).resolves.toEqual({
        activeRun: null,
        lastRun: null,
      });
      expect(await readFile(path)).toEqual(bytes);
      expect(await readdir(runsFolder(root))).toEqual([agentRunsFileName("install-local")]);
      expect(setAgentRun).toHaveBeenCalledExactlyOnceWith("ws", null);
      expect(onRunEnded).not.toHaveBeenCalled();
      await writeFile(path, JSON.stringify([run]));
      await expect(integration.getAgentRunStatus("ws")).resolves.toMatchObject({
        activeRun: null,
      });
      setAgentRun.mockClear();
      await integration.endAgentRun("ws", run.id);
      // The run's attribution was already cleared; only its history is recorded.
      expect(setAgentRun).not.toHaveBeenCalled();
      expect(onRunEnded).toHaveBeenCalledOnce();
    });
  });

  it("preserves readable bytes after a transient history read failure and retries", async () => {
    await withWorkspace(async ({ root, setSlot }) => {
      const setAgentRun = vi.fn((_id: string, run: ActiveAgentRun | null) => setSlot(run));
      const integration = createAgentIntegration({ rootFor: () => root, setAgentRun });
      const run = await integration.startAgentRun("ws");
      const path = runsPath(root);
      const bytes = await readFile(path);
      setAgentRun.mockClear();
      historyRead.failure = Object.assign(new Error("temporarily unreadable"), { code: "EACCES" });
      try {
        await expect(integration.startAgentRun("ws")).rejects.toThrow(/could not read/);
        await expect(integration.getAgentRunStatus("ws")).resolves.toMatchObject({
          activeRun: { id: run.id },
        });
        await expect(integration.endAgentRun("ws", run.id)).rejects.toThrow(/could not read/);
        await expect(integration.getAgentRunStatus("ws")).resolves.toEqual({
          activeRun: null,
          lastRun: null,
        });
      } finally {
        historyRead.failure = null;
      }
      expect(await readFile(path)).toEqual(bytes);
      expect(setAgentRun).toHaveBeenCalledExactlyOnceWith("ws", null);
      await expect(integration.getAgentRunStatus("ws")).resolves.toMatchObject({
        activeRun: null,
      });
      await integration.endAgentRun("ws", run.id);
      const next = await integration.startAgentRun("ws");
      const runs = JSON.parse(await readFile(path, "utf8"));
      expect(runs).toHaveLength(2);
      expect(runs[0]).toMatchObject({ id: run.id, status: "complete" });
      expect(runs[1]).toMatchObject({ id: next.id, status: "running" });
    });
  });

  it("never stops a newer active run when an older run's history update fails", async () => {
    await withWorkspace(async ({ root, setSlot }) => {
      const setAgentRun = vi.fn((_id: string, run: ActiveAgentRun | null) => setSlot(run));
      const integration = createAgentIntegration({
        rootFor: () => root,
        setAgentRun,
      });
      const older = await integration.startAgentRun("ws");
      const newer = await integration.startAgentRun("ws");
      const path = runsPath(root);
      await writeFile(path, "corrupt history\n");
      setAgentRun.mockClear();
      await expect(integration.endAgentRun("ws", older.id)).rejects.toThrow(/invalid JSON/);
      expect(setAgentRun).not.toHaveBeenCalled();
      await expect(integration.getAgentRunStatus("ws")).resolves.toMatchObject({
        activeRun: { id: newer.id },
      });
      await expect(integration.endAgentRun("ws", newer.id)).rejects.toThrow(/invalid JSON/);
      expect(setAgentRun).toHaveBeenCalledExactlyOnceWith("ws", null);
      await expect(integration.getAgentRunStatus("ws")).resolves.toMatchObject({
        activeRun: null,
      });
      expect(await readFile(path, "utf8")).toBe("corrupt history\n");
    });
  });

  it("keeps a run visible and stoppable when clearing its attribution fails over unreadable history", async () => {
    await withWorkspace(async ({ root, setSlot }) => {
      const clearFailure = new Error("capture refused the clear");
      let refuseClear = false;
      const integration = createAgentIntegration({
        rootFor: () => root,
        setAgentRun: (_id, run) => {
          if (!run && refuseClear) throw clearFailure;
          setSlot(run);
        },
      });
      const run = await integration.startAgentRun("ws");
      const path = runsPath(root);
      await writeFile(path, "corrupt history\n");
      refuseClear = true;
      await expect(integration.endAgentRun("ws", run.id)).rejects.toBe(clearFailure);
      await expect(integration.getAgentRunStatus("ws")).resolves.toMatchObject({
        activeRun: { id: run.id },
      });
      refuseClear = false;
      await expect(integration.endAgentRun("ws", run.id)).rejects.toThrow(/invalid JSON/);
      await expect(integration.getAgentRunStatus("ws")).resolves.toMatchObject({
        activeRun: null,
      });
      expect(await readFile(path, "utf8")).toBe("corrupt history\n");
    });
  });

  it("ending an older run while a newer run installs keeps the newer run's state and attribution", async () => {
    await withWorkspace(async ({ root }) => {
      const state = new AgentIntegrationState();
      const ids = ["run-a", "run-b"];
      const installed = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      // Mirrors workspaceActivity: a claim installs its slot before capture
      // settles, and a clear only removes the run it names.
      let slot = null as ActiveAgentRun | null;
      async function capture(run: ActiveAgentRun | null) {
        if (run?.agentRunId === "run-b") {
          installed.resolve();
          await held.promise;
        }
      }
      async function clear(runId: string) {
        if (slot?.agentRunId !== runId) return;
        await capture(null);
        if (slot?.agentRunId === runId) slot = null;
      }
      const integration = createPhysicalAgentIntegration({
        localPersonId: () => "person-local",
        installId: () => "install-local",
        workspaceIds: () => ["ws"],
        createId: () => ids.shift() ?? "run-extra",
        // Mirrors main.ts's adapter: a start clears the previous owned run,
        // and a stop clears only the run this state owns.
        acquire: () => ({
          attachmentId: Symbol.for("test-race-attachment"),
          workspaceId: "ws",
          rootPath: root,
          state,
          assertCurrent: () => undefined,
          setAgentRun: async (run) => {
            const owned = state.activeRun?.id;
            if (owned) await clear(owned);
            if (!run) return;
            if (slot) throw new Error("Another agent run is already active in this workspace.");
            slot = run;
            await capture(run);
          },
          release: () => undefined,
        }),
      });

      const a = await integration.startAgentRun("ws");
      const starting = integration.startAgentRun("ws");
      await installed.promise;
      expect(state.activeRun?.id).toBe(a.id);
      const ending = integration.endAgentRun("ws", a.id);
      held.resolve();
      const [b] = await Promise.all([starting, ending]);

      expect(b.id).toBe("run-b");
      expect(state.activeRun?.id).toBe(b.id);
      expect(slot?.agentRunId).toBe(b.id);
      const runs = JSON.parse(await readFile(runsPath(root), "utf8"));
      expect(runs).toMatchObject([
        { id: a.id, status: "complete" },
        { id: b.id, status: "running" },
      ]);
    });
  });

  it("a newer run waits behind an older run's queued attribution clear", async () => {
    await withWorkspace(async ({ root }) => {
      const race = heldClearRace(root, "queued");
      const a = await race.integration.startAgentRun("ws");
      const ending = race.integration.endAgentRun("ws", a.id);
      await race.clearHeld;
      const starting = race.integration.startAgentRun("ws");
      await race.laterCaptureCalled;
      // B's own clear of A queues behind the held one, so B cannot install yet.
      expect(race.state.activeRun?.id).toBe(a.id);
      expect(race.slot()?.agentRunId).toBe(a.id);
      race.releaseClear();
      const [b] = await Promise.all([starting, ending]);

      expect(race.state.activeRun?.id).toBe(b.id);
      expect(race.slot()?.agentRunId).toBe(b.id);
    });
  });

  it("an older run's late attribution clear never drops a newer run that installed around it", async () => {
    await withWorkspace(async ({ root }) => {
      const race = heldClearRace(root, "independent");
      const a = await race.integration.startAgentRun("ws");
      const ending = race.integration.endAgentRun("ws", a.id);
      await race.clearHeld;
      const b = await race.integration.startAgentRun("ws");
      expect(race.state.activeRun?.id).toBe(b.id);
      expect(race.slot()?.agentRunId).toBe(b.id);
      race.releaseClear();
      await ending;

      expect(race.state.activeRun?.id).toBe(b.id);
      expect(race.slot()?.agentRunId).toBe(b.id);
      const runs = JSON.parse(await readFile(runsPath(root), "utf8"));
      expect(runs).toMatchObject([
        { id: a.id, status: "complete" },
        { id: b.id, status: "running" },
      ]);
    });
  });

  it("preserves the start refusal when recording its failed status cannot read history", async () => {
    await withWorkspace(async ({ root }) => {
      const primary = new Error("slot occupied");
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const path = runsPath(root);
        const integration = createAgentIntegration({
          rootFor: () => root,
          setAgentRun: async () => {
            await writeFile(path, "external corrupt history\n");
            throw primary;
          },
        });
        await expect(integration.startAgentRun("ws")).rejects.toBe(primary);
        expect(await readFile(path, "utf8")).toBe("external corrupt history\n");
        expect(logged).toHaveBeenCalledWith(
          "[desktop] Could not record the failed agent run",
          expect.objectContaining({ message: expect.stringContaining("invalid JSON") }),
        );
      } finally {
        logged.mockRestore();
      }
    });
  });

  it("does not start a run when an inactive workspace's history is unreadable", async () => {
    await withWorkspace(async ({ root, setSlot, slots }) => {
      await mkdir(runsFolder(root), { recursive: true });
      const path = runsPath(root);
      await writeFile(path, "not JSON\n");
      const integration = createAgentIntegration({
        rootFor: () => root,
        setAgentRun: (_id, run) => setSlot(run),
      });
      await expect(integration.startAgentRun("ws")).rejects.toThrow(/invalid JSON/);
      await expect(integration.getAgentRunStatus("ws")).resolves.toEqual({
        activeRun: null,
        lastRun: null,
      });
      expect(slots).toEqual([]);
      expect(await readFile(path, "utf8")).toBe("not JSON\n");
    });
  });

  // endAgentRun is the single funnel every terminal run path goes
  // through (driver turn-completed, panel Stop, the endAgentRun IPC), so the
  // try-in-version review card listens here, not on each caller.
  it("notifies onRunEnded when a known run ends, and never for an unknown run id", async () => {
    await withWorkspace(async ({ root, setSlot }) => {
      const ended: Array<{ workspaceId: string; runId: string; status: string }> = [];
      const integration = createAgentIntegration({
        rootFor: () => root,
        setAgentRun: (_id, run) => setSlot(run),
        onRunEnded: (input) => ended.push(input),
      });
      const run = await integration.startAgentRun("ws");
      await integration.endAgentRun("ws", "no-such-run", "complete");
      expect(ended).toEqual([]);
      await integration.endAgentRun("ws", run.id, "failed");
      expect(ended).toEqual([
        {
          attachmentId: Symbol.for("test-workspace-attachment:ws"),
          workspaceId: "ws",
          runId: run.id,
          status: "failed",
        },
      ]);
    });
  });

  it("throws for an unknown workspace and never writes a record", async () => {
    const integration = createAgentIntegration({
      rootFor: () => null,
      setAgentRun: () => {},
    });
    await expect(integration.startAgentRun("nope")).rejects.toThrow("This workspace is not open. Open it again.");
  });

  it("records a failed start when the workspace attribution slot is occupied", async () => {
    await withWorkspace(async ({ root }) => {
      const integration = createAgentIntegration({
        rootFor: () => root,
        setAgentRun: (_workspaceId, run) => {
          if (run) throw new Error("slot occupied");
        },
      });
      await expect(integration.startAgentRun("ws")).rejects.toThrow(
        "slot occupied",
      );
      await expect(integration.getAgentRunStatus("ws")).resolves.toMatchObject({
        activeRun: null,
        lastRun: { status: "failed" },
      });
    });
  });

  it("does not install an old run after the attachment changes mid-start", async () => {
    await withWorkspace(async ({ root }) => {
      const oldState = new AgentIntegrationState();
      const successorState = new AgentIntegrationState();
      let currentState = oldState;
      const setStarted = Promise.withResolvers<void>();
      const allowSettle = Promise.withResolvers<void>();
      const integration = createPhysicalAgentIntegration({
        localPersonId: () => "person-local",
        installId: () => "install-local",
        workspaceIds: () => ["ws"],
        acquire: () => {
          const heldState = currentState;
          return {
            attachmentId: Symbol.for("test-old-attachment"),
            workspaceId: "ws",
            rootPath: root,
            state: heldState,
            assertCurrent: () => {
              if (currentState !== heldState) {
                throw new Error("This workspace was closed. Open it again.");
              }
            },
            setAgentRun: async () => {
              setStarted.resolve();
              await allowSettle.promise;
            },
            release: () => undefined,
          };
        },
      });

      const starting = integration.startAgentRun("ws");
      await setStarted.promise;
      currentState = successorState;
      allowSettle.resolve();

      await expect(starting).rejects.toThrow("This workspace was closed. Open it again.");
      expect(oldState.activeRun).toBeNull();
      expect(successorState.activeRun).toBeNull();
    });
  });

  it("marks a persisted run failed when its attachment retires before attribution", async () => {
    await withWorkspace(async ({ root }) => {
      const state = new AgentIntegrationState();
      const setAgentRun = vi.fn();
      const release = vi.fn();
      const integration = createPhysicalAgentIntegration({
        localPersonId: () => "person-local",
        installId: () => "install-local",
        workspaceIds: () => ["ws"],
        acquire: () => ({
          attachmentId: Symbol.for("test-retired-after-persist"),
          workspaceId: "ws",
          rootPath: root,
          state,
          assertCurrent: () => {
            throw new Error("This workspace was closed. Open it again.");
          },
          setAgentRun,
          release,
        }),
      });

      await expect(integration.startAgentRun("ws")).rejects.toThrow(
        "This workspace was closed. Open it again.",
      );
      expect(setAgentRun).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      const runs = JSON.parse(
        await readFile(runsPath(root), "utf8"),
      ) as Array<{ status: string; endedAt?: number }>;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "failed" });
      expect(runs[0]?.endedAt).toEqual(expect.any(Number));
    });
  });

  it("cleans later workspaces when an earlier shutdown cleanup fails", async () => {
    const firstFailure = new Error("first workspace slot refused cleanup");
    const firstState = new AgentIntegrationState();
    const secondState = new AgentIntegrationState();
    firstState.activeRun = {
      id: "run-first",
      startedAt: 1,
      agentId: "dohc-mcp",
      onBehalfOf: "person-local",
      status: "running",
      incarnation: "process-1",
    };
    secondState.activeRun = {
      id: "run-second",
      startedAt: 2,
      agentId: "dohc-mcp",
      onBehalfOf: "person-local",
      status: "running",
      incarnation: "process-1",
    };
    const releases: string[] = [];
    const clearedSlots: string[] = [];
    const integration = createPhysicalAgentIntegration({
      localPersonId: () => "person-local",
      installId: () => "install-local",
      workspaceIds: () => ["workspace-first", "workspace-second"],
      acquire: (workspaceId) => ({
        attachmentId: Symbol.for(`test-workspace-attachment:${workspaceId}`),
        workspaceId,
        rootPath: "/unused",
        state:
          workspaceId === "workspace-first" ? firstState : secondState,
        assertCurrent: () => undefined,
        setAgentRun: async () => {
          clearedSlots.push(workspaceId);
          if (workspaceId === "workspace-first") throw firstFailure;
        },
        release: () => releases.push(workspaceId),
      }),
    });

    await expect(integration.stopAll()).rejects.toBe(firstFailure);

    expect(clearedSlots).toEqual(["workspace-first", "workspace-second"]);
    expect(releases).toEqual(["workspace-first", "workspace-second"]);
    expect(firstState.activeRun?.id).toBe("run-first");
    expect(secondState.activeRun).toBeNull();
  });

  it("marks a run its process left running as interrupted when the next process starts", async () => {
    await withWorkspace(async ({ root, setSlot }) => {
      const before = createAgentIntegration({ rootFor: () => root, setAgentRun: (_id, run) => setSlot(run) });
      const run = await before.startAgentRun("ws");
      // The process dies here: nothing ends the run.
      const after = createAgentIntegration({ rootFor: () => root, setAgentRun: (_id, next) => setSlot(next), now: () => 99 });
      await expect(after.getAgentRunStatus("ws")).resolves.toEqual({
        activeRun: null,
        lastRun: expect.objectContaining({ id: run.id, status: "interrupted", endedAt: 99 }),
      });
      const persisted = JSON.parse(await readFile(runsPath(root), "utf8"));
      expect(persisted).toMatchObject([{ id: run.id, status: "interrupted", endedAt: 99 }]);
    });
  });

  it("sweeps another process's running runs, and keeps this process's and finished runs", async () => {
    await withWorkspace(async ({ root, setSlot }) => {
      await mkdir(runsFolder(root), { recursive: true });
      const path = runsPath(root);
      const run = (id: string, fields: Record<string, unknown> = {}) => ({
        id, startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "person-local", status: "running", ...fields,
      });
      const runs = [
        run("earlier-process", { incarnation: "process-1" }),
        run("this-process", { incarnation: "process-2" }),
        run("finished", { status: "complete", endedAt: 2, incarnation: "process-1" }),
        run("failed", { status: "failed", endedAt: 3, incarnation: "process-1" }),
      ];
      await writeFile(path, JSON.stringify(runs));
      const integration = createAgentIntegration({
        rootFor: () => root,
        setAgentRun: (_id, next) => setSlot(next),
        incarnation: "process-2",
        now: () => 50,
      });
      await integration.getAgentRunStatus("ws");
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual([
        { ...runs[0], status: "interrupted", endedAt: 50 },
        runs[1],
        runs[2],
        runs[3],
      ]);
      // Each workspace sweeps once per process.
      await writeFile(path, JSON.stringify([run("written-later", { incarnation: "process-1" })]));
      await integration.getAgentRunStatus("ws");
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject([{ id: "written-later", status: "running" }]);
    });
  });

  it("writes nothing when no run needs settling", async () => {
    await withWorkspace(async ({ root, setSlot }) => {
      await mkdir(runsFolder(root), { recursive: true });
      const path = runsPath(root);
      const source = JSON.stringify([
        { id: "done", startedAt: 1, endedAt: 2, agentId: "dohc-mcp", onBehalfOf: "person-local", status: "complete", incarnation: "process-1" },
      ]);
      await writeFile(path, source);
      const integration = createAgentIntegration({ rootFor: () => root, setAgentRun: (_id, run) => setSlot(run) });
      await integration.getAgentRunStatus("ws");
      expect(await readFile(path, "utf8")).toBe(source);
    });
  });

  it("leaves unreadable history unwritten, falls back for status, and sweeps once it is repaired", async () => {
    await withWorkspace(async ({ root, setSlot }) => {
      await mkdir(runsFolder(root), { recursive: true });
      const path = runsPath(root);
      await writeFile(path, "not JSON\n");
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const integration = createAgentIntegration({
          rootFor: () => root,
          setAgentRun: (_id, run) => setSlot(run),
          now: () => 7,
        });
        await expect(integration.getAgentRunStatus("ws")).resolves.toEqual({ activeRun: null, lastRun: null });
        expect(await readFile(path, "utf8")).toBe("not JSON\n");
        expect(await readdir(runsFolder(root))).toEqual([agentRunsFileName("install-local")]);
        await writeFile(path, JSON.stringify([
          { id: "left-open", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "person-local", status: "running", incarnation: "process-1" },
        ]));
        await expect(integration.getAgentRunStatus("ws")).resolves.toMatchObject({
          lastRun: { id: "left-open", status: "interrupted", endedAt: 7 },
        });
      } finally {
        logged.mockRestore();
      }
    });
  });

  // Same boundary as workspaceUiState: a malicious attached workspace can ship
  // `.dohc` or `.dohc/agent-runs` as a SYMLINK to a directory outside the
  // workspace. The run-log writer must refuse instead of planting a run file
  // at the target.
  it.each([
    [".dohc", "dohc could not open this workspace's .dohc folder. A link is at .dohc, which must be a real folder. Remove or rename that link. Then retry."],
    [".dohc/agent-runs", "dohc could not open this workspace's agent run history. A link is at .dohc/agent-runs, which must be a real folder. Remove or rename that link. Then retry."],
  ])("refuses to write agent runs through a symlinked %s and never lands files outside", async (link, refusal) => {
    await withWorkspace(async ({ root, setSlot }) => {
      const outside = await createTestScratch("dohc-agent-escape-");
      try {
        if (link !== ".dohc") await mkdir(join(root, ".dohc"));
        await symlink(outside, join(root, link), "dir");
        const integration = createAgentIntegration({
          rootFor: () => root,
          setAgentRun: (_id, run) => setSlot(run),
        });
        await expect(integration.startAgentRun("ws")).rejects.toThrow(refusal);
        // The escape target stayed untouched: no run log, no temp files.
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  // Two computers share one workspace folder through a file-sync service
  // such as iCloud Drive. Each computer has its own copy. A sync copies each
  // file one computer changed since the last sync to the other; when both
  // changed the same file, it keeps the winner's version whole.
  describe("with two computers syncing one workspace", () => {
    async function filesUnder(root: string): Promise<Map<string, string>> {
      const files = new Map<string, string>();
      const folder = join(root, ".dohc");
      for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        files.set(relative(folder, path), await readFile(path, "utf8"));
      }
      return files;
    }

    function fileSync(rootA: string, rootB: string) {
      let synced = new Map<string, string>();
      return async (winner: "a" | "b") => {
        const [a, b] = await Promise.all([filesUnder(rootA), filesUnder(rootB)]);
        for (const path of new Set([...a.keys(), ...b.keys()])) {
          const aChanged = a.get(path) !== synced.get(path);
          const bChanged = b.get(path) !== synced.get(path);
          const keepA = aChanged && (!bChanged || winner === "a");
          const [source, target] = keepA ? [a, rootB] : [b, rootA];
          const kept = source.get(path);
          if (kept === undefined || a.get(path) === b.get(path)) continue;
          await mkdir(dirname(join(target, ".dohc", path)), { recursive: true });
          await writeFile(join(target, ".dohc", path), kept);
        }
        synced = await filesUnder(rootA);
      };
    }

    async function recordsUnder(root: string): Promise<Array<{ id: string; status: string }>> {
      const found: Array<{ id: string; status: string }> = [];
      for (const source of (await filesUnder(root)).values()) {
        found.push(...(JSON.parse(source) as Array<{ id: string; status: string }>));
      }
      return found.sort((left, right) => left.id.localeCompare(right.id));
    }

    it("keeps every run record and review card when both start and end runs before a sync", async () => {
      await withWorkspace(async ({ root: rootA }) => {
        await withWorkspace(async ({ root: rootB }) => {
          const ended: string[] = [];
          const computer = (root: string, installId: string, ids: string[]) => createAgentIntegration({
            rootFor: () => root,
            installId: () => installId,
            createId: () => ids.shift() ?? "run-extra",
            setAgentRun: () => undefined,
            onRunEnded: ({ runId }) => ended.push(runId),
          });
          const a = computer(rootA, "local:computer-a", ["a-1", "a-2"]);
          const b = computer(rootB, "local:computer-b", ["b-1", "b-2"]);

          const sync = fileSync(rootA, rootB);

          await a.startAgentRun("ws");
          await b.startAgentRun("ws");
          await sync("a");
          await b.endAgentRun("ws", "b-1");
          await a.endAgentRun("ws", "a-1");
          await a.startAgentRun("ws");
          await b.startAgentRun("ws");
          await sync("b");
          await a.endAgentRun("ws", "a-2", "failed");
          await b.endAgentRun("ws", "b-2");
          await sync("a");

          expect(ended.sort()).toEqual(["a-1", "a-2", "b-1", "b-2"]);
          const expected = [
            { id: "a-1", status: "complete" },
            { id: "a-2", status: "failed" },
            { id: "b-1", status: "complete" },
            { id: "b-2", status: "complete" },
          ];
          expect(await recordsUnder(rootA)).toMatchObject(expected);
          expect(await recordsUnder(rootB)).toMatchObject(expected);
        });
      });
    });

    it("ignores conflict copies, another computer's file, and the old shared file", async () => {
      await withWorkspace(async ({ root, setSlot }) => {
        await mkdir(runsFolder(root), { recursive: true });
        const planted = {
          [join(root, ".dohc", "agent-runs.json")]: "not JSON\n",
          [join(root, ".dohc", "agent-runs 2.json")]: "not JSON\n",
          [join(runsFolder(root), "other-computer.json")]: "not JSON\n",
          [runsPath(root).replace(/\.json$/, " 2.json")]: "not JSON\n",
        };
        for (const [path, source] of Object.entries(planted)) await writeFile(path, source);
        const ended = vi.fn();
        const integration = createAgentIntegration({
          rootFor: () => root,
          setAgentRun: (_id, run) => setSlot(run),
          onRunEnded: ended,
        });

        const run = await integration.startAgentRun("ws");
        await integration.endAgentRun("ws", run.id);
        await expect(integration.getAgentRunStatus("ws")).resolves.toMatchObject({
          activeRun: null,
          lastRun: { id: run.id, status: "complete" },
        });
        expect(ended).toHaveBeenCalledOnce();
        for (const [path, source] of Object.entries(planted)) expect(await readFile(path, "utf8")).toBe(source);
      });
    });
  });
});
