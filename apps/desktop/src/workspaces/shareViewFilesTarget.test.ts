import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mountRootFor, mountStoreWorkspaceIdFor } from "./shareMounts";
import {
  resolveRegisteredShareViewFilesTarget,
  shareMountRegistryIsPresent,
  storedShareMounts,
  workspaceHasReceivedShareState,
} from "./shareViewFilesTarget";
import type { ShareMountRecord } from "./registryStore";

const workspaceId = "workspace-target-test";
const rootPath = join("workspace", "root");

function mount(label: string, shareId = "share-target-test"): ShareMountRecord {
  return {
    shareId,
    label,
    granterEmail: "owner@example.com",
    relayUrl: "https://relay.example.com",
    grantedSelector: { access: "view", paths: [], versionId: null },
  };
}

describe("resolveRegisteredShareViewFilesTarget", () => {
  it("reads prior display paths without letting damaged display data affect protection", () => {
    for (const snapshot of [{ paths: ["docs/local.yaml"], unchecked: true, checked: 1 }, { paths: null }]) {
      const resolved = resolveRegisteredShareViewFilesTarget({ workspaceId, rootPath,
        shareView: { shareId: "share", granterEmail: null, ended: false,
          grantedSelector: { access: "view", paths: ["docs"], versionId: null },
          unsavedPaths: ["docs/locked.md"], unconfirmedChanges: snapshot } }, { kind: "standalone", workspaceId });
      expect(resolved?.unsavedPaths).toEqual(["docs/locked.md"]);
      expect(resolved?.unconfirmedChanges).toEqual(snapshot.paths === null ? undefined : snapshot);
    }
  });
  it("distinguishes a damaged mount registry from a local-only workspace", () => {
    expect(shareMountRegistryIsPresent({})).toBe(false);
    expect(shareMountRegistryIsPresent({ shareMounts: [] })).toBe(true);
    expect(workspaceHasReceivedShareState({})).toBe(false);
    expect(workspaceHasReceivedShareState({ shareMounts: [] })).toBe(true);
    expect(
      workspaceHasReceivedShareState({
        shareMounts: [{ shareId: "damaged", label: null } as never],
      }),
    ).toBe(true);
    expect(workspaceHasReceivedShareState({ shareMounts: {} })).toBe(true);
    expect(storedShareMounts({ shareMounts: {} })).toEqual([]);
  });

  it("resolves a valid mount to its own store and projected root", () => {
    const record = mount("owner");
    const resolved = resolveRegisteredShareViewFilesTarget(
      { workspaceId, rootPath, shareMounts: [record] },
      { kind: "mount", workspaceId, shareId: record.shareId },
    );
    expect(resolved).toMatchObject({
      kind: "mount",
      workspaceId,
      storeWorkspaceId: mountStoreWorkspaceIdFor(workspaceId, record.shareId),
      rootPath: mountRootFor(rootPath, "owner"),
      mountLabel: "owner",
    });
    expect(resolve(resolved!.rootPath)).not.toBe(
      resolve(resolved!.schedulingRootPath),
    );
  });

  // The engine keys a standalone view's open by its attachment, and that open
  // is what lets the view write its refresh records in `.dohc/local`.
  it("carries a standalone view's attachment, and none for a mount's own store", () => {
    const attachmentId = Symbol("attached view");
    const record = mount("owner");
    const shareView = { shareId: "share", granterEmail: null, ended: false,
      grantedSelector: { access: "view", paths: ["docs"], versionId: null } };
    expect(resolveRegisteredShareViewFilesTarget({ workspaceId, rootPath, attachmentId, shareView },
      { kind: "standalone", workspaceId })?.attachmentId).toBe(attachmentId);
    expect(resolveRegisteredShareViewFilesTarget({ workspaceId, rootPath, attachmentId, shareMounts: [record] },
      { kind: "mount", workspaceId, shareId: record.shareId })).not.toHaveProperty("attachmentId");
  });

  it("refuses an invalid mount label instead of falling back to the host root", () => {
    const record = mount(".env");
    expect(
      resolveRegisteredShareViewFilesTarget(
        { workspaceId, rootPath, shareMounts: [record] },
        { kind: "mount", workspaceId, shareId: record.shareId },
      ),
    ).toBeNull();
  });

  it("refuses a mount whose stored share id cannot name an owner", () => {
    const record = mount("owner", "");
    expect(
      resolveRegisteredShareViewFilesTarget(
        { workspaceId, rootPath, shareMounts: [record] },
        { kind: "mount", workspaceId, shareId: record.shareId },
      ),
    ).toBeNull();
  });

  it("refuses duplicate records for one share id", () => {
    expect(
      resolveRegisteredShareViewFilesTarget(
        {
          workspaceId,
          rootPath,
          shareMounts: [mount("owner"), mount("owner-2")],
        },
        { kind: "mount", workspaceId, shareId: "share-target-test" },
      ),
    ).toBeNull();
  });

  it("refuses different shares that claim the same projected folder", () => {
    const first = mount("owner", "share-one");
    const second = mount("owner", "share-two");
    expect(
      resolveRegisteredShareViewFilesTarget(
        { workspaceId, rootPath, shareMounts: [first, second] },
        { kind: "mount", workspaceId, shareId: first.shareId },
      ),
    ).toBeNull();
  });
});
