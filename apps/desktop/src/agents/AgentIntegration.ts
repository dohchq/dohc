import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveWorkspaceMetadataDir } from "../workspaces/workspaceMetadata";
import type { ActiveAgentRun } from "../workspaces/workspaceWatcher";

// Local agent integration. Two local-only concepts live here:
//
//  1. The MCP server lifecycle. The DESKTOP runs the dohc MCP server; the
//     user's AI tool (Claude Code, Codex) is the client that launches it as a
//     stdio child via its own config. "Enabling" agents flips a per-workspace
//     toggle and (optionally) spawns the stdio server as a managed child; the
//     copyable config snippet in Settings points the AI tool at it.
//
//  2. The active agent-run slot + its persisted record. An agent run is a
//     LOCAL concept: a small record in .dohc/agent-runs.json (id, startedAt,
//     agentId, status). While a run is active, the workspace activity slot is
//     set so the watcher attributes the run's writes to the agent.

export interface AgentRunRecord {
  id: string;
  startedAt: number;
  endedAt?: number;
  agentId: string;
  onBehalfOf: string;
  status: "running" | "complete" | "failed";
}

export interface AgentRunStatus {
  mcpEnabled: boolean;
  activeRun: AgentRunRecord | null;
  lastRun: AgentRunRecord | null;
}

// A handle to a spawned MCP child the integration can stop. Kept minimal so a
// test can inject a fake spawner without a real process.
export interface McpServerHandle {
  stop(): void;
}

export interface AgentIntegrationOptions {
  // Resolves a workspace id to its root path (where .dohc/agent-runs.json
  // lives) — null if the workspace is unknown.
  rootFor(workspaceId: string): string | null;
  // Sets/clears the watcher's per-workspace active-run slot.
  setAgentRun(workspaceId: string, run: ActiveAgentRun | null): void;
  // Spawns the MCP stdio server for a workspace. Injectable so tests never
  // launch a real child. Omitted ⇒ enabling only flips the toggle (the user's
  // AI tool launches its own copy via the config snippet).
  spawnMcpServer?: (input: { root: string; home: string }) => McpServerHandle;
  // The state home (registry dir) handed to a spawned server as --home.
  home?: string;
  agentId?: string;
  onBehalfOf?: string;
  now?: () => number;
  // PR 0N-2: fired after a KNOWN run's terminal status is durably recorded.
  // endAgentRun is the single funnel every terminal path goes through
  // (AgentSessionManager finalizeRun, the panel's Stop, the endAgentRun IPC),
  // so run-completion consumers (the try-in-version review card) hook here.
  onRunEnded?: (input: {
    workspaceId: string;
    runId: string;
    status: "complete" | "failed";
  }) => void;
}

const RUNS_FILE = "agent-runs.json";
const DEFAULT_AGENT_ID = "dohc-mcp";

function isAgentRunRecord(value: unknown): value is AgentRunRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as AgentRunRecord;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.startedAt === "number" &&
    Number.isFinite(record.startedAt) &&
    (record.endedAt === undefined || (typeof record.endedAt === "number" && Number.isFinite(record.endedAt))) &&
    typeof record.agentId === "string" &&
    record.agentId.length > 0 &&
    typeof record.onBehalfOf === "string" &&
    record.onBehalfOf.length > 0 &&
    (record.status === "running" || record.status === "complete" || record.status === "failed")
  );
}

// Both paths resolve .dohc through resolveWorkspaceMetadataDir — a symlinked
// .dohc (malicious attached workspace) is refused, never followed, so the run
// log can't be planted outside the workspace boundary.
async function readRuns(rootPath: string): Promise<AgentRunRecord[]> {
  try {
    const path = join(await resolveWorkspaceMetadataDir(rootPath), RUNS_FILE);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isAgentRunRecord) : [];
  } catch {
    return [];
  }
}

async function writeRuns(rootPath: string, runs: AgentRunRecord[]): Promise<void> {
  const path = join(await resolveWorkspaceMetadataDir(rootPath), RUNS_FILE);
  // Atomic temp+rename so a crash never truncates the run log. A unique suffix
  // (not just pid) means a leftover temp from a crashed run can never be
  // reused/clobbered by a later write.
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(runs, null, 2)}\n`);
  await rename(tmp, path);
}

export function createAgentIntegration(options: AgentIntegrationOptions) {
  const now = options.now ?? (() => Date.now());
  const agentId = options.agentId ?? DEFAULT_AGENT_ID;
  const onBehalfOf = options.onBehalfOf ?? "local";

  // Per-workspace live state: the running MCP child (if spawned) and the
  // active run record. Writes to .dohc/agent-runs.json are serialized per
  // workspace so two close calls can't drop each other's record.
  interface State {
    mcp: McpServerHandle | null;
    activeRun: AgentRunRecord | null;
    chain: Promise<unknown>;
  }
  const states = new Map<string, State>();
  function stateFor(workspaceId: string): State {
    let s = states.get(workspaceId);
    if (!s) {
      s = { mcp: null, activeRun: null, chain: Promise.resolve() };
      states.set(workspaceId, s);
    }
    return s;
  }
  function serialize<T>(s: State, task: () => Promise<T>): Promise<T> {
    const run = s.chain.then(task, task);
    s.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function rootOrThrow(workspaceId: string): string {
    const root = options.rootFor(workspaceId);
    if (!root) throw new Error(`Unknown workspace: ${workspaceId}`);
    return root;
  }

  // Enabling spawns the managed MCP child (if a spawner was provided) and
  // records the run. The active-run slot is set so the watcher attributes the
  // run's writes to the agent until endAgentRun clears it.
  async function startAgentRun(workspaceId: string): Promise<AgentRunRecord> {
    const root = rootOrThrow(workspaceId);
    const s = stateFor(workspaceId);
    if (!s.mcp && options.spawnMcpServer) {
      s.mcp = options.spawnMcpServer({ root, home: options.home ?? root });
    }
    const record: AgentRunRecord = {
      id: randomUUID(),
      startedAt: now(),
      agentId,
      onBehalfOf,
      status: "running",
    };
    await serialize(s, async () => {
      const runs = await readRuns(root);
      runs.push(record);
      await writeRuns(root, runs);
    });
    try {
      options.setAgentRun(workspaceId, {
        agentId: record.agentId,
        onBehalfOf: record.onBehalfOf,
        agentRunId: record.id,
      });
      s.activeRun = record;
    } catch (error) {
      record.status = "failed";
      record.endedAt = now();
      await serialize(s, async () => {
        const runs = await readRuns(root);
        const persisted = runs.find((candidate) => candidate.id === record.id);
        if (persisted) {
          persisted.status = record.status;
          persisted.endedAt = record.endedAt;
          await writeRuns(root, runs);
        }
      });
      throw error;
    }
    return record;
  }

  // Ends a run: clears the active-run slot (so later writes are local again),
  // marks the persisted record, and stops the managed MCP child.
  async function endAgentRun(
    workspaceId: string,
    runId: string,
    status: "complete" | "failed" = "complete",
  ): Promise<void> {
    const root = rootOrThrow(workspaceId);
    const s = stateFor(workspaceId);
    // Only the run that currently OWNS the workspace may clear its live state.
    // Otherwise ending a stale/older runId would silently clear a newer active
    // run's attribution slot + child (start A, start B, end A must not unhook B).
    if (s.activeRun?.id === runId) {
      options.setAgentRun(workspaceId, null);
      s.activeRun = null;
      if (s.mcp) {
        s.mcp.stop();
        s.mcp = null;
      }
    }
    const recorded = await serialize(s, async () => {
      const runs = await readRuns(root);
      const record = runs.find((r) => r.id === runId);
      if (!record) return false;
      record.status = status;
      record.endedAt = now();
      await writeRuns(root, runs);
      return true;
    });
    if (recorded) {
      try {
        options.onRunEnded?.({ workspaceId, runId, status });
      } catch (error) {
        console.error("[desktop] onRunEnded hook failed", error);
      }
    }
  }

  async function getAgentRunStatus(workspaceId: string): Promise<AgentRunStatus> {
    const root = rootOrThrow(workspaceId);
    const s = stateFor(workspaceId);
    const runs = await readRuns(root);
    return {
      // "Enabled" means agent integration is active for this workspace: a run
      // is open, so writes are attributed and the live config snippet is valid.
      // A managed MCP child is OPTIONAL (the user's AI tool launches its own via
      // the snippet; self-spawn waits on Phase 14 packaging), so the active run
      // — not a spawned process — is the honest signal the toggle reflects.
      mcpEnabled: s.activeRun !== null,
      activeRun: s.activeRun,
      lastRun: runs.length > 0 ? runs[runs.length - 1] : null,
    };
  }

  // Quit path: stop every managed child and clear slots.
  function stopAll(): void {
    for (const [workspaceId, s] of states) {
      if (s.mcp) {
        s.mcp.stop();
        s.mcp = null;
      }
      if (s.activeRun) {
        options.setAgentRun(workspaceId, null);
        s.activeRun = null;
      }
    }
  }

  return { startAgentRun, endAgentRun, getAgentRunStatus, stopAll };
}

export type AgentIntegration = ReturnType<typeof createAgentIntegration>;
