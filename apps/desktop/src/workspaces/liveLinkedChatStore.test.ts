import {
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { describe, expect, it } from "vitest";
import { EngineWorkspaceSessions } from "./engineWorkspaceSessions";
import { createLiveLinkedChatStore } from "./liveLinkedChatStore";

describe("live linked chat store", () => {
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
        rootPath: "C:/workspace-chat-ready",
      },
      sessions,
    );

    await store.ensureOpen();

    expect(requests.map((request) => request.method)).toEqual([
      "workspace.open",
    ]);
  });
});
