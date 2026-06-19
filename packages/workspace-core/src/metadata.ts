import {
  defaultWorkspaceMode,
  WORKSPACE_KINDS,
  WORKSPACE_MODES,
  type WorkspaceKind,
  type WorkspaceMode,
} from "./workspaceMode";

// Mode lives on the workspace manifest and nowhere else: a workspace is
// local-first, cloud-first, or cloud-only as a whole, never per file.
export interface WorkspaceManifest {
  version: 1;
  workspaceId: string;
  mode: WorkspaceMode;
  kind: WorkspaceKind;
}

export function createWorkspaceManifest(input: {
  workspaceId: string;
  kind: WorkspaceKind;
  mode?: WorkspaceMode;
}): WorkspaceManifest {
  return {
    version: 1,
    workspaceId: input.workspaceId,
    kind: input.kind,
    mode: input.mode ?? defaultWorkspaceMode(input.kind),
  };
}

export type ManifestCheck =
  | { status: "valid"; manifest: WorkspaceManifest }
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "newer-version"; version: number };

// Fully validates a parsed manifest before it is trusted. A partial manifest
// (missing/invalid kind or mode) is "invalid", never silently adopted; a
// higher version is "newer-version" so callers refuse rather than overwrite.
export function checkManifest(parsed: unknown): ManifestCheck {
  if (parsed === null || typeof parsed !== "object") {
    return { status: "invalid", reason: "manifest is not an object" };
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m.version !== "number") {
    return { status: "invalid", reason: "manifest version is missing" };
  }
  if (m.version > 1) {
    return { status: "newer-version", version: m.version };
  }
  if (m.version !== 1) {
    return { status: "invalid", reason: `unsupported manifest version ${m.version}` };
  }
  if (typeof m.workspaceId !== "string" || m.workspaceId.length === 0) {
    return { status: "invalid", reason: "manifest workspaceId is missing" };
  }
  if (!WORKSPACE_KINDS.includes(m.kind as WorkspaceKind)) {
    return { status: "invalid", reason: "manifest kind is invalid" };
  }
  if (!WORKSPACE_MODES.includes(m.mode as WorkspaceMode)) {
    return { status: "invalid", reason: "manifest mode is invalid" };
  }
  return {
    status: "valid",
    manifest: {
      version: 1,
      workspaceId: m.workspaceId,
      kind: m.kind as WorkspaceKind,
      mode: m.mode as WorkspaceMode,
    },
  };
}
