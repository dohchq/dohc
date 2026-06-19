// Store-only ZIP writer (PKWARE APPNOTE container format, method 0 — no
// compression). Pure and dependency-free on purpose: workspace exports are
// local folders where deflate buys little, no zip dependency exists anywhere
// in the lockfile, and ~120 auditable lines beat a third-party archiver on a
// privileged-main-process surface. If compression ever becomes a requirement,
// yazl is the smallest credible dep — decide once at review.

export interface ZipEntry {
  // Forward-slash relative path inside the archive ("notes/today.md").
  path: string;
  data: Uint8Array;
  // Entry timestamp; encoded as DOS time (2-second resolution, local time).
  modifiedAt?: Date;
}

// Container-format bounds (not policy): EOCD entry counts are u16 and sizes
// are u32, so a store-only (non-zip64) archive cannot hold more. Policy caps
// (file count / total bytes) belong to the caller that gathers entries.
const MAX_ENTRIES = 0xffff;
const MAX_U32 = 0xffffffff;

// CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) — the checksum every
// zip reader verifies per entry. Table-driven; table built once at load.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// DOS date/time pair (the zip header's native timestamp). Years before the
// epoch of the format (1980) clamp to it.
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// Entry names MUST be relative POSIX paths. Many extractors honor an absolute
// path, a drive letter, backslashes (Windows separators), or a ".." segment to
// write OUTSIDE the extraction directory (zip-slip). This is the container
// boundary, so refuse them here — no buildStoreZip caller can emit a slip name
// even if its own name construction is ever wrong.
function assertSafeEntryName(name: string): void {
  if (name.length === 0) throw new Error("Zip entry name is empty");
  if (name.startsWith("/")) throw new Error(`Zip entry name is absolute: ${name}`);
  if (/^[a-zA-Z]:/.test(name)) throw new Error(`Zip entry name has a drive letter: ${name}`);
  if (name.includes("\\")) throw new Error(`Zip entry name has a backslash: ${name}`);
  for (const segment of name.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`Zip entry name has an unsafe segment: ${name}`);
    }
  }
}

// Builds the complete archive in memory: local file headers + data, then the
// central directory, then the end-of-central-directory record. Names are
// UTF-8 (general-purpose flag bit 11 set so readers decode them as such).
export function buildStoreZip(entries: ReadonlyArray<ZipEntry>): Buffer {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`Zip cannot hold more than ${MAX_ENTRIES} entries`);
  }
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    assertSafeEntryName(entry.path);
    if (entry.data.length > MAX_U32) {
      throw new Error(`Zip entry too large: ${entry.path}`);
    }
    const name = Buffer.from(entry.path, "utf8");
    const { time, date } = dosDateTime(entry.modifiedAt ?? new Date());
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract (2.0)
    local.writeUInt16LE(0x0800, 6); // general purpose flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method 0 = store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18); // compressed size (= stored)
    local.writeUInt32LE(entry.data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); // central directory header signature
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed to extract
    header.writeUInt16LE(0x0800, 8); // flags: UTF-8 names
    header.writeUInt16LE(0, 10); // method 0 = store
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(entry.data.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // extra field length
    header.writeUInt16LE(0, 32); // comment length
    header.writeUInt16LE(0, 34); // disk number start
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(0, 38); // external attributes
    header.writeUInt32LE(offset, 42); // local header offset

    chunks.push(local, name, Buffer.from(entry.data));
    central.push(header, name);
    offset += local.length + name.length + entry.data.length;
    if (offset > MAX_U32) throw new Error("Zip exceeds the 4GB container limit");
  }

  const centralSize = central.reduce((sum, buf) => sum + buf.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // central directory disk
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, ...central, eocd]);
}
