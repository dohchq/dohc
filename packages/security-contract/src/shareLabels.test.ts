import {expect, it} from "vitest";
import {normalizeShareLabel, shareSubjectFallback, shareSenderLabel} from "./shareLabels";
it("strips controls and bidi overrides without breaking names or joined emoji", () => {
  expect(normalizeShareLabel(" \tAna\u202e\n ")).toBe("Ana");
  expect(normalizeShareLabel("👩‍💻 می‌روم")).toBe("👩‍💻 می‌روم");
  expect(Array.from(normalizeShareLabel("😀".repeat(200))!)).toHaveLength(160);
});
it("names legacy scopes without inventing a title", () => {
  expect(shareSubjectFallback({paths: [], versionId: "main"})).toBe("a workspace");
  expect(shareSubjectFallback({kind: "group", paths: ["trip"]})).toBe("a Group");
});

it("removes invisible formatting and line separators while preserving joiners", () => {
  expect(normalizeShareLabel("A\u200b\ufeff\u{e0001}\u{e0061}\u{e007f}\u2028\u2029B")).toBe("AB");
  expect(normalizeShareLabel("\u200b\ufeff\u2028\u2029")).toBeNull();
  expect(normalizeShareLabel("👩\u200d💻 می\u200cروم")).toBe("👩‍💻 می‌روم");
});
it("keeps email alongside names, including long names and existing relay labels", () => {
  expect(shareSenderLabel("IT Security", "owner@example.test")).toBe("IT Security (owner@example.test)");
  expect(shareSenderLabel("Ana (ana@example.test)", "ana@example.test")).toBe("Ana (ana@example.test)");
  expect(shareSenderLabel("x".repeat(400), "owner@example.test")).toMatch(/ \(owner@example\.test\)$/);
  expect(shareSenderLabel(null, "owner@example.test")).toBe("owner@example.test");
});

it("fits the sender response limit without cutting a long email or surrogate pair", () => {
  const email = "a".repeat(64) + "@" + "b".repeat(63) + "." + "c".repeat(63) + ".test";
  const label = shareSenderLabel("😀".repeat(40), email);
  expect(label.length).toBeLessThanOrEqual(320);
  expect(label).toContain("(" + email + ")");
  expect(label).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
});
