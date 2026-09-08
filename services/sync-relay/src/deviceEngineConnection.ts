import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { BoundedSendQueue } from "@dohc/service-http";
import type { DeviceControlLimits } from "@dohc/live-session-contract/device-control";
import type { EngineClientConnection } from "@dohc/workspace-engine-client/daemon";

export class DeviceEngineConnection implements EngineClientConnection {
  private readonly events = new EventEmitter();
  private readonly queue: BoundedSendQueue;
  private closed = false;
  constructor(ws: WebSocket, limits: DeviceControlLimits, maxQueuedBytes: number, private readonly stop: () => void) {
    this.queue = new BoundedSendQueue({ maxBytes: maxQueuedBytes, maxSegmentBytes: limits.maxPayloadBytes,
      send(bytes, binary, done) {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + bytes.length + 16 > limits.maxPendingBytes) throw new Error("Device transport is full.");
        ws.send(bytes, { binary }, done);
      }, onDrain: () => this.events.emit("drain"), onError: () => this.close() });
  }
  receive(bytes: Buffer): void { if (!this.closed) this.events.emit("data", bytes); }
  write(bytes: Buffer): boolean { return this.queue.write(bytes, true); }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.queue.close(); this.events.emit("close"); this.stop();
  }
  onData(handler: (chunk: Buffer | Uint8Array) => void): void { this.events.on("data", handler); }
  offData(handler: (chunk: Buffer | Uint8Array) => void): void { this.events.off("data", handler); }
  onClose(handler: () => void): void { this.events.on("close", handler); }
  offClose(handler: () => void): void { this.events.off("close", handler); }
  onError(handler: (error: unknown) => void): void { this.events.on("error", handler); }
  offError(handler: (error: unknown) => void): void { this.events.off("error", handler); }
  onDrain(handler: () => void): void { this.events.on("drain", handler); }
  offDrain(handler: () => void): void { this.events.off("drain", handler); }
}
