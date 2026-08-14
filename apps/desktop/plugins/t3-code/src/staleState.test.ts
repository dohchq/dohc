import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessStaleState,
  recoverStaleState,
  serverRuntimePath,
  writeOwnerRecord,
} from "./staleState";

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

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
});

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
  const owner = { pid: 4242, port: 52835, startedAt: "" };

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

  it("terminates a live pid this plugin recorded as its own", () => {
    expect(
      assessStaleState({
        runtime: realRuntimeShape(4242),
        owner,
        isPidAlive: (pid) => pid === 4242,
      }),
    ).toEqual({ action: "terminate-orphan", pid: 4242 });
  });

  it("never signals a live pid without an ownership match", () => {
    expect(
      assessStaleState({
        runtime: realRuntimeShape(4242),
        owner: { pid: 9999, port: 52835, startedAt: "" },
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
    await writeOwnerRecord(ownerPath, { pid: 4242, port: 52835, startedAt: "" });

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
    await writeFile(
      serverRuntimePath(baseDir),
      `${JSON.stringify(realRuntimeShape(4242))}\n`,
    );
    await writeOwnerRecord(ownerPath, { pid: 4242, port: 52835, startedAt: "" });
    const signals: Array<[number, NodeJS.Signals]> = [];

    const action = await recoverStaleState({
      baseDir,
      ownerPath,
      isPidAlive: (pid) => pid === 4242, // Ignores SIGTERM.
      killPid: (pid, signal) => signals.push([pid, signal]),
      waitMs: () => Promise.resolve(),
      graceMs: 50,
    });

    expect(action).toEqual({ action: "terminate-orphan", pid: 4242 });
    expect(signals[0]).toEqual([4242, "SIGTERM"]);
    expect(signals.at(-1)).toEqual([4242, "SIGKILL"]);
    expect(existsSync(serverRuntimePath(baseDir))).toBe(false);
  });

  it("stops at SIGTERM when the orphan exits within the grace", async () => {
    const { baseDir, ownerPath } = await createStateRoot();
    await writeFile(
      serverRuntimePath(baseDir),
      `${JSON.stringify(realRuntimeShape(4242))}\n`,
    );
    await writeOwnerRecord(ownerPath, { pid: 4242, port: 52835, startedAt: "" });
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
    await writeOwnerRecord(ownerPath, {
      pid: 77,
      port: 1234,
      startedAt: "2026-08-15T00:00:00.000Z",
    });
    expect(JSON.parse(await readFile(ownerPath, "utf8"))).toEqual({
      pid: 77,
      port: 1234,
      startedAt: "2026-08-15T00:00:00.000Z",
    });
  });
});
