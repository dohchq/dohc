import { afterAll, vi } from "vitest";
import { restoreOwnProperties, saveOwnProperties, type OwnProperties } from "./testing/ownProperties";

// A shared project runs its files one after another in one worker. Each file
// starts from the worker's state before its first file: the same environment
// variables and own globals, nothing stubbed, and real timers. The reset runs
// when vitest loads this setup file, before the file's own code and hooks, so
// it holds even when the previous file's afterAll hook threw and skipped the
// rest. It runs again after the file, to release what the file left.
//
// The environment comes back from a copy, not only through vi.unstubAllEnvs:
// on Windows, stubbing both PATH and Path records the second original after the
// first stub emptied it, so unstubbing leaves PATH empty.
//
// vitest writes its VITEST_* variables and __vitest* globals for each file and
// owns console. Symbol-keyed globals belong to libraries. Those stay.

interface Baseline {
  environment: NodeJS.ProcessEnv;
  globals: OwnProperties;
}

const VITEST_VARIABLE = /^VITEST/u;
const KEPT_GLOBAL = /^(?:__vitest|__vite|console$)/u;
const globalNames = (target: object) => Object.getOwnPropertyNames(target).filter((name) => !KEPT_GLOBAL.test(name));
const store = globalThis as unknown as Record<symbol, Baseline | undefined>;
const key = Symbol.for("dohc.sharedWorkerBaseline");
const baseline = (store[key] ??= {
  environment: { ...process.env },
  globals: saveOwnProperties(globalThis, globalNames, true),
});

function reset(): void {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const name of Object.keys(process.env)) {
    if (!VITEST_VARIABLE.test(name) && !Object.hasOwn(baseline.environment, name)) delete process.env[name];
  }
  for (const [name, value] of Object.entries(baseline.environment)) {
    if (!VITEST_VARIABLE.test(name) && value !== undefined && process.env[name] !== value) process.env[name] = value;
  }
  restoreOwnProperties(globalThis, baseline.globals);
}

reset();
afterAll(reset);
