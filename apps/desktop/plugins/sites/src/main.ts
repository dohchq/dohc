import type {
  PluginActivateContext,
  PluginChildProcessCommandHandle,
  PluginHandler,
  PluginWebAppStart,
} from "@dohc/sdk/node";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  availableModes,
  discoverSites,
  heuristicMode,
  parsePreviewInstanceKey,
  SITE_SIGNAL_FILES,
  type PreviewMode,
  type RunnableMode,
  type SiteSource,
  type WorkspaceSite,
} from "../ui/sites.js";
import {
  assertLoopbackOnlyCommand,
  detectDevUrl,
  packageManagerCommand,
  splitCommandLine,
  type SiteCommand,
} from "./command.js";
import { startSiteServer, type SiteServer } from "./staticServer.js";

/** The web app every preview opens under. */
const PREVIEW_WEB_APP_ID = "preview";

/**
 * How long a build may run.
 *
 * A build serves through this plugin's own server, so the tab is open and
 * showing the build's output long before this limit — dohc's own limit on
 * starting a web app does not apply to it.
 */
const BUILD_TIMEOUT_MS = 120_000;

/** Directories a build writes its site into, when nothing names one. */
const DEFAULT_BUILD_OUTPUTS = ["dist", "build", "out"];

/** Where this plugin remembers the mode each site last opened in. */
const PREVIEW_MODE_FILE = "preview-modes.json";

/** Log lines one preview keeps for its status page. */
const MAX_LOG_LINES = 500;

interface Preview {
  stop(): Promise<void>;
}

let context: PluginActivateContext | null = null;
const previews = new Map<string, Preview>();

function requireContext(): PluginActivateContext {
  if (!context) throw new Error("The sites plugin is not running.");
  return context;
}

function previewKey(webAppId: string, instanceKey: string): string {
  return `${webAppId}\0${instanceKey}`;
}

function siteAbsolutePath(workspaceRoot: string, root: string, child = ""): string {
  const parts = [...root.split("/"), ...child.split("/")].filter((part) => part !== "");
  return join(workspaceRoot, ...parts);
}

/** Splits a site-relative page into the directory to serve and the page in it. */
export function servedEntry(entry: string): { directory: string; page: string } {
  const slash = entry.lastIndexOf("/");
  return slash === -1
    ? { directory: "", page: entry }
    : { directory: entry.slice(0, slash), page: entry.slice(slash + 1) };
}

/**
 * Reads one site out of the workspace.
 *
 * Detection runs over the same paths and the same signal files the panel's
 * list uses, through the same door, so what dohc starts is what the user
 * clicked on.
 */
async function loadSite(
  ctx: PluginActivateContext,
  root: string,
): Promise<WorkspaceSite> {
  const entries = await ctx.client.files.list(root === "" ? "." : root, {
    recursive: true,
  });
  /** @type The site's own config decides what it is; deeper ones are other sites. */
  const sources: SiteSource[] = [];
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf("/");
    const parent = slash === -1 ? "" : entry.path.slice(0, slash);
    const name = slash === -1 ? entry.path : entry.path.slice(slash + 1);
    if (parent === root && SITE_SIGNAL_FILES.includes(name)) {
      const read = await ctx.client.files.readInfo(entry.path).catch(() => null);
      sources.push({ path: entry.path, ...(read ? { body: read.text } : {}) });
      continue;
    }
    sources.push({ path: entry.path });
  }

  const site = discoverSites(sources).find((candidate) => candidate.root === root);
  if (!site) {
    throw new Error(
      `This workspace holds no site at "${root === "" ? "." : root}". It may have been renamed or deleted.`,
    );
  }
  return site;
}

/** The mode a preview opens in, given what the user asked for. */
export function resolveMode(
  site: WorkspaceSite,
  requested: PreviewMode,
  remembered: RunnableMode | null,
  configured: PreviewMode,
): RunnableMode {
  const modes = availableModes(site);
  if (modes.length === 0) {
    throw new Error(
      `"${site.title}" has nothing to preview: it has no page to serve and no dev or build script.`,
    );
  }
  if (requested !== "auto") {
    if (modes.includes(requested)) return requested;
    throw new Error(
      `"${site.title}" cannot open in ${requested} mode. It opens in ${modes.join(" or ")}.`,
    );
  }
  if (remembered && modes.includes(remembered)) return remembered;
  if (configured !== "auto" && modes.includes(configured)) return configured;
  const heuristic = heuristicMode(site, modes);
  if (!heuristic) {
    throw new Error(`"${site.title}" has nothing to preview.`);
  }
  return heuristic;
}

async function readRememberedModes(
  ctx: PluginActivateContext,
): Promise<Record<string, RunnableMode>> {
  try {
    const body = await readFile(join(ctx.stateRoot, PREVIEW_MODE_FILE), "utf8");
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const modes: Record<string, RunnableMode> = {};
    for (const [root, mode] of Object.entries(parsed)) {
      if (mode === "static" || mode === "dev" || mode === "build") modes[root] = mode;
    }
    return modes;
  } catch {
    // Remembering is a convenience. A preview must open without it.
    return {};
  }
}

async function rememberMode(
  ctx: PluginActivateContext,
  root: string,
  mode: RunnableMode,
): Promise<void> {
  try {
    const modes = await readRememberedModes(ctx);
    if (modes[root] === mode) return;
    modes[root] = mode;
    await mkdir(ctx.stateRoot, { recursive: true });
    await writeFile(
      join(ctx.stateRoot, PREVIEW_MODE_FILE),
      `${JSON.stringify(modes, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Same reason: a preview that opened must not fail because the note of it
    // could not be written.
  }
}

/**
 * The command that runs one of a site's own scripts.
 *
 * A command the site's `dohc.json` wrote out runs as written. Otherwise the
 * site's own package manager runs the script by name, because that is what
 * resolves the binaries a package script expects.
 */
export function siteCommand(site: WorkspaceSite, script: "dev" | "start" | "build"): SiteCommand {
  const configured = site.configuredScripts[script];
  if (configured) return splitCommandLine(configured);
  const inferred = site.scripts[script];
  if (!inferred) throw new Error(`"${site.title}" has no ${script} script.`);
  if (site.hasPackage) return packageManagerCommand(site.packageManager ?? "npm", script);
  return splitCommandLine(inferred);
}

/** Which of a site's two ways of starting a dev server it actually has. */
export function devScript(site: WorkspaceSite): "dev" | "start" {
  return site.configuredScripts.dev || site.scripts.dev ? "dev" : "start";
}

function pushLines(log: string[], text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 0) log.push(line);
  }
  if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES);
}

async function startStaticPreview(
  ctx: PluginActivateContext,
  site: WorkspaceSite,
): Promise<{ preview: Preview; url: string }> {
  if (!site.entry) throw new Error(`"${site.title}" has no page to serve.`);
  const { directory, page } = servedEntry(site.entry);
  const server = await startSiteServer({
    workspaceRoot: ctx.workspaceRoot,
    status: { heading: site.title, detail: "Opening this site." },
  });
  try {
    await server.serveDirectory({
      rootPath: siteAbsolutePath(ctx.workspaceRoot, site.root, directory),
      entry: page,
    });
  } catch (error) {
    await server.stop();
    throw error;
  }
  return { preview: { stop: () => server.stop() }, url: server.url };
}

async function startBuildPreview(
  ctx: PluginActivateContext,
  site: WorkspaceSite,
): Promise<{ preview: Preview; url: string }> {
  const command = siteCommand(site, "build");
  const server = await startSiteServer({
    workspaceRoot: ctx.workspaceRoot,
    status: { heading: site.title, detail: `Building with ${commandText(command)}.` },
  });

  const log: string[] = [];
  let child: PluginChildProcessCommandHandle | null = null;
  let stopped = false;

  const run = async (): Promise<void> => {
    child = await ctx.childProcesses.spawnCommand({
      command: command.command,
      args: command.args,
      cwd: { workspaceRoot: true, path: site.root === "" ? undefined : site.root },
    });
    const unsubscribe = await child.onOutput((output) => {
      pushLines(log, output.text);
      server.setStatus({
        heading: site.title,
        detail: `Building with ${commandText(command)}.`,
        log,
      });
    });
    const timer = setTimeout(() => {
      pushLines(log, `The build did not finish within ${BUILD_TIMEOUT_MS} ms.`);
      void child?.terminate().catch(() => undefined);
    }, BUILD_TIMEOUT_MS);
    try {
      const exit = await child.wait();
      if (stopped) return;
      if (exit.code !== 0) {
        server.setFailed({
          heading: `${site.title} did not build`,
          detail:
            exit.reason === "terminated"
              ? `The build was stopped after ${BUILD_TIMEOUT_MS} ms.`
              : `The build exited with code ${exit.code ?? "unknown"}.`,
          log,
        });
        return;
      }
      await serveBuildOutput(ctx, site, server, log);
    } finally {
      clearTimeout(timer);
      await unsubscribe().catch(() => undefined);
    }
  };

  void run().catch((error: unknown) => {
    if (stopped) return;
    pushLines(log, error instanceof Error ? error.message : String(error));
    server.setFailed({
      heading: `${site.title} did not build`,
      detail: "The build could not run.",
      log,
    });
  });

  return {
    preview: {
      stop: async () => {
        stopped = true;
        await child?.terminate().catch(() => undefined);
        await server.stop();
      },
    },
    url: server.url,
  };
}

function commandText(command: SiteCommand): string {
  return [command.command, ...command.args].join(" ");
}

async function serveBuildOutput(
  ctx: PluginActivateContext,
  site: WorkspaceSite,
  server: SiteServer,
  log: string[],
): Promise<void> {
  const candidates = [...site.buildOutputs, ...DEFAULT_BUILD_OUTPUTS];
  for (const candidate of candidates) {
    try {
      await server.serveDirectory({
        rootPath: siteAbsolutePath(ctx.workspaceRoot, site.root, candidate),
        entry: "index.html",
      });
      return;
    } catch {
      // Try the next place a build writes its site into.
    }
  }
  server.setFailed({
    heading: `${site.title} built, but has no page`,
    detail: `The build wrote no index.html into ${candidates.join(", ")}. Name the directory in this site's dohc.json under build.output.`,
    log,
  });
}

async function startDevPreview(
  ctx: PluginActivateContext,
  site: WorkspaceSite,
  readyTimeoutMs: number,
): Promise<{ preview: Preview; url: string }> {
  const command = siteCommand(site, devScript(site));
  assertLoopbackOnlyCommand(command.command, command.args);
  const child = await ctx.childProcesses.spawnCommand({
    command: command.command,
    args: command.args,
    cwd: { workspaceRoot: true, path: site.root === "" ? undefined : site.root },
  });

  const log: string[] = [];
  const preview: Preview = {
    stop: async () => {
      await child.terminate().catch(() => undefined);
    },
  };

  try {
    const url = await waitForDevUrl(child, log, readyTimeoutMs);
    return { preview, url };
  } catch (error) {
    // Bring the dev server down before reporting: a caller told the start
    // failed must not be able to delete or switch the workspace while the
    // server still holds the site directory.
    await preview.stop();
    throw error;
  }
}

async function waitForDevUrl(
  child: PluginChildProcessCommandHandle,
  log: string[],
  readyTimeoutMs: number,
): Promise<string> {
  const subscription: { stop: (() => Promise<void>) | null } = { stop: null };
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (result: { url: string } | { error: Error }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if ("error" in result) reject(result.error);
        else resolve(result.url);
      };
      const timer = setTimeout(() => {
        finish({
          error: new Error(
            `This site's dev server did not report a local address within ${readyTimeoutMs} ms.`,
          ),
        });
      }, readyTimeoutMs);

      void child
        .onOutput((output) => {
          pushLines(log, output.text);
          const url = detectDevUrl(output.text);
          if (url) finish({ url });
        })
        .then((stop) => {
          subscription.stop = stop;
          if (settled) void stop().catch(() => undefined);
        })
        .catch((error: unknown) => {
          finish({ error: error instanceof Error ? error : new Error(String(error)) });
        });

      void child
        .wait({ timeoutMs: readyTimeoutMs + 1_000 })
        .then((exit) => {
          finish({
            error: new Error(
              `This site's dev server exited before it was ready (code ${exit.code ?? "unknown"}).${
                log.length > 0 ? ` Last output: ${log.at(-1)}` : ""
              }`,
            ),
          });
        })
        .catch(() => undefined);
    });
  } finally {
    await subscription.stop?.().catch(() => undefined);
  }
}

async function stopPreview(key: string): Promise<void> {
  const preview = previews.get(key);
  if (!preview) return;
  previews.delete(key);
  await preview.stop().catch(() => undefined);
}

const handler: PluginHandler = {
  activate(ctx) {
    context = ctx;
  },

  async startWebApp(webAppId, instanceKey): Promise<PluginWebAppStart> {
    const ctx = requireContext();
    if (webAppId !== PREVIEW_WEB_APP_ID) {
      throw new Error(`The sites plugin serves no web app named "${webAppId}".`);
    }
    if (instanceKey === null) {
      throw new Error("A site preview opens one tab per site, so an open must name one.");
    }
    const { root, mode } = parsePreviewInstanceKey(instanceKey);
    const site = await loadSite(ctx, root);
    const settings = ctx.settings.get();
    const configured = settings.defaultPreviewMode;
    const resolved = resolveMode(
      site,
      mode,
      (await readRememberedModes(ctx))[root] ?? null,
      configured === "static" || configured === "dev" || configured === "build"
        ? configured
        : "auto",
    );

    // A second start for the same tab replaces the first: dohc calls this
    // again when a guest never arrived, and two servers for one tab would
    // leave the older one running with nothing showing it.
    const key = previewKey(webAppId, instanceKey);
    await stopPreview(key);

    const readyTimeoutMs = devReadyTimeoutMs(settings.devServerTimeoutSeconds);
    const started =
      resolved === "static"
        ? await startStaticPreview(ctx, site)
        : resolved === "build"
          ? await startBuildPreview(ctx, site)
          : await startDevPreview(ctx, site, readyTimeoutMs);

    previews.set(key, started.preview);
    await rememberMode(ctx, root, resolved);
    return { url: started.url, title: `${site.title} (${resolved})` };
  },

  async stopWebApp(webAppId, instanceKey) {
    if (instanceKey === null) return;
    await stopPreview(previewKey(webAppId, instanceKey));
  },

  async deactivate() {
    const running = [...previews.keys()];
    await Promise.all(running.map((key) => stopPreview(key)));
    context = null;
  },
};

/** Seconds the user set, held to what a dev server plausibly takes. */
export function devReadyTimeoutMs(value: unknown): number {
  const seconds = typeof value === "number" && Number.isFinite(value) ? value : 15;
  return Math.min(Math.max(Math.round(seconds), 1), 120) * 1_000;
}

export default handler;
