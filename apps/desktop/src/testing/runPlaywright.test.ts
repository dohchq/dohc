import { type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { playwrightCliPath, playwrightRunEnv, runPlaywright } from "../../scripts/run-playwright.mjs";

// The wrapper that gives every Playwright run its own transform cache
// directory, so concurrent runs cannot delete or tear each other's compiled
// config in the machine-wide os.tmpdir()/playwright-transform-cache.

const SHARED_CACHE = join(tmpdir(), "playwright-transform-cache");

type FakeChild = EventEmitter & { kill: ReturnType<typeof vi.fn> };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.kill = vi.fn();
  return child;
}

// Drives runPlaywright with a fake spawn. `exit` is [code, signal]; `fail`
// emits a spawn error instead. Returns everything the assertions read.
async function drive({
  exit = [0, null] as [number | null, string | null],
  fail = undefined as Error | undefined,
  platform = "linux" as NodeJS.Platform,
}: {
  exit?: [number | null, string | null];
  fail?: Error;
  platform?: NodeJS.Platform;
} = {}) {
  const child = fakeChild();
  let spawnedEnv: Record<string, string | undefined> = {};
  let spawnedArgs: string[] = [];
  let forward!: (signal: string) => void;
  // The fake returns an EventEmitter with kill(), the slice of ChildProcess
  // the wrapper touches; the cast bridges to spawn's full return type.
  const spawnImpl = ((
    _cmd: string,
    args: string[],
    options: { env: Record<string, string | undefined> },
  ) => {
    spawnedArgs = args;
    spawnedEnv = options.env;
    return child;
  }) as unknown as typeof spawn;
  const run = runPlaywright(["--grep", "@x"], {
    env: { KEEP: "kept" },
    platform,
    spawnImpl,
    onTermination: (handler: (signal: string) => void) => {
      forward = handler;
    },
  });
  queueMicrotask(() => {
    if (fail) child.emit("error", fail);
    else child.emit("exit", ...exit);
  });
  const settled = await run.then(
    (code) => ({ code, error: null as Error | null }),
    (error: Error) => ({ code: null as number | null, error }),
  );
  return {
    child,
    forward,
    spawnedArgs,
    spawnedEnv,
    cacheDir: spawnedEnv.PWTEST_CACHE_DIR,
    ...settled,
  };
}

describe("playwrightRunEnv", () => {
  it("overrides an inherited PWTEST_CACHE_DIR — isolation is unconditional", () => {
    const env = playwrightRunEnv(
      { PWTEST_CACHE_DIR: "/machine/shared-cache" },
      "/runs/cache-2",
    );
    expect(env.PWTEST_CACHE_DIR).toBe("/runs/cache-2");
  });
});

describe("runPlaywright", () => {
  it("gives every run its own directory, never the machine-wide cache", async () => {
    const first = await drive();
    const second = await drive();
    expect(first.cacheDir).toBeTruthy();
    expect(second.cacheDir).toBeTruthy();
    expect(first.cacheDir).not.toBe(second.cacheDir);
    expect(first.cacheDir).not.toBe(SHARED_CACHE);
    expect(second.cacheDir).not.toBe(SHARED_CACHE);
  });

  it("removes the run's directory after a zero and a nonzero exit", async () => {
    const clean = await drive({ exit: [0, null] });
    expect(clean.code).toBe(0);
    expect(existsSync(clean.cacheDir ?? "")).toBe(false);

    const failed = await drive({ exit: [7, null] });
    expect(failed.code).toBe(7);
    expect(existsSync(failed.cacheDir ?? "")).toBe(false);
  });

  it("never hard-kills the child on Windows, where the job object owns it", async () => {
    const { child, forward } = await drive({ platform: "win32" });
    forward("SIGINT");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("gives an ENOENT spawn failure the install remedy and still cleans up", async () => {
    const enoent: NodeJS.ErrnoException = new Error("spawn ENOENT");
    enoent.code = "ENOENT";
    const { error, cacheDir } = await drive({ fail: enoent });
    expect(error?.message).toContain("Could not launch the Playwright CLI at ");
    expect(error?.message).toContain("run pnpm install");
    expect(existsSync(cacheDir ?? "")).toBe(false);
  });

  it("forwards its argv to the CLI after the test subcommand", async () => {
    const { spawnedArgs } = await drive();
    // Losing the argv is silent scope creep: an argless `test --list`
    // auto-discovers the config and runs the whole suite, so smoke:settings
    // would quietly run all 67 tests instead of its one tagged spec.
    expect(spawnedArgs.slice(-3)).toEqual(["test", "--grep", "@x"]);
    expect(spawnedArgs[0]).toBe(playwrightCliPath());
  });
});
