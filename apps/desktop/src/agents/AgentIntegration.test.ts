import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  it("ending a non-active run never clears a newer active run's slot", async () => {
    await withWorkspace(async ({ root, setSlot, slots }) => {
      const integration = createAgentIntegration({
        rootFor: () => root,
        setAgentRun: (_id, run) => setSlot(run),
      });
      const a = await integration.startAgentRun("ws");
      const b = await integration.startAgentRun("ws");
      // End the OLDER run A: B still owns the workspace, so its attribution
      // slot must stay set (not silently cleared to local).
      await integration.endAgentRun("ws", a.id);
      expect(slots.at(-1)).toEqual({ agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: b.id });
      expect(await integration.getAgentRunStatus("ws")).toMatchObject({
        mcpEnabled: true,
        activeRun: { id: b.id },
      });
    });
  });

  it("ignores malformed persisted run records while keeping valid history", async () => {
    await withWorkspace(async ({ root, setSlot }) => {
      await mkdir(join(root, ".dohc"), { recursive: true });
      await writeFile(
        join(root, ".dohc/agent-runs.json"),
        JSON.stringify([
          { id: "bad-start", startedAt: "yesterday", status: "complete" },
          {
            id: "run-valid",
            startedAt: 1,
            endedAt: 2,
            agentId: "dohc-mcp",
            onBehalfOf: "local",
            status: "failed",
          },
          {
            id: "bad-status",
            startedAt: 3,
            agentId: "dohc-mcp",
            onBehalfOf: "local",
            status: "done",
          },
        ]),
      );
      const integration = createAgentIntegration({
        rootFor: () => root,
        setAgentRun: (_id, run) => setSlot(run),
      });

      await expect(integration.getAgentRunStatus("ws")).resolves.toMatchObject({
        activeRun: null,
        lastRun: { id: "run-valid", status: "failed" },
      });
    });
  });

  // PR 0N-2: endAgentRun is the single funnel every terminal run path goes
  // through (driver turn-completed, panel Stop, the endAgentRun IPC), so the
  // try-in-version review card listens HERE, not on each caller.
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
      expect(ended).toEqual([{ workspaceId: "ws", runId: run.id, status: "failed" }]);
    });
  });

  it("throws for an unknown workspace and never writes a record", async () => {
    const integration = createAgentIntegration({
      rootFor: () => null,
      setAgentRun: () => {},
    });
    await expect(integration.startAgentRun("nope")).rejects.toThrow(/Unknown workspace/);
  });

  // Same boundary as workspaceUiState: a malicious attached workspace can ship
  // `.dohc` as a SYMLINK to a directory outside the workspace. The run-log
  // writer must refuse instead of planting agent-runs.json at the target.
  it("refuses to write agent-runs through a symlinked .dohc and never lands files outside", async () => {
    await withWorkspace(async ({ root, setSlot }) => {
      const outside = await mkdtemp(join(tmpdir(), "dohc-agent-escape-"));
      try {
        await symlink(outside, join(root, ".dohc"), "dir");
        const integration = createAgentIntegration({
          rootFor: () => root,
          setAgentRun: (_id, run) => setSlot(run),
        });
        await expect(integration.startAgentRun("ws")).rejects.toThrow(/\.dohc/);
        // The escape target stayed untouched: no run log, no temp files.
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
