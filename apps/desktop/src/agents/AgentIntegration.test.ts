import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ActiveAgentRun } from "../workspaces/workspaceWatcher";
import { createAgentIntegration, type McpServerHandle } from "./AgentIntegration";

async function withWorkspace<T>(
  fn: (input: { root: string; setSlot: (r: ActiveAgentRun | null) => void; slots: Array<ActiveAgentRun | null> }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "dohc-agent-test-"));
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
      expect(run).toMatchObject({ status: "running", agentId: "dohc-mcp", onBehalfOf: "local" });
      // The watcher slot now carries this run's attribution.
      expect(slots.at(-1)).toEqual({ agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: run.id });

      // The record is durable and inspectable on disk.
      const persisted = JSON.parse(await readFile(join(root, ".dohc/agent-runs.json"), "utf8"));
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ id: run.id, status: "running" });

      await integration.endAgentRun("ws", run.id);
      // Slot cleared back to local user.
      expect(slots.at(-1)).toBeNull();
      const after = JSON.parse(await readFile(join(root, ".dohc/agent-runs.json"), "utf8"));
      expect(after[0]).toMatchObject({ status: "complete" });
      expect(after[0].endedAt).toBeTypeOf("number");
    });
  });

  it("spawns and stops the managed MCP child across a run, reflected in status", async () => {
    await withWorkspace(async ({ root, setSlot }) => {
      const stop = vi.fn();
      const spawnMcpServer = vi.fn(
        (_input: { root: string; home: string }): McpServerHandle => ({ stop }),
      );
      const integration = createAgentIntegration({
        rootFor: () => root,
        setAgentRun: (_id, run) => setSlot(run),
        spawnMcpServer,
        home: "/state/home",
      });

      const run = await integration.startAgentRun("ws");
      expect(spawnMcpServer).toHaveBeenCalledWith({ root, home: "/state/home" });
      expect(await integration.getAgentRunStatus("ws")).toMatchObject({
        mcpEnabled: true,
        activeRun: { id: run.id },
      });

      await integration.endAgentRun("ws", run.id, "complete");
      expect(stop).toHaveBeenCalledOnce();
      expect(await integration.getAgentRunStatus("ws")).toMatchObject({
        mcpEnabled: false,
        activeRun: null,
        lastRun: { id: run.id, status: "complete" },
      });
    });
  });

  it("throws for an unknown workspace and never writes a record", async () => {
    const integration = createAgentIntegration({
      rootFor: () => null,
      setAgentRun: () => {},
    });
    await expect(integration.startAgentRun("nope")).rejects.toThrow(/Unknown workspace/);
  });
});
