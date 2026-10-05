// Aggregate diagnostics for an isolated test process. No clocks or retained
// counter storage are used until the existing desktop test gate enables them.
export const PROFILE_COUNTER_NAMES = [
  "ipcInvocations", "readWorkspaceTextCalls", "listWorkspaceFilesCalls",
  "writeWorkspaceTextCalls", "activityRequests", "activityEmissions",
  "activityWindowDeliveries", "observationFactBatches", "observationFactPaths",
  "observationResyncCallbacks", "captureCallbacks", "captureCallbacksWithoutPaths", "capturedPaths",
  "mainHashCalls", "mainHashBytes", "mainHashDurationMs",
  "settledFileReadCalls", "settledFileReadBytes", "settledFileReadElapsedMs",
  "leasePublications", "leaseSubscriberDeliveries",
  "sessionPublications", "sessionSubscriberDeliveries",
] as const;

export type ProfileCounterName = typeof PROFILE_COUNTER_NAMES[number];
export type ProfileCountersSnapshot = Record<ProfileCounterName, number>;

export function createProfileCounters(now: () => number = () => performance.now()) {
  let values: ProfileCountersSnapshot | null = null;
  return {
    enable(): void {
      values ??= Object.fromEntries(PROFILE_COUNTER_NAMES.map(name => [name, 0])) as ProfileCountersSnapshot;
    },
    get enabled(): boolean { return values !== null; },
    add(name: ProfileCounterName, amount = 1): void {
      if (values) values[name] += amount;
    },
    start(): number | null { return values ? now() : null; },
    finish(name: ProfileCounterName, start: number | null): void {
      if (values && start !== null) values[name] += now() - start;
    },
    snapshot(): ProfileCountersSnapshot | null { return values ? { ...values } : null; },
    resetForTests(): void { values = null; },
  };
}

export function profileCountersDelta(
  before: ProfileCountersSnapshot | null,
  after: ProfileCountersSnapshot | null,
): ProfileCountersSnapshot | null {
  if (!before || !after) return null;
  const delta = {} as ProfileCountersSnapshot;
  for (const name of PROFILE_COUNTER_NAMES) {
    if (!Number.isFinite(before[name]) || !Number.isFinite(after[name]) || after[name] < before[name]) {
      throw new Error(`Invalid profiling counter delta: ${name}`);
    }
    delta[name] = after[name] - before[name];
  }
  return delta;
}

export const profileCounters = createProfileCounters();

export function countersPerSaveConfirmation(counters: ProfileCountersSnapshot | null, confirmations: number) {
  if (!Number.isSafeInteger(confirmations) || confirmations < 0) throw new Error("Invalid save confirmation count.");
  if (!counters || confirmations === 0) return null;
  return Object.fromEntries(PROFILE_COUNTER_NAMES.map(name => [name, counters[name] / confirmations])) as ProfileCountersSnapshot;
}
