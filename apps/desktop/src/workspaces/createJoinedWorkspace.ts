import type { CreatedWorkspace } from "./createWorkspaceFolder";
import type { RegistryEntry } from "./registryStore";
import type {
  WorkspaceAuthorityBinding,
  WorkspaceAuthorityReservation,
} from "./workspaceAuthorityOwner";

type Binding = WorkspaceAuthorityBinding<RegistryEntry>;

export function createJoinedWorkspaceRunner(dependencies: {
  // The folder's canonicalWorkspaceRoot. The reservation, the folder, and the
  // registry row must name the same root.
  canonicalizeRoot(rootPath: string): string;
  reserve(input: {
    workspaceId: string;
    rootPath: string;
  }): WorkspaceAuthorityReservation;
  createFolder(input: {
    rootPath: string;
    workspaceId: string;
    kind: "personal";
  }): Promise<CreatedWorkspace>;
  register(
    reservation: WorkspaceAuthorityReservation,
    workspace: RegistryEntry,
  ): Binding;
  remove(binding: Binding, cleanup: () => Promise<void>): Promise<void>;
  release(
    reservation: WorkspaceAuthorityReservation,
    cleanup: () => Promise<void>,
  ): Promise<void>;
  closeRelay(workspaceId: string): Promise<void>;
  rollbackComplete(): void;
  logError(message: string, error: unknown): void;
}) {
  return async function createJoinedWorkspace(input: {
    workspaceId: string;
    rootPath: string;
    prepare?(workspace: CreatedWorkspace): Promise<RegistryEntry>;
    populate(workspace: CreatedWorkspace, binding: Binding): Promise<void>;
    rollbackLabel: string;
    cleanupFailureMessage: string;
    failure(error: unknown): Error;
  }): Promise<CreatedWorkspace> {
    const rootPath = dependencies.canonicalizeRoot(input.rootPath);
    const reservation = dependencies.reserve({ workspaceId: input.workspaceId, rootPath });
    let binding: Binding | null = null;
    try {
      const workspace = await dependencies.createFolder({
        rootPath,
        workspaceId: input.workspaceId,
        kind: "personal",
      });
      const registered = input.prepare
        ? await input.prepare(workspace)
        : workspace;
      binding = dependencies.register(reservation, registered);
      await input.populate(workspace, binding);
      return workspace;
    } catch (error) {
      dependencies.logError(
        `[desktop] ${input.rollbackLabel} rollback for ${input.rootPath}:`,
        error,
      );
      try {
        // The empty-folder check cannot establish ownership of later writes.
        // Release resources, but keep all files for recovery in this folder.
        const cleanup = () => dependencies.closeRelay(input.workspaceId);
        if (binding) {
          await dependencies.remove(binding, cleanup);
        } else {
          await dependencies.release(reservation, cleanup);
        }
      } catch (cleanupError) {
        dependencies.logError(
          `[desktop] ${input.rollbackLabel} rollback cleanup:`,
          cleanupError,
        );
        throw new Error(input.cleanupFailureMessage);
      }
      dependencies.rollbackComplete();
      throw input.failure(error);
    }
  };
}
