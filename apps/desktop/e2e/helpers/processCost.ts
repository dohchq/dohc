import { readdirSync, readFileSync } from "node:fs";

/** One thread's counters from the kernel, as Linux keeps them under /proc. */
interface ThreadReading {
  process: number;
  name: string;
  ranNs: number;
  wakes: number;
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // The process or thread ended between the listing and the read.
    return null;
  }
}

/** `root` and every process it started, directly or not. */
function processTree(root: number): number[] {
  const parents = new Map<number, number>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    // The name in the second field can hold spaces and brackets, so the fields are read after its last bracket.
    const fields = read(`/proc/${entry}/stat`)?.split(") ").at(-1)?.split(" ");
    if (fields) parents.set(Number(entry), Number(fields[1]));
  }
  const tree = [root];
  for (const parent of tree)
    for (const [child, of] of parents) if (of === parent && !tree.includes(child)) tree.push(child);
  return tree;
}

function readings(processes: readonly number[]): Map<string, ThreadReading> {
  const threads = new Map<string, ThreadReading>();
  for (const pid of processes) {
    let ids: string[];
    try {
      ids = readdirSync(`/proc/${String(pid)}/task`);
    } catch {
      continue;
    }
    for (const id of ids) {
      const base = `/proc/${String(pid)}/task/${id}`;
      const [name, scheduled, status] = [
        read(`${base}/comm`),
        read(`${base}/schedstat`),
        read(`${base}/status`),
      ];
      if (!name || !scheduled || !status) continue;
      threads.set(`${String(pid)}:${id}`, {
        process: pid,
        name: name.trim(),
        ranNs: Number(scheduled.split(" ")[0]),
        // A thread that stops to wait gives up the processor by itself. Each time it runs again is one wake.
        wakes: Number(/^voluntary_ctxt_switches:\s+(\d+)/mu.exec(status)?.[1] ?? 0),
      });
    }
  }
  return threads;
}

function residentKb(pid: number): number {
  return Number(/^VmRSS:\s+(\d+)/mu.exec(read(`/proc/${String(pid)}/status`) ?? "")?.[1] ?? 0);
}

/** What the threads of one name in one process cost. */
export interface ThreadCost {
  process: number;
  /** The thread's name as the kernel keeps it, cut to 15 characters. */
  thread: string;
  threads: number;
  /** Processor time, as a percentage of one core. */
  corePercent: number;
  wakesPerSecond: number;
}

/**
 * What `root` and the processes it started cost over `seconds`, on Linux: for each process, its memory, and for
 * each kind of thread, the processor time it used and how often it woke. Rows are printed busiest first.
 */
export async function processCost(
  label: string,
  root: number,
  seconds: number,
): Promise<ThreadCost[]> {
  const tree = processTree(root);
  const before = readings(tree);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
  const after = readings(tree);
  const kinds = new Map<
    string,
    { process: number; thread: string; ranMs: number; wakes: number; threads: number }
  >();
  for (const [key, now] of after) {
    const then = before.get(key);
    if (!then) continue;
    const kind = `${String(now.process)} ${now.name}`;
    const sum = kinds.get(kind) ?? {
      process: now.process,
      thread: now.name,
      ranMs: 0,
      wakes: 0,
      threads: 0,
    };
    sum.ranMs += (now.ranNs - then.ranNs) / 1e6;
    sum.wakes += now.wakes - then.wakes;
    sum.threads += 1;
    kinds.set(kind, sum);
  }
  const total = [...kinds.values()].reduce(
    (sum, kind) => ({ ranMs: sum.ranMs + kind.ranMs, wakes: sum.wakes + kind.wakes }),
    { ranMs: 0, wakes: 0 },
  );
  console.log(
    `IDLE ${label}: over ${String(seconds)} s the server's ${String(tree.length)} processes used ${(total.ranMs / seconds / 10).toFixed(2)}% of one core and woke ${(total.wakes / seconds).toFixed(1)} times a second`,
  );
  for (const pid of tree) {
    const command = (read(`/proc/${String(pid)}/cmdline`) ?? "")
      .replaceAll("\0", " ")
      .replaceAll(/[A-Za-z0-9_-]{24,}/gu, "<long>")
      .slice(0, 110);
    console.log(
      `IDLE ${label}:   process ${String(pid)} holds ${String(Math.round(residentKb(pid) / 1024))} MB: ${command}`,
    );
  }
  const costs = [...kinds.values()]
    .sort((a, b) => b.ranMs - a.ranMs)
    .map((sum) => ({
      process: sum.process,
      thread: sum.thread,
      threads: sum.threads,
      corePercent: sum.ranMs / seconds / 10,
      wakesPerSecond: sum.wakes / seconds,
    }));
  for (const cost of costs) {
    if (cost.corePercent < 0.001 && cost.wakesPerSecond < 0.1) continue;
    console.log(
      `IDLE ${label}:   ${cost.corePercent.toFixed(2)}% of one core, ${cost.wakesPerSecond.toFixed(1)} wakes a second: ${String(cost.process)} ${cost.thread} x${String(cost.threads)}`,
    );
  }
  return costs;
}
