import { describe, expect, it, vi } from "vitest";
import { createExactRendererWorkspaceReferenceOwner } from "./exactRendererWorkspaceReference";

interface TestOperation {
  workspace: {
    workspaceId: string;
    attachmentId: symbol;
    rootPath: string;
  };
  session: { generation: number };
}

describe("exact renderer workspace references", () => {
  it("refuses a modal result after the renderer switches to a successor binding", async () => {
    const attachmentA = Symbol("A");
    let operation: TestOperation = {
      workspace: {
        workspaceId: "workspace",
        attachmentId: attachmentA,
        rootPath: "C:/canonical-a",
      },
      session: { generation: 1 },
    };
    const references = createExactRendererWorkspaceReferenceOwner(
      async (_sender: object, workspaceId: string, message: string, work) => {
        if (workspaceId !== operation.workspace.workspaceId) {
          throw new Error(message);
        }
        return await work(operation);
      },
    );
    const sender = {};
    const reference = await references.capture(sender, "workspace", "stale");
    operation = {
      workspace: {
        workspaceId: "workspace",
        attachmentId: Symbol("B"),
        rootPath: "D:/canonical-b",
      },
      session: { generation: 2 },
    };
    const effect = vi.fn();

    await expect(
      references.withReference(sender, reference, "stale", effect),
    ).rejects.toThrow("stale");
    expect(effect).not.toHaveBeenCalled();
  });

  it("refuses a modal result after the renderer generation retires", async () => {
    const attachmentId = Symbol("attachment");
    const operation: TestOperation = {
      workspace: {
        workspaceId: "workspace",
        attachmentId,
        rootPath: "C:/canonical",
      },
      session: { generation: 1 },
    };
    const references = createExactRendererWorkspaceReferenceOwner(
      async (_sender: object, _workspaceId: string, _message: string, work) =>
        await work(operation),
    );
    const sender = {};
    const reference = await references.capture(sender, "workspace", "stale");
    operation.session = { generation: 2 };
    const effect = vi.fn();

    await expect(
      references.withReference(sender, reference, "stale", effect),
    ).rejects.toThrow("stale");
    expect(effect).not.toHaveBeenCalled();
  });

  it("keeps the captured canonical root when the registry spelling is an alias", async () => {
    const attachmentId = Symbol("attachment");
    const operation: TestOperation = {
      workspace: {
        workspaceId: "workspace",
        attachmentId,
        rootPath: "C:/real/workspace",
      },
      session: { generation: 4 },
    };
    const references = createExactRendererWorkspaceReferenceOwner(
      async (_sender: object, _workspaceId: string, _message: string, work) =>
        await work(operation),
    );
    const sender = {};
    const reference = await references.capture(sender, "workspace", "stale");

    await expect(
      references.withReference(
        sender,
        reference,
        "stale",
        (current) => current.workspace.rootPath,
      ),
    ).resolves.toBe("C:/real/workspace");
  });

  it("refuses a canceled modal response after the renderer changes workspaces", async () => {
    const attachmentId = Symbol("attachment");
    const operation: TestOperation = {
      workspace: {
        workspaceId: "workspace",
        attachmentId,
        rootPath: "C:/canonical",
      },
      session: { generation: 1 },
    };
    const withOperation = vi.fn(
      async (_sender: object, _workspaceId: string, _message: string, work) =>
        await work(operation),
    );
    const references = createExactRendererWorkspaceReferenceOwner(withOperation);
    const sender = {};
    const reference = await references.capture(sender, "workspace", "stale");
    operation.session = { generation: 2 };

    const target = null;
    await expect(
      references.withReference(sender, reference, "stale", () => ({
        path: target,
      })),
    ).rejects.toThrow("stale");

    expect(withOperation).toHaveBeenCalledTimes(2);
  });

  it("returns cancellation without an effect and allows an unchanged exact export", async () => {
    const attachmentId = Symbol("attachment");
    const operation: TestOperation = {
      workspace: {
        workspaceId: "workspace",
        attachmentId,
        rootPath: "C:/canonical",
      },
      session: { generation: 1 },
    };
    const references = createExactRendererWorkspaceReferenceOwner(
      async (_sender: object, _workspaceId: string, _message: string, work) =>
        await work(operation),
    );
    const sender = {};
    const reference = await references.capture(sender, "workspace", "stale");
    const write = vi.fn(() => "C:/export.zip");

    await expect(
      references.withReference(sender, reference, "stale", () => ({
        path: null,
      })),
    ).resolves.toEqual({ path: null });
    expect(write).not.toHaveBeenCalled();

    await expect(
      references.withReference(sender, reference, "stale", () => ({
        path: write(),
        rootPath: operation.workspace.rootPath,
      })),
    ).resolves.toEqual({
      path: "C:/export.zip",
      rootPath: "C:/canonical",
    });
    expect(write).toHaveBeenCalledOnce();
  });
});
