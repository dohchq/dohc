import {
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { createLiveLinkedChatStore } from "./liveLinkedChatStore";

// prepareWorkspace lstats the workspace root and requires a real directory, so a
// synthetic path fails ENOENT on every platform.
const chatReadyRoot = mkdtempSync(join(tmpdir(), "dohc-chat-ready-"));

afterAll(() => {
  rmSync(chatReadyRoot, { recursive: true, force: true });
});

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
