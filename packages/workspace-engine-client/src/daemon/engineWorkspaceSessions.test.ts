import { readFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request } from "../ydoc/generated/Request";
import type { Response } from "../ydoc/generated/Response";
import type { WorkspaceHandle } from "../ydoc/generated/WorkspaceHandle";
import {
  EngineDaemonUnavailableError,
  type EngineDaemonClient,
} from "./engineDaemonLifecycle";
import {
  EngineWorkspaceRebindError,
  EngineWorkspaceSessions,
  WORKSPACE_OPEN_DEADLINE_MS,
} from "./engineWorkspaceSessions";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(
      async (root) => await rm(root, { recursive: true, force: true }),
    ),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-engine-sessions-"));
  roots.push(root);
  return root;
}

async function tempWorkspace(workspaceId = "workspace-sessions-test") {
  return { workspaceId, rootPath: await tempRoot() };
}

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

describe("EngineWorkspaceSessions", () => {
  it("prepares an ordinary workspace before opening it in the daemon", async () => {
    const rootPath = await tempRoot();
    let opened = false;
    const client: EngineDaemonClient = {
      close: () => undefined,
      async sendRequest(request) {
        const marker = await readFile(
          join(rootPath, ".dohc", "engine", "SHADOW_CLONE"),
          "utf8",
        );
        expect(marker).toMatch(/^[0-9a-f]{64}$/);
        opened = true;
        return {
          id: request.id,
          result: { workspace: "workspace-handle" },
        };
      },
    };
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });

    await expect(
      sessions.run(
        { workspaceId: "workspace", rootPath },
        async (binding) => binding.workspace,
      ),
    ).resolves.toBe("workspace-handle");
    expect(opened).toBe(true);
  });

  it("fails closed on a malformed existing shadow marker", async () => {
    const rootPath = await tempRoot();
    const markerDirectory = join(rootPath, ".dohc", "engine");
    await mkdir(markerDirectory, { recursive: true });
    await writeFile(join(markerDirectory, "SHADOW_CLONE"), "bad", "utf8");
    let requests = 0;
    const client: EngineDaemonClient = {
      close: () => undefined,
      async sendRequest(request) {
        requests += 1;
        return {
          id: request.id,
          result: { workspace: "workspace-handle" },
        };
      },
    };
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });

    await expect(
      sessions.run(
        { workspaceId: "workspace", rootPath },
        async (binding) => binding.workspace,
      ),
    ).rejects.toThrow("shadow marker is invalid");
    expect(requests).toBe(0);
  });

  it("invalidates but does not replay a mutation after a transport failure", async () => {
    const rootPath = await tempRoot();
    let opens = 0;
    const client: EngineDaemonClient = {
      close: () => undefined,
      async sendRequest(request) {
        opens += 1;
        return {
          id: request.id,
          result: { workspace: `workspace-handle-${opens}` },
        };
      },
    };
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });
    let mutationAttempts = 0;

    await expect(
      sessions.run(
        { workspaceId: "workspace", rootPath },
        async () => {
          mutationAttempts += 1;
          throw { code: "transport-error" };
        },
      ),
    ).rejects.toMatchObject({ code: "transport-error" });
    expect(mutationAttempts).toBe(1);

    await expect(
      sessions.run(
        { workspaceId: "workspace", rootPath },
        async (binding) => binding.workspace,
      ),
    ).resolves.toBe("workspace-handle-2");
    expect(opens).toBe(2);
  });

  it("retries an initial daemon-unavailable open when reconnect retries were requested", async () => {
    const rootPath = await tempRoot();
    const client: EngineDaemonClient = {
      close: () => undefined,
      async sendRequest(request) {
        return {
          id: request.id,
          result: { workspace: "workspace-after-restart" },
        };
      },
    };
    let available = false;
    const sleeps: number[] = [];
    const sessions = new EngineWorkspaceSessions(
      {
        currentClient: () => {
          if (!available) {
            throw new EngineDaemonUnavailableError("daemon restarting");
          }
          return client;
        },
      },
      {
        transportRebindAttempts: 3,
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
          available = true;
        },
      },
    );

    const outcome = await sessions
      .run(
        { workspaceId: "workspace", rootPath },
        async (binding) => binding.workspace,
        { retryTransportErrors: true },
      )
      .catch((error: unknown) => error);

    // MUTATION: require rebindStarted in the open-error retry branch. The
    // first currentClient() failure is returned here instead of the handle.
    expect(outcome).toBe("workspace-after-restart");
    expect(sleeps).toEqual([100]);
  });

  it.each([".dohc", ".dohc/engine"])(
    "refuses a symlinked %s engine ancestor",
    async (relativeLink) => {
      const rootPath = await tempRoot();
      const outside = await tempRoot();
      const segments = relativeLink.split("/");
      if (segments.length > 1) {
        await mkdir(join(rootPath, segments[0]!));
      }
      await symlink(
        outside,
        join(rootPath, ...segments),
        process.platform === "win32" ? "junction" : "dir",
      );
      let requests = 0;
      const client: EngineDaemonClient = {
        close: () => undefined,
        async sendRequest(request) {
          requests += 1;
          return {
            id: request.id,
            result: { workspace: "workspace-handle" },
          };
        },
      };
      const sessions = new EngineWorkspaceSessions({
        currentClient: () => client,
      });

      await expect(
        sessions.run(
          { workspaceId: "workspace", rootPath },
          async (binding) => binding.workspace,
        ),
      ).rejects.toThrow("must not be a symlink");
      expect(requests).toBe(0);
      await expect(
        readFile(join(outside, "SHADOW_CLONE"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("revalidates prepared directories before a daemon-generation reopen", async () => {
    const rootPath = await tempRoot();
    const outside = await tempRoot();
    let generation = 1;
    let opens = 0;
    const clientForGeneration = (
      clientGeneration: number,
    ): EngineDaemonClient => ({
      close: () => undefined,
      async sendRequest(request) {
        if (request.method === "workspace.close") {
          return { id: request.id, result: { closed: true } };
        }
        opens += 1;
        return {
          id: request.id,
          result: { workspace: `workspace-handle-${clientGeneration}` },
        };
      },
    });
    let client = clientForGeneration(generation);
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });

    await sessions.run(
      { workspaceId: "workspace", rootPath },
      async (binding) => binding.workspace,
    );
    await rm(join(rootPath, ".dohc"), { recursive: true, force: true });
    await symlink(
      outside,
      join(rootPath, ".dohc"),
      process.platform === "win32" ? "junction" : "dir",
    );
    generation += 1;
    client = clientForGeneration(generation);

    await expect(
      sessions.run(
        { workspaceId: "workspace", rootPath },
        async (binding) => binding.workspace,
      ),
    ).rejects.toThrow("must not be a symlink");
    expect(opens).toBe(1);
  });

  it("mutation proof: restores capture authorship in every generation's open", async () => {
    const rootPath = await tempRoot();
    const requestsByGeneration: Array<
      Array<{ method: string; params: unknown }>
    > = [[], []];
    let generation = 0;
    const clients = requestsByGeneration.map(
      (requests, index): EngineDaemonClient => ({
        close: () => undefined,
        async sendRequest(request) {
          requests.push({ method: request.method, params: request.params });
          return {
            id: request.id,
            result: { workspace: `workspace-handle-${index + 1}` },
          };
        },
      }),
    );
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => clients[generation]!,
    });
    const author = {
      kind: "agent" as const,
      agentId: "agent",
      onBehalfOf: "local",
      agentRunId: "run",
    };
    sessions.rememberCaptureAuthor("workspace", author);

    await sessions.run(
      { workspaceId: "workspace", rootPath },
      async (binding) => binding.workspace,
    );
    generation = 1;
    await sessions.run(
      { workspaceId: "workspace", rootPath },
      async (binding) => binding.workspace,
    );

    expect(requestsByGeneration).toEqual([
      [
        {
          method: "workspace.open",
          params: {
            rootDir: rootPath,
            workspaceId: "workspace",
            recoverRunningDispatches: false,
            captureAuthor: author,
          },
        },
      ],
      [
        {
          method: "workspace.open",
          params: {
            rootDir: rootPath,
            workspaceId: "workspace",
            recoverRunningDispatches: false,
            captureAuthor: author,
          },
        },
      ],
    ]);
  });

  it("drains active runs and blocks replacement opens until closeWorkspace finishes", async () => {
    const workspace = await tempWorkspace();
    const operationGate = deferred<void>();
    const closeGate = deferred<void>();
    const requests: Request[] = [];
    let openCount = 0;
    const client: EngineDaemonClient = {
      close() {},
      async sendRequest(request) {
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
    const workspace = await tempWorkspace();
    const closeGate = deferred<void>();
    const requests: Request[] = [];
    let openCount = 0;
    const client: EngineDaemonClient = {
      close() {},
      async sendRequest(request) {
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
    const workspace = await tempWorkspace();
    const requests: Request[] = [];
    const client: EngineDaemonClient = {
      close() {},
      async sendRequest(request) {
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
    // Pinned literally as well as against the constant. Comparing only against
    // the constant lets both sides move together, so a changed default would
    // still pass — and this default IS the product guarantee.
    expect(requests[0]?.deadlineMs).toBe(2_000);
  });

  it("lets a caller widen the workspace open deadline without moving the default", async () => {
    const workspace = await tempWorkspace();
    const requests: Request[] = [];
    const client: EngineDaemonClient = {
      close() {},
      async sendRequest(request) {
        requests.push(request);
        if (request.method === "workspace.open") {
          return { id: request.id, result: { workspace: "handle-1" } };
        }
        throw new Error(`Unexpected request: ${request.method}`);
      },
    };
    const sessions = new EngineWorkspaceSessions(
      { currentClient: () => client },
      { workspaceOpenDeadlineMs: 30_000 },
    );

    await sessions.run(workspace, async () => undefined);

    expect(requests[0]?.deadlineMs).toBe(30_000);
    // The product guarantee is the constant, not whatever a caller passed.
    expect(WORKSPACE_OPEN_DEADLINE_MS).toBe(2_000);
  });

  it.each([0, -1, 12.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects %s as a workspace open deadline instead of silently substituting one",
    (deadline) => {
      // `??` accepts all of these. An exported option taking 0 or NaN would
      // either fail every workspace.open or void the deadline guarantee, and a
      // caller that clamped silently would believe it had widened a deadline it
      // had not.
      // The constructor rejects before it ever consults the client, so a stub
      // that throws on use is enough — and proves nothing was sent.
      const client: EngineDaemonClient = {
        close() {},
        async sendRequest() {
          throw new Error("must not be reached: construction should have thrown");
        },
      };
      expect(
        () =>
          new EngineWorkspaceSessions(
            { currentClient: () => client },
            { workspaceOpenDeadlineMs: deadline },
          ),
      ).toThrow(/positive integer/);
    },
  );

  it("retries an initial workspace open failure before running the operation", async () => {
    const workspace = await tempWorkspace();
    let openAttempts = 0;
    const client: EngineDaemonClient = {
      close() {},
      async sendRequest(request) {
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
    const workspace = await tempWorkspace();
    const client: EngineDaemonClient = {
      close() {},
      async sendRequest(request) {
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
    const workspace = await tempWorkspace("workspace-flapping");
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
      sessions.run(workspace, async () => "unreachable"),
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
