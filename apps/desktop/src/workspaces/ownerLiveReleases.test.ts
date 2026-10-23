import {readdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {expect, it, vi} from "vitest";
import {createUnwrittenReleases} from "./ownerLiveReleases";
import {createTestScratch} from "./testTemp";

const fs = vi.hoisted(() => ({copyFile: vi.fn(), rm: vi.fn()}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fs.copyFile.mockImplementation(actual.copyFile);
  fs.rm.mockImplementation(actual.rm);
  return {...actual, copyFile: fs.copyFile, rm: fs.rm};
});

const binding = (objectId: string, restoreFenceGeneration = 0) => ({workspaceId: "owner", mainVersionId: "main", objectId, lineageClaimId: "a".repeat(64),
  currentPath: `${objectId}.md`, selectorPaths: [`${objectId}.md`], restoreFenceGeneration});
const release = (objectId: string, headDeliveryId = `${objectId}-outbox:1:digest`) =>
  ({workspaceId: "owner", objectId, path: `${objectId}.md`, reason: "invalid-update", binding: binding(objectId), headDeliveryId, retry: true});
const asideFiles = async (file: string) => (await readdir(dirname(file))).filter(name => name.startsWith("owner-live-releases.json.unreadable-"));

it("keeps a damaged record without Try again, skips an unreadable one, and sets their file aside once", async () => {
  const file = join(await createTestScratch("dohc-unwritten-rows-"), "owner-live-releases.json");
  const {reason: _reason, ...unexplained} = release("unexplained");
  const raw = JSON.stringify([release("good"), {...release("bad"), binding: {objectId: "bad"}}, {nothing: "to save"}, release("other"), {...unexplained, binding: null}]);
  await writeFile(file, raw);
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const releases = createUnwrittenReleases(() => file);
    // Three identifiers are enough to keep a record and its package.
    expect(await releases.list("owner")).toEqual([release("good"), {...release("bad"), binding: null, retry: false}, release("other"),
      {...release("unexplained"), reason: "unreadable-record", binding: null, retry: false}]);
    // A second start with the same content keeps no second copy.
    await createUnwrittenReleases(() => file).list("owner");
    const aside = await asideFiles(file);
    expect(aside).toHaveLength(1);
    expect(await readFile(join(dirname(file), aside[0]!), "utf8")).toBe(raw);
    await releases.written("owner", "good", binding("good"));
    expect((await createUnwrittenReleases(() => file).list("owner")).map(row => [row.objectId, row.retry])).toEqual([["bad", false], ["other", true], ["unexplained", false]]);
    expect(await asideFiles(file)).toHaveLength(1);
    // The damaged record ends only when its stored package has been saved.
    await releases.written("owner", "bad", binding("bad"));
    await releases.remove("owner", "bad", {binding: null, headDeliveryId: release("bad").headDeliveryId});
    expect((await createUnwrittenReleases(() => file).list("owner")).map(row => row.objectId)).toEqual(["other", "unexplained"]);
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
    expect(await asideFiles(file)).toHaveLength(1);
  } finally {vi.restoreAllMocks();}
});

it("still lists the records when their file cannot be set aside", async () => {
  const file = join(await createTestScratch("dohc-unwritten-aside-"), "owner-live-releases.json");
  await writeFile(file, JSON.stringify([release("good"), {objectId: "bad"}]));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fs.copyFile.mockRejectedValueOnce(Object.assign(new Error("EACCES: permission denied, copyfile"), {code: "EACCES"}));
  try {
    expect((await createUnwrittenReleases(() => file).list("owner")).map(row => row.objectId)).toEqual(["good"]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("could not keep the unreadable live edit records"), expect.any(Error));
    expect(await asideFiles(file)).toEqual([]);
  } finally {vi.restoreAllMocks();}
});

it("keeps each record's recovery package until that record is removed by its own binding and queue", async () => {
  const file = join(await createTestScratch("dohc-unwritten-recovery-"), "owner-live-releases.json");
  const releases = createUnwrittenReleases(() => file);
  await releases.put(release("plan"), "plan package");
  await releases.put({...release("notes"), path: "plan.md"}, "notes package");
  const reopened = createUnwrittenReleases(() => file);
  expect(await reopened.recovery("owner", "plan")).toBe("plan package");
  // A release of another generation of the same document ends nothing, nor does a save of another queue's record.
  await reopened.written("owner", "plan", binding("plan", 1));
  await reopened.remove("owner", "plan", {binding: binding("plan"), headDeliveryId: "rebuilt-outbox:1:digest"});
  expect(await reopened.recovery("owner", "plan")).toBe("plan package");
  // Another document at the same path keeps its own record.
  await reopened.remove("owner", "plan", release("plan"));
  expect((await reopened.list("owner")).map(row => row.objectId)).toEqual(["notes"]);
  expect(await reopened.recovery("owner", "plan")).toBeNull();
  expect(await reopened.recovery("owner", "notes")).toBe("notes package");
});

it("keeps a record the engine no longer holds, without Try again, and no later release replaces its package", async () => {
  const file = join(await createTestScratch("dohc-unwritten-ended-"), "owner-live-releases.json");
  const releases = createUnwrittenReleases(() => file);
  await releases.put(release("plan"), "first package");
  // The same release of the same queue, put again before it commits, replaces its own package.
  await releases.put(release("plan"), "same release");
  await releases.endRetry("owner", "plan", binding("plan"));
  const reopened = createUnwrittenReleases(() => file);
  expect(await reopened.list("owner")).toEqual([{...release("plan"), retry: false}]);
  await expect(reopened.put(release("plan"), "later package")).rejects.toThrow("Save a recovery copy of plan.md first.");
  await expect(reopened.put({...release("plan"), binding: binding("plan", 1)}, "later package")).rejects.toThrow("Save a recovery copy of plan.md first.");
  // Only Save ends it: a release of the same binding that wrote the file does not.
  await reopened.written("owner", "plan", binding("plan"));
  expect(await reopened.recovery("owner", "plan")).toBe("same release");
  expect(await reopened.list("owner")).toEqual([{...release("plan"), retry: false}]);
});

// An engine store reset can rebuild a document with the identical binding; its new queue has another head.
it("refuses a package from another queue under the identical binding, even while Try again remains", async () => {
  const file = join(await createTestScratch("dohc-unwritten-rebuilt-"), "owner-live-releases.json");
  const releases = createUnwrittenReleases(() => file);
  await releases.put(release("plan"), "first package");
  await expect(releases.put(release("plan", "rebuilt-outbox:1:digest"), "rebuilt package")).rejects.toThrow("Save a recovery copy of plan.md first.");
  expect(await createUnwrittenReleases(() => file).recovery("owner", "plan")).toBe("first package");
  expect(await createUnwrittenReleases(() => file).list("owner")).toEqual([release("plan")]);
});

it("reports a removed record as removed when its package cannot be deleted", async () => {
  const file = join(await createTestScratch("dohc-unwritten-rm-"), "owner-live-releases.json");
  const releases = createUnwrittenReleases(() => file);
  await releases.put(release("plan"), "plan package");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fs.rm.mockRejectedValueOnce(Object.assign(new Error("EBUSY: resource busy or locked, unlink"), {code: "EBUSY"}));
  try {
    await expect(releases.written("owner", "plan", binding("plan"))).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("could not remove a written live recovery package"), expect.any(Error));
    expect(await createUnwrittenReleases(() => file).list("owner")).toEqual([]);
  } finally {vi.restoreAllMocks();}
});
