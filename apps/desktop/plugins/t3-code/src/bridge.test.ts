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

type FakeBoot =
  | "ready"
  | "ready-split-token"
  | "exit-early"
  | "exit-before-subscribe"
  | "exit-split-token"
  | "wrong-version"
  // A server this plugin must destroy and cannot: the broker's terminate
  // gives up, and the process keeps the port and the workspace's t3 refs.
  | "wrong-version-unkillable";

// A real stream chunk boundary can fall anywhere. The worst place for the
// log path is inside the word `Token`, because that word is the redaction
// anchor: "Tok" + "en: <credential>" defeats every per-chunk redaction.
function cutInsideTokenWord(text: string): [string, string] {
  const cut = text.indexOf("Token:") + 3;
  return [text.slice(0, cut), text.slice(cut)];
}

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
  private exited = false;
  /** A child that dies the moment the bridge starts listening. The
   * subscription lands, and the readiness poll is what notices the exit. */
  private exitOnSubscribe = false;
  /** The broker's terminate gives up on this child: it exceeded the stop
   * grace and the force kill did not take. */
  private unkillable = false;

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
      this.exitOnSubscribe = true;
      return;
    }
    if (mode === "exit-before-subscribe") {
      // The same lost bind, one instant earlier: the child is already gone
      // when the spawn call returns, so the broker refuses the subscription.
      this.emit("bind failed: EADDRINUSE\n");
      this.finishExit();
      return;
    }
    if (mode === "exit-split-token") {
      // Prints its credential, then dies before binding. The last line has no
      // newline: the buffer only sees it when the child's exit flushes it.
      for (const chunk of cutInsideTokenWord(`starting\nToken: ${token}`)) {
        this.emit(chunk);
      }
      this.exitOnSubscribe = true;
      return;
    }
    const wrongVersion =
      mode === "wrong-version" || mode === "wrong-version-unkillable";
    this.unkillable = mode === "wrong-version-unkillable";
    const serverVersion = wrongVersion ? "9.9.9" : T3_PINNED_VERSION;
    this.server = createServer((_request, response) => {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ serverVersion }));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
    const accessBlock = [
      "T3 Code server is ready.",
      `Connection string: http://127.0.0.1:${port}`,
      `Token: ${token}`,
      `Pairing URL: http://127.0.0.1:${port}/pair#token=${token}`,
      "",
    ].join("\n");
    if (mode === "ready-split-token") {
      for (const chunk of cutInsideTokenWord(accessBlock)) this.emit(chunk);
      return;
    }
    this.emit(accessBlock);
  }

  /** Simulates the server dying out from under the bridge. */
  async die(): Promise<void> {
    await this.closeServer();
    this.finishExit();
  }

  private finishExit(exit: PluginChildProcessExit = { code: 1, reason: "exited" }): void {
    this.exited = true;
    this.exitResolve(exit);
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
    // The broker's own contract: subscribe() asserts the child is live and
    // throws for one that already exited (pluginChildProcessBroker.ts). A fake
    // that accepts the subscription anyway certifies a broker that does not
    // exist.
    if (this.exited) {
      return Promise.reject(new Error(`Child process "${this.id}" has exited.`));
    }
    this.listeners.add(listener);
    // The real broker replays a child's buffered output to a new subscriber;
    // the bridge subscribes after spawn resolves and relies on it.
    for (const output of this.buffered) listener(output);
    if (this.exitOnSubscribe) {
      this.exitOnSubscribe = false;
      this.finishExit();
    }
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
    if (this.unkillable) {
      throw new Error(`Child process "${this.id}" did not exit within 5000 ms.`);
    }
    await this.closeServer();
    this.finishExit({ code: null, reason: "terminated" });
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

async function createFixture(
  bootModes: FakeBoot[] = ["ready"],
  overrides: { fetchFn?: typeof fetch } = {},
): Promise<{
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
    pluginRoot,
    workspaceRoot,
    stateRoot,
    childProcesses: client,
  };
  const bridge = createT3Bridge(ctx, {
    log: (line) => logs.push(line),
    readiness: {
      intervalMs: 5,
      requestTimeoutMs: 500,
      overallTimeoutMs: 5_000,
      ...overrides,
    },
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

  it("redacts a credential whose line arrives split inside the word Token", async () => {
    const { logs, bridge } = await createFixture(["ready-split-token"]);
    const started = await bridge.startWebApp(T3_WEB_APP_ID);
    expect(started.url).toContain("tok-secret-0");

    // MUTATION (per-chunk logging): redacting each chunk instead of each
    // complete line logs "en: tok-secret-0" verbatim — the anchor word sits
    // in the previous chunk.
    const joined = logs.join("\n");
    expect(joined).not.toContain("tok-secret-0");
    expect(joined).not.toContain("secret");
    expect(joined).toContain("Token: [redacted]");
    expect(joined).toContain("#token=[redacted]");
    await bridge.dispose();
  });

  it("keeps a split credential out of the spawn-failure error the renderer sees", async () => {
    const { logs, bridge } = await createFixture([
      "exit-split-token",
      "exit-split-token",
      "exit-split-token",
    ]);
    const error = await bridge
      .startWebApp(T3_WEB_APP_ID)
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("3 attempts");
    // The unterminated last line only reaches the log through the exit
    // flush, and it must arrive redacted.
    expect(message).toContain("Token: [redacted]");
    for (const index of [0, 1, 2]) {
      expect(message).not.toContain(`tok-secret-${index}`);
      expect(logs.join("\n")).not.toContain(`tok-secret-${index}`);
    }
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

  it("leaves no armed record behind when every attempt fails", async () => {
    const { bridge, stateRoot } = await createFixture([
      "exit-early",
      "exit-early",
      "exit-early",
    ]);
    await expect(bridge.startWebApp(T3_WEB_APP_ID)).rejects.toThrow("3 attempts");

    // MUTATION (keep the record whatever the attempt did): the last attempt's
    // dead pid stays armed on disk, and the next start would consider
    // signalling a number the operating system is free to reuse.
    expect(existsSync(join(stateRoot, "t3-owner.json"))).toBe(false);
  });

  it("keeps the record armed for a failed attempt it could not end", async () => {
    const { spawns, bridge, stateRoot } = await createFixture([
      "wrong-version-unkillable",
    ]);
    await expect(bridge.startWebApp(T3_WEB_APP_ID)).rejects.toThrow("9.9.9");

    // MUTATION (clear on every failure): this server survived the terminate
    // and still holds the port and the workspace's checkpoint refs. With no
    // record the next start reads no owner, so recovery only deletes the
    // runtime file and leaves the orphan running.
    const owner = JSON.parse(
      await readFile(join(stateRoot, "t3-owner.json"), "utf8"),
    ) as { pid: number; port: number };
    expect(owner.pid).toBe(spawns[0]!.child.pid);
    expect(owner.port).toBe(portFromArgs(spawns[0]!.request.args));
  });

  it("counts a child that exits before the subscription as a failed attempt", async () => {
    const { spawns, bridge } = await createFixture([
      "exit-before-subscribe",
      "exit-before-subscribe",
      "exit-before-subscribe",
    ]);
    const error = await bridge
      .startWebApp(T3_WEB_APP_ID)
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    // MUTATION (let the refused subscription escape spawnAttempt): the retry
    // loop collapses to one attempt and the user reads a broker internal —
    // `Child process "child-0" has exited.` — for a race the retry exists to
    // absorb.
    expect(spawns).toHaveLength(3);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("3 attempts");
    expect((error as Error).message).not.toContain("has exited");
  });

  it("recovers on the next attempt after a child exits before the subscription", async () => {
    const { spawns, bridge } = await createFixture(["exit-before-subscribe", "ready"]);
    const started = await bridge.startWebApp(T3_WEB_APP_ID);

    expect(spawns).toHaveLength(2);
    expect(started.url).toContain(`:${portFromArgs(spawns[1]!.request.args)}/pair`);
    await bridge.dispose();
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

  it("clears the owner record on dispose, leaving no armed pid behind", async () => {
    const { bridge, stateRoot } = await createFixture();
    const ownerPath = join(stateRoot, "t3-owner.json");
    await bridge.startWebApp(T3_WEB_APP_ID);
    expect(existsSync(ownerPath)).toBe(true);

    // MUTATION (drop the clear): every clean session then leaves a record
    // naming a pid the operating system is free to reuse.
    await bridge.dispose();
    expect(existsSync(ownerPath)).toBe(false);
  });

  it("rejects a web app id the manifest does not declare", async () => {
    const { spawns, bridge } = await createFixture();
    await expect(bridge.startWebApp("other")).rejects.toThrow('"other"');
    expect(spawns).toHaveLength(0);
  });

  it("arms the ownership record at spawn, before the server answers ready", async () => {
    const armedAtReadiness: boolean[] = [];
    let ownerPath = "";
    const fixture = await createFixture(["ready"], {
      fetchFn: ((url: RequestInfo | URL, init?: RequestInit) => {
        armedAtReadiness.push(existsSync(ownerPath));
        return fetch(url, init);
      }) as typeof fetch,
    });
    ownerPath = join(fixture.stateRoot, "t3-owner.json");

    await fixture.bridge.startWebApp(T3_WEB_APP_ID);

    // MUTATION (write the record after readiness instead): the first probe
    // finds no record, which is exactly the window a crash turns into a live
    // orphan no later start may signal — it reads no owner, so it deletes the
    // stale file and leaves the server holding the workspace's t3 refs.
    expect(armedAtReadiness[0]).toBe(true);
    await fixture.bridge.dispose();
  });

  it("un-pairs on stopWebApp, so the next open reaches a fresh server", async () => {
    const { spawns, bridge, stateRoot } = await createFixture(["ready", "ready"]);
    const ownerPath = join(stateRoot, "t3-owner.json");
    const first = await bridge.startWebApp(T3_WEB_APP_ID);
    expect(first.url).toContain("#token=tok-secret-0");
    // Paired. Every later open in this session rides the guest's cookie —
    // which is exactly the state a guest that never arrived strands.
    expect((await bridge.startWebApp(T3_WEB_APP_ID)).url).not.toContain("#token=");

    await bridge.stopWebApp(T3_WEB_APP_ID);
    expect(spawns[0]!.child.terminated).toBe(true);
    expect(existsSync(ownerPath)).toBe(false);

    // MUTATION (the bridge ignores the stop): the reopen returns the paired
    // origin into a cookie-less guest, and only disable/re-enable recovers.
    const reopened = await bridge.startWebApp(T3_WEB_APP_ID);
    expect(spawns).toHaveLength(2);
    expect(reopened.url).toContain("#token=tok-secret-1");
    expect(existsSync(ownerPath)).toBe(true);
    await bridge.dispose();
  });

  it("rejects a stop for a web app id the manifest does not declare", async () => {
    const { spawns, bridge } = await createFixture();
    await bridge.startWebApp(T3_WEB_APP_ID);
    await expect(bridge.stopWebApp("other")).rejects.toThrow('"other"');
    expect(spawns[0]!.child.terminated).toBe(false);
    await bridge.dispose();
  });
});
