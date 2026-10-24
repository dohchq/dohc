import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => false), mkdirSync: vi.fn() }));
vi.mock("../../e2e/helpers/desktopApp", () => {
  throw new Error("Relay startup must not load the desktop launcher");
});

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(existsSync).mockReturnValue(false);
});
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

const deploymentOptions = {
  dbPath: join("scratch", "relay", "relay.sqlite"),
  editLinks: { engineExecutable: "engine", publicOrigin: "https://127.0.0.1:1234" },
};

it.each([false, true])("initializes with the source or sibling compiled entry (compiled=%s)", async compiled => {
  const initializer = relayChild(), child = relayChild();
  const compiledMain = join("build", "main.js");
  vi.mocked(spawn).mockReturnValueOnce(initializer as unknown as ReturnType<typeof spawn>)
    .mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const starting = spawnSyncRelay({ ...deploymentOptions, ...(compiled ? { compiledMain } : {}) });
  expect(spawn).toHaveBeenNthCalledWith(1, process.execPath, [
    ...(compiled ? [join("build", "relay-deployment.js")] : ["--import", "tsx/esm", "src/relayDeploymentCommand.ts"]),
    "initialize", "--config", join("scratch", "relay-deployment", "deployment.json"),
    "--database", deploymentOptions.dbPath, "--continuity-directory", join("scratch", "relay-deployment", "continuity"),
  ], expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
  initializer.exitCode = 0;
  initializer.emit("exit", 0, null);
  await Promise.resolve();
  expect(spawn).toHaveBeenCalledTimes(1);
  initializer.emit("close", 0, null);
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
  expect(mkdirSync).toHaveBeenCalledWith(join("scratch", "relay-deployment", "live-host"));
  child.stdout.write("SYNC_RELAY_LISTENING host=127.0.0.1 port=1234\n");
  const relay = await starting;
  const stopping = relay.stop();
  child.exitCode = 0;
  child.emit("close", 0, null);
  await stopping;
});

it("reports initializer diagnostics only after its failed child closes", async () => {
  const child = relayChild();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  let settled = false;
  const result = spawnSyncRelay(deploymentOptions).catch((error: unknown) => { settled = true; return error; });
  child.stdout.write("initializer output");
  child.stderr.write("initializer failure");
  child.exitCode = 7;
  child.emit("exit", 7, null);
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit("close", 7, null);
  expect(await result).toMatchObject({
    message: expect.stringMatching(/exit=7[\s\S]*initializer output[\s\S]*initializer failure/u),
    cause: { message: expect.stringContaining("code=7") },
  });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(child.kill).not.toHaveBeenCalled();
  expect(mkdirSync).not.toHaveBeenCalled();
});

it("stops and awaits an initializer that fails before exit", async () => {
  const child = relayChild();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  let settled = false;
  const result = spawnSyncRelay(deploymentOptions).catch((error: unknown) => { settled = true; return error; });
  child.emit("error", new Error("spawn failed"));
  await Promise.resolve();
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  expect(settled).toBe(false);
  child.signalCode = "SIGKILL";
  child.emit("close", null, "SIGKILL");
  expect(await result).toMatchObject({ cause: { message: "spawn failed" } });
  expect(spawn).toHaveBeenCalledTimes(1);
});

it("stops and awaits a stalled initializer at the existing relay startup bound", async () => {
  vi.useFakeTimers();
  const child = relayChild();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  let settled = false;
  const result = spawnSyncRelay(deploymentOptions).catch((error: unknown) => { settled = true; return error; });
  await vi.runAllTimersAsync();
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  expect(settled).toBe(false);
  child.signalCode = "SIGKILL";
  child.emit("close", null, "SIGKILL");
  expect(await result).toMatchObject({ cause: { message: "Deployment initializer did not finish." } });
  expect(spawn).toHaveBeenCalledTimes(1);
});
