import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { createForgottenShareViews } from "./forgottenShareViews";
import type { RegistryEntry, ShareViewIdentity } from "./registryStore";

const shareView: ShareViewIdentity = {
  shareId: "share-1", granterEmail: "alex@example.com", sharerName: "Alex", subjectName: "Trip", genericChatWritable: true,
  grantedSelector: { paths: ["itinerary.md"], versionId: null, access: "comment" },
  relayUrl: "https://relay.example.test", recipientUserId: "user-sam",
};

async function setup() {
  const scratch = await createTestScratch("forgotten-share-views-");
  const file = join(scratch, "profile", "forgotten-share-views.json");
  const rootPath = join(scratch, "trip");
  await mkdir(rootPath);
  const workspace = { workspaceId: "trip", rootPath, kind: "personal" as const, mode: "local-first" as const };
  const registered: RegistryEntry[] = [];
  const register = (entry: RegistryEntry) => { registered.push(entry); };
  const saved = async () => (JSON.parse(await readFile(file, "utf8")) as { forgotten: unknown[] }).forgotten;
  return { scratch, file, rootPath, workspace, registered, register, saved };
}

describe("forgotten share views", () => {
  it("saves nothing for a damaged share view, one without its account or server, or a folder that is gone", async () => {
    const { file, workspace, scratch } = await setup();
    const store = createForgottenShareViews({ file });
    await store.remember(workspace, { ...shareView, grantedSelector: { paths: [], versionId: null, access: "edit" } });
    await store.remember(workspace, { ...shareView, recipientUserId: undefined });
    await store.remember(workspace, { ...shareView, relayUrl: undefined });
    await store.remember({ ...workspace, rootPath: join(scratch, "gone") }, shareView);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws when the profile file can't be read or written", async () => {
    const { file, workspace } = await setup();
    await expect(createForgottenShareViews({ file, writeText: async () => { throw new Error("disk full"); } })
      .remember(workspace, shareView)).rejects.toThrow("disk full");
    await mkdir(file, { recursive: true });
    await expect(createForgottenShareViews({ file }).remember(workspace, shareView)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("replaces a file it can't parse at the next Forget", async () => {
    const { file, workspace, saved } = await setup();
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "{");
    await createForgottenShareViews({ file }).remember(workspace, shareView);
    expect(await saved()).toEqual([expect.objectContaining({ workspaceId: "trip", shareId: "share-1" })]);
  });

  it("keeps one record for a workspace and one for a folder", async () => {
    const { file, workspace, saved } = await setup();
    const store = createForgottenShareViews({ file });
    await store.remember(workspace, shareView);
    await store.remember(workspace, { ...shareView, shareId: "share-2" });
    expect(await saved()).toEqual([expect.objectContaining({ shareId: "share-2" })]);
    await store.remember({ ...workspace, workspaceId: "other" }, shareView);
    expect(await saved()).toEqual([expect.objectContaining({ workspaceId: "other" })]);
  });

  it("drops an older record when Forget saves none", async () => {
    const { file, workspace, saved } = await setup();
    const store = createForgottenShareViews({ file });
    await store.remember(workspace, shareView);
    await store.remember(workspace, { ...shareView, recipientUserId: undefined });
    expect(await saved()).toEqual([]);
  });

  it("opens an ended share ended, with the content its pulls skipped", async () => {
    const { file, workspace, register, registered } = await setup();
    const skippedOps = {
      ops: [{ originId: "origin", originSeq: 4, opKind: "write", code: "outside_grant", detail: "notes.md", atMs: 1 }],
      more: 1, counted: ["origin\u00004", "origin\u00005"], generation: 2, acknowledgedGeneration: 1,
      inexact: true, lastUncountedBatch: ["origin\u00006"],
    };
    const store = createForgottenShareViews({ file });
    await store.remember(workspace, { ...shareView, ended: true, skippedOps });
    await store.reopen(workspace, register);
    expect(registered[0]?.shareView).toMatchObject({ shareId: "share-1", ended: true, skippedOps });
  });

  it.each([{ counted: {} }, { ops: [null] }])("opens the share without its skip notice when the skip record is damaged: %o", async (damage) => {
    const { file, workspace, register, registered, saved } = await setup();
    const warn = vi.fn();
    const store = createForgottenShareViews({ file, warn });
    await store.remember(workspace, { ...shareView, skippedOps: { ops: [], more: 0, generation: 1 } });
    const [record] = await saved() as [{ skippedOps: object }];
    await writeFile(file, JSON.stringify({ version: 1, forgotten: [{ ...record, skippedOps: { ...record.skippedOps, ...damage } }] }));
    await store.reopen(workspace, register);
    expect(registered[0]?.shareView).toMatchObject({ shareId: "share-1" });
    expect(registered[0]?.shareView).not.toHaveProperty("skippedOps");
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("skipped-content record was damaged"), "trip");
  });

  it("runs Open and Forget one at a time, so an open that waits can't bring back an older record", async () => {
    const { workspace } = await setup();
    const files = new Map<string, string>();
    let hold: Promise<void> | null = null;
    let release!: () => void;
    const store = createForgottenShareViews({
      file: "forgotten.json",
      identify: async () => "folder",
      readText: async (file) => {
        const text = files.get(file);
        if (text === undefined) throw Object.assign(new Error("no file"), { code: "ENOENT" });
        const wait = hold;
        hold = null;
        await wait;
        return text;
      },
      writeText: async (file, text) => { files.set(file, text); },
    });
    const edit = { ...shareView, grantedSelector: { ...shareView.grantedSelector, access: "edit" as const } };
    await store.remember(workspace, edit);
    hold = new Promise((resolve) => { release = resolve; });
    const registered: RegistryEntry[] = [];
    const opening = store.reopen(workspace, (entry) => { registered.push(entry); });
    const forgetting = store.remember(workspace, shareView);
    // A Forget that doesn't wait for the open would finish in this turn.
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([opening, forgetting]);
    expect(registered.map((entry) => entry.shareView?.grantedSelector.access)).toEqual(["edit"]);
    expect((JSON.parse(files.get("forgotten.json")!) as { forgotten: unknown[] }).forgotten)
      .toEqual([expect.objectContaining({ grantedSelector: shareView.grantedSelector })]);
  });

  it.runIf(process.platform === "win32")("matches one folder spelled with forward slashes or backslashes", async () => {
    const { file, workspace, register, registered } = await setup();
    const store = createForgottenShareViews({ file });
    await store.remember({ ...workspace, rootPath: workspace.rootPath.replaceAll("/", "\\") }, shareView);
    await store.reopen({ ...workspace, rootPath: workspace.rootPath.replaceAll("\\", "/") }, register);
    expect(registered[0]?.shareView).toMatchObject({ shareId: "share-1" });
  });

  it("matches on id and path alone where the file system numbers no folders", async () => {
    const { file, workspace, register, registered } = await setup();
    const store = createForgottenShareViews({ file, identify: async () => null });
    await store.remember(workspace, shareView);
    await store.reopen(workspace, register);
    expect(registered[0]?.shareView).toMatchObject({ shareId: "share-1", grantedSelector: shareView.grantedSelector });
  });

  it("matches nothing when the folder can't be identified", async () => {
    const { file, workspace, register, registered } = await setup();
    await createForgottenShareViews({ file }).remember(workspace, shareView);
    const store = createForgottenShareViews({ file, identify: async () => { throw new Error("EACCES"); } });
    expect(await store.reopen(workspace, register)).toEqual(workspace);
    expect(registered).toEqual([workspace]);
  });

  it("keeps the share registered when its record can't be removed", async () => {
    const { file, workspace, register, registered, saved } = await setup();
    await createForgottenShareViews({ file }).remember(workspace, shareView);
    const warn = vi.fn();
    const store = createForgottenShareViews({ file, warn, writeText: async () => { throw new Error("disk full"); } });
    const entry = await store.reopen(workspace, register);
    expect(entry.shareView).toMatchObject({ shareId: "share-1" });
    expect(registered).toEqual([entry]);
    expect(warn).toHaveBeenCalledOnce();
    expect(await saved()).toHaveLength(1);
  });

  it("keeps the record when registering fails", async () => {
    const { file, workspace, saved } = await setup();
    const store = createForgottenShareViews({ file });
    await store.remember(workspace, shareView);
    await expect(store.reopen(workspace, () => { throw new Error("Folder is already attached"); })).rejects.toThrow("already attached");
    expect(await saved()).toHaveLength(1);
  });
});
