/** A body read up to a limit: its bytes, or how many had arrived when it passed the limit. */
export type BodyRead = { bytes: Uint8Array<ArrayBuffer> } | { tooLarge: number };

/**
 * Reads a body into one buffer until it ends or passes `maxBytes`. The buffer
 * starts at the first chunk's size and doubles as more arrives, up to
 * `maxBytes`, so it holds less than twice what has arrived and never one
 * object per chunk. The reader stays locked, so the caller can drain the rest.
 */
export async function readBodyAtMost(reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number): Promise<BodyRead> {
  let bytes = new Uint8Array(0);
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: bytes.subarray(0, total) };
    const needed = total + value.byteLength;
    if (needed > maxBytes) return { tooLarge: needed };
    if (needed > bytes.byteLength) {
      const grown = new Uint8Array(Math.min(maxBytes, Math.max(needed, bytes.byteLength * 2)));
      grown.set(bytes.subarray(0, total));
      bytes = grown;
    }
    bytes.set(value, total);
    total = needed;
  }
}
