import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { Request, Response } from "@dohc/workspace-engine-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineClientSpawnOptions } from "./engineClient";
import {
  createRustEngineDaemonIfEnabled,
  defaultEngineBinaryPath,
  EngineDaemonLifecycle,
  runEngineDaemonStartupSmoke,
  type EngineDaemonClient,
} from "./engineDaemonLifecycle";

class FakeClient implements EngineDaemonClient {
  readonly requests: Request[] = [];
  closed = false;
  waitForExit?: () => Promise<void>;

  constructor(
    private readonly respond: (request: Request) => Response = (request) => ({
      id: request.id,
      result: {},
    }),
  ) {}

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(request);
    return this.respond(request);
  }

  close(): void {
    this.closed = true;
  }
}

const scratchPaths: string[] = [];

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

  it("does not construct or launch the daemon when the flag is off", () => {
    const launch = vi.fn(async () => new FakeClient());
    const lifecycle = createRustEngineDaemonIfEnabled(false, {
      command: join(tmpdir(), "missing-is-irrelevant-while-disabled"),
      launch,
    });

    expect(lifecycle).toBeNull();
    expect(launch).not.toHaveBeenCalled();
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
    "completes the flag-on startup smoke against the real Rust daemon",
    async () => {
      const lifecycle = createRustEngineDaemonIfEnabled(true, {
        command: defaultEngineBinaryPath({
          isPackaged: false,
          appPath: process.cwd(),
        }),
      });
      expect(lifecycle).not.toBeNull();
      if (!lifecycle) throw new Error("flag-on lifecycle was not created");
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
