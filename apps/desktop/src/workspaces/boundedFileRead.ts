import type { FileHandle } from "node:fs/promises";

type BoundedFileHandle = Pick<FileHandle, "read" | "stat">;

export class BoundedFileReadChangedError extends Error {}
export class BoundedFileReadUnverifiableError extends Error {}
export class BoundedFileReadNotFileError extends Error {}

export class BoundedFileReadTooLargeError extends Error {
  constructor(readonly size: bigint) {
    super("File exceeds the bounded read limit.");
  }
}

export interface BoundedFileReadResult {
  bytes: Buffer;
  /** Exact size when bounded; limit + 1 when a stable file is truncated. */
  totalByteLength: number;
}

async function statHandle(handle: BoundedFileHandle) {
  try {
    return await handle.stat({ bigint: true });
  } catch {
    throw new BoundedFileReadUnverifiableError();
  }
}

function assertLimit(maxBytes: number): void {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes >= Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError("Bounded file read limit must be a safe integer.");
  }
}

async function fillFromStart(
  handle: BoundedFileHandle,
  buffer: Buffer,
): Promise<number> {
  let total = 0;
  while (total < buffer.length) {
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        total,
      ));
    } catch {
      throw new BoundedFileReadUnverifiableError();
    }
    if (
      !Number.isSafeInteger(bytesRead) ||
      bytesRead < 0 ||
      bytesRead > buffer.length - total
    ) {
      throw new BoundedFileReadUnverifiableError();
    }
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total;
}

/**
 * Read one stable file exactly. The extra byte detects growth without ever
 * allocating in proportion to an already-oversized file.
 */
export async function readFileHandleExact(
  handle: BoundedFileHandle,
  maxBytes: number,
): Promise<BoundedFileReadResult> {
  assertLimit(maxBytes);
  const before = await statHandle(handle);
  if (!before.isFile()) throw new BoundedFileReadNotFileError();
  if (before.size < 0n) throw new BoundedFileReadUnverifiableError();
  if (before.size > BigInt(maxBytes)) {
    throw new BoundedFileReadTooLargeError(before.size);
  }

  const expectedBytes = Number(before.size);
  const buffer = Buffer.allocUnsafe(expectedBytes + 1);
  const bytesRead = await fillFromStart(handle, buffer);
  const after = await statHandle(handle);
  if (after.size !== before.size || bytesRead !== expectedBytes) {
    throw new BoundedFileReadChangedError();
  }
  return {
    bytes: buffer.subarray(0, expectedBytes),
    totalByteLength: expectedBytes,
  };
}

/** Read a stable prefix, retaining one byte beyond the text-view limit. */
export async function readFileHandleTruncated(
  handle: BoundedFileHandle,
  maxBytes: number,
): Promise<BoundedFileReadResult> {
  assertLimit(maxBytes);
  const before = await statHandle(handle);
  if (!before.isFile()) throw new BoundedFileReadNotFileError();
  if (before.size < 0n) throw new BoundedFileReadUnverifiableError();

  const limit = BigInt(maxBytes);
  const truncated = before.size > limit;
  const expectedBytes = truncated ? maxBytes + 1 : Number(before.size);
  const buffer = Buffer.allocUnsafe(
    Number(before.size < limit ? before.size : limit) + 1,
  );
  const bytesRead = await fillFromStart(handle, buffer);
  const after = await statHandle(handle);
  if (after.size !== before.size || bytesRead !== expectedBytes) {
    throw new BoundedFileReadChangedError();
  }
  return {
    bytes: buffer.subarray(0, expectedBytes),
    totalByteLength: truncated ? maxBytes + 1 : expectedBytes,
  };
}
