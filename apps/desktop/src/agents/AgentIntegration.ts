import { readFile, writeFile } from "node:fs/promises";
import { atomicReplaceFile } from "../atomicReplaceFile";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveWorkspaceMetadataDir } from "../workspaces/workspaceMetadata";
import type { ActiveAgentRun } from "./activeAgentRun";

// Local agent runs. An agent run is a LOCAL concept: a small record in
// .dohc/agent-runs.json (id, startedAt, agentId, status). While a run is
// active, the workspace activity slot is set so the watcher attributes the
// run's writes to the agent. The user's AI tool launches its own MCP server
// from the config snippet in Settings; the desktop never runs one.

export interface AgentRunRecord {
  id: string;
  startedAt: number;
  endedAt?: number;
  agentId: string;
  onBehalfOf: string;
  status: "running" | "complete" | "failed";
}

interface AgentRunStatus {
  activeRun: AgentRunRecord | null;
  lastRun: AgentRunRecord | null;
}

export class AgentIntegrationState {
  activeRun: AgentRunRecord | null = null;
  chain: Promise<unknown> = Promise.resolve();
}

interface AgentIntegrationAuthority {
  readonly attachmentId: symbol;
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly state: AgentIntegrationState;
  assertCurrent(): void;
  setAgentRun(run: ActiveAgentRun | null): void | Promise<void>;
  release(): void;
}

export interface AgentIntegrationOptions {
  acquire(workspaceId: string): AgentIntegrationAuthority;
  workspaceIds(): string[];
  agentId?: string;
  // The person this computer's agent runs work for, read when a run starts.
  localPersonId(): string;
  now?: () => number;
  // Injectable id seam (oracle/tests) for the AgentRunRecord id. Omitted ⇒ a
  // real randomUUID, identical to today's behavior.
  createId?: () => string;
  // Fired after a known run's terminal status is durably recorded.
  // endAgentRun is the single funnel every terminal path goes through
  // (a Settings stop, the endAgentRun IPC),
  // so run-completion consumers (the try-in-version review card) hook here.
  onRunEnded?: (input: {
    attachmentId: symbol;
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

// Both paths resolve .dohc through resolveWorkspaceMetadataDir — a symlinked.
// Dohc (malicious attached workspace) is refused, never followed, so the run
// log can't be planted outside the workspace boundary.
async function readRuns(rootPath: string): Promise<AgentRunRecord[]> {
  const path = join(await resolveWorkspaceMetadataDir(rootPath), RUNS_FILE);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
      return [];
    }
    throw new Error(
      "dohc could not read this workspace's agent run history. Check .dohc/agent-runs.json, then try again.",
      { cause },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error(
      "This workspace's agent run history contains invalid JSON. Repair .dohc/agent-runs.json, then try again.",
      { cause },
    );
  }
  if (!Array.isArray(parsed) || !parsed.every(isAgentRunRecord)) {
    throw new Error(
      "This workspace's agent run history contains invalid run records. Repair .dohc/agent-runs.json, then try again.",
    );
  }
  return parsed;
}

async function writeRuns(rootPath: string, runs: AgentRunRecord[]): Promise<void> {
  const path = join(await resolveWorkspaceMetadataDir(rootPath), RUNS_FILE);
  // Atomic temp+rename so a crash never truncates the run log. A unique suffix
  // (not just pid) means a leftover temp from a crashed run can never be
  // reused/clobbered by a later write.
  await atomicReplaceFile(path, (tmp) => writeFile(tmp, `${JSON.stringify(runs, null, 2)}\n`));
}

export function createAgentIntegration(options: AgentIntegrationOptions) {
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? (() => randomUUID());
  const agentId = options.agentId ?? DEFAULT_AGENT_ID;

  function serialize<T>(
    state: AgentIntegrationState,
    task: () => Promise<T>,
  ): Promise<T> {
    const run = state.chain.then(task, task);
    state.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // Records the run. The active-run slot is set so the watcher attributes the
  // run's writes to the agent until endAgentRun clears it.
  async function startAgentRun(workspaceId: string): Promise<AgentRunRecord> {
    const authority = options.acquire(workspaceId);
    const root = authority.rootPath;
    const state = authority.state;
    try {
      const record: AgentRunRecord = {
        id: createId(),
        startedAt: now(),
        agentId,
        onBehalfOf: options.localPersonId(),
        status: "running",
      };
      await serialize(state, async () => {
        const runs = await readRuns(root);
        runs.push(record);
        await writeRuns(root, runs);
      });
      try {
        authority.assertCurrent();
        // A person starts this run, so its writes begin a chain at depth 0.
        await authority.setAgentRun({
          agentId: record.agentId,
          onBehalfOf: record.onBehalfOf,
          agentRunId: record.id,
          depth: 0,
        });
        authority.assertCurrent();
        state.activeRun = record;
      } catch (error) {
        record.status = "failed";
        record.endedAt = now();
        try {
          await serialize(state, async () => {
            const runs = await readRuns(root);
            const persisted = runs.find(
              (candidate) => candidate.id === record.id,
            );
            if (persisted) {
              persisted.status = record.status;
              persisted.endedAt = record.endedAt;
              await writeRuns(root, runs);
            }
          });
        } catch (historyError) {
          console.error("[desktop] Could not record the failed agent run", historyError);
        }
        throw error;
      }
      return record;
    } finally {
      authority.release();
    }
  }

  // Ends a run: clears the active-run slot (so later writes are local again),
  // and marks the persisted record.
  async function endAgentRun(
    workspaceId: string,
    runId: string,
    status: "complete" | "failed" = "complete",
  ): Promise<void> {
    const authority = options.acquire(workspaceId);
    const root = authority.rootPath;
    const state = authority.state;
    try {
      // An explicit stop must release attribution even when history is unreadable.
      // Ending an older run must not unhook a newer run.
      if (state.activeRun?.id === runId) {
        await authority.setAgentRun(null);
        authority.assertCurrent();
        // A newer run may have installed while the clear was pending.
        if (state.activeRun?.id === runId) state.activeRun = null;
      }
      const recorded = await serialize(state, async () => {
        const runs = await readRuns(root);
        const record = runs.find((r) => r.id === runId);
        if (!record) return false;
        record.status = status;
        record.endedAt = now();
        await writeRuns(root, runs);
        return true;
      });
      if (recorded) {
        authority.assertCurrent();
        try {
          options.onRunEnded?.({
            attachmentId: authority.attachmentId,
            workspaceId,
            runId,
            status,
          });
        } catch (error) {
          console.error("[desktop] onRunEnded hook failed", error);
        }
      }
    } finally {
      authority.release();
    }
  }

  async function getAgentRunStatus(workspaceId: string): Promise<AgentRunStatus> {
    const authority = options.acquire(workspaceId);
    const root = authority.rootPath;
    const state = authority.state;
    try {
      // Unreadable history still has a live answer: the run this attachment
      // owns, or none after a stop. Mutations keep refusing until it is repaired.
      let runs: AgentRunRecord[];
      try {
        runs = await readRuns(root);
      } catch {
        runs = state.activeRun ? [state.activeRun] : [];
      }
      authority.assertCurrent();
      return {
        activeRun: state.activeRun,
        lastRun: runs.length > 0 ? runs[runs.length - 1] : null,
      };
    } finally {
      authority.release();
    }
  }

  // Quit path: clear every active run's slot.
  async function stopAll(): Promise<void> {
    let failed = false;
    let firstError: unknown;
    for (const workspaceId of options.workspaceIds()) {
      let authority: AgentIntegrationAuthority | null = null;
      try {
        authority = options.acquire(workspaceId);
        const state = authority.state;
        if (state.activeRun) {
          await authority.setAgentRun(null);
          authority.assertCurrent();
          state.activeRun = null;
        }
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      } finally {
        try {
          authority?.release();
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      }
    }
    if (failed) throw firstError;
  }

  function disposeState(state: AgentIntegrationState): void {
    state.activeRun = null;
  }

  return {
    startAgentRun,
    endAgentRun,
    getAgentRunStatus,
    stopAll,
    disposeState,
  };
}

export type AgentIntegration = ReturnType<typeof createAgentIntegration>;
