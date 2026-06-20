import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeTmpdir } from "./testTemp";
import {
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
    expect(detectDevUrl("deployed at https://example.com")).toBeNull();
  });

  it("splits simple configured command strings", () => {
    expect(splitCommandLine('pnpm vite --host "127.0.0.1"')).toEqual({
      command: "pnpm",
      args: ["vite", "--host", "127.0.0.1"],
    });
    expect(() => splitCommandLine('"unterminated')).toThrow(/unterminated/);
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
    expect(handle.url).toBe("http://127.0.0.1:43210");
    expect(handle.logs().some((entry) => entry.text.includes("Local:"))).toBe(true);
    await handle.stop();
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
