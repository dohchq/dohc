import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import type { ActiveAgentRun } from "./workspaceWatcher";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import {
  createWorkspaceActivity,
  WorkspaceActivityState,
  type ActivityWorkspace,
  type WorkspaceActivityOptions,
} from "./workspaceActivity";

type TestActivityWorkspace = CreatedWorkspace & { attachmentId?: symbol };

/** Test-only registry adapter for the single-attachment activity service. */
export function createInMemoryWorkspaceActivity(
  notify: (scope?: { workspaceId: string }) => void,
  options: WorkspaceActivityOptions = {},
) {
  const service = createWorkspaceActivity(notify, options);
  const authorities = new Map<
    string,
    { workspace: ActivityWorkspace; state: WorkspaceActivityState }
  >();

  function authorityFor(workspace: TestActivityWorkspace) {
    const current = authorities.get(workspace.workspaceId);
    if (
      current &&
      (current.workspace.rootPath === workspace.rootPath ||
        service.isOpen(current.state))
    ) {
      current.workspace = {
        ...workspace,
        attachmentId:
          workspace.attachmentId ?? current.workspace.attachmentId,
      };
      return current;
    }
    const created = {
      workspace: {
        ...workspace,
        attachmentId:
          workspace.attachmentId ??
          Symbol(`test-workspace-attachment:${workspace.workspaceId}`),
      },
      state: new WorkspaceActivityState(),
    };
    authorities.set(workspace.workspaceId, created);
    return created;
  }

  function requireAuthority(workspaceId: string) {
    const current = authorities.get(workspaceId);
    if (current) return current;
    const created = {
      workspace: {
        workspaceId,
        rootPath: "",
        kind: "personal",
        mode: "local-first",
        attachmentId: Symbol(`test-workspace-attachment:${workspaceId}`),
      } as ActivityWorkspace,
      state: new WorkspaceActivityState(),
    };
    authorities.set(workspaceId, created);
    return created;
  }

  return {
    open: (workspace: TestActivityWorkspace) => {
      const authority = authorityFor(workspace);
      return service.open(authority.workspace, authority.state);
    },
    close: (
      workspaceId: string,
      closeOptions?: {
        preserveStatus?: boolean;
        notify?: boolean;
        expectedRootPath?: string;
      },
    ) => {
      const authority = authorities.get(workspaceId);
      if (!authority) return Promise.resolve(false);
      return service.close(authority.workspace, authority.state, closeOptions);
    },
    enableCloud: (
      workspace: TestActivityWorkspace,
      engineOptions?: { joinBootstrap?: boolean },
    ) => {
      const authority = authorityFor(workspace);
      return service.enableCloud(
        authority.workspace,
        authority.state,
        engineOptions,
      );
    },
    reconcileCloud: (
      engineFor: Parameters<typeof service.reconcileCloud>[1],
    ): void => {
      for (const authority of authorities.values()) {
        service.reconcileCloud(authority.state, engineFor, false);
      }
      notify();
    },
    stopEngines: async (): Promise<void> => {
      await Promise.all(
        [...authorities.values()].map(({ state }) =>
          service.stopEngine(state, false),
        ),
      );
      notify();
    },
    getStatus: (workspaceId: string) => {
      const authority = requireAuthority(workspaceId);
      return service.getStatus(authority.workspace, authority.state);
    },
    listOpenWorkspaceIds: () =>
      [...authorities.entries()]
        .filter(([, authority]) => service.isOpen(authority.state))
        .map(([workspaceId]) => workspaceId),
    queueCloudSync: (workspaceId: string): void => {
      const authority = authorities.get(workspaceId);
      if (authority) service.queueCloudSync(authority.state);
    },
    retryCloudSync: (workspaceId: string): Promise<void> => {
      const authority = authorities.get(workspaceId);
      return authority ? service.retryCloudSync(authority.state) : Promise.resolve();
    },
    setAgentRun: (
      workspaceId: string,
      run: ActiveAgentRun | null,
    ): Promise<void> => {
      const authority = requireAuthority(workspaceId);
      return service.setAgentRun(authority.workspace, authority.state, run);
    },
    claimAgentRun: (
      workspaceId: string,
      run: ActiveAgentRun,
      expectedRootPath?: string,
    ): Promise<boolean> => {
      const authority = requireAuthority(workspaceId);
      return service.claimAgentRun(
        authority.workspace,
        authority.state,
        run,
        expectedRootPath,
      );
    },
    clearAgentRun: (
      workspaceId: string,
      agentRunId: string,
      expectedRootPath?: string,
    ): Promise<void> => {
      const authority = authorities.get(workspaceId);
      if (!authority) return Promise.resolve();
      return service.clearAgentRun(
        authority.state,
        agentRunId,
        expectedRootPath,
      );
    },
    hasAgentRun: (workspaceId: string, expectedRootPath?: string): boolean => {
      const authority = authorities.get(workspaceId);
      return authority
        ? service.hasAgentRun(authority.state, expectedRootPath)
        : false;
    },
    engineCaptureFor: (
      workspaceId: string,
      expectedRootPath?: string,
    ): WorkspaceEngineCapture | null => {
      const authority = authorities.get(workspaceId);
      return authority
        ? service.engineCaptureFor(authority.state, expectedRootPath)
        : null;
    },
    workspaceRootPath: (workspaceId: string): string | null => {
      const authority = authorities.get(workspaceId);
      return authority ? service.workspaceRootPath(authority.state) : null;
    },
    registerExpectedEngineEvents: (
      workspaceId: string,
      events: Parameters<WorkspaceEngineCapture["registerExpectedEngineEvents"]>[0],
    ) => {
      const authority = requireAuthority(workspaceId);
      return service.registerExpectedEngineEvents(
        authority.workspace,
        authority.state,
        events,
      );
    },
    stopAll: async (): Promise<void> => {
      await Promise.all(
        [...authorities.values()].map(({ state }) => service.stop(state)),
      );
      authorities.clear();
    },
  };
}
