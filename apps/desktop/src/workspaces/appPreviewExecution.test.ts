import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppPreviewExecution } from "./appPreviewExecution";
import {
  createStartSitePreviewHandler,
  type SitePreviewExecutionInput,
  type SitePreviewResultBody,
} from "../ipc/sitePreviewIpc";
import type { SitePackageInfo } from "./sitePackage";
import { buildSite, startSiteDevServer, startStaticSitePreview, type SiteLogEntry, type SiteProcessHandle } from "./siteRunner";
import { createSitePreviewLifecycle, START_CANCELLED_MESSAGE } from "./sitePreviewLifecycle";
import type { ShareViewFiles, ShareViewFilesTarget } from "./shareViewFiles";
import { createTestScratch } from "./testTemp";
import { deferred } from "../testing/deferred";

vi.mock("./siteRunner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./siteRunner")>();
  return {
    ...actual,
    buildSite: vi.fn(),
    startSiteDevServer: vi.fn(),
    startStaticSitePreview: vi.fn(actual.startStaticSitePreview),
  };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.clearAllMocks(); }
});
const log = (text: string): SiteLogEntry => ({ stream: "stdout", text, at: 10 });

const devCases: Array<Pick<SitePackageInfo, "configuredScripts" | "scripts"> & { command: string; args: string[] }> = [
    { configuredScripts: { dev: "node configured.js", start: "node configured-start.js" }, scripts: { dev: "node package.js" }, command: "node", args: ["configured.js"] },
    { configuredScripts: { start: "node configured-start.js" }, scripts: { dev: "node package.js" }, command: "node", args: ["package.js"] },
    { configuredScripts: { start: "node configured-start.js" }, scripts: {}, command: "node", args: ["configured-start.js"] },
    { configuredScripts: {}, scripts: { start: "node package-start.js" }, command: "node", args: ["package-start.js"] },
  ];

async function harness() {
  const workspaceRoot = await realpath(await createTestScratch("app-preview-execution-"));
  const controller = new AbortController();
  let current = true;
  const app: SitePackageInfo = {
    root: "portal", title: "Portal", kind: "static", confidence: "high",
    entryPath: "portal/index.html", configPath: null, packagePath: null, packageManager: null,
    scripts: {}, configuredScripts: {}, configuredPreviewMode: null,
    configuredBuildOutput: null, buildOutputs: [], sourceFiles: ["portal/index.html"],
    shareManifest: { ok: true, manifest: { entryPath: "portal/index.html", assets: [] } },
    diagnostics: [], authority: { kind: "workspace" },
  };
  const write = async (path: string, text: string) => {
    const absolute = join(workspaceRoot, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, text);
    return absolute;
  };
  await write("portal/index.html", "<h1>Local app</h1>");
  await write("portal/dist/index.html", "<h1>Built app</h1>");
  const input: SitePreviewExecutionInput = {
    workspaceId: "workspace-a", workspaceRoot, site: app, mode: "static",
    sharedView: false, signal: controller.signal, isCurrent: () => current,
  };
  const readOwner = vi.fn<ShareViewFiles["read"]>(async () => ({ kind: "asset", bytes: Buffer.from("<h1>Owner app</h1>"), mediaType: "text/html" }));
  const ownerTarget: ShareViewFilesTarget = { kind: "mount", workspaceId: "workspace-a", shareId: "share-1" };
  const resolveOwner = vi.fn(async (_workspace: { workspaceId: string }, _path: string): Promise<{ target: ShareViewFilesTarget; path: string } | null> => ({ target: ownerTarget, path: "portal/dist" }));
  let files: Pick<ShareViewFiles, "read"> | undefined;
  let resolvePort: typeof resolveOwner | undefined;
  const execute = createAppPreviewExecution({
    get shareViewFiles() { if (!files) throw new Error("File owner not constructed"); return files; },
    get shareViewFilesTargetForPath() { if (!resolvePort) throw new Error("Path owner not constructed"); return resolvePort; },
  });
  files = { read: readOwner };
  resolvePort = resolveOwner;
  const devHandle: SiteProcessHandle = {
    url: "http://127.0.0.1:43210/", command: "node", args: ["server.js"], cwd: join(workspaceRoot, "portal"),
    logs: () => [log("Ready")], onExit: () => undefined, stop: vi.fn(async () => undefined),
  };
  vi.mocked(startSiteDevServer).mockResolvedValue(devHandle);
  vi.mocked(buildSite).mockResolvedValue({ ok: true, command: "node", args: ["build.js"], outputPath: join(workspaceRoot, "portal", "dist"), logs: [log("Built")], exitCode: 0 });
  const run = async () => {
    const execution = await execute(input);
    cleanups.push(() => execution.handle.stop());
    return execution;
  };
  return {
    workspaceRoot, controller, app, input, readOwner, resolveOwner, ownerTarget, devHandle, execute, run, write,
    retire: () => { current = false; },
    replaceFiles: (value: Pick<ShareViewFiles, "read">) => { files = value; },
    share: async () => {
      app.root = "shared-with-me/alice/portal";
      app.entryPath = `${app.root}/index.html`;
      app.buildOutputs = ["dist"];
      app.sourceFiles = [`${app.root}/dist/index.html`, `${app.root}/dist/assets/app.js`];
      app.authority = { kind: "share", mountRoot: "shared-with-me/alice" };
      await write(`${app.root}/dist/index.html`, "<h1>Changed recipient projection</h1>");
    },
  };
}

describe("app preview execution", () => {
  it("serves the local static entry with the real preparation and static server", async () => {
    const h = await harness();
    const execution = await h.run();
    expect(execution.result).toEqual({ siteRoot: "portal", mode: "static", logs: [] });
    expect(startStaticSitePreview).toHaveBeenCalledWith(h.workspaceRoot, "portal", { authority: h.app.authority, entry: "index.html" });
    await expect(fetch(execution.handle.url).then((response) => response.text())).resolves.toBe("<h1>Local app</h1>");
    expect(h.resolveOwner).not.toHaveBeenCalled();
    expect(h.readOwner).not.toHaveBeenCalled();
    expect(startSiteDevServer).not.toHaveBeenCalled();
    expect(buildSite).not.toHaveBeenCalled();
  });

  it("binds shared static files to the owner and reads its live file port rather than projection bytes", async () => {
    const h = await harness();
    await h.share();
    const execution = await h.run();
    expect(h.resolveOwner).toHaveBeenCalledWith({ workspaceId: "workspace-a" }, `${h.app.root}/dist`);
    const source = vi.mocked(startStaticSitePreview).mock.calls[0]![2].fileSource!;
    expect(source.contains("assets/app.js")).toBe(true);
    expect(source.contains("recipient-only.js")).toBe(false);
    const replacement = vi.fn<ShareViewFiles["read"]>(async () => ({ kind: "asset", bytes: Buffer.from("<h1>Current owner</h1>"), mediaType: "text/html" }));
    h.replaceFiles({ read: replacement });
    await expect(fetch(execution.handle.url).then((response) => response.text())).resolves.toBe("<h1>Current owner</h1>");
    expect(replacement).toHaveBeenCalledWith(h.ownerTarget, { kind: "asset", path: "portal/dist/index.html" });
    expect(h.readOwner).not.toHaveBeenCalled();
    await expect(source.read("recipient-only.js")).rejects.toThrow("Shared app file is unavailable.");
    expect(h.resolveOwner).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-asset reply from the live shared file owner", async () => {
    const h = await harness();
    await h.share();
    await h.run();
    h.readOwner.mockResolvedValue({ kind: "text", text: "wrong kind", truncated: false, contentHash: "hash" });
    const source = vi.mocked(startStaticSitePreview).mock.calls[0]![2].fileSource!;
    await expect(source.read("index.html")).rejects.toThrow("Shared app file returned an invalid result.");
  });

  it("refuses a missing shared owner before opening a static server", async () => {
    const h = await harness();
    await h.share();
    h.resolveOwner.mockResolvedValue(null);
    await expect(h.run()).rejects.toThrow("This shared app changed before the preview started. Refresh the workspace.");
    expect(startStaticSitePreview).not.toHaveBeenCalled();
  });

  it("keeps the share authority bound to its own mount at the real static server", async () => {
    const h = await harness();
    await h.share();
    h.app.authority = { kind: "share", mountRoot: "shared-with-me/another" };
    await expect(h.run()).rejects.toThrow("outside its own shared mount");
    expect(h.readOwner).not.toHaveBeenCalled();
  });

  it.each(devCases)("chooses the existing dev/start precedence for $args", async ({ configuredScripts, scripts, command, args }) => {
    const h = await harness();
    h.input.mode = "dev";
    h.app.configuredScripts = configuredScripts;
    h.app.scripts = scripts;
    const execution = await h.run();
    expect(startSiteDevServer).toHaveBeenCalledWith({ workspaceRoot: h.workspaceRoot, siteRoot: "portal", command, args, signal: h.controller.signal });
    expect(execution.handle).toBe(h.devHandle);
    expect(execution.result).toEqual({ siteRoot: "portal", mode: "dev", logs: [log("Ready")] });
    expect(startStaticSitePreview).not.toHaveBeenCalled();
  });

  it("refuses a missing dev/start script before process work", async () => {
    const h = await harness();
    h.input.mode = "dev";
    await expect(h.run()).rejects.toThrow("App has no dev or start script: portal");
    expect(startSiteDevServer).not.toHaveBeenCalled();
  });

  it("runs the actual command validator before allowing a dev process", async () => {
    const h = await harness();
    h.input.mode = "dev";
    h.app.configuredScripts = { dev: "vite --host 0.0.0.0" };
    await expect(h.run()).rejects.toThrow();
    expect(startSiteDevServer).not.toHaveBeenCalled();
  });

  it("builds with the configured command/output and preserves build metadata and logs", async () => {
    const h = await harness();
    h.input.mode = "build";
    h.app.configuredScripts = { build: "node configured-build.js" };
    h.app.scripts = { build: "node package-build.js" };
    h.app.configuredBuildOutput = "dist";
    h.app.buildOutputs = ["other"];
    const execution = await h.run();
    expect(buildSite).toHaveBeenCalledWith({ workspaceRoot: h.workspaceRoot, siteRoot: "portal", command: "node", args: ["configured-build.js"], output: "dist", signal: h.controller.signal });
    expect(execution.result).toEqual({ siteRoot: "portal", mode: "build", logs: [log("Built")], build: { ok: true, command: "node", args: ["build.js"], outputPath: join(h.workspaceRoot, "portal/dist"), exitCode: 0 } });
    expect(startStaticSitePreview).toHaveBeenCalledWith(h.workspaceRoot, "portal/dist", { authority: h.app.authority });
    await expect(fetch(execution.handle.url).then((response) => response.text())).resolves.toBe("<h1>Built app</h1>");
  });

  it("previews a discovered output without creating a build process", async () => {
    const h = await harness();
    h.input.mode = "build";
    h.app.buildOutputs = ["dist"];
    const execution = await h.run();
    expect(execution.result).toEqual({ siteRoot: "portal", mode: "build", logs: [] });
    expect(buildSite).not.toHaveBeenCalled();
  });

  it("serves the dist output of an app rooted at the workspace root", async () => {
    const h = await harness();
    h.input.mode = "build";
    h.app.root = ".";
    h.app.scripts = { build: "node build.js" };
    const output = "dist";
    await h.write(`${output}/index.html`, "root build");
    vi.mocked(buildSite).mockResolvedValue({ ok: true, command: "node", args: [], outputPath: join(h.workspaceRoot, output), logs: [], exitCode: 0 });
    await h.run();
    expect(startStaticSitePreview).toHaveBeenCalledWith(h.workspaceRoot, output, { authority: h.app.authority });
  });

  it("preserves the static owner's refusal when build output equals the app folder", async () => {
    const h = await harness();
    h.input.mode = "build";
    h.app.scripts = { build: "node build.js" };
    vi.mocked(buildSite).mockResolvedValue({ ok: true, command: "node", args: [],
      outputPath: join(h.workspaceRoot, "portal"), logs: [], exitCode: 0 });
    await expect(h.run()).rejects.toThrow("App path contains traversal: portal/.");
    expect(startStaticSitePreview).toHaveBeenCalledWith(h.workspaceRoot, "portal/.", { authority: h.app.authority });
  });

  it.each(["workspace-root", "sibling", "outside-alias"] as const)("rejects a build output at %s before starting a static server", async (location) => {
    const h = await harness();
    h.input.mode = "build";
    h.app.scripts = { build: "node build.js" };
    let outputPath = h.workspaceRoot;
    if (location === "sibling") { await h.write("other/index.html", "other"); outputPath = join(h.workspaceRoot, "other"); }
    if (location === "outside-alias") {
      const outside = await createTestScratch("app-preview-outside-");
      await writeFile(join(outside, "index.html"), "outside");
      outputPath = join(h.workspaceRoot, "portal", "escaped");
      await symlink(outside, outputPath, "junction");
    }
    vi.mocked(buildSite).mockResolvedValue({ ok: true, command: "node", args: [], outputPath, logs: [], exitCode: 0 });
    await expect(h.run()).rejects.toThrow(location === "sibling" ? "Build output must be inside the app folder:" : "Build output escaped the workspace:");
    expect(startStaticSitePreview).not.toHaveBeenCalled();
  });

  it("retains workspace authority when an existing output points inside shared-with-me", async () => {
    const h = await harness();
    h.input.mode = "build";
    h.app.root = ".";
    h.app.configuredBuildOutput = "shared-with-me/alice/portal";
    await h.write("shared-with-me/alice/portal/index.html", "shared bytes");
    await expect(h.run()).rejects.toThrow("inside shared-with-me");
  });

  it.each([{ logs: [] }, { logs: [log("ignored"), log(" first "), log("second"), log(" third ")] }, { logs: [log("ignored"), log("x".repeat(2100)), log("tail"), log("end")] }])("keeps the last three build logs and the final 2000 characters", async ({ logs }) => {
    const h = await harness();
    h.input.mode = "build";
    h.app.scripts = { build: "node build.js" };
    vi.mocked(buildSite).mockResolvedValue({ ok: false, command: "node", args: [], outputPath: null, logs, exitCode: 1 });
    const expected = logs.length === 0 ? "" : logs[1]!.text.startsWith("x") ? `[truncated]\n${"x".repeat(1991)}\ntail\nend` : "first \nsecond\n third";
    await expect(h.run()).rejects.toThrow(`App build failed or did not produce a static output folder.${expected ? `\n\nRecent output:\n${expected}` : ""}`);
    expect(startStaticSitePreview).not.toHaveBeenCalled();
  });

  it("rejects a successful build that reports no output path", async () => {
    const h = await harness();
    h.input.mode = "build";
    h.app.scripts = { build: "node build.js" };
    vi.mocked(buildSite).mockResolvedValue({ ok: true, command: "node", args: [], outputPath: null, logs: [], exitCode: 0 });
    await expect(h.run()).rejects.toThrow("App build failed or did not produce a static output folder.");
  });

  it("names an app with no build output", async () => {
    const h = await harness();
    h.input.mode = "build";
    await expect(h.run()).rejects.toThrow("App has no build output to preview: portal");
    expect(startStaticSitePreview).not.toHaveBeenCalled();
  });

  it.each(["currentness", "signal"] as const)("refuses static startup after %s changes during a held build", async (retirement) => {
    const h = await harness();
    h.input.mode = "build";
    h.app.scripts = { build: "node build.js" };
    const reached = deferred<void>();
    const release = deferred<void>();
    vi.mocked(buildSite).mockImplementation(async () => { reached.resolve(); await release.promise; return { ok: true, command: "node", args: [], outputPath: join(h.workspaceRoot, "portal/dist"), logs: [], exitCode: 0 }; });
    const pending = h.run();
    const rejected = expect(pending).rejects.toThrow(START_CANCELLED_MESSAGE);
    try {
      await reached.promise;
      if (retirement === "signal") h.controller.abort();
      else h.retire();
    } finally {
      release.resolve();
      await rejected;
    }
    expect(startStaticSitePreview).not.toHaveBeenCalled();
  });

  it("lets the real preview lifecycle stop a dev handle that arrives after sender retirement", async () => {
    const h = await harness();
    h.input.mode = "dev";
    h.app.scripts = { dev: "node server.js" };
    const allowOrigin = vi.fn(() => () => undefined);
    const lifecycle = createSitePreviewLifecycle<Awaited<ReturnType<typeof h.execute>>["result"]>({ allowOrigin });
    cleanups.push(() => lifecycle.stopAll());
    const reached = deferred<void>();
    const release = deferred<void>();
    vi.mocked(startSiteDevServer).mockImplementation(async () => { reached.resolve(); await release.promise; return h.devHandle; });
    const pending = lifecycle.start({ senderId: 7, workspaceId: "workspace-a", siteRoot: "portal", isCurrent: h.input.isCurrent, prepare: async () => (signal) => h.execute({ ...h.input, signal }) });
    const rejected = expect(pending).rejects.toThrow(START_CANCELLED_MESSAGE);
    try {
      await reached.promise;
      lifecycle.cancelSender(7);
    } finally {
      release.resolve();
      await rejected;
    }
    expect(vi.mocked(startSiteDevServer).mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(h.devHandle.stop).toHaveBeenCalledTimes(1);
    expect(allowOrigin).not.toHaveBeenCalled();
  });

  it("finishes a shared build after the window that asked first closes, for the window still holding it", async () => {
    const h = await harness();
    h.app.scripts = { build: "node build.js" };
    const lifecycle = createSitePreviewLifecycle<SitePreviewResultBody>({ allowOrigin: () => () => undefined });
    cleanups.push(() => lifecycle.stopAll());
    const open = new Map([[1, true], [2, true]]);
    const handler = createStartSitePreviewHandler({
      authority: {
        requireTrustedSender: (event: { sender: { id: number } }) => event.sender,
        withActiveWorkspace: (sender, _workspaceId, _subject, _action, work) =>
          work({
            workspace: { workspaceId: "workspace-a", rootPath: h.workspaceRoot },
            session: { isCurrent: () => open.get(sender.id) === true },
          }),
      },
      catalog: { list: async () => [h.app], get: async () => h.app },
      lifecycle,
      isSharedView: () => false,
      execute: h.execute,
    });
    const building = deferred<void>();
    const release = deferred<void>();
    vi.mocked(buildSite).mockImplementationOnce(async () => {
      building.resolve();
      await release.promise;
      return { ok: true, command: "node", args: ["build.js"], outputPath: join(h.workspaceRoot, "portal", "dist"), logs: [log("Built")], exitCode: 0 };
    });
    const start = (senderId: number, holderId: string) => handler(
      { sender: { id: senderId } },
      { workspaceId: "workspace-a", siteRoot: "portal", mode: "build", holderId, restart: false },
    );
    const asked = start(1, "tab");
    asked.catch(() => undefined);
    await building.promise;
    const joined = start(2, "pin");
    // The tab's window closes while the build runs.
    open.set(1, false);
    lifecycle.cancelSender(1);
    release.resolve();
    const shown = await joined;
    if ("replaced" in shown) throw new Error("The start was replaced.");
    expect(shown).toMatchObject({ siteRoot: "portal", mode: "build", exited: false });
    await expect(fetch(shown.url).then((response) => response.text())).resolves.toBe("<h1>Built app</h1>");
    expect(buildSite).toHaveBeenCalledOnce();
  });
});
