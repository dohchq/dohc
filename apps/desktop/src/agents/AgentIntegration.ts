import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { atomicReplaceFile } from "../atomicReplaceFile";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DOHC_AGENT_RUNS_GUARD, notARealFolderRefusal } from "@dohc/workspace-core";
import { sha256Hex } from "@dohc/workspace-core/hash";
import { resolveWorkspaceMetadataDir } from "../workspaces/workspaceMetadata";
import { UNNAMED_AGENT_ID, type ActiveAgentRun } from "./activeAgentRun";

// Local agent runs. An agent run is a LOCAL concept: a small record in this
// installation's file under .dohc/agent-runs (id, startedAt, agentId, status).
// While a run is active, the workspace activity slot is set so the watcher
// attributes the run's writes to the agent. The user's AI tool launches its
// own MCP server from the config snippet in Settings; the desktop never runs
// one.

export interface AgentRunRecord {
  id: string;
  startedAt: number;
  endedAt?: number;
  agentId: string;
  onBehalfOf: string;
  status: "running" | "complete" | "failed" | "interrupted";
  // The app process that started the run. A process that quits mid-run leaves
  // "running" behind; the next one marks it interrupted.
  incarnation: string;
}

interface AgentRunStatus {
  activeRun: AgentRunRecord | null;
  lastRun: AgentRunRecord | null;
}

export class AgentIntegrationState {
  activeRun: AgentRunRecord | null = null;
  chain: Promise<unknown> = Promise.resolve();
  // True once this process has settled the runs an earlier process left open.
  swept = false;
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
  // This installation's stable id. It names the file that holds its runs.
  installId(): string;
  // This process's id. Omitted ⇒ a new randomUUID per integration, which main
  // creates once per process.
  incarnation?: string;
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

// Each installation writes only its own file, so two computers that sync one
// workspace through a file-sync service such as iCloud Drive never replace
// each other's records, and an installation never settles another's runs.
// The name hashes the installation id, which can hold characters a file name
// cannot.
export function agentRunsFileName(installId: string): string {
  return `${sha256Hex(installId).slice(0, 32)}.json`;
}

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
    (record.status === "running" || record.status === "complete" || record.status === "failed" ||
      record.status === "interrupted") &&
    typeof record.incarnation === "string" &&
    record.incarnation.length > 0
  );
}

interface RunsFile {
  path: string;
  // The path as the user sees it, for the messages that name it.
  shown: string;
}

// .dohc resolves through resolveWorkspaceMetadataDir, and .dohc/agent-runs
// must be a real folder, so a planted link cannot send run records outside
// the workspace. Only a write makes the folder.
async function runsFile(rootPath: string, installId: string, create: boolean): Promise<RunsFile> {
  const folder = join(await resolveWorkspaceMetadataDir(rootPath), "agent-runs");
  let stats = await lstat(folder).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (stats === null && create) {
    await mkdir(folder, { recursive: true });
    stats = await lstat(folder);
  }
  if (stats !== null && (stats.isSymbolicLink() || !stats.isDirectory())) {
    throw new Error(notARealFolderRefusal(DOHC_AGENT_RUNS_GUARD, stats));
  }
  const name = agentRunsFileName(installId);
  return { path: join(folder, name), shown: `${DOHC_AGENT_RUNS_GUARD.path}/${name}` };
}

async function readRuns(rootPath: string, installId: string): Promise<AgentRunRecord[]> {
  const file = await runsFile(rootPath, installId, false);
  let source: string;
  try {
    source = await readFile(file.path, "utf8");
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
      return [];
    }
    throw new Error(
      `dohc could not read this workspace's agent run history. Check ${file.shown}, then try again.`,
      { cause },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error(
      `This workspace's agent run history contains invalid JSON. Repair ${file.shown}, then try again.`,
      { cause },
    );
  }
  if (!Array.isArray(parsed) || !parsed.every(isAgentRunRecord)) {
    throw new Error(
      `This workspace's agent run history contains invalid run records. Repair ${file.shown}, then try again.`,
    );
  }
  return parsed;
}

async function writeRuns(rootPath: string, installId: string, runs: AgentRunRecord[]): Promise<void> {
  const file = await runsFile(rootPath, installId, true);
  // Atomic temp+rename so a crash never truncates the run log. A unique suffix
  // (not just pid) means a leftover temp from a crashed run can never be
  // reused/clobbered by a later write.
  await atomicReplaceFile(file.path, (tmp) => writeFile(tmp, `${JSON.stringify(runs, null, 2)}\n`));
}

export function createAgentIntegration(options: AgentIntegrationOptions) {
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? (() => randomUUID());
  const agentId = options.agentId ?? UNNAMED_AGENT_ID;
  const incarnation = options.incarnation ?? randomUUID();
  const ownRuns = (root: string) => readRuns(root, options.installId());
  const saveOwnRuns = (root: string, runs: AgentRunRecord[]) => writeRuns(root, options.installId(), runs);

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

  // On a workspace's first use in this process, marks the runs an earlier
  // process of this installation left running as interrupted. Unreadable
  // history is left as it is and swept on a later use.
  async function sweepInterrupted(state: AgentIntegrationState, root: string): Promise<void> {
    if (state.swept) return;
    await serialize(state, async () => {
      if (state.swept) return;
      const runs = await ownRuns(root);
      const endedAt = now();
      let changed = false;
      for (const run of runs) {
        if (run.status !== "running" || run.incarnation === incarnation) continue;
        run.status = "interrupted";
        run.endedAt = endedAt;
        changed = true;
      }
      if (changed) await saveOwnRuns(root, runs);
      state.swept = true;
    }).catch((error: unknown) => {
      console.error("[desktop] Could not settle interrupted agent runs", error);
    });
  }

  // Records the run. The active-run slot is set so the watcher attributes the
  // run's writes to the agent until endAgentRun clears it.
  async function startAgentRun(workspaceId: string): Promise<AgentRunRecord> {
    const authority = options.acquire(workspaceId);
    const root = authority.rootPath;
    const state = authority.state;
    try {
      await sweepInterrupted(state, root);
      const record: AgentRunRecord = {
        id: createId(),
        startedAt: now(),
        agentId,
        onBehalfOf: options.localPersonId(),
        status: "running",
        incarnation,
      };
      await serialize(state, async () => {
        const runs = await ownRuns(root);
        runs.push(record);
        await saveOwnRuns(root, runs);
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
            const runs = await ownRuns(root);
            const persisted = runs.find(
              (candidate) => candidate.id === record.id,
            );
            if (persisted) {
              persisted.status = record.status;
              persisted.endedAt = record.endedAt;
              await saveOwnRuns(root, runs);
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
      await sweepInterrupted(state, root);
      const recorded = await serialize(state, async () => {
        const runs = await ownRuns(root);
        const record = runs.find((r) => r.id === runId);
        if (!record) return false;
        record.status = status;
        record.endedAt = now();
        await saveOwnRuns(root, runs);
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
      await sweepInterrupted(state, root);
      let runs: AgentRunRecord[];
      try {
        runs = await ownRuns(root);
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
