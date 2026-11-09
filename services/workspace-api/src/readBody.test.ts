import { describe, expect, it } from "vitest";
import { readBodyAtMost } from "./readBody";

/** A reader over `chunks`, one per read. */
function reader(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }).getReader();
}

const bytesOf = (text: string) => new TextEncoder().encode(text);

describe("readBodyAtMost", () => {
  it("reads a body in many chunks up to the limit", async () => {
    const read = await readBodyAtMost(reader([bytesOf("dohc "), bytesOf("crash "), bytesOf("report")]), 17);
    expect("bytes" in read && new TextDecoder().decode(read.bytes)).toBe("dohc crash report");
  });

  it("reads an empty body", async () => {
    const read = await readBodyAtMost(reader([]), 10);
    expect("bytes" in read && read.bytes.byteLength).toBe(0);
  });

  it("holds less than twice what has arrived, and never more than the limit", async () => {
    const small = await readBodyAtMost(reader(Array.from({ length: 1000 }, () => bytesOf("x"))), 96 * 1024);
    expect("bytes" in small && small.bytes.byteLength).toBe(1000);
    expect("bytes" in small && small.bytes.buffer.byteLength).toBeLessThan(2000);
    const full = await readBodyAtMost(reader(Array.from({ length: 100 }, () => bytesOf("x"))), 100);
    expect("bytes" in full && full.bytes.buffer.byteLength).toBe(100);
  });

  it("stops at the chunk that passes the limit and leaves the rest to read", async () => {
    const rest = reader([bytesOf("x".repeat(60)), bytesOf("y".repeat(60)), bytesOf("z")]);
    expect(await readBodyAtMost(rest, 100)).toEqual({ tooLarge: 120 });
    const { value } = await rest.read();
    expect(new TextDecoder().decode(value)).toBe("z");
  });
});
