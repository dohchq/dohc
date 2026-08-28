export interface RendererWorkspaceReferenceOperation<Workspace> {
  readonly workspace: Workspace;
  readonly session: {
    readonly generation: number;
  };
}

export interface ExactRendererWorkspaceReference {
  readonly workspaceId: string;
  readonly attachmentId: symbol;
  readonly rendererGeneration: number;
  readonly canonicalRootPath: string;
}

export function createExactRendererWorkspaceReferenceOwner<
  Sender,
  Workspace extends {
    readonly workspaceId: string;
    readonly attachmentId: symbol;
    readonly rootPath: string;
  },
  Operation extends RendererWorkspaceReferenceOperation<Workspace>,
>(
  withOperation: <Result>(
    sender: Sender,
    workspaceId: string,
    inactiveMessage: string,
    work: (operation: Operation) => Result | Promise<Result>,
  ) => Promise<Result>,
) {
  const capture = (
    sender: Sender,
    workspaceId: string,
    inactiveMessage: string,
  ): Promise<ExactRendererWorkspaceReference> =>
    withOperation(sender, workspaceId, inactiveMessage, (operation) =>
      Object.freeze({
        workspaceId: operation.workspace.workspaceId,
        attachmentId: operation.workspace.attachmentId,
        rendererGeneration: operation.session.generation,
        canonicalRootPath: operation.workspace.rootPath,
      }),
    );

  const withReference = <Result>(
    sender: Sender,
    reference: ExactRendererWorkspaceReference,
    inactiveMessage: string,
    work: (operation: Operation) => Result | Promise<Result>,
  ): Promise<Result> =>
    withOperation(
      sender,
      reference.workspaceId,
      inactiveMessage,
      (operation) => {
        const workspace = operation.workspace;
        if (
          workspace.workspaceId !== reference.workspaceId ||
          workspace.attachmentId !== reference.attachmentId ||
          workspace.rootPath !== reference.canonicalRootPath ||
          operation.session.generation !== reference.rendererGeneration
        ) {
          throw new Error(inactiveMessage);
        }
        return work(operation);
      },
    );

  return Object.freeze({ capture, withReference });
}
