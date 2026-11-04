import { describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeLocalStateOpens } from "../testing/preparedLocalState";
import { parseFolderShareViewMarker, shareViewFromFolderMarker, writeFolderShareViewMarker } from "./folderShareViewMarker";
import { createTestScratch } from "./testTemp";
import { LocalStateUnavailableError } from "./workspaceLocalState";

const receivedIdentity = { receivedSource: `share-source:v1:${"c".repeat(64)}`, grantId: "grant-1", generation: 2 };
const marker = {
  workspaceId: "ws-share", shareId: "share-1", recipientUserId: "user-sam", relayUrl: "https://relay.example.test",
  grantedSelector: { paths: ["trip"], versionId: null, access: "comment" as const }, granterUserId: "user-alex", receivedIdentity,
};

async function shareFolder(prefix: string) {
  const rootPath = await createTestScratch(prefix);
  return { workspaceId: "ws-share", rootPath };
}
const markerPath = (rootPath: string) => join(rootPath, ".dohc", "local", "share-view.json");

describe("a folder's share view marker", () => {
  it("names the share, its server and account, and holds no token or names", async () => {
    const opens = fakeLocalStateOpens();
    const workspace = await shareFolder("share-marker-write-");
    await opens.open(workspace);
    await writeFolderShareViewMarker(workspace, marker);

    expect(JSON.parse(await readFile(markerPath(workspace.rootPath), "utf8"))).toEqual({ version: 1, ...marker });
    expect(await shareViewFromFolderMarker(workspace)).toEqual({
      shareId: "share-1", granterUserId: "user-alex", granterEmail: null, subjectName: null, sharerName: null,
      genericChatWritable: false, grantedSelector: marker.grantedSelector, receivedIdentity,
      relayUrl: "https://relay.example.test", recipientUserId: "user-sam", unsavedPaths: null,
    });
  });

  it("is written only after the engine opened the folder, and only once", async () => {
    const opens = fakeLocalStateOpens();
    const workspace = await shareFolder("share-marker-once-");
    await expect(writeFolderShareViewMarker(workspace, marker)).rejects.toBeInstanceOf(LocalStateUnavailableError);
    await opens.open(workspace);
    await writeFolderShareViewMarker(workspace, marker);
    await expect(writeFolderShareViewMarker(workspace, { ...marker, shareId: "share-2" })).rejects.toThrow("already holds a share's record");
    expect(JSON.parse(await readFile(markerPath(workspace.rootPath), "utf8")).shareId).toBe("share-1");
  });

  it("reads as no share view when the folder has none", async () => {
    const workspace = await shareFolder("share-marker-absent-");
    expect(await shareViewFromFolderMarker(workspace)).toBeUndefined();
    await mkdir(join(workspace.rootPath, ".dohc", "local"), { recursive: true });
    expect(await shareViewFromFolderMarker(workspace)).toBeUndefined();
  });

  it("reads as no share view when it names another workspace", async () => {
    const opens = fakeLocalStateOpens();
    const workspace = await shareFolder("share-marker-other-");
    await opens.open(workspace);
    await writeFolderShareViewMarker(workspace, { ...marker, workspaceId: "ws-elsewhere" });
    expect(await shareViewFromFolderMarker(workspace)).toBeUndefined();
  });

  it.each([
    ["not JSON", "{"],
    ["too large", JSON.stringify({ ...marker, version: 1, pad: "x".repeat(1024 * 1024) })],
    ["unreadable", JSON.stringify({ ...marker, version: 2 })],
  ])("reads as a damaged share view when it is %s", async (_case, text) => {
    const workspace = await shareFolder("share-marker-damaged-");
    await mkdir(join(workspace.rootPath, ".dohc", "local"), { recursive: true });
    await writeFile(markerPath(workspace.rootPath), text);
    expect(await shareViewFromFolderMarker(workspace)).toEqual({});
  });

  it("reads as a damaged share view when a folder stands in its place", async () => {
    const workspace = await shareFolder("share-marker-folder-");
    await mkdir(markerPath(workspace.rootPath), { recursive: true });
    expect(await shareViewFromFolderMarker(workspace)).toEqual({});
    await rm(markerPath(workspace.rootPath), { recursive: true });
    expect(await shareViewFromFolderMarker(workspace)).toBeUndefined();
  });

  it.each([
    ["an unknown version", { version: 2 }],
    ["a share id a share code can't carry", { shareId: "../share" }],
    ["no account", { recipientUserId: "" }],
    ["no server", { relayUrl: undefined }],
    ["a grant naming nothing", { grantedSelector: { paths: [], versionId: null, access: "edit" } }],
    ["an unknown access level", { grantedSelector: { paths: ["trip"], versionId: null, access: "owner" } }],
    ["an unreadable sharer id", { granterUserId: 7 }],
    ["an unreadable received identity", { receivedIdentity: { grantId: "grant-1", generation: -1 } }],
  ])("rejects a marker with %s", (_case, change) => {
    expect(parseFolderShareViewMarker({ version: 1, ...marker, ...change })).toBeNull();
  });

  it("keeps only the fields it knows", () => {
    const parsed = parseFolderShareViewMarker({
      version: 1, ...marker, token: "secret", sharerName: "Mallory", granterEmail: "mallory@example.test",
    });
    expect(parsed).toEqual({ version: 1, ...marker });
  });
});
