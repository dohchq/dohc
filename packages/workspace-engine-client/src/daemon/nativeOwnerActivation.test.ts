import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseNativeOwnerActivation, parseNativeOwnerActivationSource } from "./nativeOwnerActivation";

function fixture() {
  const baseline = Buffer.from([0, 0]), full = Buffer.from([1, 1, 1]);
  const bytes = Buffer.concat([baseline, full]);
  const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const source = {
    version: 1, relayDatabaseNamespace: "relay", workspaceId: "workspace", mainVersionId: "main",
    objectId: "object", lineageClaimId: digest(baseline), currentPath: "notes.md", replicationEpoch: "epoch",
    streamIdentity: "stream", committedCursor: 10, baseOriginId: "peer", baseOriginSeq: 2, baseRelaySeq: 8,
    sourceMomentId: "source", sourceDigest: digest(Buffer.from("source")), sourceByteLength: 6,
    nativeHeadSequence: 1, fullStateDigest: digest(full), fullStateByteLength: full.length,
  };
  return { bytes, row: { status: "captured", activationId: `ordinary-activation-${"a".repeat(64)}`,
    sessionId: "native-session", source, baselineByteLength: baseline.length, streamId: 1,
    byteLength: bytes.length, digest: digest(bytes) } };
}

describe("native imported owner activation", () => {
  it("preserves the reader requirement in Rust's field order", () => {
    const { row, bytes } = fixture();
    const ordinary = JSON.stringify(parseNativeOwnerActivationSource(row.source, "notes.md", 1000));
    const source = Object.fromEntries(Object.entries({ ...row.source, readerSource: true }).reverse());
    const captured = parseNativeOwnerActivation({ ...row, source }, bytes, "notes.md", 1000);
    expect(JSON.stringify(captured.source)).toBe(ordinary.replace('{"version":1,', '{"version":1,"readerSource":true,'));
  });

  it.each([false, 0, 1, "true", null])("rejects a noncanonical reader requirement: %s", (readerSource) => {
    const { row } = fixture();
    expect(() => parseNativeOwnerActivationSource({ ...row.source, readerSource }, "notes.md", 1000)).toThrow();
  });

  it("keeps original lineage separate from full current state and uses the real session", () => {
    const { row, bytes } = fixture();
    const captured = parseNativeOwnerActivation(row, bytes, "notes.md", 1000);
    expect(captured.sessionId).toBe("native-session");
    expect(captured.baselineBytes).toEqual(Buffer.from([0, 0]));
    expect(captured.fullState).toEqual(Buffer.from([1, 1, 1]));
    expect(captured.source.baseRelaySeq).toBe(8);
    row.source.committedCursor = 100;
    expect(captured.source.committedCursor).toBe(10);
  });

  it.each([
    (row: ReturnType<typeof fixture>["row"]) => { row.source.baseRelaySeq = 11; },
    (row: ReturnType<typeof fixture>["row"]) => { row.source.fullStateByteLength = 2; },
    (row: ReturnType<typeof fixture>["row"]) => { row.source.lineageClaimId = "b".repeat(64); },
    (row: ReturnType<typeof fixture>["row"]) => { row.source.currentPath = "other.md"; },
    (row: ReturnType<typeof fixture>["row"]) => { row.source.sourceByteLength = 2_097_153; },
    (row: ReturnType<typeof fixture>["row"]) => { row.source.nativeHeadSequence = -1; },
    (row: ReturnType<typeof fixture>["row"]) => { row.baselineByteLength = 4; },
    (row: ReturnType<typeof fixture>["row"]) => { row.sessionId = ""; },
  ])("rejects contradictory capture evidence", (change) => {
    const { row, bytes } = fixture();
    change(row);
    expect(() => parseNativeOwnerActivation(row, bytes, "notes.md", 1000)).toThrow();
  });

  it("returns the source in native field order whatever order it arrives in", () => {
    const { row } = fixture();
    const reversed = Object.fromEntries(Object.entries(row.source).reverse());
    // The JSON serde writes for ImportedOwnerSource, which native adoption evidence hashes.
    expect(JSON.stringify(parseNativeOwnerActivationSource(reversed, "notes.md", 1000))).toBe(
      `{"version":1,"relayDatabaseNamespace":"relay","workspaceId":"workspace","mainVersionId":"main","objectId":"object",` +
      `"lineageClaimId":"${row.source.lineageClaimId}","currentPath":"notes.md","replicationEpoch":"epoch","streamIdentity":"stream",` +
      `"committedCursor":10,"baseOriginId":"peer","baseOriginSeq":2,"baseRelaySeq":8,"sourceMomentId":"source",` +
      `"sourceDigest":"${row.source.sourceDigest}","sourceByteLength":6,"nativeHeadSequence":1,` +
      `"fullStateDigest":"${row.source.fullStateDigest}","fullStateByteLength":3}`);
  });

  it("keeps a successor's predecessor last, as native writes it, and omits an absent one", () => {
    const { row } = fixture();
    expect(parseNativeOwnerActivationSource(row.source, "notes.md", 1000)).not.toHaveProperty("predecessorActivationId");
    const successor = { predecessorActivationId: "ordinary-activation-predecessor", ...row.source };
    const parsed = parseNativeOwnerActivationSource(successor, "notes.md", 1000);
    expect(Object.keys(parsed).at(-1)).toBe("predecessorActivationId");
    expect(JSON.stringify(parsed)).toBe(`${JSON.stringify(parseNativeOwnerActivationSource(row.source, "notes.md", 1000)).slice(0, -1)},` +
      `"predecessorActivationId":"ordinary-activation-predecessor"}`);
    for (const predecessor of ["", null, 7, "a".repeat(1025), "a\0b"]) {
      expect(() => parseNativeOwnerActivationSource({ ...row.source, predecessorActivationId: predecessor }, "notes.md", 1000)).toThrow();
    }
  });

  it("rejects byte corruption and output over budget", () => {
    const { row, bytes } = fixture();
    expect(() => parseNativeOwnerActivation(row, bytes, "notes.md", 4)).toThrow();
    bytes[0] = 9;
    expect(() => parseNativeOwnerActivation(row, bytes, "notes.md", 1000)).toThrow();
  });
});
