// Single source of truth: TS types AND runtime validators (zod enums in the
// desktop bridge) derive from these tuples, so adding a kind/mode can't drift
// the type from the runtime check.
export const WORKSPACE_MODES = [
  "local-first",
  "cloud-first-local-copy",
  "cloud-only",
] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export const WORKSPACE_KINDS = ["personal", "shared", "cloud-only"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

const DEFAULT_MODE_BY_KIND: Record<WorkspaceKind, WorkspaceMode> = {
  personal: "local-first",
  shared: "cloud-first-local-copy",
  "cloud-only": "cloud-only",
};

export function defaultWorkspaceMode(kind: WorkspaceKind): WorkspaceMode {
  return DEFAULT_MODE_BY_KIND[kind];
}
