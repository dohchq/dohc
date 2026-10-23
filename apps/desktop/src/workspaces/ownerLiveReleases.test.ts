import {readdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {expect, it, vi} from "vitest";
import {createUnwrittenReleases} from "./ownerLiveReleases";
import {createTestScratch} from "./testTemp";

const binding = (objectId: string) => ({workspaceId: "owner", mainVersionId: "main", objectId, lineageClaimId: "a".repeat(64),
  currentPath: `${objectId}.md`, selectorPaths: [`${objectId}.md`], restoreFenceGeneration: 0});
const release = (objectId: string) => ({workspaceId: "owner", objectId, path: `${objectId}.md`, reason: "invalid-update", binding: binding(objectId)});

it("skips an unreadable record, keeps the file it came from aside, and still lists and changes the others", async () => {
  const file = join(await createTestScratch("dohc-unwritten-rows-"), "owner-live-releases.json");
  const raw = JSON.stringify([release("good"), {...release("bad"), binding: {objectId: "bad"}}, release("other")]);
  await writeFile(file, raw);
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const releases = createUnwrittenReleases(() => file);
    expect((await releases.list("owner")).map(row => row.objectId)).toEqual(["good", "other"]);
    const aside = (await readdir(dirname(file))).filter(name => name.startsWith("owner-live-releases.json.unreadable-"));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(dirname(file), aside[0]!), "utf8")).toBe(raw);
    await releases.remove("owner", "good");
    expect((await createUnwrittenReleases(() => file).list("owner")).map(row => row.objectId)).toEqual(["other"]);
  } finally {vi.restoreAllMocks();}
});

it("reads a file that is not a list as no records, and keeps it aside", async () => {
  const file = join(await createTestScratch("dohc-unwritten-broken-"), "owner-live-releases.json");
  await writeFile(file, "{not json");
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const releases = createUnwrittenReleases(() => file);
    expect(await releases.list("owner")).toEqual([]);
    await releases.put(release("new"), "{\"kept\":true}");
    expect((await createUnwrittenReleases(() => file).list("owner")).map(row => row.objectId)).toEqual(["new"]);
    expect((await readdir(dirname(file))).filter(name => name.includes(".unreadable-"))).toHaveLength(1);
  } finally {vi.restoreAllMocks();}
});

it("keeps each record's recovery package until that record is removed by its document", async () => {
  const file = join(await createTestScratch("dohc-unwritten-recovery-"), "owner-live-releases.json");
  const releases = createUnwrittenReleases(() => file);
  await releases.put(release("plan"), "plan package");
  await releases.put({...release("notes"), path: "plan.md"}, "notes package");
  const reopened = createUnwrittenReleases(() => file);
  expect(await reopened.recovery("owner", "plan")).toBe("plan package");
  // Another document at the same path keeps its own record.
  await reopened.remove("owner", "plan");
  expect((await reopened.list("owner")).map(row => row.objectId)).toEqual(["notes"]);
  expect(await reopened.recovery("owner", "plan")).toBeNull();
  expect(await reopened.recovery("owner", "notes")).toBe("notes package");
});
