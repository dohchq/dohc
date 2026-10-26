import { LinksEdgesInput, LinksEdgesResult } from "./links";
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
    complete: false, indexBuilding: false, mountsCovered: true, nextCursor: null };
  expect(LinksInResult.parse(page)).toEqual(page);
  expect(LinksInResult.safeParse({ ...page, unchecked: [...page.unchecked, "extra.md"] }).success).toBe(false);
});


it("distinguishes building from lasting unchecked sources", () => {
  const base = { versionId: "main", subject: { path: "a.md", objectId: "a" }, entries: [],
    unchecked: ["large.md"], complete: false, indexBuilding: false, mountsCovered: false, nextCursor: null };
  expect(LinksInResult.parse(base)).toEqual(base);
  expect(LinksInResult.parse({ ...base, indexBuilding: true })?.indexBuilding).toBe(true);
  const { indexBuilding: _building, ...missing } = base;
  expect(LinksInResult.safeParse(missing).success).toBe(false);
});

it("shares the edge record and UTF-8 envelope budgets across all arrays", () => {
  const page = {versionId:"main",files:[{objectId:"a",path:"a.md",title:"A"}],entries:[],unchecked:Array.from({length:99},()=>"pending.md"),complete:false,indexBuilding:true,mountsCovered:false,nextCursor:null};
  expect(LinksEdgesResult.parse(page)).toEqual(page);
  expect(LinksEdgesResult.safeParse({...page,unchecked:[...page.unchecked,"extra.md"]}).success).toBe(false);
  expect(LinksEdgesResult.safeParse({...page,unchecked:Array.from({length:99},()=> "😀".repeat(1024))}).success).toBe(false);
  expect(LinksEdgesInput.safeParse({subject:{path:"a.md"}}).success).toBe(false);
  expect(LinksEdgesInput.safeParse({cursor:"x".repeat(32769)}).success).toBe(false);
});
