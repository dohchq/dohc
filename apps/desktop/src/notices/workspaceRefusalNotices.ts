import { WorkspaceDaemonRequester } from "@dohc/workspace-engine-client";
import type { AttachedEngineWorkspace, EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { PhysicalWorkspace } from "../workspaces/workspaceAuthorityOwner";
import { RefusalNotices } from "./noticeStore";

export function createWorkspaceRefusalNotices(deps: {
  sessions(): EngineWorkspaceSessions | null;
  workspaces(): RegistryEntry[];
  withOperation<Result>(workspaceId: string, work: (operation: {
    workspace: PhysicalWorkspace<RegistryEntry>;
  }) => Promise<Result>): Promise<Result>;
  workspaceForRegistered(workspace: PhysicalWorkspace<RegistryEntry>): AttachedEngineWorkspace;
}) {
  return {
    refusalNotices: async (openedWorkspaceId?: string) => {
      const sessions = deps.sessions();
      const workspaces = deps.workspaces();
      if (!sessions) return workspaces.map(({ workspaceId }) => ({ workspaceId, notices: null }));
      const results = await Promise.allSettled(workspaces.map(async ({ workspaceId }) =>
        openedWorkspaceId !== undefined && openedWorkspaceId !== workspaceId ? null :
        deps.withOperation(workspaceId, ({ workspace }) =>
          sessions.runIfOpen(deps.workspaceForRegistered(workspace), async ({ client, workspace: handle }) => {
            const result = await new WorkspaceDaemonRequester(client).request("sync.refusalNotices", {
              workspaceId,
            }, { workspace: handle });
            return RefusalNotices.parse(result).notices;
          }),
        ),
      ));
      return results.map((result, index) => {
        const { workspaceId } = workspaces[index]!;
        if (result.status === "rejected") {
          console.warn("[notices] could not read workspace sync refusals", workspaceId, result.reason);
        }
        return { workspaceId, notices: result.status === "fulfilled" ? result.value : null };
      });
    },
    dismissRefusal: async (workspaceId: string, noticeId: string) => {
      const sessions = deps.sessions();
      if (!sessions) return;
      await deps.withOperation(workspaceId, ({ workspace }) =>
        sessions.runIfOpen(deps.workspaceForRegistered(workspace), async ({ client, workspace: handle }) => {
          await new WorkspaceDaemonRequester(client).request("sync.dismissRefusal", { workspaceId, noticeId }, { workspace: handle });
        }),
      );
    },
  };
}
