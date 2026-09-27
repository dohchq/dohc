import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { nameSlug, nameByteLength, isPortableNamePath, truncateName } from "./names";
import { scanMentionTokens, normalizeHandle, activeMentionQuery } from "./chatMentions";

const cases: Array<{ name: string; input: string; slug: string }> = JSON.parse(readFileSync(new URL("../../../crates/dohc-engine-domain/tests/fixtures/names.json", import.meta.url), "utf8"));
it.each(cases)("shares the engine slug: $name", ({ input, slug }) => {
  expect(nameSlug(input)).toBe(slug);
  expect(nameByteLength(nameSlug(input))).toBeLessThanOrEqual(200);
  expect(nameSlug(slug)).toBe(slug);
  if (slug) {
    expect(isPortableNamePath(slug)).toBe(true);
    expect(scanMentionTokens("@" + slug).map(token => normalizeHandle(token.handle))).toEqual([slug]);
    expect(activeMentionQuery("@" + slug, slug.length + 1)?.query).toBe(slug);
  }
});
it.each(["CON", "aux.txt", "COM¹.js", "a/NUL.txt", "a/../b", "a//b", ".hidden", "a.", "a ", "a:b", "a\\b", "a/" + "界".repeat(86)])("rejects unsafe source path %s", path => {
  expect(isPortableNamePath(path)).toBe(false);
});
it("keeps complete mention offsets and normalizes lookup keys", () => {
  const body = "Hi @हिन्दी @Cafe\u0301 @𐐀𐐁.";
  const tokens = scanMentionTokens(body);
  expect(tokens.map(token => normalizeHandle(token.handle))).toEqual(["हिन्दी", "café", "𐐨𐐩"]);
  for (const token of tokens) expect(body.slice(token.start, token.end)).toBe("@" + token.handle);
  expect(scanMentionTokens("@" + "界".repeat(67))).toEqual([]);
  expect(scanMentionTokens("@CON @nul @aux.txt").map(token => normalizeHandle(token.handle))).toEqual(["con", "nul", "aux.txt"]);
  expect(scanMentionTokens("@\u0345abc")).toEqual([]);
});

const boundaries: { unicodeVersion: string; cases: Array<{ name: string; input: string; maxBytes: number; expected: string }> } = JSON.parse(readFileSync(new URL("../../../crates/dohc-engine-domain/tests/fixtures/name-boundaries.json", import.meta.url), "utf8"));
it("uses the Unicode version checked by the shared boundary fixtures", () => {
  expect(
    `${process.versions.unicode}.0`,
    "Re-check the shared boundary fixtures in TypeScript and Rust before updating unicodeVersion.",
  ).toBe(boundaries.unicodeVersion);
});
it.each(boundaries.cases)("shares the engine byte boundary: $name", ({ input, maxBytes, expected }) => {
  expect(truncateName(input, maxBytes)).toBe(expected);
  expect(nameByteLength(truncateName(input, maxBytes))).toBeLessThanOrEqual(maxBytes);
});
