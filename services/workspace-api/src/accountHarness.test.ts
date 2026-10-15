import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ spawn: vi.fn(), query: vi.fn(), end: vi.fn(), close: vi.fn(), build: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }));
vi.mock("esbuild", () => ({ build: fixture.build }));
vi.mock("pg", () => ({ Pool: class { query = fixture.query; end = fixture.end; } }));
vi.mock("../e2e/smtpCapture", () => ({ startSmtpCapture: async () => ({ port: 2525, close: fixture.close }) }));
import { startAccountServer } from "../e2e/harness";

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 1,
    kill: vi.fn(() => { child.emit("exit", 0); child.emit("close", 0); return true; }) });
  return child;
}
let child: ReturnType<typeof fakeChild>;
let spawned: Promise<void>;
beforeEach(() => {
  vi.stubEnv("POSTGRES_URL", "postgresql://disposable");
  vi.stubEnv("DOHC_REQUIRE_POSTGRES", "1");
  child = fakeChild();
  spawned = new Promise<void>(resolve => { fixture.spawn.mockImplementation(() => { resolve(); return child; }); });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

it("waits for HTTP readiness even when the listening log has not flushed", async () => {
  vi.useFakeTimers();
  const outcome = startAccountServer({ port: 12345 }).then(server => ({ server }), error => ({ error }));
  await spawned;
  await vi.advanceTimersByTimeAsync(20_001);
  const result = await outcome;
  expect(result).not.toHaveProperty("error");
  if (!("server" in result)) throw result.error;
  expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:12345/ready", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(fixture.spawn.mock.calls[0][1]).toEqual([expect.stringMatching(/main\.mjs$/)]);
  await result.server.close();
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.end).toHaveBeenCalledOnce();
});

it("keeps compilation outside the child readiness deadline", async () => {
  vi.useFakeTimers();
  let finishBuild!: () => void;
  let entered!: () => void;
  const building = new Promise<void>(resolve => { entered = resolve; });
  fixture.build.mockImplementation(() => { entered(); return new Promise<void>(resolve => { finishBuild = resolve; }); });
  const starting = startAccountServer({ port: 12345 });
  await building;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fixture.spawn).not.toHaveBeenCalled();
  finishBuild();
  const server = await starting;
  await server.close();
});

it("does not treat a listening port as ready and joins child shutdown at the deadline", async () => {
  vi.useFakeTimers();
  child.kill.mockImplementation(() => true);
  vi.stubGlobal("fetch", pendingProbe());
  let settled = false;
  const outcome = startAccountServer({ port: 12345 }).catch(error => error).finally(() => { settled = true; });
  await spawned;
  child.stdout.emit("data", "listening on 127.0.0.1:12345");
  await vi.advanceTimersByTimeAsync(20_001);
  expect(child.kill).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  child.emit("exit", 0); child.emit("close", 0);
  const error = await outcome;
  expect(error.cause.message).toContain("not ready within 20 seconds");
  expect(fixture.end).toHaveBeenCalledOnce();
  expect(child.listenerCount("exit")).toBe(0);
  expect(child.listenerCount("error")).toBe(0);
});

function pendingProbe() {
  return vi.fn((_url: string, { signal }: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
}

it("fails on a child error without waiting for the startup deadline", async () => {
  child.kill.mockImplementation(() => true);
  vi.stubGlobal("fetch", pendingProbe());
  const outcome = startAccountServer({ port: 12345 }).catch(error => error);
  await spawned;
  child.emit("error", new Error("spawn failed")); child.emit("close", null);
  const error = await outcome;
  expect(error.cause.message).toBe("spawn failed");
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.end).toHaveBeenCalledOnce();
});

it("keeps polling while the database is unready", async () => {
  let ready!: (response: Response) => void;
  let entered!: () => void;
  const probing = new Promise<void>(resolve => { entered = resolve; });
  const probe = vi.fn().mockResolvedValueOnce(Response.json({ ok: false, database: "unreachable" }, { status: 503 }))
    .mockImplementationOnce(() => { entered(); return new Promise<Response>(resolve => { ready = resolve; }); });
  vi.stubGlobal("fetch", probe);
  let settled = false;
  const starting = startAccountServer({ port: 12345 }).then(server => { settled = true; return server; });
  await probing;
  expect(probe).toHaveBeenCalledTimes(2);
  expect(settled).toBe(false);
  ready(Response.json({ ok: true }));
  const server = await starting;
  await server.close();
});

it("releases SMTP and the database when compilation fails", async () => {
  fixture.build.mockRejectedValueOnce(new Error("invalid source"));
  await expect(startAccountServer({ port: 12345 })).rejects.toThrow("invalid source");
  expect(fixture.spawn).not.toHaveBeenCalled();
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.end).toHaveBeenCalledOnce();
});
