import { describe, expect, it, vi } from "vitest";
import { createStartSitePreviewHandler } from "./ipc/sitePreviewIpc";
import { CHANNELS } from "./ipc/channels";
import { registerWorkspaceSearchIpcHandlers } from "./ipc/workspaceSearchIpc";
import { createSitePreviewLifecycle } from "./workspaces/sitePreviewLifecycle";
import { createEngineYDocSessionIpc } from "./workspaces/engineYDocSessionIpc";
import { PresenceMutationOwner } from "./collab/presenceMutationOwner";
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
  it("denies fresh work and displaced search and presence cancels", async () => {
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
    await sessions.open(renderer, workspace.workspaceId, "document-1");

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
      acquireWorkspace: () => ({
        workspace,
        assertCurrent: () => undefined,
        release: () => undefined,
      }),
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
    const searchCancel = vi.fn();
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
      authorizeCancel: (event) => {
        return sessions.current(event.sender) !== undefined;
      },
      owner: { start: searchStart, cancel: searchCancel },
    });

    const reload = sessions.retireForReload(renderer, "document-1");

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

    const replacement = sender(renderer.id);
    await sessions.open(replacement, workspace.workspaceId, "document-2");
    await searchHandlers.get(CHANNELS.cancelWorkspaceSearch)!(
      { sender: renderer },
      { searchId: "reused-search-id" },
    );
    expect(searchCancel).not.toHaveBeenCalled();

    await searchHandlers.get(CHANNELS.cancelWorkspaceSearch)!(
      { sender: replacement },
      { searchId: "reused-search-id" },
    );
    expect(searchCancel).toHaveBeenCalledWith(
      replacement.id,
      "reused-search-id",
    );

  });
});

describe("presence mutation admission", () => {
  it("rejects an old cleanup through the current A-to-B-to-A session", async () => {
    const renderer = sender(7);
    const mutations = new PresenceMutationOwner<ReturnType<typeof sender>>();
    const sessions = new RendererWorkspaceSessionOwner<ReturnType<typeof sender>>({
      retirement: {
        retireSender: (session) => mutations.retireSender(session),
        retireWorkspace: async () => undefined,
      },
    });
    const topicKey = "workspace-a/chat:channel:1/client-1";
    const oldIncarnation = "123e4567-e89b-42d3-a456-426614174001";
    const newIncarnation = "123e4567-e89b-42d3-a456-426614174002";
    const documentId = "document-1";
    const invokePublish = async (input: {
      rendererDocumentId: string;
      incarnationId: string;
      publish: () => Promise<string>;
      leave: () => Promise<void>;
    }) => {
      const current = sessions.currentForDocument(
        renderer,
        input.rendererDocumentId,
      );
      if (!current) return "unavailable";
      return await mutations.publish(
        current,
        topicKey,
        input.incarnationId,
        {
          resolve: async () => ({
            publish: input.publish,
            leave: input.leave,
          }),
        },
      );
    };
    const invokeLeave = async (input: {
      rendererDocumentId: string;
      incarnationId: string;
      leave: () => Promise<void>;
    }) => {
      const current = sessions.currentForDocument(
        renderer,
        input.rendererDocumentId,
      );
      if (!current) return "unavailable";
      return (await mutations.leave(
        current,
        topicKey,
        input.incarnationId,
        async () => input.leave,
      ))
        ? "left"
        : "noop";
    };

    await sessions.open(renderer, "workspace-a", documentId);
    const retiredLeave = vi.fn(async () => undefined);
    await expect(
      invokePublish({
        rendererDocumentId: documentId,
        incarnationId: oldIncarnation,
        publish: async () => "old",
        leave: retiredLeave,
      }),
    ).resolves.toBe("old");

    await sessions.open(renderer, "workspace-b", documentId);
    await sessions.open(renderer, "workspace-a", documentId);
    expect(retiredLeave).toHaveBeenCalledOnce();
    const currentLeave = vi.fn(async () => undefined);
    await expect(
      invokePublish({
        rendererDocumentId: documentId,
        incarnationId: newIncarnation,
        publish: async () => "new",
        leave: currentLeave,
      }),
    ).resolves.toBe("new");

    const staleResolver = vi.fn(async () => undefined);
    await expect(
      invokeLeave({
        rendererDocumentId: documentId,
        incarnationId: oldIncarnation,
        leave: staleResolver,
      }),
    ).resolves.toBe("noop");
    expect(staleResolver).not.toHaveBeenCalled();
    expect(currentLeave).not.toHaveBeenCalled();

    await expect(
      invokeLeave({
        rendererDocumentId: documentId,
        incarnationId: newIncarnation,
        leave: currentLeave,
      }),
    ).resolves.toBe("left");
    expect(currentLeave).toHaveBeenCalledOnce();
  });

  it("rejects an old-document presence invoke before successor ownership", async () => {
    const renderer = sender(7);
    const mutations = new PresenceMutationOwner<ReturnType<typeof sender>>();
    const sessions = new RendererWorkspaceSessionOwner<ReturnType<typeof sender>>({
      retirement: {
        retireSender: (session) => mutations.retireSender(session),
        retireWorkspace: async () => undefined,
      },
    });
    await sessions.open(renderer, "workspace-a", "document-1");
    await sessions.retireForReload(renderer, "document-1");
    const successor = await sessions.open(
      renderer,
      "workspace-a",
      "document-2",
    );

    expect(sessions.currentForDocument(renderer, "document-1")).toBeUndefined();
    expect(sessions.currentForDocument(renderer, "document-2")).toBe(successor);
  });
});
