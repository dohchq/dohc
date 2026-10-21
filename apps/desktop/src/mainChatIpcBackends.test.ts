import { chatOperations } from "./ipc/chatOperations";
import {
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { ChatsLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import {
  type LinkedChatStore,
} from "@dohc/workspace-contracts/engine";
import { describe, expect, it, vi } from "vitest";
import type { MainChatIpcHandler } from "./mainChatIpcHandlers";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { createDesktopLinkedChatStore } from "./workspaces/liveLinkedChatStore";
import { createTestScratch } from "./workspaces/testTemp";

function createChatFlowHandler<Event, Payload extends { workspaceId: string }, Context, Result>(input: {
  parsePayload: (payload: unknown) => Payload;
  requireContext: (workspaceId: string) => Promise<Context>;
  run: (context: Context, payload: Payload) => Promise<Result>;
}): MainChatIpcHandler<Event, Result> {
  return async (_event, rawPayload) => {
    const payload = input.parsePayload(rawPayload);
    const context = await input.requireContext(payload.workspaceId);
    return input.run(context, payload);
  };
}

interface TestEvent {
  trusted: boolean;
}

interface TestContext {
  workspace: { workspaceId: string };
  store: LinkedChatStore;
}

type RegisteredHandler = MainChatIpcHandler<TestEvent, unknown>;

function runtimeHarness() {
  const handlers = new Map<string, RegisteredHandler>();
  return {
    handle(channel: string, handler: RegisteredHandler) {
      handlers.set(channel, handler);
    },
    invoke(channel: string, payload: unknown) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for ${channel}.`);
      return handler({ trusted: true }, payload);
    },
  };
}

function parseWorkspacePayload<T extends { workspaceId: string }>(
  payload: unknown,
): T {
  const parsed = payload as T;
  if (typeof parsed?.workspaceId !== "string") {
    throw new Error("Invalid payload.");
  }
  return parsed;
}

function registerChatFlowHandlers(
  context: TestContext,
  ipc: ReturnType<typeof runtimeHarness>,
) {
  const deps = {
    assertTrustedSender(event: TestEvent) {
      if (!event.trusted) throw new Error("Untrusted renderer.");
    },
    parsePayload: <T extends { workspaceId: string }>(payload: unknown) =>
      parseWorkspacePayload<T>(payload),
    async requireContext(workspaceId: string) {
      if (workspaceId !== context.workspace.workspaceId) {
        throw new Error("Workspace not found.");
      }
      return context;
    },
  };

  ipc.handle(
    chatOperations.listChatChannels.channel,
    async (event, payload) => {
      deps.assertTrustedSender(event);
      const input = parseWorkspacePayload<{ workspaceId: string }>(payload);
      return await context.store.listChannels(input);
    },
  );
  ipc.handle(
    chatOperations.createChatChannel.channel,
    createChatFlowHandler({
      ...deps,
      parsePayload: (payload) =>
        parseWorkspacePayload<{ workspaceId: string; name: string }>(payload),
      run: async ({ store }, input) =>
        await store.createChannel({ ...input, kind: "channel" }),
    }),
  );
  ipc.handle(
    chatOperations.startChannelThread.channel,
    createChatFlowHandler({
      ...deps,
      parsePayload: (payload) =>
        parseWorkspacePayload<{
          workspaceId: string;
          channelId: string;
          body: string;
          needsDecision?: boolean;
        }>(payload),
      run: async ({ store }, input) =>
        await store.startChannelThread({
          authorActorKey: null,
          ...input,
          author: { kind: "human", displayName: "Sam" },
        }),
    }),
  );
  ipc.handle(
    chatOperations.listChannelThreads.channel,
    async (event, payload) => {
      deps.assertTrustedSender(event);
      return await context.store.listChannelThreads(
        parseWorkspacePayload(payload),
      );
    },
  );
  ipc.handle(
    chatOperations.sendChatMessage.channel,
    createChatFlowHandler({
      ...deps,
      parsePayload: (payload) =>
        parseWorkspacePayload<{
          workspaceId: string;
          threadId: string;
          body: string;
          resolves?: { messageId: string };
        }>(payload),
      run: async ({ store }, { resolves, ...input }) => {
        const message = await store.sendMessage({
          authorActorKey: null,
          ...input,
          author: { kind: "human", displayName: "Sam" },
        });
        const resolved = resolves
          ? await store.resolveChatDecision({
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              messageId: resolves.messageId,
              resolvedByMessageId: message.id,
            })
          : undefined;
        return { message, ...(resolved ? { resolved } : {}) };
      },
    }),
  );
  ipc.handle(
    chatOperations.listChatMessages.channel,
    async (event, payload) => {
      deps.assertTrustedSender(event);
      return await context.store.listMessages(
        parseWorkspacePayload(payload),
      );
    },
  );
  ipc.handle(
    chatOperations.getChatThreadRevision.channel,
    async (event, payload) => {
      deps.assertTrustedSender(event);
      const revision = await context.store.getThreadRevision(
        parseWorkspacePayload(payload),
      );
      return { revision };
    },
  );
  ipc.handle(
    chatOperations.markChatThreadRead.channel,
    createChatFlowHandler({
      ...deps,
      parsePayload: (payload) =>
        parseWorkspacePayload<{
          workspaceId: string;
          threadId: string;
          upToSequence: number;
        }>(payload),
      run: async ({ store }, input) => await store.markThreadRead(input),
    }),
  );
  ipc.handle(
    chatOperations.listChatReactions.channel,
    async (event, payload) => {
      deps.assertTrustedSender(event);
      return await context.store.listReactions(
        parseWorkspacePayload(payload),
      );
    },
  );
  ipc.handle(
    chatOperations.setChatReaction.channel,
    createChatFlowHandler({
      ...deps,
      parsePayload: (payload) =>
        parseWorkspacePayload<{
          workspaceId: string;
          threadId: string;
          messageId: string;
          emoji: string;
          state: "added" | "removed";
        }>(payload),
      run: async ({ store }, input) =>
        await store.setReaction({
          ...input,
          author: {
            authorId: "local-user",
            kind: "human",
            displayName: "Sam",
          },
        }),
    }),
  );
  ipc.handle(
    chatOperations.saveChatBookmark.channel,
    createChatFlowHandler({
      ...deps,
      parsePayload: (payload) =>
        parseWorkspacePayload<{
          workspaceId: string;
          targetId: string;
          destinationPath: string;
        }>(payload),
      run: async ({ store }, input) => {
        const bookmark = await store.saveBookmark({
          workspaceId: input.workspaceId,
          ownerUserId: "local-user",
          targetKind: "message",
          targetId: input.targetId,
          mode: "snapshot",
          destinationPath: input.destinationPath,
        });
        return await store.markBookmarkReady({
          workspaceId: input.workspaceId,
          ownerUserId: "local-user",
          bookmarkId: bookmark.bookmarkId,
          generation: bookmark.generation,
          projectedAtMs: 100,
        });
      },
    }),
  );
  ipc.handle(
    chatOperations.setChatFollow.channel,
    createChatFlowHandler({
      ...deps,
      parsePayload: (payload) =>
        parseWorkspacePayload<{
          workspaceId: string;
          targetId: string;
        }>(payload),
      run: async ({ store }, input) =>
        await store.setFollow({
          workspaceId: input.workspaceId,
          ownerUserId: "local-user",
          targetKind: "thread",
          targetId: input.targetId,
          state: "following",
        }),
    }),
  );
}

function loopbackClient(engine: ChatsLoopbackEngine) {
  const requests: Request[] = [];
  return {
    requests,
    close() {},
    async sendRequest(request: Request): Promise<Response> {
      requests.push(request);
      if (request.method === "workspace.open") {
        const workspaceId = (request.params as { workspaceId: string })
          .workspaceId;
        return { id: request.id, result: { workspace: workspaceId } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      return await engine.sendRequest(request);
    },
  };
}

describe("main chat IPC live backend", () => {
    it("round_trips_channels_threads_messages_read_decision_reaction_bookmark_and_follow", async () => {
      const rootPath = await createTestScratch("dohc-main-chat-live-");
      const workspace = {
        workspaceId: "workspace-live",
        rootPath,
      };
      const engine = new ChatsLoopbackEngine();
      const client = loopbackClient(engine);
      const sessions = new EngineWorkspaceSessions({
        currentClient: () => client,
      });
      const store = createDesktopLinkedChatStore(workspace, {
        sessions,
      });
      const ipc = runtimeHarness();
      registerChatFlowHandlers({ workspace, store }, ipc);

      try {
        const channel = (await ipc.invoke(chatOperations.createChatChannel.channel, {
          workspaceId: workspace.workspaceId,
          name: "Planning",
        })) as Awaited<ReturnType<LinkedChatStore["createChannel"]>>;
        expect(channel.name).toBe("Planning");
        await expect(
          ipc.invoke(chatOperations.listChatChannels.channel, {
            workspaceId: workspace.workspaceId,
          }),
        ).resolves.toEqual([
          expect.objectContaining({ id: channel.id, name: "Planning" }),
        ]);

        const started = (await ipc.invoke(chatOperations.startChannelThread.channel, {
          workspaceId: workspace.workspaceId,
          channelId: channel.id,
          body: "Choose a direction",
          needsDecision: true,
        })) as Awaited<ReturnType<LinkedChatStore["startChannelThread"]>>;
        await expect(
          ipc.invoke(chatOperations.listChannelThreads.channel, {
            workspaceId: workspace.workspaceId,
            channelId: channel.id,
          }),
        ).resolves.toEqual([
          expect.objectContaining({
            thread: expect.objectContaining({ id: started.thread.id }),
          }),
        ]);

        const { message: resolution, resolved } = (await ipc.invoke(chatOperations.sendChatMessage.channel, {
          workspaceId: workspace.workspaceId,
          threadId: started.thread.id,
          body: "Use the Rust path",
          resolves: { messageId: started.message.id },
        })) as {
          message: Awaited<ReturnType<LinkedChatStore["sendMessage"]>>;
          resolved?: Awaited<ReturnType<LinkedChatStore["resolveChatDecision"]>>;
        };
        expect(resolved).toMatchObject({ state: "resolved", resolvedByMessageId: resolution.id });
        await expect(
          ipc.invoke(chatOperations.getChatThreadRevision.channel, {
            workspaceId: workspace.workspaceId,
            threadId: started.thread.id,
          }),
        ).resolves.toEqual({ revision: 4 });
        await expect(
          ipc.invoke(chatOperations.listChatMessages.channel, {
            workspaceId: workspace.workspaceId,
            threadId: started.thread.id,
          }),
        ).resolves.toHaveLength(2);
        await expect(
          ipc.invoke(chatOperations.markChatThreadRead.channel, {
            workspaceId: workspace.workspaceId,
            threadId: started.thread.id,
            upToSequence: 2,
          }),
        ).resolves.toMatchObject({ lastReadSequence: 2 });
        await expect(
          ipc.invoke(chatOperations.setChatReaction.channel, {
            workspaceId: workspace.workspaceId,
            threadId: started.thread.id,
            messageId: resolution.id,
            emoji: "👍",
            state: "added",
          }),
        ).resolves.toMatchObject({ state: "added" });
        await expect(
          ipc.invoke(chatOperations.listChatReactions.channel, {
            workspaceId: workspace.workspaceId,
            threadId: started.thread.id,
          }),
        ).resolves.toEqual([
          expect.objectContaining({
            messageId: resolution.id,
            emoji: "👍",
            state: "added",
          }),
        ]);
        await expect(
          ipc.invoke(chatOperations.setChatReaction.channel, {
            workspaceId: workspace.workspaceId,
            threadId: started.thread.id,
            messageId: resolution.id,
            emoji: "👍",
            state: "removed",
          }),
        ).resolves.toMatchObject({ state: "removed" });
        await expect(
          ipc.invoke(chatOperations.saveChatBookmark.channel, {
            workspaceId: workspace.workspaceId,
            targetId: resolution.id,
            destinationPath: "bookmarks/rust.md",
          }),
        ).resolves.toMatchObject({
          applied: true,
          bookmark: { projectionState: "ready" },
        });
        await expect(
          ipc.invoke(chatOperations.setChatFollow.channel, {
            workspaceId: workspace.workspaceId,
            targetId: started.thread.id,
          }),
        ).resolves.toMatchObject({
          targetId: started.thread.id,
          state: "following",
        });

        expect(client.requests.map((request) => request.method)).toEqual(
          expect.arrayContaining([
            "workspace.open",
            "chats.channels.create",
            "chats.channels.list",
            "chats.threads.start",
            "chats.threads.listForChannel",
            "chats.messages.send",
            "chats.messages.list",
            "chats.readState.markThreadRead",
            "chats.decisions.resolve",
            "chats.reactions.set",
            "chats.reactions.list",
            "chats.bookmarks.save",
            "chats.bookmarks.markReady",
            "chats.follows.set",
          ]),
        );
      } finally {
        await store.close();
        await sessions.closeAll();
      }
    });
});

describe("desktop linked chat factory", () => {
  it("keeps_file_thread_path_hints_on_the_live_list_threads_shape", async () => {
    const rootPath = await createTestScratch("dohc-live-chat-hint-");
    const workspace = {
      workspaceId: "workspace-live-hint",
      rootPath,
    };
    const client = loopbackClient(new ChatsLoopbackEngine());
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });
    const store = createDesktopLinkedChatStore(workspace, {
      sessions,
    });

    try {
      const created = await store.createThread({
        workspaceId: workspace.workspaceId,
        title: "Removed file",
        linkedFile: {
          objectId: "object-removed",
          pathHint: "notes/removed.md",
        },
      });
      await expect(
        store.listThreads({ workspaceId: workspace.workspaceId }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: created.id,
          linkedFile: expect.objectContaining({
            objectId: "object-removed",
            pathHint: "notes/removed.md",
          }),
        }),
      ]);
      expect(client.requests.map((request) => request.method)).toContain(
        "chats.threads.listForFile",
      );
    } finally {
      await store.close();
    }
  });

  it("bounds_file_thread_path_hint_enrichment_requests", async () => {
    const rootPath = await createTestScratch("dohc-live-chat-hint-bound-");
    const workspace = {
      workspaceId: "workspace-live-hint-bound",
      rootPath,
    };
    const engine = new ChatsLoopbackEngine();
    const baseClient = loopbackClient(engine);
    let delayFileReads = false;
    let activeFileReads = 0;
    let maxActiveFileReads = 0;
    let startedFileReads = 0;
    let releaseFileReads!: () => void;
    const fileReadGate = new Promise<void>((resolve) => {
      releaseFileReads = resolve;
    });
    const client = {
      close: () => baseClient.close(),
      async sendRequest(request: Request): Promise<Response> {
        if (
          delayFileReads &&
          request.method === "chats.threads.listForFile"
        ) {
          startedFileReads += 1;
          activeFileReads += 1;
          maxActiveFileReads = Math.max(
            maxActiveFileReads,
            activeFileReads,
          );
          await fileReadGate;
          try {
            return await baseClient.sendRequest(request);
          } finally {
            activeFileReads -= 1;
          }
        }
        return await baseClient.sendRequest(request);
      },
    };
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });
    const store = createDesktopLinkedChatStore(workspace, {
      sessions,
    });

    try {
      for (let index = 0; index < 20; index += 1) {
        await store.createThread({
          workspaceId: workspace.workspaceId,
          title: `File ${index}`,
          linkedFile: {
            objectId: `object-${index}`,
            pathHint: `notes/file-${index}.md`,
          },
        });
      }

      delayFileReads = true;
      const listing = store.listThreads({
        workspaceId: workspace.workspaceId,
      });
      await vi.waitFor(() => {
        expect(startedFileReads).toBe(8);
      });
      expect(activeFileReads).toBe(8);
      expect(maxActiveFileReads).toBe(8);

      releaseFileReads();
      await expect(listing).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            linkedFile: expect.objectContaining({
              pathHint: "notes/file-19.md",
            }),
          }),
        ]),
      );
      expect(startedFileReads).toBe(20);
      expect(maxActiveFileReads).toBe(8);
    } finally {
      releaseFileReads();
      await store.close();
    }
  });

  it("rebinds_read_calls_after_transport_loss_without_retrying_writes", async () => {
    const rootPath = await createTestScratch("dohc-live-chat-read-retry-");
    const workspace = {
      workspaceId: "workspace-live-read-retry",
      rootPath,
    };
    const engine = new ChatsLoopbackEngine();
    const firstBaseClient = loopbackClient(engine);
    const replacementClient = loopbackClient(engine);
    let currentClient: ReturnType<typeof loopbackClient>;
    let failRead = false;
    let failedReadAttempts = 0;
    const firstClient = {
      requests: firstBaseClient.requests,
      close: () => firstBaseClient.close(),
      async sendRequest(request: Request): Promise<Response> {
        if (failRead && request.method === "chats.channels.list") {
          failedReadAttempts += 1;
          currentClient = replacementClient;
          throw Object.assign(new Error("sidecar transport lost"), {
            code: "transport-error" as const,
          });
        }
        return await firstBaseClient.sendRequest(request);
      },
    };
    currentClient = firstClient;
    const sessions = new EngineWorkspaceSessions(
      {
        currentClient: () => currentClient,
      },
      {
        sleep: async () => undefined,
      },
    );
    const store = createDesktopLinkedChatStore(workspace, {
      sessions,
    });

    try {
      const channel = await store.createChannel({
        workspaceId: workspace.workspaceId,
        name: "Recovered",
      });
      failRead = true;

      await expect(
        store.listChannels({ workspaceId: workspace.workspaceId }),
      ).resolves.toEqual([
        expect.objectContaining({ id: channel.id, name: "Recovered" }),
      ]);
      expect(failedReadAttempts).toBe(1);
      expect(
        replacementClient.requests.map((request) => request.method),
      ).toEqual(["workspace.open", "chats.channels.list"]);
    } finally {
      await store.close();
    }

    const writeEngine = new ChatsLoopbackEngine();
    const writeFirstBaseClient = loopbackClient(writeEngine);
    const writeReplacementClient = loopbackClient(writeEngine);
    let currentWriteClient: ReturnType<typeof loopbackClient>;
    const writeFirstClient = {
      requests: writeFirstBaseClient.requests,
      close: () => writeFirstBaseClient.close(),
      async sendRequest(request: Request): Promise<Response> {
        if (request.method === "chats.channels.create") {
          currentWriteClient = writeReplacementClient;
          throw Object.assign(new Error("write acknowledgement lost"), {
            code: "transport-error" as const,
          });
        }
        return await writeFirstBaseClient.sendRequest(request);
      },
    };
    currentWriteClient = writeFirstClient;
    const writeSessions = new EngineWorkspaceSessions({
      currentClient: () => currentWriteClient,
    });
    const writeStore = createDesktopLinkedChatStore(workspace, {
      sessions: writeSessions,
    });

    try {
      await expect(
        writeStore.createChannel({
          workspaceId: workspace.workspaceId,
          name: "Do not replay",
        }),
      ).rejects.toMatchObject({ code: "transport-error" });
      expect(writeReplacementClient.requests).toEqual([]);
    } finally {
      await writeStore.close();
    }
  });
});
