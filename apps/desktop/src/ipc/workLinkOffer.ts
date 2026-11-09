import type { WorkspaceSummary } from "./bridgeContract";

// A workspace offers work links while it syncs, because its server serves
// them. A local-only or paused workspace offers none. Main and the renderer
// both decide with this.
export function offersWorkLinks(workspace: Pick<WorkspaceSummary, "sync">): boolean {
  return workspace.sync === "on";
}
