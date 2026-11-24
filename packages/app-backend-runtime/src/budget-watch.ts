// The CPU and memory budgets of a dataset worker's steps, shared between its main thread
// and its budget watch thread as a BigInt64Array of BUDGET_STATE_SLOTS:
// 0. the section: odd while a budgeted step runs, even between steps, and
//    CONDEMNED once the watch has decided to end the worker;
// 1. the step's budget kind: 1 for the app's code, 2 for a dataset check;
// 2. the process CPU time at which the step's charge is zero;
// 3. the step's CPU budget. Times are in microseconds;
// 4. the worker peak RSS ceiling in bytes, or 0 when SQLite enforces hard_heap_limit.
export const BUDGET_STATE_SLOTS = 5;
export const CONDEMNED = -1n;

// File creation publishes the budget in its name, without waiting for a payload write.
export const CPU_BUDGET_MARKER_PREFIX = "cpu-budget-exceeded-";
export const MEMORY_BUDGET_MARKER_PREFIX = "memory-budget-exceeded-";
export type CpuBudgetKind = "app" | "checks";
export type BudgetMarker =
  | { resource: "cpu"; kind: CpuBudgetKind; budgetMs?: number }
  | { resource: "memory"; limitBytes?: number; usedBytes?: number };

export function budgetMarkerName(kind: CpuBudgetKind, budgetMs: number): string {
  return CPU_BUDGET_MARKER_PREFIX + kind + "-" + budgetMs;
}
export function memoryBudgetMarkerName(limitBytes: number, usedBytes: number): string {
  return MEMORY_BUDGET_MARKER_PREFIX + limitBytes + "-" + usedBytes;
}
export function parseBudgetMarkerName(name: string): BudgetMarker | undefined {
  if (name.startsWith(CPU_BUDGET_MARKER_PREFIX)) {
    const suffix = name.slice(CPU_BUDGET_MARKER_PREFIX.length),
      separator = suffix.indexOf("-");
    if (separator === -1) return undefined;
    const kind = suffix.slice(0, separator);
    if (kind !== "app" && kind !== "checks") return undefined;
    const budgetMs = Number(suffix.slice(separator + 1));
    return {
      resource: "cpu",
      kind,
      budgetMs: Number.isSafeInteger(budgetMs) && budgetMs > 0 ? budgetMs : undefined,
    };
  }
  if (name.startsWith(MEMORY_BUDGET_MARKER_PREFIX)) {
    const suffix = name.slice(MEMORY_BUDGET_MARKER_PREFIX.length),
      separator = suffix.indexOf("-");
    if (separator === -1) return undefined;
    const limitBytes = Number(suffix.slice(0, separator));
    const usedBytes = Number(suffix.slice(separator + 1));
    const valid =
      Number.isSafeInteger(limitBytes) &&
      limitBytes > 0 &&
      Number.isSafeInteger(usedBytes) &&
      usedBytes > 0;
    return {
      resource: "memory",
      ...(valid ? { limitBytes, usedBytes } : {}),
    };
  }
  return undefined;
}
export function sqliteEnforcesHardHeapLimit(compileOptions: readonly string[]): boolean {
  return !compileOptions.includes("DEFAULT_MEMSTATUS=0");
}
// On Linux, getrusage().ru_maxrss inherits the forked parent's high-water mark across execve.
// /proc/self/status VmHWM belongs to the child's post-exec address space.
// Sent to the watch thread as source text, so it uses only its parameters and globals.
export function processPeakMemoryBytes(
  platform: NodeJS.Platform,
  rssBytes: () => number,
  maxRssKiB: () => number,
  readProcStatus: () => string,
): bigint {
  const rss = BigInt(rssBytes());
  if (platform === "linux") {
    try {
      const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(readProcStatus());
      if (match) {
        const hwm = BigInt(match[1]!) * 1024n;
        return hwm > rss ? hwm : rss;
      }
    } catch {
      return rss;
    }
    return rss;
  }
  const maxRss = BigInt(maxRssKiB()) * 1024n;
  return maxRss > rss ? maxRss : rss;
}

/** Starts a budgeted step and returns its section. */
export function armBudget(
  state: BigInt64Array,
  kind: bigint,
  origin: bigint,
  budget: bigint,
  memoryLimitBytes = 0n,
): bigint {
  Atomics.store(state, 1, kind);
  Atomics.store(state, 2, origin);
  Atomics.store(state, 3, budget);
  Atomics.store(state, 4, memoryLimitBytes);
  return Atomics.add(state, 0, 1n) + 1n;
}
/** Ends a step within budget. Otherwise it stays armed until the watch ends the worker. */
export function disarmBudget(
  state: BigInt64Array,
  section: bigint,
  cpuMicros: bigint,
  memoryBytes = 0n,
): boolean {
  if (cpuMicros - Atomics.load(state, 2) > Atomics.load(state, 3)) return false;
  const memoryLimit = Atomics.load(state, 4);
  if (memoryLimit > 0n && memoryBytes > memoryLimit) return false;
  return Atomics.compareExchange(state, 0, section, section + 1n) === section;
}

/**
 * Runs on the watch thread, which keeps running while SQLite blocks the main
 * thread. It condemns a step over its CPU or memory budget, then ends the worker.
 * Marker creation is asynchronous and best effort: the kill waits at most `graceMs`,
 * so a stalled disk cannot keep app code running. This function is
 * sent to the thread as source text, so it uses only its parameters and globals.
 */
export function watchBudget(
  state: BigInt64Array,
  cpuMicros: () => bigint,
  memoryBytes: () => bigint,
  writeMarker: (
    exceeded:
      | { resource: "cpu"; kind: CpuBudgetKind; budgetMs: number }
      | { resource: "memory"; limitBytes: number; usedBytes: number },
  ) => Promise<unknown>,
  kill: () => void,
  pollMs: number,
  graceMs: number,
): () => void {
  const timer = setInterval(() => {
    const section = Atomics.load(state, 0);
    if (section % 2n !== 1n) return;
    const kind = Atomics.load(state, 1),
      budget = Atomics.load(state, 3),
      memoryLimit = Atomics.load(state, 4);
    let exceeded:
      | { resource: "cpu"; kind: CpuBudgetKind; budgetMs: number }
      | { resource: "memory"; limitBytes: number; usedBytes: number }
      | undefined;
    if (cpuMicros() - Atomics.load(state, 2) > budget) {
      exceeded = {
        resource: "cpu",
        kind: kind === 1n ? "app" : "checks",
        budgetMs: Number(budget / 1000n),
      };
    } else if (memoryLimit > 0n) {
      const used = memoryBytes();
      if (used > memoryLimit) {
        exceeded = {
          resource: "memory",
          limitBytes: Number(memoryLimit),
          usedBytes: Number(used),
        };
      }
    }
    if (!exceeded) return;
    // The next step stores its budget only after this one ends, so while the
    // section is unchanged the values read above are this step's.
    if (Atomics.compareExchange(state, 0, section, -1n) !== section) return;
    clearInterval(timer);
    const end = setTimeout(kill, graceMs);
    const finish = () => {
      clearTimeout(end);
      kill();
    };
    try {
      writeMarker(exceeded).then(finish, finish);
    } catch {
      finish();
    }
  }, pollMs);
  return () => clearInterval(timer);
}
