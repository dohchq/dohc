// These relay route namespaces cannot identify a workspace.
export const RESERVED_WORKSPACE_IDS: readonly string[] = Object.freeze(["link", "shares", "notices"]);

export const RESERVED_WORKSPACE_ID_TITLE = "dohc can't open this folder";

export class ReservedWorkspaceIdError extends Error {
  override name = "ReservedWorkspaceIdError";

  constructor(workspaceId: string) {
    super(`Its workspace ID, ${workspaceId}, is reserved. Change workspaceId in .dohc/manifest.json, then open the folder again.`);
  }
}
