import { describe, expect, it } from "vitest";
import { momentDiffSides } from "./momentDiffSides";

const base = {
  protected: undefined,
  beforeText: null,
  afterText: null,
  beforeBinary: undefined,
  afterBinary: undefined,
  byteLength: undefined,
} as const;

const bytes = (byteLength: number) => ({ sha256: "a".repeat(64), byteLength });

describe("momentDiffSides", () => {
  it("keeps the readable preimage when text became binary", () => {
    // MUTATION: key the page on one record-level kind -> `before` is dropped
    // and the only readable thing this moment has disappears.
    const sides = momentDiffSides({
      ...base,
      beforeText: "the old words\n",
      afterText: null,
      afterBinary: bytes(2048),
    });

    expect(sides.before).toBe("the old words\n");
    expect(sides.after).toBeUndefined();
    expect(sides.afterIsBinary).toBe(true);
    expect(sides.beforeIsBinary).toBe(false);
    expect(sides.bytesOnly).toBe(false);
    // The file existed as text, so restoring returns it, not removes it.
    expect(sides.createdFile).toBe(false);
  });

  it("keeps the readable result when binary became text", () => {
    const sides = momentDiffSides({
      ...base,
      beforeText: null,
      beforeBinary: bytes(4096),
      afterText: "the new words\n",
    });

    expect(sides.before).toBeUndefined();
    expect(sides.after).toBe("the new words\n");
    expect(sides.beforeIsBinary).toBe(true);
    expect(sides.bytesOnly).toBe(false);
    // A binary preimage is not an absent one: restore brings the bytes back.
    expect(sides.createdFile).toBe(false);
  });

  it("has no diff to draw when bytes replaced bytes", () => {
    const sides = momentDiffSides({
      ...base,
      beforeBinary: bytes(10),
      afterBinary: bytes(12),
    });

    expect(sides.bytesOnly).toBe(true);
    expect(sides.before).toBeUndefined();
    expect(sides.after).toBeUndefined();
    // The result is what the file holds now.
    expect(sides.byteLength).toBe(12);
  });

  it("names the removed bytes when a binary file was deleted", () => {
    // A delete carries its bytes on the BEFORE side, and the record-level count
    // follows the after side.
    //
    // MUTATION: read moment.byteLength alone -> a removed file that held 4096
    // bytes reports "0 bytes".
    const sides = momentDiffSides({
      ...base,
      beforeBinary: bytes(4096),
      afterBinary: undefined,
      byteLength: undefined,
    });

    expect(sides.bytesOnly).toBe(true);
    expect(sides.byteLength).toBe(4096);
  });

  it("falls back to the record count when neither side carries one", () => {
    const sides = momentDiffSides({ ...base, byteLength: 77 });

    expect(sides.byteLength).toBe(77);
  });

  it("reports a created file when nothing came before it", () => {
    const sides = momentDiffSides({ ...base, afterText: "first words\n" });

    expect(sides.createdFile).toBe(true);
    expect(sides.bytesOnly).toBe(false);
  });

  it("reports a created file when the first version holds bytes", () => {
    const sides = momentDiffSides({ ...base, afterBinary: bytes(64) });

    expect(sides.createdFile).toBe(true);
    expect(sides.bytesOnly).toBe(true);
  });

  it("shows nothing for a protected moment", () => {
    const sides = momentDiffSides({
      ...base,
      protected: true,
      beforeText: "secret\n",
      afterText: "secret two\n",
    });

    expect(sides.before).toBeUndefined();
    expect(sides.after).toBeUndefined();
    expect(sides.bytesOnly).toBe(false);
    expect(sides.createdFile).toBe(false);
  });
});
