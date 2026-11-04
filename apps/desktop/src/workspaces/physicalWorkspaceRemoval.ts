import type { createWorkspaceAuthorityOwner, WorkspaceAuthorityBinding } from "./workspaceAuthorityOwner";
import type { WorkspaceTrust } from "./workspaceTrust";

export function createPhysicalWorkspaceRemoval<Workspace extends {workspaceId: string; rootPath: string}>(dependencies: {
  retireBinding: ReturnType<typeof createWorkspaceAuthorityOwner<Workspace, unknown>>["retireBinding"];
  findWorkspace(workspaceId: string): Workspace | null;
  removeWorkspace(workspaceId: string): void;
  removeDrafts(workspaceId: string): Promise<void>;
  confirmDraftRemoval?(workspaceId: string): Promise<boolean>;
  onError(workspaceId: string, error: unknown): void;
}) {
  return async function removePhysicalWorkspace(
    binding: WorkspaceAuthorityBinding<Workspace>,
    beforeRegistryRemoval: () => void | Promise<void> = () => undefined,
    // Runs once the person has agreed, before the workspace closes.
    confirmed: () => void | Promise<void> = () => undefined,
  ): Promise<boolean> {
    if (dependencies.confirmDraftRemoval && !(await dependencies.confirmDraftRemoval(binding.workspaceId))) return false;
    await confirmed();
    await dependencies.retireBinding(binding, {
      finalize: beforeRegistryRemoval,
      removeBinding: () => {
        const current = dependencies.findWorkspace(binding.workspaceId);
        if (!current || current.rootPath !== binding.registeredRootPath) {
          throw new Error("The workspace registry binding changed before removal completed.");
        }
        dependencies.removeWorkspace(binding.workspaceId);
      },
    });
    try {
      await dependencies.removeDrafts(binding.workspaceId);
    } catch (error) {
      dependencies.onError(binding.workspaceId, error);
    }
    return true;
  };
}

export function createWorkspaceForget<Workspace extends {workspaceId: string; rootPath: string}>(dependencies: {
  currentBinding(workspaceId: string): WorkspaceAuthorityBinding<Workspace>;
  removePhysicalWorkspace: ReturnType<typeof createPhysicalWorkspaceRemoval<Workspace>>;
  trust: Pick<WorkspaceTrust, "restrict" | "isRevoked">;
  clearNotices(workspaceId: string): void;
  notifyRenderer(): void;
}) {
  return async function forgetWorkspace(workspaceId: string): Promise<void> {
    const restrict = () => dependencies.trust.restrict(workspaceId);
    // A forgotten workspace opened again is an existing folder: it starts in
    // Restricted Mode. The grant goes once the person agrees and before the
    // workspace closes, so a failed write leaves the workspace listed, not
    // forgotten with a grant that returns. Going back keeps the grant. Trust
    // is checked again once the workspace has closed.
    const removed = await dependencies.removePhysicalWorkspace(
      dependencies.currentBinding(workspaceId),
      async () => { if (!dependencies.trust.isRevoked(workspaceId)) await restrict(); },
      restrict,
    );
    if (!removed) return;
    dependencies.clearNotices(workspaceId);
    dependencies.notifyRenderer();
  };
}
