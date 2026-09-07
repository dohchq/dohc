/** Reads at most maxBytes before decoding JSON; cancellation also stops the stream. */
export async function readBoundedJson(message: Request | Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("Invalid JSON body limit.");
  signal.throwIfAborted();
  const reader = message.body?.getReader();
  if (!reader) throw new TypeError("Missing JSON body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (next.value.byteLength > maxBytes - size) throw new RangeError("JSON body exceeds limit.");
      size += next.value.byteLength;
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
