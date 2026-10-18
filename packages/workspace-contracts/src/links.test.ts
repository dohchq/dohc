import { expect, it } from "vitest";
import { LinksInResult, LinksResolveResult } from "./links";

it("distinguishes found, creation, fragment-only, and unsupported answers", () => {
  const answer = { versionId: "main", mountsCovered: true, results: [
    { path: "target.md", fragment: null },
    { path: null, create: "notes/new#plan.md", fragment: null },
    { path: "source.md", fragment: "local" },
    null,
  ] };
  expect(LinksResolveResult.parse(answer)).toEqual(answer);
});

it("rejects a creation answer without a path or with two target paths", () => {
  for (const row of [{ path: null, fragment: null }, { path: "a.md", create: "b.md", fragment: null }]) {
    expect(LinksResolveResult.safeParse({ versionId: "main", mountsCovered: true, results: [row] }).success).toBe(false);
  }
});

it("allows a hundred unchecked sources and refuses more", () => {
  const page = { versionId: "main", subject: { path: "target.md", objectId: "target" },
    entries: [], unchecked: Array.from({ length: 100 }, (_, n) => `source-${n}.md`),
    complete: false, mountsCovered: true, nextCursor: null };
  expect(LinksInResult.parse(page)).toEqual(page);
  expect(LinksInResult.safeParse({ ...page, unchecked: [...page.unchecked, "extra.md"] }).success).toBe(false);
});
