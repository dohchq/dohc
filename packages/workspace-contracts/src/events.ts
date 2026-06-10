import type { Actor } from "./backend";

export type WorkspaceEventKind =
  | "atom_created"
  | "atom_updated"
  | "asset_saved"
  | "file_renamed"
  | "file_deleted";

export type WorkspaceEvent = {
  id: string;
  workspaceId: string;
  actor: Actor;
  kind: WorkspaceEventKind;
  path: string;
  revision: string;
  createdAt: number;
};
