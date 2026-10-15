import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ spawn: vi.fn(), query: vi.fn(), end: vi.fn(), close: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }));
vi.mock("pg", () => ({ Pool: class { query = fixture.query; end = fixture.end; } }));
vi.mock("../e2e/smtpCapture", () => ({ startSmtpCapture: async () => ({ port: 2525, close: fixture.close }) }));
import { startAccountServer } from "../e2e/harness";

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 1,
    kill: vi.fn(() => { child.emit("exit", 0, null); child.emit("close", 0); return true; }) });
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

it("waits through slow readiness beyond the former 20 second deadline", async () => {
  vi.useFakeTimers();
  let ready!: (response: Response) => void;
  let entered!: () => void;
  const probing = new Promise<void>(resolve => { entered = resolve; });
  const probe = vi.fn()
    .mockResolvedValueOnce(Response.json({ ok: false, database: "unreachable" }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ ok: false, database: "unreachable" }, { status: 503 }))
    .mockImplementationOnce(() => { entered(); return new Promise<Response>(resolve => { ready = resolve; }); });
  vi.stubGlobal("fetch", probe);
  let settled = false;
  const outcome = startAccountServer({ port: 12345 }).then(server => ({ server }), error => ({ error }))
    .finally(() => { settled = true; });
  await spawned;
  await vi.advanceTimersByTimeAsync(200);
  await probing;
  await vi.advanceTimersByTimeAsync(25_000);
  expect(settled).toBe(false);
  expect(child.kill).not.toHaveBeenCalled();
  ready(Response.json({ ok: true }));
  const result = await outcome;
  if (!("server" in result)) throw result.error;
  expect(probe).toHaveBeenCalledTimes(3);
  expect(fixture.spawn.mock.calls[0][1]).toEqual(["--import", "tsx", "src/main.ts"]);
  await result.server.close();
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.end).toHaveBeenCalledOnce();
});

function pendingProbe() {
  return vi.fn((_url: string, { signal }: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
}

it("fails promptly when the child exits during a readiness request", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", pendingProbe());
  const outcome = startAccountServer({ port: 12345 }).catch(error => error);
  await spawned;
  child.stderr.emit("data", "database initialization failed");
  child.emit("exit", 17, null); child.emit("close", 17);
  const error = await outcome;
  expect(error.message).toContain("code 17");
  expect(error.message).toContain("Last /ready body: No HTTP response.");
  expect(error.message).toContain("database initialization failed");
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.end).toHaveBeenCalledOnce();
});

it("reports caller cancellation and the last readiness body, and joins shutdown", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  child.kill.mockImplementation(() => true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, database: "unreachable" }, { status: 503 })));
  let settled = false;
  const outcome = startAccountServer({ port: 12345, signal: controller.signal }).catch(error => error)
    .finally(() => { settled = true; });
  await spawned;
  await vi.advanceTimersByTimeAsync(0);
  controller.abort(new Error("setup cancelled by caller"));
  await vi.advanceTimersByTimeAsync(0);
  expect(child.kill).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  child.emit("exit", 0, null); child.emit("close", 0);
  const error = await outcome;
  expect(error.message).toContain("setup cancelled by caller");
  expect(error.message).toContain('Last /ready body: {"ok":false,"database":"unreachable"}');
  expect(error.cause).toBe(controller.signal.reason);
  expect(fixture.end).toHaveBeenCalledOnce();
});

it("fails promptly on a child error", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", pendingProbe());
  const outcome = startAccountServer({ port: 12345 }).catch(error => error);
  await spawned;
  child.emit("error", new Error("spawn failed")); child.emit("close", null);
  const error = await outcome;
  expect(error.message).toContain("spawn failed");
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.end).toHaveBeenCalledOnce();
});

it("keeps an error listener for shutdown after startup", async () => {
  const server = await startAccountServer({ port: 12345 });
  child.kill.mockImplementation(() => {
    child.emit("error", new Error("kill failed"));
    child.emit("exit", 0, null); child.emit("close", 0);
    return true;
  });
  await expect(server.close()).resolves.toBeUndefined();
  expect(child.listenerCount("error")).toBe(1);
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.end).toHaveBeenCalledOnce();
});
