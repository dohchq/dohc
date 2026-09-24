import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EngineClientError,
  EngineRequestDeadlineError,
  EngineRequestError,
  type EngineClientSpawnOptions,
} from "@dohc/workspace-engine-client/daemon";
import type { Request, Response } from "@dohc/workspace-engine-client";
import { startEngineProjection, type EngineProjectionOptions } from "./engineProjection";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function executable(): string {
  const directory = mkdtempSync(join(tmpdir(), "engine-projection-"));
  directories.push(directory);
  const path = join(directory, "engine");
  writeFileSync(path, "engine build one");
  return path;
}

const content = "# Plan\n";
const answer = (request: Request): Response => ({ id: request.id, result: {
  contentBase64: Buffer.from(content).toString("base64"), sourceStateVectorSha256: "a".repeat(64) } });
const limits = { maxFrameBytes: 8 * 1024 * 1024, maxBlobChunkBytes: 262_144, maxStringBytes: 8 * 1024 * 1024,
  maxCollectionLen: 16_384, maxBatchLen: 64, maxJsonDepth: 32 };

/** A stand-in engine child. It answers the startup probes; every projection waits until the test settles it. */
class FakeEngine {
  readonly requests: { request: Request; resolve: (response: Response) => void; reject: (error: unknown) => void }[] = [];
  readonly helloAck = { type: "helloAck" as const, protocolVersion: 2, sessionGeneration: 1, capabilities: [], limits };
  closes = 0;
  kills = 0;
  private exit!: () => void;
  private readonly exited = new Promise<void>(resolve => { this.exit = resolve; });
  constructor(readonly options: EngineClientSpawnOptions, private readonly probes: "answer" | "missing-method" = "answer") {}
  sendRequest(request: Request): Promise<Response> {
    if (request.method === "engine.ping") return Promise.resolve({ id: request.id, result: { ok: true } });
    if (request.method === "ydoc.project" && !(request.params as { contentKind?: unknown }).contentKind) {
      return Promise.reject(new EngineRequestError(request.id, this.probes === "answer"
        ? { code: "INVALID_PARAMS", message: "invalid parameters", retry: "no" }
        : { code: "METHOD_NOT_FOUND", message: "unknown method", retry: "no" }));
    }
    return new Promise((resolve, reject) => this.requests.push({ request, resolve, reject }));
  }
  close(): void { this.closes += 1; this.stop(new EngineClientError("closed", "The engine client was closed.")); }
  closeUnresponsive(): void { this.kills += 1; this.stop(new EngineClientError("transport-error", "The engine was killed.")); }
  waitForExit(): Promise<void> { return this.exited; }
  /** The child dies with its requests unanswered. */
  crash(): void {
    this.stop(new EngineClientError("transport-error", "The engine sidecar exited with code 3."));
    this.options.onExit?.(3, null);
  }
  answerNext(): void {
    const next = this.requests.shift()!;
    next.resolve(answer(next.request));
  }
  private stop(error: EngineClientError): void {
    for (const pending of this.requests.splice(0)) pending.reject(error);
    this.exit();
  }
}

async function harness(overrides: Partial<EngineProjectionOptions> = {}) {
  const engines: FakeEngine[] = [];
  let clock = 0;
  const path = overrides.engineExecutable ?? executable();
  const projection = await startEngineProjection({ engineExecutable: path, maxInFlight: 2, maxQueued: 4, maxQueuedBytes: 1_000_000,
    deadlineMs: 1_000, connectTimeoutMs: 1_000, restartBackoffMs: { initial: 100, max: 400 }, maxAddressSpaceBytes: 1024 * 1024 * 1024,
    now: () => clock,
    async launch(options) {
      const engine = new FakeEngine(options);
      engines.push(engine);
      return engine;
    }, ...overrides });
  // Resolves once the numbered engine holds that many unanswered projections.
  const pending = async (engine: number, count: number) => {
    while ((engines[engine]?.requests.length ?? 0) < count) await new Promise(resolve => setImmediate(resolve));
    return engines[engine]!;
  };
  return { projection, engines, pending, path, advance(ms: number) { clock += ms; } };
}

const input = { contentKind: "richdoc" as const, updates: [new Uint8Array([1, 2, 3])] };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

describe("engine projection", () => {
  it("starts one engine with no relay environment, probes it, and records the executable's digest", async () => {
    const { projection, engines, pending, path } = await harness();
    expect(engines).toHaveLength(1);
    const { options } = engines[0]!;
    expect(options).toMatchObject({ inheritEnvironment: false, protocolVersion: 2, capabilities: [] });
    expect(Object.keys(options.env ?? {})).toEqual(process.platform === "win32" ? ["SystemRoot"] : ["MALLOC_ARENA_MAX"]);
    if (process.platform === "win32") expect(options.command).toBe(path);
    else expect(options).toMatchObject({ command: "/bin/sh", args: ["-c", 'ulimit -v "$1" && exec "$0"', path, "1048576"] });
    expect(projection.engineSha256).toBe(hash("engine build one"));
    for (let call = 0; call < 2; call += 1) {
      const result = projection.project(input);
      (await pending(0, 1)).answerNext();
      expect(await result).toEqual({ kind: "projected", content: Buffer.from(content), sha256: hash(content),
        sourceStateVectorSha256: "a".repeat(64), engineSha256: hash("engine build one") });
    }
    expect(engines).toHaveLength(1);
    await projection.close();
    expect(engines[0]!.closes).toBeGreaterThan(0);
  });

  it("refuses to start an engine that lacks ydoc.project, and ends it", async () => {
    const engines: FakeEngine[] = [];
    await expect(startEngineProjection({ engineExecutable: executable(), maxInFlight: 1, maxQueued: 0, maxQueuedBytes: 1,
      deadlineMs: 1, connectTimeoutMs: 1, restartBackoffMs: { initial: 1, max: 1 }, maxAddressSpaceBytes: 1,
      async launch(options) { const engine = new FakeEngine(options, "missing-method"); engines.push(engine); return engine; } }))
      .rejects.toThrow(/did not start\. It does not provide ydoc\.project/);
    expect(engines[0]!.closes).toBeGreaterThan(0);
  });

  it("sends the updates to ydoc.project with its deadline", async () => {
    const { projection, pending } = await harness();
    const result = projection.project({ contentKind: "plaintext", updates: [new Uint8Array([1, 2]), new Uint8Array([3])] });
    const engine = await pending(0, 1);
    expect(engine.requests[0]!.request).toMatchObject({ method: "ydoc.project", deadlineMs: 1_000,
      params: { contentKind: "plaintext", updatesBase64: ["AQI=", "Aw=="] } });
    engine.answerNext();
    expect(await result).toMatchObject({ kind: "projected" });
    await projection.close();
  });

  it("refuses more updates than one engine request carries before it encodes or queues them", async () => {
    const { projection, engines } = await harness({ maxInFlight: 1, maxQueued: 0 });
    const tooMany = { contentKind: "richdoc" as const, updates: Array.from({ length: limits.maxCollectionLen + 1 }, () => new Uint8Array(1)) };
    expect(await projection.project(tooMany)).toMatchObject({ kind: "refused", reason: "too-large",
      message: expect.stringContaining(`at most ${limits.maxCollectionLen}`) });
    const tooBig = { contentKind: "richdoc" as const, updates: [new Uint8Array(4 * 1024 * 1024), new Uint8Array(3 * 1024 * 1024)] };
    expect(await projection.project(tooBig)).toMatchObject({ kind: "refused", reason: "too-large",
      message: expect.stringContaining(`at most ${limits.maxFrameBytes}`) });
    expect(engines[0]!.requests).toHaveLength(0);
    await projection.close();
  });

  it("refuses work beyond its slots, queue places and queued bytes, then admits a waiter when a slot frees", async () => {
    const { projection, pending } = await harness({ maxInFlight: 1, maxQueued: 2, maxQueuedBytes: 3_000 });
    const running = projection.project(input);
    const engine = await pending(0, 1);
    const queued = projection.project(input);
    expect(await projection.project({ contentKind: "richdoc", updates: [new Uint8Array(2_000)] })).toMatchObject({ kind: "refused", reason: "busy" });
    engine.answerNext();
    expect(await running).toMatchObject({ kind: "projected" });
    (await pending(0, 1)).answerNext();
    expect(await queued).toMatchObject({ kind: "projected" });
    await projection.close();
  });

  it("lets an aborted caller go but keeps its slot until the engine answers", async () => {
    const { projection, pending } = await harness({ maxInFlight: 1, maxQueued: 1 });
    const controller = new AbortController();
    const abandoned = projection.project(input, controller.signal);
    const engine = await pending(0, 1);
    controller.abort(new Error("reader left"));
    await expect(abandoned).rejects.toThrow("reader left");
    const next = projection.project(input);
    for (let turn = 0; turn < 10; turn += 1) await new Promise(resolve => setImmediate(resolve));
    expect(engine.requests).toHaveLength(1);
    engine.answerNext();
    (await pending(0, 1)).answerNext();
    expect(await next).toMatchObject({ kind: "projected" });
    await projection.close();
  });

  it("keeps a crash in the child and starts a fresh one after a growing delay", async () => {
    const { projection, engines, pending, advance } = await harness();
    const crashed = projection.project(input);
    (await pending(0, 1)).crash();
    expect(await crashed).toMatchObject({ kind: "refused", reason: "unavailable" });
    expect(await projection.project(input)).toMatchObject({ kind: "refused", reason: "unavailable", message: expect.stringContaining("starts again in 100 ms") });
    advance(100);
    const second = projection.project(input);
    (await pending(1, 1)).crash();
    expect(await second).toMatchObject({ kind: "refused", reason: "unavailable" });
    advance(100);
    expect(await projection.project(input)).toMatchObject({ kind: "refused", reason: "unavailable", message: expect.stringContaining("starts again in 100 ms") });
    advance(100);
    const third = projection.project(input);
    (await pending(2, 1)).answerNext();
    expect(await third).toMatchObject({ kind: "projected" });
    expect(engines).toHaveLength(3);
    await projection.close();
  });

  it("refuses to restart an executable that changed after startup", async () => {
    const { projection, engines, pending, path, advance } = await harness();
    const crashed = projection.project(input);
    (await pending(0, 1)).crash();
    await crashed;
    writeFileSync(path, "engine build two");
    advance(100);
    expect(await projection.project(input)).toMatchObject({ kind: "refused", reason: "unavailable", message: expect.stringContaining("changed after the relay started") });
    expect(engines).toHaveLength(1);
    await projection.close();
  });

  it("kills a child that passes the deadline, because the projection keeps running there", async () => {
    const { projection, engines, pending, advance } = await harness();
    const late = projection.project(input);
    const engine = await pending(0, 1);
    engine.requests.shift()!.reject(new EngineRequestDeadlineError(1, "ydoc.project", 1_000));
    expect(await late).toMatchObject({ kind: "refused", reason: "unavailable" });
    await engine.waitForExit();
    expect(engine.kills).toBe(1);
    advance(100);
    const next = projection.project(input);
    (await pending(1, 1)).answerNext();
    expect(await next).toMatchObject({ kind: "projected" });
    expect(engines).toHaveLength(2);
    await projection.close();
  });

  it.each([
    [new EngineRequestError(1, { code: "INVALID_PARAMS", message: "the ydoc updates are missing a dependency", retry: "no" }), "invalid"],
    [new EngineRequestError(1, { code: "INTERNAL", message: "ydoc projection failed", retry: "no" }), "invalid"],
    [new EngineRequestError(1, { code: "PAYLOAD_TOO_LARGE", message: "the file is above MAX_PUBLIC_MARKDOWN_BYTES", retry: "no" }), "too-large"],
    [new EngineRequestError(1, { code: "OVERLOADED", message: "overloaded", retry: "afterBackoff" }), "busy"],
    [new EngineClientError("request-too-large", "request-exceeds-wire-limit"), "too-large"],
  ] as const)("reports %s as %s and keeps the child", async (error, reason) => {
    const { projection, engines, pending } = await harness();
    const result = projection.project(input);
    const engine = await pending(0, 1);
    engine.requests.shift()!.reject(error);
    expect(await result).toEqual({ kind: "refused", reason, message: error.message });
    expect(engine.closes + engine.kills).toBe(0);
    const next = projection.project(input);
    (await pending(0, 1)).answerNext();
    expect(await next).toMatchObject({ kind: "projected" });
    expect(engines).toHaveLength(1);
    await projection.close();
  });

  it("refuses an answer that is not a projection", async () => {
    const { projection, pending } = await harness();
    const result = projection.project(input);
    const engine = await pending(0, 1);
    const { request, resolve } = engine.requests.shift()!;
    resolve({ id: request.id, result: { contentBase64: "not base64!", sourceStateVectorSha256: "a".repeat(64) } });
    expect(await result).toMatchObject({ kind: "refused", reason: "invalid" });
    await projection.close();
  });

  it("refuses running, queued and later work once closed, and waits for the child to exit", async () => {
    const { projection, engines, pending } = await harness({ maxInFlight: 1, maxQueued: 1 });
    const running = projection.project(input);
    await pending(0, 1);
    const queued = projection.project(input);
    await projection.close();
    expect(await queued).toMatchObject({ kind: "refused", reason: "unavailable" });
    expect(await running).toMatchObject({ kind: "refused", reason: "unavailable" });
    expect(engines[0]!.closes).toBeGreaterThan(0);
    expect(await projection.project(input)).toMatchObject({ kind: "refused", reason: "unavailable" });
    expect(engines).toHaveLength(1);
  });

  it("stops a restart in progress when closed", async () => {
    let first: FakeEngine | undefined;
    const { projection, advance } = await harness({
      async launch(options) {
        if (!first) return first = new FakeEngine(options);
        // A restart that would otherwise wait out its connect timeout.
        return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("launch aborted")), { once: true }));
      },
    });
    const crashed = projection.project(input);
    while (first!.requests.length < 1) await new Promise(resolve => setImmediate(resolve));
    first!.crash();
    await crashed;
    advance(100);
    const restarting = projection.project(input);
    await projection.close();
    expect(await restarting).toMatchObject({ kind: "refused", reason: "unavailable" });
  });

  it("refuses an executable that is not an absolute path to a file", async () => {
    for (const engineExecutable of ["relative-engine", join(tmpdir(), "missing-engine-projection-binary"), tmpdir()]) {
      await expect(startEngineProjection({ engineExecutable, maxInFlight: 1, maxQueued: 0, maxQueuedBytes: 1, deadlineMs: 1, connectTimeoutMs: 1,
        restartBackoffMs: { initial: 1, max: 1 }, maxAddressSpaceBytes: 1 })).rejects.toThrow(TypeError);
    }
  });
});
