import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseNativeOwnerActivation } from "./nativeOwnerActivation";

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

  it("rejects byte corruption and output over budget", () => {
    const { row, bytes } = fixture();
    expect(() => parseNativeOwnerActivation(row, bytes, "notes.md", 4)).toThrow();
    bytes[0] = 9;
    expect(() => parseNativeOwnerActivation(row, bytes, "notes.md", 1000)).toThrow();
  });
});
