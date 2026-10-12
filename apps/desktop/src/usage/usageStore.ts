import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  UsageAppVersion, UsageInvocation, UsageVersionCoverage, decodeUsageSnapshot,
  USAGE_MAX_COUNT, USAGE_RETENTION_DAYS, localUsageDay, queryUsage, usageRowKey,
  type UsageBuildPair, type UsageCount, type UsageDayRecord, type UsageQuery, type UsageSnapshot,
} from "@dohc/workspace-contracts/usage";

export const USAGE_WRITE_INTERVAL_MS = 30_000;
export const USAGE_PENDING_LIMIT = 256;
export const USAGE_SNAPSHOT_NAME = "dohc-usage.json";
export interface UsageFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string, options: { mode: number }): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  rm(path: string, options: { force: true }): Promise<unknown>;
}

// Main supplies the fixed coverage mapping for this build.
// Early successes queue only aggregates until the saved setting is loaded.
export function createUsageStore(deps: {
  stateDir(): string;
  appVersion: string;
  coverage?: readonly UsageBuildPair[];
  now?: () => Date;
  io?: UsageFileSystem;
  onWriteFailure?: () => void;
}) {
  const appVersion = UsageAppVersion.parse(deps.appVersion);
  const buildCoverage = UsageVersionCoverage.parse({ appVersion, pairs: deps.coverage ?? [] });
  const io = deps.io ?? fs;
  const now = deps.now ?? (() => new Date());
  const days = new Map<string, UsageDayRecord>();
  const counts = new Map<string, UsageCount>();
  const coverage = new Map<string, UsageVersionCoverage>();
  const pending: UsageCount[] = [];
  let pendingOverflow = false;
  let enabled = true;
  let loaded = false;
  let admissionReady = false;
  let unreadable: { error: unknown } | undefined;
  let activeDay: string | undefined;
  let loading: Promise<void> | undefined;
  let directory: string;
  let path: string;
  let revision = 0;
  let savedRevision = 0;
  let committedCleanExit = true;
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
  function changed() {
    revision++;
    if (loaded) scheduleWrite();
  }
  function scheduleWrite() {
    if (closing || writeTimer || revision === savedRevision && !committedCleanExit) return;
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
  function incomplete(day = localUsageDay(now())) {
    const record = days.get(day);
    if (record?.complete) { record.complete = false; changed(); }
  }
  function touchDay(day: string) {
    const current = days.get(day);
    if (!current) {
      days.set(day, { day, appVersions: [appVersion], complete: enabled });
      changed();
    } else if (!current.appVersions.includes(appVersion)) {
      if (current.appVersions.length >= 90) { incomplete(day); return; }
      current.appVersions.push(appVersion);
      changed();
    }
  }
  function oldestDay() {
    const cutoff = new Date(now());
    cutoff.setDate(cutoff.getDate() - (USAGE_RETENTION_DAYS - 1));
    return localUsageDay(cutoff);
  }
  function refreshDay() {
    const today = localUsageDay(now());
    if (activeDay === today && days.has(today)) return;
    const oldest = oldestDay();
    for (const map of [days, counts]) {
      for (const [key, row] of map) {
        if (row.day < oldest) { map.delete(key); changed(); }
      }
    }
    const versions = new Set([...days.values()].flatMap(day => day.appVersions));
    for (const version of coverage.keys()) {
      if (version !== appVersion && !versions.has(version)) { coverage.delete(version); changed(); }
    }
    touchDay(today);
    activeDay = today;
  }
  function scheduleDay() {
    if (closing) return;
    if (dayTimer) clearTimeout(dayTimer);
    const date = now();
    const midnight = new Date(date);
    midnight.setHours(24, 0, 0, 0);
    dayTimer = setTimeout(() => { dayTimer = undefined; refreshDay(); scheduleDay(); },
      Math.max(1, midnight.getTime() - date.getTime()));
    dayTimer.unref?.();
  }
  function increment(row: UsageCount): boolean {
    touchDay(row.day);
    const key = usageRowKey(row);
    const current = counts.get(key)?.count ?? 0;
    if (current >= USAGE_MAX_COUNT) { incomplete(row.day); return false; }
    counts.set(key, { ...row, count: current + 1 });
    changed();
    return true;
  }
  function applyPending() {
    if (enabled) {
      const oldest = oldestDay();
      for (const row of pending) {
        if (row.day < oldest) continue;
        increment(row);
        if (pendingOverflow) incomplete(row.day);
      }
      if (pendingOverflow) incomplete();
    }
    pending.length = 0;
    pendingOverflow = false;
  }
  function pause(error: unknown) {
    unreadable = { error };
    enabled = false;
    pending.length = 0;
    pendingOverflow = false;
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
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          // Stay inert until a control retries the read. Never replace
          // a record whose contents and saved setting we could not inspect.
          pause(error);
          return;
        }
      }
      unreadable = undefined;
      enabled = true;
      let restored: UsageSnapshot | undefined;
      if (raw !== undefined) {
        try { restored = decodeUsageSnapshot(JSON.parse(raw)); }
        catch (error) {
          pause(Object.assign(new Error("Usage record could not be decoded", { cause: error }),
            { code: "INVALID_USAGE_RECORD" }));
          return;
        }
      }
      if (restored) {
        enabled = restored.enabled;
        committedCleanExit = restored.cleanExit;
        for (const row of restored.days) days.set(row.day, row);
        for (const row of restored.counts) counts.set(usageRowKey(row), row);
        for (const version of restored.coverage) coverage.set(version.appVersion, version);
      }
      coverage.set(appVersion, buildCoverage);
      changed();
      refreshDay();
      if (!restored || !restored.cleanExit) {
        // An unflushed crash can straddle midnight. Preserve both days' gaps.
        const previous = restored?.days.map(day => day.day).filter(day => day <= localUsageDay(now())).sort().at(-1);
        if (previous && restored && !restored.cleanExit) incomplete(previous);
        incomplete();
      }
      loaded = true;
      // Invalidate the clean marker before admitting counts, even on an idle launch.
      await write().catch(() => {});
      scheduleDay();
    })();
    return loading;
  }
  function snapshot(cleanExit = false): UsageSnapshot {
    return { version: 1, enabled, cleanExit,
      days: [...days.values()].map(row => ({ day: row.day, appVersions: row.appVersions.slice(), complete: row.complete })),
      counts: [...counts.values()].map(row => ({ day: row.day, capabilityId: row.capabilityId, door: row.door, count: row.count })),
      coverage: [...coverage.values()].map(version => ({ appVersion: version.appVersion,
        pairs: version.pairs.map(pair => ({ capabilityId: pair.capabilityId, door: pair.door, status: pair.status })) })),
    };
  }
  async function write(cleanExit = false) {
    if (!loaded) return;
    refreshDay();
    if (cleanExit) applyPending();
    if (revision === savedRevision && cleanExit === committedCleanExit) return;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = undefined;
    const writingRevision = revision;
    lastWriteAt = now().getTime();
    try {
      // Maps contain only validated aggregates; avoid re-validating the whole store.
      const data = JSON.stringify(snapshot(cleanExit));
      await io.mkdir(directory, { recursive: true });
      await io.writeFile(path + ".tmp", data, { mode: 0o600 });
      await io.rename(path + ".tmp", path);
      savedRevision = writingRevision;
      committedCleanExit = cleanExit;
      admissionReady = !cleanExit;
      if (admissionReady) applyPending();
    } catch (error) {
      incomplete();
      try { deps.onWriteFailure?.(); } catch { /* Preserve the write error. */ }
      throw error;
    } finally { scheduleWrite(); }
  }
  function requireReadable() {
    if (unreadable) throw unreadable.error;
  }
  function control(change: () => Promise<void>): Promise<void> {
    if (closing) return Promise.reject(new Error("Usage store is closed"));
    controls++;
    return enqueue(async () => {
      if (unreadable) loading = undefined;
      await load(); requireReadable(); refreshDay(); await change();
    })
      .finally(() => { controls--; });
  }
  return {
    load: () => closing ? Promise.reject(new Error("Usage store is closed")) : load(),
    recordSuccess(input: unknown): boolean {
      if (closing || controls || unreadable) return false;
      const parsed = UsageInvocation.safeParse(input);
      if (!parsed.success) return false;
      const row = { day: localUsageDay(now()), ...parsed.data, count: 1 };
      if (loaded) { refreshDay(); if (!enabled) return false; }
      if (!loaded || !admissionReady) {
        if (pending.length >= USAGE_PENDING_LIMIT) { pendingOverflow = true; return false; }
        pending.push(row);
        return true;
      }
      return increment(row);
    },
    async query(input: UsageQuery) {
      if (closing) throw new Error("Usage store is closed");
      await load(); requireReadable(); refreshDay();
      return queryUsage(snapshot(), input);
    },
    async read(): Promise<UsageSnapshot> {
      if (closing) throw new Error("Usage store is closed");
      await load(); requireReadable(); refreshDay();
      return snapshot();
    },
    setEnabled(value: boolean): Promise<void> {
      if (typeof value !== "boolean") return Promise.reject(new Error("Invalid usage setting"));
      return control(async () => {
        const previous = enabled;
        if (enabled !== value) { enabled = value; incomplete(); changed(); }
        if (!enabled) { pending.length = 0; pendingOverflow = false; }
        try {
          await write();
        } catch (error) {
          // The file keeps the old setting, so memory keeps it too.
          if (enabled !== previous) { enabled = previous; changed(); }
          throw error;
        }
      });
    },
    clear(): Promise<void> {
      return control(async () => {
        const saved = { days: [...days], counts: [...counts], coverage: [...coverage] };
        pending.length = 0; pendingOverflow = false;
        counts.clear(); days.clear(); coverage.clear();
        coverage.set(appVersion, buildCoverage);
        refreshDay(); incomplete(); changed();
        try {
          await io.rm(path + ".tmp", { force: true });
          await write();
        } catch (error) {
          // The file keeps the old counts, so memory keeps them too.
          days.clear(); counts.clear(); coverage.clear();
          for (const [key, row] of saved.days) days.set(key, row);
          for (const [key, row] of saved.counts) counts.set(key, row);
          for (const [key, row] of saved.coverage) coverage.set(key, row);
          incomplete(); changed();
          throw error;
        }
      });
    },
    flush(): Promise<void> {
      if (closing) return Promise.reject(new Error("Usage store is closed"));
      return enqueue(async () => { await load(); requireReadable(); await write(); });
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      if (writeTimer) clearTimeout(writeTimer);
      if (dayTimer) clearTimeout(dayTimer);
      writeTimer = undefined; dayTimer = undefined;
      closePromise = enqueue(async () => {
        if (loading) await loading;
        else if (pending.length) await load();
        await write(true);
      });
      return closePromise;
    },
  };
}
