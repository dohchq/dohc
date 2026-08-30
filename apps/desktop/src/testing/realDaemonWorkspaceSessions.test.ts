import { readFileSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request } from "@dohc/workspace-engine-client";
import type { EngineDaemonClient } from "@dohc/workspace-engine-client/daemon";
import { describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { createRealDaemonWorkspaceSessions } from "./realDaemonWorkspaceSessions";

describe("real daemon workspace sessions", () => {
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
        deadlineMs: 10_000,
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

  it("keeps real-daemon suites on the shared session factory", () => {
    const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
    const lifecycleConstructor = ["new", "EngineDaemonLifecycle("].join(" ");
    const sessionConstructor = ["new", "EngineWorkspaceSessions("].join(" ");
    const offenders = testSources(desktopRoot)
      .filter(({ path, source }) => {
        const normalized = path.replaceAll("\\", "/");
        return (
          normalized.startsWith("e2e/") ||
          normalized.endsWith(".e2e.test.ts") ||
          source.includes(lifecycleConstructor)
        );
      })
      .filter(({ source }) => source.includes(sessionConstructor))
      .map(({ path }) => path)
      .sort();

    expect(offenders).toEqual([]);
  });
});

function testSources(root: string): Array<{ path: string; source: string }> {
  const sources: Array<{ path: string; source: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        sources.push({
          path: relative(root, absolute),
          source: readFileSync(absolute, "utf8"),
        });
      }
    }
  };
  visit(join(root, "src"));
  visit(join(root, "e2e"));
  return sources;
}
