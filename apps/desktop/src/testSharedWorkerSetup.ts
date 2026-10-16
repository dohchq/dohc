import { afterAll, vi } from "vitest";

// A shared project runs its files one after another in one worker. When a file
// ends, the next file gets the environment variables this file started with,
// the globals vitest stubbed, and real timers.
//
// The environment is restored from a copy, not only through vi.unstubAllEnvs:
// on Windows, stubbing both PATH and Path records the second original after the
// first stub emptied it, so unstubbing leaves PATH empty.
const environment = { ...process.env };
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const name of Object.keys(process.env)) {
    if (!Object.hasOwn(environment, name)) delete process.env[name];
  }
  Object.assign(process.env, environment);
});
