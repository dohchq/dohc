import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mountRootFor, mountStoreWorkspaceIdFor } from "./shareMounts";
import {
  resolveRegisteredShareViewFilesTarget,
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
  it("distinguishes a damaged mount registry from a local-only workspace", () => {
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
    expect(
      resolveRegisteredShareViewFilesTarget(
        { workspaceId, rootPath, shareMounts: [record] },
        { kind: "mount", workspaceId, shareId: record.shareId },
      ),
    ).toMatchObject({
      kind: "mount",
      workspaceId,
      storeWorkspaceId: mountStoreWorkspaceIdFor(workspaceId, record.shareId),
      rootPath: mountRootFor(rootPath, "owner"),
      mountLabel: "owner",
    });
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
