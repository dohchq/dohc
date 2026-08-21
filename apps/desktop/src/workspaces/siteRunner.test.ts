import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GetSitePreviewLogsResult,
  StartSitePreviewResult,
} from "../ipc/bridgeContract";

// Every test here spawns real node children, honest work a busy machine
// stretches (#568). Measured 2026-08-03 on a 24-process load (12 runs):
// individual tests passed at up to 2.3s against vitest's 5s default test
// deadline, and the dev-server cancel completed in up to 3.3s against its
// old 2s promptness ceiling — limits inside the loaded-healthy range. The
// test deadline goes to 15s (~6x measured); the cancel ceilings and their
// widened timeout bands are documented at the tests.
vi.setConfig({ testTimeout: 15_000 });
import { createTestScratch } from "./testTemp";
import { buildOutputSiteRoot } from "./sitePackage";
import {
  assertLoopbackOnlyDevServerCommand,
  buildSite,
  BUILD_HARD_KILL_GRACE_MS,
  detectBuildOutput,
  detectDevUrl,
  packageManagerCommand,
  packageManagerValidatedScriptCommand,
  splitCommandLine,
  startSiteDevServer,
  startStaticSitePreview,
  WILL_QUIT_BUDGET_MS,
} from "./siteRunner";

let root: string;
const workspaceAuthority = { kind: "workspace" } as const;

beforeEach(async () => {
  root = await createTestScratch("dohc-sites-");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("startStaticSitePreview", () => {
  it("serves only the mounted site's own shared-with-me subtree", async () => {
    const mountRoot = "shared-with-me/alex";
    const siteRoot = `${mountRoot}/portal`;
    await mkdir(join(root, siteRoot), { recursive: true });
    await mkdir(join(root, "shared-with-me", "blair", "portal"), { recursive: true });
    await writeFile(join(root, siteRoot, "index.html"), "<h1>Alex portal</h1>");
    await writeFile(
      join(root, "shared-with-me", "blair", "portal", "index.html"),
      "<h1>Blair portal</h1>",
    );

    const preview = await startStaticSitePreview(root, siteRoot, {
      authority: { kind: "share", mountRoot },
    });
    try {
      await expect(fetch(preview.url).then((response) => response.text()))
        .resolves.toContain("Alex portal");
    } finally {
      await preview.stop();
    }

    await expect(
      startStaticSitePreview(root, "shared-with-me/blair/portal", {
        authority: { kind: "share", mountRoot },
      }),
    ).rejects.toThrow(/own shared mount/i);
  });

  it("refuses a configured build output inside shared-with-me", async () => {
    const configuredBuildOutput = "shared-with-me/alex/site";
    await mkdir(join(root, configuredBuildOutput), { recursive: true });
    await writeFile(
      join(root, configuredBuildOutput, "index.html"),
      "<h1>Mounted build</h1>",
    );
    const site = { root: ".", configuredBuildOutput };
    const servedRoot = buildOutputSiteRoot(
      site,
      configuredBuildOutput,
    );
    const outcome = await startStaticSitePreview(root, servedRoot, {
      authority: workspaceAuthority,
    }).then(
      (preview) => ({ kind: "started" as const, preview }),
      (error: unknown) => ({ kind: "refused" as const, error }),
    );
    if (outcome.kind === "started") await outcome.preview.stop();

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(String(outcome.error)).toMatch(/shared-with-me.*cannot preview/i);
    }
  });

  it("serves a normal configured build output", async () => {
    const configuredBuildOutput = "release/site";
    await mkdir(join(root, configuredBuildOutput), { recursive: true });
    await writeFile(
      join(root, configuredBuildOutput, "index.html"),
      "<h1>Owned build</h1>",
    );
    const site = { root: ".", configuredBuildOutput };
    const servedRoot = buildOutputSiteRoot(
      site,
      configuredBuildOutput,
    );

    const preview = await startStaticSitePreview(root, servedRoot, {
      authority: workspaceAuthority,
    });
    try {
      await expect(fetch(preview.url).then((response) => response.text()))
        .resolves.toContain("Owned build");
    } finally {
      await preview.stop();
    }
  });

  it("serves a normal static website from a contained workspace folder", async () => {
    await mkdir(join(root, "report"), { recursive: true });
    await writeFile(join(root, "report", "index.html"), '<link rel="stylesheet" href="./style.css"><h1>Report</h1>');
    await writeFile(join(root, "report", "style.css"), "body { color: rgb(1, 2, 3); }");

    const preview = await startStaticSitePreview(root, "report", {
      authority: workspaceAuthority,
    });
    try {
      const html = await fetch(preview.url).then((res) => res.text());
      expect(html).toContain("<h1>Report</h1>");
      const css = await fetch(new URL("./style.css", preview.url)).then((res) => res.text());
      expect(css).toContain("rgb(1, 2, 3)");
    } finally {
      await preview.stop();
    }
  });

  it("serves a root-level workspace website", async () => {
    await writeFile(join(root, "index.html"), "<h1>Root Site</h1>");

    const preview = await startStaticSitePreview(root, ".", {
      authority: workspaceAuthority,
    });
    try {
      await expect(fetch(preview.url).then((res) => res.text())).resolves.toContain("Root Site");
    } finally {
      await preview.stop();
    }
  });

  it("does not serve a shared-with-me mount from a root-level site", async () => {
    await mkdir(join(root, "shared-with-me", "Alex"), { recursive: true });
    await writeFile(join(root, "index.html"), "<h1>Root Site</h1>");
    await writeFile(
      join(root, "shared-with-me", "Alex", "private.txt"),
      "shared private file",
    );
    await writeFile(join(root, "shared-with-me-notes.txt"), "owned sibling file");

    const preview = await startStaticSitePreview(root, ".", {
      authority: workspaceAuthority,
    });
    try {
      const shared = await fetch(
        new URL("/shared-with-me/Alex/private.txt", preview.url),
      );
      expect(shared.status).toBe(403);

      const sibling = await fetch(
        new URL("/shared-with-me-notes.txt", preview.url),
      );
      expect(sibling.status).toBe(200);
      await expect(sibling.text()).resolves.toBe("owned sibling file");
    } finally {
      await preview.stop();
    }
  });

  it("rejects traversal and missing entry files", async () => {
    await mkdir(join(root, "empty"), { recursive: true });
    await expect(
      startStaticSitePreview(root, "../escape", { authority: workspaceAuthority }),
    ).rejects.toThrow(/traversal|relative/);
    await expect(
      startStaticSitePreview(root, "empty", { authority: workspaceAuthority }),
    ).rejects.toThrow();
    await mkdir(join(root, "site"), { recursive: true });
    await writeFile(join(root, "site", "index.html"), "ok");
    await expect(startStaticSitePreview(root, "site", {
      authority: workspaceAuthority,
      entry: "../index.html",
    })).rejects.toThrow(
      /Invalid site entry/,
    );
  });

  it("never serves nested dohc metadata from a static site root", async () => {
    await mkdir(join(root, "site", "nested", ".dohc"), { recursive: true });
    await writeFile(join(root, "site", "index.html"), "public");
    await writeFile(join(root, "site", "nested", ".dohc", "secret.txt"), "secret");

    const preview = await startStaticSitePreview(root, "site", {
      authority: workspaceAuthority,
    });
    try {
      const direct = await fetch(new URL("/nested/.dohc/secret.txt", preview.url));
      expect(direct.status).toBe(403);
      const encoded = await fetch(new URL("/nested/%2edohc/secret.txt", preview.url));
      expect(encoded.status).toBe(403);
    } finally {
      await preview.stop();
    }

    await expect(
      startStaticSitePreview(root, "site", {
        authority: workspaceAuthority,
        entry: "nested/.dohc/secret.txt",
      }),
    ).rejects.toThrow(/reserved metadata path/);
  });
});

describe("package manager helpers", () => {
  it("produces script commands", () => {
    expect(packageManagerCommand("pnpm", "dev")).toEqual({ command: "pnpm", args: ["dev"] });
    expect(packageManagerCommand("npm", "build")).toEqual({ command: "npm", args: ["run", "build"] });
  });

  it("validates the visible body of package-backed dev scripts", () => {
    expect(() =>
      packageManagerValidatedScriptCommand("pnpm", "dev", "vite --host 0.0.0.0"),
    ).toThrow(/loopback/);
    expect(packageManagerValidatedScriptCommand("pnpm", "dev", "vite")).toEqual({
      command: "pnpm",
      args: ["dev"],
    });
  });

  it.each(["npm", "pnpm"] as const)(
    "validates implicit %s lifecycle hooks around a safe dev script",
    (manager) => {
      expect(() =>
        packageManagerValidatedScriptCommand(
          manager,
          "dev",
          "vite --host 127.0.0.1",
          { pre: "vite --host 0.0.0.0" },
        ),
      ).toThrow(/loopback/);
    },
  );

  it("recursively validates a shell-wrapped implicit lifecycle hook", () => {
    expect(() =>
      packageManagerValidatedScriptCommand(
        "npm",
        "dev",
        "vite --host 127.0.0.1",
        { post: "bash -lc 'vite --host 0.0.0.0'" },
      ),
    ).toThrow(/loopback/);
  });

  it("validates host flags inside visible shell-wrapped package scripts", () => {
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "sh -c 'vite --host 0.0.0.0'",
      ),
    ).toThrow(/loopback/);
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "sh -c 'vite --host 127.0.0.1'",
      ),
    ).not.toThrow();
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "BASH -c 'vite --hostname 192.168.1.1'",
      ),
    ).toThrow(/loopback/);
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "bash -lc 'vite --host 0.0.0.0'",
      ),
    ).toThrow(/loopback/);
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "bash -lc 'vite --host 127.0.0.1'",
      ),
    ).not.toThrow();
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "cmd /c 'vite --host 0.0.0.0'",
      ),
    ).toThrow(/loopback/);
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "powershell -Command 'vite --host 127.0.0.1'",
      ),
    ).not.toThrow();
  });

  it("extracts local dev server urls from common tool output", () => {
    expect(detectDevUrl("  Local:   http://localhost:5173/")).toBe("http://localhost:5173/");
    expect(detectDevUrl("ready on http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    // Normalize IPv6 loopback so downstream preview origin checks see one stable loopback form.
    expect(detectDevUrl("ready on http://[::1]:5173/app")).toBe("http://127.0.0.1:5173/app");
    expect(detectDevUrl("ready on https://localhost:5173")).toBeNull();
    expect(detectDevUrl("deployed at https://example.com")).toBeNull();
    expect(detectDevUrl("listening on http://0.0.0.0:3000")).toBeNull();
    expect(detectDevUrl("network at http://192.168.1.1:5173")).toBeNull();
    expect(detectDevUrl("network at http://10.0.0.1:5173")).toBeNull();
    expect(detectDevUrl("ready on http://[2001:db8::1]:5173")).toBeNull();
    expect(detectDevUrl("ready on http://example.com:5173")).toBeNull();
    expect(detectDevUrl("ready on http://mysite.local:5173")).toBeNull();
    expect(detectDevUrl("ready on http://localhost.tunnel.example:5173")).toBeNull();
    // Vite with FORCE_COLOR reaching it (Playwright workers set it; user
    // shells can too) bolds the PORT with ANSI SGR sequences mid-URL — the
    // port must not be dropped (a port-less URL loads a dead preview).
    expect(
      detectDevUrl(
        "  \u001B[32m→\u001B[39m  \u001B[1mLocal\u001B[22m:   \u001B[36mhttp://127.0.0.1:\u001B[1m5173\u001B[22m/\u001B[39m",
      ),
    ).toBe("http://127.0.0.1:5173/");
  });

  it.each([
    [
      "Server ready (http://localhost:5173)",
      "http://localhost:5173",
    ],
    [
      'Local: "http://localhost:3000"',
      "http://localhost:3000",
    ],
    [
      "ready on http://localhost:5173/app.",
      "http://localhost:5173/app",
    ],
  ])("removes delimiters from a detected dev URL in %s", (output, expected) => {
    expect(detectDevUrl(output)).toBe(expected);
  });

  it("splits simple configured command strings", () => {
    expect(splitCommandLine('pnpm vite --host "127.0.0.1"')).toEqual({
      command: "pnpm",
      args: ["vite", "--host", "127.0.0.1"],
    });
    expect(() => splitCommandLine('"unterminated')).toThrow(/unterminated/);
    if (process.platform === "win32") {
      // Backslashes are Windows path separators, never shell escapes.
      expect(splitCommandLine('node "C:\\ws\\build.mjs"')).toEqual({
        command: "node",
        args: ["C:\\ws\\build.mjs"],
      });
    }
  });

  it("rejects dev server commands that explicitly bind outside loopback", () => {
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", ["--host", "127.0.0.1"]),
    ).not.toThrow();
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", ["--host=localhost"]),
    ).not.toThrow();
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", ["--hostname", "::1"]),
    ).not.toThrow();
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", ["--host", "0.0.0.0"]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", ["--host=192.168.1.1"]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("next", ["-H", "mysite.local"]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", ["--host"]),
    ).toThrow(/all interfaces/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", [
        "--host",
        "127.0.0.1",
        "--host",
        "0.0.0.0",
      ]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", [
        "--host",
        "127.0.0.1",
        "--host",
        "127.0.0.1",
      ]),
    ).not.toThrow();
  });

  it("gives the will-quit teardown enough budget to reach a site preview's own hard-kill deadline", () => {
    // stopChild's POSIX/Windows path waits BUILD_HARD_KILL_GRACE_MS for a
    // graceful exit before it can even issue SIGKILL — quit exiting before
    // that deadline (plus headroom for the SIGKILL round-trip itself)
    // leaves an unref'd preview process with no kill signal ever sent
    // (round-15 finding 7).
    expect(WILL_QUIT_BUDGET_MS).toBeGreaterThan(BUILD_HARD_KILL_GRACE_MS);
  });

  it("rejects a leading HOST/HOSTNAME environment assignment that binds outside loopback", () => {
    // splitCommandLine has no concept of shell env assignments — "HOST=0.0.0.0
    // node server.cjs" tokenizes as command "HOST=0.0.0.0" with args
    // ["node", "server.cjs"], which the flag-based check alone never sees.
    expect(() =>
      assertLoopbackOnlyDevServerCommand("HOST=0.0.0.0", ["node", "server.cjs"]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("HOSTNAME=0.0.0.0", ["node", "server.cjs"]),
    ).toThrow(/loopback/);
    // A loopback value, or a non-host assignment entirely, is unaffected.
    expect(() =>
      assertLoopbackOnlyDevServerCommand("HOST=127.0.0.1", ["node", "server.cjs"]),
    ).not.toThrow();
    expect(() =>
      assertLoopbackOnlyDevServerCommand("NODE_ENV=production", ["node", "server.cjs"]),
    ).not.toThrow();
    // Multiple leading assignments, and an assignment inside a lifecycle
    // hook's own command string, are covered too.
    expect(() =>
      assertLoopbackOnlyDevServerCommand("NODE_ENV=production", [
        "HOST=0.0.0.0",
        "node",
        "server.cjs",
      ]),
    ).toThrow(/loopback/);
  });
});

describe("startSiteDevServer", () => {
  it.runIf(process.platform !== "win32")(
    "stops descendants after the shell wrapper exits",
    async () => {
      await mkdir(join(root, "site"), { recursive: true });
      const handle = await startSiteDevServer({
        workspaceRoot: root,
        siteRoot: "site",
        command: "sh",
        args: [
          "-c",
          "sleep 500 & child=$!; echo CHILD:$child; echo 'Local: http://127.0.0.1:43210'; wait",
        ],
        readyTimeoutMs: 5000,
      });
      const childLog = handle.logs().find((entry) => entry.text.includes("CHILD:"));
      const descendantPid = Number(/CHILD:(\d+)/.exec(childLog?.text ?? "")?.[1]);
      expect(descendantPid).toBeGreaterThan(0);

      try {
        await handle.stop();
        expect(() => process.kill(descendantPid, 0)).toThrow();
      } finally {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The fixed teardown already removed it.
        }
      }
    },
  );

  it("reports when a ready dev server exits on its own", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const handle = await startSiteDevServer({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: [
        "-e",
        "console.log('Local: http://127.0.0.1:43210'); process.exit(0)",
      ],
      readyTimeoutMs: 5000,
    });

    // Subscribe after the process is already down. Main can be busy between
    // receiving the ready URL and storing the handle, so late subscribers
    // must still receive the exit.
    await new Promise<void>((resolve) => handle.onExit(resolve));
    await new Promise<void>((resolve) => handle.onExit(resolve));
  });

  it("waits for a local URL, buffers logs, and stops the child process", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const handle = await startSiteDevServer({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: [
        "-e",
        "console.log('Local: http://127.0.0.1:43210'); setInterval(() => {}, 1000)",
      ],
      readyTimeoutMs: 5000,
    });
    try {
      expect(handle.url).toBe("http://127.0.0.1:43210");
      expect(handle.logs().some((entry) => entry.text.includes("Local:"))).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it("keeps oversized log lines inside the preview IPC contract", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const handle = await startSiteDevServer({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: [
        "-e",
        [
          'console.log("x".repeat(10_001));',
          "console.log('Local: http://127.0.0.1:43210');",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      readyTimeoutMs: 5000,
    });
    try {
      const logs = handle.logs();
      const parseResults = {
        immediate: StartSitePreviewResult.safeParse({
          siteRoot: "site",
          mode: "dev",
          url: handle.url,
          logs,
          exited: false,
        }).success,
        later: GetSitePreviewLogsResult.safeParse({
          logs,
          exited: false,
        }).success,
      };
      expect(parseResults).toEqual({ immediate: true, later: true });

      const oversized = logs.find((entry) => entry.text.startsWith("x"));
      expect(oversized?.text.length).toBeLessThanOrEqual(10_000);
      expect(oversized?.text).toContain("[truncated]");
    } finally {
      await handle.stop();
    }
  });

  it("detects a local URL split across stdout chunks", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const handle = await startSiteDevServer({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stdout.write('Local: http://local');",
          "setTimeout(() => process.stdout.write('host:5173/\\n'), 100);",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      readyTimeoutMs: 750,
    });
    try {
      expect(handle.url).toBe("http://localhost:5173/");
    } finally {
      await handle.stop();
    }
  });

  it("does not reject the ready-timeout until the child is fully stopped", async () => {
    // Regression: the ready-timeout used to `void stopChild(child)` and reject
    // immediately, so a caller could observe the failure and delete/switch the
    // workspace while the dev server was still alive holding the site dir. The
    // reject must now wait for stopChild to complete. A child that delays its
    // exit on SIGTERM makes the ordering observable: with the await in place
    // the rejection cannot arrive before that delay has elapsed.
    await mkdir(join(root, "site"), { recursive: true });
    const pidFile = join(root, "site", "dev.pid");
    const readyTimeoutMs = 150;
    const sigtermExitDelayMs = 400;
    const script = [
      `process.on("SIGTERM", () => { setTimeout(() => process.exit(0), ${sigtermExitDelayMs}); });`,
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const startedAt = Date.now();
    await expect(
      startSiteDevServer({
        workspaceRoot: root,
        siteRoot: "site",
        command: process.execPath,
        args: ["-e", script],
        readyTimeoutMs,
      }),
    ).rejects.toThrow(/did not report a local URL/);
    const elapsed = Date.now() - startedAt;

    // Reject waited for the delayed exit; without the fix it fires at ~150ms.
    // On win32 stopChild reaches killChildTreeWin32 (taskkill /T /F) before
    // it ever sends SIGTERM, so the child dies immediately and the delay is
    // unobservable; the pid liveness check below still catches the regression
    // (verified: re-injecting `void stopChild` fails it 5/5 on Windows).
    if (process.platform !== "win32") {
      expect(elapsed).toBeGreaterThanOrEqual(readyTimeoutMs + sigtermExitDelayMs - 100);
    }

    // And the child is confirmed down by the time the rejection surfaces.
    // The child writes its pid file asynchronously after spawn, and nothing in
    // the reject path waits for it — on a loaded machine the read below can
    // outrun the child and fail ENOENT. Wait for the file the assertion needs.
    await expect
      .poll(() => existsSync(pidFile), { timeout: 10_000 })
      .toBe(true);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("fails when the child exits before reporting a URL", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    await expect(
      startSiteDevServer({
        workspaceRoot: root,
        siteRoot: "site",
        command: process.execPath,
        args: ["-e", "console.error('nope'); process.exit(2)"],
        readyTimeoutMs: 5000,
      }),
    ).rejects.toThrow(/exited before it was ready/);
  });

  it("cancels an in-flight dev server start", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const controller = new AbortController();
    const startedAt = Date.now();
    // The ceiling proves the abort drove the rejection, not the ready
    // timeout. Honest cancels measured up to 3.3s on a 24-process load
    // (#568), so the old 5000/2000 band held no room for both margins:
    // 30_000/10_000 keeps 3x above the measured cancel and 3x below the
    // ready timeout.
    const starting = startSiteDevServer({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      readyTimeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    await expect(starting).rejects.toThrow(/cancelled/);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});

describe("buildSite", () => {
  it("runs a build command and detects the output directory", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const result = await buildSite({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/index.html','built'); console.log('built ok')",
      ],
      timeoutMs: 10000,
    });
    expect(result.ok).toBe(true);
    expect(result.outputPath).toBe(join(root, "site", "dist"));
    expect(result.logs.some((entry) => entry.text.includes("built ok"))).toBe(true);
    expect(await readFile(join(root, "site", "dist", "index.html"), "utf8")).toBe("built");
  });

  it("reports failed builds without stale output", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const result = await buildSite({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: ["-e", "console.error('broken build'); process.exit(3)"],
      timeoutMs: 10000,
    });
    expect(result.ok).toBe(false);
    expect(result.outputPath).toBeNull();
    expect(result.exitCode).toBe(3);
    expect(result.logs.some((entry) => entry.text.includes("broken build"))).toBe(true);
  });

  it("cancels an in-flight build instead of waiting for its timeout", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const controller = new AbortController();
    const startedAt = Date.now();
    // Same band as the dev-server cancel above (#568): the ceiling proves
    // the abort ended the build, not the build timeout, with 3x margin to
    // the measured loaded cancel on one side and to the timeout on the
    // other.
    const building = buildSite({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    const result = await building;
    expect(result.ok).toBe(false);
    expect(result.logs.some((entry) => entry.text.includes("Build cancelled"))).toBe(
      true,
    );
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it("reports build timeouts with the resolved timeout", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const result = await buildSite({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.logs.some((entry) => entry.text.includes("Build timed out after 100ms."))).toBe(
      true,
    );
  });

  it("detects configured and conventional build outputs", async () => {
    await mkdir(join(root, "site", "custom"), { recursive: true });
    expect(await detectBuildOutput(join(root, "site"), "custom")).toBe(join(root, "site", "custom"));
    await mkdir(join(root, "outside"), { recursive: true });
    expect(await detectBuildOutput(join(root, "site"), "../outside")).toBeNull();
    expect(await detectBuildOutput(join(root, "site"))).toBeNull();
    await mkdir(join(root, "site", "out"), { recursive: true });
    expect(await detectBuildOutput(join(root, "site"))).toBe(join(root, "site", "out"));
    expect(existsSync(join(root, "site", "out"))).toBe(true);
  });
});
