import {
  WORKSPACE_METHOD,
  WorkspaceDaemonRequester,
} from "@dohc/workspace-engine-client";
import type {
  EngineWorkspace,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { queryWorkspaceSearchDaemon } from "./workspaceSearchDaemon";
import type { WorkspaceSearchEngineInput } from "./workspaceSearchOwner";

export function createWorkspaceSearchDaemonQuery<
  Workspace extends EngineWorkspace,
>(
  sessions: () => EngineWorkspaceSessions | null,
): (workspace: Workspace, input: WorkspaceSearchEngineInput) => ReturnType<
  typeof queryWorkspaceSearchDaemon
> {
  return async (workspace, input) => {
    const current = sessions();
    if (!current) {
      throw new Error("Rust engine workspace sessions are unavailable.");
    }
    return await current.run(
      workspace,
      async (binding) => {
        const requester = new WorkspaceDaemonRequester(binding.client);
        return await queryWorkspaceSearchDaemon({
          daemon: {
            queryPage: async (params) =>
              await requester.request(WORKSPACE_METHOD.searchQueryPage, params, {
                workspace: binding.workspace,
              }),
          },
          query: input.query,
          limit: input.limit,
          isCurrent: input.isCurrent,
        });
      },
      { retryTransportErrors: true },
    );
  };
}
