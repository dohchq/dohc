import { needsBuiltArtifact, presentBuildOutput } from "@dohc/workspace-core";
import type {
  SitePackageInfo,
  SitePreviewMode,
  WorkspaceSettingsResult,
} from "../ipc/bridgeContract";

export type WorkspacePreviewMode =
  WorkspaceSettingsResult["settings"]["sites"]["defaultPreviewMode"];

export function modeLabel(mode: SitePreviewMode): string {
  if (mode === "dev") return "Dev";
  if (mode === "build") return "Build";
  return "Static";
}

/** The modes this app can preview in, in the order the preview menu lists them. */
export function availableModes(
  site: SitePackageInfo,
  sharedView = false,
): SitePreviewMode[] {
  const modes: SitePreviewMode[] = [];
  if (sharedView || site.authority.kind === "share") {
    const sharedStaticEntry = presentBuildOutput(site) ??
      (!needsBuiltArtifact(site)
        ? site.entryPath
        : null);
    return sharedStaticEntry ? ["static"] : [];
  }
  if (site.entryPath) modes.push("static");
  if (
    site.configuredScripts.dev ||
    site.scripts.dev ||
    site.configuredScripts.start ||
    site.scripts.start
  ) modes.push("dev");
  if (
    site.configuredScripts.build ||
    site.scripts.build ||
    site.buildOutputs.length > 0 ||
    presentBuildOutput(site)
  ) modes.push("build");
  return modes;
}

// The mode a person picked for one app. It stays on this computer.
const SITE_PREVIEW_MODE_STORAGE_PREFIX = "dohc.site-preview-mode.v1";

function storedModeKey(workspaceId: string, siteRoot: string): string {
  return `${SITE_PREVIEW_MODE_STORAGE_PREFIX}:${workspaceId}:${siteRoot}`;
}

export function readStoredMode(
  workspaceId: string,
  siteRoot: string,
  modes: readonly SitePreviewMode[],
): SitePreviewMode | null {
  try {
    const stored = window.localStorage.getItem(storedModeKey(workspaceId, siteRoot));
    return modes.includes(stored as SitePreviewMode) ? (stored as SitePreviewMode) : null;
  } catch {
    return null;
  }
}

export function rememberMode(workspaceId: string, siteRoot: string, mode: SitePreviewMode) {
  try {
    window.localStorage.setItem(storedModeKey(workspaceId, siteRoot), mode);
  } catch {
    // Preview startup must not depend on storage being available.
  }
}

export function forgetMode(workspaceId: string, siteRoot: string) {
  try {
    window.localStorage.removeItem(storedModeKey(workspaceId, siteRoot));
  } catch {
    // Nothing stored is the same as nothing to forget.
  }
}

/**
 * Where an app's starting mode comes from, in the order the preview checks:
 * the mode picked for it on this computer, a shared app's only mode, its
 * dohc.json, the workspace's default, then dohc's automatic choice.
 */
export type StartingModeSource = "picked" | "shared" | "app" | "workspace" | "automatic";

export function startingMode(
  site: SitePackageInfo,
  modes: readonly SitePreviewMode[],
  picked: SitePreviewMode | null,
  defaultPreviewMode: WorkspacePreviewMode,
  sharedView = false,
): { mode: SitePreviewMode; source: StartingModeSource } | null {
  if (picked && modes.includes(picked)) return { mode: picked, source: "picked" };
  if (sharedView || site.authority.kind === "share") {
    return modes.includes("static") ? { mode: "static", source: "shared" } : null;
  }
  if (site.configuredPreviewMode && modes.includes(site.configuredPreviewMode)) {
    return { mode: site.configuredPreviewMode, source: "app" };
  }
  if (defaultPreviewMode !== "auto" && modes.includes(defaultPreviewMode)) {
    return { mode: defaultPreviewMode, source: "workspace" };
  }
  const automatic: SitePreviewMode | null =
    modes.includes("dev") ? "dev"
    : site.kind !== "static" && modes.includes("build") ? "build"
    : modes.includes("static") ? "static"
    : modes.includes("build") ? "build"
    : null;
  return automatic ? { mode: automatic, source: "automatic" } : null;
}

export function preferredMode(
  site: SitePackageInfo,
  modes: readonly SitePreviewMode[],
  workspaceId: string,
  defaultPreviewMode: WorkspacePreviewMode,
  sharedView = false,
): SitePreviewMode | null {
  return startingMode(
    site,
    modes,
    readStoredMode(workspaceId, site.root, modes),
    defaultPreviewMode,
    sharedView,
  )?.mode ?? null;
}
