import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalWorkspaceRoot, FOLDER_CHANGED } from "./createWorkspaceFolder";
import { mergeShareSkippedOps, type RegistryEntry } from "./registryStore";
import { endJoinedChannel, mergeJoinedChannel } from "./sharedChannels";
import { updateShareMountRecords, withoutShareMountRecords } from "./shareMounts";
import { readSyncHistory, recordNeverSynced } from "./syncHistory";
import { createTestScratch } from "./testTemp";
import {
  acknowledgeWorkspaceShareSkips, findWorkspace, reconcileWorkspaceRecipientShares, registerWorkspace,
  setWorkspaceRemote, setWorkspaceShareView, updateWorkspaceShareMounts, updateWorkspaceSharedChannels,
} from "./WorkspaceRegistry";

const userData = vi.hoisted(() => ({ path: "" }));
vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => userData.path } }));

const selector = { paths: ["Trip"], versionId: null, access: "view" as const };
const remote = { serverUrl: "https://server.dohc.test", ownerUserId: "u-me" };
const shareView = { shareId: "s-view", granterEmail: null, genericChatWritable: false, grantedSelector: selector };
const channel = (shareId: string) => ({
  shareId, channelWireId: `wire-${shareId}`, access: "read-write" as const, granterEmail: "ana@dohc.test",
  relayUrl: "https://relay.dohc.test", recipientUserId: "u-me",
});
const mount = (shareId: string) => ({
  shareId, label: shareId, granterEmail: "ana@dohc.test", relayUrl: "https://relay.dohc.test", grantedSelector: selector,
});
const ended = <Row>(row: Row) => ({ ...row, ended: true });

beforeAll(async () => {
  userData.path = await createTestScratch("dohc-registry-");
});

let next = 0;
// A registered workspace whose folder record says it never synced, or whose
// history cannot be written: `.dohc` is a file, or its marks' folder is.
async function workspace(
  folder: "never-synced" | "unwritable-folder" | "unwritable-record",
  received: Pick<RegistryEntry, "shareMounts" | "sharedChannels"> = {},
) {
  const rootPath = canonicalWorkspaceRoot(await createTestScratch("dohc-registry-workspace-"));
  if (folder === "unwritable-folder") await writeFile(join(rootPath, ".dohc"), "");
  else await mkdir(join(rootPath, ".dohc"));
  if (folder === "never-synced") await recordNeverSynced(rootPath, { installId: "install-here", label: "This Mac" });
  if (folder === "unwritable-record") await writeFile(join(rootPath, ".dohc", "sync-history"), "");
  const workspaceId = `w-${next++}`;
  registerWorkspace({ workspaceId, rootPath, kind: "personal", mode: "local-first", ...received });
  return { workspaceId, rootPath };
}

const endMount = (workspaceId: string, shareId: string) =>
  updateWorkspaceShareMounts(workspaceId, mounts => updateShareMountRecords(mounts, shareId, ended));

describe("the registry and the folder's sync record", () => {
  it("records a sync or opened share in the folder along with the registry", async () => {
    const synced = await workspace("never-synced");
    await setWorkspaceRemote(synced.workspaceId, remote);
    expect(findWorkspace(synced.workspaceId)?.remote).toEqual(remote);
    expect(await readSyncHistory(synced.rootPath)).toBe("synced");

    const opened = await workspace("never-synced");
    await setWorkspaceShareView(opened.workspaceId, shareView);
    expect(findWorkspace(opened.workspaceId)?.shareView).toEqual(shareView);
    expect(await readSyncHistory(opened.rootPath)).toBe("synced");
  });

  it("changes nothing in the registry when the folder cannot record the sync", async () => {
    const synced = await workspace("unwritable-folder");
    await expect(setWorkspaceRemote(synced.workspaceId, remote)).rejects.toThrow();
    expect(findWorkspace(synced.workspaceId)?.remote).toBeUndefined();

    const opened = await workspace("unwritable-folder");
    await expect(setWorkspaceShareView(opened.workspaceId, shareView)).rejects.toThrow();
    expect(findWorkspace(opened.workspaceId)?.shareView).toBeUndefined();
  });

  it("keeps no received share or chat the folder cannot record", async () => {
    const received = await workspace("unwritable-record");
    await expect(updateWorkspaceShareMounts(received.workspaceId, () => [mount("s-mount")])).rejects.toThrow();
    await expect(updateWorkspaceSharedChannels(received.workspaceId, () => [channel("s-chat")])).rejects.toThrow();
    expect(findWorkspace(received.workspaceId)?.shareMounts).toBeUndefined();
    expect(findWorkspace(received.workspaceId)?.sharedChannels).toBeUndefined();
  });

  it("stores nothing when a change refuses the set it finds after the folder records the share", async () => {
    const received = await workspace("never-synced");
    let passes = 0;
    await expect(updateWorkspaceShareMounts(received.workspaceId, mounts => {
      passes += 1;
      if (passes === 2) throw new Error("This workspace was closed. Open it again.");
      return [...mounts, mount("s-mount")];
    })).rejects.toThrow("This workspace was closed. Open it again.");
    expect(findWorkspace(received.workspaceId)?.shareMounts).toBeUndefined();
  });
});

describe("changes that wait on the folder record", () => {
  it("keeps both of two mounts ended together", async () => {
    const received = await workspace("never-synced", { shareMounts: [mount("a"), mount("b")] });
    await Promise.all([endMount(received.workspaceId, "a"), endMount(received.workspaceId, "b")]);
    expect(findWorkspace(received.workspaceId)?.shareMounts).toEqual([ended(mount("a")), ended(mount("b"))]);
  });

  it("keeps a chat joined while another is left", async () => {
    const received = await workspace("never-synced", { sharedChannels: [channel("a")] });
    const joining = updateWorkspaceSharedChannels(received.workspaceId, channels => mergeJoinedChannel(channels, channel("b")));
    const leaving = updateWorkspaceSharedChannels(received.workspaceId, channels => endJoinedChannel(channels, "a"));
    await Promise.all([joining, leaving]);
    expect(findWorkspace(received.workspaceId)?.sharedChannels).toEqual([
      { ...channel("a"), ended: true, left: true }, channel("b"),
    ]);
  });

  it("does not bring back a mount removed meanwhile", async () => {
    const received = await workspace("never-synced", { shareMounts: [mount("a")] });
    const ending = endMount(received.workspaceId, "a");
    // The last mount's removal leaves an empty set, which needs no record.
    await updateWorkspaceShareMounts(received.workspaceId, mounts => withoutShareMountRecords(mounts, "a"));
    expect(findWorkspace(received.workspaceId)?.shareMounts).toEqual([]);
    await ending;
    expect(findWorkspace(received.workspaceId)?.shareMounts).toEqual([]);
  });

  it("keeps an acknowledgement and a reconcile made meanwhile", async () => {
    const skippedOps = mergeShareSkippedOps(undefined, [{
      originId: "origin-granter", originSeq: 1, opKind: "moment.append",
      code: "share-boundary-violation", detail: "refused 1", atMs: 1000,
    }]);
    const received = await workspace("never-synced", { shareMounts: [{ ...mount("a"), skippedOps }, mount("b")] });
    const ending = endMount(received.workspaceId, "a");
    acknowledgeWorkspaceShareSkips(received.workspaceId, "a", skippedOps.generation);
    reconcileWorkspaceRecipientShares(received.workspaceId, entry => ({
      ...entry, shareMounts: entry.shareMounts!.map(row => row.shareId === "b" ? ended(row) : row),
    }));
    await ending;
    expect(findWorkspace(received.workspaceId)?.shareMounts).toEqual([
      { ...mount("a"), ended: true, skippedOps: { ...skippedOps, acknowledgedGeneration: skippedOps.generation } },
      ended(mount("b")),
    ]);
  });
});

describe("a folder reached through a link", () => {
  it("is saved only under its real path, once", async () => {
    const real = await createTestScratch("dohc-registry-real-");
    const link = join(await createTestScratch("dohc-registry-links-"), "linked");
    await symlink(real, link, process.platform === "win32" ? "junction" : "dir");
    const entry = (workspaceId: string, rootPath: string): RegistryEntry =>
      ({ workspaceId, rootPath, kind: "personal", mode: "local-first" });

    // A root that is not its own real path changed after its check: nothing is saved.
    expect(() => registerWorkspace(entry("w-linked", link))).toThrow(FOLDER_CHANGED);
    expect(findWorkspace("w-linked")).toBeNull();

    registerWorkspace(entry("w-real", canonicalWorkspaceRoot(real)));
    expect(findWorkspace("w-real")?.rootPath).toBe(canonicalWorkspaceRoot(link));
    expect(() => registerWorkspace(entry("w-again", canonicalWorkspaceRoot(link)))).toThrow("Folder is already attached");
    expect(findWorkspace("w-again")).toBeNull();
  });
});
