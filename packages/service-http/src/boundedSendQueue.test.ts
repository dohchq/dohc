import { describe, expect, it } from "vitest";
import { BoundedSendQueue } from "./boundedSendQueue";

describe("bounded transport send queue", () => {
  function fixture(maxBytes = 100) {
    const sent: { bytes: Buffer; binary: boolean; callback: (error?: Error) => void }[] = [];
    let drains = 0, errors = 0;
    const queue = new BoundedSendQueue({ maxBytes, maxSegmentBytes: 8,
      send(bytes, binary, callback) { sent.push({ bytes, binary, callback }); },
      onDrain() { drains++; }, onError() { errors++; } });
    return { queue, sent, drains: () => drains, errors: () => errors };
  }
  it("segments byte streams without changing order and drains only after callbacks", () => {
    const run = fixture();
    const source = Buffer.from("0123456789abcdefghi");
    run.queue.write(source, true);
    source.fill(0);
    expect(run.sent).toHaveLength(1);
    run.sent[0]!.callback();
    expect(run.sent).toHaveLength(2);
    run.sent[1]!.callback();
    expect(run.sent).toHaveLength(3);
    expect(run.drains()).toBe(0);
    run.sent[2]!.callback();
    expect(Buffer.concat(run.sent.map(item => item.bytes)).toString()).toBe("0123456789abcdefghi");
    expect(run.drains()).toBe(1);
  });
  it("counts the stalled active send and refuses queued overflow", () => {
    const run = fixture(48);
    run.queue.write(Buffer.alloc(8), true);
    run.queue.write(Buffer.alloc(8), true);
    run.queue.write(Buffer.alloc(1), true);
    expect(run.errors()).toBe(1);
    run.sent[0]!.callback();
    expect(run.sent).toHaveLength(1);
    expect(run.drains()).toBe(0);
  });
  it("counts framing overhead for tiny segments", () => {
    const run = fixture(24);
    run.queue.write(Buffer.alloc(1), true);
    run.queue.write(Buffer.alloc(1), true);
    expect(run.errors()).toBe(1);
  });
  it("retains one bounded input buffer when a peer negotiates tiny segments", () => {
    const sent: Buffer[] = [];
    const callbacks: (() => void)[] = [];
    let errors = 0;
    const queue = new BoundedSendQueue({ maxBytes: 24, maxSegmentBytes: 1,
      send(bytes, _binary, done) { sent.push(Buffer.from(bytes)); callbacks.push(done); }, onDrain() {}, onError() { errors++; } });
    queue.write(Buffer.from("12345678"), true);
    for (let n = 0; n < 8; n++) callbacks[n]!();
    expect(Buffer.concat(sent).toString()).toBe("12345678"); expect(errors).toBe(0);
  });
  it("keeps text controls whole and rejects oversize controls", () => {
    const run = fixture();
    run.queue.write(Buffer.from("control"), false);
    expect(run.sent[0]!.binary).toBe(false);
    run.queue.write(Buffer.alloc(9), false);
    expect(run.errors()).toBe(1);
  });
  it("stops after send errors and ignores late callbacks after close", () => {
    const run = fixture();
    run.queue.write(Buffer.alloc(9), true);
    run.sent[0]!.callback(new Error("closed"));
    expect(run.errors()).toBe(1);
    expect(run.sent).toHaveLength(1);
    const other = fixture();
    other.queue.write(Buffer.alloc(9), true);
    other.queue.close();
    other.sent[0]!.callback();
    expect(other.sent).toHaveLength(1);
    expect(other.drains()).toBe(0);
  });
});
