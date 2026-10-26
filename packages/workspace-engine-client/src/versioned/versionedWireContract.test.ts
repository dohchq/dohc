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
  authors: null,
  syncRecordOnly: false,
  afterText: "a",
  afterByteLength: 1,
  afterInbandLimitBytes: null,
  beforeText: null,
  beforeByteLength: null,
  beforeInbandLimitBytes: null,
};

describe("versioned result decoder rejection", () => {
  it("decodes closed-document rewrite counts and rejects malformed replies", () => {
    const reply = {documents: 2, links: 4, unchecked: ["open.md"], uncheckedCount: 1, complete: false};
    expect(decodeVersionedResult(VERSIONED_METHOD.historyRewriteLinks, reply)).toEqual(reply);
    for (const field of ["documents", "links", "uncheckedCount", "complete"]) {
      expect(() => decodeVersionedResult(VERSIONED_METHOD.historyRewriteLinks, {...reply, [field]: "wrong"})).toThrow(ProtocolShapeError);
    }
    expect(() => decodeVersionedResult(VERSIONED_METHOD.historyRewriteLinks, {...reply, unchecked: [7]})).toThrow(ProtocolShapeError);
  });
  it("preserves parked rollback placement as a distinct outcome", () => {
    const result = {
      rolledBack: true,
      deduped: false,
      materializeEnqueued: true,
      materialized: false,
      materializeOutcome: "parked",
    };
    expect(decodeVersionedResult(VERSIONED_METHOD.textRollback, result)).toEqual(result);
  });

  it.each([
    { kind: "agent", agentId: "agent" },
    { kind: "automation", automationId: "collection:tasks#stamp", depth: 4 },
    { kind: "human", humanId: "ada" },
  ])("keeps a $kind author without a declared principal", (author) => {
    const authors = [author];
    expect(decodeVersionedResult(VERSIONED_METHOD.momentsGet, { ...validMoment, authors })?.authors).toEqual(authors);
    expect(() => decodeVersionedResult(VERSIONED_METHOD.momentsGet, {
      ...validMoment, authors: [{ ...author, onBehalfOf: null }],
    })).toThrow(ProtocolShapeError);
  });

  it("keeps every author of a moment and each corrupt entry", () => {
    const authors = [
      { kind: "human", humanId: "ada", onBehalfOf: "ada" },
      { kind: "agent", agentId: "agent" },
      { corrupt: true },
      { kind: "unattributed" },
    ];
    expect(decodeVersionedResult(VERSIONED_METHOD.momentsGet, { ...validMoment, authors })?.authors).toEqual(authors);
    expect(() => decodeVersionedResult(VERSIONED_METHOD.momentsGet, {
      ...validMoment, authors: { kind: "agent", agentId: "agent" },
    })).toThrow(ProtocolShapeError);
  });

  it("keeps a live author snapshot's account holder, declared agent, and link holder", () => {
    const authors = [
      { kind: "human", humanId: "owner", humanName: "Owner" },
      { kind: "agent", agentId: "writer", agentName: "Writer", onBehalfOf: "owner", depth: 1 },
      { kind: "link", publicPrincipalId: "public_1", label: "Anonymous" },
      { kind: "link", grantId: "grant", grantGeneration: 2, principalId: "holder" },
    ];
    expect(decodeVersionedResult(VERSIONED_METHOD.momentsGet, { ...validMoment, authors })?.authors).toEqual(authors);
    for (const author of [
      { kind: "human", humanId: "owner", humanName: "Owner", onBehalfOf: "owner" },
      { kind: "human", humanId: "owner", humanName: 1 },
      { kind: "link", publicPrincipalId: "public_1" },
      { kind: "link", publicPrincipalId: "public_1", label: "Anonymous", grantId: "grant" },
      { kind: "link", grantId: "grant", grantGeneration: 2, principalId: "holder", label: "Ana" },
      { kind: "agent", agentId: "writer", agentName: null },
    ]) {
      expect(() => decodeVersionedResult(VERSIONED_METHOD.momentsGet, { ...validMoment, authors: [author] }), JSON.stringify(author))
        .toThrow(ProtocolShapeError);
    }
  });

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
    expect(decodeVersionedResult(VERSIONED_METHOD.momentsGet, { ...validMoment, authors: [author] })?.authors)
      .toEqual([author]);
    for (const malformed of [
      { kind: "named", userId: "ana", grantId: "grant" },
      { ...author, grantGeneration: 1.5 },
      { ...author, email: "ana@example.com" },
    ]) {
      expect(() =>
        decodeVersionedResult(VERSIONED_METHOD.momentsGet, { ...validMoment, authors: [malformed] }),
      ).toThrow(ProtocolShapeError);
    }
  });

  it("accepts a link author only with its grant, integer generation, and principal", () => {
    const author = { kind: "link", grantId: "grant", grantGeneration: 2, principalId: "holder" };
    expect(decodeVersionedResult(VERSIONED_METHOD.momentsGet, { ...validMoment, authors: [author] })?.authors).toEqual([author]);
    for (const malformed of [
      { kind: "link", grantId: "grant", grantGeneration: 2 },
      { ...author, grantGeneration: 1.5 },
      { ...author, userId: "ana" },
      { ...author, displayName: "Ana" },
    ]) {
      expect(() =>
        decodeVersionedResult(VERSIONED_METHOD.momentsGet, { ...validMoment, authors: [malformed] }),
      ).toThrow(ProtocolShapeError);
    }
  });

  it("preserves live human and public link author snapshots without accepting mixed identities", () => {
    for (const author of [
      { kind: "human", humanId: "ana", humanName: "Ana" },
      { kind: "link", publicPrincipalId: "public-ana", label: "Ana" },
    ]) {
      expect(decodeVersionedResult(VERSIONED_METHOD.momentsGet, { ...validMoment, authors: [author] })?.authors).toEqual([author]);
      expect(() => decodeVersionedResult(VERSIONED_METHOD.momentsGet, { ...validMoment, authors: [{ ...author, principalId: "private" }] })).toThrow(ProtocolShapeError);
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


describe("metadata-only History pages", () => {
  const cursor = { format: 1, engineUuid: "store", workspaceId: "ws", versionId: "main", objectId: null, operationId: null,
    textFence: 1, protectedFence: -1, markerFence: 1, text: null, protected: null, marker: null };
  const metadata = { momentOrder: 1, momentId: "m", versionId: "main", objectId: "o", path: "a.md", beforePath: null, recordedAtMs: 10,
    operation: "write", afterContentKind: "text", afterByteLength: 1, metadataOrigin: "api", authors: null, syncRecordOnly: false };
  const page = { activeVersion: { id: "main", workspaceId: "ws", kind: "main", name: "Main", createdAtMs: 1 },
    moments: [metadata], protectedMoments: [], versionMarkers: [], startCursor: cursor, nextCursor: null, latestMomentOrder: 1 };
  it("decodes literal positions and metadata without payload fields", () => {
    expect(decodeVersionedResult(VERSIONED_METHOD.historyPage, page)).toEqual(page);
  });
  it.each(["afterText", "beforeText", "payload", "bytesBase64"])("rejects a page moment carrying %s", key => {
    expect(() => decodeVersionedResult(VERSIONED_METHOD.historyPage, { ...page, moments: [{ ...metadata, [key]: "body" }] })).toThrow(ProtocolShapeError);
  });
});

const operationResult = {operationId:"dohc-operation:minted", versionId:"main", momentCount:15000};
it.each([VERSIONED_METHOD.historyOperations, VERSIONED_METHOD.historyUndo])("decodes %s as a bounded summary", method => {
  const result = method===VERSIONED_METHOD.historyUndo ? {...operationResult,notRestored: [], compensationOperationId:"dohc-operation:undo:committed",deduped:true,materialized:false} : {...operationResult,kind:null};
  expect(decodeVersionedResult(method,result)).toEqual(result);
  expect(()=>decodeVersionedResult(method,{...result,moments:[]})).toThrow(ProtocolShapeError);
});
it("requires and preserves Undo members that were not restored", () => {
  const reply = { ...operationResult, compensationOperationId: "dohc-operation:undo:committed", deduped: true,
    materialized: true, notRestored: ["moved/source.md"] };
  expect(decodeVersionedResult(VERSIONED_METHOD.historyUndo, reply)).toEqual(reply);
  const { notRestored: _omitted, ...missing } = reply;
  expect(() => decodeVersionedResult(VERSIONED_METHOD.historyUndo, missing)).toThrow(ProtocolShapeError);
});
