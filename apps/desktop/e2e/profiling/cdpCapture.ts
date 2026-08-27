import type { Page } from "@playwright/test";
import type { CDPSession, ElectronApplication } from "playwright";

export interface CpuProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  hitCount?: number;
  children?: number[];
}

export interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

export interface LongTaskEntry {
  name: string;
  startTime: number;
  duration: number;
}

export interface CdpMetrics {
  values: Record<string, number>;
}

export interface CdpCaptureResult {
  cpuProfile: CpuProfile;
  performance: {
    before: CdpMetrics;
    after: CdpMetrics;
    delta: Record<string, number>;
  };
  longTasks: {
    supported: boolean;
    count: number;
    totalDurationMs: number;
    entries: LongTaskEntry[];
  };
}

type LongTaskWindow = Window & {
  __dohcProfileLongTasks?: {
    supported: boolean;
    observer: PerformanceObserver | null;
    entries: LongTaskEntry[];
  };
};

export async function startLongTaskObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as LongTaskWindow;
    target.__dohcProfileLongTasks?.observer?.disconnect();
    const supported = PerformanceObserver.supportedEntryTypes.includes("longtask");
    const state: NonNullable<LongTaskWindow["__dohcProfileLongTasks"]> = {
      supported,
      observer: null,
      entries: [],
    };
    if (supported) {
      state.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.entries.push({
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      });
      state.observer.observe({ type: "longtask", buffered: true });
    }
    target.__dohcProfileLongTasks = state;
  });
}

export async function stopLongTaskObserver(page: Page): Promise<CdpCaptureResult["longTasks"]> {
  return page.evaluate(() => {
    const state = (window as LongTaskWindow).__dohcProfileLongTasks;
    if (!state) return { supported: false, count: 0, totalDurationMs: 0, entries: [] };
    if (state.observer) {
      for (const entry of state.observer.takeRecords()) {
        state.entries.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
        });
      }
      state.observer.disconnect();
    }
    const entries = [...state.entries];
    delete (window as LongTaskWindow).__dohcProfileLongTasks;
    return {
      supported: state.supported,
      count: entries.length,
      totalDurationMs: entries.reduce((total, entry) => total + entry.duration, 0),
      entries,
    };
  });
}

async function readMetrics(session: CDPSession): Promise<CdpMetrics> {
  const result = (await session.send("Performance.getMetrics")) as {
    metrics: Array<{ name: string; value: number }>;
  };
  return { values: Object.fromEntries(result.metrics.map(({ name, value }) => [name, value])) };
}

function metricDelta(before: CdpMetrics, after: CdpMetrics): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const [name, value] of Object.entries(after.values)) {
    const earlier = before.values[name];
    if (earlier !== undefined) delta[name] = value - earlier;
  }
  return delta;
}

export async function startCdpCapture(
  app: ElectronApplication,
  page: Page,
): Promise<{ session: CDPSession; stop(): Promise<CdpCaptureResult> }> {
  const session = await app.context().newCDPSession(page);
  await startLongTaskObserver(page);
  await session.send("Performance.enable");
  const before = await readMetrics(session);
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 1_000 });
  await session.send("Profiler.start");
  let stopped = false;
  return {
    session,
    stop: async () => {
      if (stopped) throw new Error("CDP capture was already stopped.");
      stopped = true;
      try {
        const stoppedProfile = (await session.send("Profiler.stop")) as {
          profile: CpuProfile;
        };
        const after = await readMetrics(session);
        const longTasks = await stopLongTaskObserver(page);
        return {
          cpuProfile: stoppedProfile.profile,
          performance: { before, after, delta: metricDelta(before, after) },
          longTasks,
        };
      } finally {
        await session.send("Profiler.disable").catch(() => undefined);
        await session.send("Performance.disable").catch(() => undefined);
        await session.detach().catch(() => undefined);
      }
    },
  };
}
