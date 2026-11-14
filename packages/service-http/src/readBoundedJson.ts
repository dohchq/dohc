/** Reads at most maxBytes of a body; cancellation also stops the stream. */
export async function readBoundedBytes(
  message: Request | Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("Invalid body limit.");
  signal.throwIfAborted();
  const reader = message.body?.getReader();
  if (!reader) throw new TypeError("Missing body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (next.value.byteLength > maxBytes - size) throw new RangeError("Body exceeds limit.");
      size += next.value.byteLength;
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Reads at most maxBytes before decoding JSON; cancellation also stops the stream. */
export async function readBoundedJson(
  message: Request | Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const bytes = await readBoundedBytes(message, maxBytes, signal);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
