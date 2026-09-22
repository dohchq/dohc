import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { DatasetCursor } from "./journal.js";

export const RECOVERY_CHUNK_BYTES = 1024 * 1024;
const MAGIC = Buffer.from("DOHCDR01");
const MANIFEST = 1, DATA = 2, ENTRY_END = 3, END = 4;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface RecoveryEntry {
  /** An opaque identifier, never interpreted as a path. */
  id: string;
  kind: "checkpoint" | "events" | "history" | "artifact" | "attachment";
  byteLength: number;
  sha256: string;
  role?: "source" | "schema" | "definition";
  afterRevision?: number;
  throughRevision?: number;
}
export interface DatasetRecoveryManifest {
  format: "dohc-dataset-recovery-v1";
  cursor: DatasetCursor;
  checkpoint: DatasetCursor;
  /** History includes prior checkpoint transitions, operations, and their durable receipt data. */
  entries: RecoveryEntry[];
}
export interface RecoveryLimits {
  /** Host reservation for all checkpoint, history, source, and attachment bytes combined. */
  maxTotalBytes: number;
  maxEntries?: number;
}
interface RecoveryControls {
  /** Recheck the current principal's authority. The manifest hash is integrity, not authorization. */
  authorize(): void | Promise<void>;
  signal?: AbortSignal;
  limits: RecoveryLimits;
}
export interface StagedDatasetRecovery {
  manifest: DatasetRecoveryManifest;
  directory: string;
  files: ReadonlyArray<{ entry: RecoveryEntry; path: string }>;
  /** Does not activate data. The host validates content and atomically installs it separately. */
  dispose(): Promise<void>;
}

function fail(message: string): never { throw new Error(`Invalid dataset recovery: ${message}`); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail("unexpected fields.");
}
function integer(value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) fail("invalid length or revision.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 4096 || /[\u0000-\u001f]/u.test(value)) fail("invalid identifier.");
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("invalid SHA-256.");
  return value;
}
function cursor(value: unknown): DatasetCursor {
  const c = record(value);
  keys(c, ["workspaceId", "datasetId", "hostEpoch", "approvedRevisionHash", "revision", "digest"]);
  return { workspaceId: text(c.workspaceId), datasetId: text(c.datasetId), hostEpoch: text(c.hostEpoch),
    approvedRevisionHash: digest(c.approvedRevisionHash), revision: integer(c.revision), digest: digest(c.digest) };
}
function limits(value: RecoveryLimits) {
  const maxEntries = integer(value.maxEntries ?? 4096, 5);
  if (maxEntries > 4096) fail("too many allowed entries.");
  return { maxTotalBytes: integer(value.maxTotalBytes, 1), maxEntries };
}
function manifest(value: unknown, bounds: RecoveryLimits): DatasetRecoveryManifest {
  const max = limits(bounds), m = record(value);
  keys(m, ["format", "cursor", "checkpoint", "entries"]);
  if (m.format !== "dohc-dataset-recovery-v1") fail("unsupported format.");
  const head = cursor(m.cursor), checkpoint = cursor(m.checkpoint);
  if (head.workspaceId !== checkpoint.workspaceId || head.datasetId !== checkpoint.datasetId || head.hostEpoch !== checkpoint.hostEpoch ||
      head.approvedRevisionHash !== checkpoint.approvedRevisionHash || checkpoint.revision > head.revision ||
      (checkpoint.revision === head.revision && checkpoint.digest !== head.digest)) fail("checkpoint scope or cursor differs.");
  if (!Array.isArray(m.entries) || m.entries.length < 5 || m.entries.length > max.maxEntries) fail("entry count exceeds its limit.");
  let total = 0, lastRevision = checkpoint.revision;
  const ids = new Set<string>(), roles = new Set<string>();
  let checkpoints = 0, histories = 0;
  const entries = m.entries.map(raw => {
    const e = record(raw);
    keys(e, ["id", "kind", "byteLength", "sha256"], ["role", "afterRevision", "throughRevision"]);
    const id = text(e.id), byteLength = integer(e.byteLength), sha256 = digest(e.sha256);
    if (ids.has(id)) fail("duplicate entry identifier.");
    ids.add(id); total += byteLength;
    if (!Number.isSafeInteger(total) || total > max.maxTotalBytes) fail("host storage reservation exceeded.");
    if (!["checkpoint", "events", "history", "artifact", "attachment"].includes(String(e.kind))) fail("unknown entry kind.");
    const entry: RecoveryEntry = { id, kind: e.kind as RecoveryEntry["kind"], byteLength, sha256 };
    if (e.kind === "artifact") {
      if (!["source", "schema", "definition"].includes(String(e.role)) || roles.has(String(e.role)) || id !== `artifact:${e.role}`) fail("ambiguous artifact role.");
      roles.add(String(e.role)); entry.role = e.role as RecoveryEntry["role"];
    } else if (Object.hasOwn(e, "role")) fail("unexpected artifact role.");
    if (e.kind === "events") {
      const after = integer(e.afterRevision), through = integer(e.throughRevision);
      if (after !== lastRevision || through <= after || through > head.revision) fail("noncontiguous event range.");
      lastRevision = through; entry.afterRevision = after; entry.throughRevision = through;
    } else if (Object.hasOwn(e, "afterRevision") || Object.hasOwn(e, "throughRevision")) fail("unexpected event range.");
    if (e.kind === "checkpoint" && (++checkpoints !== 1 || id !== "checkpoint" || byteLength === 0)) fail("ambiguous checkpoint.");
    if (e.kind === "history" && (++histories !== 1 || id !== "history")) fail("ambiguous history.");
    return entry;
  });
  if (checkpoints !== 1 || histories !== 1 || roles.size !== 3 || lastRevision !== head.revision) fail("incomplete recovery manifest.");
  return { format: "dohc-dataset-recovery-v1", cursor: head, checkpoint, entries };
}

/** Canonical header bytes let the authenticated host bind a transfer before accepting its contents. */
export function encodeRecoveryManifest(input: DatasetRecoveryManifest, bounds: RecoveryLimits): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(manifest(input, bounds)));
  if (bytes.byteLength > RECOVERY_CHUNK_BYTES) fail("manifest exceeds its bound.");
  return bytes;
}
export function recoveryManifestSha256(input: DatasetRecoveryManifest, bounds: RecoveryLimits): string {
  return sha(encodeRecoveryManifest(input, bounds));
}
async function authorize(options: RecoveryControls) {
  options.signal?.throwIfAborted();
  await options.authorize();
  options.signal?.throwIfAborted();
}
function frame(kind: number, bytes: Uint8Array = new Uint8Array()): Uint8Array {
  const result = Buffer.allocUnsafe(5 + bytes.byteLength);
  result[0] = kind; result.writeUInt32BE(bytes.byteLength, 1); result.set(bytes, 5);
  return result;
}
async function next<T>(iterator: AsyncIterator<T>, signal?: AbortSignal): Promise<IteratorResult<T>> {
  signal?.throwIfAborted();
  if (!signal) return iterator.next();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason ?? new Error("Recovery cancelled.")); });
  signal.addEventListener("abort", onAbort, { once: true });
  try { return await Promise.race([iterator.next(), cancelled]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
function release(iterator: AsyncIterator<unknown>) {
  // A transport blocked in next() may delay return(); it must not prevent cancellation cleanup.
  try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* Data validation does not depend on transport cleanup. */ }
}

export async function* writeDatasetRecovery(options: RecoveryControls & {
  manifest: DatasetRecoveryManifest;
  open(entry: RecoveryEntry): AsyncIterable<Uint8Array>;
}): AsyncGenerator<Uint8Array> {
  const header = encodeRecoveryManifest(options.manifest, options.limits);
  const pinned = manifest(JSON.parse(Buffer.from(header).toString()), options.limits);
  await authorize(options); yield Uint8Array.from(MAGIC);
  await authorize(options); yield frame(MANIFEST, header);
  for (const entry of pinned.entries) {
    const hash = createHash("sha256"); let size = 0;
    await authorize(options);
    const iterator = options.open({ ...entry })[Symbol.asyncIterator]();
    try {
      for (;;) {
        const item = await next(iterator, options.signal);
        if (item.done) break;
        await authorize(options);
        if (!(item.value instanceof Uint8Array) || item.value.byteLength > RECOVERY_CHUNK_BYTES) fail("source chunks exceed their bound.");
        if (!item.value.byteLength) fail("empty source chunk.");
        size += item.value.byteLength;
        if (size > entry.byteLength) fail("entry exceeds its declared length.");
        const bytes = Uint8Array.from(item.value);
        hash.update(bytes); yield frame(DATA, bytes);
      }
    } finally { release(iterator); }
    if (size !== entry.byteLength || hash.digest("hex") !== entry.sha256) fail("entry hash or length differs.");
    await authorize(options); yield frame(ENTRY_END);
  }
  await authorize(options); yield frame(END, Buffer.from(sha(header), "hex"));
}

class Reader {
  private buffered = new Uint8Array();
  private offset = 0;
  readonly iterator: AsyncIterator<Uint8Array>;
  constructor(stream: AsyncIterable<Uint8Array>, private controls: RecoveryControls) { this.iterator = stream[Symbol.asyncIterator](); }
  async bytes(length: number, allowEof = false): Promise<Uint8Array | null> {
    const output = new Uint8Array(length); let written = 0;
    while (written < length) {
      if (this.offset === this.buffered.byteLength) {
        await authorize(this.controls);
        const nextChunk = await next(this.iterator, this.controls.signal);
        if (nextChunk.done) {
          if (allowEof && written === 0) return null;
          return fail("truncated stream.");
        }
        if (!(nextChunk.value instanceof Uint8Array) || !nextChunk.value.byteLength || nextChunk.value.byteLength > RECOVERY_CHUNK_BYTES + 5) fail("transport chunks exceed their bound.");
        await authorize(this.controls);
        this.buffered = Uint8Array.from(nextChunk.value); this.offset = 0;
      }
      const count = Math.min(length - written, this.buffered.byteLength - this.offset);
      output.set(this.buffered.subarray(this.offset, this.offset + count), written);
      written += count; this.offset += count;
    }
    return output;
  }
  async frame(): Promise<{ kind: number; bytes: Uint8Array }> {
    await authorize(this.controls);
    const header = (await this.bytes(5))!;
    const size = new DataView(header.buffer, header.byteOffset, 5).getUint32(1);
    if (size > RECOVERY_CHUNK_BYTES) fail("frame exceeds its bound.");
    return { kind: header[0]!, bytes: (await this.bytes(size))! };
  }
}

/** Stages into a fresh host-owned directory. No manifest-supplied string becomes a filesystem path. */
export async function stageDatasetRecovery(options: RecoveryControls & {
  stream: AsyncIterable<Uint8Array>;
  stagingParent: string;
  expectedManifestSha256: string;
}): Promise<StagedDatasetRecovery> {
  digest(options.expectedManifestSha256); limits(options.limits);
  if (!isAbsolute(options.stagingParent)) fail("staging parent must be absolute.");
  const parent = await realpath(options.stagingParent), stat = await lstat(options.stagingParent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("staging parent must be a host-owned directory.");
  const reader = new Reader(options.stream, options);
  let directory: string | undefined;
  let disposed = false;
  const dispose = async () => {
    if (disposed || !directory) return;
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(directory)) !== resolve(directory)) fail("staging directory ownership changed.");
    await rm(directory, { recursive: true, force: true }); disposed = true;
  };
  try {
    await authorize(options);
    const magic = await reader.bytes(MAGIC.byteLength);
    if (!magic || !Buffer.from(magic).equals(MAGIC)) fail("wrong stream magic.");
    const header = await reader.frame();
    if (header.kind !== MANIFEST || sha(header.bytes) !== options.expectedManifestSha256) fail("manifest integrity differs.");
    const parsed = manifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(header.bytes)), options.limits);
    // Only a validated, reservation-bounded manifest can allocate staging space.
    directory = await mkdtemp(join(parent, "dohc-recovery-"));
    const files: Array<{ entry: RecoveryEntry; path: string }> = [];
    for (const [index, entry] of parsed.entries.entries()) {
      await authorize(options);
      const path = join(directory, `${index}.part`), handle = await open(path, "wx", 0o600);
      const hash = createHash("sha256"); let size = 0;
      try {
        for (;;) {
          const chunk = await reader.frame();
          if (chunk.kind === ENTRY_END && chunk.bytes.byteLength === 0) break;
          if (chunk.kind !== DATA || !chunk.bytes.byteLength) fail("unexpected entry frame.");
          size += chunk.bytes.byteLength;
          if (size > entry.byteLength) fail("entry exceeds its declared length.");
          hash.update(chunk.bytes);
          let offset = 0;
          while (offset < chunk.bytes.byteLength) {
            const written = await handle.write(chunk.bytes, offset, chunk.bytes.byteLength - offset);
            if (!written.bytesWritten) throw new Error("Recovery staging write made no progress.");
            offset += written.bytesWritten;
          }
        }
        if (size !== entry.byteLength || hash.digest("hex") !== entry.sha256) fail("entry hash or length differs.");
        await handle.sync();
      } finally { await handle.close(); }
      files.push({ entry, path });
    }
    const end = await reader.frame();
    if (end.kind !== END || Buffer.from(end.bytes).toString("hex") !== options.expectedManifestSha256) fail("missing or invalid trailer.");
    if (await reader.bytes(1, true)) fail("trailing stream bytes.");
    await authorize(options);
    return { manifest: parsed, directory, files, dispose };
  } catch (error) { await dispose(); throw error; }
  finally { release(reader.iterator); }
}
