import { vi } from "vitest";

// vi.waitFor has a fixed 1 s default and no setting for it. Relay work that
// finishes in time on a quiet host can take longer on a loaded one, so every
// relay suite gets the same 10 s as expect.poll. An explicit timeout still wins.
// Under fake timers each check advances the fake clock by the interval, so a
// longer wait would move fake time further; those waits keep vitest's default.
const waitFor = vi.waitFor;
vi.waitFor = (callback, options) =>
  waitFor(callback, typeof options === "number" || vi.isFakeTimers() ? options : { timeout: 10_000, ...options });
