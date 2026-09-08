import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { BoundedSendQueue, DeviceCreditSender, DeviceControlWriter, DeviceCreditWindow } from "@dohc/service-http";
import { deviceLiveHostReceive, type DeviceControlLimits, type DeviceLiveHostStart } from "@dohc/live-session-contract/device-control";
import type { DeviceLiveHostConfig } from "./deviceLiveHostConfig.js";

/** Owns the device child and both byte queues until stdio has closed. */
export function startDeviceNativeTransport(options: {
  config: DeviceLiveHostConfig; start: DeviceLiveHostStart; ws: WebSocket; limits: DeviceControlLimits; stop: () => void;
}) {
  const { config, start, ws, limits } = options;
  let child: ChildProcessWithoutNullStreams | undefined, temporary: string | undefined, stopping = false, attached = false;
  let input: BoundedSendQueue | undefined, output: DeviceCreditSender | undefined, writer: DeviceControlWriter | undefined;
  const receive = deviceLiveHostReceive(limits, { maxPayloadBytes: limits.maxPayloadBytes, maxPendingBytes: config.maxQueuedBytes });
  const incoming = new DeviceCreditWindow(receive.maxPendingBytes, receive.maxPayloadBytes);
  let receivedBytes = 0;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let exited: Promise<void> | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true; attached = false; input?.close(); output?.close(); writer?.close();
    if (child) {
      child.stdout.removeAllListeners("data"); child.stdout.resume(); child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        killTimer = setTimeout(() => {
          if (!child || child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          forceTimer = setTimeout(() => {
            if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }, config.shutdownGraceMs);
          forceTimer.unref();
        }, config.shutdownGraceMs);
        killTimer.unref();
      }
    }
  };
  const fail = () => { stop(); options.stop(); };
  const startup = (async () => {
    try {
      temporary = await mkdtemp(join(tmpdir(), "dohc-device-live-host-"));
      if (stopping) return;
      const nativeConfig = join(temporary, "host.json");
      await writeFile(nativeConfig, JSON.stringify({ version: 1, relayNamespace: start.relayNamespace, host: start.host,
        workspaces: config.workspaces, ingress: config.ingress, settlement: config.settlement }), { flag: "wx", mode: 0o600 });
      if (stopping) return;
      child = spawn(config.engineExecutable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        env: { ...process.env, DOHC_ENGINE_LIVE_HOST_CONFIG: nativeConfig, DOHC_ENGINE_AUTH_TOKEN: start.authToken } });
      const launched = child;
      exited = new Promise<void>(resolve => launched.once("close", () => {
        if (killTimer) clearTimeout(killTimer);
        if (forceTimer) clearTimeout(forceTimer);
        resolve(); fail();
      }));
      launched.on("error", fail);
      launched.stdin.on("error", fail);
      launched.stdout.on("error", fail);
      launched.stderr.on("error", fail);
      launched.stderr.on("data", (bytes: Buffer) => console.error("[device-live-host]", bytes.toString("utf8").trimEnd()));
      input = new BoundedSendQueue({ maxBytes: config.maxQueuedBytes, maxSegmentBytes: limits.maxPayloadBytes,
        send(bytes, _binary, done) { launched.stdin.write(bytes, error => done(error ?? undefined)); },
        onDrain() {
          if (stopping) return;
          incoming.acknowledge(receivedBytes); writer!.acknowledge(receivedBytes);
        }, onError: fail });
      writer = new DeviceControlWriter({
        send(bytes, binary, done) {
          if (bytes.length > limits.maxPayloadBytes || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + bytes.length + 16 > limits.maxPendingBytes) throw new Error("Device transport is full.");
          ws.send(bytes, { binary }, done);
        }, onError: fail });
      output = new DeviceCreditSender({ maxQueuedBytes: config.maxQueuedBytes,
        maxPayloadBytes: Math.min(limits.maxPayloadBytes, start.receive.maxPayloadBytes), windowBytes: start.receive.maxPendingBytes,
        send: (bytes, done) => writer!.write(bytes, true, done),
        onDrain() { if (!stopping) launched.stdout.resume(); }, onError: fail });
      launched.stdout.on("data", (bytes: Buffer) => { launched.stdout.pause(); output!.write(bytes); });
      launched.stdout.pause();
      if (stopping) return;
      attached = true;
      writer.write(Buffer.from(JSON.stringify({ type: "liveHost.transport", version: 1, receive })), false,
        () => { if (!stopping) launched.stdout.resume(); });
    } catch { fail(); }
  })();
  return {
    receive(bytes: Buffer): void {
      if (!attached || !input || bytes.length === 0) { fail(); return; }
      incoming.receive(bytes.length);
      receivedBytes += bytes.length + 16;
      input.write(bytes, true);
    },
    credit(total: number): void { if (!attached || !output) { fail(); return; } output.acknowledge(total); },
    async close(): Promise<void> {
      stop(); await startup; await exited;
      if (temporary) await rm(temporary, { recursive: true, force: true });
    },
  };
}
