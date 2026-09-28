import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../e2e/helpers/desktopApp", () => ({ desktopRoot: "/desktop" }));

function relayChild() {
  return Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    connected: true,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    send: vi.fn(),
    kill: vi.fn(),
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

it("joins concurrent stops until the relay child closes, even after exit", async () => {
  const child = relayChild();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const starting = spawnSyncRelay({ dbPath: "/scratch/relay.sqlite" });
  child.stdout.write("SYNC_RELAY_LISTENING host=127.0.0.1 port=1234\n");
  const relay = await starting;
  let stopped = 0;
  const first = relay.stop().then(() => stopped++);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  const second = relay.stop().then(() => stopped++);
  await Promise.resolve();
  await Promise.resolve();
  expect(stopped).toBe(0);
  expect(child.send).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  expect(child.kill).not.toHaveBeenCalled();
  child.emit("close", 0, null);
  await Promise.all([first, second]);
  await relay.stop();
  expect(stopped).toBe(2);
  expect(child.send).toHaveBeenCalledTimes(1);
});

it("waits for close before reporting a startup failure", async () => {
  const child = relayChild();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const starting = spawnSyncRelay({ dbPath: "/scratch/relay.sqlite" });
  let settled = false;
  const result = starting.catch((error: unknown) => { settled = true; return error; });
  child.exitCode = 1;
  child.emit("exit", 1, null);
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit("close", 1, null);
  expect(await result).toMatchObject({ message: expect.stringContaining("exited before listening") });
  expect(child.kill).not.toHaveBeenCalled();
});

it("waits for close after escalating a stalled shutdown", async () => {
  vi.useFakeTimers();
  const child = relayChild();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const starting = spawnSyncRelay({ dbPath: "/scratch/relay.sqlite" });
  child.stdout.write("SYNC_RELAY_LISTENING host=127.0.0.1 port=1234\n");
  const relay = await starting;
  let stopped = false;
  const stopping = relay.stop().then(() => { stopped = true; });
  await vi.runAllTimersAsync();
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  expect(stopped).toBe(false);
  child.signalCode = "SIGKILL";
  child.emit("exit", null, "SIGKILL");
  await Promise.resolve();
  expect(stopped).toBe(false);
  child.emit("close", null, "SIGKILL");
  await stopping;
  expect(stopped).toBe(true);
});
