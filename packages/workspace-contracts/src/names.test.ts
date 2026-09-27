import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { nameSlug, nameByteLength, isPortableNamePath } from "./names";
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
  expect(scanMentionTokens("@CON")).toEqual([]);
});
