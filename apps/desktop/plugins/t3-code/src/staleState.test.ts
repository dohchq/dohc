import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessStaleState,
  clearOwnerRecord,
  recoverStaleState,
  serverRuntimePath,
  writeOwnerRecord,
} from "./staleState";
import { T3_PINNED_VERSION } from "./t3Entry";

// The runtime-file shape a real t3@0.0.33 left behind after SIGTERM on
// Windows (2026-08-15): {"version":1,"pid":…,"host":"127.0.0.1","port":…,
// "origin":"http://127.0.0.1:…","startedAt":"…"}.
function realRuntimeShape(pid: number, port = 52835): Record<string, unknown> {
  return {
    version: 1,
    pid,
    host: "127.0.0.1",
    port,
    origin: `http://127.0.0.1:${port}`,
    startedAt: "2026-08-14T16:49:43.161Z",
  };
}

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all([
    ...roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
    ...servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  ]);
});

/** A real loopback listener on an ephemeral port. The probe runs against real
 * HTTP — a pid this plugin may signal is proven by what answers, not by an
 * injected boolean. */
async function listenOn(
  respond: (path: string) => { status: number; body: string },
): Promise<number> {
  const server = createServer((request, response) => {
    const answer = respond(request.url ?? "");
    response
      .writeHead(answer.status, { "content-type": "application/json" })
      .end(answer.body);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("the probe server did not bind a port");
  }
  return address.port;
}

const T3_ENVIRONMENT_PATH = "/.well-known/t3/environment";

function t3Server(version: string): (path: string) => {
  status: number;
  body: string;
} {
  return (path) =>
    path === T3_ENVIRONMENT_PATH
      ? { status: 200, body: JSON.stringify({ serverVersion: version }) }
      : { status: 404, body: "{}" };
}

/** A port nothing listens on: bound, then released. */
async function closedPort(): Promise<number> {
  const port = await listenOn(() => ({ status: 200, body: "{}" }));
  const server = servers.pop()!;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function createStateRoot(): Promise<{
  stateRoot: string;
  baseDir: string;
  ownerPath: string;
}> {
  const stateRoot = await mkdtemp(join(tmpdir(), "dohc-t3-stale-"));
  roots.push(stateRoot);
  const baseDir = join(stateRoot, "t3");
  await mkdir(join(baseDir, "userdata"), { recursive: true });
  return { stateRoot, baseDir, ownerPath: join(stateRoot, "t3-owner.json") };
}

describe("assessStaleState", () => {
  const owner = { pid: 4242, port: 52835 };

  it("does nothing without a runtime file", () => {
    expect(
      assessStaleState({ runtime: null, owner, isPidAlive: () => true }),
    ).toEqual({ action: "none" });
  });

  it("removes an undecodable runtime file", () => {
    expect(
      assessStaleState({
        runtime: { pid: "not-a-pid" },
        owner,
        isPidAlive: () => true,
      }),
    ).toEqual({ action: "remove-stale-file" });
  });

  it("removes the file when the recorded pid is dead", () => {
    expect(
      assessStaleState({
        runtime: realRuntimeShape(4242),
        owner,
        isPidAlive: () => false,
      }),
    ).toEqual({ action: "remove-stale-file" });
  });

  it("carries the owner's port so the caller can prove the pid before signalling", () => {
    expect(
      assessStaleState({
        runtime: realRuntimeShape(4242),
        owner,
        isPidAlive: (pid) => pid === 4242,
      }),
    ).toEqual({ action: "terminate-orphan", pid: 4242, port: 52835 });
  });

  it("never signals a live pid without an ownership match", () => {
    expect(
      assessStaleState({
        runtime: realRuntimeShape(4242),
        owner: { pid: 9999, port: 52835 },
        isPidAlive: () => true,
      }),
    ).toEqual({ action: "remove-stale-file" });
    expect(
      assessStaleState({
        runtime: realRuntimeShape(4242),
        owner: null,
        isPidAlive: () => true,
      }),
    ).toEqual({ action: "remove-stale-file" });
  });
});

describe("recoverStaleState", () => {
  it("removes a stale runtime file left by a dead server", async () => {
    const { baseDir, ownerPath } = await createStateRoot();
    const runtimePath = serverRuntimePath(baseDir);
    await writeFile(runtimePath, `${JSON.stringify(realRuntimeShape(4242))}\n`);
    await writeOwnerRecord(ownerPath, { pid: 4242, port: 52835 });

    const action = await recoverStaleState({
      baseDir,
      ownerPath,
      isPidAlive: () => false,
      killPid: () => {
        throw new Error("must not signal a dead pid");
      },
    });

    expect(action).toEqual({ action: "remove-stale-file" });
    expect(existsSync(runtimePath)).toBe(false);
  });

  it("terminates an owned orphan with SIGTERM, then SIGKILL after the grace", async () => {
    const { baseDir, ownerPath } = await createStateRoot();
    const port = await listenOn(t3Server(T3_PINNED_VERSION));
    await writeFile(
      serverRuntimePath(baseDir),
      `${JSON.stringify(realRuntimeShape(4242, port))}\n`,
    );
    await writeOwnerRecord(ownerPath, { pid: 4242, port });
    const signals: Array<[number, NodeJS.Signals]> = [];

    const action = await recoverStaleState({
      baseDir,
      ownerPath,
      isPidAlive: (pid) => pid === 4242, // Ignores SIGTERM.
      killPid: (pid, signal) => signals.push([pid, signal]),
      waitMs: () => Promise.resolve(),
      graceMs: 50,
    });

    expect(action).toEqual({ action: "terminate-orphan", pid: 4242, port });
    expect(signals[0]).toEqual([4242, "SIGTERM"]);
    expect(signals.at(-1)).toEqual([4242, "SIGKILL"]);
    expect(existsSync(serverRuntimePath(baseDir))).toBe(false);
  });

  it("stops at SIGTERM when the orphan exits within the grace", async () => {
    const { baseDir, ownerPath } = await createStateRoot();
    const port = await listenOn(t3Server(T3_PINNED_VERSION));
    await writeFile(
      serverRuntimePath(baseDir),
      `${JSON.stringify(realRuntimeShape(4242, port))}\n`,
    );
    await writeOwnerRecord(ownerPath, { pid: 4242, port });
    let alive = true;
    const signals: NodeJS.Signals[] = [];

    await recoverStaleState({
      baseDir,
      ownerPath,
      isPidAlive: () => alive,
      killPid: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGTERM") alive = false;
      },
      waitMs: () => Promise.resolve(),
      graceMs: 50,
    });

    expect(signals).toEqual(["SIGTERM"]);
  });

  // A1: pid reuse is the routine case after a reboot — the runtime file and
  // the owner record both name pid N, and N now belongs to something else.
  // Each case below is a live, ownership-matching pid whose port fails to
  // vouch for it.
  it.each([
    ["the port answers, but not as t3", () => listenOn(() => ({ status: 404, body: "{}" }))],
    ["the port answers as another t3 release", () => listenOn(t3Server("9.9.9"))],
    ["nothing listens on the port at all", closedPort],
  ])("never signals a matching pid when %s", async (_case, portOf) => {
    const { baseDir, ownerPath } = await createStateRoot();
    const port = await portOf();
    const runtimePath = serverRuntimePath(baseDir);
    await writeFile(runtimePath, `${JSON.stringify(realRuntimeShape(4242, port))}\n`);
    await writeOwnerRecord(ownerPath, { pid: 4242, port });
    const signals: Array<[number, NodeJS.Signals]> = [];

    const action = await recoverStaleState({
      baseDir,
      ownerPath,
      isPidAlive: () => true,
      killPid: (pid, signal) => signals.push([pid, signal]),
      waitMs: () => Promise.resolve(),
      graceMs: 50,
    });

    // MUTATION (drop the probe): the pid is alive and recorded, so without
    // the probe this SIGTERMs and then SIGKILLs an unrelated process.
    expect(signals).toEqual([]);
    expect(action).toEqual({ action: "remove-stale-file" });
    expect(existsSync(runtimePath)).toBe(false);
  });

  it("clears the owner record so a routine exit leaves no armed pid", async () => {
    const { baseDir, ownerPath } = await createStateRoot();
    await writeOwnerRecord(ownerPath, { pid: 4242, port: 52835 });
    await clearOwnerRecord(ownerPath);
    expect(existsSync(ownerPath)).toBe(false);

    // With no record, a live runtime pid is never this plugin's to signal.
    await writeFile(
      serverRuntimePath(baseDir),
      `${JSON.stringify(realRuntimeShape(4242))}\n`,
    );
    const action = await recoverStaleState({
      baseDir,
      ownerPath,
      isPidAlive: () => true,
      killPid: () => {
        throw new Error("must not signal an unowned pid");
      },
    });
    expect(action).toEqual({ action: "remove-stale-file" });
  });

  it("does nothing on a clean state directory", async () => {
    const { baseDir, ownerPath } = await createStateRoot();
    const action = await recoverStaleState({
      baseDir,
      ownerPath,
      isPidAlive: () => true,
      killPid: () => {
        throw new Error("must not signal anything");
      },
    });
    expect(action).toEqual({ action: "none" });
  });

  it("round-trips the owner record it writes", async () => {
    const { ownerPath } = await createStateRoot();
    await writeOwnerRecord(ownerPath, { pid: 77, port: 1234 });
    expect(JSON.parse(await readFile(ownerPath, "utf8"))).toEqual({
      pid: 77,
      port: 1234,
    });
  });
});
