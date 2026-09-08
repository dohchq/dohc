/** Serializes data and coalesces cumulative credits into one pending scalar. */
export class DeviceControlWriter {
  private active = false;
  private closed = false;
  private pending: { bytes: Buffer; binary: boolean; done: (error?: Error) => void } | undefined;
  private credit: number | undefined;
  constructor(private readonly options: {
    send: (bytes: Buffer, binary: boolean, done: (error?: Error) => void) => void;
    onError: () => void;
  }) {}
  write(bytes: Buffer, binary: boolean, done: (error?: Error) => void): void {
    if (this.closed) return;
    if (this.pending) { this.fail(); return; }
    this.pending = { bytes, binary, done };
    this.pump();
  }
  acknowledge(receivedBytes: number): void {
    if (this.closed) return;
    this.credit = receivedBytes;
    this.pump();
  }
  close(): void { this.closed = true; this.pending = undefined; this.credit = undefined; }
  private fail(): void { if (!this.closed) { this.close(); this.options.onError(); } }
  private pump(): void {
    if (this.closed || this.active) return;
    const credit = this.credit;
    const next = credit === undefined ? this.pending : {
      bytes: Buffer.from(JSON.stringify({ type: "liveHost.credit", version: 1, receivedBytes: credit })),
      binary: false, done: () => {},
    };
    if (!next) return;
    if (credit === undefined) this.pending = undefined; else this.credit = undefined;
    this.active = true;
    try {
      this.options.send(next.bytes, next.binary, error => {
        if (this.closed) return;
        this.active = false;
        if (error) { this.fail(); return; }
        next.done();
        this.pump();
      });
    } catch { this.fail(); }
  }
}

/** Accounts payload and framing until the receiver acknowledges consumption. */
export class DeviceCreditWindow {
  private sent = 0;
  private acknowledged = 0;
  constructor(private readonly maximum: number, private readonly payload: number) {}
  receive(bytes: number): void {
    const charge = bytes + 16;
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.payload ||
      charge > this.maximum - (this.sent - this.acknowledged) || !Number.isSafeInteger(this.sent + charge)) {
      throw new Error("Device credit exhausted.");
    }
    this.sent += charge;
  }
  acknowledge(total: number): void {
    if (!Number.isSafeInteger(total) || total <= this.acknowledged || total > this.sent) throw new Error("Invalid device credit.");
    this.acknowledged = total;
  }
}
