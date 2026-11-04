import { describe, expect, it, vi } from "vitest";
import { realpathSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { CHANNELS } from "./channels";
import type { WorkspaceSummary } from "./bridgeContract";
import { createWorkspaceRootApproval, registerWorkspaceRegistryIpcHandlers } from "./workspaceRegistryIpc";
import {
  canonicalWorkspaceRoot,
  createWorkspaceFolderWithFreshness,
  type CreatedWorkspace,
} from "../workspaces/createWorkspaceFolder";
import { createForgottenShareViews } from "../workspaces/forgottenShareViews";
import { createPhysicalWorkspaceRemoval, createWorkspaceForget } from "../workspaces/physicalWorkspaceRemoval";
import { createRegistryStore, type RegistryEntry, type ShareViewIdentity } from "../workspaces/registryStore";
import { createTestScratch } from "../workspaces/testTemp";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";
import { workspaceSummariesFrom } from "../workspaces/workspaceSummaryProjection";
import { createWorkspaceTrust, folderIdentity } from "../workspaces/workspaceTrust";

type Event = { trusted: boolean };
const computer = { installId: "install-here", label: "This Mac" };
const grantedSelector = { paths: ["itinerary.md"], versionId: null, access: "edit" as const };
const receivedIdentity = { receivedSource: `share-source:v1:${"b".repeat(64)}`, grantId: "grant", generation: 3 };
const opened: ShareViewIdentity = {
  shareId: "share-1", granterUserId: "user-alex", granterEmail: "alex@example.com", sharerName: "Alex", subjectName: "Trip",
  genericChatWritable: true, grantedSelector, receivedIdentity, relayUrl: "https://relay.example.test", recipientUserId: "user-sam",
};

// What opening a share leaves in its folder: its manifest under the view's
// own id, the engine's store, and the shared files.
async function shareFolder(home: string, name: string, workspaceId: string): Promise<CreatedWorkspace> {
  const folder = join(home, name);
  await mkdir(folder);
  const { workspace } = await createWorkspaceFolderWithFreshness({ rootPath: folder, homeDir: home, computer, kind: "personal", workspaceId });
  await mkdir(join(folder, ".dohc", "engine"), { recursive: true });
  await writeFile(join(folder, ".dohc", "engine", "store.db"), "engine");
  await writeFile(join(folder, "itinerary.md"), "# Day 1\n");
  return workspace;
}

// Every file and folder under a root outside `.dohc/engine`, with each file's
// contents and modification time.
async function folderContents(root: string): Promise<Record<string, string | null>> {
  const contents: Record<string, string | null> = {};
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const path = name.split(sep).join("/");
    if (path === ".dohc/engine" || path.startsWith(".dohc/engine/")) continue;
    const full = join(root, name);
    const stats = await stat(full);
    contents[path] = stats.isDirectory() ? null : `${stats.mtimeMs} ${await readFile(full, "utf8")}`;
  }
  return contents;
}

// Open folder and Forget as main wires them: the real registry, workspace
// authority, trust and profile record, each file in its own place.
async function harness(home: string) {
  const profile = join(home, "profile");
  const profileFile = join(profile, "forgotten-share-views.json");
  const registry = createRegistryStore(join(home, "dohc-workspaces.json"));
  const findWorkspace = (workspaceId: string) => registry.find(workspaceId);
  const owner = createWorkspaceAuthorityOwner<RegistryEntry, object>({
    findWorkspace,
    canonicalizeRoot: (rootPath) => realpathSync.native(rootPath),
    createState: () => ({}),
  });
  const forgottenShareViews = createForgottenShareViews({ file: profileFile });
  const forgetWorkspace = createWorkspaceForget({
    currentBinding: (workspaceId) => owner.currentBinding(workspaceId),
    findWorkspace,
    removePhysicalWorkspace: createPhysicalWorkspaceRemoval({
      retireBinding: (binding, retirement) => owner.retireBinding(binding, retirement),
      findWorkspace,
      removeWorkspace: (workspaceId) => registry.remove(workspaceId),
      removeDrafts: async () => undefined,
      onError: () => undefined,
    }),
    trust: createWorkspaceTrust({ file: join(profile, "workspace-trust.json") }),
    forgottenShareViews,
    clearNotices: () => undefined,
    notifyRenderer: () => undefined,
  });
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  let picked = home;
  registerWorkspaceRegistryIpcHandlers<Event>({
    registerHandler: (channel, handler) => { handlers.set(channel, handler); },
    assertTrustedSender: () => undefined,
    app: { isPackaged: false },
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [picked] })) },
    roots: createWorkspaceRootApproval(() => home),
    effectiveHome: () => home,
    workspaceSummaries: () => workspaceSummariesFrom(registry.list()),
    prioritizePreferredWorkspace: (rows) => rows,
    createWorkspaceFolder: createWorkspaceFolderWithFreshness,
    thisComputer: () => computer,
    forgetWorkspace,
    showItemInFolder: () => undefined,
    openWorkspaceWindow: async () => undefined,
    openWorkspaceManager: () => undefined,
    closeWindowOf: () => undefined,
    registerPhysicalWorkspace: (workspace) => { registry.register(workspace); },
    forgottenShareViews,
    trustNewWorkspace: async () => undefined,
    refreshNativeWorkspaceSurfaces: () => undefined,
    desktopMarks: { mark: () => undefined, measureSince: () => undefined },
  });
  const invoke = (channel: string, payload?: unknown) => handlers.get(channel)!({ trusted: true }, payload);
  const openFolder = async (folder: string) => {
    picked = folder;
    const rootPath = await invoke(CHANNELS.pickWorkspaceRoot) as string;
    return await invoke(CHANNELS.attachWorkspaceFolder, { rootPath }) as WorkspaceSummary;
  };
  const forget = (workspaceId: string) => invoke(CHANNELS.forgetWorkspace, { workspaceId });
  const records = async () => {
    const text = await readFile(profileFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return '{"forgotten":[]}';
      throw error;
    });
    return (JSON.parse(text) as { forgotten: Array<Record<string, unknown>> }).forgotten;
  };
  return { registry, profileFile, openFolder, forget, records };
}

// A share view opened into a folder, then forgotten there.
async function forgottenShare(prefix: string, shareView: ShareViewIdentity = opened) {
  const home = await createTestScratch(prefix);
  const share = await shareFolder(home, "trip-from-alex", "ws-share-view");
  const h = await harness(home);
  h.registry.register({ ...share, shareView });
  return { home, share, h };
}

// What the registry holds for a share reopened from this computer's record.
const reopened = (shareView: Partial<ShareViewIdentity> = {}): ShareViewIdentity => ({
  shareId: "share-1", granterUserId: "user-alex", granterEmail: null, subjectName: null, sharerName: null,
  genericChatWritable: false, grantedSelector, receivedIdentity, relayUrl: "https://relay.example.test",
  recipientUserId: "user-sam", unsavedPaths: null, ...shareView,
});

describe("Open folder on a forgotten share's folder", () => {
  it("registers the folder as that share again, with names unknown, and removes the record", async () => {
    const { share, h } = await forgottenShare("forgotten-share-");
    await h.forget("ws-share-view");
    expect(h.registry.list()).toEqual([]);
    const [record] = await h.records();
    expect(record).toEqual({
      workspaceId: "ws-share-view", rootPath: canonicalWorkspaceRoot(share.rootPath), folder: await folderIdentity(share.rootPath),
      shareId: "share-1", recipientUserId: "user-sam", relayUrl: "https://relay.example.test", grantedSelector,
      granterUserId: "user-alex", receivedIdentity,
    });
    for (const name of ["alex@example.com", "Alex", "Trip"]) expect(JSON.stringify(record)).not.toContain(name);

    const attached = await h.openFolder(share.rootPath);
    expect(attached).toMatchObject({ workspaceId: "ws-share-view", rootPath: canonicalWorkspaceRoot(share.rootPath), kind: "personal" });
    expect(attached.shareView).toMatchObject({
      shareId: "share-1", recipientUserId: "user-sam", granterEmail: null, access: "edit", unsavedPaths: null,
    });
    expect(attached.shareView).not.toHaveProperty("sharerName");
    expect(attached.shareView).not.toHaveProperty("damaged");
    expect(h.registry.find("ws-share-view")?.shareView).toEqual(reopened());
    expect(await h.records()).toEqual([]);
  });

  it("saves the access the share has at Forget, after a narrowing", async () => {
    const { share, h } = await forgottenShare("forgotten-share-narrowed-");
    const narrowed = { ...grantedSelector, access: "view" as const };
    h.registry.setShareView("ws-share-view", { ...opened, grantedSelector: narrowed });
    await h.forget("ws-share-view");
    expect((await h.records())[0]).toMatchObject({ grantedSelector: narrowed });
    const attached = await h.openFolder(share.rootPath);
    expect(attached.shareView).toMatchObject({ access: "view" });
    expect(h.registry.find("ws-share-view")?.shareView).toEqual(reopened({ grantedSelector: narrowed }));
  });

  it("creates or changes no file in the folder outside .dohc/engine", async () => {
    const { share, h } = await forgottenShare("forgotten-share-untouched-");
    const before = await folderContents(share.rootPath);
    await h.forget("ws-share-view");
    await h.openFolder(share.rootPath);
    expect(h.registry.find("ws-share-view")?.shareView).toEqual(reopened());
    expect(await folderContents(share.rootPath)).toEqual(before);
  });

  it("refuses a second Open folder, and a second Forget saves the record again", async () => {
    const { share, h } = await forgottenShare("forgotten-share-again-");
    await h.forget("ws-share-view");
    await h.openFolder(share.rootPath);
    await expect(h.openFolder(share.rootPath)).rejects.toThrow("Folder is already attached");
    expect(h.registry.list()).toEqual([expect.objectContaining({ workspaceId: "ws-share-view", shareView: reopened() })]);
    expect(await h.records()).toEqual([]);

    await h.forget("ws-share-view");
    expect(await h.records()).toEqual([expect.objectContaining({ workspaceId: "ws-share-view", shareId: "share-1", grantedSelector })]);
    const attached = await h.openFolder(share.rootPath);
    expect(attached.shareView).toMatchObject({ shareId: "share-1", access: "edit" });
    expect(await h.records()).toEqual([]);
  });

  it.each([
    ["a copy of the folder at another path", async (root: string, home: string) => {
      const copy = join(home, "trip-copy");
      await cp(root, copy, { recursive: true });
      return { folder: copy, workspaceId: "ws-share-view" };
    }],
    ["another folder put at the same path", async (root: string, home: string) => {
      const moved = join(home, "trip-moved");
      await rename(root, moved);
      await cp(moved, root, { recursive: true });
      return { folder: root, workspaceId: "ws-share-view" };
    }],
    ["another workspace in the same folder", async (root: string, _home: string) => {
      const manifest = join(root, ".dohc", "manifest.json");
      const parsed = JSON.parse(await readFile(manifest, "utf8")) as Record<string, unknown>;
      await writeFile(manifest, JSON.stringify({ ...parsed, workspaceId: "ws-other" }));
      return { folder: root, workspaceId: "ws-other" };
    }],
  ])("opens %s as an ordinary workspace", async (_case, change) => {
    const { home, share, h } = await forgottenShare("forgotten-share-elsewhere-");
    await h.forget("ws-share-view");
    const { folder, workspaceId } = await change(share.rootPath, home);
    const attached = await h.openFolder(folder);
    expect(attached).toMatchObject({ workspaceId, rootPath: canonicalWorkspaceRoot(folder) });
    expect(attached.shareView).toBeUndefined();
    expect(h.registry.find(workspaceId)).not.toHaveProperty("shareView");
    // The record still names the folder it was saved for.
    expect(await h.records()).toEqual([expect.objectContaining({ workspaceId: "ws-share-view" })]);
  });

  it.each([
    ["is not JSON", (file: string) => writeFile(file, "{")],
    ["holds a record dohc can't read", async (file: string) => {
      const saved = JSON.parse(await readFile(file, "utf8")) as { forgotten: Array<Record<string, unknown>> };
      await writeFile(file, JSON.stringify({ forgotten: saved.forgotten.map((record) => ({ ...record, grantedSelector: { paths: [], versionId: null, access: "edit" } })) }));
    }],
    ["can't be read", async (file: string) => { await rm(file); await mkdir(file); }],
  ])("opens the folder as an ordinary workspace when the profile file %s", async (_case, damage) => {
    const { share, h } = await forgottenShare("forgotten-share-damaged-");
    await h.forget("ws-share-view");
    await damage(h.profileFile);
    const attached = await h.openFolder(share.rootPath);
    expect(attached.shareView).toBeUndefined();
    expect(h.registry.find("ws-share-view")).not.toHaveProperty("shareView");
  });

  it("registers a folder with no record as an ordinary workspace", async () => {
    const home = await createTestScratch("forgotten-share-none-");
    const folder = join(home, "notes");
    await mkdir(folder);
    await writeFile(join(folder, "todo.md"), "- pack\n");
    const h = await harness(home);
    const attached = await h.openFolder(folder);
    expect(attached.shareView).toBeUndefined();
    const [entry] = h.registry.list();
    expect(entry).toMatchObject({ rootPath: canonicalWorkspaceRoot(folder), kind: "personal", mode: "local-first" });
    expect(entry).not.toHaveProperty("shareView");
  });

  it("refuses a whole copy of the folder while the share is registered", async () => {
    const { home, share, h } = await forgottenShare("forgotten-share-whole-copy-");
    await h.forget("ws-share-view");
    const copy = join(home, "trip-copy");
    await cp(share.rootPath, copy, { recursive: true });
    await h.openFolder(share.rootPath);
    // One id names one root: the registry refuses the second root.
    await expect(h.openFolder(copy)).rejects.toThrow("carries the identity of an already attached workspace (ws-share-view)");
    expect(h.registry.list().map((entry) => entry.rootPath)).toEqual([canonicalWorkspaceRoot(share.rootPath)]);
  });
});
