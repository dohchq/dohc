import { spawnSync, type spawn } from "node:child_process";
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

  it("gives an ENOENT spawn failure the install remedy and still cleans up", async () => {
    const enoent: NodeJS.ErrnoException = new Error("spawn ENOENT");
    enoent.code = "ENOENT";
    const { error, cacheDir } = await drive({ fail: enoent });
    expect(error?.message).toContain("Could not launch the Playwright CLI at ");
    expect(error?.message).toContain("run pnpm install");
    expect(existsSync(cacheDir ?? "")).toBe(false);
  });

  it("surfaces a permission failure's own code — pnpm install cannot fix EACCES", async () => {
    const eacces: NodeJS.ErrnoException = new Error("spawn EACCES");
    eacces.code = "EACCES";
    const { error, cacheDir } = await drive({ fail: eacces });
    expect(error?.message).toContain("EACCES");
    expect(error?.message).toContain("spawn EACCES");
    expect(error?.message).not.toContain("pnpm install");
    expect(existsSync(cacheDir ?? "")).toBe(false);
  });

  it("forwards its argv to the CLI after the test subcommand", async () => {
    const { spawnedArgs } = await drive();
    // Losing the argv is silent scope creep: an argless `test --list`
    // auto-discovers the config and runs the WHOLE suite, so smoke:settings
    // would quietly run all 67 tests instead of its one tagged spec.
    expect(spawnedArgs.slice(-3)).toEqual(["test", "--grep", "@x"]);
    expect(spawnedArgs[0]).toBe(playwrightCliPath());
  });

  it("keeps the parent environment when no env override is given", async () => {
    process.env.DOHC_TEST_RUNPW_SENTINEL = "carried";
    try {
      const child = fakeChild();
      let spawnedEnv: Record<string, string | undefined> = {};
      const run = runPlaywright([], {
        spawnImpl: ((
          _cmd: string,
          _args: string[],
          options: { env: Record<string, string | undefined> },
        ) => {
          spawnedEnv = options.env;
          return child;
        }) as unknown as typeof spawn,
        onTermination: () => {},
      });
      queueMicrotask(() => child.emit("exit", 0, null));
      await run;
      expect(spawnedEnv.DOHC_TEST_RUNPW_SENTINEL).toBe("carried");
    } finally {
      delete process.env.DOHC_TEST_RUNPW_SENTINEL;
    }
  });

  it("registers real signal handlers by default and removes them after the run", async () => {
    const baseInt = process.listenerCount("SIGINT");
    const baseTerm = process.listenerCount("SIGTERM");
    const child = fakeChild();
    const run = runPlaywright([], {
      spawnImpl: (() => child) as unknown as typeof spawn,
    });
    // Mid-run: the default onTermination has armed both handlers.
    expect(process.listenerCount("SIGINT")).toBe(baseInt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(baseTerm + 1);
    child.emit("exit", 0, null);
    await run;
    // And the run removes what it registered — repeated calls must not leak.
    expect(process.listenerCount("SIGINT")).toBe(baseInt);
    expect(process.listenerCount("SIGTERM")).toBe(baseTerm);
  });

  it("defaults the kill decision to the machine it runs on", async () => {
    const child = fakeChild();
    let forward!: (signal: string) => void;
    const run = runPlaywright([], {
      spawnImpl: (() => child) as unknown as typeof spawn,
      onTermination: (handler: (signal: string) => void) => {
        forward = handler;
      },
    });
    forward("SIGTERM");
    // No platform override: the branch must follow process.platform, so a
    // hardcoded platform fails this on any machine of the other kind.
    if (process.platform === "win32") {
      expect(child.kill).not.toHaveBeenCalled();
    } else {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    }
    child.emit("exit", 0, null);
    await run;
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

describe("run-playwright entry point", () => {
  it(
    "passes the command line through to the CLI — one tagged spec, not the suite",
    () => {
      // The only coverage of `process.argv.slice(2)` in the main block: a
      // real invocation whose --grep must narrow the listing to the single
      // @settings-smoke spec. If the entry drops its argv, the CLI
      // auto-discovers the config and lists the whole suite instead.
      const result = spawnSync(
        process.execPath,
        [
          join(import.meta.dirname, "..", "..", "scripts", "run-playwright.mjs"),
          "--config",
          "playwright.config.ts",
          "--list",
          "--grep",
          "@settings-smoke",
        ],
        { cwd: join(import.meta.dirname, "..", ".."), encoding: "utf8", timeout: 90_000 },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Total: 1 test in 1 file");
    },
    120_000,
  );
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
