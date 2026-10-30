import { rm } from "node:fs/promises";
import type { Request } from "@dohc/workspace-engine-client";
import type { EngineDaemonClient } from "@dohc/workspace-engine-client/daemon";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import {
  createRealDaemonLifecycle,
  createRealDaemonWorkspaceSessions,
} from "./realDaemonWorkspaceSessions";

vi.mock("../workspaces/installedReaderConfig", () => ({
  installedReaderConfig: () => "prepared-reader-config",
}));

describe("real daemon workspace sessions", () => {
  it("launches the prepared witness checker for imported Markdown edits", async () => {
    const launch = vi.fn(async (): Promise<EngineDaemonClient> => ({
      close() {},
      async sendRequest(request) { return { id: request.id, result: {} }; },
    }));
    const lifecycle = createRealDaemonLifecycle({ command: "engine", fileExists: () => true, launch });
    try {
      await lifecycle.start();
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({
        env: expect.objectContaining({ DOHC_ENGINE_READER_CONFIG: "prepared-reader-config" }),
      }));
    } finally { await lifecycle.stop(); }
  });

  it("gives every workspace open the shared real-daemon test deadline", async () => {
    const rootPath = await createTestScratch("dohc-real-daemon-sessions-");
    const requests: Request[] = [];
    const client: EngineDaemonClient = {
      close() {},
      async sendRequest(request) {
        requests.push(request);
        if (request.method === "workspace.open") {
          return { id: request.id, result: { workspace: "handle-1" } };
        }
        if (request.method === "workspace.close") {
          return { id: request.id, result: { closed: true } };
        }
        throw new Error(`Unexpected request: ${request.method}`);
      },
    };
    const sessions = createRealDaemonWorkspaceSessions({
      currentClient: () => client,
    });

    try {
      await sessions.run(
        { workspaceId: "real-daemon-test", rootPath },
        async () => undefined,
      );

      expect(requests[0]).toMatchObject({
        method: "workspace.open",
        deadlineMs: 20_000,
      });
    } finally {
      await sessions.closeAll();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("keeps a profile's explicit open budget on the shared factory", async () => {
    const rootPath = await createTestScratch("dohc-profile-daemon-sessions-");
    const requests: Request[] = [];
    const client: EngineDaemonClient = {
      close() {},
      async sendRequest(request) {
        requests.push(request);
        if (request.method === "workspace.open") {
          return { id: request.id, result: { workspace: "handle-1" } };
        }
        if (request.method === "workspace.close") {
          return { id: request.id, result: { closed: true } };
        }
        throw new Error(`Unexpected request: ${request.method}`);
      },
    };
    const sessions = createRealDaemonWorkspaceSessions(
      { currentClient: () => client },
      { workspaceOpenDeadlineMs: 300_000 },
    );

    try {
      await sessions.run(
        { workspaceId: "profile-daemon-test", rootPath },
        async () => undefined,
      );
      expect(requests[0]).toMatchObject({
        method: "workspace.open",
        deadlineMs: 300_000,
      });
    } finally {
      await sessions.closeAll();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("gives the startup smoke the shared real-daemon test deadline", async () => {
    const requests: Request[] = [];
    const client: EngineDaemonClient = {
      close() {},
      async sendRequest(request) {
        requests.push(request);
        if (request.method === "workspace.open") {
          return { id: request.id, result: { workspace: "handle-1" } };
        }
        return { id: request.id, result: {} };
      },
    };
    const lifecycle = createRealDaemonLifecycle({
      command: "engine",
      fileExists: () => true,
      launch: async () => client,
    });

    try {
      await lifecycle.start();
      await expect
        .poll(() => requests.find(({ method }) => method === "workspace.open"))
        .toMatchObject({ deadlineMs: 20_000 });
    } finally {
      await lifecycle.stop();
    }
  });

});
