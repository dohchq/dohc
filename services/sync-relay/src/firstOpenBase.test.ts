import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { yDocToArtifactMarkdown } from "@dohc/ydoc-projection";
import {
  createLiveMarkdownJournalValidator,
  createLiveMarkdownRegistrationValidator,
} from "@dohc/ydoc-projection/live-journal-validation";
import * as richdocSeed from "@dohc/ydoc-projection/richdoc-seed";
import { encodeRichdocSeed, seedClientId } from "@dohc/ydoc-projection/richdoc-seed";
import * as projectionImport from "../../../packages/ydoc-projection/src/import-export.js";
import type { NativeOwnerActivationSource } from "@dohc/workspace-engine-client/daemon";
import {
  MAX_YDOC_UPDATE_BYTES,
  NATIVE_NUMBER_GROWTH_BYTES,
  buildFirstOpenBase,
  firstOpenBaseExceeds,
  nativeFullStateGrowth,
  type FirstOpenBaseInput,
} from "./firstOpenBase.js";
import { createLiveValidationExecutor } from "./liveValidation.js";
import { openSyncRelayStorage } from "./storage.js";
import type { StorageContext } from "./storage/context.js";
import {
  activationCaptureBytes,
  activationDescriptorBytes,
  activationDescriptorReserve,
  ordinaryActivationEntryBytes,
  ordinaryActivationReadBytes,
  verifyOrdinaryActivationCut,
  type KnownActivationSource,
} from "./storage/ordinaryActivationSource.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const policy = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000};
const roomy = { maxCaptureBytes: 1_000_000, maxBytesPerDrain: 1_000_000, descriptorBytes: 1_000, logEntryBytes: 1_000 };
const document = { workspaceId: "workspace", mainVersionId: "main" as const, objectId: "object" };
function input(markdown: string, overrides: Partial<FirstOpenBaseInput> = {}): FirstOpenBaseInput {
  return { document, currentPath: "docs/a.md", headMomentId: "head-moment", markdown,
    sourceDigest: sha256(markdown), sourceByteLength: Buffer.byteLength(markdown), bounds: roomy, ...overrides };
}
const fixtures = new URL("../../../crates/dohc-engine-collab/tests/first-open-base/", import.meta.url);
const readFixture = (name: string) =>
  new Map((JSON.parse(readFileSync(new URL(name, fixtures), "utf8")) as { name: string; markdown?: string; bytes: number[] }[])
    .map(base => [base.name, { markdown: base.markdown ?? "", bytes: Uint8Array.from(base.bytes) }]));
const tsBases = readFixture("ts-bases.json"), yrsBases = readFixture("yrs-bases.json");
const pools: ReturnType<typeof createLiveValidationExecutor>[] = [];
afterEach(async () => { await Promise.all(pools.splice(0).map(pool => pool.close())); });

describe("first-open preflight", () => {
  const sizes = { baseBytes: 1_000, stateUpdateBytes: 1_000, nativeGrowthBytes: 40 };
  const bounds = { maxCaptureBytes: 10_000_000, maxBytesPerDrain: 10_000_000, descriptorBytes: 500, logEntryBytes: 300 };
  const unbounded = { ...bounds, maxCaptureBytes: 1e9, maxBytesPerDrain: 1e9 };
  it("bounds the base and native's full state by the engine's update limit", () => {
    expect(firstOpenBaseExceeds({ baseBytes: MAX_YDOC_UPDATE_BYTES, stateUpdateBytes: 0, nativeGrowthBytes: 0 }, unbounded)).toBeUndefined();
    expect(firstOpenBaseExceeds({ baseBytes: MAX_YDOC_UPDATE_BYTES + 1, stateUpdateBytes: 0, nativeGrowthBytes: 0 }, unbounded)).toBe("update-limit");
    expect(firstOpenBaseExceeds({ baseBytes: MAX_YDOC_UPDATE_BYTES - 40, stateUpdateBytes: 0, nativeGrowthBytes: 40 }, unbounded)).toBeUndefined();
    expect(firstOpenBaseExceeds({ baseBytes: MAX_YDOC_UPDATE_BYTES - 40, stateUpdateBytes: 0, nativeGrowthBytes: 41 }, unbounded)).toBe("update-limit");
  });
  it("needs no separate drain bound: the reads always exceed the base first", () => {
    // A base the size of a whole drain is still read at least three times.
    expect(firstOpenBaseExceeds(sizes, { ...bounds, maxBytesPerDrain: 1_000 })).toBe("read-budget");
  });
  it("bounds two full states, native's growth, and the descriptor by the capture budget", () => {
    // 1000 + (1000 + 40) + 500
    expect(firstOpenBaseExceeds(sizes, { ...bounds, maxCaptureBytes: 2_540 })).toBeUndefined();
    expect(firstOpenBaseExceeds(sizes, { ...bounds, maxCaptureBytes: 2_539 })).toBe("capture-budget");
    // 1500 + (1500 + 40) + 500
    const larger = { ...sizes, stateUpdateBytes: 1_500 };
    expect(firstOpenBaseExceeds(larger, { ...bounds, maxCaptureBytes: 3_540 })).toBeUndefined();
    expect(firstOpenBaseExceeds(larger, { ...bounds, maxCaptureBytes: 3_539 })).toBe("capture-budget");
  });
  it("bounds the verifier's cumulative reads", () => {
    // 3 * 1000 + 300 + (1000 + 40) + 2
    expect(firstOpenBaseExceeds(sizes, { ...bounds, maxBytesPerDrain: 4_342 })).toBeUndefined();
    expect(firstOpenBaseExceeds(sizes, { ...bounds, maxBytesPerDrain: 4_341 })).toBe("read-budget");
    // 3 * 1000 + 300 + (1500 + 40) + 2
    const larger = { ...sizes, stateUpdateBytes: 1_500 };
    expect(firstOpenBaseExceeds(larger, { ...bounds, maxBytesPerDrain: 4_842 })).toBeUndefined();
    expect(firstOpenBaseExceeds(larger, { ...bounds, maxBytesPerDrain: 4_841 })).toBe("read-budget");
  });
});

describe("native full-state growth", () => {
  it("bounds how much yrs grows every Rust fixture", () => {
    expect(tsBases.size).toBeGreaterThan(0);
    for (const [name, base] of tsBases) {
      const native = yrsBases.get(name)!.bytes;
      expect(native.length, name).toBeLessThanOrEqual(base.bytes.length + nativeFullStateGrowth(base.bytes)!);
    }
  });
  it("reserves exactly what yrs adds to wide integers, beyond any fixed slack", () => {
    const base = tsBases.get("float32-integers")!.bytes, native = yrsBases.get("float32-integers")!.bytes;
    expect(native.length - base.length).toBeGreaterThan(1_024);
    expect(nativeFullStateGrowth(base)).toBe(native.length - base.length);
    expect(nativeFullStateGrowth(tsBases.get("integer-2147483648")!.bytes)).toBe(NATIVE_NUMBER_GROWTH_BYTES);
  });
  it("counts numbers inside arrays and objects, and only those yrs writes wider", () => {
    const doc = new Y.Doc();
    try {
      doc.getMap("m").set("values", [2 ** 31 - 1, 2 ** 31, -(2 ** 52), 2 ** 53 + 2, 0.5, { nested: [2 ** 40] }]);
      expect(nativeFullStateGrowth(Y.encodeStateAsUpdate(doc))).toBe(3 * NATIVE_NUMBER_GROWTH_BYTES);
    } finally { doc.destroy(); }
  });
  it("refuses to bound a number yrs may print differently in format JSON", () => {
    const growth = (value: unknown) => {
      const doc = new Y.Doc();
      try {
        doc.getText("t").insert(0, "x", { mark: value });
        return nativeFullStateGrowth(Y.encodeStateAsUpdate(doc));
      } finally { doc.destroy(); }
    };
    expect(growth({ href: "https://example.com", level: 2 ** 53 - 1 })).toBe(0);
    expect(growth({ width: 0.5 })).toBeUndefined();
    expect(growth([1e21])).toBeUndefined();
  });
});

describe("the verifier's byte counts", () => {
  function baseOnlyHistory(markdown: string, given?: { base: Uint8Array; fullState: Uint8Array }) {
    const root = mkdtempSync(join(tmpdir(), "dohc-first-open-")), path = join(root, "relay.sqlite");
    const storage = openSyncRelayStorage(path) as StorageContext, raw = new DatabaseSync(path);
    const built = given ? { base: given.base, lineageClaimId: sha256(given.base) } : buildFirstOpenBase(policy, input(markdown));
    if (!("base" in built)) throw new Error(JSON.stringify(built));
    const base = built.base, fullState = given?.fullState ?? base, live = { ...document, lineageClaimId: built.lineageClaimId };
    const baseline = createLiveMarkdownRegistrationValidator(policy)({ document: live, currentPath: "docs/a.md", checkpoint: base });
    if (baseline.kind !== "accepted") throw new Error(JSON.stringify(baseline));
    const payload = JSON.stringify({ versionId: "main", objectId: "object", path: "docs/a.md", contentKind: "richdoc", isBaseState: true,
      lineageClaimId: built.lineageClaimId, updateBlobSha256: built.lineageClaimId });
    raw.exec("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity) VALUES ('workspace','owner',0,'epoch','stream')");
    raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',0,'moment.append',?,0)")
      .run(JSON.stringify({ versionId: "main", objectId: "object", momentId: "head-moment", path: "docs/a.md", operation: "write", payloadAfterPath: "docs/a.md",
        payloadAfterContentKind: "text", payloadAfterBlobSha256: sha256(markdown), payloadAfterByteLength: Buffer.byteLength(markdown) }));
    raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',1,'ydoc.update',?,1)").run(payload);
    raw.prepare("INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)").run(built.lineageClaimId, base.length, base);
    raw.prepare("INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms) VALUES ('workspace','object',1,'head-moment','main','docs/a.md',?,'text',?,0)")
      .run(sha256(markdown), Buffer.byteLength(markdown));
    const source: NativeOwnerActivationSource = { version: 1, relayDatabaseNamespace: "history", ...live, currentPath: "docs/a.md",
      replicationEpoch: "epoch", streamIdentity: "stream", committedCursor: 2, baseOriginId: "origin", baseOriginSeq: 1, baseRelaySeq: 2,
      sourceMomentId: "head-moment", sourceDigest: sha256(markdown), sourceByteLength: Buffer.byteLength(markdown), nativeHeadSequence: 1,
      fullStateDigest: sha256(fullState), fullStateByteLength: fullState.length };
    const logEntryBytes = ordinaryActivationEntryBytes({ relay_seq: 2, origin_id: "origin", origin_seq: 1, op_kind: "ydoc.update" }, Buffer.byteLength(payload));
    const verify = (bounds: { maxCaptureBytes: number; maxBytesPerDrain: number }) => verifyOrdinaryActivationCut(storage, {
      source, document: live, baselineBytes: base, fullState, baseline: baseline.evidence,
      validateJournal: createLiveMarkdownJournalValidator(policy), validateRegistration: createLiveMarkdownRegistrationValidator(policy),
      bounds: { maxEntriesPerDrain: 10, ...bounds } });
    return { base, source, logEntryBytes, stateUpdateBytes: baseline.evidence.stateUpdateByteLength, verify,
      close() { raw.close(); storage.close(); rmSync(root, { recursive: true, force: true }); } };
  }

  it("verifies a base-only history at exactly the reads and capture the preflight counts", () => {
    const history = baseOnlyHistory("# Shared\n\nStarting together.\n");
    try {
      const B = history.base.length, descriptorBytes = activationDescriptorBytes(history.source);
      const reads = ordinaryActivationReadBytes({ baselineBytes: B, entryBytes: [history.logEntryBytes], updateBytes: [B], fullStateBytes: B });
      expect(reads).toBe(3 * B + B + history.logEntryBytes + 2);
      expect(history.verify({ maxCaptureBytes: 1_000_000, maxBytesPerDrain: reads })).toEqual({ verified: true });
      expect(() => history.verify({ maxCaptureBytes: 1_000_000, maxBytesPerDrain: reads - 1 })).toThrow("byte budget");
      const capture = activationCaptureBytes(B, B, descriptorBytes);
      expect(history.verify({ maxCaptureBytes: capture, maxBytesPerDrain: 1_000_000 })).toEqual({ verified: true });
      expect(() => history.verify({ maxCaptureBytes: capture - 1, maxBytesPerDrain: 1_000_000 })).toThrow("capture exceeds");
      // The preflight draws the same lines.
      const sizes = { baseBytes: B, stateUpdateBytes: history.stateUpdateBytes, nativeGrowthBytes: nativeFullStateGrowth(history.base)! };
      const exceeds = (maxBytesPerDrain: number, maxCaptureBytes: number) =>
        firstOpenBaseExceeds(sizes, { descriptorBytes, logEntryBytes: history.logEntryBytes, maxBytesPerDrain, maxCaptureBytes });
      expect(exceeds(reads, capture)).toBeUndefined();
      expect(exceeds(reads - 1, capture)).toBe("read-budget");
      expect(exceeds(reads, capture - 1)).toBe("capture-budget");
    } finally { history.close(); }
  });

  it("admits nothing the verifier would refuse", () => {
    const history = baseOnlyHistory("* one\n* two\n");
    try {
      const { source } = history, B = history.base.length;
      const descriptorBytes = activationDescriptorReserve(source);
      expect(descriptorBytes).toBeGreaterThan(activationDescriptorBytes(source));
      const nativeGrowthBytes = nativeFullStateGrowth(history.base)!;
      const fullStateBytes = Math.max(B, history.stateUpdateBytes) + nativeGrowthBytes;
      const bounds = { descriptorBytes, logEntryBytes: history.logEntryBytes,
        maxCaptureBytes: activationCaptureBytes(Math.max(B, history.stateUpdateBytes), fullStateBytes, descriptorBytes),
        maxBytesPerDrain: ordinaryActivationReadBytes({ baselineBytes: B, entryBytes: [history.logEntryBytes], updateBytes: [B], fullStateBytes }) };
      expect(firstOpenBaseExceeds({ baseBytes: B, stateUpdateBytes: history.stateUpdateBytes, nativeGrowthBytes }, bounds)).toBeUndefined();
      expect(history.verify(bounds)).toEqual({ verified: true });
    } finally { history.close(); }
  });

  it("verifies native's wider full state at exactly the bounds the preflight reserves for it", () => {
    const { markdown, bytes: base } = tsBases.get("float32-integers")!;
    const history = baseOnlyHistory(markdown, { base, fullState: yrsBases.get("float32-integers")!.bytes });
    try {
      const B = base.length, descriptorBytes = activationDescriptorBytes(history.source);
      const sizes = { baseBytes: B, stateUpdateBytes: history.stateUpdateBytes, nativeGrowthBytes: nativeFullStateGrowth(base)! };
      const fullStateBytes = Math.max(B, sizes.stateUpdateBytes) + sizes.nativeGrowthBytes;
      expect(fullStateBytes).toBe(history.source.fullStateByteLength);
      const capture = activationCaptureBytes(B, fullStateBytes, descriptorBytes);
      const reads = ordinaryActivationReadBytes({ baselineBytes: B, entryBytes: [history.logEntryBytes], updateBytes: [B], fullStateBytes });
      const bounds = { descriptorBytes, logEntryBytes: history.logEntryBytes, maxCaptureBytes: capture, maxBytesPerDrain: reads };
      expect(firstOpenBaseExceeds(sizes, bounds)).toBeUndefined();
      expect(history.verify(bounds)).toEqual({ verified: true });
      expect(firstOpenBaseExceeds(sizes, { ...bounds, maxCaptureBytes: capture - 1 })).toBe("capture-budget");
      expect(() => history.verify({ ...bounds, maxCaptureBytes: capture - 1 })).toThrow("capture exceeds");
      expect(firstOpenBaseExceeds(sizes, { ...bounds, maxBytesPerDrain: reads - 1 })).toBe("read-budget");
      expect(() => history.verify({ ...bounds, maxBytesPerDrain: reads - 1 })).toThrow("byte budget");
    } finally { history.close(); }
  });

  it("reserves the widest descriptor native writes, pinned by the engine", () => {
    const fixture = new URL("../../../crates/dohc-engine-collab/tests/first-open-base/descriptor-reserve.json", import.meta.url);
    const known: KnownActivationSource = { relayDatabaseNamespace: "history", workspaceId: "工作区-ü", objectId: "objét-🎉",
      currentPath: "notes/café \"q\"\\\u0001.md", replicationEpoch: "epoch-ü", streamIdentity: "stream", baseOriginId: "relay-origin-ü",
      sourceMomentId: "moment-ü", sourceDigest: sha256("source"), sourceByteLength: 2_097_152 };
    const reserve = activationDescriptorReserve(known);
    if (process.env.DOHC_WRITE_FIRST_OPEN_FIXTURES === "1") writeFileSync(fixture, `${JSON.stringify({ known, reserve })}\n`);
    expect(JSON.parse(readFileSync(fixture, "utf8"))).toEqual({ known, reserve });
  });
});

describe("first-open base", () => {
  it.each([
    ["empty Markdown", ""],
    ["Unicode", "# Café 🎉\n\nnaïve 中文 — ok"],
    ["frontmatter", "---\ntitle: Plan\nnested:\n  count: 3\n---\n\nBody\n"],
    ["a source witness", "* one\n* two\n"],
  ])("builds the desktop seed for %s and settles to the file", (_name, markdown) => {
    const built = buildFirstOpenBase(policy, input(markdown));
    if (built.kind !== "built") throw new Error(JSON.stringify(built));
    const clientId = seedClientId({ workspaceId: "workspace", versionId: "main", objectId: "object", contentKind: "richdoc",
      headMomentId: "head-moment", headBlobSha256: sha256(markdown) });
    expect(Buffer.from(built.base).equals(Buffer.from(encodeRichdocSeed(markdown, clientId)))).toBe(true);
    expect(built.lineageClaimId).toBe(sha256(built.base));
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, built.base);
      expect([...doc.store.clients.keys()]).toEqual([clientId]);
      expect(yDocToArtifactMarkdown(doc)).toBe(markdown);
    } finally { doc.destroy(); }
  });

  it("refuses a source that is not the verified head", () => {
    expect(buildFirstOpenBase(policy, input("Body", { sourceDigest: sha256("Other") }))).toEqual({ kind: "refused", reason: "source-mismatch" });
    expect(buildFirstOpenBase(policy, input("Body", { sourceByteLength: 5 }))).toEqual({ kind: "refused", reason: "source-mismatch" });
    // A stale head stays a mismatch even when its text is unsupported.
    expect(buildFirstOpenBase(policy, input("See <https://example.com/b>.\n", { sourceDigest: sha256("Other") })))
      .toEqual({ kind: "refused", reason: "source-mismatch" });
  });

  it("refuses a current head whose witness the engine would not settle to as unsupported", () => {
    const markdown = "See <https://example.com/b>.\n";
    const built = buildFirstOpenBase(policy, input(markdown, { bounds: roomy }));
    expect(built).toEqual({ kind: "refused", reason: "unsupported-source" });
    // The live validator alone verifies this witness.
    const clientId = seedClientId({ workspaceId: "workspace", versionId: "main", objectId: "object", contentKind: "richdoc",
      headMomentId: "head-moment", headBlobSha256: sha256(markdown) });
    const base = encodeRichdocSeed(markdown, clientId);
    const validated = createLiveMarkdownRegistrationValidator(policy)({ document: { ...document, lineageClaimId: sha256(base) },
      currentPath: "docs/a.md", checkpoint: base });
    expect(validated.kind === "accepted" && validated.evidence.projectedMarkdownSha256).toBe(sha256(markdown));
  });

  it("refuses a projection mismatch without a valid witness", () => {
    const projector = vi.spyOn(projectionImport, "yDocToMarkdown").mockImplementationOnce(() => {
      throw new Error("source projection failed");
    });
    try {
      expect(buildFirstOpenBase(policy, input("* one\n* two\n"))).toEqual({ kind: "refused", reason: "unsupported-source" });
      expect(projector).toHaveBeenCalled();
    } finally { projector.mockRestore(); }
  });

  it("refuses a base the live validator refuses", () => {
    expect(buildFirstOpenBase(policy, input("Body", { currentPath: "docs/a.txt" }))).toEqual({ kind: "refused", reason: "invalid-base" });
  });

  it("refuses a base over the engine's update limit before decoding it", () => {
    // Bytes no decoder reads, so decoding them would throw instead of refusing.
    const oversized = new Uint8Array(MAX_YDOC_UPDATE_BYTES + 1).fill(0xff);
    expect(() => Y.decodeUpdate(oversized)).toThrow();
    const encode = vi.spyOn(richdocSeed, "encodeRichdocSeed").mockReturnValueOnce(oversized);
    try {
      expect(buildFirstOpenBase(policy, input("Body"))).toEqual({ kind: "refused", reason: "update-limit" });
      expect(encode).toHaveBeenCalled();
    } finally { encode.mockRestore(); }
  });

  it("refuses a base its activation could not capture or verify", () => {
    expect(buildFirstOpenBase(policy, input("Body", { bounds: { ...roomy, maxCaptureBytes: 100 } }))).toEqual({ kind: "refused", reason: "capture-budget" });
    expect(buildFirstOpenBase(policy, input("Body", { bounds: { ...roomy, maxBytesPerDrain: 10 } }))).toEqual({ kind: "refused", reason: "read-budget" });
  });
});

describe("first-open worker", () => {
  function fixture() {
    const pool = createLiveValidationExecutor(); pools.push(pool);
    const doc = projectionImport.markdownToYDoc("A **shared** document");
    const checkpoint = Y.encodeStateAsUpdate(doc); doc.destroy();
    const journal = { document: { ...document, lineageClaimId: "lineage" }, currentPath: "note.md", checkpoint, suffix: [], candidate: Uint8Array.of(0, 0) };
    return { pool, journal, validate: pool.validator(policy) };
  }

  it("builds the same base in a worker", async () => {
    const { pool } = fixture();
    expect(await pool.buildFirstOpenBase(policy, input("# Café\n"))).toEqual(buildFirstOpenBase(policy, input("# Café\n")));
  });

  it("takes at most one slot and leaves the other to live admission", async () => {
    const { pool, journal, validate } = fixture();
    const building = pool.buildFirstOpenBase(policy, input("Body"));
    expect(await pool.buildFirstOpenBase(policy, input("Other"))).toEqual({ kind: "busy" });
    expect(validate.hasCapacity?.()).toBe(true);
    expect((await validate(journal)).kind).toBe("accepted");
    expect((await building).kind).toBe("built");
  });

  it("does not wait while live admission holds every slot", async () => {
    const { pool, journal, validate } = fixture();
    const live = [validate(journal), validate(journal)];
    expect(await pool.buildFirstOpenBase(policy, input("Body"))).toEqual({ kind: "busy" });
    for (const result of await Promise.all(live)) expect(result.kind).toBe("accepted");
    expect((await pool.buildFirstOpenBase(policy, input("Body"))).kind).toBe("built");
  });

  it("keeps its slot until a cancelled or failed worker exits, then frees it", async () => {
    const { pool, journal, validate } = fixture(), abort = new AbortController();
    const built = async () => expect((await pool.buildFirstOpenBase(policy, input("Body"))).kind).toBe("built");
    const cancelled = pool.buildFirstOpenBase(policy, input("Body"), abort.signal);
    abort.abort(new Error("cancelled"));
    await expect(cancelled).rejects.toThrow("cancelled");
    expect(await pool.buildFirstOpenBase(policy, input("Body"))).toEqual({ kind: "busy" });
    expect(validate.hasCapacity?.()).toBe(true);
    expect((await validate(journal)).kind).toBe("accepted");
    await vi.waitFor(built, { timeout: 10_000 });
    await expect(pool.buildFirstOpenBase(policy, { ...input("Body"), document: null as never })).rejects.toThrow();
    expect(await pool.buildFirstOpenBase(policy, input("Body"))).toEqual({ kind: "busy" });
    expect((await validate(journal)).kind).toBe("accepted");
    await vi.waitFor(built, { timeout: 10_000 });
  });
});
