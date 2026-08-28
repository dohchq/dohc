import { describe, expect, it, vi } from "vitest";
import { createLastKnownDmRequestLanesCache } from "../workspaces/dmRequests";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";
import { createRendererWorkspaceOperationRunner } from "./rendererWorkspaceOperation";

function deferred() {
  return Promise.withResolvers<void>();
}

interface TestWorkspace {
  workspaceId: string;
  attachmentId: symbol;
  rootPath: string;
}

interface TestSession {
  workspaceId: string;
  attachmentId: symbol;
  generation: number;
  isCurrent(): boolean;
}

describe("renderer workspace operation runner", () => {
  it("admits only the active renderer attachment and keeps its canonical root", async () => {
    const attachmentA = Symbol("A");
    const attachmentB = Symbol("B");
    let session = {
      workspaceId: "workspace-a",
      attachmentId: attachmentA,
      generation: 1,
      isCurrent: () => true,
    };
    const workspace = {
      workspaceId: "workspace-a",
      attachmentId: attachmentA,
      rootPath: "C:/canonical-a",
    };
    const run = createRendererWorkspaceOperationRunner<
      object,
      TestWorkspace,
      Record<string, never>,
      TestSession
    >({
      currentSession: () => session,
      withPhysicalOperation: async (workspaceId: string, work) => {
        if (workspaceId !== workspace.workspaceId) {
          throw new Error(`Unknown workspace: ${workspaceId}`);
        }
        return await work({
          workspace,
          state: {},
          signal: new AbortController().signal,
          assertCurrent: () => undefined,
        });
      },
    });

    await expect(
      run({}, "workspace-a", "inactive", (operation) =>
        operation.workspace.rootPath,
      ),
    ).resolves.toBe("C:/canonical-a");

    session = {
      workspaceId: "workspace-b",
      attachmentId: attachmentB,
      generation: 2,
      isCurrent: () => true,
    };
    await expect(
      run({}, "workspace-a", "inactive", () => "wrong"),
    ).rejects.toThrow("inactive");
  });

  it("rejects an old same-id renderer after attachment replacement", async () => {
    const oldAttachment = Symbol("old");
    const currentAttachment = Symbol("current");
    const session = {
      workspaceId: "workspace",
      attachmentId: oldAttachment,
      generation: 1,
      isCurrent: () => true,
    };
    const run = createRendererWorkspaceOperationRunner<
      object,
      TestWorkspace,
      Record<string, never>,
      TestSession
    >({
      currentSession: () => session,
      withPhysicalOperation: async (_workspaceId: string, work) =>
        await work({
          workspace: {
            workspaceId: "workspace",
            attachmentId: currentAttachment,
            rootPath: "D:/replacement",
          },
          state: {},
          signal: new AbortController().signal,
          assertCurrent: () => undefined,
        }),
    });
    const effect = vi.fn();

    await expect(
      run({}, "workspace", "inactive", effect),
    ).rejects.toThrow("inactive");
    expect(effect).not.toHaveBeenCalled();
  });

  it("blocks a post-prerequisite effect and result after renderer retirement", async () => {
    const prerequisite = deferred();
    let current = true;
    const attachmentId = Symbol("attachment");
    const session = {
      workspaceId: "workspace",
      attachmentId,
      generation: 1,
      isCurrent: () => current,
    };
    const run = createRendererWorkspaceOperationRunner<
      object,
      TestWorkspace,
      Record<string, never>,
      TestSession
    >({
      currentSession: () => session,
      withPhysicalOperation: async (_workspaceId: string, work) =>
        await work({
          workspace: {
            workspaceId: "workspace",
            attachmentId,
            rootPath: "C:/canonical",
          },
          state: {},
          signal: new AbortController().signal,
          assertCurrent: () => undefined,
        }),
    });
    const effect = vi.fn();
    const pending = run({}, "workspace", "inactive", async (operation) => {
      await prerequisite.promise;
      operation.assertCurrent();
      effect();
      return "success";
    });

    current = false;
    prerequisite.resolve();

    await expect(pending).rejects.toThrow("inactive");
    expect(effect).not.toHaveBeenCalled();
  });

  it("does not expose attachment A's DM request lanes to same-id successor B", async () => {
    let workspace: { workspaceId: string; rootPath: string } | null = {
      workspaceId: "workspace",
      rootPath: "C:/workspace",
    };
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: () => workspace,
      canonicalizeRoot: (rootPath: string) => rootPath,
      createState: () => ({
        lastKnownDmRequestLanes: createLastKnownDmRequestLanesCache(),
      }),
    });
    const first = owner.acquire("workspace");
    let session: TestSession = {
      workspaceId: "workspace",
      attachmentId: first.binding.attachmentId,
      generation: 1,
      isCurrent: () => true,
    };
    first.release();
    const run = createRendererWorkspaceOperationRunner<
      object,
      TestWorkspace,
      {
        lastKnownDmRequestLanes: ReturnType<
          typeof createLastKnownDmRequestLanesCache
        >;
      },
      TestSession
    >({
      currentSession: () => session,
      withPhysicalOperation: (workspaceId, work) =>
        owner.withOperation(workspaceId, work),
    });

    await run({}, "workspace", "inactive", (operation) => {
      operation.state.lastKnownDmRequestLanes.set("workspace", {
        pending: [{ shareId: "share-a", granterEmail: "a@example.com" }],
        declined: [],
      });
    });

    workspace = null;
    await owner.invalidate("workspace");
    workspace = { workspaceId: "workspace", rootPath: "C:/workspace" };
    const successor = owner.acquire("workspace");
    session = {
      workspaceId: "workspace",
      attachmentId: successor.binding.attachmentId,
      generation: 2,
      isCurrent: () => true,
    };
    successor.release();

    await expect(
      run({}, "workspace", "inactive", (operation) =>
        operation.state.lastKnownDmRequestLanes.get("workspace"),
      ),
    ).resolves.toBeUndefined();
  });
});
