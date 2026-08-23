import { describe, expect, it, vi } from "vitest";
import {
  BoundedFileReadChangedError,
  BoundedFileReadTooLargeError,
  BoundedFileReadUnverifiableError,
  readFileHandleExact,
  readFileHandleTruncated,
} from "./boundedFileRead";

function fakeHandle(input: {
  content: Buffer;
  sizes: bigint[];
  maxReadBytes?: number;
  stopAfterBytes?: number;
}) {
  const bufferLengths: number[] = [];
  let statIndex = 0;
  return {
    bufferLengths,
    handle: {
      stat: vi.fn(async () => {
        const size = input.sizes[Math.min(statIndex, input.sizes.length - 1)]!;
        statIndex += 1;
        return { size, isFile: () => true };
      }),
      read: vi.fn(
        async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          bufferLengths.push(buffer.length);
          const stop = input.stopAfterBytes ?? input.content.length;
          const available = Math.max(0, Math.min(stop, input.content.length) - position);
          const bytesRead = Math.min(
            available,
            length,
            input.maxReadBytes ?? length,
          );
          input.content.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead, buffer };
        },
      ),
    },
  };
}

describe("bounded file reads", () => {
  it("allocates only a small asset's measured size plus one byte", async () => {
    const fake = fakeHandle({
      content: Buffer.from("small"),
      sizes: [5n, 5n],
      maxReadBytes: 2,
    });

    await expect(
      readFileHandleExact(fake.handle as never, 64 * 1024 * 1024),
    ).resolves.toEqual({
      bytes: Buffer.from("small"),
      totalByteLength: 5,
    });
    expect(new Set(fake.bufferLengths)).toEqual(new Set([6]));
  });

  it("rejects an initially oversized asset before allocating or reading", async () => {
    const fake = fakeHandle({ content: Buffer.alloc(0), sizes: [65n] });

    await expect(readFileHandleExact(fake.handle as never, 64)).rejects.toBeInstanceOf(
      BoundedFileReadTooLargeError,
    );
    expect(fake.handle.read).not.toHaveBeenCalled();
  });

  it("refuses an exact read that grows, shrinks, or ends early", async () => {
    const grown = fakeHandle({ content: Buffer.from("hello!"), sizes: [5n, 6n] });
    const shrunk = fakeHandle({ content: Buffer.from("hell"), sizes: [5n, 4n] });
    const short = fakeHandle({
      content: Buffer.from("hello"),
      sizes: [5n, 5n],
      stopAfterBytes: 4,
    });

    await expect(readFileHandleExact(grown.handle as never, 64)).rejects.toBeInstanceOf(
      BoundedFileReadChangedError,
    );
    await expect(readFileHandleExact(shrunk.handle as never, 64)).rejects.toBeInstanceOf(
      BoundedFileReadChangedError,
    );
    await expect(readFileHandleExact(short.handle as never, 64)).rejects.toBeInstanceOf(
      BoundedFileReadChangedError,
    );
  });

  it("keeps a stable oversized text prefix and refuses size changes", async () => {
    const stable = fakeHandle({
      content: Buffer.from("0123456789"),
      sizes: [10n, 10n],
    });
    const changed = fakeHandle({
      content: Buffer.from("0123456789"),
      sizes: [10n, 11n],
    });
    const shrunk = fakeHandle({
      content: Buffer.from("0123"),
      sizes: [10n, 4n],
    });
    const short = fakeHandle({
      content: Buffer.from("0123456789"),
      sizes: [10n, 10n],
      stopAfterBytes: 4,
    });

    await expect(readFileHandleTruncated(stable.handle as never, 4)).resolves.toEqual({
      bytes: Buffer.from("01234"),
      totalByteLength: 5,
    });
    expect(new Set(stable.bufferLengths)).toEqual(new Set([5]));
    await expect(
      readFileHandleTruncated(changed.handle as never, 4),
    ).rejects.toBeInstanceOf(BoundedFileReadChangedError);
    await expect(
      readFileHandleTruncated(shrunk.handle as never, 4),
    ).rejects.toBeInstanceOf(BoundedFileReadChangedError);
    await expect(
      readFileHandleTruncated(short.handle as never, 4),
    ).rejects.toBeInstanceOf(BoundedFileReadChangedError);
  });

  it("maps a raw handle read failure to an unverifiable read", async () => {
    const fake = fakeHandle({ content: Buffer.from("small"), sizes: [5n] });
    fake.handle.read.mockRejectedValueOnce(new Error("raw I/O failure"));

    await expect(
      readFileHandleExact(fake.handle as never, 64),
    ).rejects.toBeInstanceOf(BoundedFileReadUnverifiableError);
  });
});
