import {readdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {expect, it, vi} from "vitest";
import {createUnwrittenReleases, keptEarlierRelease, recoverySnapshot} from "./ownerLiveReleases";
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
const release = (objectId: string, headDeliveryId = `${objectId}-outbox:1:digest`, snapshot = "5".repeat(64)) =>
  ({workspaceId: "owner", objectId, path: `${objectId}.md`, reason: "invalid-update", binding: binding(objectId), headDeliveryId, snapshot, retry: true});
const asideFiles = async (file: string) => (await readdir(dirname(file))).filter(name => name.startsWith("owner-live-releases.json.unreadable-"));

it("keeps a damaged record without Try again, skips an unreadable one, and sets their file aside once", async () => {
  const file = join(await createTestScratch("dohc-unwritten-rows-"), "owner-live-releases.json");
  const {reason: _reason, ...unexplained} = release("unexplained");
  const raw = JSON.stringify([release("good"), {...release("bad"), binding: {objectId: "bad"}}, {nothing: "to save"}, release("other"), {...unexplained, binding: null}]);
  await writeFile(file, raw);
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const releases = createUnwrittenReleases(() => file);
    // Three identifiers are enough to keep a record and its package. A damaged record names no edits, even when its snapshot survived.
    expect(await releases.list("owner")).toEqual([release("good"), {...release("bad"), binding: null, snapshot: null, retry: false}, release("other"),
      {...release("unexplained"), reason: "unreadable-record", binding: null, snapshot: null, retry: false}]);
    // A second start with the same content keeps no second copy.
    await createUnwrittenReleases(() => file).list("owner");
    const aside = await asideFiles(file);
    expect(aside).toHaveLength(1);
    expect(await readFile(join(dirname(file), aside[0]!), "utf8")).toBe(raw);
    await releases.written("owner", "good", {binding: binding("good"), snapshot: release("good").snapshot});
    expect((await createUnwrittenReleases(() => file).list("owner")).map(row => [row.objectId, row.retry])).toEqual([["bad", false], ["other", true], ["unexplained", false]]);
    expect(await asideFiles(file)).toHaveLength(1);
    // The damaged record ends only when its stored package has been saved.
    await releases.written("owner", "bad", {binding: binding("bad"), snapshot: release("bad").snapshot});
    await releases.remove("owner", "bad", {binding: null, headDeliveryId: release("bad").headDeliveryId, snapshot: release("bad").snapshot});
    expect((await createUnwrittenReleases(() => file).list("owner")).map(row => row.objectId)).toEqual(["bad", "other", "unexplained"]);
    await releases.remove("owner", "bad", {binding: null, headDeliveryId: release("bad").headDeliveryId, snapshot: null});
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

it("keeps a held first release across restart after a safe peer is written", async () => {
  const file = join(await createTestScratch("dohc-unwritten-held-batch-"), "owner-live-releases.json");
  const held = {...release("held"), reason: "markdown-write-held"};
  const safe = release("safe");
  const releases = createUnwrittenReleases(() => file);
  await releases.put(held, "held accepted edits and private tail");
  await releases.put(safe, "safe edits");
  await releases.written("owner", "safe", {binding: safe.binding, snapshot: safe.snapshot});

  const restarted = createUnwrittenReleases(() => file);
  expect(await restarted.list("owner")).toEqual([held]);
  expect(await restarted.recovery("owner", "held")).toBe("held accepted edits and private tail");
  expect(await restarted.recovery("owner", "safe")).toBeNull();
  await restarted.written("owner", "held", {binding: binding("held", 1), snapshot: held.snapshot});
  await restarted.written("owner", "held", {binding: held.binding, snapshot: "9".repeat(64)});
  expect(await restarted.list("owner")).toEqual([held]);

  await restarted.written("owner", "held", {binding: held.binding, snapshot: held.snapshot});
  const finished = createUnwrittenReleases(() => file);
  expect(await finished.list("owner")).toEqual([]);
  expect(await finished.recovery("owner", "held")).toBeNull();
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
  await reopened.written("owner", "plan", {binding: binding("plan", 1), snapshot: release("plan").snapshot});
  // Nor does a release of another Stop under the same binding, which took other edits or named none.
  await reopened.written("owner", "plan", {binding: binding("plan"), snapshot: "6".repeat(64)});
  await reopened.written("owner", "plan", {binding: binding("plan"), snapshot: null});
  await reopened.remove("owner", "plan", {binding: binding("plan"), headDeliveryId: "rebuilt-outbox:1:digest", snapshot: release("plan").snapshot});
  await reopened.remove("owner", "plan", {...release("plan"), snapshot: "6".repeat(64)});
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
  // The same edits put again before the release commits keep their package: a
  // later read of them may carry an older checkpoint, or none. The record follows the later put.
  await releases.put({...release("plan"), path: "renamed.md"}, "same release");
  expect(await releases.recovery("owner", "plan")).toBe("first package");
  expect((await releases.list("owner")).map(row => row.path)).toEqual(["renamed.md"]);
  await releases.put(release("plan"), "same release");
  await releases.endRetry("owner", "plan", binding("plan"));
  const reopened = createUnwrittenReleases(() => file);
  expect(await reopened.list("owner")).toEqual([{...release("plan"), retry: false}]);
  await expect(reopened.put(release("plan"), "later package")).rejects.toThrow("Save a recovery copy of plan.md first.");
  await expect(reopened.put({...release("plan"), binding: binding("plan", 1)}, "later package")).rejects.toThrow("Save a recovery copy of plan.md first.");
  // Only Save ends it: a release of the same binding that wrote the file does not.
  await reopened.written("owner", "plan", {binding: binding("plan"), snapshot: release("plan").snapshot});
  expect(await reopened.recovery("owner", "plan")).toBe("first package");
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

// Restoring an earlier engine state can repeat the binding and the head with fewer edits behind it.
it("refuses a package of other edits under the identical binding and head, and keeps the stored one", async () => {
  const file = join(await createTestScratch("dohc-unwritten-restored-"), "owner-live-releases.json");
  const releases = createUnwrittenReleases(() => file);
  const both = release("plan", undefined, "e".repeat(64)), first = release("plan", undefined, "1".repeat(64));
  await releases.put(both, "package of E1 and E2");
  await expect(releases.put(first, "package of E1")).rejects.toThrow("Save a recovery copy of plan.md first.");
  expect(keptEarlierRelease(await releases.list("owner"), first)).toEqual(both);
  // Before its queue is read, the same queue's Stop is not yet refused.
  const {snapshot: _unread, ...unread} = first;
  expect(keptEarlierRelease(await releases.list("owner"), unread)).toBeUndefined();
  const reopened = createUnwrittenReleases(() => file);
  expect(await reopened.recovery("owner", "plan")).toBe("package of E1 and E2");
  expect(await reopened.list("owner")).toEqual([both]);
  // Save's removal of a record of other edits ends nothing.
  await reopened.remove("owner", "plan", first);
  expect(await reopened.list("owner")).toEqual([both]);
  await reopened.remove("owner", "plan", both);
  expect(await reopened.list("owner")).toEqual([]);
});

it("digests a queue's refused edits, not when it was read nor what the server accepted since", async () => {
  const update = new Uint8Array([1, 2, 3]);
  const entry = (sequence: number) => ({sequence, appendKey: `e${sequence}`, deliveryId: `outbox:${sequence}:digest`, updateDigest: "d".repeat(64),
    update, byteLength: 3, createdAtMs: sequence});
  const queue = {outboxId: "outbox", binding: binding("plan"), baseUpdateDigest: "b".repeat(64), baseUpdate: update, state: "quarantined" as const,
    pendingBytes: 6, oldestEntryAtMs: 1, quarantineReason: "invalid-update", observedBinding: null, retryDeliveryId: null,
    entries: [entry(1), entry(2)], checkpoint: new Uint8Array([9]), checkpointDigest: "9".repeat(64)};
  const snapshot = recoverySnapshot(queue);
  expect(snapshot).toMatch(/^[0-9a-f]{64}$/);
  expect(recoverySnapshot({...queue, oldestEntryAtMs: 5, retryDeliveryId: "outbox:1:digest", quarantineReason: "capacity-refused"})).toBe(snapshot);
  expect(recoverySnapshot({...queue, entries: [entry(1)], pendingBytes: 3})).not.toBe(snapshot);
  expect(recoverySnapshot({...queue, baseUpdateDigest: "c".repeat(64)})).not.toBe(snapshot);
  expect(recoverySnapshot({...queue, checkpoint: new Uint8Array([8])})).toBe(snapshot);
  expect(recoverySnapshot({...queue, checkpoint: null})).toBe(snapshot);
});

it("reports a removed record as removed when its package cannot be deleted", async () => {
  const file = join(await createTestScratch("dohc-unwritten-rm-"), "owner-live-releases.json");
  const releases = createUnwrittenReleases(() => file);
  await releases.put(release("plan"), "plan package");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fs.rm.mockRejectedValueOnce(Object.assign(new Error("EBUSY: resource busy or locked, unlink"), {code: "EBUSY"}));
  try {
    await expect(releases.written("owner", "plan", {binding: binding("plan"), snapshot: release("plan").snapshot})).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("could not remove a written live recovery package"), expect.any(Error));
    expect(await createUnwrittenReleases(() => file).list("owner")).toEqual([]);
  } finally {vi.restoreAllMocks();}
});
