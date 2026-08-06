import { describe, expect, it } from "vitest";
import { shareSkipNoticeLines } from "./shareSkipNotice";

const boundary = {
  code: "share-boundary-violation",
  detail:
    "replicated moment is outside the share boundary: the share granted " +
    "version main, the relay offered version version-other",
};
const malformed = {
  code: "invalid-input",
  detail:
    "invalid replication input: payload exceeds the relay limit: at most " +
    "262144 bytes, offered 300000 bytes",
};
// The refusal an unusable versionId produces, verbatim from the engine
// (`SyncError::ShareVersionUnusable`). It is a MALFORMED field, not a scope
// decision — `SyncError::code` classifies it that way, and this is the vector
// that says so on the reader's side.
const unusableVersion = {
  code: "invalid-input",
  detail:
    "replicated moment carries no versionId the relay could have issued: a " +
    "version id is non-empty, unpadded, and at most 128 UTF-16 code units; " +
    "the relay offered no versionId string",
};

// An authentic shared file over this recipient's content-kind ceiling,
// verbatim from the engine (`RelayError::ShareBlobOverCeiling`).
const oversized = {
  code: "share-blob-over-ceiling",
  detail:
    "shared blob exceeds MAX_CAPTURE_BINARY_FILE_BYTES: limit 5242880 " +
    "bytes, observed 5242881 bytes — docs/report.bin",
};

describe("what a share's skipped ops say", () => {
  // The grant excluded the op. The share is the cause, and the person who
  // shared it is the one who can change that.
  it("names the share and its granter for a boundary refusal", () => {
    const [line, ...rest] = shareSkipNoticeLines(
      { ops: [boundary], more: 0 },
      "granter@dohc.test",
    );
    expect(rest).toEqual([]);
    expect(line?.kind).toBe("boundary");
    expect(
      line?.text,
      "MUTATION: a boundary refusal that stops naming the share hides the one cause the reader can act on",
    ).toBe(
      "dohc skipped 1 update outside what this share covers. Ask granter@dohc.test.",
    );
  });

  // The relay sent an envelope the engine could not read. The selector may
  // well cover it, nothing about the share is at fault, and the granter can
  // change nothing — so the copy claims none of that.
  it("claims no cause and no next step for a malformed refusal", () => {
    const [line, ...rest] = shareSkipNoticeLines(
      { ops: [malformed], more: 0 },
      "granter@dohc.test",
    );
    expect(rest).toEqual([]);
    expect(line?.kind).toBe("malformed");
    expect(
      line?.text,
      "MUTATION: telling the reader to ask the granter about a malformed envelope is a false cause AND a false instruction",
    ).toBe("dohc couldn't apply 1 update this share sent.");
    expect(line?.text).not.toContain("granter@dohc.test");
    expect(line?.text).not.toContain("this share covers");
    // The detail rides along in the notice title, so it must not claim the
    // scope the line just refused to claim.
    expect(
      line?.detail,
      "MUTATION: the persisted detail claims the op was outside the share, contradicting the notice it is attached to",
    ).not.toContain("outside the share boundary");
  });

  // An in-scope update whose versionId the relay mangled. The share may well
  // cover it and the granter can repair nothing, so this must not arrive as
  // "outside what this share covers — ask them". The classification lives in
  // `SyncError::code` (crates/dohc-engine-sync/src/error.rs); this is the
  // reader's half of it.
  it("does not blame the share for an unusable version id", () => {
    const [line, ...rest] = shareSkipNoticeLines(
      { ops: [unusableVersion], more: 0 },
      "granter@dohc.test",
    );
    expect(rest).toEqual([]);
    expect(
      line?.kind,
      "MUTATION: classifying an unusable versionId as a boundary refusal tells the reader the share excluded an update it may cover, and sends them to a granter who cannot fix it",
    ).toBe("malformed");
    expect(line?.text).toBe("dohc couldn't apply 1 update this share sent.");
    expect(line?.text).not.toContain("granter@dohc.test");
    expect(line?.text).not.toContain("this share covers");
    // The detail is persisted with the refusal and shown as this notice's
    // title. It must not claim the scope the line just refused to claim.
    expect(
      line?.detail,
      "MUTATION: the persisted detail says the moment was outside the share boundary, contradicting the notice it is attached to and the code that classifies it",
    ).not.toContain("outside the share boundary");
    expect(line?.detail).toContain("128 UTF-16 code units");
  });

  // The one replay refusal with a recovery. The bytes are authentically the
  // granter's file and it is over the ceiling this recipient enforces, so no
  // repair at the relay helps — but the granter making the file smaller and
  // sharing it again arrives as a new op at a later cursor. "dohc couldn't
  // apply it" would state that nobody can act, which is false here, and the
  // cursor has already committed past the file.
  it("tells the reader how to recover an update refused for size", () => {
    const [line, ...rest] = shareSkipNoticeLines(
      { ops: [oversized], more: 0 },
      "granter@dohc.test",
    );
    expect(rest).toEqual([]);
    expect(
      line?.kind,
      "MUTATION: an oversized update is classed as unappliable and the reader is told nothing can be done",
    ).toBe("oversized");
    expect(line?.text).toBe(
      "dohc skipped 1 update with files over the size limit. Ask granter@dohc.test to make them smaller and share them again.",
    );
    // The measurements ride along as the notice title.
    expect(line?.detail).toContain("MAX_CAPTURE_BINARY_FILE_BYTES");
  });

  it("names no granter for a size refusal when the share has none", () => {
    const [line, ...rest] = shareSkipNoticeLines(
      { ops: [oversized], more: 0 },
      null,
    );
    expect(
      rest,
      "MUTATION: the size refusal is counted twice, once as unappliable",
    ).toEqual([]);
    expect(line?.text).toBe(
      "dohc skipped 1 update with files over the size limit. Ask the person who shared it to make them smaller and share them again.",
    );
  });

  it("says both when both happened", () => {
    const lines = shareSkipNoticeLines(
      { ops: [boundary, malformed], more: 0 },
      null,
    );
    expect(lines.map((line) => line.kind)).toEqual(["boundary", "malformed"]);
    expect(lines[0]?.text).toContain("1 update outside what this share covers");
    expect(lines[1]?.text).toContain("couldn't apply 1 update");
  });

  // The overflow keeps NO class with it. Folding it into whichever class the
  // retained sample happens to show is the same false attribution one level
  // down: twenty boundary refusals and one malformed overflow would tell the
  // reader all twenty-one were outside the share and to go ask the granter.
  it("claims no cause for the overflow, whatever the retained ops are", () => {
    const allBoundary = shareSkipNoticeLines(
      { ops: [boundary, boundary], more: 1 },
      "granter@dohc.test",
    );
    const overflow = allBoundary.find((line) => line.kind === "unknown");
    expect(
      overflow?.text,
      "MUTATION: the overflow inherits the retained sample's cause and the reader is sent to the granter about it",
    ).toBe("dohc skipped 1 more update from this share.");
    expect(overflow?.text).not.toContain("this share covers");
    expect(overflow?.text).not.toContain("granter@dohc.test");
    // The boundary line counts only what it can name.
    expect(allBoundary[0]?.text).toContain(
      "2 updates outside what this share covers",
    );

    // The inverse: an actionable boundary refusal must not be buried in a
    // count the reader cannot act on.
    const allMalformed = shareSkipNoticeLines(
      { ops: [malformed, malformed], more: 1 },
      "granter@dohc.test",
    );
    expect(allMalformed.map((line) => line.kind)).toEqual([
      "malformed",
      "unknown",
    ]);
    expect(
      allMalformed[1]?.text,
      "MUTATION: the overflow is reported as unappliable, hiding a boundary refusal the reader could act on",
    ).toBe("dohc skipped 1 more update from this share.");
  });

  it("says only what it knows when nothing was retained", () => {
    const [line, ...rest] = shareSkipNoticeLines({ ops: [], more: 3 }, null);
    expect(rest).toEqual([]);
    expect(line?.kind).toBe("unknown");
    expect(line?.text).toBe("dohc skipped 3 more updates from this share.");
    expect(line?.detail).toBeUndefined();
  });

  // The count is a true lower bound — it holds only ops the record can prove
  // distinct — so an incomplete count says so rather than reading exact.
  it("says the overflow is a lower bound when the count is incomplete", () => {
    const lines = shareSkipNoticeLines(
      { ops: [boundary], more: 4, inexact: true },
      null,
    );
    expect(lines[1]?.text).toBe(
      "dohc skipped at least 4 more updates from this share.",
    );
    // The class line stays exact: it counts only what it holds.
    expect(lines[0]?.text).toContain("1 update outside what this share covers");
  });
});
