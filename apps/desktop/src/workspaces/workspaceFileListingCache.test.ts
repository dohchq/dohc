import { describe, expect, it, vi } from "vitest";
import type { ListWorkspaceFilesResult } from "../ipc/bridgeContract";
import { WorkspaceFileListingCache } from "./workspaceFileListingCache";
import { deferred } from "../testing/deferred";

const ATTACHMENT_A = Symbol("attachment-a");
const ATTACHMENT_B = Symbol("attachment-b");

function listing(path: string): ListWorkspaceFilesResult {
  return { files: [{ path, kind: "file" }], folders: [] };
}

function cachedListing(path: string): ListWorkspaceFilesResult {
  return { ...listing(path), cached: true };
}

describe("WorkspaceFileListingCache", () => {
  it("reuses a complete listing only when the caller permits it", async () => {
    const cache = new WorkspaceFileListingCache();
    const firstLoad = vi.fn(async () => listing("old.md"));
    const forcedLoad = vi.fn(async () => listing("new.md"));

    await expect(
      cache.list({
        workspaceId: "ws-a",
        attachmentId: ATTACHMENT_A,
        allowCached: false,
        load: firstLoad,
      }),
    ).resolves.toEqual(listing("old.md"));
    await expect(
      cache.list({
        workspaceId: "ws-a",
        attachmentId: ATTACHMENT_A,
        allowCached: true,
        load: vi.fn(async () => listing("unused.md")),
      }),
    ).resolves.toEqual(cachedListing("old.md"));
    await expect(
      cache.list({
        workspaceId: "ws-a",
        attachmentId: ATTACHMENT_A,
        allowCached: false,
        load: forcedLoad,
      }),
    ).resolves.toEqual(listing("new.md"));
    await expect(
      cache.list({
        workspaceId: "ws-a",
        attachmentId: ATTACHMENT_A,
        allowCached: true,
        load: vi.fn(async () => listing("unused-again.md")),
      }),
    ).resolves.toEqual(cachedListing("new.md"));

    expect(firstLoad).toHaveBeenCalledOnce();
    expect(forcedLoad).toHaveBeenCalledOnce();
  });

  it("does not reuse a listing after the workspace id changes physical attachments", async () => {
    const cache = new WorkspaceFileListingCache();

    await expect(
      cache.list({
        workspaceId: "ws-a",
        attachmentId: ATTACHMENT_A,
        allowCached: true,
        load: async () => listing("old-root.md"),
      }),
    ).resolves.toEqual(listing("old-root.md"));
    await expect(
      cache.list({
        workspaceId: "ws-a",
        attachmentId: ATTACHMENT_B,
        allowCached: true,
        load: async () => listing("new-root.md"),
      }),
    ).resolves.toEqual(listing("new-root.md"));
  });

  it("keeps the replacement attachment cached when the old listing rejects late", async () => {
    const cache = new WorkspaceFileListingCache();
    const old = deferred<ListWorkspaceFilesResult>();
    const replacementLoad = vi.fn(async () => listing("new-root.md"));

    const oldRead = cache.list({
      workspaceId: "ws-a",
      attachmentId: ATTACHMENT_A,
      allowCached: true,
      load: () => old.promise,
    });
    await expect(
      cache.list({
        workspaceId: "ws-a",
        attachmentId: ATTACHMENT_B,
        allowCached: true,
        load: replacementLoad,
      }),
    ).resolves.toEqual(listing("new-root.md"));

    old.reject(new Error("old attachment disappeared"));
    await expect(oldRead).rejects.toThrow("old attachment disappeared");

    const unexpectedReload = vi.fn(async () => listing("unexpected.md"));
    await expect(
      cache.list({
        workspaceId: "ws-a",
        attachmentId: ATTACHMENT_B,
        allowCached: true,
        load: unexpectedReload,
      }),
    ).resolves.toEqual(cachedListing("new-root.md"));
    expect(replacementLoad).toHaveBeenCalledOnce();
    expect(unexpectedReload).not.toHaveBeenCalled();
  });

  it("coalesces concurrent permitted reads without sharing across workspaces", async () => {
    const cache = new WorkspaceFileListingCache();
    const pending = deferred<ListWorkspaceFilesResult>();
    const loadA = vi.fn(() => pending.promise);
    const loadB = vi.fn(async () => listing("b.md"));

    const firstA = cache.list({
      workspaceId: "ws-a",
      attachmentId: ATTACHMENT_A,
      allowCached: true,
      load: loadA,
    });
    const secondA = cache.list({
      workspaceId: "ws-a",
      attachmentId: ATTACHMENT_A,
      allowCached: true,
      load: loadA,
    });
    const firstB = cache.list({
      workspaceId: "ws-b",
      attachmentId: ATTACHMENT_B,
      allowCached: true,
      load: loadB,
    });
    pending.resolve(listing("a.md"));

    await expect(firstA).resolves.toEqual(listing("a.md"));
    await expect(secondA).resolves.toEqual(listing("a.md"));
    await expect(firstB).resolves.toEqual(listing("b.md"));
    await expect(
      cache.list({
        workspaceId: "ws-a",
        attachmentId: ATTACHMENT_A,
        allowCached: true,
        load: vi.fn(async () => listing("unused.md")),
      }),
    ).resolves.toEqual(cachedListing("a.md"));
    expect(loadA).toHaveBeenCalledOnce();
    expect(loadB).toHaveBeenCalledOnce();
  });

  it("retains ignored-only activity and evicts every broad or visible scope", async () => {
    const cache = new WorkspaceFileListingCache("linux");
    const loads = new Map<string, number>();
    const read = (workspaceId: string) =>
      cache.list({
        workspaceId,
        attachmentId:
          workspaceId === "ws-a" ? ATTACHMENT_A : ATTACHMENT_B,
        allowCached: true,
        load: async () => {
          const revision = (loads.get(workspaceId) ?? 0) + 1;
          loads.set(workspaceId, revision);
          return listing(`${workspaceId}-${revision}.md`);
        },
      });

    await read("ws-a");
    await read("ws-b");
    cache.invalidate({
      workspaceId: "ws-a",
      paths: [".GIT/file.md"],
    });
    await expect(read("ws-a")).resolves.toEqual(listing("ws-a-2.md"));

    cache.invalidate({
      workspaceId: "ws-a",
      paths: [".dohc/engine/index", "pkg/node_modules/x.js"],
    });
    await expect(read("ws-a")).resolves.toEqual(cachedListing("ws-a-2.md"));

    cache.invalidate({
      workspaceId: "ws-a",
      paths: [".dohc/engine/index", "notes/new.md"],
    });
    await expect(read("ws-a")).resolves.toEqual(listing("ws-a-3.md"));
    cache.invalidate({ workspaceId: "ws-a" });
    await expect(read("ws-a")).resolves.toEqual(listing("ws-a-4.md"));
    expect(loads.get("ws-b")).toBe(1);

    cache.invalidate({});
    await expect(read("ws-a")).resolves.toEqual(listing("ws-a-5.md"));
    await expect(read("ws-b")).resolves.toEqual(listing("ws-b-2.md"));
  });

  it("does not let an invalidated in-flight listing repopulate the cache", async () => {
    const cache = new WorkspaceFileListingCache();
    const old = deferred<ListWorkspaceFilesResult>();
    const fresh = deferred<ListWorkspaceFilesResult>();

    const oldRead = cache.list({
      workspaceId: "ws-a",
      attachmentId: ATTACHMENT_A,
      allowCached: true,
      load: () => old.promise,
    });
    cache.invalidate({ workspaceId: "ws-a", paths: ["visible.md"] });
    const freshRead = cache.list({
      workspaceId: "ws-a",
      attachmentId: ATTACHMENT_A,
      allowCached: true,
      load: () => fresh.promise,
    });
    old.resolve(listing("old.md"));
    fresh.resolve(listing("fresh.md"));

    await expect(oldRead).resolves.toEqual(listing("old.md"));
    await expect(freshRead).resolves.toEqual(listing("fresh.md"));
    await expect(
      cache.list({
        workspaceId: "ws-a",
        attachmentId: ATTACHMENT_A,
        allowCached: true,
        load: vi.fn(async () => listing("stale-fill.md")),
      }),
    ).resolves.toEqual(cachedListing("fresh.md"));
  });

  it("retries after a rejected listing", async () => {
    const cache = new WorkspaceFileListingCache();
    await expect(
      cache.list({
        workspaceId: "ws-a",
        attachmentId: ATTACHMENT_A,
        allowCached: true,
        load: async () => {
          throw new Error("walk failed");
        },
      }),
    ).rejects.toThrow("walk failed");
    await expect(
      cache.list({
        workspaceId: "ws-a",
        attachmentId: ATTACHMENT_A,
        allowCached: true,
        load: async () => listing("retry.md"),
      }),
    ).resolves.toEqual(listing("retry.md"));
  });
});
