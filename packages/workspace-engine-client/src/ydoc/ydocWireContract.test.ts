import { describe, expect, it } from "vitest";
import {
  YdocProtocolShapeError,
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
});
