import { describe, expect, it, vi } from "vitest";
import { createStartSitePreviewHandler } from "./ipc/sitePreviewIpc";
import { CHANNELS } from "./ipc/channels";
import { registerWorkspaceSearchIpcHandlers } from "./ipc/workspaceSearchIpc";
import { createSitePreviewLifecycle } from "./workspaces/sitePreviewLifecycle";
import { createEngineYDocSessionIpc } from "./workspaces/engineYDocSessionIpc";
import { RendererWorkspaceSessionOwner } from "./window/rendererWorkspaceSessionOwner";

function deferred() {
  return Promise.withResolvers<void>();
}

function sender(id: number) {
  const destroyedListeners: Array<() => void> = [];
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
    once(event: "destroyed", listener: () => void) {
      expect(event).toBe("destroyed");
      destroyedListeners.push(listener);
      return this;
    },
  };
}

describe("renderer reload admission", () => {
  it("denies fresh site preview, Y.Doc, and search work before retirement drains", async () => {
    const senderDrain = deferred();
    const workspaceDrain = deferred();
    const sessions = new RendererWorkspaceSessionOwner<ReturnType<typeof sender>>({
      retirement: {
        retireSender: () => senderDrain.promise,
        retireWorkspace: () => workspaceDrain.promise,
      },
    });
    const renderer = sender(7);
    const workspace = {
      workspaceId: "workspace-1",
      rootPath: "C:/workspace-1",
    };
    await sessions.open(renderer, workspace.workspaceId);

    const siteLifecycle = createSitePreviewLifecycle({
      allowOrigin: () => () => undefined,
    });
    const catalogGet = vi.fn(async () => null);
    const startSitePreview = createStartSitePreviewHandler({
      authority: {
        requireTrustedSender: (event: { sender: typeof renderer }) => event.sender,
        requireActiveWorkspace: (requestSender: typeof renderer) => {
          const session = sessions.current(requestSender);
          if (!session) throw new Error("Site preview has no active lease.");
          return { workspace, session };
        },
      },
      catalog: { list: async () => [], get: catalogGet },
      lifecycle: siteLifecycle,
      isSharedView: () => false,
      execute: vi.fn(async () => {
        throw new Error("site execution must not start");
      }),
    });

    const openYDocSession = vi.fn();
    const yDoc = createEngineYDocSessionIpc({
      sessionFor: (requestSender) =>
        sessions.current(requestSender as typeof renderer),
      requireWorkspace: () => workspace,
      captureFor: () => ({ openYDocSession }),
      ensureCaptureFor: vi.fn(async () => undefined),
      isSharedView: () => false,
      resolveDocumentPath: async (_workspace, path) => path,
      onError: vi.fn(),
    });

    const searchHandlers = new Map<
      string,
      (event: { sender: typeof renderer }, payload: unknown) => unknown
    >();
    const searchStart = vi.fn(async () => undefined);
    registerWorkspaceSearchIpcHandlers<
      { sender: typeof renderer },
      typeof workspace
    >({
      registerHandler: (channel, handler) => searchHandlers.set(channel, handler),
      assertTrustedSender: () => undefined,
      authorizeWorkspace: (event, workspaceId) => {
        const session = sessions.current(event.sender);
        if (!session || session.workspaceId !== workspaceId) {
          throw new Error("Search has no active lease.");
        }
        return { workspace, isCurrent: () => session.isCurrent() };
      },
      owner: { start: searchStart, cancel: vi.fn() },
    });

    const reload = sessions.retireForReload(renderer);

    await expect(
      startSitePreview(
        { sender: renderer },
        { workspaceId: workspace.workspaceId, siteRoot: "site", mode: "static" },
      ),
    ).rejects.toThrow("no active lease");
    await expect(
      yDoc.open(renderer, {
        workspaceId: workspace.workspaceId,
        sessionId: "renderer-doc-1",
        path: "notes/a.md",
      }),
    ).resolves.toEqual({ available: false });
    await expect(
      searchHandlers.get(CHANNELS.searchWorkspace)!(
        { sender: renderer },
        {
          workspaceId: workspace.workspaceId,
          searchId: "search-after-reload",
          query: "needle",
        },
      ),
    ).rejects.toThrow("no active lease");

    expect(catalogGet).not.toHaveBeenCalled();
    expect(openYDocSession).not.toHaveBeenCalled();
    expect(searchStart).not.toHaveBeenCalled();

    senderDrain.resolve();
    workspaceDrain.resolve();
    await reload;
  });
});
