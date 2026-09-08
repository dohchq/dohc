import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { BoundedSendQueue } from "@dohc/service-http";
import type { DeviceControlLimits, DeviceLiveHostStart } from "@dohc/live-session-contract/device-control";
import type { DeviceLiveHostConfig } from "./deviceLiveHostConfig.js";

/** Owns the device child and both byte queues until stdio has closed. */
export function startDeviceNativeTransport(options: {
  config: DeviceLiveHostConfig; start: DeviceLiveHostStart; ws: WebSocket; limits: DeviceControlLimits; stop: () => void;
}) {
  const { config, start, ws, limits } = options;
  let child: ChildProcessWithoutNullStreams | undefined, temporary: string | undefined, stopping = false, attached = false;
  let input: BoundedSendQueue | undefined, output: BoundedSendQueue | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let exited: Promise<void> | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true; attached = false; input?.close(); output?.close();
    if (child) {
      child.stdout.pause(); child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        killTimer = setTimeout(() => { if (child?.exitCode === null && child.signalCode === null) child.kill(); }, limits.closeTimeoutMs);
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
      exited = new Promise<void>(resolve => launched.once("close", () => { if (killTimer) clearTimeout(killTimer); resolve(); fail(); }));
      launched.on("error", fail);
      launched.stdin.on("error", fail);
      launched.stdout.on("error", fail);
      launched.stderr.on("error", fail);
      launched.stderr.on("data", (bytes: Buffer) => console.error("[device-live-host]", bytes.toString("utf8").trimEnd()));
      input = new BoundedSendQueue({ maxBytes: config.maxQueuedBytes, maxSegmentBytes: limits.maxPayloadBytes,
        send(bytes, _binary, done) { launched.stdin.write(bytes, error => done(error ?? undefined)); }, onDrain() {}, onError: fail });
      output = new BoundedSendQueue({ maxBytes: config.maxQueuedBytes, maxSegmentBytes: limits.maxPayloadBytes,
        send(bytes, binary, done) {
          if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + bytes.length + 16 > limits.maxPendingBytes) throw new Error("Device transport is full.");
          ws.send(bytes, { binary }, done);
        }, onDrain() { if (!stopping) launched.stdout.resume(); }, onError: fail });
      launched.stdout.on("data", (bytes: Buffer) => { launched.stdout.pause(); output!.write(bytes, true); });
      launched.stdout.pause();
      if (stopping) return;
      attached = true;
      output.write(Buffer.from(JSON.stringify({ type: "liveHost.transport", version: 1 })), false);
    } catch { fail(); }
  })();
  return {
    receive(bytes: Buffer): void {
      if (!attached || !input || bytes.length === 0) { fail(); return; }
      input.write(bytes, true);
    },
    async close(): Promise<void> {
      stop(); await startup; await exited;
      if (temporary) await rm(temporary, { recursive: true, force: true });
    },
  };
}
