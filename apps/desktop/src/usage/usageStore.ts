import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  UsageAppVersion, UsageCoverageInput, UsageInvocation, UsageSnapshot,
  USAGE_MAX_COUNT, USAGE_RETENTION_DAYS, localUsageDay, queryUsage, usageRowKey,
  type UsageCount, type UsageCoverage, type UsageDayRecord, type UsageQuery,
} from "@dohc/workspace-contracts/usage";

export const USAGE_WRITE_INTERVAL_MS = 30_000;
export const USAGE_SNAPSHOT_NAME = "dohc-usage.json";

export interface UsageFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string, options: { mode: number }): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  rm(path: string, options: { force: true }): Promise<unknown>;
}

// Main owns one instance. PR 2 supplies stateDir() after editable readiness.
// Construction and recording before load perform no I/O and start no timers.
export function createUsageStore(deps: {
  stateDir(): string;
  appVersion: string;
  now?: () => Date;
  io?: UsageFileSystem;
  onWriteFailure?: () => void;
}) {
  const appVersion = UsageAppVersion.parse(deps.appVersion);
  const io = deps.io ?? fs;
  const now = deps.now ?? (() => new Date());
  const days = new Map<string, UsageDayRecord>();
  const counts = new Map<string, UsageCount>();
  const coverage = new Map<string, UsageCoverage>();
  let enabled = true;
  let loaded = false;
  let activeDay: string | undefined;
  let loading: Promise<void> | undefined;
  let directory: string;
  let path: string;
  let revision = 0;
  let savedRevision = 0;
  let lastWriteAt = -Infinity;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  let dayTimer: ReturnType<typeof setTimeout> | undefined;
  let serial = Promise.resolve();
  let controls = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;

  function enqueue(task: () => Promise<void>): Promise<void> {
    const result = serial.then(task);
    serial = result.catch(() => {});
    return result;
  }

  function scheduleWrite() {
    if (closing || writeTimer || revision === savedRevision) return;
    const delay = Math.max(USAGE_WRITE_INTERVAL_MS, lastWriteAt + USAGE_WRITE_INTERVAL_MS - now().getTime());
    writeTimer = setTimeout(() => {
      writeTimer = undefined;
      void enqueue(async () => {
        if (now().getTime() - lastWriteAt < USAGE_WRITE_INTERVAL_MS) { scheduleWrite(); return; }
        await write();
      }).catch(() => {});
    }, delay);
    writeTimer.unref?.();
  }

  function changed() {
    revision++;
    if (loaded) scheduleWrite();
  }

  function incompleteToday() {
    const today = localUsageDay(now());
    for (const row of coverage.values()) {
      if (row.day === today && row.status === "covered") {
        row.status = "incomplete";
        changed();
      }
    }
  }

  function refreshDay() {
    const today = localUsageDay(now());
    if (activeDay === today && days.has(today)) return;
    const cutoff = new Date(now());
    cutoff.setDate(cutoff.getDate() - (USAGE_RETENTION_DAYS - 1));
    const oldest = localUsageDay(cutoff);
    for (const map of [days, counts, coverage]) {
      for (const [key, row] of map) {
        if (row.day < oldest || row.day > today) {
          map.delete(key);
          changed();
        }
      }
    }
    const current = days.get(today);
    if (!current) {
      days.set(today, { day: today, appVersions: [appVersion], collection: enabled ? "on" : "off" });
      changed();
    } else if (!current.appVersions.includes(appVersion)) {
      if (current.appVersions.length >= 90) throw new Error("Too many app versions in one usage day");
      current.appVersions.push(appVersion);
      changed();
    }
    activeDay = today;
  }

  function scheduleDay() {
    if (closing) return;
    if (dayTimer) clearTimeout(dayTimer);
    const date = now();
    const midnight = new Date(date);
    midnight.setHours(24, 0, 0, 0);
    dayTimer = setTimeout(() => {
      dayTimer = undefined;
      refreshDay();
      scheduleDay();
    }, Math.max(1, midnight.getTime() - date.getTime()));
    dayTimer.unref?.();
  }

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      directory = deps.stateDir();
      path = join(directory, USAGE_SNAPSHOT_NAME);
      let raw: string | undefined;
      try {
        raw = await io.readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (raw !== undefined) {
        const snapshot = UsageSnapshot.parse(JSON.parse(raw));
        enabled = snapshot.enabled;
        for (const row of snapshot.days) days.set(row.day, row);
        for (const row of snapshot.counts) counts.set(usageRowKey(row), row);
        for (const row of snapshot.coverage) coverage.set(usageRowKey(row), row);
      }
      refreshDay();
      // A restart cannot prove that no completions were lost before this load.
      incompleteToday();
      loaded = true;
      scheduleWrite();
      scheduleDay();
    })();
    try {
      await loading;
    } catch (error) {
      loading = undefined;
      throw error;
    }
  }

  function snapshot(): UsageSnapshot {
    return {
      version: 1, enabled,
      days: [...days.values()].map(row => ({ day: row.day, appVersions: row.appVersions.slice(), collection: row.collection })),
      counts: [...counts.values()].map(row => ({ day: row.day, capabilityId: row.capabilityId, door: row.door, count: row.count })),
      coverage: [...coverage.values()].map(row => ({ day: row.day, capabilityId: row.capabilityId, door: row.door, status: row.status })),
    };
  }

  async function write() {
    if (!loaded) return;
    refreshDay();
    if (revision === savedRevision) return;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = undefined;
    const writingRevision = revision;
    lastWriteAt = now().getTime();
    try {
      const data = JSON.stringify(UsageSnapshot.parse(snapshot()));
      await io.mkdir(directory, { recursive: true });
      await io.writeFile(path + ".tmp", data, { mode: 0o600 });
      await io.rename(path + ".tmp", path);
      savedRevision = writingRevision;
    } catch (error) {
      incompleteToday();
      try { deps.onWriteFailure?.(); } catch { /* Reporting cannot replace the write failure. */ }
      throw error;
    } finally {
      scheduleWrite();
    }
  }

  function control(change: () => Promise<void>): Promise<void> {
    if (closing) return Promise.reject(new Error("Usage store is closed"));
    // Close admission at call time, including while another write is pending.
    controls++;
    return enqueue(async () => {
      await load();
      refreshDay();
      await change();
    }).finally(() => { controls--; });
  }

  return {
    load: () => closing ? Promise.reject(new Error("Usage store is closed")) : load(),
    recordSuccess(input: unknown): boolean {
      if (!loaded || closing || controls) return false;
      refreshDay();
      if (!enabled) return false;
      const parsed = UsageInvocation.safeParse(input);
      if (!parsed.success) return false;
      const row = { day: localUsageDay(now()), ...parsed.data };
      const key = usageRowKey(row);
      const current = counts.get(key)?.count ?? 0;
      if (current >= USAGE_MAX_COUNT) {
        incompleteToday();
        return false;
      }
      counts.set(key, { ...row, count: current + 1 });
      changed();
      return true;
    },
    setCoverage(input: unknown): boolean {
      if (!loaded || closing || controls) return false;
      const parsed = UsageCoverageInput.safeParse(input);
      if (!parsed.success) return false;
      if (parsed.data.status === "covered" && !UsageInvocation.safeParse({
        capabilityId: parsed.data.capabilityId, door: parsed.data.door,
      }).success) return false;
      refreshDay();
      const day = localUsageDay(now());
      const row = { day, ...parsed.data };
      const key = usageRowKey(row);
      const current = coverage.get(key);
      // A gap cannot be erased later in the same day.
      if (row.status === "covered" && (!enabled || days.get(day)?.collection !== "on"
        || current && current.status !== "covered")) return false;
      if (current?.status === "incomplete" || current?.status === "off") return row.status === current.status;
      if (current?.status === row.status) return true;
      coverage.set(key, row);
      changed();
      return true;
    },
    async query(input: UsageQuery) {
      if (closing) throw new Error("Usage store is closed");
      await load();
      refreshDay();
      return queryUsage(snapshot(), input);
    },
    async read(): Promise<UsageSnapshot> {
      if (closing) throw new Error("Usage store is closed");
      await load();
      refreshDay();
      return snapshot();
    },
    setEnabled(value: boolean): Promise<void> {
      if (typeof value !== "boolean") return Promise.reject(new Error("Invalid usage setting"));
      return control(async () => {
        if (enabled !== value) {
          enabled = value;
          days.get(localUsageDay(now()))!.collection = "partial";
          incompleteToday();
          changed();
        }
        await write();
      });
    },
    clear(): Promise<void> {
      return control(async () => {
        counts.clear();
        coverage.clear();
        days.clear();
        refreshDay();
        if (enabled) days.get(localUsageDay(now()))!.collection = "partial";
        changed();
        // Remove the only temporary filename this single writer can create.
        await io.rm(path + ".tmp", { force: true });
        await write();
      });
    },
    flush(): Promise<void> {
      if (closing) return Promise.reject(new Error("Usage store is closed"));
      return enqueue(async () => { await load(); await write(); });
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      if (writeTimer) clearTimeout(writeTimer);
      if (dayTimer) clearTimeout(dayTimer);
      writeTimer = undefined;
      dayTimer = undefined;
      // Do not initialize an unused store just because main is exiting.
      closePromise = enqueue(async () => { if (loading) await loading; await write(); });
      return closePromise;
    },
  };
}
