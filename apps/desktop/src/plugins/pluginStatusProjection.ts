import type {
  PLUGIN_PIPELINE_ERROR_STAGES,
  PLUGIN_PIPELINE_STATUSES,
} from "../ipc/channels";
import type { InstalledPluginRecord } from "./pluginDiscovery";
import type { PluginRuntimeStatus } from "./pluginHostProtocol";
import type { DohcPluginManifest, PluginSettingDeclaration } from "./pluginManifestSchema";

type PluginPipelineStatus = typeof PLUGIN_PIPELINE_STATUSES[number];

export type PluginPipelineErrorStage =
  typeof PLUGIN_PIPELINE_ERROR_STAGES[number];

export interface PluginPipelineError {
  stage: PluginPipelineErrorStage;
  code: string;
  message: string;
}

/**
 * What the manifest says a plugin is, for the list row and the details header.
 * Every field is optional in the manifest, so every field can be null and each
 * surface falls back on its own: the id names an unnamed plugin, and the
 * glyph tile stands in for a missing icon.
 */
interface PluginMetadata {
  displayName: string | null;
  description: string | null;
  publisher: string | null;
  /** Plugin-root-relative, already checked by discovery. */
  icon: string | null;
  /** What the plugin calls this build. Display only — never compared. */
  pluginVersion: string | null;
  repository: string | null;
  issues: string | null;
  license: string | null;
}

/** One declared panel, and where the workbench shows it. */
interface PluginPanelContribution {
  id: string;
  title: string;
  placement: "editor" | "view";
  /** The rail button's icon, plugin-root-relative, or null to fall back to
   * the plugin's own icon. */
  icon: string | null;
}

interface PluginCommandContribution {
  id: string;
  title: string;
}

export interface PluginPipelinePluginStatus extends PluginMetadata {
  id: string;
  directoryName: string;
  rootPath: string;
  valid: boolean;
  status: PluginPipelineStatus;
  disabledReason: "user" | "crash-loop" | "approval" | "repair" | null;
  runtimeStatus: PluginRuntimeStatus | null;
  sourceHash: string | null;
  approvedHash: string | null;
  installedBaselineHash: string | null;
  /** The manifest's declared web apps, so the settings surface can offer an
   * Open control without a second manifest read. */
  webApps: { id: string; title: string; instanced: boolean }[];
  /** The manifest's declared panels, so the workbench can put the ones placed
   * in the view rail there without a second manifest read. */
  panels: PluginPanelContribution[];
  /** The manifest's declared commands, so the workbench can list them
   * without a second manifest read. */
  commands: PluginCommandContribution[];
  /** The manifest's declared settings, so the details page can render the
   * controls without a second manifest read. Values live per workspace and
   * travel separately. */
  settings: PluginSettingDeclaration[];
  /**
   * True from the moment a build fails while an old runtime keeps serving,
   * until a replacement build succeeds — independent of runtimeStatus, so a
   * crash-loop respawn between the failure and the fix can never make the
   * still-owed replacement disappear from status. Mirrors recoveryState's
   * own has() (round-8 finding 3), cleared the moment a replacement
   * publishes or the plugin stops.
   */
  hasFailedReplacement: boolean;
  diagnostics: string[];
  warnings: string[];
  error: PluginPipelineError | null;
}

/**
 * The bridge contract caps PluginPipelineError.message at 10,000 characters
 * (min 1), and several producers join unbounded diagnostic lists — a noisy
 * directory's discovery diagnostics, a drifted snapshot manifest's parse
 * issues, a failed build's output. One
 * over-cap message made the whole plugin list and every status event for
 * the candidate fail schema parsing, so every message is bounded here, in
 * the one place all pipeline errors are built.
 */
const PIPELINE_ERROR_MESSAGE_MAX_CHARS = 8_000;

function boundedErrorMessage(message: string): string {
  if (message.length === 0) return "(no error detail)";
  if (message.length <= PIPELINE_ERROR_MESSAGE_MAX_CHARS) return message;
  const note = (shown: number): string =>
    ` [${message.length - shown} of ${message.length} characters elided; ` +
    `this message is capped at ${PIPELINE_ERROR_MESSAGE_MAX_CHARS} characters.]`;
  // The note's own width shrinks (never grows) once the real shown count —
  // no larger than the total — replaces the estimate, so the result stays
  // inside the cap.
  const shown = PIPELINE_ERROR_MESSAGE_MAX_CHARS - note(0).length;
  return `${message.slice(0, shown)}${note(shown)}`;
}

export function pipelineError(
  stage: PluginPipelineErrorStage,
  code: string,
  message: string,
): PluginPipelineError {
  return { stage, code, message: boundedErrorMessage(message) };
}

/**
 * The same cap for the diagnostics and warnings a status record carries. Their
 * producers are as unbounded as the error producers above: a hostile
 * dohc-plugin.json puts a whole unrecognized key name into one strict-object
 * diagnostic, and a lifecycle warning line embeds a package's own version
 * string. One over-cap entry failed the entire list's schema parse, denying
 * every other plugin's Disable and Uninstall too.
 */
function boundedStatusLines(lines: readonly string[]): string[] {
  return lines.map(boundedErrorMessage);
}

function cloneError(error: PluginPipelineError | null): PluginPipelineError | null {
  return error ? { ...error } : null;
}

export function cloneStatus(status: PluginPipelinePluginStatus): PluginPipelinePluginStatus {
  return {
    ...status,
    settings: status.settings.map((setting) => ({ ...setting })),
    webApps: status.webApps.map((webApp) => ({ ...webApp })),
    panels: status.panels.map((panel) => ({ ...panel })),
    commands: status.commands.map((command) => ({ ...command })),
    diagnostics: [...status.diagnostics],
    warnings: [...status.warnings],
    error: cloneError(status.error),
  };
}

function manifestWebApps(
  manifest: {
    webApps?: { id: string; title: string; instanced: boolean }[];
  } | null,
): { id: string; title: string; instanced: boolean }[] {
  return (manifest?.webApps ?? []).map((webApp) => ({
    id: webApp.id,
    title: webApp.title,
    instanced: webApp.instanced,
  }));
}

/**
 * The panels a plugin declares, with where each one shows. The entry path
 * stays behind in main: the renderer never loads a panel by path — it asks
 * for one by id, and main re-reads the manifest to answer.
 */
function manifestPanels(
  manifest: {
    panels?: {
      id: string;
      title: string;
      placement: "editor" | "view";
      icon?: string;
    }[];
  } | null,
): PluginPanelContribution[] {
  return (manifest?.panels ?? []).map((panel) => ({
    id: panel.id,
    title: panel.title,
    placement: panel.placement,
    icon: panel.icon ?? null,
  }));
}

function manifestCommands(
  manifest: {
    commands?: { id: string; title: string }[];
  } | null,
): PluginCommandContribution[] {
  return (manifest?.commands ?? []).map((command) => ({
    id: command.id,
    title: command.title,
  }));
}

/**
 * What a plugin says about itself, for the surfaces that show a plugin before
 * anyone installs it. Derived from the candidate on every status change for
 * the same reason webApps is: an approved manifest edit that renames a plugin
 * or rewrites its description must reach the list, not stay frozen at first
 * discovery. The icon comes from the candidate rather than the manifest —
 * discovery is what checked the file behind it.
 */
export function manifestSettings(
  manifest: { settings?: PluginSettingDeclaration[] } | null,
): PluginSettingDeclaration[] {
  return (manifest?.settings ?? []).map((setting) => ({ ...setting }));
}

function manifestMetadata(candidate: InstalledPluginRecord): PluginMetadata {
  return {
    displayName: candidate.manifest?.displayName ?? null,
    description: candidate.manifest?.description ?? null,
    publisher: candidate.manifest?.publisher ?? null,
    icon: candidate.iconPath,
    pluginVersion: candidate.manifest?.pluginVersion ?? null,
    repository: candidate.manifest?.repository ?? null,
    issues: candidate.manifest?.issues ?? null,
    license: candidate.manifest?.license ?? null,
  };
}

export function invalidPluginError(
  candidate: InstalledPluginRecord,
): PluginPipelineError | null {
  if (candidate.diagnostics.length === 0) return null;
  // pipelineError bounds the joined message.
  return pipelineError(
    "discovery",
    "invalid-plugin",
    candidate.diagnostics.join(" "),
  );
}

export function initialPluginStatus(
  candidate: InstalledPluginRecord,
  recoveredManifest: DohcPluginManifest | null | undefined,
): PluginPipelinePluginStatus {
  return {
    id: candidate.id,
    directoryName: candidate.directoryName,
    rootPath: candidate.rootPath,
    valid: candidate.valid && candidate.manifest !== null,
    status: candidate.valid ? "discovered" : "invalid",
    disabledReason: null,
    runtimeStatus: null,
    sourceHash: null,
    approvedHash: null,
    installedBaselineHash: null,
    ...manifestMetadata(candidate),
    settings: manifestSettings(candidate.manifest),
    webApps: manifestWebApps(candidate.manifest),
    panels: manifestPanels(candidate.manifest),
    commands: manifestCommands(candidate.manifest),
    hasFailedReplacement: recoveredManifest !== undefined,
    diagnostics: boundedStatusLines(candidate.diagnostics),
    warnings: [],
    error: null,
  };
}

export function projectPluginStatus(
  candidate: InstalledPluginRecord,
  current: PluginPipelinePluginStatus,
  patch: Partial<PluginPipelinePluginStatus>,
  recoveredManifest: DohcPluginManifest | null | undefined,
  built?: { manifest: DohcPluginManifest; iconPath: string | null },
): PluginPipelinePluginStatus {
  // null (a failed replacement, nothing recovered) falls every
  // derivation below back to current's own contributions instead of
  // this candidate's own untrusted manifest.
  const authoritativeManifest = recoveredManifest !== undefined
    ? (recoveredManifest ?? null)
    : (built?.manifest ?? candidate.manifest);
  // Only the manifest content and icon this call reports on should
  // prefer built — directoryName/rootPath/valid below stay tied to the
  // real discovery candidate, which is what identifies the plugin on
  // disk, not what it built.
  const metadataSource: InstalledPluginRecord = built
    ? { ...candidate, manifest: built.manifest, iconPath: built.iconPath }
    : candidate;
  const next: PluginPipelinePluginStatus = {
    ...current,
    ...patch,
    directoryName: candidate.directoryName,
    rootPath: candidate.rootPath,
    // A caller with no real discovery candidate left (failure()'s
    // synthetic fallback, below) explicitly states the validity it wants
    // preserved via patch.valid; every other caller passes a real
    // discovered candidate and gets the normal derived computation.
    // Without this, a failure recorded after a still-valid plugin's
    // discovery entry was replaced always read back as invalid.
    valid: patch.valid ?? (candidate.valid && candidate.manifest !== null),
    // Derived from the candidate like directoryName/rootPath: an approved
    // manifest edit that adds or renames a web app must become visible on
    // the next status change, not stay frozen at first discovery. The
    // manifest's own metadata is derived the same way — except from a
    // synthetic candidate (failure()'s fallback, a sourceless uninstall),
    // which has no manifest to read. The status keeps the name and icon it
    // already carried rather than losing them mid-action.
    ...(metadataSource.manifest ? manifestMetadata(metadataSource) : {}),
    settings: authoritativeManifest
      ? manifestSettings(authoritativeManifest)
      : current.settings,
    webApps: patch.webApps ?? (authoritativeManifest
      ? manifestWebApps(authoritativeManifest)
      : current.webApps),
    panels: patch.panels ?? (authoritativeManifest
      ? manifestPanels(authoritativeManifest)
      : current.panels),
    commands: patch.commands ?? (authoritativeManifest
      ? manifestCommands(authoritativeManifest)
      : current.commands),
    hasFailedReplacement: recoveredManifest !== undefined,
    diagnostics: boundedStatusLines(patch.diagnostics ?? current.diagnostics),
    warnings: boundedStatusLines(patch.warnings ?? current.warnings),
    error: patch.error === undefined ? cloneError(current.error) : cloneError(patch.error),
  };
  return next;
}

export function invalidPluginStatus(
  candidate: InstalledPluginRecord,
  recoveredManifest: DohcPluginManifest | null | undefined,
): PluginPipelinePluginStatus {
  return {
    ...initialPluginStatus(candidate, recoveredManifest),
    valid: false,
    status: "invalid",
    error: invalidPluginError(candidate),
  };
}
