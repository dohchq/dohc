import { BoundedSendQueue } from "./boundedSendQueue";

/** Keeps transport credit separate from locally queued bytes. */
export class DeviceCreditSender {
  private readonly queue: BoundedSendQueue;
  private sent = 0;
  private acknowledged = 0;
  private pending: (() => void) | undefined;
  private closed = false;

  constructor(private readonly options: {
    maxQueuedBytes: number; maxPayloadBytes: number; windowBytes: number;
    send: (bytes: Buffer, done: (error?: Error) => void) => void;
    onDrain: () => void; onError: () => void;
  }) {
    if (!Number.isSafeInteger(options.windowBytes) || options.windowBytes < options.maxPayloadBytes + 16) {
      throw new TypeError("Invalid device credit window.");
    }
    this.queue = new BoundedSendQueue({ maxBytes: options.maxQueuedBytes, maxSegmentBytes: options.maxPayloadBytes,
      send: (bytes, _binary, done) => {
        const send = () => {
          const charge = bytes.length + 16;
          if (charge > options.windowBytes - (this.sent - this.acknowledged)) { this.pending = send; return; }
          if (!Number.isSafeInteger(this.sent + charge)) { this.fail(); return; }
          this.pending = undefined;
          this.sent += charge;
          options.send(bytes, done);
        };
        send();
      }, onDrain: options.onDrain, onError: () => this.fail() });
  }
  write(bytes: Buffer): void { this.queue.write(bytes, true); }
  acknowledge(total: number): void {
    if (this.closed) return;
    if (!Number.isSafeInteger(total) || total <= this.acknowledged || total > this.sent) { this.fail(); return; }
    this.acknowledged = total;
    this.pending?.();
  }
  close(): void { this.closed = true; this.pending = undefined; this.queue.close(); }
  private fail(): void { if (!this.closed) { this.close(); this.options.onError(); } }
}
