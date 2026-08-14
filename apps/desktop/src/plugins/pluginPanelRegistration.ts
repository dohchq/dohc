import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { resolveWorkspaceFile } from "../workspaces/workspaceAssets";
import { readPluginManifestFile } from "./pluginManifest";
import type { DohcPluginManifest } from "./pluginManifestSchema";

export interface PluginPanelRegistration {
  pluginRoot: string;
  manifest: DohcPluginManifest;
  panel: NonNullable<DohcPluginManifest["panels"]>[number];
}

/** What the main process serves a plugin's panels from, per workspace. */
export interface RegisteredPlugin {
  pluginRoot: string;
  manifest: DohcPluginManifest;
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
  registration: PluginPanelRegistration,
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
 * Starts a plugin because a panel needs it, and records the panel's claim on
 * the host's lifetime.
 *
 * The claim is made only when this start performed the zero-to-running
 * transition, which the pipeline reports from inside its own per-plugin
 * queue: a plugin the workspace enabled keeps running with no panel open, so
 * a panel that merely rode along must not stop it on close (#779 round 4
 * finding 3, round 10 B3).
 */
export async function startPluginForPanel(input: {
  panelStartedHosts: Set<string>;
  workspaceId: string;
  pluginId: string;
  isHostRunning: () => boolean;
  ensureStarted: () => Promise<PluginPanelHostStartResult>;
}): Promise<void> {
  if (input.isHostRunning()) return;
  const result = await input.ensureStarted();
  if (!result.ok) throw new Error(result.error.message);
  if (!result.startedHost) return;
  input.panelStartedHosts.add(
    pluginLifecycleKey(input.workspaceId, input.pluginId),
  );
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

export async function loadPluginPanelRegistration(input: {
  workspaceRoot: string;
  pluginRoot: string;
  pluginId: string;
  panelId: string;
}): Promise<PluginPanelRegistration> {
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

  const read = await readPluginManifestFile(pluginRoot);
  if (!read.ok) {
    throw new Error(`Plugin manifest is invalid. ${read.diagnostics.join("; ")}`);
  }
  if (read.manifest.name !== input.pluginId) {
    throw new Error(
      `Plugin id "${input.pluginId}" does not match manifest name "${read.manifest.name}".`,
    );
  }
  const panel = read.manifest.panels?.find(
    (candidate) => candidate.id === input.panelId,
  );
  if (!panel) {
    throw new Error(
      `Plugin "${input.pluginId}" does not declare panel "${input.panelId}".`,
    );
  }
  return { pluginRoot, manifest: read.manifest, panel };
}
