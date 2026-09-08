import { relayError } from "./errors";

export async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > maxBytes) throw relayError("payload_too_large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw relayError("payload_too_large");
  return bytes;
}

export function arrayBufferForBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
