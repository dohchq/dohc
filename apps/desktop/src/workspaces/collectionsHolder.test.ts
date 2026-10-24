import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitCollectionsStore,
  collectionsHolderRequired,
  collectionsKeptElsewhere,
  CollectionsRefusalError,
  createHoldingCheck,
  holderWork,
  keepCollectionsHere,
  keepQuestionWords,
  recordCollectionsStore,
  recordNewCollectionsHolder,
  type KeepSteps,
} from "./collectionsHolder";
import { createTestScratch } from "./testTemp";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {...actual, lstatSync: vi.fn(actual.lstatSync)};
});

const here = { installId: "install-here", label: "Studio" };
const laptop = { installId: "install-laptop", label: "Laptop" };
const workspaceId = "w-1";
const storeId = "5b2c6c1e-2f4a-4c1b-9d7e-0a1b2c3d4e5f";
const required = { here: () => here, required: () => true };

let root: string;
const recordPath = () => join(root, ".dohc", "collections.json");
const record = (fields: Record<string, unknown>) => writeFile(recordPath(), JSON.stringify(fields));
const named = (computer: { installId: string; label: string }, id: string | null = null) =>
  record({ version: 1, workspaceId, installId: computer.installId, label: computer.label, storeId: id });
// The store's folder in .dohc/local, or where stores were before it, which iCloud Drive syncs.
const places = { local: [".dohc", "local", "datasets"], old: [".dohc", "datasets"] } as const;
type Place = keyof typeof places;
const addStore = async (file = "state.sqlite", place: Place = "local") => {
  await mkdir(join(root, ...places[place]), { recursive: true });
  await writeFile(join(root, ...places[place], file), "");
};
const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CollectionsRefusalError);
  return error as CollectionsRefusalError;
};
const exists = (path: string) => lstat(path).then(() => true, () => false);
// Keep's steps: no store here to name, nobody else made the workspace, and the person confirms.
const steps = (overrides: Partial<KeepSteps> = {}): KeepSteps => ({
  adoptStore: vi.fn(async () => {}), storeIdHere: vi.fn(async () => null), madeBy: vi.fn(async () => null),
  confirm: vi.fn(async () => true), ...overrides,
});
const recordNow = async () => JSON.parse(await readFile(recordPath(), "utf8")) as Record<string, unknown>;

beforeEach(async () => {
  root = await createTestScratch("dohc-collections-holder-");
  await mkdir(join(root, ".dohc"));
});

describe("a workspace's Collections holder", () => {
  it("refuses a changed holder even when its file metadata did not change", async () => {
    await named(here, storeId);
    const check = createHoldingCheck(root, workspaceId, required, () => storeId);
    const metadata = lstatSync(recordPath(), {bigint: true});
    check();
    // A same-size overwrite can share all timestamps on a coarse filesystem.
    await named({installId: "install-away", label: "Studio"}, storeId);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(lstatSync).mockImplementation(((path: string, options: unknown) =>
      path === recordPath() ? metadata : actual.lstatSync(path, options as never)) as typeof lstatSync);
    try {
      expect(() => check()).toThrowError(expect.objectContaining({code: "collections-elsewhere"}));
    } finally {vi.mocked(lstatSync).mockReset();}
  });
  it("names the installation that made a new workspace, with no store yet, and keeps a record already there", async () => {
    await recordNewCollectionsHolder(root, workspaceId, here);
    expect(JSON.parse(await readFile(recordPath(), "utf8"))).toEqual({ version: 1, workspaceId, installId: "install-here", label: "Studio", storeId: null });
    expect(await admitCollectionsStore(root, workspaceId, required)).toMatchObject({ kind: "create", storeId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await recordNewCollectionsHolder(root, workspaceId, laptop);
    expect(JSON.parse(await readFile(recordPath(), "utf8")).installId).toBe("install-here");
  });

  it.each(["local", "old"] as const)("opens the store the record names, once it is there, in the %s place", async (place) => {
    await named(here, storeId);
    await addStore("state.sqlite", place);
    expect(await admitCollectionsStore(root, workspaceId, required)).toEqual({ kind: "open", storeId });
  });

  it.each(["local", "old"] as const)("blocks Collections no record names, with or without a store in the %s place, and creates nothing", async (place) => {
    for (const store of [false, true]) {
      if (store) await addStore("state.sqlite-wal", place);
      const refused = await refusal(admitCollectionsStore(root, workspaceId, required));
      expect(refused.refusal).toEqual({ kind: "unclaimed" });
      expect(refused.code).toBe("collections-unclaimed");
      expect(refused.message).toBe("dohc doesn't know which computer keeps this workspace's Collections. To keep them on this computer, choose Use this computer in dohc.");
      expect(refused.computerLabel).toBeNull();
    }
    expect(await readdir(join(root, ".dohc")), "nothing but the store this test made").toEqual([places[place][1]]);
    expect(await readdir(join(root, ...places[place]))).toEqual(["state.sqlite-wal"]);
  });

  // A copy in the old place may be another computer's that iCloud Drive has not removed yet.
  it.each(["local", "old"] as const)("blocks a store in the %s place that the record names no store for, as one a computer made before it", async (place) => {
    await named(here);
    await addStore("state.sqlite-shm", place);
    expect((await refusal(admitCollectionsStore(root, workspaceId, required))).refusal).toEqual({ kind: "unclaimed" });
  });

  it("refuses Collections another computer keeps, in words that name it, whatever is here", async () => {
    await named(laptop, storeId);
    for (const store of [false, true]) {
      if (store) await addStore();
      const refused = await refusal(admitCollectionsStore(root, workspaceId, required));
      expect(refused.code).toBe("collections-elsewhere");
      expect(refused.computerLabel).toBe("Laptop");
      expect(refused.message).toBe("These Collections are on Laptop. Open this workspace there to use them, or to move them to a server.");
    }
    await named({ installId: "install-old", label: "Studio" });
    expect((await refusal(admitCollectionsStore(root, workspaceId, required))).message)
      .toBe("These Collections are on Studio, another installation of dohc with this computer's name. Open this workspace there to use them, or to move them to a server.");
  });

  it("tells from the record alone that another computer keeps them, and nothing else", async () => {
    // Nobody keeps them yet.
    expect(await collectionsKeptElsewhere(root, workspaceId, required)).toBeNull();
    await named(laptop, storeId);
    expect(await collectionsKeptElsewhere(root, workspaceId, required)).toEqual({ kind: "elsewhere", computer: laptop, sameName: false });
    await named({ installId: "install-old", label: "Studio" });
    expect(await collectionsKeptElsewhere(root, workspaceId, required)).toEqual({ kind: "elsewhere", computer: { installId: "install-old", label: "Studio" }, sameName: true });
    // This computer keeps them, a share needs no holder, and a record dohc cannot read names nobody.
    await named(here, storeId);
    expect(await collectionsKeptElsewhere(root, workspaceId, required)).toBeNull();
    await named(laptop, storeId);
    expect(await collectionsKeptElsewhere(root, workspaceId, { here: () => here, required: () => false })).toBeNull();
    await record({ version: 2, workspaceId, installId: laptop.installId, label: laptop.label, storeId });
    expect(await collectionsKeptElsewhere(root, workspaceId, required)).toBeNull();
    await named(laptop, storeId);
    expect(await collectionsKeptElsewhere(root, "w-2", required)).toBeNull();
    expect(await readdir(join(root, ".dohc"))).toEqual(["collections.json"]);
  });

  it("refuses a store this computer keeps that is not there, without creating one", async () => {
    await named(here, storeId);
    const refused = await refusal(admitCollectionsStore(root, workspaceId, required));
    expect(refused.code).toBe("collections-missing");
    expect(refused.message).toBe("This computer keeps this workspace's Collections, but .dohc/local/datasets/state.sqlite is not there. Restore it from a backup, then try again.");
    // A -wal without its database is not the store, in either place.
    for (const place of ["local", "old"] as const) await addStore("state.sqlite-wal", place);
    expect((await refusal(admitCollectionsStore(root, workspaceId, required))).refusal).toEqual({ kind: "missing" });
    for (const place of ["local", "old"] as const) expect(await exists(join(root, ...places[place], "state.sqlite"))).toBe(false);
  });

  it("checks an open store and the holder record before each use", async () => {
    await named(here, storeId);
    let open: string | null = storeId;
    const check = createHoldingCheck(root, workspaceId, required, () => open);
    check();
    const stop = (expected: object) => { try { check(); } catch (error) { expect((error as CollectionsRefusalError).refusal).toMatchObject(expected); return; } throw new Error("Expected a refusal."); };
    open = "0b2c6c1e-2f4a-4c1b-9d7e-0a1b2c3d4e5f";
    stop({ kind: "replaced" });
    await named(here, storeId);
    stop({ kind: "replaced" });
    open = storeId;
    await named(laptop, storeId);
    stop({ kind: "elsewhere" });
    await named(here);
    stop({ kind: "unclaimed" });
    await rm(recordPath());
    stop({ kind: "unclaimed" });
    await writeFile(recordPath(), "{");
    stop({ kind: "unreadable" });
    await named(here, storeId);
    check();
    // Rewriting identical bytes remains valid even when timestamps do not change.
    await writeFile(recordPath(), await readFile(recordPath()));
    check();
    expect(() => createHoldingCheck(root, workspaceId, { here: () => here, required: () => false }, () => null)()).not.toThrow();
  });

  it.each([
    ["damaged", "{"],
    ["not an object", "[]"],
    ["a newer version", JSON.stringify({ version: 2, workspaceId, installId: "install-here", label: "Studio", storeId: null })],
    ["another workspace's", JSON.stringify({ version: 1, workspaceId: "w-2", installId: "install-here", label: "Studio", storeId: null })],
    ["one with a field dohc does not know", JSON.stringify({ version: 1, workspaceId, installId: "install-here", label: "Studio", storeId: null, server: "x" })],
    ["one with a bad store id", JSON.stringify({ version: 1, workspaceId, installId: "install-here", label: "Studio", storeId: "../state" })],
    ["one with a label that spans lines", JSON.stringify({ version: 1, workspaceId, installId: "install-here", label: "Studio\nMac", storeId: null })],
  ])("blocks a record dohc cannot read: %s", async (_case, text) => {
    await writeFile(recordPath(), text);
    await addStore();
    const refused = await refusal(admitCollectionsStore(root, workspaceId, required));
    expect(refused.code).toBe("collections-unreadable");
    expect(refused.message).toBe("dohc could not read which computer keeps this workspace's Collections. Restore .dohc/collections.json, or update dohc. Then retry.");
    // Keeping them here does not replace a record dohc cannot read.
    const kept = steps();
    await refusal(keepCollectionsHere(root, workspaceId, here, kept));
    expect(kept.adoptStore).not.toHaveBeenCalled();
    expect(await readFile(recordPath(), "utf8")).toBe(text);
  });

  it("blocks a link or a folder at the record without following it", async () => {
    const target = join(root, "elsewhere.json");
    await symlink(target, recordPath());
    const link = await refusal(admitCollectionsStore(root, workspaceId, required));
    expect(link.message).toBe("dohc could not read which computer keeps this workspace's Collections. A link is at .dohc/collections.json, which must be a file. Remove or rename that link. Then retry.");
    expect((await refusal(keepCollectionsHere(root, workspaceId, here, steps()))).message).toBe(link.message);
    await expect(recordNewCollectionsHolder(root, workspaceId, here)).rejects.toThrow("A link is at .dohc/collections.json");
    expect(await exists(target), "the link's target").toBe(false);
    await rm(recordPath());
    await mkdir(recordPath());
    expect((await refusal(admitCollectionsStore(root, workspaceId, required))).message).toContain("An item is at .dohc/collections.json, which must be a file.");
  });

  it("blocks a .dohc that is a link", async () => {
    root = await createTestScratch("dohc-collections-holder-link-");
    const outside = await createTestScratch("dohc-collections-holder-outside-");
    await symlink(outside, join(root, ".dohc"), process.platform === "win32" ? "junction" : "dir");
    expect((await refusal(admitCollectionsStore(root, workspaceId, required))).code).toBe("collections-unreadable");
  });

  it("needs a holder in every workspace of the person's own, synced through a server or not, and none in a received share", async () => {
    expect(await admitCollectionsStore(root, workspaceId, { here: () => here, required: () => false })).toEqual({ kind: "unguarded" });
    expect(collectionsHolderRequired({})).toBe(true);
    expect(collectionsHolderRequired(undefined)).toBe(true);
    // A server's sync never carries .dohc, so the record cannot travel through it.
    expect(collectionsHolderRequired({ remote: { serverUrl: "https://server.dohc.test" } } as { shareView?: unknown })).toBe(true);
    expect(collectionsHolderRequired({ pausedRemote: { serverUrl: "https://server.dohc.test" } } as { shareView?: unknown })).toBe(true);
    expect(collectionsHolderRequired({ shareView: { shareId: "s" } })).toBe(false);
  });

  it("names a new store once it is created, only while the record is still the one admission read", async () => {
    await named(here);
    const admitted = await admitCollectionsStore(root, workspaceId, required);
    if (admitted.kind !== "create") throw new Error("Expected a new store.");
    // Another computer's record arrives while the store is made.
    await named(laptop);
    const changed = await refusal(recordCollectionsStore(root, workspaceId, here, admitted.storeId, admitted.seen));
    expect(changed.message).toBe("dohc did not record which computer keeps this workspace's Collections, because .dohc/collections.json changed meanwhile. Try again.");
    expect(await recordNow()).toMatchObject({ installId: "install-laptop", storeId: null });
    await named(here);
    const again = await admitCollectionsStore(root, workspaceId, required);
    if (again.kind !== "create") throw new Error("Expected a new store.");
    await recordCollectionsStore(root, workspaceId, here, again.storeId, again.seen);
    expect((await recordNow()).storeId).toBe(again.storeId);
  });
});

it("runs claims, adoptions and new stores in one workspace one at a time, whether each succeeds or not", async () => {
  const order: string[] = [];
  let release!: () => void;
  const first = holderWork("w-queue", async () => {
    order.push("first starts");
    await new Promise<void>((resolve) => { release = resolve; });
    order.push("first fails");
    throw new Error("first");
  });
  const second = holderWork("w-queue", async () => { order.push("second"); });
  await holderWork("w-other", async () => { order.push("another workspace"); });
  release();
  await expect(first).rejects.toThrow("first");
  await second;
  expect(order).toEqual(["first starts", "another workspace", "first fails", "second"]);
});

describe("keeping the Collections on this computer", () => {
  it.each(["local", "old"] as const)("adopts a store in the %s place that no record names: the store takes a new id first, then the record names it", async (place) => {
    await addStore("state.sqlite", place);
    const order: string[] = [];
    let adopted = "";
    expect(await keepCollectionsHere(root, workspaceId, here, steps({ adoptStore: async (id) => {
      adopted = id;
      order.push(await exists(recordPath()) ? "record first" : "store first");
    } }))).toBe(true);
    expect(order).toEqual(["store first"]);
    expect(await recordNow()).toEqual({ version: 1, workspaceId, installId: "install-here", label: "Studio", storeId: adopted });
    expect(await admitCollectionsStore(root, workspaceId, required)).toEqual({ kind: "open", storeId: adopted });
  });

  it("names this computer for Collections that have no store yet, so it may create one", async () => {
    const kept = steps();
    await keepCollectionsHere(root, workspaceId, here, kept);
    expect(kept.adoptStore).not.toHaveBeenCalled();
    expect(kept.confirm).not.toHaveBeenCalled();
    expect(await admitCollectionsStore(root, workspaceId, required)).toMatchObject({ kind: "create" });
  });

  it("leaves Collections this computer keeps as they are", async () => {
    await named(here, storeId);
    await addStore();
    const kept = steps();
    expect(await keepCollectionsHere(root, workspaceId, here, kept)).toBe(true);
    expect(kept.adoptStore).not.toHaveBeenCalled();
    expect((await recordNow()).storeId).toBe(storeId);
  });

  it("adopts a store the record names this computer for but no store id, as a creation cut short leaves it", async () => {
    await named(here);
    await addStore();
    for (const madeBy of [null, here]) {
      await named(here);
      let adopted = "";
      const kept = steps({ madeBy: async () => madeBy, adoptStore: async (id) => { adopted = id; } });
      await keepCollectionsHere(root, workspaceId, here, kept);
      expect(kept.confirm, "this computer made it, or nobody says who did").not.toHaveBeenCalled();
      expect((await recordNow()).storeId).toBe(adopted);
    }
  });

  it("asks before adopting a store the record names no id for, when another computer made the workspace", async () => {
    await named(here);
    await addStore();
    const declined = steps({ madeBy: async () => laptop, confirm: vi.fn(async () => false) });
    expect(await keepCollectionsHere(root, workspaceId, here, declined)).toBe(false);
    expect(declined.confirm).toHaveBeenCalledWith({ kind: "made-elsewhere", computer: laptop });
    expect(declined.adoptStore).not.toHaveBeenCalled();
    expect((await recordNow()).storeId).toBeNull();
    let adopted = "";
    const accepted = steps({ madeBy: async () => laptop, adoptStore: async (id) => { adopted = id; } });
    expect(await keepCollectionsHere(root, workspaceId, here, accepted)).toBe(true);
    expect((await recordNow()).storeId).toBe(adopted);
  });

  it("asks first when another computer made the workspace, since its Collections may still be syncing", async () => {
    const declined = steps({ madeBy: async () => laptop, confirm: vi.fn(async () => false) });
    expect(await keepCollectionsHere(root, workspaceId, here, declined)).toBe(false);
    expect(declined.confirm).toHaveBeenCalledWith({ kind: "made-elsewhere", computer: laptop });
    expect(await exists(recordPath()), "nothing kept").toBe(false);
    expect(keepQuestionWords({ kind: "made-elsewhere", computer: laptop })).toEqual({
      message: "Use this computer for these Collections?",
      detail: "Laptop made this workspace. Its Collections may still be syncing from there. If you keep them here before they arrive, this computer can replace Laptop's Collections.",
    });
    const accepted = steps({ madeBy: async () => laptop });
    expect(await keepCollectionsHere(root, workspaceId, here, accepted)).toBe(true);
    expect(await recordNow()).toMatchObject({ installId: "install-here", storeId: null });
    // This computer made it: nothing to ask.
    await rm(recordPath());
    const own = steps({ madeBy: async () => here });
    await keepCollectionsHere(root, workspaceId, here, own);
    expect(own.confirm).not.toHaveBeenCalled();
  });

  it("refuses a record that changes while the store here takes its new id, and keeps the newer record", async () => {
    await addStore();
    const kept = steps({ adoptStore: async () => { await named(laptop, storeId); } });
    expect((await refusal(keepCollectionsHere(root, workspaceId, here, kept))).refusal).toEqual({ kind: "changed" });
    expect(await recordNow()).toMatchObject({ installId: "install-laptop", storeId });
  });

  it("refuses to write a record it read before another step named a store, so no store id is lost", async () => {
    // Keep reads no record; a new store is named before Keep writes.
    const kept = steps({ madeBy: async () => { await named(here, storeId); return null; } });
    expect((await refusal(keepCollectionsHere(root, workspaceId, here, kept))).refusal).toEqual({ kind: "changed" });
    expect((await recordNow()).storeId).toBe(storeId);
    expect(kept.adoptStore).not.toHaveBeenCalled();
  });
});

describe("keeping the Collections of an earlier installation of dohc on this computer", () => {
  it("asks, then names this installation for the store the record names, keeping its id", async () => {
    await named({ installId: "install-old", label: "Studio" }, storeId);
    await addStore();
    const kept = steps({ storeIdHere: async () => storeId });
    expect(await keepCollectionsHere(root, workspaceId, here, kept)).toBe(true);
    expect(kept.confirm).toHaveBeenCalledWith({ kind: "earlier-installation", computer: { installId: "install-old", label: "Studio" } });
    expect(kept.adoptStore).not.toHaveBeenCalled();
    expect(await recordNow()).toEqual({ version: 1, workspaceId, installId: "install-here", label: "Studio", storeId });
    expect(keepQuestionWords({ kind: "earlier-installation", computer: laptop })).toEqual({
      message: "Use this computer for these Collections?",
      detail: "Laptop keeps these Collections. If Laptop was this computer before dohc was set up again, keep them here. If Laptop is another computer that still uses them, don't, or its changes can be lost.",
    });
  });

  it("refuses when the store here is not the one the record names, or there is none, and changes nothing", async () => {
    await named(laptop, storeId);
    for (const id of [null, "0b2c6c1e-2f4a-4c1b-9d7e-0a1b2c3d4e5f"]) {
      await expect(keepCollectionsHere(root, workspaceId, here, steps({ storeIdHere: async () => id })))
        .rejects.toThrow("This computer doesn't have Laptop's copy of the Collections.");
      expect(await recordNow()).toMatchObject({ installId: "install-laptop", storeId });
    }
  });

  it("keeps a record that names no store yet only where there is no store, since no store here could match it", async () => {
    await named(laptop);
    // In either place: one in the old place may be the other computer's, which iCloud Drive has not removed yet.
    for (const place of ["old", "local"] as const) {
      await addStore("state.sqlite-shm", place);
      const withStore = steps();
      expect((await refusal(keepCollectionsHere(root, workspaceId, here, withStore))).refusal.kind).toBe("elsewhere");
      expect(withStore.confirm).not.toHaveBeenCalled();
      expect((await recordNow()).installId).toBe("install-laptop");
      await rm(join(root, ...places[place]), { recursive: true });
    }
    const declined = steps({ confirm: vi.fn(async () => false) });
    expect(await keepCollectionsHere(root, workspaceId, here, declined)).toBe(false);
    expect(declined.confirm).toHaveBeenCalledWith({ kind: "earlier-installation", computer: laptop });
    expect((await recordNow()).installId).toBe("install-laptop");
    const kept = steps();
    expect(await keepCollectionsHere(root, workspaceId, here, kept)).toBe(true);
    expect(await recordNow()).toEqual({ version: 1, workspaceId, installId: "install-here", label: "Studio", storeId: null });
    expect(kept.adoptStore).not.toHaveBeenCalled();
    expect(await admitCollectionsStore(root, workspaceId, required)).toMatchObject({ kind: "create" });
  });

  it("keeps nothing when the person does not confirm", async () => {
    await named(laptop, storeId);
    const kept = steps({ storeIdHere: vi.fn(async () => storeId), confirm: async () => false });
    expect(await keepCollectionsHere(root, workspaceId, here, kept)).toBe(false);
    expect(kept.storeIdHere).not.toHaveBeenCalled();
    expect((await recordNow()).installId).toBe("install-laptop");
  });
});
