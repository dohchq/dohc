import { describe, expect, it } from "vitest";
import { sameFsEntry } from "./fsEntryIdentity";

// This decides whether a ladder of renames may keep going. Both surfaces that
// move files into the workspace trash ask it before every attempt after the
// first, so a wrong "same" here trashes a file nobody named.
describe("filesystem entry identity", () => {
  it("keeps adjacent 64-bit filesystem IDs distinct", () => {
    const before = 11_540_474_052_488_864n;
    const after = before + 1n;
    expect(Number(before)).toBe(Number(after));
    expect(
      sameFsEntry(
        { ino: before, dev: 4_035_675_872n },
        { ino: after, dev: 4_035_675_872n },
      ),
    ).toBe("replaced");
  });

  it("proves sameness only when both halves match", () => {
    expect(sameFsEntry({ ino: 7n, dev: 3n }, { ino: 7n, dev: 3n })).toBe("same");
    expect(sameFsEntry({ ino: 7n, dev: 3n }, { ino: 8n, dev: 3n })).toBe("replaced");
    // dev alone: the same inode number on a different device is a different
    // entry, which is what a remounted or swapped path looks like.
    expect(sameFsEntry({ ino: 7n, dev: 3n }, { ino: 7n, dev: 4n })).toBe("replaced");
  });

  // An inode of 0 is a filesystem saying it has none to give. That is absent
  // evidence, and absent evidence must not read as permission to proceed.
  it("answers unknown when either side has no inode to give", () => {
    expect(sameFsEntry({ ino: 0n, dev: 3n }, { ino: 7n, dev: 3n })).toBe("unknown");
    expect(sameFsEntry({ ino: 7n, dev: 3n }, { ino: 0n, dev: 3n })).toBe("unknown");
    // Both zero would compare EQUAL under a naive check, which is the
    // dangerous direction: it would read as "same" and let the ladder run on.
    expect(sameFsEntry({ ino: 0n, dev: 3n }, { ino: 0n, dev: 3n })).toBe("unknown");
  });
});
