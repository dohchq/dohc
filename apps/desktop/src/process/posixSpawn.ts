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

export interface ProcessTableEntry {
  pid: number;
  ppid: number;
}

/** Parses `ps -A -o pid=,ppid=` output. Ignores lines it cannot read. */
export function parseProcessTable(output: string): ProcessTableEntry[] {
  const entries: ProcessTableEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    entries.push({ pid, ppid });
  }
  return entries;
}

/**
 * The root pid and every transitive child, children before their parents so a
 * signalled parent cannot leave a child behind that the next round's
 * enumeration would no longer link to this tree.
 */
export function processTreePids(
  table: readonly ProcessTableEntry[],
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
   * Pids an earlier round already enumerated. Each one is signalled and its
   * own subtree is enumerated again, so a descendant whose parent has since
   * exited — leaving it linked to init rather than to `rootPid` — is still
   * reachable in this round.
   */
  alsoSignal?: readonly number[];
}

/**
 * Every descendant of `rootPid`, enumerated but not signalled — for a
 * caller that wants to keep a rolling snapshot of a still-running tree
 * (siteRunner's stopChild) so a descendant is still reachable by pid even
 * after the process it was captured under has since exited and been
 * reparented away from `rootPid` in the process table. Excludes `rootPid`
 * itself. An unreadable process table degrades to an empty list, the same
 * way killProcessTreePosix degrades to signalling only its known pids.
 */
export async function processDescendantsPosix(
  rootPid: number,
  readProcessTable: () => Promise<string> = readProcessTableWithPs,
): Promise<number[]> {
  try {
    const table = parseProcessTable(await readProcessTable());
    return processTreePids(table, rootPid).filter((pid) => pid !== rootPid);
  } catch {
    return [];
  }
}

function readProcessTableWithPs(): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile("ps", ["-A", "-o", "pid=,ppid="], (error, stdout) => {
      if (error) reject(error);
      else resolveOutput(stdout);
    });
  });
}

/**
 * Signals `rootPid`, every pid in `options.alsoSignal`, and every descendant
 * of them. Enumerates the process table on every call, so a child started
 * after an earlier round still gets signalled. An unreadable process table
 * degrades to signalling those pids alone. Rejects only when the root pid
 * itself could not be signalled. Returns every pid it signalled, which the
 * next round takes as its `alsoSignal` set.
 */
export async function killProcessTreePosix(
  rootPid: number,
  signal: NodeJS.Signals,
  options: KillProcessTreePosixOptions = {},
): Promise<number[]> {
  const readProcessTable = options.readProcessTable ?? readProcessTableWithPs;
  const sendSignal = options.sendSignal ??
    ((pid, pidSignal) => process.kill(pid, pidSignal));
  const roots = [rootPid, ...(options.alsoSignal ?? [])];

  let pids = [...new Set(roots)];
  try {
    const table = parseProcessTable(await readProcessTable());
    pids = [...new Set(roots.flatMap((pid) => processTreePids(table, pid)))];
  } catch {
    // The process table is unavailable. The known pids are still worth
    // signalling.
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
  return pids;
}
