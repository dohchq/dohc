import { mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { encodeRecoveryManifest, recoveryManifestSha256, stageDatasetRecovery, writeDatasetRecovery, RECOVERY_CHUNK_BYTES,
  type DatasetRecoveryManifest, type RecoveryEntry } from "./recovery";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const limits = { maxTotalBytes: 256 * 1024 * 1024, maxEntries: 32 };
const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), "dohc-recovery-test-")); directories.push(path); return path; }
afterEach(async () => { for (const path of directories.splice(0)) { if (!resolve(path).startsWith(`${resolve(tmpdir())}${sep}dohc-recovery-test-`)) throw Error("bad test path"); await rm(path, { recursive: true, force: true }); } });
const cursor = (revision: number, digest: string): DatasetRecoveryManifest["cursor"] => ({ workspaceId: "w", datasetId: "d", hostEpoch: "h", approvedRevisionHash: "a".repeat(64), revision, digest });
function fixture() {
  const content = new Map<string, Uint8Array>([["checkpoint", Buffer.from("checkpoint")], ["history", Buffer.from("history")], ["artifact:source", Buffer.from("source")], ["artifact:schema", Buffer.from("schema")], ["artifact:definition", Buffer.from("definition")], ["events", Buffer.from("events")]]);
  const entry = (id: string, kind: RecoveryEntry["kind"], extra: Partial<RecoveryEntry> = {}): RecoveryEntry => ({ id, kind, byteLength: content.get(id)!.byteLength, sha256: hash(content.get(id)!), ...extra });
  const manifest: DatasetRecoveryManifest = { format: "dohc-dataset-recovery-v1", sourceState: "active", cursor: cursor(9, "9".repeat(64)), checkpoint: cursor(7, "7".repeat(64)), entries: [entry("checkpoint", "checkpoint"), entry("history", "history"), entry("artifact:source", "artifact", { role: "source" }), entry("artifact:schema", "artifact", { role: "schema" }), entry("artifact:definition", "artifact", { role: "definition" }), entry("events", "events", { afterRevision: 7, throughRevision: 9 })] };
  return { content, manifest, options: { manifest, limits, authorize() {}, open: async function* (e: RecoveryEntry) { yield content.get(e.id)!; } } };
}
async function collect(stream: AsyncIterable<Uint8Array>) { const out: Uint8Array[] = []; for await (const item of stream) out.push(item); return out; }
async function* parts(items: Uint8Array[]) { yield* items; }
async function fileHash(path: string) { const h = createHash("sha256"); for await (const item of createReadStream(path)) h.update(item); return h.digest("hex"); }

describe("dataset recovery transport", () => {
  it("streams and stages a real 100 MiB checkpoint in bounded frames", async () => {
    const parent = await directory(), sourceParent = await directory(), source = join(sourceParent, "source.sqlite"), handle = await open(source, "wx");
    const chunk = Buffer.alloc(RECOVERY_CHUNK_BYTES, 23), digest = createHash("sha256");
    for (let i = 0; i < 101; i++) { await handle.writeFile(chunk); digest.update(chunk); } await handle.close();
    const expectedHash = digest.digest("hex"), length = 101 * RECOVERY_CHUNK_BYTES, { manifest, options } = fixture();
    manifest.entries[0] = { id: "checkpoint", kind: "checkpoint", byteLength: length, sha256: expectedHash };
    manifest.entries.push({ id: "../../not-a-path", kind: "attachment", byteLength: length, sha256: expectedHash });
    let frames = 0, largest = 0;
    const sourceStream = (e: RecoveryEntry) => (e.kind === "checkpoint" || e.kind === "attachment") ? createReadStream(source, { highWaterMark: RECOVERY_CHUNK_BYTES }) : options.open(e);
    async function* stream() { for await (const frame of writeDatasetRecovery({ ...options, open: sourceStream })) { frames++; largest = Math.max(largest, frame.byteLength); yield frame; } }
    const staged = await stageDatasetRecovery({ stream: stream(), stagingParent: parent, limits, authorize() {}, expectedManifestSha256: recoveryManifestSha256(manifest, limits) });
    expect(frames).toBeGreaterThan(200); expect(largest).toBeLessThanOrEqual(RECOVERY_CHUNK_BYTES + 5); expect(staged.files).toHaveLength(manifest.entries.length);
    for (const file of [staged.files[0]!, staged.files.at(-1)!]) { expect((await stat(file.path)).size).toBe(length); expect(await fileHash(file.path)).toBe(expectedHash); }
    await staged.dispose(); expect(await readdir(parent)).toEqual([]);
  }, 30_000);
  it("accepts fragmented transport and cleans failed or cancelled staging", async () => {
    const { manifest, options } = fixture(), parent = await directory();
    async function* fragmented() { for await (const frame of writeDatasetRecovery(options)) for (let i = 0; i < frame.length; i += 7) yield frame.subarray(i, i + 7); }
    const staged = await stageDatasetRecovery({ stream: fragmented(), stagingParent: parent, limits, authorize() {}, expectedManifestSha256: recoveryManifestSha256(manifest, limits) });
    expect(staged.manifest).toEqual(manifest); await staged.dispose();
    const badParent = await directory(); const encoded = await collect(writeDatasetRecovery(options)); const bad = Uint8Array.from(encoded[2]!); bad[5] = bad[5]! ^ 1;
    await writeFile(join(badParent, "current.sqlite"), "current data");
    await expect(stageDatasetRecovery({ stream: parts([encoded[0]!, encoded[1]!, bad, ...encoded.slice(3)]), stagingParent: badParent, limits, authorize() {}, expectedManifestSha256: recoveryManifestSha256(manifest, limits) })).rejects.toThrow();
    expect(await readdir(badParent)).toEqual(["current.sqlite"]);
    expect(await readFile(join(badParent, "current.sqlite"), "utf8")).toBe("current data");
  }, 30_000);
  it("cancels a stalled import and cleans its stage without waiting for transport", async () => {
    const { manifest, options } = fixture(), parent = await directory(), controller = new AbortController();
    const encoded = await collect(writeDatasetRecovery(options)); let index = 0, returned = false;
    const stream: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { return {
      next() {
        if (index < 3) return Promise.resolve({ done: false as const, value: encoded[index++]! });
        controller.abort(new Error("Cancelled")); return new Promise<IteratorResult<Uint8Array>>(() => {});
      }, async return() { returned = true; return { done: true as const, value: undefined }; },
    }; } };
    await expect(stageDatasetRecovery({ stream, stagingParent: parent, signal: controller.signal, limits, authorize() {},
      expectedManifestSha256: recoveryManifestSha256(manifest, limits) })).rejects.toThrow("Cancelled");
    expect(returned).toBe(true); expect(await readdir(parent)).toEqual([]);
  });
  it("rechecks authority during import and export", async () => {
    const { manifest, options } = fixture(), parent = await directory(); let authorized = true;
    async function* revoke() { let count = 0; for await (const chunk of writeDatasetRecovery(options)) { if (++count === 5) authorized = false; yield chunk; } }
    await expect(stageDatasetRecovery({ stream: revoke(), stagingParent: parent, limits, authorize() { if (!authorized) throw Error("Revoked"); },
      expectedManifestSha256: recoveryManifestSha256(manifest, limits) })).rejects.toThrow("Revoked");
    expect(await readdir(parent)).toEqual([]);
    let checks = 0;
    await expect(collect(writeDatasetRecovery({ ...options, authorize() { if (++checks === 5) throw Error("Revoked"); } }))).rejects.toThrow("Revoked");
  });
  it("rejects scope, event, role, reservation, manifest, and trailing-byte violations", async () => {
    const { manifest, options } = fixture();
    expect(() => encodeRecoveryManifest({ ...manifest, checkpoint: { ...manifest.checkpoint, datasetId: "other" } }, limits)).toThrow("scope");
    expect(() => encodeRecoveryManifest({ ...manifest, entries: manifest.entries.map(e => e.kind === "events" ? { ...e, afterRevision: 8 } : e) }, limits)).toThrow("noncontiguous");
    expect(() => encodeRecoveryManifest({ ...manifest, entries: manifest.entries.map(e => e.id === "artifact:source" ? { ...e, id: "evil" } : e) }, limits)).toThrow("ambiguous");
    expect(() => encodeRecoveryManifest({ ...manifest, entries: manifest.entries.filter(e => e.kind !== "history") }, limits)).toThrow("incomplete");
    const parent = await directory();
    await expect(stageDatasetRecovery({ stream: writeDatasetRecovery(options), stagingParent: parent, limits: { maxTotalBytes: 1, maxEntries: 32 }, authorize() {}, expectedManifestSha256: recoveryManifestSha256(manifest, limits) })).rejects.toThrow("reservation");
    expect(await readdir(parent)).toEqual([]);
    await expect(stageDatasetRecovery({ stream: parts([...await collect(writeDatasetRecovery(options)), Uint8Array.of(1)]), stagingParent: parent, limits, authorize() {}, expectedManifestSha256: recoveryManifestSha256(manifest, limits) })).rejects.toThrow();
    expect(await readdir(parent)).toEqual([]);
    const chunks = await collect(writeDatasetRecovery(options));
    await expect(stageDatasetRecovery({ stream: parts(chunks), stagingParent: parent, limits, authorize() {},
      expectedManifestSha256: "0".repeat(64) })).rejects.toThrow("manifest integrity");
    const oversized = Buffer.alloc(5); oversized[0] = 2; oversized.writeUInt32BE(RECOVERY_CHUNK_BYTES + 1, 1);
    for (const damaged of [chunks.slice(0, -1), [...chunks.slice(0, 2), oversized],
      [...chunks.slice(0, 2), chunks[4]!, chunks[3]!, chunks[2]!, ...chunks.slice(5)]]) {
      await expect(stageDatasetRecovery({ stream: parts(damaged), stagingParent: parent, limits, authorize() {},
        expectedManifestSha256: recoveryManifestSha256(manifest, limits) })).rejects.toThrow();
      expect(await readdir(parent)).toEqual([]);
    }
  });
});
