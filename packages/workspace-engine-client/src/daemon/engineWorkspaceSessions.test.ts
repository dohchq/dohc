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
import {
  DaemonRefusalError,
  type DaemonErrorCode,
} from "../live/daemonLiveAdapter";
import type { Request } from "../ydoc/generated/Request";
import type { Response } from "../ydoc/generated/Response";
import type { WorkspaceHandle } from "../ydoc/generated/WorkspaceHandle";
import { EngineClientError } from "./engineClient";
import {
  EngineDaemonUnavailableError,
  type EngineDaemonClient,
} from "./engineDaemonLifecycle";
import {
  EngineWorkspaceRebindError,
  EngineWorkspaceRetryDeadlineError,
  EngineWorkspaceSessions,
  EngineWorkspaceShuttingDownError,
  isEngineWorkspaceOpenRefusedError,
  WORKSPACE_OPEN_DEADLINE_MS,
} from "./engineWorkspaceSessions";

// What the real client throws when the daemon's transport drops
// (`engineClient.ts` — "transport-error"). The retry gate duck-types on
// `.code`, so a bare `{ code: "transport-error" }` also passes it; using the
// real class keeps the ladder under test from depending on a value that is
// looser than anything the transport can produce.
function transportFailure(): EngineClientError {
  return new EngineClientError("transport-error", "Engine transport failed.");
}

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

// The daemon's retryable refusals, which seven ladder tests below raise. The
// disposition is the part under test in every one of them, so it stays at the
// call site while the envelope shape does not.
function daemonRefusal(
  code: DaemonErrorCode,
  message: string,
  retry: "afterReconnect" | "afterBackoff" | "immediate",
): DaemonRefusalError {
  return new DaemonRefusalError({ code, message, retry }, undefined);
}

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
          throw transportFailure();
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
        sessions.withRetryBudget(1, async () =>
          await sessions.run(workspace, async (binding) => binding.workspace, {
            retryTransportErrors: true,
          }),
        ),
      ).resolves.toBe("handle-healthy");
    });

    it("stops retrying transport errors once the deadline is spent", async () => {
      const workspace = await tempWorkspace("workspace-deadline");
      const client = new MockClient("handle-deadline");
      // Injected clock: each failed attempt costs 2,500 ms (the shape of a
      // real workspace-open deadline plus overhead). The budget's clock
      // starts at the FIRST failure (t=2,500), so attempts 2 and 3 are inside
      // the 6,000 ms window and the check after attempt 4 is not.
      let nowMs = 0;
      let attempts = 0;
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowMs, sleep: async () => {} },
      );

      const outcome = await sessions
        .withRetryBudget(6_000, async () =>
          await sessions.run(
            workspace,
            async () => {
              attempts += 1;
              nowMs += 2_500;
              throw transportFailure();
            },
            { retryTransportErrors: true },
          ),
        )
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      // MUTATION: drop the deadline check -> all six attempts run and the
      // rejection is EngineWorkspaceRebindError instead.
      expect(attempts).toBe(4);
      const message = (outcome as Error).message;
      // The rejection names the constraint, the configured limit with its
      // unit, and the observed wait (AGENTS.md: show agents the limits they
      // hit).
      expect(message).toContain("withRetryBudget budgetMs limit of 6000ms");
      // The two durations differ by the first attempt, which the budget
      // deliberately does not charge.
      expect(message).toContain("7500ms since the first failure");
      expect(message).toContain("waited 10000ms in total, across 4 failed attempts");
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
        .withRetryBudget(6_000, async () =>
          await sessions.run(workspace, async () => "unreachable", {
            retryTransportErrors: true,
          }),
        )
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      // Four, not six: the first failure starts the clock and the fourth
      // open finds it spent.
      expect(clientReads).toBe(4);
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
          // The wait costs what it says it costs, so a backoff can carry the
          // budget over the line — which is the whole case here.
          sleep: async (delayMs) => {
            nowMs += delayMs;
          },
        },
      );

      // Tuned so the BACKOFF is what spends it: attempt 2 ends at 2,550 ms of
      // recovery (inside 2,600) and the 200 ms backoff after it ends at
      // 2,750 ms (outside).
      const outcome = await sessions
        .withRetryBudget(2_600, async () =>
          await sessions.run(
            workspace,
            async () => {
              attempts += 1;
              nowMs += 2_450;
              throw transportFailure();
            },
            { retryTransportErrors: true },
          ),
        )
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      // MUTATION: drop the post-backoff re-check -> a third attempt starts on
      // a budget the backoff had already spent.
      expect(attempts).toBe(2);
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
        .withRetryBudget(6_000, async () =>
          await sessions.run(workspace, async () => "unreachable"),
        )
        .catch((error: unknown) => error);

      // MUTATION: drop the deadline from the churn ladder -> the full
      // six-open churn runs (12 reads) and rejects with
      // EngineWorkspaceRebindError.
      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      expect(reads).toBe(6);
    });

    it("bounds an afterReconnect storm, which takes no backoff at all", async () => {
      // codex round 3: an `afterReconnect` retry skipped the whole waiting
      // block, so it consulted neither gate — six attempts, each paying a
      // 2 s workspace.open, holding the capture chain for ~12 s.
      const workspace = await tempWorkspace("workspace-reconnect-storm");
      const client = new MockClient("handle-reconnect");
      let nowMs = 0;
      let attempts = 0;
      // A spy, not a bare stub: this test's NAME asserts "no backoff at all",
      // and with an unobservable stub it could not tell a waiting ladder from
      // a non-waiting one (review round 8).
      const sleep = vi.fn(async () => {});
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowMs, sleep },
      );

      const outcome = await sessions
        .withRetryBudget(5_000, async () =>
          await sessions.run(
            workspace,
            async () => {
              attempts += 1;
              nowMs += 2_000;
              throw daemonRefusal("CONFLICT", "workspace moved", "afterReconnect");
            },
            { retryTransportErrors: true },
          ),
        )
        .catch((error: unknown) => error);

      // MUTATION: gate only the transport branch -> six attempts and a
      // DaemonRefusalError instead.
      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      expect(attempts).toBe(4);
      // MUTATION: make `settleAttempt` back off unconditionally -> an
      // afterReconnect retry waits, which this test's name says it never does.
      expect(sleep).not.toHaveBeenCalled();
    });

    it("bounds an OPEN that keeps refusing with afterReconnect", async () => {
      // codex round 4: the open ladder's gate only recognised transport and
      // daemon-unavailable errors, so a `workspace.open` refusing with the
      // afterReconnect disposition — which the shipping daemon does — ran
      // six full opens past a spent budget.
      const workspace = await tempWorkspace("workspace-open-reconnect");
      let nowMs = 0;
      let opens = 0;
      const client: EngineDaemonClient = {
        close: () => undefined,
        async sendRequest() {
          opens += 1;
          nowMs += 2_000;
          throw daemonRefusal("CONFLICT", "workspace handle is stale", "afterReconnect");
        },
      };
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowMs, sleep: async () => {} },
      );

      const outcome = await sessions
        .withRetryBudget(5_000, async () =>
          await sessions.run(workspace, async () => "unreachable", {
            retryTransportErrors: true,
          }),
        )
        .catch((error: unknown) => error);

      // MUTATION: drop requiresReconnect from daemonMayBeRelaunching -> the
      // ladder runs every attempt and rejects with the refusal instead.
      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      expect(opens).toBe(4);
    });

    it("calls an exhausted ladder past its budget a DEADLINE, not a transport failure", async () => {
      // codex round 5: the LAST allowed attempt can start inside the budget
      // and finish outside it. That branch threw the transport error, and
      // main maps only EngineWorkspaceRetryDeadlineError to `engineMayHoldDocument` —
      // so an exhausted ladder downgraded an engine-owned document to the
      // writable plain editor. Same failure as the unbounded-task blocker,
      // through a different door.
      const workspace = await tempWorkspace("workspace-exhausted");
      const client = new MockClient("handle-exhausted");
      let nowMs = 0;
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowMs, sleep: async () => {}, transportRebindAttempts: 2 },
      );

      const outcome = await sessions
        .withRetryBudget(3_000, async () =>
          await sessions.run(
            workspace,
            async () => {
              // The last allowed attempt STARTS inside the budget (0 ms of
              // recovery spent) and ends outside it, which is the case this
              // pins.
              nowMs += 3_000;
              throw transportFailure();
            },
            { retryTransportErrors: true },
          ),
        )
        .catch((error: unknown) => error);

      // MUTATION: throw the transport error at the terminal attempt -> this
      // is `{ code: "transport-error" }` and the document downgrades.
      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
    });

    it("retries any method the daemon refuses with afterBackoff, once, after waiting", async () => {
      // #658. The engine answers `afterBackoff` for a busy store on EVERY
      // method, but only the open ladder and the Y.Doc surfaces collected on
      // it — so a version or chat call reported the kebab-case wire message
      // to the user for a condition that clears by itself. That is exactly
      // the contract #595 round 14 refused to ship: a retry nobody performs.
      //
      // Safe for non-idempotent methods too, which is why it can live in the
      // generic wrapper: a busy store is raised by `BEGIN IMMEDIATE` or by
      // the commit, so nothing was applied and a second attempt cannot
      // duplicate it.
      //
      // MUTATION: drop `retryAfterBackoff` from `retryable` -> one attempt
      // and the refusal reaches the caller.
      const workspace = await tempWorkspace("workspace-run-backoff");
      const sleep = vi.fn(async () => undefined);
      const client = new MockClient("handle-run-backoff");
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { sleep },
      );

      let attempts = 0;
      const result = await sessions.run(workspace, async () => {
        attempts += 1;
        if (attempts === 1) {
          throw daemonRefusal("OVERLOADED", "engine-store-busy", "afterBackoff");
        }
        return "landed";
      });

      expect(result).toBe("landed");
      expect(attempts).toBe(2);
      // MUTATION: pass only `retryAfterTransport` as `backoff` -> the retry
      // is immediate, which is not what `afterBackoff` asks for.
      expect(sleep).toHaveBeenCalled();
    });

    it("bounds an OPEN the daemon keeps refusing with afterBackoff", async () => {
      // Review round 8: `afterBackoff` is the daemon's own "retry, but wait" —
      // it raises it for DeadlineExceeded and Overloaded on any method,
      // including the `workspace.open` this file deadlines at 2 s. The gate
      // recognised only transport, daemon-unavailable and afterReconnect, so
      // the refusal took a bare `continue`: six immediate opens over ~12 s
      // against a 5 s deadline, rejecting with the refusal (which main does
      // NOT map to engineMayHoldDocument) and applying no backoff at all to an
      // overload the daemon had just declared.
      const workspace = await tempWorkspace("workspace-open-backoff");
      let nowMs = 0;
      let opens = 0;
      const delays: number[] = [];
      const client: EngineDaemonClient = {
        close: () => undefined,
        async sendRequest() {
          opens += 1;
          nowMs += 2_000;
          throw daemonRefusal("DEADLINE_EXCEEDED", "workspace open exceeded its deadline", "afterBackoff");
        },
      };
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        {
          now: () => nowMs,
          sleep: async (delayMs) => {
            delays.push(delayMs);
          },
        },
      );

      const outcome = await sessions
        .withRetryBudget(4_000, async () =>
          await sessions.run(workspace, async () => "unreachable", {
            retryTransportErrors: true,
          }),
        )
        .catch((error: unknown) => error);

      // MUTATION: restore the bare `continue` for errors outside
      // daemonMayBeRelaunching -> six opens and a DaemonRefusalError, so the
      // surface downgrades to the writable plain editor.
      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      expect(opens).toBe(3);
      // MUTATION: drop requiresBackoff from the backoff decision -> the ladder
      // re-opens immediately and amplifies the overload the daemon declared.
      expect(delays).toEqual([100, 200]);
    });

    it("gates an OPEN that keeps failing with an ordinary error, without waiting", async () => {
      // Delta review D1: a PARTIAL revert — restoring the bare `continue` only
      // for errors that are neither `daemonMayBeRelaunching` nor
      // `requiresBackoff` — passed the whole suite, so this half of the fix
      // was unpinned. Reachable producers are ordinary: `prepareWorkspace`
      // guard and fs errno failures, `DaemonProtocolError`, and
      // `EngineClientError` with connect-timeout/closed/handshake-incomplete.
      // None is a transport error or a refusal, so all of them land here.
      const workspace = await tempWorkspace("workspace-open-plain-error");
      let nowMs = 0;
      let opens = 0;
      const delays: number[] = [];
      const client: EngineDaemonClient = {
        close: () => undefined,
        async sendRequest() {
          opens += 1;
          nowMs += 2_000;
          throw new Error("workspace open failed");
        },
      };
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        {
          now: () => nowMs,
          sleep: async (delayMs) => {
            delays.push(delayMs);
          },
        },
      );

      const outcome = await sessions
        .withRetryBudget(4_000, async () =>
          await sessions.run(workspace, async () => "unreachable", {
            retryTransportErrors: true,
          }),
        )
        .catch((error: unknown) => error);

      // MUTATION: restore the bare `continue` for errors outside
      // daemonMayBeRelaunching -> six opens over 12,000 ms on a 4,000 ms
      // budget, rejecting with the plain Error.
      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      expect(opens).toBe(3);
      // Gated, but still immediate: the error class decides only whether to
      // WAIT, and an ordinary failure has no reason to.
      expect(delays).toEqual([]);
    });

    it("gates an OPEN refused with the immediate disposition", async () => {
      // Delta review D1: `immediate` is the fourth Retryability value and had
      // no test at all. It must be gated like every other retry decision, and
      // must not wait — the daemon said retry now.
      const workspace = await tempWorkspace("workspace-open-immediate");
      let nowMs = 0;
      let opens = 0;
      const delays: number[] = [];
      const client: EngineDaemonClient = {
        close: () => undefined,
        async sendRequest() {
          opens += 1;
          nowMs += 2_000;
          throw daemonRefusal("CONFLICT", "workspace is busy", "immediate");
        },
      };
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        {
          now: () => nowMs,
          sleep: async (delayMs) => {
            delays.push(delayMs);
          },
        },
      );

      const outcome = await sessions
        .withRetryBudget(4_000, async () =>
          await sessions.run(workspace, async () => "unreachable", {
            retryTransportErrors: true,
          }),
        )
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      expect(opens).toBe(3);
      expect(delays).toEqual([]);
    });

    it("prefers the deadline to the terminal error when quit races the last attempt", async () => {
      // Review round 8: `settleAttempt` checks the deadline BEFORE it consults
      // `shuttingDown`, and the ordering was unpinned — swapping the two
      // passed every test. At quit, on the last allowed attempt with a spent
      // budget, the swap returns the ladder's own transport error, which main
      // does not map to engineMayHoldDocument: the plain-editor downgrade, at quit.
      const workspace = await tempWorkspace("workspace-quit-vs-deadline");
      const client = new MockClient("handle-quit-deadline");
      let nowMs = 0;
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowMs, sleep: async () => {}, transportRebindAttempts: 2 },
      );

      const outcome = await sessions
        .withRetryBudget(3_000, async () =>
          await sessions.run(
            workspace,
            async () => {
              nowMs += 3_000;
              // Quit arrives while the LAST allowed attempt is in flight.
              if (nowMs >= 6_000) sessions.beginShutdown();
              throw transportFailure();
            },
            { retryTransportErrors: true },
          ),
        )
        .catch((error: unknown) => error);

      // MUTATION: check `shuttingDown` before the lastAttempt deadline branch
      // -> `{ code: "transport-error" }`, and the document downgrades.
      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
    });

    it("calls an exhausted CHURN ladder past its budget a deadline too", async () => {
      // codex round 7: the churn ladder ordered its terminal throw AHEAD of
      // the deadline check, so a last open that started inside the budget and
      // finished outside it rejected with EngineWorkspaceRebindError. Main
      // maps only EngineWorkspaceRetryDeadlineError to `engineMayHoldDocument`, so
      // that downgraded an engine-owned document to the writable plain
      // editor — the disk/Y.Doc race this budget exists to prevent.
      const workspace = await tempWorkspace("workspace-churn-exhausted");
      const first = new MockClient("handle-churn-e");
      const second = new MockClient("handle-churn-f");
      let nowMs = 0;
      let reads = 0;
      const sessions = new EngineWorkspaceSessions(
        {
          currentClient: () => {
            reads += 1;
            // Two reads per open attempt: the last allowed attempt starts at
            // 3,000 ms — inside the budget — and ends at 6,000 ms, outside it.
            nowMs += 1_500;
            return reads % 2 === 1 ? first : second;
          },
        },
        {
          now: () => nowMs,
          sleep: async () => {},
          transportRebindAttempts: 2,
        },
      );

      // The budget's clock starts at the FIRST FAILURE (t=3,000 here), not at
      // region entry, so 2,000 ms of recovery is what the terminal attempt at
      // t=6,000 overruns.
      const outcome = await sessions
        .withRetryBudget(2_000, async () => {
          return await sessions.run(workspace, async () => "unreachable");
        })
        .catch((error: unknown) => error);

      // MUTATION: throw the rebind error before the terminal deadline check
      // -> EngineWorkspaceRebindError, and the document downgrades.
      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      // MUTATION: stop counting churned opens on the budget -> "across 0
      // attempts" for a wait this ladder is the whole explanation for.
      expect((outcome as Error).message).toContain("across 2 failed attempts");
    });

    it("counts attempts across the whole budget, not one ladder's share", async () => {
      // codex round 5: the refusal reported the LOCAL ladder's counter, which
      // each `run` resets — so a wait covering several daemon attempts could
      // say "across 1 attempts". False diagnostic data in an error whose job
      // is to tell an agent what happened.
      const workspace = await tempWorkspace("workspace-cumulative");
      const client = new MockClient("handle-cumulative");
      let nowMs = 0;
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowMs, sleep: async () => {} },
      );

      const outcome = await sessions
        .withRetryBudget(4_000, async () => {
          // TWO runs inside one budget. The first is not a retry ladder, so
          // it spends one attempt and rejects on its own; the second retries
          // and trips the budget on its second attempt. Three attempts have
          // happened by then — one ladder can only see two.
          await sessions
            .run(workspace, async () => {
              nowMs += 2_000;
              throw transportFailure();
            })
            .catch(() => undefined);
          return await sessions.run(
            workspace,
            async () => {
              nowMs += 2_000;
              throw transportFailure();
            },
            { retryTransportErrors: true },
          );
        })
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      // MUTATION: report the local `attempt` -> "across 1 attempts", a
      // number the reader would take for the whole wait.
      expect((outcome as Error).message).toContain("across 3 failed attempts");
      // The constraint named is the one the CALLER set. MUTATION: name
      // `retryDeadlineMs` here -> the refusal points an agent at an option
      // with no production caller, which it cannot find or change.
      expect((outcome as Error).message).toContain(
        "withRetryBudget budgetMs limit of 4000ms",
      );
      // The budget's clock starts at the first failure (t=2,000) and the
      // region started at t=0, so the two durations differ by that first
      // attempt: 4,000ms of budget spent, 6,000ms of chain actually held.
      const deadline = outcome as EngineWorkspaceRetryDeadlineError;
      expect(deadline.measuredMs).toBe(4_000);
      expect(deadline.totalWaitedMs).toBe(6_000);
    });

    it("reports the recovery window and the total wait as different numbers", async () => {
      // codex on the round-10 head: the budget's clock starts at the first
      // FAILURE, but the message reported that interval as the time waited
      // "across" an attempt count that INCLUDES the first failure. One number
      // was being asked to mean two things, and an agent diagnosing a capture
      // chain held for 8s read 6s and looked in the wrong place.
      const workspace = await tempWorkspace("workspace-two-durations");
      const client = new MockClient("handle-two-durations");
      // A clock that does NOT start at zero. `performance.now()` never does in
      // a running app, and with a zero origin `startedAtMs: this.now()` and
      // `startedAtMs: 0` are indistinguishable — the region-entry timestamp
      // would be unpinned.
      let nowMs = 5_000;
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowMs, sleep: async () => {} },
      );

      const outcome = await sessions
        .withRetryBudget(6_000, async () =>
          await sessions.run(
            workspace,
            async () => {
              // A slow FIRST attempt (2s) the budget must not charge, then
              // failures that spend it.
              nowMs += 2_000;
              throw transportFailure();
            },
            { retryTransportErrors: true },
          ),
        )
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      const deadline = outcome as EngineWorkspaceRetryDeadlineError;
      // The chain was held for 8s; the recovery window that the limit bounds
      // opened 2s in. MUTATION: report `measuredMs` as the total wait -> the
      // message says 6000ms for an 8000ms hold.
      expect(deadline.measuredMs).toBe(6_000);
      expect(deadline.totalWaitedMs).toBe(8_000);
      expect(deadline.message).toContain("6000ms since the first failure");
      expect(deadline.message).toContain("waited 8000ms in total");
    });

    it("does not spend the budget on a slow attempt that was succeeding", async () => {
      // codex P1: anchored at region entry, this budget rejected work it had
      // never measured. A legitimately slow open — a large document's lineage
      // resurrection, the slow case #514 fought — spent the whole budget while
      // SUCCEEDING, and the first blip after it was then refused a retry that
      // would have bound. The measurement on record uses an instant provider
      // stub, so it covers none of that. The clock starts at the first
      // FAILURE instead: what stays bounded is recovery, which is what the
      // constant is derived from.
      const workspace = await tempWorkspace("workspace-slow-but-healthy");
      const client = new MockClient("handle-slow-healthy");
      let nowMs = 0;
      let attempts = 0;
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowMs, sleep: async () => {} },
      );

      const outcome = await sessions.withRetryBudget(2_000, async () =>
        await sessions.run(
          workspace,
          async () => {
            attempts += 1;
            // Attempt 1 works for 10 s — five times the budget — and then
            // hits one transport blip. Attempt 2 binds immediately.
            if (attempts === 1) {
              nowMs += 10_000;
              throw transportFailure();
            }
            return "bound";
          },
          { retryTransportErrors: true },
        ),
      );

      // MUTATION: anchor the budget at region entry -> the retry is refused
      // with EngineWorkspaceRetryDeadlineError and the document is downgraded,
      // for an open that was healthy and simply slow.
      expect(outcome).toBe("bound");
      expect(attempts).toBe(2);
    });

    it("refuses the NEXT call when an earlier one recovered past the window", async () => {
      // codex r15, and it is the bound's own hole. The gates lived on the
      // failure path, so a call that failed, RECOVERED and returned left the
      // budget spent with nothing to notice: the next call started unbounded.
      // In the document open that is the version read recovering and then
      // admitting the provider open past the window — the capture chain held
      // with no deadline left to stop it, which is the hold #564 removes.
      const workspace = await tempWorkspace("workspace-spent-then-next");
      const client = new MockClient("handle-spent-then-next");
      let nowMs = 5_000;
      let secondCall = 0;
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowMs, sleep: async () => {} },
      );

      const outcome = await sessions
        .withRetryBudget(2_000, async () => {
          let attempts = 0;
          // Call 1 fails once — starting the clock — waits out the whole
          // budget, and then SUCCEEDS. Nothing on this path throws.
          await sessions.run(
            workspace,
            async () => {
              attempts += 1;
              if (attempts === 1) throw transportFailure();
              nowMs += 5_000;
              return "recovered";
            },
            { retryTransportErrors: true },
          );
          // MUTATION: check the budget only at region entry and after a
          // failure -> this call runs, and everything it opens is unbounded.
          return await sessions.run(workspace, async () => {
            secondCall += 1;
            return "unbounded";
          });
        })
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      expect(secondCall).toBe(0);
      const deadline = outcome as EngineWorkspaceRetryDeadlineError;
      expect(deadline.constraint).toBe("withRetryBudget budgetMs");
      expect(deadline.limitMs).toBe(2_000);
      // The failure that started the clock rides along, so the refusal says
      // what the region was recovering from.
      expect(deadline.cause).toMatchObject({ code: "transport-error" });
    });

    it("refuses the NEXT call when quit arrives between two calls", async () => {
      // The same gap, reached the other way: `withRetryBudget` checks
      // `shuttingDown` at region entry, so a flag that flips between two calls
      // was never consulted and the region went on holding the chain.
      const workspace = await tempWorkspace("workspace-quit-between");
      const client = new MockClient("handle-quit-between");
      let secondCall = 0;
      const sessions = new EngineWorkspaceSessions({
        currentClient: () => client,
      });

      const outcome = await sessions
        .withRetryBudget(60_000, async () => {
          await sessions.run(workspace, async () => "first");
          sessions.beginShutdown();
          return await sessions.run(workspace, async () => {
            secondCall += 1;
            return "unbounded";
          });
        })
        .catch((error: unknown) => error);

      // MUTATION: consult `shuttingDown` only at region entry -> the quit
      // teardown waits behind a call this region had not started yet.
      expect(outcome).toBeInstanceOf(EngineWorkspaceShuttingDownError);
      expect(secondCall).toBe(0);
    });

    it("refuses the operation when the rebind spent the window", async () => {
      // codex r17. The start-of-run gate answered before `openForRun`, and
      // that call has a ladder of its own: it can wait, retry, recover, and
      // return with the whole window behind it. The operation it admits is the
      // document open itself — so the region ended up holding the capture
      // chain on a budget it had already spent, which is the hold this whole
      // bound exists to remove.
      const workspace = await tempWorkspace("workspace-rebind-spends");
      let nowMs = 5_000;
      let opens = 0;
      let operations = 0;
      const client: EngineDaemonClient = {
        close: () => undefined,
        async sendRequest(request) {
          opens += 1;
          // The FIRST open fails, which starts the clock, and the retry
          // succeeds — after the whole window has gone by.
          if (opens === 1) {
            nowMs += 100;
            throw transportFailure();
          }
          nowMs += 5_000;
          return { id: request.id, result: { workspace: "rebind-spends" } };
        },
      };
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowMs, sleep: async () => {} },
      );

      const outcome = await sessions
        .withRetryBudget(2_000, async () =>
          await sessions.run(
            workspace,
            async () => {
              operations += 1;
              return "held the chain";
            },
            { retryTransportErrors: true },
          ),
        )
        .catch((error: unknown) => error);

      // MUTATION: check the region only before `openForRun` -> the operation
      // runs on a spent budget, unbounded.
      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      expect(operations).toBe(0);
    });

    // The THIRD await found holding this hole, which is why the check moved to
    // the doors instead of gaining a third caller. A run that arrives while the
    // entry is closing waits for that close — and a `workspace.close` is a
    // daemon round trip, so the window can go by inside it. The run then walked
    // on into a 2 s `workspace.open` with nothing left to stop it.
    //
    // What it costs is the OPEN, not the answer: the gate after the rebind
    // still refuses the operation, so the run fails either way. It fails after
    // holding the capture chain through a 2 s `workspace.open` that had no
    // business starting — which is the hold, and the thing to count.
    function closingEntryHarness(options: {
      onClose: (advance: () => void) => void;
      nowRef: { ms: number };
      opensAfterClose: { count: number };
    }) {
      let closed = false;
      const client: EngineDaemonClient = {
        close: () => undefined,
        async sendRequest(request) {
          if (request.method === "workspace.close") {
            closed = true;
            options.onClose(() => {
              options.nowRef.ms += 5_000;
            });
            return { id: request.id, result: { closed: true } };
          }
          if (closed) options.opensAfterClose.count += 1;
          return { id: request.id, result: { workspace: "closing-wait" } };
        },
      };
      return client;
    }

    it("refuses an open that waited out the window on a closing entry", async () => {
      const workspace = await tempWorkspace("workspace-closing-wait");
      const nowRef = { ms: 5_000 };
      const opensAfterClose = { count: 0 };
      let operations = 0;
      const client = closingEntryHarness({
        nowRef,
        opensAfterClose,
        // The close IS the wait: the budget goes by inside it.
        onClose: (advance) => advance(),
      });
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowRef.ms, sleep: async () => {} },
      );

      const outcome = await sessions
        .withRetryBudget(2_000, async () => {
          // One failure starts the clock, and the retry succeeds well inside
          // the window — so the gate at the top of `run` has nothing to refuse.
          let attempts = 0;
          await sessions.run(
            workspace,
            async () => {
              attempts += 1;
              if (attempts === 1) throw transportFailure();
              return "recovered";
            },
            { retryTransportErrors: true },
          );
          // Now the entry starts closing, and this run queues behind it.
          const closing = sessions.closeWorkspace(workspace.workspaceId);
          const queued = sessions.run(workspace, async () => {
            operations += 1;
            return "held the chain";
          });
          await closing;
          return await queued;
        })
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      expect(operations).toBe(0);
      // MUTATION: check the region only at `run` entry and after the rebind ->
      // a `workspace.open` is issued on a budget the closing wait had already
      // spent, and the capture chain waits out its 2 s deadline for nothing.
      expect(opensAfterClose.count).toBe(0);
    });

    it("refuses an open that waited out a quit on a closing entry", async () => {
      const workspace = await tempWorkspace("workspace-closing-quit");
      const nowRef = { ms: 5_000 };
      const opensAfterClose = { count: 0 };
      let operations = 0;
      let sessions!: EngineWorkspaceSessions;
      const client = closingEntryHarness({
        nowRef,
        opensAfterClose,
        // Quit arrives while the close is in flight, so nothing this run has
        // already checked knows about it.
        onClose: () => sessions.beginShutdown(),
      });
      sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowRef.ms, sleep: async () => {} },
      );

      const outcome = await sessions
        .withRetryBudget(60_000, async () => {
          await sessions.run(workspace, async () => "first");
          const closing = sessions.closeWorkspace(workspace.workspaceId);
          const queued = sessions.run(workspace, async () => {
            operations += 1;
            return "held the chain";
          });
          await closing;
          return await queued;
        })
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(EngineWorkspaceShuttingDownError);
      expect(operations).toBe(0);
      // Nothing new starts during teardown, whatever it waited on.
      expect(opensAfterClose.count).toBe(0);
    });

    it("refuses on time when a stale client never answers its cleanup close", async () => {
      // codex r19, and the r18 class in one more flavor: the doors bound what
      // STARTS, and this await sat between two of them. When the client churns
      // mid-open the loser's binding is closed — and a `workspace.close` on a
      // client that is connected but UNRESPONSIVE never answers, so the region
      // waited there past its budget and past quit with the gate one line
      // away. Cleanup for a generation nobody will use again does not get to
      // hold the capture chain.
      //
      // Under the defect this test does not fail, it HANGS: the first cleanup
      // close never settles, so the run never returns and the case becomes the
      // file's timeout.
      const workspace = await tempWorkspace("workspace-stale-close-hangs");
      let nowMs = 5_000;
      let reads = 0;
      let closeStarted = 0;
      // Every open answers and then finds the client changed under it, so the
      // ladder churns — and every loser's cleanup close hangs.
      const churning = (): EngineDaemonClient => ({
        close: () => undefined,
        async sendRequest(request) {
          if (request.method === "workspace.close") {
            closeStarted += 1;
            return await new Promise<never>(() => {});
          }
          // Each open costs 4,000 ms against a 2,000 ms window.
          nowMs += 4_000;
          return { id: request.id, result: { workspace: "churning" } };
        },
      });
      const generations = [churning(), churning(), churning(), churning()];
      const sessions = new EngineWorkspaceSessions(
        {
          currentClient: () => {
            const client = generations[Math.min(reads, generations.length - 1)];
            reads += 1;
            return client as EngineDaemonClient;
          },
        },
        { now: () => nowMs, sleep: async () => {} },
      );

      const outcome = await sessions
        .withRetryBudget(2_000, async () =>
          await sessions.run(workspace, async () => "unreachable", {
            retryTransportErrors: true,
          }),
        )
        .catch((error: unknown) => error);

      // MUTATION: await the cleanup close -> this never resolves and the
      // region is held by a daemon request nothing bounds.
      expect(outcome).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      // The cleanup was still ISSUED — it is best-effort, not skipped.
      expect(closeStarted).toBeGreaterThan(0);
    });

    it("lets a settle armed during the open run after the region ends", async () => {
      // codex r22, and the round-9 asymmetry wearing an async-context coat.
      // A document open INSTALLS things that outlive it — the settle debounce
      // timer, the remote-update subscription, the save-state reporter — and a
      // Node timer keeps the async context it was created in. So the session's
      // later work kept reading as work inside the ABANDONABLE open region,
      // for the whole life of the session: a settle for an edit the engine had
      // already accepted would be refused by a budget spent during the open.
      // That is the one thing this class must never do to an accepted write.
      const workspace = await tempWorkspace("workspace-settle-after-region");
      const client = new MockClient("handle-settle-after");
      let nowMs = 5_000;
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowMs, sleep: async () => {} },
      );

      // A real timer, armed INSIDE the region, exactly as the provider arms
      // its settle debounce while the open runs. A plain closure would not
      // reproduce this: it is the timer that carries the context.
      let settle!: Promise<unknown>;
      await sessions.withRetryBudget(2_000, async () => {
        let attempts = 0;
        await sessions.run(
          workspace,
          async () => {
            attempts += 1;
            // One failure starts the budget's clock, and the retry binds.
            if (attempts === 1) throw transportFailure();
            return "bound";
          },
          { retryTransportErrors: true },
        );
        settle = new Promise((resolve, reject) => {
          setTimeout(() => {
            // The accepted edit's settle, on the live session.
            sessions
              .run(workspace, async () => "settled")
              .then(resolve, reject);
          }, 0);
        });
        // The open spends the rest of its window before returning.
        nowMs += 5_000;
      });

      // MUTATION: leave the region live after the task returns -> this settle
      // reads as abandonable work on a spent budget and rejects with
      // EngineWorkspaceRetryDeadlineError, losing an accepted update.
      await expect(settle).resolves.toBe("settled");
    });

    it("lets a settle armed during the open survive quit", async () => {
      // The same leak, reached through `beginShutdown` instead of the clock:
      // an abandonable region stops retrying at quit, and a live document's
      // settle is not abandonable.
      const workspace = await tempWorkspace("workspace-settle-after-quit");
      const client = new MockClient("handle-settle-quit");
      const sessions = new EngineWorkspaceSessions({
        currentClient: () => client,
      });

      let settle!: Promise<unknown>;
      await sessions.withRetryBudget(60_000, async () => {
        await sessions.run(workspace, async () => "bound");
        settle = new Promise((resolve, reject) => {
          setTimeout(() => {
            let attempts = 0;
            sessions
              .run(
                workspace,
                async () => {
                  attempts += 1;
                  // The daemon blips once; an accepted write retries through
                  // it even at quit.
                  if (attempts === 1) throw transportFailure();
                  return "settled";
                },
                { retryTransportErrors: true },
              )
              .then(resolve, reject);
          }, 0);
        });
      });
      sessions.beginShutdown();

      await expect(settle).resolves.toBe("settled");
    });

    it("keeps running a region whose budget clock never started", async () => {
      // The invariant the gate must not break: a healthy attempt costs the
      // budget nothing, however long it takes, so a region that has not
      // FAILED yet is never refused for time alone.
      const workspace = await tempWorkspace("workspace-healthy-region");
      const client = new MockClient("handle-healthy-region");
      let nowMs = 5_000;
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { now: () => nowMs, sleep: async () => {} },
      );

      const outcome = await sessions.withRetryBudget(1_000, async () => {
        await sessions.run(workspace, async () => {
          nowMs += 60_000;
          return "slow but healthy";
        });
        return await sessions.run(workspace, async () => "second");
      });

      expect(outcome).toBe("second");
    });

    it("rejects an invalid budget instead of quietly voiding it", async () => {
      const client = new MockClient("handle-bad-budget");
      const sessions = new EngineWorkspaceSessions({
        currentClient: () => client,
      });

      await expect(
        sessions.withRetryBudget(0, async () => "unreachable"),
      ).rejects.toThrow(TypeError);
    });
  });

  // #564: app quit. Retry waiting ends NOW — an armed backoff resolves, the
  // failure that caused it surfaces, and the capture chain behind the run is
  // free within one attempt instead of the full ladder.
  describe("beginShutdown", () => {
    // Quit ends retry WAITING for a bounded region, and only for one. Every
    // test below therefore runs its ladder inside `withRetryBudget`, because
    // that is what marks work as abandonable: the document open, which holds
    // no edit (#533). A budget far past anything these ladders can spend, so
    // the only thing that can stop them is the shutdown gate under test.
    //
    // Quit arrives from INSIDE the first failure, because a region is now
    // refused outright if it tries to start after shutdown began (see
    // `refuses a bounded region that tries to START after shutdown began`).
    // That is also the realistic sequence: the ladder is already running when
    // `will-quit` fires.
    //
    // `keeps retrying work outside a bounded region at quit` is the other
    // half of this contract.
    const ABANDONABLE = 60_000;

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

      const run = sessions.withRetryBudget(
        ABANDONABLE,
        async () =>
          await sessions.run(
            workspace,
            async () => {
              throw transportFailure();
            },
            { retryTransportErrors: true },
          ),
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

      const run = sessions.withRetryBudget(
        ABANDONABLE,
        async () => await sessions.run(workspace, async () => "unreachable"),
      );
      await vi.waitFor(() => {
        expect(sleeping).not.toBeNull();
      });
      sessions.beginShutdown();
      await expect(run).rejects.toBeInstanceOf(EngineWorkspaceRebindError);
    });

    it("stops an OPEN that keeps refusing with afterReconnect", async () => {
      const workspace = await tempWorkspace("workspace-open-reconnect-quit");
      let opens = 0;
      const sleep = vi.fn(async () => {});
      const client: EngineDaemonClient = {
        close: () => undefined,
        async sendRequest() {
          opens += 1;
          // Quit lands while the first open is in flight.
          if (opens === 1) sessions.beginShutdown();
          throw daemonRefusal("CONFLICT", "workspace handle is stale", "afterReconnect");
        },
      };
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { sleep },
      );

      await expect(
        sessions.withRetryBudget(
          ABANDONABLE,
          async () =>
            await sessions.run(workspace, async () => "unreachable", {
              retryTransportErrors: true,
            }),
        ),
      ).rejects.toBeInstanceOf(DaemonRefusalError);
      // MUTATION: drop requiresReconnect from the gate -> six opens while the
      // quit teardown waits on the chain behind them.
      expect(opens).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("stops an OPEN the daemon keeps refusing with afterBackoff", async () => {
      // Review round 8, the quit half of the same gap: an `afterBackoff`
      // refusal took a bare `continue`, so beginShutdown() could not end the
      // ladder and the quit teardown waited on the chain behind six opens.
      const workspace = await tempWorkspace("workspace-open-backoff-quit");
      let opens = 0;
      const sleep = vi.fn(async () => {});
      const client: EngineDaemonClient = {
        close: () => undefined,
        async sendRequest() {
          opens += 1;
          // Quit lands while the first open is in flight.
          if (opens === 1) sessions.beginShutdown();
          throw daemonRefusal("OVERLOADED", "engine queue is full", "afterBackoff");
        },
      };
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { sleep },
      );

      await expect(
        sessions.withRetryBudget(
          ABANDONABLE,
          async () =>
            await sessions.run(workspace, async () => "unreachable", {
              retryTransportErrors: true,
            }),
        ),
      ).rejects.toBeInstanceOf(DaemonRefusalError);
      // MUTATION: restore the bare `continue` -> six opens while the quit
      // teardown waits on the capture chain behind them.
      expect(opens).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
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

      await expect(
        sessions.withRetryBudget(
          ABANDONABLE,
          async () =>
            await sessions.run(workspace, async () => {
              attempts += 1;
              // Quit lands while the first attempt is in flight.
              if (attempts === 1) sessions.beginShutdown();
              throw daemonRefusal("CONFLICT", "workspace moved", "afterReconnect");
            }, { retryTransportErrors: true }),
        ),
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

      await expect(
        sessions.withRetryBudget(
          ABANDONABLE,
          async () =>
            await sessions.run(
              workspace,
              async () => {
                attempts += 1;
                // Quit lands while the first attempt is in flight.
                if (attempts === 1) sessions.beginShutdown();
                throw transportFailure();
              },
              { retryTransportErrors: true },
            ),
        ),
      ).rejects.toMatchObject({ code: "transport-error" });
      // MUTATION: drop the shutdown gate -> six attempts with backoff.
      expect(attempts).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("refuses a bounded region that tries to START after shutdown began", async () => {
      // codex on the round-9 head, and the other half of the backoff finding:
      // `shuttingDown` was consulted on the FAILURE path only, so a task that
      // never fails never checks it. A document open still queued on the
      // capture chain when `will-quit` fires would enter the region
      // afterwards, SUCCEED at its first workspace call, and proceed into a
      // `ydoc.open` whose own bound (#616) outlasts the 3 s forced-exit timer.
      const workspace = await tempWorkspace("workspace-region-after-quit");
      const client = new MockClient("handle-region-after-quit");
      let ran = 0;
      const sessions = new EngineWorkspaceSessions({
        currentClient: () => client,
      });
      sessions.beginShutdown();

      const outcome = await sessions
        .withRetryBudget(6_000, async () => {
          ran += 1;
          return await sessions.run(workspace, async () => "opened");
        })
        .catch((error: unknown) => error);

      // MUTATION: start the task unconditionally -> the region runs, the open
      // succeeds, and the chain is held into the forced-exit timer.
      expect(outcome).toBeInstanceOf(EngineWorkspaceShuttingDownError);
      expect(ran).toBe(0);
      // It must keep the document READ-ONLY, never downgrade it to the
      // writable plain editor: main answers both open refusals with
      // `engineMayHoldDocument`. MUTATION: drop it from the predicate -> the surface
      // takes the disk path #533 closed.
      expect(isEngineWorkspaceOpenRefusedError(outcome)).toBe(true);
    });

    it("keeps retrying work outside a bounded region at quit", async () => {
      // codex P1: `beginShutdown` is a global flag doing a scoped job. It must
      // abandon a pending document OPEN — which holds no edit (#533) — and it
      // must NOT abandon an already-open document retrying a write the engine
      // already accepted. That update lives only in the canonical in-memory
      // Y.Doc, `closeAllEngineYDocSessions` swallows the failure, and
      // `app.exit(0)` then discards it: silent data loss at exit, and the
      // opposite obligation from the one the bound was aimed at.
      const workspace = await tempWorkspace("workspace-accepted-write-quit");
      const client = new MockClient("handle-accepted-write");
      let attempts = 0;
      const sleep = vi.fn(async () => {});
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { sleep },
      );
      sessions.beginShutdown();

      // NO withRetryBudget: this is a live document's write, not the open.
      await expect(
        sessions.run(
          workspace,
          async () => {
            attempts += 1;
            if (attempts < 3) throw transportFailure();
            return "landed";
          },
          { retryTransportErrors: true },
        ),
      ).resolves.toBe("landed");
      // MUTATION: consult `shuttingDown` for every run, not just a bounded
      // region -> one attempt, the write is abandoned, and the edit is gone.
      expect(attempts).toBe(3);
      // It KEEPS its pacing. Quit ends the waiting of abandonable work only,
      // and the test below is why.
      expect(sleep).toHaveBeenCalled();
    });

    it("paces a live document's retry at quit, so a relaunching daemon can answer", async () => {
      // codex r17 P1. Quit used to make every non-region retry immediate, on
      // the reasoning that it is racing the quit timer. But the daemon it is
      // racing is RELAUNCHING, and a burst of synchronous attempts all land
      // inside that window: six failures in zero elapsed time, a close that
      // `closeAllEngineYDocSessions` swallows, and `app.exit(0)` discarding an
      // edit that lived only in the canonical Y.Doc. Fast-failing a retry is
      // not racing the timer, it is losing to it. Only WAITING is abandoned at
      // quit, and only for work that may be abandoned.
      const workspace = await tempWorkspace("workspace-quit-pacing");
      const client = new MockClient("handle-quit-pacing");
      let nowMs = 0;
      let attempts = 0;
      const sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        {
          now: () => nowMs,
          sleep: async (delayMs) => {
            nowMs += delayMs;
          },
        },
      );
      sessions.beginShutdown();

      // The daemon is relaunching: it refuses for 100 ms, then answers. Only a
      // retry that waits can see the second answer.
      // MUTATION: return "retry" without backoff at quit -> every attempt runs
      // at t=0, the write never lands, and the edit is gone at exit.
      await expect(
        sessions.run(
          workspace,
          async () => {
            attempts += 1;
            if (nowMs < 100) throw transportFailure();
            return "landed";
          },
          { retryTransportErrors: true },
        ),
      ).resolves.toBe("landed");
      expect(attempts).toBe(2);
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
