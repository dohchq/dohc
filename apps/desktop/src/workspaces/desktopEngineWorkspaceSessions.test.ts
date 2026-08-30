import { rm } from "node:fs/promises";
import type { Request, Response } from "@dohc/workspace-engine-client";
import type {
  EngineDaemonClient,
  EngineDaemonClientSource,
} from "@dohc/workspace-engine-client/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { createTestScratch } from "./testTemp";
import {
  createDesktopEngineWorkspaceSessions,
  DESKTOP_WORKSPACE_OPEN_DEADLINE_MS,
} from "./desktopEngineWorkspaceSessions";

describe("desktop engine workspace sessions", () => {
  const scratch: string[] = [];

  afterEach(async () => {
    await Promise.all(
      scratch.splice(0).map(async (path) => {
        await rm(path, { recursive: true, force: true });
      }),
    );
  });

  it("allows a measured cold adoption to finish before exposing the handle", async () => {
    const rootPath = await createTestScratch("dohc-desktop-engine-sessions-");
    scratch.push(rootPath);
    const openRequested = Promise.withResolvers<Request>();
    const openResponse = Promise.withResolvers<Response>();
    const client: EngineDaemonClient = {
      close() {},
      async sendRequest(request) {
        if (request.method === "workspace.open") {
          openRequested.resolve(request);
          return await openResponse.promise;
        }
        if (request.method === "workspace.close") {
          return { id: request.id, result: { closed: true } };
        }
        throw new Error(`Unexpected request: ${request.method}`);
      },
    };
    const source: EngineDaemonClientSource = {
      currentClient: () => client,
    };
    const sessions = createDesktopEngineWorkspaceSessions(source);
    let operationStarted = false;

    const run = sessions.run(
      { workspaceId: "cold-adoption", rootPath },
      async () => {
        operationStarted = true;
      },
    );
    const request = await openRequested.promise;

    expect(DESKTOP_WORKSPACE_OPEN_DEADLINE_MS).toBe(120_000);
    expect(request.deadlineMs).toBe(DESKTOP_WORKSPACE_OPEN_DEADLINE_MS);
    expect(operationStarted).toBe(false);

    openResponse.resolve({
      id: request.id,
      result: { workspace: "cold-adoption-handle" },
    });
    await run;
    expect(operationStarted).toBe(true);

    await sessions.closeAll();
  });
});
