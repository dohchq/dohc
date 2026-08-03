import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every test here spawns real node children, honest work a busy machine
// stretches (#568). Measured 2026-08-03 on a 24-process load (12 runs):
// individual tests passed at up to 2.3s against vitest's 5s default test
// deadline, and the dev-server cancel completed in up to 3.3s against its
// old 2s promptness ceiling — limits inside the loaded-healthy range. The
// test deadline goes to 15s (~6x measured); the cancel ceilings and their
// widened timeout bands are documented at the tests.
vi.setConfig({ testTimeout: 15_000 });
import { nativeTmpdir } from "./testTemp";
import {
  assertLoopbackOnlyDevServerCommand,
  buildSite,
  detectBuildOutput,
  detectDevUrl,
  detectPackageManager,
  packageManagerCommand,
  splitCommandLine,
  startSiteDevServer,
  startStaticSitePreview,
} from "./siteRunner";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(nativeTmpdir(), "dohc-sites-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("startStaticSitePreview", () => {
  it("serves a normal static website from a contained workspace folder", async () => {
    await mkdir(join(root, "report"), { recursive: true });
    await writeFile(join(root, "report", "index.html"), '<link rel="stylesheet" href="./style.css"><h1>Report</h1>');
    await writeFile(join(root, "report", "style.css"), "body { color: rgb(1, 2, 3); }");

    const preview = await startStaticSitePreview(root, "report");
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

    const preview = await startStaticSitePreview(root, ".");
    try {
      await expect(fetch(preview.url).then((res) => res.text())).resolves.toContain("Root Site");
    } finally {
      await preview.stop();
    }
  });

  it("rejects traversal and missing entry files", async () => {
    await mkdir(join(root, "empty"), { recursive: true });
    await expect(startStaticSitePreview(root, "../escape")).rejects.toThrow(/traversal|relative/);
    await expect(startStaticSitePreview(root, "empty")).rejects.toThrow();
    await mkdir(join(root, "site"), { recursive: true });
    await writeFile(join(root, "site", "index.html"), "ok");
    await expect(startStaticSitePreview(root, "site", { entry: "../index.html" })).rejects.toThrow(
      /Invalid site entry/,
    );
  });

  it("never serves nested dohc metadata from a static site root", async () => {
    await mkdir(join(root, "site", "nested", ".dohc"), { recursive: true });
    await writeFile(join(root, "site", "index.html"), "public");
    await writeFile(join(root, "site", "nested", ".dohc", "secret.txt"), "secret");

    const preview = await startStaticSitePreview(root, "site");
    try {
      const direct = await fetch(new URL("/nested/.dohc/secret.txt", preview.url));
      expect(direct.status).toBe(403);
      const encoded = await fetch(new URL("/nested/%2edohc/secret.txt", preview.url));
      expect(encoded.status).toBe(403);
    } finally {
      await preview.stop();
    }

    await expect(
      startStaticSitePreview(root, "site", { entry: "nested/.dohc/secret.txt" }),
    ).rejects.toThrow(/reserved metadata path/);
  });
});

describe("package manager helpers", () => {
  it("detects package managers from lockfiles and produces script commands", () => {
    expect(detectPackageManager(["site/pnpm-lock.yaml"])).toBe("pnpm");
    expect(detectPackageManager(["site/bun.lock"])).toBe("bun");
    expect(detectPackageManager(["site/yarn.lock"])).toBe("yarn");
    expect(detectPackageManager(["site/package-lock.json"])).toBe("npm");
    expect(packageManagerCommand("pnpm", "dev")).toEqual({ command: "pnpm", args: ["dev"] });
    expect(packageManagerCommand("npm", "build")).toEqual({ command: "npm", args: ["run", "build"] });
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
    // Vite with FORCE_COLOR reaching it (Playwright workers set it; user
    // shells can too) bolds the PORT with ANSI SGR sequences mid-URL — the
    // port must not be dropped (a port-less URL loads a dead preview).
    expect(
      detectDevUrl(
        "  \u001B[32m→\u001B[39m  \u001B[1mLocal\u001B[22m:   \u001B[36mhttp://127.0.0.1:\u001B[1m5173\u001B[22m/\u001B[39m",
      ),
    ).toBe("http://127.0.0.1:5173/");
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
  });
});

describe("startSiteDevServer", () => {
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
