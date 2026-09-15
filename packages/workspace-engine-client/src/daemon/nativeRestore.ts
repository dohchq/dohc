function bound(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 5 || maxBytes > 0xffff_ffff) {
    throw new TypeError("Invalid native restore byte bound.");
  }
}

/** Call after reserving the output length; headerJson is already serialized under the caller's budget. */
export function encodeNativeRestoreInput(headerJson: Uint8Array, maxBytes: number): Uint8Array {
  bound(maxBytes);
  const length = 4 + headerJson.byteLength;
  if (headerJson.byteLength === 0 || length > maxBytes) throw new TypeError("Native restore input exceeds its byte bound.");
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, headerJson.byteLength, true);
  bytes.set(headerJson, 4);
  return bytes;
}
