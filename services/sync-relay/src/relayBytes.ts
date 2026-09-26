import { relayError, RelayError } from "./errors";

export async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > maxBytes) throw relayError("payload_too_large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw relayError("payload_too_large");
  return bytes;
}

/**
 * Reads a body the HTTP adapter streams instead of buffering, up to
 * `maxBytes` and within `timeoutMs`. Past either bound it stops reading and
 * throws; the adapter answers and closes the connection without draining it.
 */
export async function readStreamedBytes(request: Request, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > maxBytes) throw relayError("payload_too_large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RelayError("bad_request", "request body timed out", 408)), timeoutMs);
  });
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const read = reader.read();
      // A read left pending at a bound rejects when the adapter closes the connection.
      read.catch(() => undefined);
      const item = await Promise.race([read, deadline]);
      if (item.done) return Buffer.concat(chunks);
      received += item.value.byteLength;
      if (received > maxBytes) throw relayError("payload_too_large");
      chunks.push(item.value);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function arrayBufferForBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
