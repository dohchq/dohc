import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { resolveWorkspaceFile } from "../workspaces/workspaceAssets";
import { readPluginManifestFile } from "./pluginManifest";
import type { DohcPluginManifest } from "./pluginManifestSchema";
import type { PluginPipelineStatusEvent } from "./PluginPipeline";

export interface PluginPanelRegistration {
  pluginRoot: string;
  manifest: DohcPluginManifest;
  panel: NonNullable<DohcPluginManifest["panels"]>[number];
}

export interface PluginWebAppRegistration {
  pluginRoot: string;
  manifest: DohcPluginManifest;
  webApp: NonNullable<DohcPluginManifest["webApps"]>[number];
}

/** What the main process serves a plugin's panels from, per workspace. */
export interface RegisteredPlugin {
  pluginRoot: string;
  manifest: DohcPluginManifest;
}

export interface PluginRegistrationSource {
  pluginRegistration(pluginId: string): RegisteredPlugin | null;
}

export function resolveRegisteredPlugin(
  pluginId: string,
  pipeline: PluginRegistrationSource | undefined,
  remembered: ReadonlyMap<string, RegisteredPlugin> | undefined,
): RegisteredPlugin | undefined {
  return pipeline?.pluginRegistration(pluginId) ??
    remembered?.get(pluginId) ??
    undefined;
}

/**
 * Records the newest registration for a plugin in a workspace, replacing the
 * one before it. Keeping the first registration forever froze the manifest
 * panels are served from, so an approved manifest edit that added a panel or
 * changed an entry never became servable — not even after reopening the
 * workspace (#779 round 10 B7). The plugin root is the one thing that cannot
 * change under an id while it is registered.
 */
export function rememberPluginRegistration(
  registrations: Map<string, Map<string, RegisteredPlugin>>,
  workspaceId: string,
  registration: { pluginRoot: string; manifest: DohcPluginManifest },
): RegisteredPlugin {
  const forWorkspace = registrations.get(workspaceId) ??
    new Map<string, RegisteredPlugin>();
  const existing = forWorkspace.get(registration.manifest.name);
  if (
    existing &&
    resolve(existing.pluginRoot) !== resolve(registration.pluginRoot)
  ) {
    throw new Error(
      `Plugin "${registration.manifest.name}" is already running from another root.`,
    );
  }
  const remembered: RegisteredPlugin = {
    pluginRoot: registration.pluginRoot,
    manifest: registration.manifest,
  };
  forWorkspace.set(registration.manifest.name, remembered);
  registrations.set(workspaceId, forWorkspace);
  return remembered;
}

/** The key a plugin's host lifetime is tracked under, per workspace. */
export function pluginLifecycleKey(
  workspaceId: string,
  pluginId: string,
): string {
  return `${workspaceId}\0${pluginId}`;
}

/** What `PluginPipeline.ensureStarted` reports back to a panel start. */
export type PluginPanelHostStartResult =
  | { ok: true; startedHost: boolean }
  | { ok: false; error: { message: string } };

/**
 * Starts a plugin because a caller needs it. Panel and web-app callers record
 * a claim on the host's lifetime. Other callers can opt out when the host
 * should live for the workspace instead.
 *
 * Returning on a spawned-but-still-activating host is what made a cold open
 * fail: the surface's next call reached the plugin before `activate()`
 * resolved and was refused as "still starting" (#798). So both paths end on
 * the host's activation — the one for a host something else already started,
 * and the one this call started itself.
 *
 * The claim is made only when this start performed the zero-to-running
 * transition, which the pipeline reports from inside its own per-plugin
 * queue: a plugin the workspace enabled keeps running with no panel open, so
 * a panel that merely rode along must not stop it on close (#779 round 4
 * finding 3, round 10 B3). A start that ran the host owns it even if that
 * host then fails to activate — nothing else is going to stop it.
 */
export async function startPluginForPanel(input: {
  panelStartedHosts: Set<string>;
  workspaceId: string;
  pluginId: string;
  claim?: boolean;
  /** The running host's activation, or undefined when no host is running. */
  hostActivation: () => Promise<void> | undefined;
  ensureStarted: () => Promise<PluginPanelHostStartResult>;
}): Promise<void> {
  const running = input.hostActivation();
  if (running) return running;
  const result = await input.ensureStarted();
  if (!result.ok) throw new Error(result.error.message);
  if (result.startedHost && input.claim !== false) {
    input.panelStartedHosts.add(
      pluginLifecycleKey(input.workspaceId, input.pluginId),
    );
  }
  await input.hostActivation();
}

/**
 * Forgets what the main process remembers about a plugin that is gone: the
 * manifest its panels are served from, and any panel claim on its host. A
 * refused uninstall changes nothing, so the plugin keeps both (#779 round 10
 * B7).
 */
export function forgetUninstalledPlugin(input: {
  registrations: Map<string, Map<string, RegisteredPlugin>>;
  panelStartedHosts: Set<string>;
  workspaceId: string;
  pluginId: string;
  uninstalled: boolean;
}): void {
  if (!input.uninstalled) return;
  input.registrations.get(input.workspaceId)?.delete(input.pluginId);
  input.panelStartedHosts.delete(
    pluginLifecycleKey(input.workspaceId, input.pluginId),
  );
}

/**
 * Forgets a plugin the pipeline reports as removed. Uninstall is not the
 * only way an identity departs: a rename (`plugins/foo` to `plugins/bar`,
 * same manifest name) removes the old identity through the watcher path,
 * and its stale registration kept every panel of the reinstalled plugin
 * throwing "already running from another root" until the workspace
 * reopened (#779 round 14 A5).
 */
export function forgetRemovedPlugin(input: {
  registrations: Map<string, Map<string, RegisteredPlugin>>;
  panelStartedHosts: Set<string>;
  workspaceId: string;
  event: PluginPipelineStatusEvent;
}): void {
  if (input.event.kind !== "removed") return;
  forgetUninstalledPlugin({
    registrations: input.registrations,
    panelStartedHosts: input.panelStartedHosts,
    workspaceId: input.workspaceId,
    pluginId: input.event.pluginId,
    uninstalled: true,
  });
}

/**
 * Forgets the registrations of a workspace that is closing. They describe
 * manifests read from a workspace that is no longer open; reopening a panel
 * re-reads them. Every other workspace keeps its own (#779 round 10 B7).
 */
export function forgetWorkspaceRegistrations(
  registrations: Map<string, Map<string, RegisteredPlugin>>,
  workspaceId: string,
): void {
  registrations.delete(workspaceId);
}

function workspaceRelativePluginRoot(
  workspaceRoot: string,
  pluginRoot: string,
): string {
  if (!isAbsolute(pluginRoot)) return pluginRoot;
  const resolved = relative(workspaceRoot, pluginRoot);
  if (resolved.length === 0) return ".";
  if (
    isAbsolute(resolved) ||
    resolved === ".." ||
    resolved.startsWith(`..${sep}`)
  ) {
    throw new Error(`Plugin root escapes the workspace: ${pluginRoot}.`);
  }
  return resolved.replaceAll("\\", "/");
}

async function loadValidatedPluginManifest(input: {
  workspaceRoot: string;
  pluginRoot: string;
  pluginId: string;
  pluginRegistration?: PluginRegistrationSource;
}): Promise<{ pluginRoot: string; manifest: DohcPluginManifest }> {
  const requestedRoot = workspaceRelativePluginRoot(
    input.workspaceRoot,
    input.pluginRoot,
  );
  const { realTarget: pluginRoot } = await resolveWorkspaceFile(
    input.workspaceRoot,
    requestedRoot,
    "write",
  );
  const canonicalWorkspaceRoot = await realpath(input.workspaceRoot);
  const canonicalRelative = relative(canonicalWorkspaceRoot, pluginRoot).replaceAll(
    "\\",
    "/",
  );
  const canonicalSegments = canonicalRelative.split("/");
  if (
    canonicalSegments.length < 2 ||
    canonicalSegments[0]?.toLowerCase() !== "plugins"
  ) {
    throw new Error(
      `Plugin root must be under the workspace plugins/ tree: ${input.pluginRoot}.`,
    );
  }
  if (!(await stat(pluginRoot)).isDirectory()) {
    throw new Error(`Plugin root is not a directory: ${input.pluginRoot}.`);
  }

  const registered = input.pluginRegistration?.pluginRegistration(input.pluginId);
  let manifest = registered?.manifest;
  if (!manifest) {
    const read = await readPluginManifestFile(pluginRoot);
    if (!read.ok) {
      throw new Error(`Plugin manifest is invalid. ${read.diagnostics.join("; ")}`);
    }
    manifest = read.manifest;
  }
  if (manifest.name !== input.pluginId) {
    throw new Error(
      `Plugin id "${input.pluginId}" does not match manifest name "${manifest.name}".`,
    );
  }
  return { pluginRoot, manifest };
}

export async function loadPluginPanelRegistration(input: {
  workspaceRoot: string;
  pluginRoot: string;
  pluginId: string;
  panelId: string;
  pluginRegistration?: PluginRegistrationSource;
}): Promise<PluginPanelRegistration> {
  const { pluginRoot, manifest } = await loadValidatedPluginManifest(input);
  const panel = manifest.panels?.find(
    (candidate) => candidate.id === input.panelId,
  );
  if (!panel) {
    throw new Error(
      `Plugin "${input.pluginId}" does not declare panel "${input.panelId}".`,
    );
  }
  // One panel runs once per workspace, so a panel cannot be a tab and a view
  // at the same time: opening this one as a tab would stop the rail's copy.
  if (panel.placement !== "editor") {
    throw new Error(
      `Plugin "${input.pluginId}" panel "${input.panelId}" has placement ` +
        `"${panel.placement}", so it opens in the activity bar, not as a tab.`,
    );
  }
  return { pluginRoot, manifest, panel };
}

export async function loadPluginWebAppRegistration(input: {
  workspaceRoot: string;
  pluginRoot: string;
  pluginId: string;
  webAppId: string;
  pluginRegistration?: PluginRegistrationSource;
}): Promise<PluginWebAppRegistration> {
  const { pluginRoot, manifest } = await loadValidatedPluginManifest(input);
  const webApp = manifest.webApps?.find(
    (candidate) => candidate.id === input.webAppId,
  );
  if (!webApp) {
    throw new Error(
      `Plugin "${input.pluginId}" does not declare web app "${input.webAppId}".`,
    );
  }
  return { pluginRoot, manifest, webApp };
}
