import { readFileSync } from "node:fs";
import type {
  Request,
  Response,
} from "@dohc/workspace-engine-client";
import { describe, expect, it, vi } from "vitest";
import type { EngineDaemonClient } from "./engineDaemonLifecycle";
import {
  EngineWorkspaceRebindError,
  EngineWorkspaceSessions,
} from "./engineWorkspaceSessions";

describe("EngineWorkspaceRunOptions", () => {
  it("documents that transport retries replay the caller operation", () => {
    // MUTATION: remove the retryTransportErrors safety contract -> callers can
    // opt a non-idempotent write into operation replay without an API warning.
    const source = readFileSync(
      new URL("./engineWorkspaceSessions.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("Replays the operation after transport rebinding");
    expect(source).toContain("only for idempotent operations");
    expect(source).toContain("verify a possibly committed");
  });
});

class MockClient implements EngineDaemonClient {
  readonly requests: Request[] = [];

  constructor(private readonly handle: string) {}

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(request);
    if (request.method === "workspace.open") {
      return { id: request.id, result: { workspace: this.handle } };
    }
    if (request.method === "workspace.close") {
      return { id: request.id, result: { closed: true } };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  }

  close(): void {}
}

describe("EngineWorkspaceSessions", () => {
  it("bounds client-generation churn while opening a workspace", async () => {
    const first = new MockClient("handle-first");
    const second = new MockClient("handle-second");
    let reads = 0;
    const sleep = vi.fn(async () => {});
    const sessions = new EngineWorkspaceSessions(
      {
        currentClient: () => {
          const client = reads % 2 === 0 ? first : second;
          reads += 1;
          return client;
        },
      },
      { transportRebindAttempts: 2, sleep },
    );

    await expect(
      sessions.run(
        { workspaceId: "workspace-flapping", rootPath: "/tmp/flapping" },
        async () => "unreachable",
      ),
    ).rejects.toBeInstanceOf(EngineWorkspaceRebindError);
    expect(
      first.requests.filter((request) => request.method === "workspace.open"),
      "MUTATION: an unbounded open loop keeps issuing opens forever",
    ).toHaveLength(2);
    expect(
      first.requests.filter((request) => request.method === "workspace.close"),
    ).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
