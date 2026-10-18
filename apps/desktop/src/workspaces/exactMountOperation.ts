export function createExactMountOperationRunner<
  Workspace extends { workspaceId: string; attachmentId: symbol },
  Operation extends { workspace: Workspace; assertCurrent(): void },
>(dependencies: {
  withOperation<Result>(
    workspaceId: string,
    run: (operation: Operation) => Promise<Result>,
  ): Promise<Result>;
  engineReady(): Promise<unknown>;
}) {
  return function withExactMountOperation<Result>(
    input: { workspace: { workspaceId: string }; assertCurrent(): void },
    run: (
      operation: Operation,
      current: { workspace: Workspace; assertCurrent(): void },
    ) => Promise<Result>,
  ): Promise<Result> {
    const attachmentId = Reflect.get(input.workspace, "attachmentId");
    if (typeof attachmentId !== "symbol") {
      throw new Error(
        "Open this workspace again before using this share.",
      );
    }
    return dependencies.withOperation(
      input.workspace.workspaceId,
      async (operation) => {
        if (operation.workspace.attachmentId !== attachmentId) {
          throw new Error("This workspace was closed. Open it again.");
        }
        await dependencies.engineReady();
        const assertCurrent = (): void => {
          operation.assertCurrent();
          input.assertCurrent();
        };
        assertCurrent();
        return run(operation, {
          workspace: operation.workspace,
          assertCurrent,
        });
      },
    );
  };
}
