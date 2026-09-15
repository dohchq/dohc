import { EventEmitter } from "node:events";
import {readFileSync} from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { DeviceLiveHostConfig } from "./deviceLiveHostConfig";
import type { WebSocket } from "ws";
import { startDeviceNativeTransport } from "./deviceNativeTransport";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it.each([false, true])("forwards explicit sync config (%s) and uses the native grace twice when EOF and TERM are ignored", async enabled => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as string | null,
    kill: vi.fn((signal: string) => {
      if (signal === "SIGKILL") { child.signalCode = signal; child.emit("close"); }
      return true;
    }),
  });
  spawn.mockReturnValue(child);
  let attached!: () => void;
  const ready = new Promise<void>(resolve => { attached = resolve; });
  const ws = { readyState: 1, bufferedAmount: 0, send(bytes: Buffer, _options: unknown, done: () => void) {
    if (JSON.parse(bytes.toString()).type === "liveHost.transport") attached();
    done();
  } } as unknown as WebSocket;
  const limits = { maxPayloadBytes: 4096, maxPendingBytes: 8192, closeTimeoutMs: 1 } as Parameters<typeof startDeviceNativeTransport>[0]["limits"];
  const sync = enabled ? {policy: {maxClientVectorBytes: 1024, maxHostVectorBytes: 4096,
    maxOutputBytes: 1_000_000, maxReadBytes: 10_000_000}, workingReserveBytes: 16_777_216} : undefined;
  const config = { engineExecutable: process.execPath, workspaces: [], ingress: {}, maxQueuedBytes: 100_000, sync,
    shutdownGraceMs: 1000 } as unknown as DeviceLiveHostConfig;
  const transport = startDeviceNativeTransport({ ws, limits, config, stop() {}, start: {
    type: "liveHost.start", version: 1, relayNamespace: "relay", authToken: "A".repeat(43),
    host: { hostId: "host", hostEpoch: parseHostEpoch(1), instanceId: "instance", connectionId: "connection" },
    receive: { maxPayloadBytes: 4096, maxPendingBytes: 8192 },
  } });
  await ready;
  const options = spawn.mock.calls[0]![2];
  const saved = JSON.parse(readFileSync(options.env.DOHC_ENGINE_LIVE_HOST_CONFIG, "utf8"));
  expect(saved.sync).toEqual(sync);
  const closed = transport.close();
  await vi.advanceTimersByTimeAsync(1);
  expect(child.kill).not.toHaveBeenCalled();
  expect(child.stdin.writableEnded).toBe(true);
  expect(child.stdout.isPaused()).toBe(false);
  await vi.advanceTimersByTimeAsync(999);
  expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  await vi.advanceTimersByTimeAsync(1000);
  await closed;
  expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  expect(vi.getTimerCount()).toBe(0);
});
