/** Serializes transport callbacks and counts all retained bytes, including the active send. */
export class BoundedSendQueue {
  private queue: { bytes: Buffer; binary: boolean }[] = [];
  private pending = 0;
  private sending = false;
  private closed = false;

  constructor(private readonly options: {
    maxBytes: number; maxSegmentBytes: number;
    send: (bytes: Buffer, binary: boolean, done: (error?: Error) => void) => void;
    onDrain: () => void; onError: () => void;
  }) {
    if (!Number.isSafeInteger(options.maxBytes) || !Number.isSafeInteger(options.maxSegmentBytes) ||
      options.maxSegmentBytes <= 0 || options.maxBytes < options.maxSegmentBytes + 16) throw new TypeError("Invalid send queue limits.");
  }

  write(bytes: Buffer, binary: boolean): boolean {
    const count = binary ? Math.ceil(bytes.length / this.options.maxSegmentBytes) : 1;
    const retained = bytes.length + count * 16;
    if (this.closed || !bytes.length || (!binary && bytes.length > this.options.maxSegmentBytes) ||
      retained > this.options.maxBytes - this.pending) {
      this.close(); this.options.onError(); return false;
    }
    this.pending += retained;
    for (let offset = 0; offset < bytes.length; offset += this.options.maxSegmentBytes) {
      this.queue.push({ bytes: Buffer.from(bytes.subarray(offset, offset + this.options.maxSegmentBytes)), binary });
    }
    this.pump();
    return false;
  }

  close(): void { this.closed = true; this.queue = []; this.pending = 0; }

  private pump(): void {
    if (this.closed || this.sending) return;
    const next = this.queue.shift();
    if (!next) { this.options.onDrain(); return; }
    this.sending = true;
    try {
      this.options.send(next.bytes, next.binary, error => {
        if (this.closed) return;
        this.sending = false;
        this.pending -= next.bytes.length + 16;
        if (error) { this.close(); this.options.onError(); return; }
        this.pump();
      });
    } catch { this.close(); this.options.onError(); }
  }
}
