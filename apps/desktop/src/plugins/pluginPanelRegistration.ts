import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isInside } from "../security/pathContainment";
import { resolveWorkspaceFile } from "../workspaces/workspaceAssets";
import {
  CLAIMS_DRAINING_ERROR_CODE,
  PluginClaimsDrainingError,
} from "./pluginCommandInvocation";
import { readPluginManifestFile } from "./pluginManifest";
import type { DohcPluginManifest } from "./pluginManifestSchema";
import type {
  PluginPipelineEnsureStartedResult,
  PluginPipelineStatusEvent,
} from "./PluginPipeline";

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
  | {
    ok: false;
    error: {
      message: string;
      /**
       * The one pipeline failure a command's own claim can cause (see
       * PluginPipeline's hasOutstandingCommandClaim, #779 round 25
       * finding 3). Never reached by a panel or web app, which never
       * claims. Typed to the one literal it can ever be, not open
       * `string`, so a producer misspelling of CLAIMS_DRAINING_ERROR_CODE
       * fails the type system instead of silently degrading this
       * retryable refusal to a generic error (#779 round 27).
       */
      code?: typeof CLAIMS_DRAINING_ERROR_CODE;
    };
  };

/**
 * Narrows a PluginPipeline action result's own open-ended error code down
 * to the one literal startPluginForPanel's own ensureStarted result
 * recognizes, dropping anything else — the same as no code at all.
 */
export function toPluginPanelHostStartResult(
  result: PluginPipelineEnsureStartedResult,
): PluginPanelHostStartResult {
  if (result.ok) return result;
  return {
    ok: false,
    error: {
      message: result.error.message,
      code: result.error.code === CLAIMS_DRAINING_ERROR_CODE
        ? CLAIMS_DRAINING_ERROR_CODE
        : undefined,
    },
  };
}

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
 * a panel that merely rode along must not stop it on close. A start that
 * ran the host owns it even if that host then fails to activate — nothing
 * else is going to stop it.
 */
export async function startPluginForPanel(input: {
  panelStartedHosts: Set<string>;
  workspaceId: string;
  pluginId: string;
  claim?: boolean;
  /**
   * Called once, only when this exact call performed the zero-to-running
   * transition under claim: false — the on-demand-command counterpart to
   * panelStartedHosts gaining an entry, for a caller that opted out of
   * panel ownership but still needs to know it alone is why the host is
   * running (round-9 finding 1).
   */
  onColdStartWithoutClaim?: () => void;
  /** The running host's activation, or undefined when no host is running. */
  hostActivation: () => Promise<void> | undefined;
  ensureStarted: () => Promise<PluginPanelHostStartResult>;
}): Promise<void> {
  const running = input.hostActivation();
  if (running) return running;
  const result = await input.ensureStarted();
  if (!result.ok) {
    // See PluginPanelHostStartResult's own code field above (#779 round
    // 25 finding 3).
    if (result.error.code === CLAIMS_DRAINING_ERROR_CODE) {
      throw new PluginClaimsDrainingError(input.pluginId);
    }
    throw new Error(result.error.message);
  }
  if (result.startedHost) {
    if (input.claim !== false) {
      input.panelStartedHosts.add(
        pluginLifecycleKey(input.workspaceId, input.pluginId),
      );
    } else {
      input.onColdStartWithoutClaim?.();
    }
  }
  await input.hostActivation();
}

/**
 * Forgets what the main process remembers about a plugin that is gone: the
 * manifest its panels are served from, and any panel claim on its host. A
 * refused uninstall changes nothing, so the plugin keeps both.
 */
export function forgetUninstalledPlugin(input: {
  registrations: Map<string, Map<string, RegisteredPlugin>>;
  panelStartedHosts: Set<string>;
  workspaceId: string;
  pluginId: string;
  directoryName: string;
  uninstalled: boolean;
}): void {
  if (!input.uninstalled) return;
  const forWorkspace = input.registrations.get(input.workspaceId);
  const registered = forWorkspace?.get(input.pluginId);
  // The standing trace-to-directory rule: this id's registration and
  // started-host claim are only ever the departed row's own to forget
  // when they actually trace to the SAME directory. Two rows can share an
  // id (a broken manifest's directory-derived fallback colliding with
  // some other, unrelated plugin's real id) — an id-losing loser's own
  // removal must never reach into a still-installed winner's live
  // registration and host claim under that shared id. Nothing registered
  // at all is trivially nothing to forget either way.
  if (!registered || registered.directoryName !== input.directoryName) return;
  forWorkspace?.delete(input.pluginId);
  input.panelStartedHosts.delete(
    pluginLifecycleKey(input.workspaceId, input.pluginId),
  );
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
  panelStartedHosts: Set<string>;
  workspaceId: string;
  event: PluginPipelineStatusEvent;
}): void {
  if (input.event.kind !== "removed" && input.event.kind !== "renamed") return;
  forgetUninstalledPlugin({
    registrations: input.registrations,
    panelStartedHosts: input.panelStartedHosts,
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
