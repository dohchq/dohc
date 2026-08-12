import { describe, expect, it } from "vitest";
import {
  YdocProtocolShapeError,
  decodeYdocOpenResult,
  decodeYdocSettleResult,
} from "./ydocWireContract";

// AUDIT-SILENTSAVE round 2 (D4). The settle result grew two fields that carry
// safety meaning — `markdown: string | null` (null = the body was past the
// in-band cap, read the file instead) and `materialized: boolean` (false = the
// settle committed but the file never moved). The daemon test proves the engine
// EMITS them and the capture test proves the desktop HANDLES them; this pins
// the decoder in between, which nothing else exercised.

function settleResult(overrides: Record<string, unknown> = {}) {
  return {
    momentId: "moment-1",
    path: "notes/big.md",
    markdown: "# Body\n",
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

describe("decodeYdocSettleResult", () => {
  it("accepts a normal in-band settle", () => {
    const decoded = decodeYdocSettleResult(settleResult());
    expect(decoded.markdown).toBe("# Body\n");
    expect(decoded.materialized).toBe(true);
  });

  it("accepts markdown: null — the over-cap answer", () => {
    const decoded = decodeYdocSettleResult(settleResult({ markdown: null }));
    // null must survive as null: coercing it to "" here would hand the capture
    // layer an empty body to mirror onto disk, which is the data loss this
    // whole change exists to stop.
    expect(decoded.markdown).toBeNull();
  });

  it("REJECTS an absent markdown key — null means something, missing is a violation", () => {
    const { markdown: _omitted, ...withoutMarkdown } = settleResult();
    expect(() => decodeYdocSettleResult(withoutMarkdown)).toThrow(
      YdocProtocolShapeError,
    );
  });

  it("rejects a non-string, non-null markdown", () => {
    expect(() => decodeYdocSettleResult(settleResult({ markdown: 12 }))).toThrow(
      YdocProtocolShapeError,
    );
  });

  it("carries materialized: false through", () => {
    const decoded = decodeYdocSettleResult(
      settleResult({ materialized: false, markdown: null }),
    );
    expect(decoded.materialized).toBe(false);
  });

  it("REJECTS an absent materialized key rather than assuming the file landed", () => {
    const { materialized: _omitted, ...withoutMaterialized } = settleResult();
    expect(() => decodeYdocSettleResult(withoutMaterialized)).toThrow(
      YdocProtocolShapeError,
    );
  });

  it("rejects a non-boolean materialized", () => {
    expect(() =>
      decodeYdocSettleResult(settleResult({ materialized: "yes" })),
    ).toThrow(YdocProtocolShapeError);
  });

  it("reports a wrong-typed nested projection field path", () => {
    expect(() =>
      decodeYdocSettleResult(settleResult({
        projection: {
          contentKind: "richdoc",
          sourceStateVectorSha256: 7,
          destructive: false,
        },
      })),
    ).toThrowError(
      expect.objectContaining<Partial<YdocProtocolShapeError>>({
        message: expect.stringContaining(
          "ydoc.settle result.projection.sourceStateVectorSha256",
        ),
      }),
    );
  });
});

// #534. Two INDEPENDENT facts gate the open consumer's refusal. `head` says
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
    initialUpdateBase64: "AAA=",
    head: "present",
    lineage: "existing",
    ...overrides,
  };
}

describe("decodeYdocOpenResult", () => {
  it("carries head and lineage through independently", () => {
    const decoded = decodeYdocOpenResult(
      openResult({ head: "absent", lineage: "existing" }),
    );
    expect(decoded.head).toBe("absent");
    expect(decoded.lineage).toBe("existing");
  });

  it("REJECTS an absent head key instead of assuming the version has the path", () => {
    const { head: _omitted, ...withoutHead } = openResult();
    expect(() => decodeYdocOpenResult(withoutHead)).toThrow(
      YdocProtocolShapeError,
    );
  });

  it("REJECTS an absent lineage key instead of assuming there is nothing to lose", () => {
    const { lineage: _omitted, ...withoutLineage } = openResult();
    expect(() => decodeYdocOpenResult(withoutLineage)).toThrow(
      YdocProtocolShapeError,
    );
  });

  it("rejects values outside the contract", () => {
    expect(() => decodeYdocOpenResult(openResult({ head: true }))).toThrow(
      YdocProtocolShapeError,
    );
    expect(() =>
      decodeYdocOpenResult(openResult({ lineage: "present" })),
    ).toThrow(YdocProtocolShapeError);
  });

  it("strips extra daemon fields without rejecting the result", () => {
    const decoded = decodeYdocOpenResult(
      openResult({ seedMarkdown: "# Seed", daemonOnly: true }),
    );
    expect(decoded).not.toHaveProperty("seedMarkdown");
    expect(decoded).not.toHaveProperty("daemonOnly");
  });
});
