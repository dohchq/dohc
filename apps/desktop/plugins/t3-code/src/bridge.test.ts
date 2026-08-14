import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PluginChildProcessClient,
  PluginChildProcessExit,
  PluginChildProcessHandle,
  PluginChildProcessOutput,
  PluginChildProcessSpawnOptions,
} from "@dohc/sdk/node";
import { createT3Bridge, T3_WEB_APP_ID, type T3BridgeContext } from "./bridge";
import { serverRuntimePath } from "./staleState";
import { T3_ENTRY_MODULE_PATH, T3_PINNED_VERSION } from "./t3Entry";

// The bridge orchestrates against the SDK child-process client and a real
// HTTP readiness endpoint. The fake below stands in for the broker + t3
// process pair: it answers readiness over a real socket at the port the
// bridge chose and prints the real access-block format, so the bridge's
// parsing, polling, redaction, and retry logic all run against the true
// shapes.

type FakeBoot = "ready" | "exit-early" | "wrong-version";

interface FakeSpawn {
  request: PluginChildProcessSpawnOptions;
  child: FakeT3Child;
}

class FakeT3Child implements PluginChildProcessHandle {
  readonly id: string;
  readonly pid: number;
  terminated = false;
  private readonly listeners = new Set<(output: PluginChildProcessOutput) => void>();
  private readonly buffered: PluginChildProcessOutput[] = [];
  private sequence = 0;
  private exitResolve: (exit: PluginChildProcessExit) => void = () => undefined;
  private readonly exitPromise: Promise<PluginChildProcessExit>;
  private server: Server | null = null;

  constructor(index: number) {
    this.id = `child-${index}`;
    this.pid = 40_000 + index;
    this.exitPromise = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
  }

  emit(text: string): void {
    const output = { sequence: ++this.sequence, stream: "stdout" as const, text };
    this.buffered.push(output);
    for (const listener of this.listeners) listener(output);
  }

  async boot(mode: FakeBoot, port: number, token: string): Promise<void> {
    if (mode === "exit-early") {
      this.emit("bind failed: EADDRINUSE\n");
      this.exitResolve({ code: 1, reason: "exited" });
      return;
    }
    const serverVersion = mode === "ready" ? T3_PINNED_VERSION : "9.9.9";
    this.server = createServer((_request, response) => {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ serverVersion }));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
    this.emit(
      [
        "T3 Code server is ready.",
        `Connection string: http://127.0.0.1:${port}`,
        `Token: ${token}`,
        `Pairing URL: http://127.0.0.1:${port}/pair#token=${token}`,
        "",
      ].join("\n"),
    );
  }

  /** Simulates the server dying out from under the bridge. */
  async die(): Promise<void> {
    await this.closeServer();
    this.exitResolve({ code: 1, reason: "exited" });
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  onOutput(
    listener: (output: PluginChildProcessOutput) => void,
  ): Promise<() => Promise<void>> {
    this.listeners.add(listener);
    // The real broker replays a child's buffered output to a new subscriber;
    // the bridge subscribes after spawn resolves and relies on it.
    for (const output of this.buffered) listener(output);
    return Promise.resolve(async () => {
      this.listeners.delete(listener);
    });
  }

  send(): Promise<void> {
    return Promise.resolve();
  }

  logs(): Promise<PluginChildProcessOutput[]> {
    return Promise.resolve([]);
  }

  wait(): Promise<PluginChildProcessExit> {
    return this.exitPromise;
  }

  async terminate(): Promise<PluginChildProcessExit> {
    this.terminated = true;
    await this.closeServer();
    this.exitResolve({ code: null, reason: "terminated" });
    return { code: null, reason: "terminated" };
  }
}

function portFromArgs(args: readonly string[] | undefined): number {
  const index = args?.indexOf("--port") ?? -1;
  const value = index >= 0 ? Number(args?.[index + 1]) : Number.NaN;
  if (!Number.isInteger(value)) throw new Error("spawn request carried no port");
  return value;
}

function createFakeBroker(bootModes: FakeBoot[]): {
  client: PluginChildProcessClient;
  spawns: FakeSpawn[];
} {
  const spawns: FakeSpawn[] = [];
  const client: PluginChildProcessClient = {
    async spawn(request) {
      const index = spawns.length;
      const child = new FakeT3Child(index);
      spawns.push({ request, child });
      const mode = bootModes[index] ?? "ready";
      await child.boot(mode, portFromArgs(request.args), `tok-secret-${index}`);
      return child;
    },
  };
  return { client, spawns };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
});

async function createFixture(bootModes: FakeBoot[] = ["ready"]): Promise<{
  ctx: T3BridgeContext;
  spawns: FakeSpawn[];
  logs: string[];
  bridge: ReturnType<typeof createT3Bridge>;
  stateRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dohc-t3-bridge-"));
  roots.push(root);
  const pluginRoot = join(root, "built");
  const stateRoot = join(root, "state");
  const workspaceRoot = join(root, "workspace");
  const packageDir = join(pluginRoot, "snapshot", "node_modules", "t3");
  await mkdir(join(packageDir, "dist"), { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "t3",
      version: T3_PINNED_VERSION,
      bin: { t3: "./dist/bin.mjs" },
    }),
  );
  await writeFile(join(packageDir, "dist", "bin.mjs"), "#!/usr/bin/env node\n");

  const { client, spawns } = createFakeBroker(bootModes);
  const logs: string[] = [];
  const ctx: T3BridgeContext = {
    pluginId: "t3-code",
    pluginRoot,
    workspaceRoot,
    stateRoot,
    childProcesses: client,
  };
  const bridge = createT3Bridge(ctx, {
    log: (line) => logs.push(line),
    readiness: { intervalMs: 5, requestTimeoutMs: 500, overallTimeoutMs: 5_000 },
  });
  return { ctx, spawns, logs, bridge, stateRoot };
}

describe("createT3Bridge", () => {
  it("spawns the pinned entry with the decided arguments, env, and workspace cwd", async () => {
    const { ctx, spawns, bridge } = await createFixture();
    await bridge.startWebApp(T3_WEB_APP_ID);

    expect(spawns).toHaveLength(1);
    const request = spawns[0]!.request;
    const port = portFromArgs(request.args);
    expect(request.modulePath).toBe(T3_ENTRY_MODULE_PATH);
    expect(request.args).toEqual([
      "serve",
      "--mode",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      join(ctx.stateRoot, "t3"),
      ctx.workspaceRoot,
    ]);
    expect(request.cwd).toEqual({ workspaceRoot: true });
    expect(request.env).toEqual({
      T3CODE_NO_BROWSER: "1",
      T3CODE_TELEMETRY_ENABLED: "false",
      NO_COLOR: "1",
    });
    await bridge.dispose();
  });

  it("hands the guest the pairing URL once, then the credential-free origin", async () => {
    const { spawns, bridge } = await createFixture();
    const first = await bridge.startWebApp(T3_WEB_APP_ID);
    const second = await bridge.startWebApp(T3_WEB_APP_ID);

    const port = portFromArgs(spawns[0]!.request.args);
    expect(first.url).toBe(`http://127.0.0.1:${port}/pair#token=tok-secret-0`);
    expect(second.url).toBe(`http://127.0.0.1:${port}/`);
    expect(spawns).toHaveLength(1);
    await bridge.dispose();
  });

  it("single-flights concurrent starts onto one server", async () => {
    const { spawns, bridge } = await createFixture();
    const [first, second] = await Promise.all([
      bridge.startWebApp(T3_WEB_APP_ID),
      bridge.startWebApp(T3_WEB_APP_ID),
    ]);
    expect(spawns).toHaveLength(1);
    // Exactly one of the two carries the one-time pairing credential.
    const pairing = [first.url, second.url].filter((url) => url.includes("#token="));
    expect(pairing).toHaveLength(1);
    await bridge.dispose();
  });

  it("never lets the pairing credential reach the log", async () => {
    const { logs, bridge } = await createFixture();
    const started = await bridge.startWebApp(T3_WEB_APP_ID);
    expect(started.url).toContain("tok-secret-0");

    const joined = logs.join("\n");
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).not.toContain("tok-secret-0");
    expect(joined).toContain("Token: [redacted]");
    expect(joined).toContain("#token=[redacted]");
    await bridge.dispose();
  });

  it("records ownership of the spawned server beside its state", async () => {
    const { spawns, bridge, stateRoot } = await createFixture();
    await bridge.startWebApp(T3_WEB_APP_ID);

    const owner = JSON.parse(
      await readFile(join(stateRoot, "t3-owner.json"), "utf8"),
    ) as { pid: number; port: number };
    expect(owner.pid).toBe(spawns[0]!.child.pid);
    expect(owner.port).toBe(portFromArgs(spawns[0]!.request.args));
    await bridge.dispose();
  });

  it("retries an early-exiting server with a fresh port, then succeeds", async () => {
    const { spawns, bridge } = await createFixture(["exit-early", "ready"]);
    const started = await bridge.startWebApp(T3_WEB_APP_ID);

    expect(spawns).toHaveLength(2);
    const firstPort = portFromArgs(spawns[0]!.request.args);
    const secondPort = portFromArgs(spawns[1]!.request.args);
    expect(secondPort).not.toBe(firstPort);
    expect(started.url).toContain(`:${secondPort}/pair`);
    await bridge.dispose();
  });

  it("gives up after three early exits with an error naming the attempts", async () => {
    const { spawns, bridge } = await createFixture([
      "exit-early",
      "exit-early",
      "exit-early",
    ]);
    await expect(bridge.startWebApp(T3_WEB_APP_ID)).rejects.toThrow("3 attempts");
    expect(spawns).toHaveLength(3);
  });

  it("destroys a server reporting any other version and reports the mismatch", async () => {
    const { spawns, bridge } = await createFixture(["wrong-version"]);
    await expect(bridge.startWebApp(T3_WEB_APP_ID)).rejects.toThrow("9.9.9");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.child.terminated).toBe(true);
  });

  it("respawns after the running server dies, issuing a fresh pairing URL", async () => {
    const { spawns, bridge } = await createFixture(["ready", "ready"]);
    const first = await bridge.startWebApp(T3_WEB_APP_ID);
    await spawns[0]!.child.die();
    // Let the exit propagate to the bridge's liveness tracking.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await bridge.startWebApp(T3_WEB_APP_ID);
    expect(spawns).toHaveLength(2);
    expect(second.url).toContain("#token=tok-secret-1");
    expect(second.url).not.toBe(first.url);
    await bridge.dispose();
  });

  it("removes a stale runtime file before starting", async () => {
    const { spawns, bridge, stateRoot } = await createFixture();
    const baseDir = join(stateRoot, "t3");
    await mkdir(join(baseDir, "userdata"), { recursive: true });
    const runtimePath = serverRuntimePath(baseDir);
    await writeFile(
      runtimePath,
      `${JSON.stringify({ version: 1, pid: 999_999_999, port: 1, origin: "http://127.0.0.1:1", startedAt: "x" })}\n`,
    );

    await bridge.startWebApp(T3_WEB_APP_ID);
    expect(existsSync(runtimePath)).toBe(false);
    expect(spawns).toHaveLength(1);
    await bridge.dispose();
  });

  it("terminates the server on dispose", async () => {
    const { spawns, bridge } = await createFixture();
    await bridge.startWebApp(T3_WEB_APP_ID);
    await bridge.dispose();
    expect(spawns[0]!.child.terminated).toBe(true);
    await expect(bridge.startWebApp(T3_WEB_APP_ID)).rejects.toThrow("deactivated");
  });

  it("rejects a web app id the manifest does not declare", async () => {
    const { spawns, bridge } = await createFixture();
    await expect(bridge.startWebApp("other")).rejects.toThrow('"other"');
    expect(spawns).toHaveLength(0);
  });
});
