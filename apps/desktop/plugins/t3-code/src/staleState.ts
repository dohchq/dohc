import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// t3 leaves <baseDir>/userdata/server-runtime.json behind after Windows
// termination — its shutdown finalizers do not run under Node's signal
// emulation (proven in the 2026-08-13 spike and re-proven for this bridge).
// The contract: the file is stale unless its pid is alive AND matches the
// ownership record this plugin wrote at spawn time. A live match is an
// orphan from a crashed previous host, and it must die before a new server
// binds the same base dir. HTTP readiness is the only liveness truth; this
// file never proves a server is running.

export const T3_OWNER_FILE_NAME = "t3-owner.json";

export interface T3OwnerRecord {
  pid: number;
  port: number;
  startedAt: string;
}

export type StaleStateAction =
  | { action: "none" }
  | { action: "remove-stale-file" }
  | { action: "terminate-orphan"; pid: number };

export function assessStaleState(input: {
  /** Parsed server-runtime.json contents, or null when the file is absent. */
  runtime: unknown;
  owner: T3OwnerRecord | null;
  isPidAlive: (pid: number) => boolean;
}): StaleStateAction {
  if (input.runtime === null || input.runtime === undefined) {
    return { action: "none" };
  }
  const pid =
    typeof input.runtime === "object" &&
    input.runtime !== null &&
    "pid" in input.runtime &&
    Number.isSafeInteger(input.runtime.pid) &&
    (input.runtime.pid as number) > 0
      ? (input.runtime.pid as number)
      : null;
  if (pid === null) return { action: "remove-stale-file" };
  if (!input.isPidAlive(pid)) return { action: "remove-stale-file" };
  if (input.owner && input.owner.pid === pid) {
    return { action: "terminate-orphan", pid };
  }
  // Alive but not a process this plugin recorded: pid reuse by an unrelated
  // process. Never signal a pid ownership cannot vouch for; the file is
  // still stale for our purposes and t3 reads it only informationally.
  return { action: "remove-stale-file" };
}

export interface RecoverStaleStateDeps {
  baseDir: string;
  ownerPath: string;
  isPidAlive?: (pid: number) => boolean;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  waitMs?: (ms: number) => Promise<void>;
  /** SIGTERM grace before SIGKILL, matching the broker's teardown grace. */
  graceMs?: number;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKillPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Unreadable is as stale as invalid.
    return { unreadable: true };
  }
}

function decodeOwner(value: unknown): T3OwnerRecord | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    "port" in value &&
    Number.isSafeInteger(value.port)
  ) {
    return {
      pid: value.pid as number,
      port: value.port as number,
      startedAt:
        "startedAt" in value && typeof value.startedAt === "string"
          ? value.startedAt
          : "",
    };
  }
  return null;
}

export function serverRuntimePath(baseDir: string): string {
  return join(baseDir, "userdata", "server-runtime.json");
}

/** Runs before every spawn. Returns the action it took, for the caller's
 * redacted diagnostics. */
export async function recoverStaleState(
  deps: RecoverStaleStateDeps,
): Promise<StaleStateAction> {
  const runtimePath = serverRuntimePath(deps.baseDir);
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const killPid = deps.killPid ?? defaultKillPid;
  const waitMs =
    deps.waitMs ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const graceMs = deps.graceMs ?? 2_000;

  const runtime = await readJsonFile(runtimePath);
  const owner = decodeOwner(await readJsonFile(deps.ownerPath));
  const assessment = assessStaleState({ runtime, owner, isPidAlive });

  if (assessment.action === "terminate-orphan") {
    killPid(assessment.pid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && isPidAlive(assessment.pid)) {
      await waitMs(100);
    }
    if (isPidAlive(assessment.pid)) killPid(assessment.pid, "SIGKILL");
  }
  if (assessment.action !== "none") {
    await unlink(runtimePath).catch(() => undefined);
  }
  return assessment;
}

export async function writeOwnerRecord(
  ownerPath: string,
  record: T3OwnerRecord,
): Promise<void> {
  await writeFile(ownerPath, `${JSON.stringify(record)}\n`, "utf8");
}
