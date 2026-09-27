import {expect, it} from "vitest";
import {normalizeShareLabel, shareSubjectFallback} from "./shareLabels";
it("strips controls and bidi overrides without breaking names or joined emoji", () => {
  expect(normalizeShareLabel(" \tAna\u202e\n ")).toBe("Ana");
  expect(normalizeShareLabel("👩‍💻 می‌روم")).toBe("👩‍💻 می‌روم");
  expect(Array.from(normalizeShareLabel("😀".repeat(200))!)).toHaveLength(160);
});
it("names legacy scopes without inventing a title", () => {
  expect(shareSubjectFallback({paths: [], versionId: "main"})).toBe("a workspace");
  expect(shareSubjectFallback({kind: "group", paths: ["trip"]})).toBe("a Group");
});
