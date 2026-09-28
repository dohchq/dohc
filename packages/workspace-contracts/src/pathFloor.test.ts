import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import data from "./pathFoldData.json";
import fixtures from "../../../crates/dohc-engine-files/src/pathFoldFixtures.json";
import { foldPathSegment, isIgnoredPathSegment } from "./pathFloor";

it("keeps the generated TypeScript data equal to the crate's canonical data", () => {
  const canonical = new URL("../../../crates/dohc-engine-files/src/pathFoldData.json", import.meta.url);
  expect(data).toEqual(JSON.parse(readFileSync(canonical, "utf8")));
});

it.each(fixtures)("folds $input and admits only ordinary names", ({ input, folded, ignored }) => {
  expect(foldPathSegment(input)).toBe(folded);
  expect(isIgnoredPathSegment(input)).toBe(ignored);
});

it("removes the complete Default_Ignorable_Code_Point set", () => {
  for (const [start, end] of data.ignorables) {
    for (let code = start; code <= end; code++) {
      const name = `.do${String.fromCodePoint(code)}hc`;
      expect(foldPathSegment(name)).toBe(".dohc");
      expect(isIgnoredPathSegment(name)).toBe(true);
    }
  }
});

it("keeps the ASCII fast path equivalent to full folding", () => {
  for (let code = 0; code < 128; code++) {
    const name = String.fromCodePoint(code);
    expect(foldPathSegment(name)).toBe(foldPathSegment(`${name}\u200d`));
  }
});
