import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitCollectionsStore,
  collectionsHolderRequired,
  CollectionsRefusalError,
  heldHere,
  keepCollectionsHere,
  recordCollectionsStore,
  recordNewCollectionsHolder,
} from "./collectionsHolder";
import { createTestScratch } from "./testTemp";

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
const addStore = async (file = "state.sqlite") => {
  await mkdir(join(root, ".dohc", "datasets"), { recursive: true });
  await writeFile(join(root, ".dohc", "datasets", file), "");
};
const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CollectionsRefusalError);
  return error as CollectionsRefusalError;
};
const exists = (path: string) => lstat(path).then(() => true, () => false);

beforeEach(async () => {
  root = await createTestScratch("dohc-collections-holder-");
  await mkdir(join(root, ".dohc"));
});

describe("a workspace's Collections holder", () => {
  it("names the installation that made a new workspace, with no store yet, and keeps a record already there", async () => {
    await recordNewCollectionsHolder(root, workspaceId, here);
    expect(JSON.parse(await readFile(recordPath(), "utf8"))).toEqual({ version: 1, workspaceId, installId: "install-here", label: "Studio", storeId: null });
    expect(await admitCollectionsStore(root, workspaceId, required)).toEqual({ kind: "create", storeId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await recordNewCollectionsHolder(root, workspaceId, laptop);
    expect(JSON.parse(await readFile(recordPath(), "utf8")).installId).toBe("install-here");
  });

  it("opens the store the record names, once it is there", async () => {
    await named(here, storeId);
    await addStore();
    expect(await admitCollectionsStore(root, workspaceId, required)).toEqual({ kind: "open", storeId });
  });

  it("blocks Collections no record names, with or without a store, and creates nothing", async () => {
    for (const store of [false, true]) {
      if (store) await addStore("state.sqlite-wal");
      const refused = await refusal(admitCollectionsStore(root, workspaceId, required));
      expect(refused.refusal).toEqual({ kind: "unclaimed" });
      expect(refused.code).toBe("collections-unclaimed");
      expect(refused.message).toBe("dohc doesn't know which computer keeps this workspace's Collections. If it's this one, choose Keep the Collections on this computer.");
    }
    expect(await readdir(join(root, ".dohc")), "nothing but the store this test made").toEqual(["datasets"]);
    expect(await readdir(join(root, ".dohc", "datasets"))).toEqual(["state.sqlite-wal"]);
  });

  it("blocks a store the record names no store for, as one a computer made before it", async () => {
    await named(here);
    await addStore();
    expect((await refusal(admitCollectionsStore(root, workspaceId, required))).refusal).toEqual({ kind: "unclaimed" });
  });

  it("refuses Collections another computer keeps, in words that name it, whatever is here", async () => {
    await named(laptop, storeId);
    for (const store of [false, true]) {
      if (store) await addStore();
      const refused = await refusal(admitCollectionsStore(root, workspaceId, required));
      expect(refused.code).toBe("collections-elsewhere");
      expect(refused.message).toBe("These Collections are on Laptop. Open this workspace there to use them, or to move them to a server.");
    }
    await named({ installId: "install-old", label: "Studio" });
    expect((await refusal(admitCollectionsStore(root, workspaceId, required))).message)
      .toBe("These Collections are on Studio, another installation of dohc with this computer's name. Open this workspace there to use them, or to move them to a server.");
  });

  it("refuses a store this computer keeps that is not there, without creating one", async () => {
    await named(here, storeId);
    const refused = await refusal(admitCollectionsStore(root, workspaceId, required));
    expect(refused.code).toBe("collections-missing");
    expect(refused.message).toBe("This computer keeps this workspace's Collections, but .dohc/datasets/state.sqlite is not there. Restore it from a backup, then try again.");
    // A -wal without its database is not the store.
    await addStore("state.sqlite-wal");
    expect((await refusal(admitCollectionsStore(root, workspaceId, required))).refusal).toEqual({ kind: "missing" });
    expect(await exists(join(root, ".dohc", "datasets", "state.sqlite"))).toBe(false);
  });

  it("checks an open store against the record, so a changed record stops it", async () => {
    await named(here, storeId);
    await expect(heldHere(root, workspaceId, here, storeId)).resolves.toEqual({ computer: here, storeId });
    expect((await refusal(heldHere(root, workspaceId, here, "0b2c6c1e-2f4a-4c1b-9d7e-0a1b2c3d4e5f"))).refusal).toEqual({ kind: "replaced" });
    expect((await refusal(heldHere(root, workspaceId, here, null))).refusal).toEqual({ kind: "replaced" });
    await named(laptop, storeId);
    expect((await refusal(heldHere(root, workspaceId, here, storeId))).refusal.kind).toBe("elsewhere");
    await named(here);
    expect((await refusal(heldHere(root, workspaceId, here, storeId))).refusal, "an open store the record does not name").toEqual({ kind: "unclaimed" });
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
    const adopt = vi.fn(async () => {});
    await refusal(keepCollectionsHere(root, workspaceId, here, adopt));
    expect(adopt).not.toHaveBeenCalled();
    expect(await readFile(recordPath(), "utf8")).toBe(text);
  });

  it("blocks a link or a folder at the record without following it", async () => {
    const target = join(root, "elsewhere.json");
    await symlink(target, recordPath());
    const link = await refusal(admitCollectionsStore(root, workspaceId, required));
    expect(link.message).toBe("dohc could not read which computer keeps this workspace's Collections. A link is at .dohc/collections.json, which must be a file. Remove or rename that link. Then retry.");
    expect((await refusal(keepCollectionsHere(root, workspaceId, here, async () => {}))).message).toBe(link.message);
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

  it("needs no holder in a workspace that syncs through a server, even paused, or opened as a share", async () => {
    expect(await admitCollectionsStore(root, workspaceId, { here: () => here, required: () => false })).toEqual({ kind: "unguarded" });
    expect(collectionsHolderRequired({})).toBe(true);
    expect(collectionsHolderRequired(undefined)).toBe(true);
    expect(collectionsHolderRequired({ remote: { serverUrl: "https://server.dohc.test" } })).toBe(false);
    expect(collectionsHolderRequired({ pausedRemote: { serverUrl: "https://server.dohc.test" } })).toBe(false);
    expect(collectionsHolderRequired({ shareView: { shareId: "s" } })).toBe(false);
  });

  it("names a new store once it is created, only while the record still names this computer without one", async () => {
    await named(here);
    await recordCollectionsStore(root, workspaceId, here, storeId);
    expect(JSON.parse(await readFile(recordPath(), "utf8")).storeId).toBe(storeId);
    expect((await refusal(recordCollectionsStore(root, workspaceId, here, storeId))).refusal).toEqual({ kind: "replaced" });
    await named(laptop);
    expect((await refusal(recordCollectionsStore(root, workspaceId, here, storeId))).refusal.kind).toBe("elsewhere");
  });
});

describe("keeping the Collections on this computer", () => {
  it("adopts a store no record names: the store takes a new id first, then the record names it", async () => {
    await addStore();
    const order: string[] = [];
    let adopted = "";
    await keepCollectionsHere(root, workspaceId, here, async (id) => {
      adopted = id;
      order.push(await exists(recordPath()) ? "record first" : "store first");
    });
    expect(order).toEqual(["store first"]);
    expect(JSON.parse(await readFile(recordPath(), "utf8"))).toEqual({ version: 1, workspaceId, installId: "install-here", label: "Studio", storeId: adopted });
    expect(await admitCollectionsStore(root, workspaceId, required)).toEqual({ kind: "open", storeId: adopted });
  });

  it("names this computer for Collections that have no store yet, so it may create one", async () => {
    const adopt = vi.fn(async () => {});
    await keepCollectionsHere(root, workspaceId, here, adopt);
    expect(adopt).not.toHaveBeenCalled();
    expect(await admitCollectionsStore(root, workspaceId, required)).toMatchObject({ kind: "create" });
  });

  it("never takes Collections another computer keeps, and leaves this computer's as they are", async () => {
    await named(laptop, storeId);
    await addStore();
    const adopt = vi.fn(async () => {});
    expect((await refusal(keepCollectionsHere(root, workspaceId, here, adopt))).refusal.kind).toBe("elsewhere");
    await named(here, storeId);
    await keepCollectionsHere(root, workspaceId, here, adopt);
    expect(adopt).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(recordPath(), "utf8")).storeId).toBe(storeId);
  });

  it("adopts a store the record names this computer for but no store id, as a creation cut short leaves it", async () => {
    await named(here);
    await addStore();
    let adopted = "";
    await keepCollectionsHere(root, workspaceId, here, async (id) => { adopted = id; });
    expect(JSON.parse(await readFile(recordPath(), "utf8")).storeId).toBe(adopted);
  });
});
