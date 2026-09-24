import { ProtocolShapeError } from "../wireSchema";
import { describe, expect, it } from "vitest";
import { decodeVersionedResult, VERSIONED_METHOD } from "./versionedWireContract";

const validMoment = {
  momentOrder: 1,
  momentId: "m1",
  versionId: "main",
  objectId: "o",
  path: "a.md",
  recordedAtMs: 1,
  operation: "write",
  afterContentKind: "text",
  afterBlobSha256: "b",
  afterBinarySha256: null,
  beforePresent: false,
  beforeContentKind: "text",
  beforeBlobSha256: null,
  beforeBinarySha256: null,
  beforeLatestMomentId: null,
  metadataOrigin: "api",
  author: null,
  syncRecordOnly: false,
  afterText: "a",
  afterByteLength: 1,
  afterInbandLimitBytes: null,
  beforeText: null,
  beforeByteLength: null,
  beforeInbandLimitBytes: null,
};

describe("versioned result decoder rejection", () => {
  it("reports the wrong-typed nested write field path", () => {
    // The snapshot and moment stubs are complete so validation reaches the
    // one wrong-typed field this test pins: object.createdAtMs.
    const validSnapshot = {
      workspaceId: "w",
      versionId: "main",
      objectId: "o",
      path: "a.md",
      contentKind: "text",
      sha256: "s",
      byteLength: 1,
      updatedAtMs: 1,
      latestMomentId: "m1",
      metadataOrigin: "api",
      text: "a",
      blobSha256: "b",
    };
    expect(() =>
      decodeVersionedResult(VERSIONED_METHOD.textWrite, {
        object: { id: "o", workspaceId: "w", createdAtMs: "wrong" },
        snapshot: validSnapshot,
        moment: validMoment,
        deduped: false,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProtocolShapeError>>({
        name: "ProtocolShapeError",
        message: expect.stringContaining("versionedText.write result.object.createdAtMs"),
      }),
    );
  });

  it("reports the wrong-typed compareFiles entry field path", () => {
    expect(() =>
      decodeVersionedResult(VERSIONED_METHOD.versionsCompareFiles, {
        entries: [{ path: 7, status: "added" }],
        nextCursor: null,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProtocolShapeError>>({
        name: "ProtocolShapeError",
        message: expect.stringContaining("versions.compareFiles result.entries[0].path"),
      }),
    );
  });

  it("rejects unsafe integers and excess nested fields", () => {
    expect(() =>
      decodeVersionedResult(VERSIONED_METHOD.versionsCreateNamed, {
        id: "draft",
        workspaceId: "w",
        kind: "named",
        name: "Draft",
        createdAtMs: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(ProtocolShapeError);

    expect(() =>
      decodeVersionedResult(VERSIONED_METHOD.versionsCreateNamed, {
        id: "draft",
        workspaceId: "w",
        kind: "named",
        name: "Draft",
        forkPoint: { versionId: "main", unexpected: true },
        createdAtMs: 1,
      }),
    ).toThrow(ProtocolShapeError);
  });

  it("rejects invalid discriminants strictly", () => {
    expect(() =>
      decodeVersionedResult(VERSIONED_METHOD.versionsCompareFiles, {
        entries: [{ path: "x", status: "future" }],
        nextCursor: null,
      }),
    ).toThrow(ProtocolShapeError);
  });

  it("accepts a named author only with its user, grant, and integer generation", () => {
    const author = { kind: "named", userId: "ana", grantId: "grant", grantGeneration: 2 };
    expect(decodeVersionedResult(VERSIONED_METHOD.momentsGet, { ...validMoment, author })?.author).toEqual(author);
    for (const malformed of [
      { kind: "named", userId: "ana", grantId: "grant" },
      { ...author, grantGeneration: 1.5 },
      { ...author, email: "ana@example.com" },
    ]) {
      expect(() =>
        decodeVersionedResult(VERSIONED_METHOD.momentsGet, { ...validMoment, author: malformed }),
      ).toThrow(ProtocolShapeError);
    }
  });

  it("strips accepted over-cap metadata from in-band blob results", () => {
    const result = {
      bytesBase64: "YWJj",
      byteLength: 3,
      inbandLimitBytes: 48 * 1024,
    };
    expect(decodeVersionedResult(VERSIONED_METHOD.binaryReadBlob, result)).toEqual({
      bytesBase64: "YWJj",
    });
    expect(decodeVersionedResult(VERSIONED_METHOD.textReadBlob, result)).toEqual({
      bytesBase64: "YWJj",
    });
  });
});

describe("versionedText.list hasYdocMarker", () => {
  // AUDIT-SILENTSAVE round 4 (D3). hasYdocMarker is what stops the desktop
  // capture layer from retiring a settled Y.Doc for exceeding a cap a Y.Doc is
  // not bound by. A row that silently defaulted to false would re-open exactly
  // that data-loss path, so an absent key must be a protocol violation — the
  // same rule already applied to `materialized`.
  const row = (overrides: Record<string, unknown> = {}) => ({
    path: "notes/settled.md",
    objectId: "object-1",
    contentKind: "text",
    sha256: "a".repeat(64),
    byteLength: 12,
    binarySha256: null,
    updatedAtMs: 1,
    latestMomentId: "moment-1",
    metadataOrigin: "ydoc",
    hasYdocMarker: true,
    ...overrides,
  });

  it("carries the flag through, both ways", () => {
    expect(
      decodeVersionedResult(VERSIONED_METHOD.textList, { files: [row()], nextAfterPath: null })
        .files[0]!.hasYdocMarker,
    ).toBe(true);
    expect(
      decodeVersionedResult(VERSIONED_METHOD.textList, {
        files: [row({ hasYdocMarker: false, metadataOrigin: "capture" })],
        nextAfterPath: null,
      }).files[0]!.hasYdocMarker,
    ).toBe(false);
  });

  it("Rejects a row with no hasYdocMarker instead of assuming unowned", () => {
    const { hasYdocMarker: _omitted, ...withoutFlag } = row();
    expect(() =>
      decodeVersionedResult(VERSIONED_METHOD.textList, { files: [withoutFlag], nextAfterPath: null }),
    ).toThrow(ProtocolShapeError);
  });

  it("rejects a non-boolean hasYdocMarker", () => {
    expect(() =>
      decodeVersionedResult(VERSIONED_METHOD.textList, {
        files: [row({ hasYdocMarker: "yes" })],
        nextAfterPath: null,
      }),
    ).toThrow(ProtocolShapeError);
  });
});
