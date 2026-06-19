import { describe, expect, it } from "vitest";
import { buildStoreZip, crc32 } from "./zipWriter";

// Pure reader for the test: walks the central directory the way unzip does
// (EOCD → central headers → local headers) so the writer is verified against
// the FORMAT, not against itself.
function readZip(zip: Buffer): Array<{ path: string; data: Buffer; crc: number }> {
  const eocdOffset = zip.length - 22;
  expect(zip.readUInt32LE(eocdOffset)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocdOffset + 10);
  let cursor = zip.readUInt32LE(eocdOffset + 16);
  const entries: Array<{ path: string; data: Buffer; crc: number }> = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(cursor + 16);
    const size = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const path = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    // Follow the offset to the local header and read the stored bytes.
    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({ path, data: zip.subarray(dataStart, dataStart + size), crc });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe("crc32", () => {
  it("matches the IEEE reference vector", () => {
    // The canonical CRC-32 check value: crc32("123456789") = 0xCBF43926.
    expect(crc32(Buffer.from("123456789", "ascii"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe("buildStoreZip", () => {
  it("round-trips entries through a format-level reader", () => {
    const zip = buildStoreZip([
      { path: "notes/today.md", data: Buffer.from("# Today\n") },
      { path: "b.md", data: Buffer.from("beta") },
      { path: "empty.md", data: Buffer.alloc(0) },
    ]);
    const entries = readZip(zip);
    expect(entries.map((entry) => entry.path)).toEqual([
      "notes/today.md",
      "b.md",
      "empty.md",
    ]);
    expect(entries[0]!.data.toString("utf8")).toBe("# Today\n");
    expect(entries[2]!.data.length).toBe(0);
    for (const entry of entries) {
      expect(entry.crc).toBe(crc32(entry.data));
    }
  });

  it("encodes UTF-8 names with the UTF-8 flag set", () => {
    const zip = buildStoreZip([{ path: "héllo/привет.md", data: Buffer.from("x") }]);
    const [entry] = readZip(zip);
    expect(entry!.path).toBe("héllo/привет.md");
    // General-purpose bit 11 (0x0800) in the local header.
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800);
  });

  it("refuses more entries than the container can address", () => {
    const tiny = { path: "x", data: Buffer.alloc(0) };
    const entries = Array.from({ length: 65_536 }, () => tiny);
    expect(() => buildStoreZip(entries)).toThrow(/cannot hold/);
  });

  it("refuses zip-slip entry names at the container boundary", () => {
    const data = Buffer.from("x");
    // Each of these can write OUTSIDE the extraction dir in some extractor.
    for (const path of [
      "../evil.md", // parent traversal
      "a/../../evil.md", // traversal mid-path
      "/etc/passwd", // absolute (POSIX)
      "C:\\Windows\\evil", // drive letter
      "a\\b.md", // backslash separator (Windows)
      "a//b.md", // empty segment
      "a/./b.md", // dot segment
      "", // empty name
    ]) {
      expect(() => buildStoreZip([{ path, data }])).toThrow(
        /absolute|drive letter|backslash|unsafe segment|empty/,
      );
    }
    // A clean relative POSIX name (including dots WITHIN a segment) is fine.
    expect(() => buildStoreZip([{ path: "notes/my.notes.md", data }])).not.toThrow();
  });
});
