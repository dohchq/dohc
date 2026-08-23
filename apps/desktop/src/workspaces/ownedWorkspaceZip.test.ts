import { mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import {
  collectOwnedWorkspaceZipEntries,
  ownedZipProjectionPlan,
  type OwnedZipShareRequest,
} from "./ownedWorkspaceZip";
import { MAX_ZIP_TOTAL_BYTES } from "./workspaceFiles";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function workspaceRoot(): Promise<string> {
  const root = await createTestScratch("dohc-owned-zip-");
  roots.push(root);
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "local.md"), "local");
  await mkdir(join(root, "shared-with-me", "owner"), { recursive: true });
  await writeFile(
    join(root, "shared-with-me", "owner", "stale.md"),
    "recipient cache",
  );
  return root;
}

function canonicalShareCollector() {
  return vi.fn(async (request: OwnedZipShareRequest) => ({
    entries: [{ path: "canonical.md", data: Buffer.from("owner bytes") }],
    baseName: request.rootName,
  }));
}

describe("ownedZipProjectionPlan", () => {
  it("replaces raw projections in a whole-workspace export", () => {
    const plan = ownedZipProjectionPlan({
      kind: "workspace-root",
      archiveRoot: null,
    });

    expect(plan.keepDiskEntry("notes/local.md")).toBe(true);
    expect(plan.keepDiskEntry("shared-with-me/owner/recipient-only.md")).toBe(
      false,
    );
    expect(plan.mountArchivePrefix("owner")).toBe(
      "shared-with-me/owner",
    );
  });

  it("uses resolved workspace ownership under an aliased archive root", () => {
    const plan = ownedZipProjectionPlan({
      kind: "workspace-root",
      archiveRoot: "workspace-alias",
    });

    expect(plan.keepDiskEntry("workspace-alias/notes/local.md")).toBe(true);
    expect(
      plan.keepDiskEntry(
        "workspace-alias/shared-with-me/owner/recipient-only.md",
      ),
    ).toBe(false);
    expect(plan.mountArchivePrefix("owner")).toBe(
      "workspace-alias/shared-with-me/owner",
    );
  });

  it("replaces every raw entry when the selection aliases the projection root", () => {
    const plan = ownedZipProjectionPlan({
      kind: "projection-root",
      archiveRoot: "inbox",
    });

    expect(plan.keepDiskEntry("inbox/owner/recipient-only.md")).toBe(false);
    expect(plan.mountArchivePrefix("owner")).toBe("inbox/owner");
  });

  it("leaves a resolved local selection alone", () => {
    const plan = ownedZipProjectionPlan({ kind: "local" });

    expect(plan.includesMounts).toBe(false);
    expect(plan.keepDiskEntry("notes/local.md")).toBe(true);
    expect(plan.mountArchivePrefix("owner")).toBeNull();
  });

  it("excludes every cached projection when an empty registry tombstone remains", async () => {
    const root = await workspaceRoot();
    await truncate(
      join(root, "shared-with-me", "owner", "stale.md"),
      MAX_ZIP_TOTAL_BYTES + 1,
    );
    const collectShare = canonicalShareCollector();

    const exported = await collectOwnedWorkspaceZipEntries({
      workspace: {
        workspaceId: "host",
        rootPath: root,
        shareMounts: [],
      },
      collectShare,
    });

    expect(exported.entries.map((entry) => entry.path)).toEqual([
      "notes/local.md",
    ]);
    expect(collectShare).not.toHaveBeenCalled();
  });

  it("uses resolved ownership when an export aliases the workspace root", async () => {
    const root = await workspaceRoot();
    await symlink(root, join(root, "workspace-alias"), "dir");
    const collectShare = canonicalShareCollector();

    const exported = await collectOwnedWorkspaceZipEntries({
      workspace: {
        workspaceId: "host",
        rootPath: root,
        shareMounts: [{ shareId: "share-owner", label: "owner" }],
      },
      relativePath: "workspace-alias",
      collectShare,
    });

    expect(exported.entries.map((entry) => entry.path)).toEqual([
      "workspace-alias/notes/local.md",
      "workspace-alias/shared-with-me/owner/canonical.md",
    ]);
    expect(collectShare).toHaveBeenCalledWith({
      target: {
        kind: "mount",
        workspaceId: "host",
        shareId: "share-owner",
      },
      rootName: "owner",
    });
  });

  it("normalizes an aliased workspace-root spelling before excluding projections", async () => {
    const root = await workspaceRoot();
    await symlink(root, join(root, "workspace-alias"), "dir");
    const collectShare = canonicalShareCollector();

    const exported = await collectOwnedWorkspaceZipEntries({
      workspace: {
        workspaceId: "host",
        rootPath: root,
        shareMounts: [{ shareId: "share-owner", label: "owner" }],
      },
      relativePath: "workspace-alias/.",
      collectShare,
    });

    expect(exported.entries.map((entry) => entry.path)).toEqual([
      "workspace-alias/notes/local.md",
      "workspace-alias/shared-with-me/owner/canonical.md",
    ]);
  });

  it("never reads cached bytes through an alias to the projection root", async () => {
    const root = await workspaceRoot();
    await symlink(
      join(root, "shared-with-me"),
      join(root, "inbox"),
      "dir",
    );
    const collectShare = canonicalShareCollector();

    const exported = await collectOwnedWorkspaceZipEntries({
      workspace: {
        workspaceId: "host",
        rootPath: root,
        shareMounts: [{ shareId: "share-owner", label: "owner" }],
      },
      relativePath: "inbox",
      collectShare,
    });

    expect(exported.entries.map((entry) => entry.path)).toEqual([
      "inbox/owner/canonical.md",
    ]);
  });

  it("exports an exact mount root without inventing an empty owner path", async () => {
    const root = await workspaceRoot();
    const collectShare = canonicalShareCollector();

    await collectOwnedWorkspaceZipEntries({
      workspace: {
        workspaceId: "host",
        rootPath: root,
        shareMounts: [{ shareId: "share-owner", label: "owner" }],
      },
      relativePath: "shared-with-me/owner",
      collectShare,
    });

    expect(collectShare).toHaveBeenCalledWith({
      target: {
        kind: "mount",
        workspaceId: "host",
        shareId: "share-owner",
      },
      rootName: "owner",
    });
  });
});
