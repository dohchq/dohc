import type { createWorkspaceAuthorityOwner, WorkspaceAuthorityBinding } from "./workspaceAuthorityOwner";

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

export function createWorkspaceForget(dependencies: {
  // False when the person goes back. `confirmed` runs before anything is removed.
  remove(workspaceId: string, confirmed: () => Promise<void>): Promise<boolean>;
  restrict(workspaceId: string): Promise<void>;
  clearNotices(workspaceId: string): void;
  notifyRenderer(): void;
}) {
  return async function forgetWorkspace(workspaceId: string): Promise<void> {
    // A forgotten workspace opened again is an existing folder: it starts in
    // Restricted Mode. The grant goes first, so a failed write cannot leave
    // one that returns when the folder opens again. Going back keeps it.
    if (!(await dependencies.remove(workspaceId, () => dependencies.restrict(workspaceId)))) return;
    dependencies.clearNotices(workspaceId);
    dependencies.notifyRenderer();
  };
}
