import type { createWorkspaceAuthorityOwner, WorkspaceAuthorityBinding } from "./workspaceAuthorityOwner";

export function createPhysicalWorkspaceRemoval<Workspace extends {workspaceId: string; rootPath: string}>(dependencies: {
  retireBinding: ReturnType<typeof createWorkspaceAuthorityOwner<Workspace, unknown>>["retireBinding"];
  findWorkspace(workspaceId: string): Workspace | null;
  removeWorkspace(workspaceId: string): void;
  removeDrafts(workspaceId: string): Promise<void>;
}) {
  return async function removePhysicalWorkspace(
    binding: WorkspaceAuthorityBinding<Workspace>,
    beforeRegistryRemoval: () => void | Promise<void> = () => undefined,
  ): Promise<void> {
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
    await dependencies.removeDrafts(binding.workspaceId);
  };
}
