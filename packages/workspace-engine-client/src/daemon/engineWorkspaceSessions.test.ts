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
import { DaemonRefusalError } from "../live/daemonLiveAdapter";
import type { Request } from "../ydoc/generated/Request";
import type { Response } from "../ydoc/generated/Response";
import type { WorkspaceHandle } from "../ydoc/generated/WorkspaceHandle";
import {
  EngineDaemonUnavailableError,
  type EngineDaemonClient,
} from "./engineDaemonLifecycle";
import {
  EngineWorkspaceRebindError,
  EngineWorkspaceRetryDeadlineError,
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
      ).rejects.toThrow(
        relativeLink === ".dohc"
          ? "dohc could not open this workspace's .dohc folder. A link is at .dohc, which must be a real folder. Remove or rename that link. Then retry."
          : "dohc could not start the engine for this workspace. A link is at .dohc/engine, which must be a real folder. Remove or rename that link. Then retry.",
      );
      expect(requests).toBe(0);
      await expect(
        readFile(join(outside, "SHADOW_CLONE"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  // The squat shapes an errno allowlist gets wrong. mkdir raises EEXIST for a
  // file and ENOENT for a dangling link, so the old `isAlreadyExists` check
  // rethrew the dangling case as a bare errno and answered the file case with
  // "must not be a symlink" -- about a plain file. Presence decides now, and
  // both name what is actually there (#612).
  it.each([
    [
      "a file",
      ".dohc",
      async (rootPath: string) => {
        await writeFile(join(rootPath, ".dohc"), "squatting");
      },
      "dohc could not open this workspace's .dohc folder. A file is at .dohc, which must be a real folder. Remove or rename that file. Then retry.",
    ],
    [
      "a dangling link",
      ".dohc",
      async (rootPath: string) => {
        // Measured on this host: a plain mkdir answers EEXIST for a dangling
        // link of either kind, while mkdir{recursive} answers ENOENT. So the
        // errno an allowlist would have to know differs by CALL, not only by
        // platform -- which is the argument for keying on presence instead.
        await symlink(join(rootPath, "nowhere"), join(rootPath, ".dohc"), "dir");
      },
      "dohc could not open this workspace's .dohc folder. A link is at .dohc, which must be a real folder. Remove or rename that link. Then retry.",
    ],
    [
      "a file",
      ".dohc/engine",
      async (rootPath: string) => {
        await mkdir(join(rootPath, ".dohc"));
        await writeFile(join(rootPath, ".dohc", "engine"), "squatting");
      },
      "dohc could not start the engine for this workspace. A file is at .dohc/engine, which must be a real folder. Remove or rename that file. Then retry.",
    ],
  ])(
    "names %s squatting %s, never a raw errno",
    async (_shape, _path, squat, refusal) => {
      const rootPath = await tempRoot();
      await squat(rootPath);
      let requests = 0;
      const client: EngineDaemonClient = {
        close: () => undefined,
        async sendRequest(request) {
          requests += 1;
          return { id: request.id, result: { workspace: "workspace-handle" } };
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
      ).rejects.toThrow(refusal);
      // Nothing opened, and the refusal never printed the absolute host path.
      expect(requests).toBe(0);
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
    ).rejects.toThrow(
      "dohc could not open this workspace's .dohc folder. A link is at .dohc, which must be a real folder. Remove or rename that link. Then retry.",
    );
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

  // #564: the retry deadline bounds how long one run may keep WAITING on
  // transport recovery. It gates retries only — a healthy first attempt is
  // never rejected, however small the deadline.
  describe("retryDeadlineMs", () => {
    it("never rejects a healthy open, however small the deadline", async () => {
      const workspace = await tempWorkspace("workspace-healthy-deadline");
      const client = new MockClient("handle-healthy");
      const sessions = new EngineWorkspaceSessions({
        currentClient: () => client,
      });

      await expect(
        sessions.run(workspace, async (binding) => binding.workspace, {
          retryTransportErrors: true,
          retryDeadlineMs: 1,
        }),
      ).resolves.toBe("handle-healthy");
    });

    it("stops retrying transport errors once the deadline is spent", async () => {
      const workspace = await tempWorkspace("workspace-deadline");
      const client = new MockClient("handle-deadline");
      // Injected clock: each failed attempt costs 2,500 ms (the shape of a
      // real workspace-open deadline plus overhead). Attempts 1 and 2 are
      // inside the 6,000 ms budget; the check after attempt 3 is not.
      let nowMs = 0;
      let attempts = 0;
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowMs, sleep: async () => {} },
      );

      const outcome = await sessions
        .run(
          workspace,
          async () => {
            attempts += 1;
            nowMs += 2_500;
            throw { code: "transport-error" };
          },
          { retryTransportErrors: true, retryDeadlineMs: 6_000 },
        )
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      // MUTATION: drop the deadline check -> all six attempts run and the
      // rejection is EngineWorkspaceRebindError instead.
      expect(attempts).toBe(3);
      const message = (outcome as Error).message;
      // The rejection names the constraint, the configured limit with its
      // unit, and the observed wait (AGENTS.md: show agents the limits they
      // hit).
      expect(message).toContain("retryDeadlineMs limit of 6000ms");
      expect(message).toContain("waited 7500ms across 3 attempts");
      expect((outcome as Error).cause).toMatchObject({
        code: "transport-error",
      });
    });

    it("bounds a daemon-down OPEN the same way", async () => {
      const workspace = await tempWorkspace("workspace-open-deadline");
      let nowMs = 0;
      let clientReads = 0;
      const sessions = new EngineWorkspaceSessions(
        {
          currentClient: () => {
            clientReads += 1;
            nowMs += 2_500;
            throw new EngineDaemonUnavailableError("daemon down");
          },
        },
        { now: () => nowMs, sleep: async () => {} },
      );

      const outcome = await sessions
        .run(workspace, async () => "unreachable", {
          retryTransportErrors: true,
          retryDeadlineMs: 6_000,
        })
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      expect(clientReads).toBe(3);
    });

    it("does not start attempt N+1 on a budget the backoff spent", async () => {
      // codex round 2: the deadline was checked only BEFORE the backoff. An
      // attempt ending just inside it could ride the backoff over the line
      // and still start a fresh 2 s open on a spent budget (~8 s observed on
      // a 6 s contract). The clock is re-checked after the backoff.
      const workspace = await tempWorkspace("workspace-overshoot");
      const client = new MockClient("handle-overshoot");
      let nowMs = 0;
      let attempts = 0;
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        {
          now: () => nowMs,
          sleep: async () => {
            nowMs += 300;
          },
        },
      );

      const outcome = await sessions
        .run(
          workspace,
          async () => {
            attempts += 1;
            nowMs += 4_900;
            throw { code: "transport-error" };
          },
          { retryTransportErrors: true, retryDeadlineMs: 5_000 },
        )
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      // MUTATION: drop the post-backoff re-check -> a second attempt starts
      // (4,900 ms was inside the budget when the backoff was armed).
      expect(attempts).toBe(1);
    });

    it("bounds the client-churn open ladder the same way", async () => {
      // codex round 2: churning client generations held a caller through six
      // full opens — the ladder consulted neither the deadline nor shutdown.
      const workspace = await tempWorkspace("workspace-churn-deadline");
      const first = new MockClient("handle-churn-a");
      const second = new MockClient("handle-churn-b");
      let nowMs = 0;
      let reads = 0;
      const sessions = new EngineWorkspaceSessions(
        {
          currentClient: () => {
            reads += 1;
            nowMs += 2_500;
            return reads % 2 === 1 ? first : second;
          },
        },
        { now: () => nowMs, sleep: async () => {} },
      );

      const outcome = await sessions
        .run(workspace, async () => "unreachable", {
          retryDeadlineMs: 6_000,
        })
        .catch((error: unknown) => error);

      // MUTATION: drop the deadline from the churn ladder -> the full
      // six-open churn runs and rejects with EngineWorkspaceRebindError.
      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      expect(reads).toBeLessThanOrEqual(4);
    });

    it("bounds an afterReconnect storm, which takes no backoff at all", async () => {
      // codex round 3: an `afterReconnect` retry skipped the whole waiting
      // block, so it consulted neither gate — six attempts, each paying a
      // 2 s workspace.open, holding the capture chain for ~12 s.
      const workspace = await tempWorkspace("workspace-reconnect-storm");
      const client = new MockClient("handle-reconnect");
      let nowMs = 0;
      let attempts = 0;
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowMs, sleep: async () => {} },
      );

      const outcome = await sessions
        .run(
          workspace,
          async () => {
            attempts += 1;
            nowMs += 2_000;
            throw new DaemonRefusalError(
              {
                code: "CONFLICT",
                message: "workspace moved",
                retry: "afterReconnect",
              },
              undefined,
            );
          },
          { retryTransportErrors: true, retryDeadlineMs: 5_000 },
        )
        .catch((error: unknown) => error);

      // MUTATION: gate only the transport branch -> six attempts and a
      // DaemonRefusalError instead.
      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      expect(attempts).toBe(3);
    });

    it("rejects an invalid deadline instead of quietly voiding it", async () => {
      const workspace = await tempWorkspace("workspace-bad-deadline");
      const client = new MockClient("handle-bad-deadline");
      const sessions = new EngineWorkspaceSessions({
        currentClient: () => client,
      });

      await expect(
        sessions.run(workspace, async () => "unreachable", {
          retryDeadlineMs: 0,
        }),
      ).rejects.toThrow(TypeError);
    });
  });

  // #564: app quit. Retry waiting ends NOW — an armed backoff resolves, the
  // failure that caused it surfaces, and the capture chain behind the run is
  // free within one attempt instead of the full ladder.
  describe("beginShutdown", () => {
    it("cancels an armed backoff and surfaces the transport failure", async () => {
      const workspace = await tempWorkspace("workspace-shutdown-sleep");
      const client = new MockClient("handle-shutdown-sleep");
      let sleeping: (() => void) | null = null;
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        {
          // Never resolves on its own: without the cancel race, this run
          // waits forever and so would the quit behind it.
          sleep: () =>
            new Promise<void>((resolveSleep) => {
              sleeping = () => resolveSleep();
            }),
        },
      );

      const run = sessions.run(
        workspace,
        async () => {
          throw { code: "transport-error" };
        },
        { retryTransportErrors: true },
      );
      await vi.waitFor(() => {
        expect(sleeping).not.toBeNull();
      });
      sessions.beginShutdown();
      await expect(run).rejects.toMatchObject({ code: "transport-error" });
    });

    it("exits the client-churn open ladder", async () => {
      // codex round 2: beginShutdown resolved the churn ladder's sleep, but
      // the loop continued without checking — churning generations could
      // hold the chain into the forced-exit timer.
      const workspace = await tempWorkspace("workspace-churn-shutdown");
      const first = new MockClient("handle-churn-c");
      const second = new MockClient("handle-churn-d");
      let reads = 0;
      let sleeping: (() => void) | null = null;
      const sessions = new EngineWorkspaceSessions(
        {
          currentClient: () => {
            reads += 1;
            return reads % 2 === 1 ? first : second;
          },
        },
        {
          sleep: () =>
            new Promise<void>((resolveSleep) => {
              sleeping = () => resolveSleep();
            }),
        },
      );

      const run = sessions.run(workspace, async () => "unreachable");
      await vi.waitFor(() => {
        expect(sleeping).not.toBeNull();
      });
      sessions.beginShutdown();
      await expect(run).rejects.toBeInstanceOf(EngineWorkspaceRebindError);
    });

    it("makes a later afterReconnect refusal final too", async () => {
      // Same gap from the shutdown side: an afterReconnect storm at quit
      // never consulted `shuttingDown`, so it kept reopening the workspace
      // while the teardown waited on the chain behind it.
      const workspace = await tempWorkspace("workspace-reconnect-shutdown");
      const client = new MockClient("handle-reconnect-quit");
      let attempts = 0;
      const sessions = new EngineWorkspaceSessions({
        currentClient: () => client,
      });
      sessions.beginShutdown();

      await expect(
        sessions.run(workspace, async () => {
          attempts += 1;
          throw new DaemonRefusalError(
            {
              code: "CONFLICT",
              message: "workspace moved",
              retry: "afterReconnect",
            },
            undefined,
          );
        }, { retryTransportErrors: true }),
      ).rejects.toBeInstanceOf(DaemonRefusalError);
      // MUTATION: gate only the transport branch -> the full six-attempt
      // ladder runs while the quit teardown waits behind it.
      expect(attempts).toBe(1);
    });

    it("makes a later transport failure final instead of retried", async () => {
      const workspace = await tempWorkspace("workspace-shutdown-final");
      const client = new MockClient("handle-shutdown-final");
      let attempts = 0;
      const sleep = vi.fn(async () => {});
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { sleep },
      );
      sessions.beginShutdown();

      await expect(
        sessions.run(
          workspace,
          async () => {
            attempts += 1;
            throw { code: "transport-error" };
          },
          { retryTransportErrors: true },
        ),
      ).rejects.toMatchObject({ code: "transport-error" });
      // MUTATION: drop the shutdown gate -> six attempts with backoff.
      expect(attempts).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
    });
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
