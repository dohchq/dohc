export interface RendererWorkspaceOperationSession {
  readonly workspaceId: string;
  readonly attachmentId: symbol;
  readonly generation: number;
  isCurrent(): boolean;
}

export interface PhysicalWorkspaceOperation<Workspace, State> {
  readonly workspace: Workspace;
  readonly state: State;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export type ExactRendererWorkspaceOperation<Workspace, State, Session> =
  PhysicalWorkspaceOperation<Workspace, State> & {
    readonly session: Session;
    assertCurrent(): void;
  };

export function createRendererWorkspaceOperationRunner<
  Sender,
  Workspace extends {
    readonly workspaceId: string;
    readonly attachmentId: symbol;
  },
  State,
  Session extends RendererWorkspaceOperationSession,
>(dependencies: {
  currentSession(sender: Sender): Session | undefined;
  withPhysicalOperation<Result>(
    workspaceId: string,
    work: (
      operation: PhysicalWorkspaceOperation<Workspace, State>,
    ) => Result | Promise<Result>,
  ): Promise<Result>;
}) {
  return function withRendererWorkspaceOperation<Result>(
    sender: Sender,
    workspaceId: string,
    inactiveMessage: string,
    work: (
      operation: ExactRendererWorkspaceOperation<Workspace, State, Session>,
    ) => Result | Promise<Result>,
  ): Promise<Result> {
    const session = dependencies.currentSession(sender);
    return dependencies.withPhysicalOperation(
      workspaceId,
      async (physical) => {
        const assertCurrent = (): void => {
          physical.assertCurrent();
          const workspace = physical.workspace;
          if (
            !session?.isCurrent() ||
            session.workspaceId !== workspace.workspaceId ||
            session.attachmentId !== workspace.attachmentId
          ) {
            throw new Error(inactiveMessage);
          }
        };
        assertCurrent();
        if (!session) throw new Error(inactiveMessage);
        const operation = Object.freeze({
          get workspace() {
            return physical.workspace;
          },
          state: physical.state,
          signal: physical.signal,
          session,
          assertCurrent,
        });
        const result = await work(operation);
        assertCurrent();
        return result;
      },
    );
  };
}
