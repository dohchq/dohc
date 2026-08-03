import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  playwrightCliPath,
  playwrightRunEnv,
  requirePlaywrightCli,
  runPlaywright,
} from "../../scripts/run-playwright.mjs";

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
  let forward!: (signal: string) => void;
  // The fake returns an EventEmitter with kill(), the slice of ChildProcess
  // the wrapper touches; the cast bridges to spawn's full return type.
  const spawnImpl = ((
    _cmd: string,
    _args: string[],
    options: { env: Record<string, string | undefined> },
  ) => {
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
  return { child, forward, cacheDir: spawnedEnv.PWTEST_CACHE_DIR, ...settled };
}

describe("playwrightCliPath", () => {
  it("resolves to an existing Playwright CLI entry", () => {
    const cli = playwrightCliPath();
    expect(cli.endsWith("cli.js")).toBe(true);
    expect(statSync(cli).isFile()).toBe(true);
  });
});

describe("playwrightRunEnv", () => {
  it("points PWTEST_CACHE_DIR at the per-run directory", () => {
    const env = playwrightRunEnv({ PATH: "/bin" }, "/runs/cache-1");
    expect(env.PWTEST_CACHE_DIR).toBe("/runs/cache-1");
  });

  it("keeps the rest of the environment", () => {
    const env = playwrightRunEnv({ PATH: "/bin", HOME: "/home/u" }, "/runs/cache-1");
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/u");
  });

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

  it("keeps a signal exit's conventional code", async () => {
    const { code } = await drive({ exit: [null, "SIGINT"] });
    expect(code).toBe(130);
  });

  it("forwards termination to the child on POSIX", async () => {
    const { child, forward } = await drive();
    forward("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("never hard-kills the child on Windows, where the job object owns it", async () => {
    const { child, forward } = await drive({ platform: "win32" });
    forward("SIGINT");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("names the missing CLI on a spawn failure and still cleans up", async () => {
    const { error, cacheDir } = await drive({ fail: new Error("spawn ENOENT") });
    expect(error?.message).toContain("Could not launch the Playwright CLI at ");
    expect(error?.message).toContain("run pnpm install");
    expect(existsSync(cacheDir ?? "")).toBe(false);
  });

  it("refuses a nonexistent CLI path with the remedy, before spawning anything", async () => {
    const spawnImpl = vi.fn();
    const missing = join(tmpdir(), "definitely-missing-playwright-cli.js");
    await expect(
      runPlaywright([], {
        cliPath: missing,
        spawnImpl: spawnImpl as unknown as typeof spawn,
      }),
    ).rejects.toThrow(
      `Could not launch the Playwright CLI at ${missing}. The e2e scripts need the playwright package installed; run pnpm install.`,
    );
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe("requirePlaywrightCli", () => {
  it("turns a failed package resolution into the named remedy", () => {
    expect(() =>
      requirePlaywrightCli(undefined, () => {
        throw new Error("Cannot find module 'playwright/package.json'");
      }),
    ).toThrow(
      "Could not resolve the playwright package. The e2e scripts need it installed; run pnpm install.",
    );
  });

  it("returns the resolved entry when it exists", () => {
    expect(requirePlaywrightCli(undefined)).toBe(playwrightCliPath());
  });
});
