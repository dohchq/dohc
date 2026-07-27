import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "@dohc/workspace-engine-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineClientSpawnOptions } from "./engineClient";
import {
  createRustEngineDaemon,
  defaultEngineBinaryPath,
  EngineDaemonLifecycle,
  runEngineDaemonStartupSmoke,
  type EngineDaemonClient,
} from "./engineDaemonLifecycle";

class FakeClient implements EngineDaemonClient {
  readonly requests: Request[] = [];
  readonly cancelledRequestIds: number[] = [];
  closed = false;
  waitForExit?: () => Promise<void>;

  constructor(
    private readonly respond: (
      request: Request,
    ) => Response | Promise<Response> = (request) =>
      request.method === "workspace.open"
        ? { id: request.id, result: { workspace: "health-handle" } }
        : { id: request.id, result: null },
  ) {}

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(request);
    return await this.respond(request);
  }

  async cancelRequest(requestId: number): Promise<void> {
    this.cancelledRequestIds.push(requestId);
  }

  close(): void {
    this.closed = true;
  }
}

const scratchPaths: string[] = [];
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fakeBinary(): string {
  const directory = mkdtempSync(join(tmpdir(), "dohc-engine-lifecycle-test-"));
  scratchPaths.push(directory);
  const path = join(directory, "dohc-workspace-engine");
  writeFileSync(path, "test");
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Rust engine daemon lifecycle", () => {
  it("fails the packaging gate when the staged engine binary is missing", () => {
    const emptyResourceDir = mkdtempSync(
      join(tmpdir(), "dohc-missing-engine-resource-"),
    );
    scratchPaths.push(emptyResourceDir);

    const gate = spawnSync(
      process.execPath,
      [
        join(desktopDir, "scripts", "require-workspace-engine.mjs"),
        emptyResourceDir,
      ],
      { encoding: "utf8" },
    );

    expect(gate.status).not.toBe(0);
    expect(gate.stderr).toContain(
      "Refusing to package without the Rust workspace engine binary",
    );
    expect(
      readFileSync(join(desktopDir, "electron-builder.yml"), "utf8"),
    ).toMatch(/^beforePack: scripts\/require-workspace-engine\.mjs$/m);
    expect(
      readFileSync(
        resolve(desktopDir, "../..", ".github/workflows/desktop-release.yml"),
        "utf8",
      ),
    ).toContain(
      "pnpm --filter @dohc/desktop run build:engine -- --target",
    );
  });

  it("generates a distinct auth token for every launch", async () => {
    const tokens: string[] = [];
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      initialBackoffMs: 0,
      launch: async (options) => {
        tokens.push(options.authToken);
        exits.push(options.onExit);
        return new FakeClient();
      },
    });

    await lifecycle.start();
    exits[0]?.(9, null);
    await vi.waitFor(() => expect(tokens).toHaveLength(2));

    expect(tokens[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens[1]).not.toBe(tokens[0]);
    await lifecycle.stop();
  });

  it("fails loudly before launch when the configured binary is missing", async () => {
    const launch = vi.fn(async () => new FakeClient());
    const lifecycle = new EngineDaemonLifecycle({
      command: join(tmpdir(), "definitely-missing-dohc-engine"),
      fileExists: () => false,
      launch,
    });

    await expect(lifecycle.start()).rejects.toThrow(
      /Rust engine binary not found/,
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("bounds restart attempts when every replacement fails", async () => {
    let exit: EngineClientSpawnOptions["onExit"];
    let launchCount = 0;
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: 3,
      initialBackoffMs: 0,
      launch: async (options) => {
        launchCount += 1;
        if (launchCount === 1) {
          exit = options.onExit;
          return new FakeClient();
        }
        throw new Error("replacement handshake failed");
      },
      onFailure: (_error, isTerminal) => {
        if (isTerminal) resolveTerminal();
      },
    });

    await lifecycle.start();
    exit?.(1, null);
    await terminal;
    expect(launchCount).toBe(4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(launchCount).toBe(4);
    await lifecycle.stop();
  });

  it("carries the restart budget across handshaking daemon generations", async () => {
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    const terminalFailures: Error[] = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: 3,
      initialBackoffMs: 0,
      launch: async (options) => {
        exits.push(options.onExit);
        return new FakeClient();
      },
      onFailure: (error, terminal) => {
        if (terminal) terminalFailures.push(error);
      },
    });

    try {
      await lifecycle.start();
      for (let generation = 0; generation < 4; generation += 1) {
        exits[generation]?.(1, null);
        if (generation < 3) {
          await vi.waitFor(() =>
            expect(exits).toHaveLength(generation + 2),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      await vi.waitFor(
        () => {
          expect(terminalFailures).toHaveLength(1);
        },
        { timeout: 100 },
      );
      expect(exits).toHaveLength(4);
      expect(terminalFailures[0]?.message).toMatch(
        /restart limit exceeded after 3 attempts/,
      );
    } finally {
      await lifecycle.stop();
    }
  });

  it("resets the restart budget after a sustained healthy generation", async () => {
    const exits: EngineClientSpawnOptions["onExit"][] = [];
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: 1,
      initialBackoffMs: 0,
      healthyResetMs: 20,
      launch: async (options) => {
        exits.push(options.onExit);
        return new FakeClient();
      },
    });

    try {
      await lifecycle.start();
      exits[0]?.(1, null);
      await vi.waitFor(() => expect(exits).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 30));
      exits[1]?.(1, null);
      await vi.waitFor(() => expect(exits).toHaveLength(3));
    } finally {
      await lifecycle.stop();
    }
  });

  it("counts a replacement that handshakes then hangs as a failed restart", async () => {
    let initialExit: EngineClientSpawnOptions["onExit"];
    let launchCount = 0;
    const failures: Array<{ error: Error; terminal: boolean }> = [];
    const healthyClient = new FakeClient((request) => {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "health-handle" } };
      }
      return { id: request.id, result: null };
    });
    const hungClient = new FakeClient(
      () =>
        new Promise<Response>(() => {
          // The replacement completed helloAck but cannot serve requests.
        }),
    );
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      maxRestarts: 1,
      initialBackoffMs: 0,
      healthyResetMs: 20,
      requestTimeoutMs: 10,
      launch: async (options) => {
        launchCount += 1;
        if (launchCount === 1) {
          initialExit = options.onExit;
          return healthyClient;
        }
        return hungClient;
      },
      onFailure: (error, terminal) => {
        failures.push({ error, terminal });
      },
    });

    try {
      await lifecycle.start();
      initialExit?.(1, null);
      await vi.waitFor(() => expect(launchCount).toBe(2));
      await vi.waitFor(
        () => {
          expect(
            failures.some(
              ({ error, terminal }) =>
                !terminal &&
                /workspace\.open timed out after 10ms/.test(error.message),
            ),
          ).toBe(true);
          expect(failures.some(({ terminal }) => terminal)).toBe(true);
        },
        { timeout: 200 },
      );
    } finally {
      await lifecycle.stop();
    }
  });

  it("waits for the daemon to exit during clean shutdown", async () => {
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const client = new FakeClient();
    client.waitForExit = () => exited;
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      launch: async () => client,
    });
    await lifecycle.start();

    let stopped = false;
    const stop = lifecycle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(client.closed).toBe(true);
    expect(stopped).toBe(false);
    resolveExit();
    await stop;
    expect(stopped).toBe(true);
  });

  it("waits for an in-flight launch and leaves no daemon starting on shutdown", async () => {
    let resolveLaunch!: (client: EngineDaemonClient) => void;
    let resolveExit!: () => void;
    const launched = new Promise<EngineDaemonClient>((resolve) => {
      resolveLaunch = resolve;
    });
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    let launchSignal: AbortSignal | undefined;
    const client = new FakeClient();
    client.waitForExit = () => exited;
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      launch: async (options) => {
        launchSignal = options.signal;
        return await launched;
      },
    });

    const start = lifecycle.start();
    await Promise.resolve();
    let stopped = false;
    const stop = lifecycle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(launchSignal?.aborted).toBe(true);

    resolveLaunch(client);
    await vi.waitFor(() => expect(client.closed).toBe(true));
    expect(stopped).toBe(false);

    resolveExit();
    await Promise.all([start, stop]);
    expect(stopped).toBe(true);
  });

  it("opens a workspace and completes a versions.active smoke round-trip", async () => {
    const client = new FakeClient((request) => {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "opaque-handle" } };
      }
      if (request.method === "versions.active") {
        return { id: request.id, result: { id: "main", kind: "main" } };
      }
      return { id: request.id, result: {} };
    });
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      launch: async () => client,
    });
    await lifecycle.start();
    client.requests.length = 0;

    await expect(
      lifecycle.smokeWorkspace("C:\\shadow-workspace", "smoke-workspace"),
    ).resolves.toEqual({ id: "main", kind: "main" });
    expect(client.requests.map((request) => request.method)).toEqual([
      "workspace.open",
      "versions.active",
      "workspace.close",
    ]);
    expect(client.requests[1]?.workspace).toBe("opaque-handle");
    await lifecycle.stop();
  });

  it("opens, binds, and closes a workspace around an injected CLI read", async () => {
    const client = new FakeClient((request) => {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "cli-handle" } };
      }
      if (request.method === "search.queryChatMessagesGranular") {
        return {
          id: request.id,
          result: {
            results: [{
              threadId: "thread",
              messageId: null,
              text: "needle",
            }],
            saturated: false,
          },
        };
      }
      return { id: request.id, result: {} };
    });
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      launch: async () => client,
    });
    await lifecycle.start();
    client.requests.length = 0;

    await expect(
      lifecycle.requestWorkspace(
        "C:\\workspace",
        "workspace",
        "search.queryChatMessagesGranular",
        { query: "needle", limit: 50_000 },
      ),
    ).resolves.toEqual({
      results: [{
        threadId: "thread",
        messageId: null,
        text: "needle",
      }],
      saturated: false,
    });
    expect(client.requests.map((request) => request.method)).toEqual([
      "workspace.open",
      "search.queryChatMessagesGranular",
      "workspace.close",
    ]);
    expect(client.requests[0]?.params).toEqual({
      rootDir: "C:\\workspace",
      workspaceId: "workspace",
      recoverRunningDispatches: false,
      skipStartupMaintenance: true,
    });
    expect(client.requests[1]?.workspace).toBe("cli-handle");
    await lifecycle.stop();
  });

  it("serializes concurrent CLI reads that share a workspace handle", async () => {
    let releaseFirst!: (response: Response) => void;
    let readCount = 0;
    const client = new FakeClient((request) => {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "shared-handle" } };
      }
      if (request.method === "search.queryChatMessagesGranular") {
        readCount += 1;
        if (readCount === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { id: request.id, result: { results: [], saturated: false } };
      }
      return { id: request.id, result: {} };
    });
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      launch: async () => client,
    });
    await lifecycle.start();
    client.requests.length = 0;

    const first = lifecycle.requestWorkspace(
      "C:\\workspace",
      "workspace",
      "search.queryChatMessagesGranular",
      { query: "first", limit: 50_000 },
    );
    await vi.waitFor(() => expect(client.requests).toHaveLength(2));
    const second = lifecycle.requestWorkspace(
      "C:\\workspace",
      "workspace",
      "search.queryChatMessagesGranular",
      { query: "second", limit: 50_000 },
    );
    await Promise.resolve();
    expect(client.requests.map((request) => request.method)).toEqual([
      "workspace.open",
      "search.queryChatMessagesGranular",
    ]);

    const firstRequest = client.requests[1];
    if (!firstRequest) throw new Error("First read was not sent");
    releaseFirst({
      id: firstRequest.id,
      result: { results: [], saturated: false },
    });
    await Promise.all([first, second]);
    expect(client.requests.map((request) => request.method)).toEqual([
      "workspace.open",
      "search.queryChatMessagesGranular",
      "workspace.close",
      "workspace.open",
      "search.queryChatMessagesGranular",
      "workspace.close",
    ]);
    await lifecycle.stop();
  });

  it("fails initial generation health within the request bound after helloAck", async () => {
    const client = new FakeClient(
      () =>
        new Promise<Response>(() => {
          // Deliberately never settles: the daemon completed helloAck but
          // stopped processing requests.
        }),
    );
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      requestTimeoutMs: 20,
      launch: async () => client,
    });

    const startedAt = Date.now();
    await expect(lifecycle.start()).rejects.toThrow(
      /workspace\.open timed out after 20ms/,
    );
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(client.closed).toBe(true);
    await lifecycle.stop();
  });

  it("times out workspace opens with an engine deadline and cancellation", async () => {
    let hangOpen = false;
    const client = new FakeClient((request) => {
      if (request.method === "workspace.open" && hangOpen) {
        return new Promise<Response>(() => {
          // The daemon never acknowledges this real-workspace open.
        });
      }
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "health-handle" } };
      }
      return { id: request.id, result: null };
    });
    const lifecycle = new EngineDaemonLifecycle({
      command: fakeBinary(),
      requestTimeoutMs: 20,
      launch: async () => client,
    });

    await lifecycle.start();
    client.requests.length = 0;
    client.cancelledRequestIds.length = 0;
    hangOpen = true;
    await expect(
      lifecycle.requestWorkspace(
        "C:\\workspace",
        "workspace",
        "search.queryChatMessagesGranular",
        { query: "needle", limit: 50_000 },
      ),
    ).rejects.toThrow(
      /workspace\.open timed out after 20ms/,
    );
    expect(client.requests[0]?.deadlineMs).toBe(20);
    expect(client.cancelledRequestIds).toEqual([client.requests[0]?.id]);
    expect(client.closed).toBe(true);
    await lifecycle.stop();
  });

  it("resolves the dev and packaged binary layouts", () => {
    expect(
      defaultEngineBinaryPath({
        isPackaged: false,
        appPath: "/repo/apps/desktop",
        platform: "linux",
      }),
    ).toBe(posix.join("/repo", "target/debug/dohc-workspace-engine"));
    expect(
      defaultEngineBinaryPath({
        isPackaged: true,
        appPath: "C:\\ignored",
        resourcesPath: "C:\\Program Files\\dohc\\resources",
        platform: "win32",
      }),
    ).toBe(
      win32.join(
        "C:\\Program Files\\dohc\\resources",
        "workspace-engine",
        "dohc-workspace-engine.exe",
      ),
    );
  });

  it.runIf(process.env.DOHC_TEST_REAL_RUST_ENGINE === "1")(
    "completes the startup smoke against the real Rust daemon",
    async () => {
      const lifecycle = createRustEngineDaemon({
        command: defaultEngineBinaryPath({
          isPackaged: false,
          appPath: process.cwd(),
        }),
      });
      try {
        await lifecycle.start();
        // A fresh shadow database currently has no active version. The null
        // result is still a successful, decoded versions.active round-trip.
        await expect(runEngineDaemonStartupSmoke(lifecycle)).resolves.toBeNull();
      } finally {
        await lifecycle.stop();
      }
    },
  );
});
