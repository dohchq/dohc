export interface WorkspaceChatLifecycleRecord {
  workspaceId: string;
  rootPath: string;
}

export function createWorkspaceChatLifecycle(options: {
  isReadOnly(workspaceId: string): boolean;
  isReadyForMaintenance?(workspaceId: string): boolean;
  maintain(rootPath: string): Promise<void>;
  onError(error: unknown): void;
}) {
  const maintainedWorkspaceIds = new Set<string>();
  const maintenanceInFlight = new Map<string, Promise<void>>();

  function maintainOnce(workspace: WorkspaceChatLifecycleRecord): Promise<void> {
    if (
      options.isReadOnly(workspace.workspaceId) ||
      options.isReadyForMaintenance?.(workspace.workspaceId) === false ||
      maintainedWorkspaceIds.has(workspace.workspaceId)
    ) {
      return Promise.resolve();
    }
    const existing = maintenanceInFlight.get(workspace.workspaceId);
    if (existing) return existing;
    const maintenance = options
      .maintain(workspace.rootPath)
      .then(() => {
        maintainedWorkspaceIds.add(workspace.workspaceId);
      })
      .catch((error: unknown) => {
        options.onError(error);
      })
      .finally(() => {
        if (maintenanceInFlight.get(workspace.workspaceId) === maintenance) {
          maintenanceInFlight.delete(workspace.workspaceId);
        }
      });
    maintenanceInFlight.set(workspace.workspaceId, maintenance);
    return maintenance;
  }

  return {
    async boot(workspaces: readonly WorkspaceChatLifecycleRecord[]): Promise<void> {
      await Promise.all(workspaces.map(maintainOnce));
    },

    async open<Result>(
      workspace: WorkspaceChatLifecycleRecord,
      openActivity: () => Promise<Result>,
      afterActivityOpen?: () => Promise<void>,
    ): Promise<Result> {
      const result = await openActivity();
      // Join bootstrap hydrates the remote inside this seam. Maintenance must
      // START afterward so a local AGENTS.md write cannot precede first pull —
      // that ordering is load-bearing and stays. The open's caller (the
      // renderer's file tree, a dispatch run) does not wait for the
      // read-modify-write itself: maintainOnce settles its own errors through
      // onError and never rejects.
      await afterActivityOpen?.();
      void maintainOnce(workspace);
      return result;
    },

    async settled(): Promise<void> {
      await Promise.all(maintenanceInFlight.values());
    },
  };
}
