import type {
  RendererWorkspaceRetirement,
  RendererWorkspaceSender,
  RendererWorkspaceSession,
} from "./window/rendererWorkspaceSessionOwner";

interface SenderRetirementPorts<Sender extends RendererWorkspaceSender> {
  engineYDoc: {
    retireSender(sender: Sender, generation: number): Promise<unknown>;
  };
  pluginSurfaces: {
    stop(
      target:
        | { kind: "sender"; senderId: number }
        | { kind: "workspace"; workspaceId: string },
    ): Promise<void>;
  };
  workspaceSearch: {
    disposeSender(senderId: number): void;
  };
  presencePolls: {
    disposeSender(senderId: number): void;
  };
}

interface WorkspaceRetirementPorts {
  pluginRuntimes: {
    stop(workspaceId: string, beforeDispose: () => Promise<void>): Promise<void>;
  };
}

export interface DesktopRendererWorkspaceRetirementDependencies<
  Sender extends RendererWorkspaceSender,
> extends SenderRetirementPorts<Sender>,
    WorkspaceRetirementPorts {
  sitePreviews: {
    cancelSender(senderId: number): void;
    stopWorkspace(workspaceId: string): Promise<void>;
  };
  onCleanupError(
    owner: string,
    scope:
      | { kind: "sender"; senderId: number }
      | { kind: "workspace"; workspaceId: string },
    error: unknown,
  ): void;
}

interface CleanupArm {
  readonly owner: string;
  readonly run: () => void | Promise<unknown>;
}

async function drainCleanup(
  arms: readonly CleanupArm[],
  scope:
    | { kind: "sender"; senderId: number }
    | { kind: "workspace"; workspaceId: string },
  onCleanupError: DesktopRendererWorkspaceRetirementDependencies<RendererWorkspaceSender>[
    "onCleanupError"
  ],
): Promise<void> {
  const drains = arms.map(({ owner, run }) => {
    try {
      return Promise.resolve(run()).catch((error: unknown) => {
        onCleanupError(owner, scope, error);
      });
    } catch (error) {
      onCleanupError(owner, scope, error);
      return Promise.resolve();
    }
  });
  await Promise.all(drains);
}

/** Maps the renderer lease onto the domain owners without taking their state. */
export function createDesktopRendererWorkspaceRetirement<
  Sender extends RendererWorkspaceSender,
>(
  dependencies: DesktopRendererWorkspaceRetirementDependencies<Sender>,
): RendererWorkspaceRetirement<Sender> {
  return {
    retireSender(session: RendererWorkspaceSession<Sender>): Promise<void> {
      const scope = { kind: "sender" as const, senderId: session.senderId };
      return drainCleanup(
        [
          {
            owner: "engine Y.Doc sessions",
            run: () =>
              dependencies.engineYDoc.retireSender(
                session.sender,
                session.generation,
              ),
          },
          {
            owner: "site preview starts",
            run: () => dependencies.sitePreviews.cancelSender(session.senderId),
          },
          {
            owner: "plugin surfaces",
            run: () =>
              dependencies.pluginSurfaces.stop({
                kind: "sender",
                senderId: session.senderId,
              }),
          },
          {
            owner: "workspace search",
            run: () =>
              dependencies.workspaceSearch.disposeSender(session.senderId),
          },
          {
            owner: "presence polls",
            run: () => dependencies.presencePolls.disposeSender(session.senderId),
          },
        ],
        scope,
        dependencies.onCleanupError,
      );
    },

    retireWorkspace(workspaceId: string): Promise<void> {
      const scope = { kind: "workspace" as const, workspaceId };
      return drainCleanup(
        [
          {
            owner: "site previews",
            run: () => dependencies.sitePreviews.stopWorkspace(workspaceId),
          },
          {
            owner: "plugin runtime",
            run: () =>
              dependencies.pluginRuntimes.stop(workspaceId, () =>
                dependencies.pluginSurfaces.stop({
                  kind: "workspace",
                  workspaceId,
                }),
              ),
          },
        ],
        scope,
        dependencies.onCleanupError,
      );
    },
  };
}
