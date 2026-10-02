import { ProtocolShapeError } from "../wireSchema";
import { describe, expect, it } from "vitest";
import { decodeOwnerYDocOutboxAppendResult, decodeYdocResult, YDOC_METHOD } from "./ydocWireContract";

const appendResult = {
  outboxId: "opaque-outbox", sequence: 1, deliveryId: "opaque-delivery",
  updateDigest: "ab".repeat(32), pendingBytes: 2, oldestEntryAtMs: 0, state: "active",
};

describe("owner Y.Doc append result", () => {
  function projection(value: typeof appendResult) {
    const { oldestEntryAtMs: _omitted, ...ownerDraft } = value;
    return { lineageClaimId: "lineage", ownerDraft };
  }

  it.each(["active", "sealed"])("accepts %s full results and six-field projections", (state) => {
    const value = { ...appendResult, state };
    expect(decodeOwnerYDocOutboxAppendResult(value)).toEqual(value);
    const projected = projection(value);
    expect(decodeYdocResult(YDOC_METHOD.recordUpdate, projected)).toEqual(projected);
  });

  it("accepts safe boundaries and strips extras without requiring projection timestamps", () => {
    const value = { ...appendResult, sequence: Number.MAX_SAFE_INTEGER, pendingBytes: Number.MAX_SAFE_INTEGER, oldestEntryAtMs: Number.MAX_SAFE_INTEGER };
    expect(decodeOwnerYDocOutboxAppendResult({ ...value, extra: true })).toEqual(value);
    const projected = projection(value);
    expect(decodeYdocResult(YDOC_METHOD.recordUpdate, { ...projected, extra: true, ownerDraft: { ...projected.ownerDraft, oldestEntryAtMs: -1, extra: true } })).toEqual(projected);
    expect(decodeYdocResult(YDOC_METHOD.recordUpdate, { seq: 0, lineageClaimId: null, extra: true })).toEqual({ seq: 0, lineageClaimId: null });
  });

  for (const field of ["sequence", "pendingBytes"] as const) {
    it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null])(`rejects invalid ${field}: %s in both shapes`, (invalid) => {
      const value = { ...appendResult, [field]: invalid };
      expect(() => decodeOwnerYDocOutboxAppendResult(value)).toThrow(TypeError);
      const { oldestEntryAtMs: _omitted, ...ownerDraft } = value;
      expect(() => decodeYdocResult(YDOC_METHOD.recordUpdate, { lineageClaimId: "lineage", ownerDraft })).toThrow(ProtocolShapeError);
    });
  }

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", null])("rejects invalid oldestEntryAtMs: %s", (oldestEntryAtMs) => {
    expect(() => decodeOwnerYDocOutboxAppendResult({ ...appendResult, oldestEntryAtMs })).toThrow(TypeError);
  });

  for (const field of ["outboxId", "deliveryId"] as const) {
    it.each(["", "bad\u0000", "bad\u007f", "\ud800", "é".repeat(257)])(`rejects invalid ${field}`, (invalid) => {
      expect(() => decodeOwnerYDocOutboxAppendResult({ ...appendResult, [field]: invalid })).toThrow(TypeError);
      expect(() => decodeYdocResult(YDOC_METHOD.recordUpdate, projection({ ...appendResult, [field]: invalid }))).toThrow(ProtocolShapeError);
    });
    it(`accepts UTF-8 byte bounds and supplementary text in ${field}`, () => {
      for (const value of ["é".repeat(256), "paired-😀"]) {
        expect(decodeOwnerYDocOutboxAppendResult({ ...appendResult, [field]: value })[field]).toBe(value);
      }
    });
  }

  it.each(["a".repeat(63), "a".repeat(65), "AB".repeat(32), "g".repeat(64), ""])("rejects noncanonical digests", (updateDigest) => {
    expect(() => decodeOwnerYDocOutboxAppendResult({ ...appendResult, updateDigest })).toThrow(TypeError);
    expect(() => decodeYdocResult(YDOC_METHOD.recordUpdate, projection({ ...appendResult, updateDigest }))).toThrow(ProtocolShapeError);
  });

  it("rejects quarantine, missing fields, null and arrays", () => {
    for (const state of ["quarantined", null]) {
      expect(() => decodeOwnerYDocOutboxAppendResult({ ...appendResult, state })).toThrow(TypeError);
      expect(() => decodeYdocResult(YDOC_METHOD.recordUpdate, { lineageClaimId: "lineage", ownerDraft: { ...appendResult, state } })).toThrow(ProtocolShapeError);
    }
    for (const field of Object.keys(appendResult)) {
      const value: Record<string, unknown> = { ...appendResult };
      delete value[field];
      expect(() => decodeOwnerYDocOutboxAppendResult(value)).toThrow(TypeError);
      if (field !== "oldestEntryAtMs") {
        expect(() => decodeYdocResult(YDOC_METHOD.recordUpdate, { lineageClaimId: "lineage", ownerDraft: value as typeof appendResult })).toThrow(ProtocolShapeError);
      }
    }
    for (const value of [null, []]) {
      expect(() => decodeOwnerYDocOutboxAppendResult(value)).toThrow(TypeError);
      expect(() => decodeYdocResult(YDOC_METHOD.recordUpdate, value)).toThrow(ProtocolShapeError);
      expect(() => decodeYdocResult(YDOC_METHOD.recordUpdate, { lineageClaimId: "lineage", ownerDraft: value })).toThrow(ProtocolShapeError);
    }
  });
});

// AUDIT-SILENTSAVE round 2 (D4). The settle result grew two fields that carry
// safety meaning — `content: string | null` (null = the artifact was past the
// in-band cap, read the file instead) and `materialized: boolean` (false = the
// settle committed but the file never moved). The daemon test proves the engine
// emits them and the capture test proves the desktop handles them; this pins
// the decoder in between, which nothing else exercised.

function settleResult(overrides: Record<string, unknown> = {}) {
  return {
    momentId: "moment-1",
    path: "notes/big.md",
    content: "# Body\n",
    sha256: "a".repeat(64),
    materialized: true,
    projection: {
      contentKind: "richdoc",
      sourceStateVectorSha256: "b".repeat(64),
      destructive: false,
    },
    ...overrides,
  };
}

describe("ydoc.settle result", () => {
  it("accepts a normal in-band settle", () => {
    const decoded = decodeYdocResult(YDOC_METHOD.settle, settleResult());
    expect(decoded.content).toBe("# Body\n");
    expect(decoded.materialized).toBe(true);
  });

  it("accepts content: null — the over-cap answer", () => {
    const decoded = decodeYdocResult(YDOC_METHOD.settle, settleResult({ content: null }));
    // null must survive as null: coercing it to "" here would hand the capture
    // layer an empty body to mirror onto disk, which is the data loss this
    // whole change exists to stop.
    expect(decoded.content).toBeNull();
  });

  it("Rejects an absent content key — null means something, missing is a violation", () => {
    const { content: _omitted, ...withoutContent } = settleResult();
    expect(() => decodeYdocResult(YDOC_METHOD.settle, withoutContent)).toThrow(
      ProtocolShapeError,
    );
  });

  it("rejects non-string, non-null content", () => {
    expect(() => decodeYdocResult(YDOC_METHOD.settle, settleResult({ content: 12 }))).toThrow(
      ProtocolShapeError,
    );
  });

  it("carries materialized: false through", () => {
    const decoded = decodeYdocResult(
      YDOC_METHOD.settle,
      settleResult({ materialized: false, content: null }),
    );
    expect(decoded.materialized).toBe(false);
  });

  it("Rejects an absent materialized key rather than assuming the file landed", () => {
    const { materialized: _omitted, ...withoutMaterialized } = settleResult();
    expect(() => decodeYdocResult(YDOC_METHOD.settle, withoutMaterialized)).toThrow(
      ProtocolShapeError,
    );
  });

  it("rejects a non-boolean materialized", () => {
    expect(() =>
      decodeYdocResult(YDOC_METHOD.settle, settleResult({ materialized: "yes" })),
    ).toThrow(ProtocolShapeError);
  });

  it("reports a wrong-typed nested projection field path", () => {
    expect(() =>
      decodeYdocResult(YDOC_METHOD.settle, settleResult({
        projection: {
          contentKind: "richdoc",
          sourceStateVectorSha256: 7,
          destructive: false,
        },
      })),
    ).toThrowError(
      expect.objectContaining<Partial<ProtocolShapeError>>({
        message: expect.stringContaining(
          "ydoc.settle result.projection.sourceStateVectorSha256",
        ),
      }),
    );
  });
});

// Two independent facts gate the open consumer's refusal. `head` says
// whether the entered version has a snapshot for the path; `lineage` says
// whether the daemon resumed durable CRDT state. Only both absent means the
// session is bound to an empty doc over nothing — head-absent alone is the
// crash-orphaned draft the daemon resurrects, whose rows hold the user's only
// copy. A decoder that defaulted either one to its permissive value would turn
// the refusal off, or throw those edits away, without a word. Both required.
function openResult(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "ydoc-1",
    objectId: "object-1",
    path: "notes/solo.md",
    contentKind: "richdoc",
    head: "present",
    lineage: "existing",
    unsettled: false,
    lineageClaimId: null,
    lineageOriginatedHere: false,
    ...overrides,
  };
}

describe("ydoc.open result", () => {
  it("accepts scene sessions", () => {
    expect(
      decodeYdocResult(YDOC_METHOD.open, openResult({ contentKind: "scene" })).contentKind,
    ).toBe("scene");
  });

  it("carries optional seed content and its seed client through", () => {
    expect(
      decodeYdocResult(YDOC_METHOD.open, openResult({ seedContent: "# Seed\n", seedClientId: 7 })),
    ).toMatchObject({ seedContent: "# Seed\n", seedClientId: 7 });
  });

  it("carries validated artifact asset descriptors through", () => {
    const descriptor = {
      id: "image-1",
      mimeType: "image/png",
      created: 12,
      lastRetrieved: 13,
      version: 1,
      ref: "drawings/board.assets/image-1-aabbccdd.png",
      sha256: "a".repeat(64),
    };
    expect(
      decodeYdocResult(YDOC_METHOD.open, openResult({
        contentKind: "scene",
        artifactAssets: [descriptor],
      })).artifactAssets,
    ).toEqual([descriptor]);
  });

  it("rejects malformed artifact asset authority", () => {
    const asset = {
      id: "image-1",
      mimeType: "image/png",
      created: 12,
      ref: "drawings/board.assets/image.png",
      sha256: "a".repeat(64),
    };
    for (const invalid of [
      { ...asset, ref: "../outside.png" },
      { ...asset, ref: "drawings/bad:name.png" },
      { ...asset, ref: "drawings/bad\u0000name.png" },
      { ...asset, ref: "drawings/bad\u0085name.png" },
      { ...asset, ref: "drawings/bad\ud800name.png" },
      { ...asset, ref: "drawings/bad\udc00name.png" },
      { ...asset, sha256: "A".repeat(64) },
      { ...asset, created: -1 },
      { ...asset, created: Number.MAX_SAFE_INTEGER + 1 },
      { ...asset, lastRetrieved: Number.MAX_SAFE_INTEGER + 1 },
      { ...asset, version: Number.MAX_SAFE_INTEGER + 1 },
      { ...asset, id: "" },
      { ...asset, mimeType: "" },
    ]) {
      expect(() =>
        decodeYdocResult(YDOC_METHOD.open, openResult({ artifactAssets: [invalid] })),
      ).toThrow(ProtocolShapeError);
    }
  });

  it("carries head and lineage through independently", () => {
    const decoded = decodeYdocResult(
      YDOC_METHOD.open,
      openResult({ head: "absent", lineage: "existing" }),
    );
    expect(decoded.head).toBe("absent");
    expect(decoded.lineage).toBe("existing");
  });

  it("Rejects an absent head key instead of assuming the version has the path", () => {
    const { head: _omitted, ...withoutHead } = openResult();
    expect(() => decodeYdocResult(YDOC_METHOD.open, withoutHead)).toThrow(
      ProtocolShapeError,
    );
  });

  it("rejects an absent unsettled key instead of assuming the file has every update", () => {
    const { unsettled: _omitted, ...withoutUnsettled } = openResult();
    expect(() => decodeYdocResult(YDOC_METHOD.open, withoutUnsettled)).toThrow(
      ProtocolShapeError,
    );
  });

  it("Rejects an absent lineage key instead of assuming there is nothing to lose", () => {
    const { lineage: _omitted, ...withoutLineage } = openResult();
    expect(() => decodeYdocResult(YDOC_METHOD.open, withoutLineage)).toThrow(
      ProtocolShapeError,
    );
  });

  it("rejects values outside the contract", () => {
    expect(() => decodeYdocResult(YDOC_METHOD.open, openResult({ head: true }))).toThrow(
      ProtocolShapeError,
    );
    expect(() =>
      decodeYdocResult(YDOC_METHOD.open, openResult({ lineage: "present" })),
    ).toThrow(ProtocolShapeError);
  });

  it("strips extra daemon fields without rejecting the result", () => {
    const decoded = decodeYdocResult(
      YDOC_METHOD.open,
      openResult({ seedMarkdown: "# Seed", daemonOnly: true }),
    );
    expect(decoded).not.toHaveProperty("seedMarkdown");
    expect(decoded).not.toHaveProperty("daemonOnly");
  });
});
