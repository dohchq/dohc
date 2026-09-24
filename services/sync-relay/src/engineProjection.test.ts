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
import { createEngineProjection } from "./engineProjection";

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

/** A stand-in engine child. Each request waits until the test settles it. */
class FakeEngine {
  readonly requests: { request: Request; resolve: (response: Response) => void; reject: (error: unknown) => void }[] = [];
  closes = 0;
  kills = 0;
  private exit!: () => void;
  private readonly exited = new Promise<void>(resolve => { this.exit = resolve; });
  constructor(readonly options: EngineClientSpawnOptions) {}
  sendRequest(request: Request): Promise<Response> {
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

function harness(limits: { maxInFlight?: number; maxQueued?: number } = {}) {
  const engines: FakeEngine[] = [];
  const projection = createEngineProjection({ engineExecutable: executable(), maxInFlight: limits.maxInFlight ?? 2,
    maxQueued: limits.maxQueued ?? 4, deadlineMs: 1_000, connectTimeoutMs: 1_000,
    async launch(options) {
      const engine = new FakeEngine(options);
      engines.push(engine);
      return engine;
    } });
  // Resolves once the numbered engine holds that many unanswered requests.
  const pending = async (engine: number, count: number) => {
    while ((engines[engine]?.requests.length ?? 0) < count) await new Promise(resolve => setImmediate(resolve));
    return engines[engine]!;
  };
  return { projection, engines, pending };
}

const input = { contentKind: "richdoc" as const, updates: [new Uint8Array([1, 2, 3])] };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

describe("engine projection", () => {
  it("projects through one long-lived engine and records the executable's digest", async () => {
    const { projection, engines, pending } = harness();
    const first = projection.project(input);
    (await pending(0, 1)).answerNext();
    const second = projection.project(input);
    (await pending(0, 1)).answerNext();
    for (const result of [await first, await second]) {
      expect(result).toEqual({ kind: "projected", content: Buffer.from(content), sha256: hash(content),
        sourceStateVectorSha256: "a".repeat(64), engineSha256: hash("engine build one") });
    }
    expect(engines).toHaveLength(1);
    expect(engines[0]!.options).toMatchObject({ protocolVersion: 2, capabilities: [] });
    await projection.close();
    expect(engines[0]!.closes).toBeGreaterThan(0);
  });

  it("sends the updates to ydoc.project with its deadline", async () => {
    const { projection, pending } = harness();
    const result = projection.project({ contentKind: "plaintext", updates: [new Uint8Array([1, 2]), new Uint8Array([3])] });
    const engine = await pending(0, 1);
    expect(engine.requests[0]!.request).toMatchObject({ method: "ydoc.project", deadlineMs: 1_000,
      params: { contentKind: "plaintext", updatesBase64: ["AQI=", "Aw=="] } });
    engine.answerNext();
    expect(await result).toMatchObject({ kind: "projected" });
    await projection.close();
  });

  it("refuses work beyond its slots and queue, then admits the waiter when a slot frees", async () => {
    const { projection, pending } = harness({ maxInFlight: 1, maxQueued: 1 });
    const running = projection.project(input);
    const engine = await pending(0, 1);
    const queued = projection.project(input);
    expect(await projection.project(input)).toMatchObject({ kind: "refused", reason: "busy" });
    engine.answerNext();
    expect(await running).toMatchObject({ kind: "projected" });
    (await pending(0, 1)).answerNext();
    expect(await queued).toMatchObject({ kind: "projected" });
    await projection.close();
  });

  it("keeps a crash in the child and starts a fresh one for the next call", async () => {
    const { projection, engines, pending } = harness();
    const crashed = projection.project(input);
    (await pending(0, 1)).crash();
    expect(await crashed).toMatchObject({ kind: "refused", reason: "unavailable" });
    const next = projection.project(input);
    (await pending(1, 1)).answerNext();
    expect(await next).toMatchObject({ kind: "projected" });
    expect(engines).toHaveLength(2);
    await projection.close();
  });

  it("kills a child that passes the deadline, because the projection keeps running there", async () => {
    const { projection, engines, pending } = harness();
    const late = projection.project(input);
    const engine = await pending(0, 1);
    engine.requests.shift()!.reject(new EngineRequestDeadlineError(1, "ydoc.project", 1_000));
    expect(await late).toMatchObject({ kind: "refused", reason: "unavailable" });
    await engine.waitForExit();
    expect(engine.kills).toBe(1);
    const next = projection.project(input);
    (await pending(1, 1)).answerNext();
    expect(await next).toMatchObject({ kind: "projected" });
    expect(engines).toHaveLength(2);
    await projection.close();
  });

  it.each([
    [new EngineRequestError(1, { code: "INVALID_PARAMS", message: "the ydoc updates are missing a dependency", retry: "no" }), "invalid"],
    [new EngineRequestError(1, { code: "INTERNAL", message: "ydoc projection failed", retry: "no" }), "invalid"],
    [new EngineRequestError(1, { code: "PAYLOAD_TOO_LARGE", message: "Y.Doc projection exceeds MAX_PUBLIC_MARKDOWN_BYTES", retry: "no" }), "too-large"],
    [new EngineRequestError(1, { code: "OVERLOADED", message: "overloaded", retry: "afterBackoff" }), "busy"],
    [new EngineClientError("request-too-large", "request-exceeds-wire-limit"), "too-large"],
  ] as const)("reports %s as %s and keeps the child", async (error, reason) => {
    const { projection, engines, pending } = harness();
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
    const { projection, pending } = harness();
    const result = projection.project(input);
    const engine = await pending(0, 1);
    const { request, resolve } = engine.requests.shift()!;
    resolve({ id: request.id, result: { contentBase64: "not base64!", sourceStateVectorSha256: "a".repeat(64) } });
    expect(await result).toMatchObject({ kind: "refused", reason: "invalid" });
    await projection.close();
  });

  it("refuses running, queued and later work once closed, and waits for the child to exit", async () => {
    const { projection, engines, pending } = harness({ maxInFlight: 1, maxQueued: 1 });
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

  it("refuses an executable that is not an absolute path to a file", () => {
    for (const engineExecutable of ["relative-engine", join(tmpdir(), "missing-engine-projection-binary"), tmpdir()]) {
      expect(() => createEngineProjection({ engineExecutable, maxInFlight: 1, maxQueued: 0, deadlineMs: 1, connectTimeoutMs: 1 })).toThrow(TypeError);
    }
  });
});
