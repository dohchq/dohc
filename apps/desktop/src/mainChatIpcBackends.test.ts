import { type Request, type Response } from "@dohc/workspace-engine-client";
import { ChatsLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { describe, expect, it, vi } from "vitest";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { createDesktopLinkedChatStore } from "./workspaces/liveLinkedChatStore";
import { createTestScratch } from "./workspaces/testTemp";

function loopbackClient(engine: ChatsLoopbackEngine) {
  const requests: Request[] = [];
  return {
    requests,
    close() {},
    async sendRequest(request: Request): Promise<Response> {
      requests.push(request);
      if (request.method === "workspace.open") {
        const workspaceId = (request.params as { workspaceId: string }).workspaceId;
        return { id: request.id, result: { workspace: workspaceId } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      return await engine.sendRequest(request);
    },
  };
}

describe("desktop linked chat factory", () => {
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
        if (delayFileReads && request.method === "chats.threads.listForFile") {
          startedFileReads += 1;
          activeFileReads += 1;
          maxActiveFileReads = Math.max(maxActiveFileReads, activeFileReads);
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

      await expect(store.listChannels({ workspaceId: workspace.workspaceId })).resolves.toEqual([
        expect.objectContaining({ id: channel.id, name: "Recovered" }),
      ]);
      expect(failedReadAttempts).toBe(1);
      expect(replacementClient.requests.map((request) => request.method)).toEqual([
        "workspace.open",
        "chats.channels.list",
      ]);
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
