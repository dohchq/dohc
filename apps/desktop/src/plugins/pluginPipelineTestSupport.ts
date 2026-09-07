import { spawn } from "node:child_process";
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stop } from "esbuild";
import { vi } from "vitest";
import type { PluginHostOptions } from "./PluginHost";
import type { PluginPipeline } from "./PluginPipeline";
import { resolvePluginEsbuildBinary } from "./pluginBuildRunner";
import { PLUGIN_HOST_METHODS } from "./pluginHostProtocol";
import type { PluginInstallForkOptions, PluginInstallProcessHandle } from "./pluginInstallRunner";
import { workspaceStateKey } from "./pluginLocalState";

export const roots: string[] = [];

let resourcesParent: string;

export let resourcesBasePath: string;

// The production install forks this file, and so does every install here:
// Node runs its TypeScript source directly.
export const pnpmRunnerEntry = join(import.meta.dirname, "pluginPnpmRunnerProcess.ts");

export function nodeForkProcess(
  modulePath: string,
  args: string[],
  options: PluginInstallForkOptions,
): PluginInstallProcessHandle {
  const child = spawn(process.execPath, [modulePath, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio,
  });
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    onExit: (listener) => {
      child.once("exit", (code) => listener(code ?? 1));
    },
    onError: (listener) => {
      child.once("error", (error) => listener(error.message));
    },
    terminate: () => child.kill(),
  };
}

export async function stagePluginTools(): Promise<void> {
  resourcesParent = await mkdtemp(join(tmpdir(), "dohc-pipeline-tools-"));
  resourcesBasePath = join(resourcesParent, "resources");
  const requireFromTest = createRequire(import.meta.url);

  const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
  await cp(
    join(desktopRoot, "node_modules", "pnpm"),
    join(resourcesBasePath, "plugin-tools", "pnpm"),
    { recursive: true },
  );

  const platformKey = `${process.platform}-${process.arch}`;
  const esbuildPackageJson = requireFromTest.resolve("esbuild/package.json");
  const requireFromEsbuild = createRequire(esbuildPackageJson);
  const platformPackageJson = requireFromEsbuild.resolve(
    `@esbuild/${platformKey}/package.json`,
  );
  const sourceBinary = process.platform === "win32"
    ? join(dirname(platformPackageJson), "esbuild.exe")
    : join(dirname(platformPackageJson), "bin", "esbuild");
  const destinationBinary = resolvePluginEsbuildBinary(resourcesBasePath);
  await mkdir(dirname(destinationBinary), { recursive: true });
  await copyFile(sourceBinary, destinationBinary);
  if (process.platform !== "win32") await chmod(destinationBinary, 0o755);
}

export async function createPluginWorkspace(): Promise<{
  root: string;
  workspaceRoot: string;
  pluginRoot: string;
  entryPath: string;
  stateDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dohc-plugin-pipeline-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const pluginRoot = join(workspaceRoot, "plugins", "example-plugin");
  const entryPath = join(pluginRoot, "src", "index.ts");
  const stateDir = join(root, "state");
  await Promise.all([
    mkdir(dirname(entryPath), { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(pluginRoot, "dohc-plugin.json"), `${JSON.stringify({
      version: 1,
      name: "example-plugin",
      displayName: "Example plugin",
      entry: "src/index.ts",
    }, null, 2)}\n`),
    writeFile(join(pluginRoot, "package.json"), `${JSON.stringify({
      name: "example-plugin",
      version: "1.0.0",
      private: true,
      type: "module",
      packageManager: "pnpm@11.20.0",
    }, null, 2)}\n`),
    writeFile(join(pluginRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "",
    ].join("\n")),
    writeFile(entryPath, [
      'export const marker = "one";',
      "export default { activate() {} };",
      "",
    ].join("\n")),
  ]);
  return { root, workspaceRoot, pluginRoot, entryPath, stateDir };
}

export async function createNamedPluginWorkspace(directoryName: string, pluginId: string): Promise<{
  root: string;
  workspaceRoot: string;
  pluginRoot: string;
  entryPath: string;
  stateDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dohc-plugin-pipeline-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const pluginRoot = join(workspaceRoot, "plugins", directoryName);
  const entryPath = join(pluginRoot, "src", "index.ts");
  const stateDir = join(root, "state");
  await Promise.all([
    mkdir(dirname(entryPath), { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(pluginRoot, "dohc-plugin.json"), `${JSON.stringify({
      version: 1,
      name: pluginId,
      displayName: pluginId,
      entry: "src/index.ts",
    }, null, 2)}\n`),
    writeFile(join(pluginRoot, "package.json"), `${JSON.stringify({
      name: pluginId,
      version: "1.0.0",
      private: true,
      type: "module",
      packageManager: "pnpm@11.20.0",
    }, null, 2)}\n`),
    writeFile(join(pluginRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "",
    ].join("\n")),
    writeFile(entryPath, [
      'export const marker = "one";',
      "export default { activate() {} };",
      "",
    ].join("\n")),
  ]);
  return { root, workspaceRoot, pluginRoot, entryPath, stateDir };
}

// Matches PluginPipeline's own dohcDir computation exactly: derived plugin
// artifacts live under <stateDir>/plugin-data/<workspaceStateKey>, never
// inside the workspace folder (CERT779).
export function pluginsDataRoot(
  fixture: { stateDir: string; workspaceRoot: string },
): string {
  return join(
    fixture.stateDir,
    "plugin-data",
    workspaceStateKey(fixture.workspaceRoot),
    "plugins",
  );
}

export function liveBundlePath(
  fixture: { stateDir: string; workspaceRoot: string },
  pluginId: string,
): string {
  return join(pluginsDataRoot(fixture), pluginId, "bundle.mjs");
}

/** Staged source trees are siblings of the live root, so this finds any left. */
export async function stagingLeftovers(
  fixture: { stateDir: string; workspaceRoot: string },
  pluginId: string,
): Promise<string[]> {
  const names = await readdir(pluginsDataRoot(fixture)).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith(`${pluginId}.snap-staging-`));
}

/**
 * Pass a function for any message that reads live state: a template string
 * argument is built before the wait starts, so it reports the state the
 * pipeline was in on the way in rather than the one it timed out in.
 */
export async function waitFor(
  condition: () => boolean,
  message: string | (() => string),
  timeoutMs = 30_000,
): Promise<void> {
  await vi.waitFor(
    () => {
      if (!condition()) throw new Error(typeof message === "string" ? message : message());
    },
    { timeout: timeoutMs, interval: 20 },
  );
}

export async function ensureFromCommand(
  pipeline: PluginPipeline,
  pluginId: string,
): Promise<{
  result: Awaited<ReturnType<PluginPipeline["ensureStarted"]>>["value"];
  exact: Awaited<ReturnType<PluginPipeline["ensureStarted"]>>;
}> {
  let exact: Awaited<ReturnType<PluginPipeline["ensureStarted"]>> | undefined;
  const command = await pipeline.hostOwnership.runCommand(
    pluginId,
    async (authority) => authority.start(async () => {
      exact = await pipeline.ensureStarted(pluginId, authority);
      return exact;
    }),
  );
  if (command.kind !== "completed" || command.value.kind !== "admitted") {
    throw new Error(`Plugin "${pluginId}" start was refused.`);
  }
  if (!exact) throw new Error(`Plugin "${pluginId}" returned no start result.`);
  return { result: command.value.value, exact };
}

export async function ensureFromSurface(
  pipeline: PluginPipeline,
  pluginId: string,
): Promise<{
  result: Awaited<ReturnType<PluginPipeline["ensureStarted"]>>["value"];
  exact: Awaited<ReturnType<PluginPipeline["ensureStarted"]>>;
  release: () => Promise<void>;
}> {
  const lease = pipeline.hostOwnership.acquireSurface(pluginId);
  if ("kind" in lease) throw new Error(`Plugin "${pluginId}" surface was refused.`);
  let exact: Awaited<ReturnType<PluginPipeline["ensureStarted"]>> | undefined;
  const started = await lease.start(async (authority) => {
    exact = await pipeline.ensureStarted(pluginId, authority);
    return exact;
  });
  if (started.kind !== "admitted") {
    await lease.release();
    throw new Error(`Plugin "${pluginId}" start was refused.`);
  }
  if (!exact) {
    await lease.release();
    throw new Error(`Plugin "${pluginId}" returned no start result.`);
  }
  return { result: started.value, exact, release: () => lease.release() };
}

export function fakeSpawnTransport(
  registeredCommands: () => string[] = () => [],
  beforeRequest?: (method: string) => Promise<void> | void,
): PluginHostOptions["spawnTransport"] {
  return vi.fn<PluginHostOptions["spawnTransport"]>(() => ({
    request: async <T = unknown>(method: string): Promise<T> => {
      await beforeRequest?.(method);
      return (method === PLUGIN_HOST_METHODS.activate
        ? { commands: registeredCommands(), drivers: [] }
        : {}) as T;
    },
    notify: () => undefined,
    dispose: async () => undefined,
  }));
}

export async function cleanupPluginWorkspaces(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
}

export async function cleanupPluginTools(): Promise<void> {
  // R7 fix: real builds above spawn esbuild's shared service process from
  // the staged binary under resourcesParent, which holds the executable
  // open until stopped — that blocks deleting it on Windows.
  await stop();
  await rm(resourcesParent, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
