// POSIX process-tree teardown, the sibling of windowsSpawn.ts's
// killProcessTreeWin32. Signalling only a child's own pid leaves the servers
// and workers it started running, still holding their ports and their cwd.
//
// The negated "-pid" process-group form cannot do this job here: the callers
// fork children through Electron's utilityProcess.fork, which has no
// `detached` option, so a child never becomes its own group leader and "-pid"
// would signal this app's own group (CodeRabbit #779 R10). Enumerate the tree
// from the process table instead and signal each pid.
import { execFile } from "node:child_process";

function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export interface ProcessTableEntry {
  pid: number;
  ppid: number;
  startedAt: string;
}

export interface ProcessIdentity {
  pid: number;
  startedAt: string;
}

/** Parses `ps -A -o pid=,ppid=,lstart=` output. Ignores unreadable lines. */
export function parseProcessTable(output: string): ProcessTableEntry[] {
  const entries: ProcessTableEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S(?:.*\S)?)\s*$/.exec(
      line,
    );
    if (!match?.[1] || !match[2] || !match[3]) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    entries.push({ pid, ppid, startedAt: match[3] });
  }
  return entries;
}

/**
 * The root pid and every transitive child, children before their parents so a
 * signalled parent cannot leave a child behind that the next round's
 * enumeration would no longer link to this tree.
 */
export function processTreePids(
  table: readonly Pick<ProcessTableEntry, "pid" | "ppid">[],
  rootPid: number,
): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const entry of table) {
    if (entry.pid === entry.ppid) continue;
    const siblings = childrenByParent.get(entry.ppid);
    if (siblings) siblings.push(entry.pid);
    else childrenByParent.set(entry.ppid, [entry.pid]);
  }
  const ordered: number[] = [rootPid];
  const seen = new Set<number>([rootPid]);
  for (let index = 0; index < ordered.length; index += 1) {
    const pid = ordered[index];
    if (pid === undefined) continue;
    for (const child of childrenByParent.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      ordered.push(child);
    }
  }
  return ordered.reverse();
}

export interface KillProcessTreePosixOptions {
  /** Injectable for tests: the real `ps` cannot run on Windows hosts. */
  readProcessTable?: () => Promise<string>;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * Pids an earlier round already enumerated. The next round enumerates each
   * surviving pid's subtree, including descendants reparented to init.
   */
  alsoSignal?: readonly number[];
  /** When present, a fresh process-table row must match before reuse. */
  alsoSignalIdentities?: readonly ProcessIdentity[];
}

export interface StopProcessTreePosixOptions extends Pick<
  KillProcessTreePosixOptions,
  "readProcessTable" | "sendSignal"
> {
  isAlive?: (pid: number) => boolean;
}

function readProcessTableWithPs(): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,lstart="], (error, stdout) => {
      if (error) reject(error);
      else resolveOutput(stdout);
    });
  });
}

interface ProcessTreeSignalResult {
  pids: number[];
  identities: ProcessIdentity[];
  tableReadFailed: boolean;
}

async function signalProcessTreePosix(
  rootPid: number,
  signal: NodeJS.Signals,
  options: KillProcessTreePosixOptions,
): Promise<ProcessTreeSignalResult> {
  const readProcessTable = options.readProcessTable ?? readProcessTableWithPs;
  const sendSignal = options.sendSignal ??
    ((pid, pidSignal) => process.kill(pid, pidSignal));
  const isForceRound = options.alsoSignalIdentities !== undefined;
  const capturedIdentities = new Map(
    options.alsoSignalIdentities?.map((identity) => [identity.pid, identity]),
  );
  const unverifiedRoots = isForceRound
    ? []
    : [rootPid, ...(options.alsoSignal ?? [])].filter(
        (pid) => !capturedIdentities.has(pid),
      );

  let pids = [...new Set(unverifiedRoots)];
  let identities: ProcessIdentity[] = [];
  let tableReadFailed = false;
  try {
    const table = parseProcessTable(await readProcessTable());
    const entriesByPid = new Map(table.map((entry) => [entry.pid, entry]));
    const identityMatches = (pid: number): boolean => {
      const captured = capturedIdentities.get(pid);
      if (captured === undefined) {
        // A process alive during round one would have supplied an identity.
        // Without one, the force round cannot distinguish an exited process
        // from an unrelated process that reused its pid, so signalling is unsafe.
        return !isForceRound;
      }
      return entriesByPid.get(pid)?.startedAt === captured.startedAt;
    };
    const roots = [rootPid, ...(options.alsoSignal ?? [])].filter(
      identityMatches,
    );
    pids = [...new Set(roots.flatMap((pid) => processTreePids(table, pid)))];
    identities = pids.flatMap((pid) => {
      const entry = entriesByPid.get(pid);
      return entry ? [{ pid, startedAt: entry.startedAt }] : [];
    });
  } catch {
    tableReadFailed = true;
    // The process table is unavailable. Signal only roots that do not need an
    // identity check; a captured pid is unsafe without a fresh table row.
  }

  let rootFailure: unknown;
  for (const pid of pids) {
    try {
      sendSignal(pid, signal);
    } catch (error) {
      // ESRCH means the process already exited, which is the outcome we want.
      // It covers the root too: a root that exits between rounds must not
      // fail the round that still has to reach its descendants.
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      if (pid === rootPid) rootFailure = error;
    }
  }
  if (rootFailure !== undefined) throw rootFailure;
  return { pids, identities, tableReadFailed };
}

/**
 * Signals `rootPid`, eligible `alsoSignal` pids, and their descendants. A pid
 * with a captured identity is eligible only when the fresh table row matches.
 * Without a process table, the function skips identity-bound pids. It rejects
 * only when signalling `rootPid` fails, and returns every pid it signalled.
 */
export async function killProcessTreePosix(
  rootPid: number,
  signal: NodeJS.Signals,
  options: KillProcessTreePosixOptions = {},
): Promise<number[]> {
  return (await signalProcessTreePosix(rootPid, signal, options)).pids;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessExit(
  pids: readonly number[],
  budgetMs: number,
  isAlive: (pid: number) => boolean,
): Promise<void> {
  if (budgetMs <= 0) return;
  const deadline = Date.now() + budgetMs;
  let remaining = [...new Set(pids)];
  while (remaining.length > 0) {
    remaining = remaining.filter(isAlive);
    if (remaining.length === 0) return;
    const waitMs = Math.min(50, deadline - Date.now());
    if (waitMs <= 0) return;
    await unrefDelay(waitMs);
  }
}

/**
 * SIGTERM the whole POSIX process tree rooted at `pid`, then wait concurrently
 * for `settled` to resolve and every captured pid to exit. Each wait uses the
 * same `settleMs` grace period before the tree receives SIGKILL. The force
 * round reuses a captured pid only when its start time still matches, so it
 * reaches a reparented descendant without signalling a process that reused
 * the pid. After SIGKILL, waits up to `settleMs` for the force-round targets
 * to exit.
 */
export async function stopProcessTreePosix(
  pid: number,
  settled: Promise<unknown> | (() => Promise<unknown>),
  settleMs = 2_000,
  onTreeKillFailure?: () => void,
  options: StopProcessTreePosixOptions = {},
): Promise<void> {
  const isAlive = options.isAlive ?? isProcessAlive;
  let captured: readonly number[] = [];
  let capturedIdentities: readonly ProcessIdentity[] = [];
  let unverifiable = false;
  try {
    const result = await signalProcessTreePosix(pid, "SIGTERM", options);
    captured = result.pids;
    capturedIdentities = result.identities;
    unverifiable = result.tableReadFailed;
  } catch {
    unverifiable = true;
  }

  const settledPromise = typeof settled === "function" ? settled() : settled;
  await Promise.all([
    Promise.race([settledPromise, unrefDelay(settleMs)]),
    waitForProcessExit(captured, settleMs, isAlive),
  ]);

  let forceResultPids: readonly number[] = [];
  try {
    const result = await signalProcessTreePosix(pid, "SIGKILL", {
      ...options,
      alsoSignal: captured,
      alsoSignalIdentities: capturedIdentities,
    });
    forceResultPids = result.pids;
    unverifiable ||= result.tableReadFailed;
    await waitForProcessExit(forceResultPids, settleMs, isAlive);
  } catch {
    unverifiable = true;
  }

  // A failed table read prevents identity verification. A surviving verified
  // SIGKILL target also proves the tree did not stop. The caller's owned
  // process handle cannot target an unrelated process through pid reuse.
  if (unverifiable || forceResultPids.some(isAlive)) {
    onTreeKillFailure?.();
  }
}
