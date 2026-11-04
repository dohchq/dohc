import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startEngineProjection,
  type EngineProjectionOptions,
} from "./engineProjection";
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const limits = {
  maxFrameBytes: 14 * 1024 * 1024,
  maxStringBytes: 14 * 1024 * 1024,
  maxCollectionLen: 16384,
  maxJsonDepth: 32,
  maxBatchLen: 64,
  maxBlobChunkBytes: 262144,
};
function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(12);
  header.write("DOP1");
  header[4] = 1;
  header.writeUInt32LE(payload.length, 8);
  return Buffer.concat([header, payload]);
}
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  requests: {
    id: number;
    method: string;
    params: { contentKind?: string; updatesBase64?: string[] };
  }[] = [];
  manualExit = false;
  mode = "projection-only";
  kill = vi.fn((_signal?: NodeJS.Signals) => {
    if (!this.manualExit) this.finish(0, "SIGKILL");
    return true;
  });
  constructor() {
    super();
    let pending = Buffer.alloc(0);
    this.stdin.on("data", (data: Buffer) => {
      pending = Buffer.concat([pending, data]);
      while (
        pending.length >= 12 &&
        pending.length >= 12 + pending.readUInt32LE(8)
      ) {
        const length = pending.readUInt32LE(8);
        const row = JSON.parse(
          pending.subarray(12, 12 + length).toString(),
        ) as {
          type: string;
          id: number;
          method: string;
          params: { contentKind?: string; updatesBase64?: string[] };
        };
        pending = pending.subarray(12 + length);
        if (row.type === "hello")
          this.stdout.write(
            frame({
              type: "helloAck",
              protocolVersion: 2,
              sessionGeneration: 1,
              capabilities: ["projection-only"],
              limits,
            }),
          );
        else if (row.method === "engine.ping")
          this.stdout.write(
            frame({
              type: "response",
              id: row.id,
              result: { ok: true, mode: this.mode },
            }),
          );
        else {
          this.requests.push(row);
          if (row.params.updatesBase64?.[0] === "AAA=") {
            this.reply("");
          }
        }
      }
    });
  }
  reply(text: string) {
    const request = this.requests.shift()!;
    this.stdout.write(
      frame({
        type: "response",
        id: request.id,
        result: {
          contentBase64: Buffer.from(text).toString("base64"),
          sourceStateVectorSha256: "a".repeat(64),
        },
      }),
    );
    if (!this.manualExit) setImmediate(() => this.finish());
  }
  finish(code = 0, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = signal ? null : code;
    this.signalCode = signal;
    this.emit("exit", this.exitCode, signal);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", this.exitCode, signal);
  }
}
async function harness(overrides: Partial<EngineProjectionOptions> = {}) {
  const path = await mkdtemp(join(tmpdir(), "dohc-projection-"));
  roots.push(path);
  const engineExecutable = join(path, "engine");
  await writeFile(engineExecutable, "engine one");
  const children: FakeChild[] = [];
  const launches: {
    command: string;
    args: readonly string[];
    options: SpawnOptionsWithoutStdio;
  }[] = [];
  const options: EngineProjectionOptions = {
    engineExecutable,
    platform: "linux",
    deadlineMs: 30_000,
    maxQueued: 1,
    maxQueuedBytes: 3000,
    spawnChild(command, args, options) {
      launches.push({ command, args, options });
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    ...overrides,
  };
  const service = await startEngineProjection(options);
  const pending = async () => {
    await expect
      .poll(
        () => {
          const child = children.at(-1);
          return child?.exitCode === null && child?.signalCode === null
            ? child.requests.length
            : 0;
        },
        { timeout: 30_000 },
      )
      .toBe(1);
    return children.at(-1)!;
  };
  return { service, children, launches, pending, engineExecutable };
}
const input = {
  contentKind: "plaintext" as const,
  updates: [new Uint8Array([1])],
};
describe("isolated engine projection", () => {
  it("starts a dedicated Linux child with an empty environment and bounded address space", async () => {
    const h = await harness();
    expect(h.launches[0]).toEqual({
      command: "/bin/sh",
      args: [
        "-c",
        'ulimit -v "$1" && exec /usr/bin/env -i "$0" --projection-only',
        h.engineExecutable,
        "4194304",
      ],
      options: { env: {}, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    });
    const result = h.service.project(input);
    const child = await h.pending();
    child.reply("Text");
    expect(await result).toMatchObject({
      kind: "projected",
      content: Buffer.from("Text"),
      engineSha256: h.service.engineSha256,
    });
    await h.service.close();
  });
  it.each(["win32", "darwin"] as const)(
    "refuses %s without explicit development opt-in",
    async (platform) => {
      await expect(
        startEngineProjection({ engineExecutable: "unused", platform }),
      ).rejects.toThrow(/requires Linux/);
      const h = await harness({ platform, allowUnisolatedProjection: true });
      expect(h.launches[0]!.command).toBe(h.engineExecutable);
      expect(h.launches[0]!.args).toEqual(["--projection-only"]);
      expect(h.launches[0]!.options.env).toEqual({});
      await h.service.close();
    },
  );
  it("bounds input before spawning or queueing", async () => {
    const h = await harness();
    expect(
      await h.service.project({
        ...input,
        updates: Array.from({ length: 16385 }, () => new Uint8Array(1)),
      }),
    ).toMatchObject({ kind: "refused", reason: "too-large" });
    expect(
      await h.service.project({
        ...input,
        updates: [new Uint8Array(11 * 1024 * 1024)],
      }),
    ).toMatchObject({ kind: "refused", reason: "too-large" });
    expect(h.children).toHaveLength(1);
    await h.service.close();
  });
  it("holds one slot until exit, bounds the queue, and copies accepted input", async () => {
    const h = await harness();
    const first = h.service.project(input);
    const child = await h.pending();
    child.manualExit = true;
    const update = new Uint8Array([2]);
    const second = h.service.project({ ...input, updates: [update] });
    update[0] = 9;
    expect(await h.service.project(input)).toMatchObject({
      kind: "refused",
      reason: "busy",
    });
    child.reply("one");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.children).toHaveLength(2);
    child.finish();
    expect(await first).toMatchObject({ kind: "projected" });
    const next = await h.pending();
    expect(next.requests[0]!.params.updatesBase64).toEqual(["Ag=="]);
    next.reply("two");
    expect(await second).toMatchObject({ kind: "projected" });
    await h.service.close();
  });
  it("reads a final response after process exit and keeps capacity until stdio closes", async () => {
    const h = await harness();
    const first = h.service.project(input);
    const child = await h.pending();
    child.manualExit = true;
    const queued = h.service.project(input);
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.children).toHaveLength(2);
    child.reply("final stdout");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
    expect(await first).toMatchObject({
      kind: "projected",
      content: Buffer.from("final stdout"),
    });
    (await h.pending()).reply("next");
    expect(await queued).toMatchObject({ kind: "projected" });
    await h.service.close();
  });
  it("bounds queued bytes independently of queued job count", async () => {
    const h = await harness({ maxQueued: 32, maxQueuedBytes: 1200 });
    const first = h.service.project(input);
    const child = await h.pending();
    expect(
      await h.service.project({ ...input, updates: [new Uint8Array(256)] }),
    ).toMatchObject({ kind: "refused", reason: "busy" });
    expect(h.children).toHaveLength(2);
    child.reply("done");
    await first;
    await h.service.close();
  });
  it("aborted callers cannot free capacity before their killed child exits", async () => {
    const h = await harness();
    const controller = new AbortController();
    const first = h.service.project(input, controller.signal);
    const child = await h.pending();
    child.manualExit = true;
    controller.abort();
    expect(await first).toMatchObject({ reason: "cancelled" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    const next = h.service.project(input);
    expect(h.children).toHaveLength(2);
    child.finish(0, "SIGKILL");
    const second = await h.pending();
    second.reply("next");
    expect(await next).toMatchObject({ kind: "projected" });
    await h.service.close();
  });
  it("kills only its owned child on the deadline", async () => {
    const timed = await harness({ deadlineMs: 2000 });
    const late = timed.service.project(input);
    const held = await timed.pending();
    expect(await late).toMatchObject({ kind: "refused", reason: "timeout" });
    expect(held.kill).toHaveBeenCalledWith("SIGKILL");
    await timed.service.close();
  });
  it("closes active and queued jobs and refuses future calls", async () => {
    const h = await harness();
    const first = h.service.project(input);
    await h.pending();
    const queued = h.service.project(input);
    await h.service.close();
    await first;
    expect(await queued).toMatchObject({ reason: "unavailable" });
    expect(await h.service.project(input)).toMatchObject({
      reason: "unavailable",
    });
  });
  it("refuses output above 2 MiB and executable replacement", async () => {
    const h = await harness();
    const big = h.service.project(input);
    (await h.pending()).reply("x".repeat(2 * 1024 * 1024 + 1));
    expect(await big).toMatchObject({ reason: "invalid" });
    await writeFile(h.engineExecutable, "engine two");
    expect(await h.service.project(input)).toMatchObject({
      reason: "unavailable",
    });
    await h.service.close();
  });
});
