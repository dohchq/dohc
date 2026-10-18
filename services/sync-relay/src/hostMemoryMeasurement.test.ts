import {afterEach, describe, expect, it, vi} from "vitest";
import {createHostMemoryBudget} from "./hostMemoryBudget";
import {discoverHostCgroup, readCgroupMemoryLimit, startHostMemoryMeasurement, type HostMemoryFiles} from "./hostMemoryMeasurement";

const MiB = 1024 * 1024;
const cgroup2 = (root: string, mountPoint: string) => `30 25 0:26 ${root} ${mountPoint} rw,nosuid,nodev,noexec,relatime shared:4 - cgroup2 cgroup2 rw,nsdelegate`;
const unrelated = "22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/root rw\n26 25 0:23 / /sys/fs/cgroup/memory rw,nosuid shared:8 - cgroup cgroup rw,memory";
// A fixture tree: a string is a file's contents, and an Error is a read that fails.
function tree(files: Record<string, string | Error>) {
  const reads: string[] = [];
  const fixture: HostMemoryFiles & {reads: string[]} = {reads, async readFile(path) {
    reads.push(path);
    const value = files[path];
    if (value === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), {code: "ENOENT"});
    if (value instanceof Error) throw value;
    return value;
  }};
  return fixture;
}

describe("cgroup v2 discovery", () => {
  it("finds a namespaced container's cgroup at the mount point", async () => {
    const files = tree({"/proc/self/cgroup": "0::/\n", "/proc/self/mountinfo": `${unrelated}\n${cgroup2("/", "/sys/fs/cgroup")}\n`,
      "/sys/fs/cgroup/memory.current": "1048576\n"});
    expect(await discoverHostCgroup(files, "linux")).toEqual({directory: "/sys/fs/cgroup", mountPoint: "/sys/fs/cgroup"});
  });

  it("finds a nested cgroup on a host with v1 lines beside the v2 line", async () => {
    const files = tree({"/proc/self/cgroup": "12:memory:/system.slice/dohc.service\n0::/system.slice/dohc.service\n",
      "/proc/self/mountinfo": `${unrelated}\n${cgroup2("/", "/sys/fs/cgroup")}\n`, "/sys/fs/cgroup/system.slice/dohc.service/memory.current": "1"});
    expect(await discoverHostCgroup(files, "linux")).toEqual({directory: "/sys/fs/cgroup/system.slice/dohc.service", mountPoint: "/sys/fs/cgroup"});
  });

  it("maps a cgroup path through the mount's root and decodes escaped mount points", async () => {
    const files = tree({"/proc/self/cgroup": "0::/docker/abc/inner\n", "/proc/self/mountinfo": cgroup2("/docker/abc", "/mnt/cgroup\\040v2"),
      "/mnt/cgroup v2/inner/memory.current": "1"});
    expect(await discoverHostCgroup(files, "linux")).toEqual({directory: "/mnt/cgroup v2/inner", mountPoint: "/mnt/cgroup v2"});
  });

  it("chooses the mount that shows the most ancestors, whatever the mount order", async () => {
    const leaf = cgroup2("/docker/abc", "/sys/fs/cgroup"), parent = cgroup2("/docker", "/mnt/parent");
    for (const order of [[leaf, parent], [parent, leaf]]) {
      const files = tree({"/proc/self/cgroup": "0::/docker/abc\n", "/proc/self/mountinfo": order.join("\n"),
        "/sys/fs/cgroup/memory.current": "1", "/sys/fs/cgroup/memory.max": "max\n",
        "/mnt/parent/abc/memory.current": "1", "/mnt/parent/abc/memory.max": "max\n", "/mnt/parent/memory.max": `${512 * MiB}\n`});
      const cgroup = await discoverHostCgroup(files, "linux");
      expect(cgroup).toEqual({directory: "/mnt/parent/abc", mountPoint: "/mnt/parent"});
      expect(await readCgroupMemoryLimit(cgroup!, files)).toBe(512 * MiB);
    }
  });

  it("skips a mount without the memory controller and uses another", async () => {
    const files = tree({"/proc/self/cgroup": "0::/docker/abc\n",
      "/proc/self/mountinfo": [cgroup2("/", "/sys/fs/cgroup"), cgroup2("/docker/abc", "/mnt/leaf")].join("\n"), "/mnt/leaf/memory.current": "1"});
    expect(await discoverHostCgroup(files, "linux")).toEqual({directory: "/mnt/leaf", mountPoint: "/mnt/leaf"});
  });

  it("reports no cgroup off Linux without reading anything", async () => {
    const files = tree({});
    for (const platform of ["win32", "darwin"] as const) expect(await discoverHostCgroup(files, platform)).toBeUndefined();
    expect(files.reads).toEqual([]);
  });

  it("reports no cgroup when v2 is missing, unmounted, outside the mount, or unreadable", async () => {
    const cases: Record<string, string | Error>[] = [
      {"/proc/self/cgroup": "12:memory:/docker/abc\n", "/proc/self/mountinfo": cgroup2("/", "/sys/fs/cgroup")},
      {"/proc/self/cgroup": "0::/\n", "/proc/self/mountinfo": unrelated},
      {"/proc/self/cgroup": "0::/other\n", "/proc/self/mountinfo": cgroup2("/docker/abc", "/sys/fs/cgroup")},
      {"/proc/self/cgroup": new Error("EACCES"), "/proc/self/mountinfo": cgroup2("/", "/sys/fs/cgroup")},
      {"/proc/self/cgroup": "0::/\n", "/proc/self/mountinfo": new Error("EACCES")},
      {"/proc/self/cgroup": "0::/\n", "/proc/self/mountinfo": cgroup2("/", "/sys/fs/cgroup")},
      {"/proc/self/cgroup": "0::/\n", "/proc/self/mountinfo": cgroup2("/", "/sys/fs/cgroup"), "/sys/fs/cgroup/memory.current": "garbage"},
    ];
    for (const files of cases) expect(await discoverHostCgroup(tree(files), "linux"), JSON.stringify(files)).toBeUndefined();
  });
});

describe("cgroup memory limit", () => {
  const cgroup = {directory: "/sys/fs/cgroup/a/b/c", mountPoint: "/sys/fs/cgroup"};

  it("takes the lowest finite memory.max among the cgroup and its ancestors, and stops at the mount point", async () => {
    const files = tree({"/sys/fs/cgroup/a/b/c/memory.max": "max\n", "/sys/fs/cgroup/a/b/memory.max": `${4096 * MiB}\n`,
      "/sys/fs/cgroup/a/memory.max": `${2048 * MiB}\n`, "/sys/fs/cgroup/memory.max": `${3072 * MiB}\n`, "/sys/fs/memory.max": "1\n"});
    expect(await readCgroupMemoryLimit(cgroup, files)).toBe(2048 * MiB);
    expect(files.reads).not.toContain("/sys/fs/memory.max");
  });

  it("treats max as no limit and skips missing or unreadable levels", async () => {
    expect(await readCgroupMemoryLimit(cgroup, tree({"/sys/fs/cgroup/a/b/c/memory.max": "max\n", "/sys/fs/cgroup/a/memory.max": "max"}))).toBeUndefined();
    expect(await readCgroupMemoryLimit(cgroup, tree({"/sys/fs/cgroup/a/b/c/memory.max": new Error("EACCES"),
      "/sys/fs/cgroup/a/b/memory.max": `${1024 * MiB}`}))).toBe(1024 * MiB);
  });
});

describe("sampling", () => {
  afterEach(() => {vi.useRealTimers();});
  const cgroup = {directory: "/sys/fs/cgroup", mountPoint: "/sys/fs/cgroup"};
  const healthy = () => ({"/sys/fs/cgroup/memory.current": `${700 * MiB}\n`, "/sys/fs/cgroup/memory.max": `${2048 * MiB}\n`,
    "/sys/fs/cgroup/memory.stat": `file 1000\nanon ${400 * MiB}\nanon_thp 0\n`} as Record<string, string | Error>);

  it("reads the cgroup's figures and reports relay RSS beside them, never added to them", async () => {
    // Validation workers are threads, so relay RSS already includes them and the cgroup already includes the relay.
    const measurement = startHostMemoryMeasurement({cgroup, files: tree(healthy()), rss: () => 300 * MiB, now: () => 5_000, intervalMs: 60_000});
    try {
      await measurement.sampleNow();
      expect(measurement.source).toBe("cgroup-v2");
      expect(measurement.latest()).toEqual({ageMs: 0, sample: {takenAtMs: 5_000, relayRssBytes: 300 * MiB,
        aggregate: {currentBytes: 700 * MiB, anonymousBytes: 400 * MiB, limitBytes: 2048 * MiB}}});
    } finally {await measurement.close();}
  });

  it("reports relay RSS alone and marks the aggregate unavailable without a cgroup", async () => {
    const measurement = startHostMemoryMeasurement({cgroup: undefined, rss: () => 123, now: () => 1, intervalMs: 60_000});
    try {
      await measurement.sampleNow();
      expect(measurement.source).toBe("relay-rss");
      expect(measurement.latest()?.sample).toEqual({takenAtMs: 1, relayRssBytes: 123, aggregate: null});
    } finally {await measurement.close();}
  });

  it("keeps the last sample and its age when a later sample fails", async () => {
    let time = 1_000;
    const files = healthy();
    const measurement = startHostMemoryMeasurement({cgroup, files: tree(files), rss: () => 1, now: () => time, intervalMs: 60_000});
    try {
      expect(measurement.latest()).toBeUndefined();
      await measurement.sampleNow();
      files["/sys/fs/cgroup/memory.current"] = new Error("EIO");
      time = 5_000;
      await measurement.sampleNow();
      expect(measurement.latest()).toMatchObject({ageMs: 4_000, sample: {takenAtMs: 1_000}});
    } finally {await measurement.close();}
  });

  it("samples once per second on its own", async () => {
    vi.useFakeTimers();
    const files = tree(healthy());
    const measurement = startHostMemoryMeasurement({cgroup, files, rss: () => 1});
    try {
      await vi.advanceTimersByTimeAsync(999);
      expect(measurement.latest()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(measurement.latest()?.sample.aggregate?.currentBytes).toBe(700 * MiB);
      const reads = files.reads.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(files.reads.length).toBeGreaterThan(reads);
    } finally {await measurement.close();}
  });

  it("never refuses admission when a sample is missing, failed, or stale", async () => {
    const memory = createHostMemoryBudget({effectiveBytes: 1024 * MiB, baselineBytes: 0}), engine = memory.startEngine();
    const measurement = startHostMemoryMeasurement({cgroup, files: tree({}), rss: () => 4096 * MiB, now: () => 10 ** 9, intervalMs: 60_000});
    try {
      expect(engine.reserveTemporary(MiB).ok).toBe(true);
      await measurement.sampleNow();
      expect(measurement.latest()).toBeUndefined();
      expect(engine.reserveTemporary(MiB).ok).toBe(true);
    } finally {await measurement.close();}
  });
});
