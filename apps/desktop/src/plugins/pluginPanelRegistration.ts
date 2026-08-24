import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isInside } from "../security/pathContainment";
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
  // The pipeline's own discovered directoryName for this id — never
  // re-derived from pluginRoot's basename, which an in-workspace symlink
  // can resolve to a different final segment than the plugin's actual
  // discovered directory: a basename-derived name can silently stop
  // matching the pipeline's own directoryName, so the forget gate below
  // never matches and a stale registration survives uninstall. Explicit,
  // the same way PluginHost.start's own directoryName is never derived —
  // this id's own claim on this workspace is only ever THIS directory's to
  // forget.
  directoryName: string;
}

export interface PluginRegistrationSource {
  pluginRegistration(pluginId: string): RegisteredPlugin | null;
  hasUnrecoverableFailedReplacement(pluginId: string): boolean;
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
 * workspace. The plugin root is the one thing that cannot change under an
 * id while it is registered.
 */
export function rememberPluginRegistration(
  registrations: Map<string, Map<string, RegisteredPlugin>>,
  workspaceId: string,
  registration: { pluginRoot: string; manifest: DohcPluginManifest; directoryName: string },
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
    directoryName: registration.directoryName,
  };
  forWorkspace.set(registration.manifest.name, remembered);
  registrations.set(workspaceId, forWorkspace);
  return remembered;
}

/**
 * Forgets the registration the main process remembers for a removed plugin.
 * A refused uninstall changes nothing, so the plugin keeps its registration.
 */
export function forgetUninstalledPlugin(input: {
  registrations: Map<string, Map<string, RegisteredPlugin>>;
  workspaceId: string;
  pluginId: string;
  directoryName: string;
  uninstalled: boolean;
}): void {
  if (!input.uninstalled) return;
  const forWorkspace = input.registrations.get(input.workspaceId);
  const registered = forWorkspace?.get(input.pluginId);
  // The standing trace-to-directory rule: this registration is only the
  // departed row's to forget when both name the same directory. Two rows can share an
  // id (a broken manifest's directory-derived fallback colliding with
  // some other, unrelated plugin's real id) — an id-losing loser's own
  // removal must never reach into a still-installed winner's live
  // registration under that shared id. Nothing registered at all is
  // trivially nothing to forget either way.
  if (!registered || registered.directoryName !== input.directoryName) return;
  forWorkspace?.delete(input.pluginId);
}

/**
 * Forgets a plugin the pipeline reports as removed or renamed. A rename's
 * OLD registration is just as stale as an uninstalled one — its pluginRoot
 * still points at the vacated directory — so every panel of the renamed
 * plugin would throw "already running from another root" until the
 * workspace reopened, the same failure an uninstalled plugin's stale
 * registration causes.
 */
export function forgetRemovedPlugin(input: {
  registrations: Map<string, Map<string, RegisteredPlugin>>;
  workspaceId: string;
  event: PluginPipelineStatusEvent;
}): void {
  if (input.event.kind !== "removed" && input.event.kind !== "renamed") return;
  forgetUninstalledPlugin({
    registrations: input.registrations,
    workspaceId: input.workspaceId,
    pluginId: input.event.pluginId,
    directoryName: input.event.kind === "removed"
      ? input.event.directoryName
      : input.event.from,
    uninstalled: true,
  });
}

/**
 * Forgets the registrations of a workspace that is closing. They describe
 * manifests read from a workspace that is no longer open; reopening a panel
 * re-reads them. Every other workspace keeps its own.
 */
export function forgetWorkspaceRegistrations(
  registrations: Map<string, Map<string, RegisteredPlugin>>,
  workspaceId: string,
): void {
  registrations.delete(workspaceId);
}

async function workspaceRelativePluginRoot(
  workspaceRoot: string,
  pluginRoot: string,
): Promise<string> {
  if (!isAbsolute(pluginRoot)) return pluginRoot;
  const [realWorkspaceRoot, realPluginRoot] = await Promise.all([
    realpath(workspaceRoot),
    realpath(pluginRoot),
  ]);
  if (!isInside(realWorkspaceRoot, realPluginRoot)) {
    throw new Error(`Plugin root escapes the workspace: ${pluginRoot}.`);
  }
  const resolved = relative(realWorkspaceRoot, realPluginRoot);
  if (resolved.length === 0) return ".";
  return resolved.replaceAll("\\", "/");
}

async function loadValidatedPluginManifest(input: {
  workspaceRoot: string;
  pluginRoot: string;
  pluginId: string;
  pluginRegistration?: PluginRegistrationSource;
}): Promise<{ pluginRoot: string; manifest: DohcPluginManifest }> {
  const requestedRoot = await workspaceRelativePluginRoot(
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
    // A null registration can mean "unknown to this pipeline" (fine to read
    // the manifest straight off disk) or "this plugin's replacement just
    // failed and nothing could be recovered" (not fine — that raw manifest
    // is the failed candidate's own, the exact thing the null was refusing
    // to serve). Only the second one refuses here (#779 round 23 finding 1).
    if (input.pluginRegistration?.hasUnrecoverableFailedReplacement(input.pluginId)) {
      throw new Error(
        `dohc could not recover plugin "${input.pluginId}"'s last working build to open this. Fix the plugin and retry.`,
      );
    }
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
