// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge, ListWorkspaceFilesResult } from "../../ipc/bridgeContract";
import { defaultWorkbenchState, openTab } from "../workbench/workbenchState";
import { useWorkspaceListing } from "./useWorkspaceListing";

let previousBridge: DohcDesktopBridge | undefined;
const listWorkspaceFiles = vi.fn<() => Promise<ListWorkspaceFilesResult>>();

beforeEach(() => {
  previousBridge = window.dohcDesktop;
  window.dohcDesktop = { listWorkspaceFiles } as unknown as DohcDesktopBridge;
});

afterEach(() => {
  cleanup();
  window.dohcDesktop = previousBridge;
  vi.resetAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("workspace listing revalidation", () => {
  it("lets an equal fresh empty listing reconcile restored tabs", async () => {
    const { result } = renderHook(() => useWorkspaceListing("workspace-1"));
    const files = result.current.files;
    const folders = result.current.folders;
    const restored = new Set(["gone.md"]);
    const dirty = new Set<string>();
    listWorkspaceFiles.mockResolvedValueOnce({ files: [], cached: true });
    await act(async () => { await result.current.refreshFiles({ allowCached: true }); });
    expect(result.current.prepareRestoredTabPruning(restored, dirty)).toBeNull();
    listWorkspaceFiles.mockResolvedValueOnce({ files: [], folders: [] });
    await act(async () => { await result.current.refreshFiles(); });
    expect(result.current.files).toBe(files);
    expect(result.current.folders).toBe(folders);
    const prune = result.current.prepareRestoredTabPruning(restored, dirty);
    expect(prune).not.toBeNull();
    const state = openTab(defaultWorkbenchState(), "gone.md");
    expect(prune!(state)).not.toEqual(state);
  });

  it.each([
    { path: "renamed.md", kind: "file" as const, icon: "🍎" },
    { path: "a.md", kind: "database" as const, icon: "🍎" },
    { path: "a.md", kind: "file" as const, icon: "🍊" },
    { path: "a.md", kind: "file" as const },
  ])("commits changed file metadata: %j", async (next) => {
    const { result } = renderHook(() => useWorkspaceListing("workspace-1"));
    listWorkspaceFiles.mockResolvedValueOnce({ files: [{ path: "a.md", kind: "file", icon: "🍎" }] });
    await act(async () => { await result.current.refreshFiles(); });
    listWorkspaceFiles.mockResolvedValueOnce({ files: [next] });
    await act(async () => { await result.current.refreshFiles(); });
    expect(result.current.files).toEqual([next]);
    expect(result.current.fileIndex.presentPaths.has(next.path)).toBe(true);
  });

  it("commits folder additions, ordering and removals independently of files", async () => {
    const { result } = renderHook(() => useWorkspaceListing("workspace-1"));
    const files = result.current.files;
    for (const folders of [["empty"], ["empty", "other"], ["other", "empty"], []]) {
      listWorkspaceFiles.mockResolvedValueOnce({ files: [], folders });
      await act(async () => { await result.current.refreshFiles(); });
      expect(result.current.folders).toEqual(folders);
      expect(result.current.files).toBe(files);
    }
  });

  it("does not let a delayed different listing replace a newer equal answer", async () => {
    const { result } = renderHook(() => useWorkspaceListing("workspace-1"));
    const snapshot: ListWorkspaceFilesResult = { files: [{ path: "a.md", kind: "file" }], folders: [] };
    listWorkspaceFiles.mockResolvedValueOnce(snapshot);
    await act(async () => { await result.current.refreshFiles(); });
    const stale = deferred<ListWorkspaceFilesResult>();
    listWorkspaceFiles.mockReturnValueOnce(stale.promise);
    const pending = result.current.refreshFiles();
    listWorkspaceFiles.mockResolvedValueOnce({ files: [{ ...snapshot.files[0] }], folders: [] });
    await act(async () => { await result.current.refreshFiles(); });
    await act(async () => {
      stale.resolve({ files: [{ path: "stale.md", kind: "file" }], cached: true });
      await pending;
    });
    expect(result.current.files).toBe(snapshot.files);
    expect(result.current.filesRevalidated).toBe(true);
    expect(result.current.fileListingCommit).toEqual({ request: 3, listingSource: "fresh" });
  });
});
