import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { encodeRichdocSeed, richdocSeedFile, seedClientId } from "@dohc/ydoc-projection/richdoc-seed";
import * as projectionImport from "../../../packages/ydoc-projection/src/import-export.js";
import { LIVE_MARKDOWN_MAX_BYTES } from "@dohc/live-session-contract/limits";
import type { NativeOwnerActivationSource } from "@dohc/workspace-engine-client/daemon";
import {
  MAX_YDOC_UPDATE_BYTES,
  buildFirstOpenBase,
  firstOpenBaseExceeds,
  firstOpenEncodingCap,
  type FirstOpenBaseInput,
} from "./firstOpenBase.js";
import { createLiveValidationExecutor, FIRST_OPEN_BUILD_MS } from "./liveValidation.js";
import { openSyncRelayStorage } from "./storage.js";
import type { StorageContext } from "./storage/context.js";
import {
  activationCaptureBytes,
  activationDescriptorBytes,
  activationDescriptorReserve,
  ordinaryActivationEntryBytes,
  ordinaryActivationReadBytes,
  verifyOrdinaryActivationCut,
  readOrdinaryActivationHistory,
  validateOrdinaryActivation,
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
  const sizes = { baseBytes: 1_000, fullStateBytes: 1_040 };
  const bounds = { maxCaptureBytes: 10_000_000, maxBytesPerDrain: 10_000_000, descriptorBytes: 500, logEntryBytes: 300 };
  const unbounded = { ...bounds, maxCaptureBytes: 1e9, maxBytesPerDrain: 1e9 };
  it("bounds the base and native's full state by the engine's update limit", () => {
    expect(firstOpenBaseExceeds({ baseBytes: MAX_YDOC_UPDATE_BYTES, fullStateBytes: MAX_YDOC_UPDATE_BYTES }, unbounded)).toBeUndefined();
    expect(firstOpenBaseExceeds({ baseBytes: MAX_YDOC_UPDATE_BYTES + 1, fullStateBytes: 2 }, unbounded)).toBe("update-limit");
    expect(firstOpenBaseExceeds({ baseBytes: 2, fullStateBytes: MAX_YDOC_UPDATE_BYTES + 1 }, unbounded)).toBe("update-limit");
  });
  it("needs no separate drain bound: the reads always exceed the base first", () => {
    // A base the size of a whole drain is still read at least three times.
    expect(firstOpenBaseExceeds(sizes, { ...bounds, maxBytesPerDrain: 1_000 })).toBe("read-budget");
  });
  it("bounds the base, native's measured full state, and the descriptor by the capture budget", () => {
    // 1000 + 1040 + 500
    expect(firstOpenBaseExceeds(sizes, { ...bounds, maxCaptureBytes: 2_540 })).toBeUndefined();
    expect(firstOpenBaseExceeds(sizes, { ...bounds, maxCaptureBytes: 2_539 })).toBe("capture-budget");
  });
  it("bounds the verifier's cumulative reads", () => {
    // 3 * 1000 + 300 + 1040 + 2
    expect(firstOpenBaseExceeds(sizes, { ...bounds, maxBytesPerDrain: 4_342 })).toBeUndefined();
    expect(firstOpenBaseExceeds(sizes, { ...bounds, maxBytesPerDrain: 4_341 })).toBe("read-budget");
  });
  it("caps native's encoding at what the least of the update, capture and read allowances leaves", () => {
    const at = (change: Partial<typeof bounds>) => firstOpenEncodingCap(1_000, { ...unbounded, ...change });
    expect(at({})).toEqual({ cap: MAX_YDOC_UPDATE_BYTES, bound: "update-limit" });
    expect(at({ maxCaptureBytes: 2_540 })).toEqual({ cap: 1_040, bound: "capture-budget" });
    expect(at({ maxBytesPerDrain: 4_342 })).toEqual({ cap: 1_040, bound: "read-budget" });
    expect(at({ maxCaptureBytes: 2_541, maxBytesPerDrain: 4_342 })).toEqual({ cap: 1_040, bound: "read-budget" });
    // Each cap is the largest full state the shared arithmetic admits.
    for (const change of [{ maxCaptureBytes: 2_540 }, { maxBytesPerDrain: 4_342 }, {}]) {
      const room = at(change);
      if (!("cap" in room)) throw new Error(JSON.stringify(room));
      expect(firstOpenBaseExceeds({ baseBytes: 1_000, fullStateBytes: room.cap }, { ...unbounded, ...change })).toBeUndefined();
      expect(firstOpenBaseExceeds({ baseBytes: 1_000, fullStateBytes: room.cap + 1 }, { ...unbounded, ...change })).toBe(room.bound);
    }
  });
  it("refuses a base that leaves no room for even an empty full state", () => {
    expect(firstOpenEncodingCap(1_000, { ...unbounded, maxCaptureBytes: 1_502 })).toEqual({ cap: 2, bound: "capture-budget" });
    expect(firstOpenEncodingCap(1_000, { ...unbounded, maxCaptureBytes: 1_501 })).toEqual({ exceeded: "capture-budget" });
    expect(firstOpenEncodingCap(1_000, { ...unbounded, maxBytesPerDrain: 100 })).toEqual({ exceeded: "read-budget" });
    expect(firstOpenEncodingCap(MAX_YDOC_UPDATE_BYTES + 1, unbounded)).toEqual({ exceeded: "update-limit" });
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
    const verify = (bounds: { maxCaptureBytes: number; maxBytesPerDrain: number }) => {
      const input = {source, document: live, baselineBytes: base, fullState, bounds: {maxEntriesPerDrain: 10, ...bounds}};
      const history = readOrdinaryActivationHistory(storage, input);
      const validation = validateOrdinaryActivation({document: live, currentPath: source.currentPath, baselineBytes: base,
        cut: {source, fullState, history, maxBytesPerDrain: bounds.maxBytesPerDrain}}, policy);
      if (validation.kind !== "accepted") throw new Error("Ordinary activation validation refused.");
      return verifyOrdinaryActivationCut(storage, {...input, baseline: validation.baseline, history});
    };
    return { base, source, logEntryBytes, verify,
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
      // The preflight and the encoding cap draw the same lines.
      const sizes = { baseBytes: B, fullStateBytes: B };
      const bounds = (maxBytesPerDrain: number, maxCaptureBytes: number) =>
        ({ descriptorBytes, logEntryBytes: history.logEntryBytes, maxBytesPerDrain, maxCaptureBytes });
      expect(firstOpenBaseExceeds(sizes, bounds(reads, capture))).toBeUndefined();
      expect(firstOpenBaseExceeds(sizes, bounds(reads - 1, capture))).toBe("read-budget");
      expect(firstOpenBaseExceeds(sizes, bounds(reads, capture - 1))).toBe("capture-budget");
      expect(firstOpenEncodingCap(B, bounds(reads, 1_000_000))).toEqual({ cap: B, bound: "read-budget" });
      expect(firstOpenEncodingCap(B, bounds(1_000_000, capture))).toEqual({ cap: B, bound: "capture-budget" });
    } finally { history.close(); }
  });

  it("admits nothing the verifier would refuse", () => {
    const history = baseOnlyHistory("* one\n* two\n");
    try {
      const { source } = history, B = history.base.length;
      const descriptorBytes = activationDescriptorReserve(source);
      expect(descriptorBytes).toBeGreaterThan(activationDescriptorBytes(source));
      const bounds = { descriptorBytes, logEntryBytes: history.logEntryBytes,
        maxCaptureBytes: activationCaptureBytes(B, B, descriptorBytes),
        maxBytesPerDrain: ordinaryActivationReadBytes({ baselineBytes: B, entryBytes: [history.logEntryBytes], updateBytes: [B], fullStateBytes: B }) };
      expect(firstOpenBaseExceeds({ baseBytes: B, fullStateBytes: B }, bounds)).toBeUndefined();
      expect(history.verify(bounds)).toEqual({ verified: true });
    } finally { history.close(); }
  });

  it("verifies native's wider full state at exactly the bounds its measured length sets", () => {
    const { markdown, bytes: base } = tsBases.get("float32-integers")!;
    const history = baseOnlyHistory(markdown, { base, fullState: yrsBases.get("float32-integers")!.bytes });
    try {
      const B = base.length, descriptorBytes = activationDescriptorBytes(history.source);
      const fullStateBytes = history.source.fullStateByteLength, sizes = { baseBytes: B, fullStateBytes };
      // A base that encodes as itself would understate this one.
      expect(fullStateBytes - B).toBeGreaterThan(1_024);
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

  it("builds a candidate whose witness only the engine can judge, without the blanket guard", () => {
    // The engine settles this autolink canonically and refuses it; `&`, `<` and `]:` no longer refuse here.
    for (const markdown of ["See <https://example.com/b>.\n", "Title\n=====\n\nUse `a && b` here.\n", "Title\n=====\n\n```\n[docs]: https://example.com\n```\n"]) {
      const built = buildFirstOpenBase(policy, input(markdown, { bounds: roomy }));
      if (built.kind !== "built") throw new Error(`${markdown}: ${JSON.stringify(built)}`);
      const clientId = seedClientId({ workspaceId: "workspace", versionId: "main", objectId: "object", contentKind: "richdoc",
        headMomentId: "head-moment", headBlobSha256: sha256(markdown) });
      expect(Buffer.from(built.base).equals(Buffer.from(encodeRichdocSeed(markdown, clientId)))).toBe(true);
      // TypeScript's own settlement keeps the conservative guard; only the engine's check decides.
      expect(richdocSeedFile(built.base)).not.toBe(markdown);
    }
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

  it("refuses a file nested past the live document contract, or past its lexing budget, as unsupported", () => {
    const encode = vi.spyOn(richdocSeed, "encodeRichdocSeed");
    try {
      for (const markdown of [`${">".repeat(121)} a\n`, `${"- ".repeat(65)}a\n`, `${">".repeat(120)} a\n===\n\n`.repeat(16)]) {
        expect(buildFirstOpenBase(policy, input(markdown))).toEqual({ kind: "refused", reason: "unsupported-source" });
      }
      expect(encode).toHaveBeenCalledTimes(3);
    } finally { encode.mockRestore(); }
  });

  it("refuses a base the live validator refuses, with the validator's reason", () => {
    expect(buildFirstOpenBase(policy, input("Body", { currentPath: "docs/a.txt" }))).toEqual({ kind: "refused", reason: "invalid-base", fault: "invalid-input" });
    // The live schema keeps no link around inline code.
    expect(buildFirstOpenBase(policy, input("See [`lock()`](https://example.com/lock).\n")))
      .toEqual({ kind: "refused", reason: "invalid-base", fault: "invalid-schema" });
    const encode = vi.spyOn(richdocSeed, "encodeRichdocSeed").mockImplementationOnce(() => { throw new Error("an encoder bug"); });
    try {
      expect(buildFirstOpenBase(policy, input("Body"))).toEqual({ kind: "refused", reason: "invalid-base", fault: "seed-encoder" });
    } finally { encode.mockRestore(); }
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

// The relay's candidates for the engine's first-open check; Rust checks these
// exact bytes against each file. Real notes keep their bytes at this revision.
const CORPUS_REVISION = "a572fc3f5";
const CORPUS = ["docs/reference/usage-and-error-reports.md", "vendor/yrs-0.27.3/README.md", "vendor/notify-8.2.0/README.md",
  "vendor/file-guard-0.2.0/README.md", "tools/rust-engine-program/README.md", "CONTEXT.md", "examples/trip-poll/README.md",
  "SECURITY.md", "docs/README.md", ".agents/skills/verification-triage/SKILL.md", "services/share-web/README.md",
  "tools/perf-profiling/README.md", "docs/reference/workspace-file-versions.md"];
// A setext heading makes the projection differ, so each base carries the file as its witness.
const FOCUSED: [string, string][] = [
  ["autolink", "See <https://example.com/b>.\n"],
  ["amp-fenced", "Title\n=====\n\n```rust\nlet x = &mut y;\n```\n"],
  ["lt-fenced", "Title\n=====\n\n```rust\nlet v: Vec<u8> = a < b;\n```\n"],
  ["refdef-fenced", "Title\n=====\n\n```\n[docs]: https://example.com\n```\n"],
  ["amp-indented", "Title\n=====\n\n    a && b\n"],
  ["lt-indented", "Title\n=====\n\n    Vec<u8>\n"],
  ["refdef-indented", "Title\n=====\n\n    [docs]: https://example.com\n"],
  ["amp-inline", "Title\n=====\n\nUse `a && b` here.\n"],
  ["lt-inline", "Title\n=====\n\nUse `Vec<u8>` here.\n"],
  ["refdef-inline", "Title\n=====\n\nWrite `[docs]: url` once.\n"],
  ["amp-bare", "Title\n=====\n\nFish & chips\n"],
  ["amp-entity", "Title\n=====\n\nFish &amp; chips &copy; &#169;\n"],
  ["lt-bare", "Title\n=====\n\n1 < 2 and 3 <= 4\n"],
  ["html-inline", "Title\n=====\n\nHello <b>bold</b> world\n"],
  ["html-block", "Title\n=====\n\n<div>\nblock\n</div>\n"],
  ["refdef", "Title\n=====\n\nSee [docs][d].\n\n[d]: https://example.com\n"],
  ["literal-punctuation", "Title\n=====\n\nKeys a]: b, x <- y, AT&T.\n"],
  ["frontmatter", "---\ntitle: R&D <draft>\nref: \"[x]: y\"\n---\n\nTitle\n=====\n\nBody & more\n"],
  ["mixed-technical", "Notes\n=====\n\n* Run `cargo test -- <filter>` & check.\n* See [the guide][g] for `a && b`.\n\n```sh\nfoo < in.txt && bar\n```\n\n[g]: https://example.com/guide\n"],
  ["crlf", "Title\r\n=====\r\n\r\nFish & chips < 2\r\n"],
  ["no-final-newline", "Title\n=====\n\nFish & chips < 2"],
  ["extra-final-newlines", "Title\n=====\n\nFish & chips < 2\n\n\n"],
  ["trailing-whitespace", "Title  \n=====\n\nFish & chips < 2   \n"],
  ["unicode", "Café\n====\n\nnaïve 中文 — 🎉 & <ok>\n"],
  ["empty", ""],
];
// Where TypeScript's construction and the engine's settlement part, each beside
// a spelling both agree on. The final newline makes each base carry a witness.
const PARITY: [string, string][] = [
  ["table-inline-code", "| Event | Sent when |\n| --- | --- |\n| `app_launched` | dohc starts. |\n"],
  ["table-escapes", "| Code | Meaning |\n| --- | --- |\n| `a\\|b` | x \\| y \\*not\\* |\n"],
  ["table-plain", "| Event | Sent when |\n| --- | --- |\n| launched | dohc starts. |\n"],
  ["fence-tilde", "# Title\n\n~~~sh\nfoo\n~~~\n"],
  ["fence-tilde-setext", "Title\n=====\n\n~~~sh\nfoo\n~~~\n"],
  ["fence-tilde-table", "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n~~~sh\nfoo\n~~~\n"],
  ["fence-backtick-setext", "Title\n=====\n\n```sh\nfoo\n```\n"],
  ["reference-link", "See [docs][d].\n\n[d]: https://example.com\n"],
  ["emphasis-underscore", "We _avoid_ it.\n"],
  ["emphasis-star", "We *avoid* it.\n"],
  ["gt-text", "Open **Settings > Privacy** now.\n"],
  ["gt-inline-code", "Run `git bisect start <head> <base>`.\n"],
  ["html-comment-block", "<!-- note -->\n\nBody\n"],
  ["html-comment-inline", "Body <!-- note --> more\n"],
  ["html-comment-multiline", "# Title\n\n<!-- Generated by a tool. Change that file, then run:\npnpm test -u -->\n\nBody\n"],
  ["link-leading", "[Report](https://example.com/a).\n"],
  ["link-inside", "See [Report](https://example.com/a).\n"],
  ["image-leading", "![Verify](https://example.com/badge.svg)\n"],
];

describe("first-open candidates", () => {
  const fixture = new URL("candidates.json", fixtures);
  const identity = { workspaceId: "workspace", versionId: "main", objectId: "object", contentKind: "richdoc", headMomentId: "head-moment" } as const;
  type Row = { name: string; corpus: { path: string; revision: string; sha256: string } | null; markdown: string; oldGuard: string; candidate: string };
  const row = (name: string, markdown: string, corpus: Row["corpus"]): Row => {
    const candidate = encodeRichdocSeed(markdown, seedClientId({ ...identity, headBlobSha256: sha256(markdown) }));
    const built = buildFirstOpenBase(policy, input(markdown));
    if (built.kind === "built") expect(Buffer.from(built.base).equals(Buffer.from(candidate)), name).toBe(true);
    // What the blanket guard the engine's check replaced answered: it also required TypeScript to settle the candidate to the file.
    const oldGuard = built.kind !== "built" ? built.reason : richdocSeedFile(built.base) === markdown ? "built" : "unsupported-source";
    return { name, corpus, markdown, oldGuard, candidate: Buffer.from(candidate).toString("base64") };
  };

  it("keeps the committed candidates the relay builds today", () => {
    const writing = process.env.DOHC_WRITE_FIRST_OPEN_FIXTURES === "1";
    const read = () => JSON.parse(readFileSync(fixture, "utf8")) as Row[];
    const committed = writing ? undefined : read();
    const markdown = (path: string) => committed ? committed.find(row => row.corpus?.path === path)!.markdown
      : execFileSync("git", ["show", `${CORPUS_REVISION}:${path}`], { encoding: "utf8" });
    const rows = [
      ...CORPUS.map(path => { const text = markdown(path); return row(`corpus:${path}`, text, { path, revision: CORPUS_REVISION, sha256: sha256(text) }); }),
      ...[...FOCUSED, ...PARITY].map(([name, text]) => row(name, text, null)),
    ];
    if (writing) writeFileSync(fixture, `[\n${rows.map(row => JSON.stringify(row)).join(",\n")}\n]\n`);
    expect(read()).toEqual(rows);
  });

  // Every tracked Markdown file at the corpus revision, for the engine's
  // `first_open_inventory` test, which writes `inventory.json` from it.
  it.runIf(process.env.DOHC_FIRST_OPEN_INVENTORY === "1")("writes the inventory's input", () => {
    const git = (...args: string[]) => execFileSync("git", args, { maxBuffer: 1 << 26 });
    const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const paths = utf8.decode(git("ls-tree", "-r", "--full-tree", "--name-only", CORPUS_REVISION)).split("\n").filter(path => path.endsWith(".md"));
    const rows = paths.map(path => {
      const markdown = utf8.decode(git("show", `${CORPUS_REVISION}:${path}`));
      const { oldGuard, candidate } = row(path, markdown, null);
      const doc = projectionImport.markdownToYDoc(markdown);
      let projection: string | null = null;
      try { projection = projectionImport.yDocToMarkdown(doc); } catch { /* The engine's row names it. */ } finally { doc.destroy(); }
      return { path, revision: CORPUS_REVISION, sha256: sha256(markdown), markdown, oldGuard, candidate, projection };
    });
    const target = new URL("../../../target/", import.meta.url);
    mkdirSync(target, { recursive: true });
    expect(rows).toHaveLength(46);
    writeFileSync(new URL("first-open-inventory.json", target), JSON.stringify(rows));
  });

  // The relay's seeds under seed client 1, its smallest encoding, of notes at
  // the projection node limit, for the engine's `first_open_check_memory`
  // measurement. `over` is the same note with one more line. Run with
  // `vitest run src/firstOpenBase.test.ts --mode first-open-dense`.
  it.runIf(process.env.MODE === "first-open-dense")("writes the dense seeds the memory measurement checks", () => {
    // Paragraphs of 1,387 hard breaks, the shape the measurement recorded.
    const breaks = (count: number) => Array.from({ length: Math.ceil(count / 1_387) },
      (_, index) => `${"a  \n".repeat(Math.min(1_387, count - index * 1_387) - 1)}a`).join("\n\n") + "\n";
    const shapes: [string, (count: number) => string, number][] = [
      ["paragraphs", count => "a\n\n".repeat(count).slice(0, -1), 87_381],
      ["paragraphs-bare", count => "a\n\n".repeat(count).slice(0, -2), 87_381],
      ["paragraphs-spaced", count => "a\n\n\n".repeat(count).slice(0, -2), 87_381],
      ["star-bullets", count => "* a\n".repeat(count), 65_535],
      ["tight-list", count => "- a\n".repeat(count), 65_535],
      ["hard-breaks", breaks, 87_381],
    ];
    const seed = (markdown: string) => Buffer.from(encodeRichdocSeed(markdown, 1)).toString("base64");
    const rows = shapes.map(([name, note, count]) => ({ name, markdown: note(count), candidate: seed(note(count)),
      overMarkdown: note(count + 1), over: seed(note(count + 1)) }));
    const target = new URL("../../../target/", import.meta.url);
    mkdirSync(target, { recursive: true });
    writeFileSync(new URL("first-open-dense-seeds.json", target), JSON.stringify(rows));
  });
});

describe("first-open worker", () => {
  function fixture(options?: Parameters<typeof createLiveValidationExecutor>[2]) {
    const pool = createLiveValidationExecutor(undefined, undefined, options); pools.push(pool);
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

  // Each of these once held the worker for minutes to hours at this size. On
  // a loaded host the slowest now takes about 25 s.
  const slowShapes = ["a*", "a@", "[", "[[", "a[[", "{{atom:", "$", "$$a\n", "*a ", "_a ", "~a ", "*.txt ", "[](", "[a](", "\\[", "a<!--"];
  it("builds a note of each shape that once parsed slowly at the source limit, or refuses it by size, inside the deadline", async () => {
    const { pool } = fixture();
    const bySize = ["update-limit", "capture-budget", "read-budget", "validation-budget", "seed-worker-capacity"];
    const outcomes = [];
    for (const unit of slowShapes) {
      // A started worker, so the deadline bounds only the build.
      expect((await pool.buildFirstOpenBase(policy, input("Body"))).kind).toBe("built");
      const built = await pool.buildFirstOpenBase(policy, input(unit.repeat(Math.floor(LIVE_MARKDOWN_MAX_BYTES / unit.length))));
      outcomes.push({ unit, built: built.kind === "refused" ? built.reason : built.kind });
    }
    expect(outcomes.filter(({ built }) => built !== "built" && !bySize.includes(built))).toEqual([]);
  }, (slowShapes.length + 2) * FIRST_OPEN_BUILD_MS);

  // Repeated units with what follows them once: one closer after many
  // openers, an underline after a separator, a definition after its
  // references, and the shapes the importer's growth sweep found.
  const [lineSeparator, paragraphSeparator] = [0x2028, 0x2029].map(code => String.fromCharCode(code));
  const closedShapes: [unit: string, end: string][] = [
    ["*a ", "a*"], ["_a ", "a_"], ["~a ", "a~"], ["\\[ *a ", "a*"],
    ["$$a\n", `x${lineSeparator}\n---`], ["a\n$$b\n", `x${lineSeparator}\n---`], ["$$", `${lineSeparator}\n===`],
    ["$$a\n", `x${paragraphSeparator}\n---`], ["a\n$$b\n", `x${paragraphSeparator}\n---`], ["$$", `${paragraphSeparator}\n===`], ["$$", "\r\n==="],
    ["[x] ", "\n\n[x]: /u\n"], [".<?", ""], [".<!a ", ""], [".<![CDATA[", ""], [".www.", ""], ["\\```", "@"], ["*", "&"],
    ["*\n| - |\n", ""], ["|\n| - |\n", ""], ["<!a ]]>", "\n---"],
  ];
  it("builds a note of each shape that read slowly before one closer or terminator at the source limit, or refuses it by size, inside the deadline", async () => {
    const { pool } = fixture();
    const bySize = ["update-limit", "capture-budget", "read-budget", "validation-budget", "seed-worker-capacity"];
    const outcomes = [];
    for (const [unit, end] of closedShapes) {
      expect((await pool.buildFirstOpenBase(policy, input("Body"))).kind).toBe("built");
      const built = await pool.buildFirstOpenBase(policy, input(unit.repeat(Math.floor((LIVE_MARKDOWN_MAX_BYTES - Buffer.byteLength(end)) / unit.length)) + end));
      outcomes.push({ unit, end, built: built.kind === "refused" ? built.reason : built.kind });
    }
    expect(outcomes.filter(({ built }) => built !== "built" && !bySize.includes(built))).toEqual([]);
  }, (closedShapes.length + 2) * FIRST_OPEN_BUILD_MS);

  it("ends a build that passes its deadline and answers once its slot is free, while a caller's cancellation still rejects", async () => {
    // A deadline of 0 passes long before a new worker can start and answer.
    const { pool, journal, validate } = fixture({ firstOpenBuildMs: 0 });
    expect(await pool.buildFirstOpenBase(policy, input("Body"))).toEqual({ kind: "deadline" });
    expect(await pool.buildFirstOpenBase(policy, input("Body"))).toEqual({ kind: "deadline" });
    expect((await Promise.all([validate(journal), validate(journal)])).map(result => result.kind)).toEqual(["accepted", "accepted"]);
    const abort = new AbortController(), cancelled = pool.buildFirstOpenBase(policy, input("Body"), abort.signal);
    abort.abort(new Error("cancelled"));
    await expect(cancelled).rejects.toThrow("cancelled");
  });
});
