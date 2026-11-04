import { describe, expect, it, vi } from "vitest";
import { copyFile, cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHANNELS } from "./channels";
import type { WorkspaceSummary } from "./bridgeContract";
import { createWorkspaceRootApproval, registerWorkspaceRegistryIpcHandlers } from "./workspaceRegistryIpc";
import {
  canonicalWorkspaceRoot,
  createWorkspaceFolderWithFreshness,
  type CreatedWorkspace,
} from "../workspaces/createWorkspaceFolder";
import { shareViewFromFolderMarker, writeFolderShareViewMarker } from "../workspaces/folderShareViewMarker";
import { createRegistryStore, type ShareViewIdentity } from "../workspaces/registryStore";
import { readSyncHistory } from "../workspaces/syncHistory";
import { createTestScratch } from "../workspaces/testTemp";
import { workspaceSummariesFrom } from "../workspaces/workspaceSummaryProjection";
import { openedLocalState } from "../testing/preparedLocalState";

type Event = { trusted: boolean };
const computer = { installId: "install-here", label: "This Mac" };
const grantedSelector = { paths: ["itinerary.md"], versionId: null, access: "edit" as const };
const marker = (workspaceId: string) => ({
  workspaceId, shareId: "share-1", recipientUserId: "user-sam", relayUrl: "https://relay.example.test",
  grantedSelector, granterUserId: "user-alex",
});

// What opening a share leaves in its folder: the join's manifest under the
// view's own id, its sync mark, its marker, and the shared files.
async function openedShareFolder(home: string, name: string, workspaceId: string): Promise<CreatedWorkspace> {
  const folder = join(home, name);
  await mkdir(folder);
  const { workspace } = await createWorkspaceFolderWithFreshness({ rootPath: folder, homeDir: home, computer, kind: "personal", workspaceId });
  await openedLocalState(workspace);
  await writeFolderShareViewMarker(workspace, marker(workspaceId));
  await writeFile(join(folder, "itinerary.md"), "# Day 1\n");
  return workspace;
}

async function openFolderHarness(home: string) {
  const registry = createRegistryStore(join(home, "dohc-workspaces.json"));
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
    // Forget drops the registry row and leaves the folder alone.
    forgetWorkspace: async (workspaceId) => { registry.remove(workspaceId); },
    showItemInFolder: () => undefined,
    openWorkspaceWindow: async () => undefined,
    openWorkspaceManager: () => undefined,
    closeWindowOf: () => undefined,
    shareViewMarkerOf: shareViewFromFolderMarker,
    registerPhysicalWorkspace: (workspace) => { registry.register(workspace); },
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
  return { registry, invoke, openFolder };
}

describe("Open folder on a forgotten share's folder", () => {
  it("registers the folder as that share again, with names unknown and every file kept", async () => {
    const home = await createTestScratch("forgotten-share-");
    const share = await openedShareFolder(home, "trip-from-alex", "ws-share-view");
    expect(await readSyncHistory(share.rootPath)).toBe("synced");
    const h = await openFolderHarness(home);
    const opened: ShareViewIdentity = {
      shareId: "share-1", granterEmail: "alex@example.com", sharerName: "Alex", subjectName: "Trip",
      genericChatWritable: true, grantedSelector, relayUrl: "https://relay.example.test", recipientUserId: "user-sam",
    };
    h.registry.register({ ...share, shareView: opened });

    await h.invoke(CHANNELS.forgetWorkspace, { workspaceId: "ws-share-view" });
    expect(h.registry.list()).toEqual([]);
    const attached = await h.openFolder(share.rootPath);

    expect(attached).toMatchObject({ workspaceId: "ws-share-view", rootPath: canonicalWorkspaceRoot(share.rootPath), kind: "personal" });
    expect(attached.shareView).toMatchObject({
      shareId: "share-1", recipientUserId: "user-sam", granterEmail: null, access: "edit", unsavedPaths: null,
    });
    expect(attached.shareView).not.toHaveProperty("sharerName");
    expect(attached.shareView).not.toHaveProperty("damaged");
    expect(h.registry.find("ws-share-view")?.shareView).toEqual({
      shareId: "share-1", granterUserId: "user-alex", granterEmail: null, subjectName: null, sharerName: null,
      genericChatWritable: false, grantedSelector, relayUrl: "https://relay.example.test", recipientUserId: "user-sam",
      unsavedPaths: null,
    });
  });

  it("registers a folder with no marker as an ordinary workspace", async () => {
    const home = await createTestScratch("forgotten-share-none-");
    const folder = join(home, "notes");
    await mkdir(folder);
    await writeFile(join(folder, "todo.md"), "- pack\n");
    const h = await openFolderHarness(home);
    const attached = await h.openFolder(folder);
    expect(attached.shareView).toBeUndefined();
    const [entry] = h.registry.list();
    expect(entry).toMatchObject({ rootPath: canonicalWorkspaceRoot(folder), kind: "personal", mode: "local-first" });
    expect(entry).not.toHaveProperty("shareView");
  });

  it.each([
    ["is not JSON", "{"],
    ["is missing its account", JSON.stringify({ ...marker("ws-share-view"), recipientUserId: undefined, version: 1 })],
    ["names an unreadable grant", JSON.stringify({ ...marker("ws-share-view"), grantedSelector: { paths: [], versionId: null, access: "edit" }, version: 1 })],
  ])("registers a damaged share view when the marker %s", async (_case, text) => {
    const home = await createTestScratch("forgotten-share-damaged-");
    const share = await openedShareFolder(home, "trip-from-alex", "ws-share-view");
    await writeFile(join(share.rootPath, ".dohc", "local", "share-view.json"), text);
    const h = await openFolderHarness(home);
    const attached = await h.openFolder(share.rootPath);
    // The shell's damaged stance: read-only, no refresh.
    expect(attached.shareView).toEqual({ damaged: true, granterEmail: null });
    expect(h.registry.find("ws-share-view")?.shareView).toEqual({});
  });

  it("ignores a marker copied into another workspace's folder", async () => {
    const home = await createTestScratch("forgotten-share-copied-");
    const share = await openedShareFolder(home, "trip-from-alex", "ws-share-view");
    const other = join(home, "my-notes");
    await mkdir(other);
    const { workspace: mine } = await createWorkspaceFolderWithFreshness({ rootPath: other, homeDir: home, computer, kind: "personal" });
    await openedLocalState(mine);
    await copyFile(join(share.rootPath, ".dohc", "local", "share-view.json"), join(mine.rootPath, ".dohc", "local", "share-view.json"));
    const h = await openFolderHarness(home);
    const attached = await h.openFolder(other);
    expect(attached.workspaceId).toBe(mine.workspaceId);
    expect(attached.shareView).toBeUndefined();
    expect(h.registry.find(mine.workspaceId)).not.toHaveProperty("shareView");
  });

  it("refuses a whole copy of the folder while the share is registered", async () => {
    const home = await createTestScratch("forgotten-share-whole-copy-");
    const share = await openedShareFolder(home, "trip-from-alex", "ws-share-view");
    const copy = join(home, "trip-copy");
    await cp(share.rootPath, copy, { recursive: true });
    const h = await openFolderHarness(home);
    await h.openFolder(share.rootPath);
    // One id names one root: the registry refuses the second root.
    await expect(h.openFolder(copy)).rejects.toThrow("carries the identity of an already attached workspace (ws-share-view)");
    expect(h.registry.list().map((entry) => entry.rootPath)).toEqual([canonicalWorkspaceRoot(share.rootPath)]);
  });
});
