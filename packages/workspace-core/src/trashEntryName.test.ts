import { describe, expect, it } from "vitest";
import {
  fitWithinNameMax,
  NAME_MAX_BYTES,
  trashEntryName,
} from "./trashEntryName";

const PREFIX = "1785780488421-0ff532fe-1e3f-4c2b-9a77-5d1e6c8b3a10-";

const byteLength = (value: string) => new TextEncoder().encode(value).length;

describe("trash entry names", () => {
  // The #613 vector: a basename that is legal everywhere, and a prefix that
  // pushes the pair past the per-component limit.
  it("fits a legal 230-character basename that the prefix would overflow", () => {
    const name = `${"a".repeat(226)}.txt`;
    expect(name).toHaveLength(230);
    expect(byteLength(`${PREFIX}${name}`)).toBeGreaterThan(NAME_MAX_BYTES);

    const entry = trashEntryName(name, PREFIX);
    expect(byteLength(entry)).toBe(NAME_MAX_BYTES);
    expect(entry.startsWith(PREFIX)).toBe(true);
  });

  it("leaves a name that already fits exactly as it is", () => {
    const name = "notes.md";
    expect(trashEntryName(name, PREFIX)).toBe(`${PREFIX}${name}`);
  });

  // The boundary either side, because an off-by-one here either truncates a
  // name that fits or ships one the filesystem rejects.
  it("keeps the longest name that fits and trims the first that does not", () => {
    const budget = NAME_MAX_BYTES - byteLength(PREFIX);
    const exact = "b".repeat(budget);
    expect(trashEntryName(exact, PREFIX)).toBe(`${PREFIX}${exact}`);
    const oneOver = "b".repeat(budget + 1);
    expect(byteLength(trashEntryName(oneOver, PREFIX))).toBe(NAME_MAX_BYTES);
  });

  // Bytes, not characters: 200 two-byte characters is 400 bytes, and a
  // character-counting cap would ship a name the filesystem cannot hold.
  it("counts bytes, and never leaves half a character behind", () => {
    const name = "é".repeat(200);
    expect(name).toHaveLength(200);
    const entry = trashEntryName(name, PREFIX);
    expect(byteLength(entry)).toBeLessThanOrEqual(NAME_MAX_BYTES);
    expect(entry).not.toMatch(/�/);
  });

  // A cut that lands mid-sequence decodes to U+FFFD. Trimming it is what keeps
  // the trash listing readable.
  it("trims a replacement character produced by the cut", () => {
    const budget = NAME_MAX_BYTES - byteLength(PREFIX);
    // One single-byte character short of the budget, then a 2-byte character
    // that the cut must split.
    const name = `${"c".repeat(budget - 1)}é`;
    const entry = trashEntryName(name, PREFIX);
    expect(entry).toBe(`${PREFIX}${"c".repeat(budget - 1)}`);
    expect(byteLength(entry)).toBe(NAME_MAX_BYTES - 1);
  });

  it("answers an empty name when the prefix alone exhausts the limit", () => {
    const prefix = "p".repeat(NAME_MAX_BYTES);
    expect(fitWithinNameMax("anything", prefix)).toBe("");
    expect(trashEntryName("anything", prefix)).toBe(prefix);
  });
});
