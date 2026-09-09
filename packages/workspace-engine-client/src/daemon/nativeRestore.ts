/** Private native restore framing. The authenticated consumer owns JSON parsing and proof validation. */
export interface NativeRestoreProposalBytes {
  readonly receiptJson: Uint8Array;
  readonly candidateBytes: Uint8Array;
  readonly frozenStateBytes: Uint8Array;
  readonly pointStateBytes: Uint8Array;
  readonly nativeSourceBytes: readonly Uint8Array[];
}

function bound(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 8 || maxBytes > 0xffff_ffff) {
    throw new TypeError("Invalid native restore byte bound.");
  }
}

/** Call after reserving the output length; headerJson is already serialized under the caller's budget. */
export function encodeNativeRestoreInput(headerJson: Uint8Array, ownerOrigin: Uint8Array, maxBytes: number): Uint8Array {
  bound(maxBytes);
  const length = 8 + headerJson.byteLength + ownerOrigin.byteLength;
  if (headerJson.byteLength === 0 || length > maxBytes) throw new TypeError("Native restore input exceeds its byte bound.");
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, headerJson.byteLength, true);
  bytes.set(headerJson, 4);
  view.setUint32(4 + headerJson.byteLength, ownerOrigin.byteLength, true);
  bytes.set(ownerOrigin, 8 + headerJson.byteLength);
  return bytes;
}

/** Returns views into the owned response buffer. Receipt JSON remains raw until its consumer reserves parsing memory. */
export function decodeNativeRestoreProposal(bytes: Uint8Array, maxBytes: number, maxEvents: number): NativeRestoreProposalBytes {
  bound(maxBytes);
  if (bytes.byteLength > maxBytes || !Number.isSafeInteger(maxEvents) || maxEvents < 1) {
    throw new TypeError("Invalid native restore proposal bounds.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const field = (): Uint8Array => {
    if (offset + 4 > bytes.byteLength) throw new TypeError("Truncated native restore field.");
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length > bytes.byteLength - offset) throw new TypeError("Truncated native restore field.");
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const receiptJson = field(), candidateBytes = field(), frozenStateBytes = field(), pointStateBytes = field();
  const nativeSourceBytes: Uint8Array[] = [];
  while (offset < bytes.byteLength) {
    if (nativeSourceBytes.length >= maxEvents) throw new TypeError("Native restore source count exceeds its bound.");
    nativeSourceBytes.push(field());
  }
  return { receiptJson, candidateBytes, frozenStateBytes, pointStateBytes, nativeSourceBytes };
}
