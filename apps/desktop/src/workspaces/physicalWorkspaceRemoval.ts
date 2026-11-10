import type { createWorkspaceAuthorityOwner, WorkspaceAuthorityBinding } from "./workspaceAuthorityOwner";
import type { ForgottenShareViews } from "./forgottenShareViews";
import type { ShareViewIdentity } from "./registryStore";
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
    // A join that failed takes its unfinished entry out of the list without
    // asking, because its typing waiting to recover stays on disk.
    { keepDrafts = false } = {},
  ): Promise<boolean> {
    if (!keepDrafts && dependencies.confirmDraftRemoval && !(await dependencies.confirmDraftRemoval(binding.workspaceId))) return false;
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
    if (keepDrafts) return true;
    try {
      await dependencies.removeDrafts(binding.workspaceId);
    } catch (error) {
      dependencies.onError(binding.workspaceId, error);
    }
    return true;
  };
}

export function createWorkspaceForget<Workspace extends {workspaceId: string; rootPath: string; shareView?: ShareViewIdentity}>(dependencies: {
  currentBinding(workspaceId: string): WorkspaceAuthorityBinding<Workspace>;
  findWorkspace(workspaceId: string): Workspace | null;
  removePhysicalWorkspace: ReturnType<typeof createPhysicalWorkspaceRemoval<Workspace>>;
  trust: Pick<WorkspaceTrust, "restrict">;
  forgottenShareViews: Pick<ForgottenShareViews, "remember">;
  clearNotices(workspaceId: string): void;
  notifyRenderer(): void;
}) {
  return async function forgetWorkspace(workspaceId: string): Promise<void> {
    const binding = dependencies.currentBinding(workspaceId);
    const restrict = () => dependencies.trust.restrict(workspaceId);
    // A forgotten share view's folder opens as that share again. Its record
    // is saved once the workspace has closed, so it holds the access the
    // share has now, and before its row goes, so a failed write leaves the
    // workspace listed.
    const rememberShareView = async () => {
      const shareView = dependencies.findWorkspace(workspaceId)?.shareView;
      if (!shareView) return;
      await dependencies.forgottenShareViews.remember({ workspaceId, rootPath: binding.canonicalRootPath }, shareView);
    };
    // A forgotten workspace opened again is an existing folder: it starts in
    // Restricted Mode. The grant goes once the person agrees and before the
    // workspace closes, so a failed write leaves the workspace listed, not
    // forgotten with a grant that returns. Going back keeps the grant. Forget
    // restricts again once the workspace has closed, before its row goes.
    const removed = await dependencies.removePhysicalWorkspace(
      binding,
      async () => {
        await restrict();
        await rememberShareView();
      },
      restrict,
    );
    if (!removed) return;
    dependencies.clearNotices(workspaceId);
    dependencies.notifyRenderer();
  };
}
