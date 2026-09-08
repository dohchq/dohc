/** Serializes transport callbacks and counts all retained bytes, including the active send. */
export class BoundedSendQueue {
  private queue: { bytes: Buffer; binary: boolean; offset: number }[] = [];
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

  write(bytes: Buffer, binary: boolean): void {
    const retained = bytes.length + 16;
    if (this.closed || !bytes.length || (!binary && bytes.length > this.options.maxSegmentBytes) ||
      retained > this.options.maxBytes - this.pending) {
      this.close(); this.options.onError(); return;
    }
    this.pending += retained;
    this.queue.push({ bytes: Buffer.from(bytes), binary, offset: 0 });
    this.pump();
  }

  close(): void { this.closed = true; this.queue = []; this.pending = 0; }

  private pump(): void {
    if (this.closed || this.sending) return;
    const next = this.queue[0];
    if (!next) { this.options.onDrain(); return; }
    this.sending = true;
    try {
      const segment = next.bytes.subarray(next.offset, next.offset + this.options.maxSegmentBytes);
      this.options.send(segment, next.binary, error => {
        if (this.closed) return;
        this.sending = false;
        if (error) { this.close(); this.options.onError(); return; }
        next.offset += segment.length;
        if (next.offset === next.bytes.length) {
          this.pending -= next.bytes.length + 16;
          this.queue.shift();
        }
        this.pump();
      });
    } catch { this.close(); this.options.onError(); }
  }
}
