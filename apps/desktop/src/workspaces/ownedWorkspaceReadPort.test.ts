import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListWorkspaceFilesResult } from "../ipc/bridgeContract";
import { overlayCanonicalShareMountFiles } from "./shareMounts";
import type { ShareViewFilesTarget } from "./shareViewFiles";
import { createOwnedWorkspaceReadPort } from "./ownedWorkspaceReadPort";
import { listFiles } from "./workspaceFiles";
import { createTestScratch } from "./testTemp";

const WORKSPACE_ID = "workspace-owner-test";
const HEALTHY_SHARE_ID = "healthy-share";
const DAMAGED_SHARE_ID = "damaged-share";
const mounts = [
  { shareId: HEALTHY_SHARE_ID, label: "healthy" },
  { shareId: DAMAGED_SHARE_ID, label: "damaged" },
];

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function shareTarget(shareId: string): ShareViewFilesTarget {
  return { kind: "mount", workspaceId: WORKSPACE_ID, shareId };
}

function shareId(target: ShareViewFilesTarget): string {
  if (target.kind !== "mount") throw new Error("Expected a mount target");
  return target.shareId;
}

describe("createOwnedWorkspaceReadPort", () => {
  it("skips a full owner listing for an unrestricted local search", async () => {
    const listOwnedFiles = vi.fn(async () => ({ files: [] }));
    const port = createOwnedWorkspaceReadPort({
      listFiles: listOwnedFiles,
      hasShareState: false,
      searchSources: [],
      repairProjection: async () => {
        throw new Error("unused");
      },
    });

    const view = await port.prepareSearch();
    expect(view.listing).toBeNull();
    expect(view.allowPath("any/local/path.md")).toBe(true);
    expect(listOwnedFiles).not.toHaveBeenCalled();
  });

  it("lists through the owner when damaged share state has no search source", async () => {
    const listOwnedFiles = vi.fn(async () => ({
      files: [{ path: "notes/local.md", kind: "file" as const }],
      folders: ["notes"],
    }));
    const port = createOwnedWorkspaceReadPort({
      listFiles: listOwnedFiles,
      hasShareState: true,
      searchSources: [],
      repairProjection: async () => {
        throw new Error("unused");
      },
    });

    const view = await port.prepareSearch();
    expect(view.listing).toEqual({
      files: [{ path: "notes/local.md", kind: "file" }],
      folders: ["notes"],
    });
    expect(view.allowPath("notes/local.md")).toBe(true);
    expect(view.allowPath("shared-with-me/damaged/stale.md")).toBe(false);
    expect(listOwnedFiles).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary and healthy search results when another mount is damaged", async () => {
    const root = await createTestScratch("dohc-owned-search-");
    roots.push(root);
    await mkdir(join(root, "notes"), { recursive: true });
    await mkdir(join(root, "shared-with-me", "healthy"), { recursive: true });
    await mkdir(join(root, "shared-with-me", "damaged"), { recursive: true });
    await writeFile(join(root, "notes", "ordinary.md"), "ordinary needle\n");
    await writeFile(
      join(root, "shared-with-me", "damaged", "recipient-only.md"),
      "damaged needle\n",
    );

    const healthyCanonical: ListWorkspaceFilesResult = {
      files: [{ path: "missing.md", kind: "file" as const }],
      folders: [] as string[],
    };
    const listCanonical = vi.fn(async (mount: (typeof mounts)[number]) => {
      if (mount.shareId === DAMAGED_SHARE_ID) throw new Error("damaged owner");
      return healthyCanonical;
    });
    const repaired: string[] = [];
    const failures: string[] = [];
    const port = createOwnedWorkspaceReadPort({
      listFiles: async () =>
        overlayCanonicalShareMountFiles({
          disk: await listFiles(root),
          mounts,
          listCanonical,
        }),
      hasShareState: true,
      searchSources: mounts.map((mount) => ({
        target: shareTarget(mount.shareId),
        prefix: `shared-with-me/${mount.label}`,
      })),
      repairProjection: async (target) => {
        const id = shareId(target);
        repaired.push(id);
        if (id === DAMAGED_SHARE_ID) throw new Error("damaged projection");
        await writeFile(
          join(root, "shared-with-me", "healthy", "missing.md"),
          "healthy needle\n",
        );
      },
      onSearchSourceFailure: (source) => failures.push(shareId(source.target)),
    });
    const prepared = await port.prepareSearch();
    expect(prepared.listing?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "notes/ordinary.md" }),
        expect.objectContaining({ path: "shared-with-me/healthy/missing.md" }),
      ]),
    );
    expect(prepared.listing?.files).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "shared-with-me/damaged/recipient-only.md",
        }),
      ]),
    );
    expect(prepared.allowPath("shared-with-me/healthy/missing.md")).toBe(true);
    expect(prepared.allowPath("shared-with-me/damaged/recipient-only.md")).toBe(false);
    expect(repaired).toEqual([HEALTHY_SHARE_ID, DAMAGED_SHARE_ID]);
    expect(failures).toEqual([DAMAGED_SHARE_ID]);
  });

  it("classifies a missing projected canonical file as a file after repair", async () => {
    const root = await createTestScratch("dohc-owned-search-scope-");
    roots.push(root);
    const mountRoot = join(root, "shared-with-me", "healthy");
    await mkdir(mountRoot, { recursive: true });
    const mount = mounts[0]!;
    const canonical: ListWorkspaceFilesResult = {
      files: [{ path: "restored.md", kind: "file" as const }],
      folders: [] as string[],
    };
    const port = createOwnedWorkspaceReadPort({
      listFiles: async () =>
        overlayCanonicalShareMountFiles({
          disk: await listFiles(root),
          mounts: [mount],
          listCanonical: async () => canonical,
        }),
      hasShareState: true,
      searchSources: [
        {
          target: shareTarget(mount.shareId),
          prefix: "shared-with-me/healthy",
        },
      ],
      repairProjection: async () => {
        await writeFile(join(mountRoot, "restored.md"), "restored needle\n");
      },
    });

    const view = await port.prepareSearch(
      process.platform === "win32"
        ? "SHARED-WITH-ME/HEALTHY/RESTORED.MD"
        : "shared-with-me/healthy/restored.md",
    );
    // A file, so the search reads that one file rather than a folder below it.
    expect(view.includeGlob).toBe("shared-with-me/healthy/restored.md");
    expect(view.allowPath("shared-with-me/healthy/restored.md")).toBe(true);
  });
});
