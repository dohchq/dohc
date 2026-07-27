import { readFileSync } from "node:fs";
import {
  type Request,
  type Response,
  type WorkspaceHandle,
} from "@dohc/workspace-engine-client";
import { describe, expect, it, vi } from "vitest";
import {
  EngineDaemonUnavailableError,
  type EngineDaemonClient,
} from "./engineDaemonLifecycle";
import {
  EngineWorkspaceRebindError,
  EngineWorkspaceSessions,
  WORKSPACE_OPEN_DEADLINE_MS,
} from "./engineWorkspaceSessions";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const workspace = {
  workspaceId: "workspace-sessions-test",
  rootPath: "C:/workspace-sessions-test",
};

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
  it("drains active runs and blocks replacement opens until closeWorkspace finishes", async () => {
    const operationGate = deferred<void>();
    const closeGate = deferred<void>();
    const requests: Request[] = [];
    let openCount = 0;
    const client = {
      close() {},
      async sendRequest(request: Request): Promise<Response> {
        requests.push(request);
        if (request.method === "workspace.open") {
          openCount += 1;
          return {
            id: request.id,
            result: { workspace: `handle-${openCount}` },
          };
        }
        if (request.method === "workspace.close") {
          await closeGate.promise;
          return { id: request.id, result: { closed: true } };
        }
        throw new Error(`Unexpected request: ${request.method}`);
      },
    };
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });
    const firstOperationStarted = deferred<void>();
    const firstRun = sessions.run(workspace, async () => {
      firstOperationStarted.resolve();
      await operationGate.promise;
      return "first";
    });
    await firstOperationStarted.promise;

    const closing = sessions.closeWorkspace(workspace.workspaceId);
    await Promise.resolve();
    expect(
      requests.filter((request) => request.method === "workspace.close"),
    ).toHaveLength(0);

    operationGate.resolve();
    await expect(firstRun).resolves.toBe("first");
    await vi.waitFor(() => {
      expect(
        requests.filter((request) => request.method === "workspace.close"),
      ).toHaveLength(1);
    });

    const secondOperation = vi.fn(
      async (binding: { workspace: WorkspaceHandle }) => binding.workspace,
    );
    const secondRun = sessions.run(workspace, secondOperation);
    await Promise.resolve();
    expect(openCount).toBe(1);
    expect(secondOperation).not.toHaveBeenCalled();

    closeGate.resolve();
    await closing;
    await expect(secondRun).resolves.toBe("handle-2");
    expect(secondOperation).toHaveBeenCalledOnce();
  });

  it("makes closeAll terminal so teardown cannot be repopulated", async () => {
    const closeGate = deferred<void>();
    const requests: Request[] = [];
    let openCount = 0;
    const client = {
      close() {},
      async sendRequest(request: Request): Promise<Response> {
        requests.push(request);
        if (request.method === "workspace.open") {
          openCount += 1;
          return {
            id: request.id,
            result: { workspace: `handle-${openCount}` },
          };
        }
        if (request.method === "workspace.close") {
          await closeGate.promise;
          return { id: request.id, result: { closed: true } };
        }
        throw new Error(`Unexpected request: ${request.method}`);
      },
    };
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });
    await sessions.run(workspace, async () => undefined);

    const closing = sessions.closeAll();
    await vi.waitFor(() => {
      expect(
        requests.filter((request) => request.method === "workspace.close"),
      ).toHaveLength(1);
    });
    const lateRun = sessions.run(workspace, async () => "unexpected");
    closeGate.resolve();
    await closing;

    await expect(lateRun).rejects.toThrow(
      "Rust engine workspace sessions are closed.",
    );
    expect(openCount).toBe(1);
  });

  it("bounds every workspace open with a daemon deadline", async () => {
    const requests: Request[] = [];
    const client = {
      close() {},
      async sendRequest(request: Request): Promise<Response> {
        requests.push(request);
        if (request.method === "workspace.open") {
          return { id: request.id, result: { workspace: "handle-1" } };
        }
        throw new Error(`Unexpected request: ${request.method}`);
      },
    };
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });

    await sessions.run(workspace, async () => undefined);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.deadlineMs).toBe(WORKSPACE_OPEN_DEADLINE_MS);
  });

  it("retries an initial workspace open failure before running the operation", async () => {
    let openAttempts = 0;
    const client = {
      close() {},
      async sendRequest(request: Request): Promise<Response> {
        if (request.method !== "workspace.open") {
          throw new Error(`Unexpected request: ${request.method}`);
        }
        openAttempts += 1;
        if (openAttempts === 1) {
          throw new Error("transient workspace open failure");
        }
        return { id: request.id, result: { workspace: "handle-2" } };
      },
    };
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });
    const operation = vi.fn(async () => "opened");

    await expect(sessions.run(workspace, operation)).resolves.toBe("opened");
    expect(openAttempts).toBe(2);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("paces open retries while the daemon lifecycle is relaunching", async () => {
    const client = {
      close() {},
      async sendRequest(request: Request): Promise<Response> {
        if (request.method !== "workspace.open") {
          throw new Error(`Unexpected request: ${request.method}`);
        }
        return { id: request.id, result: { workspace: "handle-relaunched" } };
      },
    };
    let daemonAvailable = false;
    let clientLookups = 0;
    const delays: number[] = [];
    const sessions = new EngineWorkspaceSessions(
      {
        currentClient: () => {
          clientLookups += 1;
          if (!daemonAvailable) {
            throw new EngineDaemonUnavailableError(
              "Rust engine is relaunching.",
            );
          }
          return client;
        },
      },
      {
        sleep: async (delayMs) => {
          delays.push(delayMs);
          daemonAvailable = true;
        },
      },
    );

    await expect(
      sessions.run(
        workspace,
        async ({ workspace: handle }) => handle,
        { retryTransportErrors: true },
      ),
    ).resolves.toBe("handle-relaunched");
    expect(delays).toEqual([100]);
    expect(clientLookups).toBeGreaterThanOrEqual(3);
  });

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
