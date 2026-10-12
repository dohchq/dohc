import { describe, expect, it, vi } from "vitest";
import { workspaceFileOperations } from "./workspaceFileOperations";
import { operationBridge, registerOperations, type OperationHandlers } from "./operationTable";

const rows = Object.entries(workspaceFileOperations) as [
  keyof typeof workspaceFileOperations,
  (typeof workspaceFileOperations)[keyof typeof workspaceFileOperations],
][];

describe("file operation registration", () => {
  it.each(rows)("refuses an untrusted sender before parsing or running %s", async (name, row) => {
    const handle = vi.fn();
    const withActiveWorkspace = vi.fn();
    const handler = vi.fn((): never => { throw new Error("handler must not run"); });
    const handlers: OperationHandlers<typeof workspaceFileOperations> = {
      listWorkspaceFiles: handler,
      createWorkspaceFile: handler,
      createWorkspaceFolder: handler,
      moveWorkspacePath: handler,
      deleteWorkspacePath: handler,
      exportWorkspaceZip: handler,
      exportDocumentFile: handler,
      importWorkspaceFiles: handler,
      readWorkspaceText: handler,
      writeWorkspaceText: handler,
      writeWorkspaceAsset: handler,
      pickImageFiles: handler,
      openFileExternally: handler,
    };
    registerOperations({
      handle,
      assertTrustedSender: () => { throw new Error("untrusted"); },
      withActiveWorkspace,
    }, workspaceFileOperations, handlers);
    const listener = handle.mock.calls.find(([channel]) => channel === row.channel)![1];
    await expect(listener({}, null)).rejects.toThrow("untrusted");
    expect(handler, name).not.toHaveBeenCalled();
    expect(withActiveWorkspace).not.toHaveBeenCalled();
  });

  it.each(rows)("derives the existing preload wire name for %s", async (name, row) => {
    const invoke = vi.fn(async () => undefined);
    const bridge = operationBridge(workspaceFileOperations, invoke);
    const payload = { workspaceId: "workspace" };
    await (bridge[name] as (input: unknown) => Promise<unknown>)(payload);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(row.channel, payload);
  });
});
