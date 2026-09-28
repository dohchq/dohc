import { expect, it } from "vitest";
import data from "./pathFoldData.json";
import fixtures from "./pathFoldFixtures.json";
import { foldPathSegment, isIgnoredPathSegment } from "./pathFloor";

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
