export type WorkspaceMode =
  | "local-first"
  | "cloud-first-local-copy"
  | "cloud-only";

export type WorkspaceKind = "personal" | "shared" | "cloud-only";

const DEFAULT_MODE_BY_KIND: Record<WorkspaceKind, WorkspaceMode> = {
  personal: "local-first",
  shared: "cloud-first-local-copy",
  "cloud-only": "cloud-only",
};

export function defaultWorkspaceMode(kind: WorkspaceKind): WorkspaceMode {
  return DEFAULT_MODE_BY_KIND[kind];
}
