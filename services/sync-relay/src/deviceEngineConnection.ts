import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { DeviceCreditSender, DeviceControlWriter } from "@dohc/service-http";
import type { DeviceControlLimits, DeviceLiveHostReceive } from "@dohc/live-session-contract/device-control";
import type { EngineClientConnection } from "@dohc/workspace-engine-client/daemon";

export class DeviceEngineConnection implements EngineClientConnection {
  private readonly events = new EventEmitter();
  private readonly queue: DeviceCreditSender;
  private readonly writer: DeviceControlWriter;
  private closed = false;
  constructor(ws: WebSocket, limits: DeviceControlLimits, receive: DeviceLiveHostReceive, maxQueuedBytes: number, private readonly stop: () => void) {
    this.writer = new DeviceControlWriter({
      send(bytes, binary, done) {
        if (bytes.length > limits.maxPayloadBytes || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + bytes.length + 16 > limits.maxPendingBytes) throw new Error("Device transport is full.");
        ws.send(bytes, { binary }, done);
      }, onError: () => this.close() });
    this.queue = new DeviceCreditSender({ maxQueuedBytes, maxPayloadBytes: Math.min(limits.maxPayloadBytes, receive.maxPayloadBytes), windowBytes: receive.maxPendingBytes,
      send: (bytes, done) => this.writer.write(bytes, true, done),
      onDrain: () => this.events.emit("drain"), onError: () => this.close() });
  }
  credit(total: number): void { this.queue.acknowledge(total); }
  acknowledge(total: number): void { this.writer.acknowledge(total); }
  receive(bytes: Buffer): void { if (!this.closed) this.events.emit("data", bytes); }
  write(bytes: Buffer): boolean {
    this.queue.write(bytes);
    // EngineClient waits for the queue's drain event before its next frame.
    return false;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.queue.close(); this.writer.close(); this.events.emit("close"); this.stop();
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
