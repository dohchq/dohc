import {
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { rmSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { createLiveLinkedChatStore } from "./liveLinkedChatStore";
import { createSuiteTestScratchSync } from "./testTemp";

// prepareWorkspace lstats the workspace root and requires a real directory, so a
// synthetic path fails ENOENT on every platform.
const chatReadyRoot = createSuiteTestScratchSync("dohc-chat-ready-");

afterAll(() => {
  rmSync(chatReadyRoot, { recursive: true, force: true });
});

describe("live linked chat store", () => {
  it("reads only one bounded channel page for Access", async () => {
    const requests: Request[] = [];
    const client = { close() {}, async sendRequest(request: Request): Promise<Response> {
      requests.push(request);
      if (request.method === "workspace.open") return { id: request.id, result: { workspace: "chat-handle" } };
      if (request.method === "chats.channels.list") return { id: request.id, result: { channels: [], nextCursor: "more" } };
      throw Error(`Unexpected request: ${request.method}`);
    } };
    const sessions = new EngineWorkspaceSessions({ currentClient: () => client });
    const store = createLiveLinkedChatStore({ workspaceId: "w", rootPath: chatReadyRoot }, sessions);
    expect(await store.listChannelsPage({ workspaceId: "w", limit: 100 })).toEqual({ channels: [], nextCursor: "more" });
    expect(requests.filter(request => request.method === "chats.channels.list").map(request => request.params)).toEqual([{ pageLimit: 100 }]);
    await expect(store.listChannelsPage({ workspaceId: "other", limit: 100 })).rejects.toThrow("workspace mismatch");
    expect(requests.filter(request => request.method === "chats.channels.list")).toHaveLength(1);
  });
  it("asks the engine to record the owner's account once, even when the seed fails", async () => {
    const requests: Request[] = [];
    let seedFails = true;
    const client = { close() {}, async sendRequest(request: Request): Promise<Response> {
      requests.push(request);
      if (request.method === "workspace.open") return { id: request.id, result: { workspace: "chat-handle" } };
      if (request.method === "chats.readState.seedAccount") {
        if (seedFails) throw new Error("the engine is busy");
        return { id: request.id, result: { recorded: true } };
      }
      if (request.method === "chats.channels.list") return { id: request.id, result: { channels: [], nextCursor: null } };
      throw Error(`Unexpected request: ${request.method}`);
    } };
    const sessions = new EngineWorkspaceSessions({ currentClient: () => client });
    let owner: string | undefined;
    const store = createLiveLinkedChatStore({ workspaceId: "w", rootPath: chatReadyRoot }, sessions, {
      accountReadOwner: () => owner,
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seeds = () => requests.filter(request => request.method === "chats.readState.seedAccount");
    try {
      // Signed out: nothing to record.
      await store.listChannelsPage({ workspaceId: "w", limit: 10 });
      expect(seeds()).toEqual([]);
      owner = "owner";
      await store.listChannelsPage({ workspaceId: "w", limit: 10 });
      await store.listChannelsPage({ workspaceId: "w", limit: 10 });
      expect(seeds().map(request => request.params)).toEqual([{ accountUserId: "owner", seedLocal: true }]);
      expect(logged).toHaveBeenCalledOnce();

      // Opening the workspace again makes a new store, which tries again.
      seedFails = false;
      const reopened = createLiveLinkedChatStore({ workspaceId: "w", rootPath: chatReadyRoot }, sessions, {
        accountReadOwner: () => owner,
      });
      await reopened.listChannelsPage({ workspaceId: "w", limit: 10 });
      await reopened.listChannelsPage({ workspaceId: "w", limit: 10 });
      expect(seeds()).toHaveLength(2);
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
  });
  it("opens the engine workspace when dispatch schema readiness is requested", async () => {
    const requests: Request[] = [];
    const client = {
      close() {},
      async sendRequest(request: Request): Promise<Response> {
        requests.push(request);
        if (request.method === "workspace.open") {
          return { id: request.id, result: { workspace: "chat-handle" } };
        }
        throw new Error(`Unexpected request: ${request.method}`);
      },
    };
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });
    const store = createLiveLinkedChatStore(
      {
        workspaceId: "workspace-chat-ready",
        rootPath: chatReadyRoot,
      },
      sessions,
    );

    await store.ensureOpen();

    expect(requests.map((request) => request.method)).toEqual([
      "workspace.open",
    ]);
  });
});
