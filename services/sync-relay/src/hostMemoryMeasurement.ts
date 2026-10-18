import {readFile} from "node:fs/promises";
import {posix} from "node:path";

/** Reads a text file. Tests substitute a fixture cgroup tree. */
export type HostMemoryFiles = {readFile(path: string): Promise<string>};
const nodeFiles: HostMemoryFiles = {readFile: path => readFile(path, "utf8")};

/** The relay's cgroup v2 folder, and the mount point above which no ancestor is visible. */
export type HostCgroup = {directory: string; mountPoint: string};

/** One diagnostic sample. It never decides admission. */
export type HostMemorySample = {
  takenAtMs: number;
  /** The relay process alone. Validation workers are threads, so this already includes them. */
  relayRssBytes: number;
  /** The cgroup's figures, which include the engine processes. Null without a usable cgroup v2. */
  aggregate: {currentBytes: number; anonymousBytes: number; limitBytes: number | null} | null;
};

const unescapeMount = (value: string) => value.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
const bytes = (text: string) => /^\d+$/u.test(text.trim()) ? Number(text.trim()) : undefined;

/** Finds the relay's cgroup v2 folder through /proc/self/cgroup and the mount table. Returns undefined when none is usable. */
export async function discoverHostCgroup(files: HostMemoryFiles = nodeFiles, platform: NodeJS.Platform = process.platform): Promise<HostCgroup | undefined> {
  if (platform !== "linux") return undefined;
  try {
    const path = (await files.readFile("/proc/self/cgroup")).split("\n").find(line => line.startsWith("0::"))?.slice(3);
    if (!path?.startsWith("/")) return undefined;
    for (const line of (await files.readFile("/proc/self/mountinfo")).split("\n")) {
      const fields = line.split(" "), separator = fields.indexOf("-");
      if (separator < 0 || fields[separator + 1] !== "cgroup2") continue;
      const root = unescapeMount(fields[3]!), mountPoint = unescapeMount(fields[4]!);
      const inside = root === "/" ? path : path === root ? "/" : path.startsWith(`${root}/`) ? path.slice(root.length) : undefined;
      if (inside === undefined) continue;
      const cgroup = {directory: inside === "/" ? mountPoint : posix.join(mountPoint, inside), mountPoint};
      // A folder without the memory controller cannot be measured.
      if (bytes(await files.readFile(posix.join(cgroup.directory, "memory.current"))) === undefined) return undefined;
      return cgroup;
    }
  } catch {}
  return undefined;
}

/** The lowest finite memory.max among the cgroup and its visible ancestors. */
export async function readCgroupMemoryLimit(cgroup: HostCgroup, files: HostMemoryFiles = nodeFiles): Promise<number | undefined> {
  let lowest: number | undefined;
  for (let directory = cgroup.directory; ; directory = posix.dirname(directory)) {
    // The root cgroup has no memory.max, and "max" means no limit.
    const limit = await files.readFile(posix.join(directory, "memory.max")).then(bytes, () => undefined);
    if (limit !== undefined && (lowest === undefined || limit < lowest)) lowest = limit;
    if (directory === cgroup.mountPoint || directory === posix.dirname(directory)) return lowest;
  }
}

async function readAggregate(cgroup: HostCgroup, files: HostMemoryFiles): Promise<NonNullable<HostMemorySample["aggregate"]>> {
  const [current, stat, limit] = await Promise.all([files.readFile(posix.join(cgroup.directory, "memory.current")),
    files.readFile(posix.join(cgroup.directory, "memory.stat")), readCgroupMemoryLimit(cgroup, files)]);
  const currentBytes = bytes(current), anonymousBytes = bytes(/^anon (\d+)$/mu.exec(stat)?.[1] ?? "");
  if (currentBytes === undefined || anonymousBytes === undefined) throw new Error("The cgroup's memory files are unreadable.");
  return {currentBytes, anonymousBytes, limitBytes: limit ?? null};
}

/**
 * Samples memory once per interval for operator diagnostics, off the
 * admission path. A failed sample keeps the previous one.
 */
export function startHostMemoryMeasurement(options: {
  cgroup: HostCgroup | undefined; files?: HostMemoryFiles; rss?: () => number; now?: () => number; intervalMs?: number;
}) {
  const {cgroup} = options, files = options.files ?? nodeFiles, now = options.now ?? Date.now;
  const rss = options.rss ?? (() => process.memoryUsage().rss);
  let last: HostMemorySample | undefined, running: Promise<void> | undefined;
  const sample = async () => {
    try {
      const aggregate = cgroup ? await readAggregate(cgroup, files) : null;
      last = {takenAtMs: now(), relayRssBytes: rss(), aggregate};
    } catch {}
  };
  const sampleNow = () => running ??= sample().finally(() => {running = undefined;});
  const timer = setInterval(() => {void sampleNow();}, options.intervalMs ?? 1_000);
  timer.unref();
  return {
    source: cgroup ? "cgroup-v2" as const : "relay-rss" as const,
    /** Takes a sample now, or joins the one in progress. */
    sampleNow,
    /** The last sample and its age, or undefined before the first one. */
    latest() {return last && {sample: last, ageMs: now() - last.takenAtMs};},
    async close() {clearInterval(timer); await running;},
  };
}
