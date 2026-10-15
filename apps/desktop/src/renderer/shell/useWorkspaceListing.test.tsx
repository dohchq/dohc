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
    listWorkspaceFiles.mockResolvedValueOnce({ visibility: { status: "ready", rules: [] }, files: [], cached: true });
    await act(async () => { await result.current.refreshFiles({ allowCached: true }); });
    expect(result.current.prepareRestoredTabPruning(restored, dirty)).toBeNull();
    listWorkspaceFiles.mockResolvedValueOnce({ visibility: { status: "ready", rules: [] }, files: [], folders: [] });
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
    listWorkspaceFiles.mockResolvedValueOnce({ visibility: { status: "ready", rules: [] }, files: [{ path: "a.md", kind: "file", icon: "🍎" }] });
    await act(async () => { await result.current.refreshFiles(); });
    listWorkspaceFiles.mockResolvedValueOnce({ visibility: { status: "ready", rules: [] }, files: [next] });
    await act(async () => { await result.current.refreshFiles(); });
    expect(result.current.files).toEqual([next]);
    expect(result.current.fileIndex.presentPaths.has(next.path)).toBe(true);
  });

  it("commits folder additions, ordering and removals independently of files", async () => {
    const { result } = renderHook(() => useWorkspaceListing("workspace-1"));
    const files = result.current.files;
    for (const folders of [["empty"], ["empty", "other"], ["other", "empty"], []]) {
      listWorkspaceFiles.mockResolvedValueOnce({ visibility: { status: "ready", rules: [] }, files: [], folders });
      await act(async () => { await result.current.refreshFiles(); });
      expect(result.current.folders).toEqual(folders);
      expect(result.current.files).toBe(files);
    }
  });

  it("does not let a delayed different listing replace a newer equal answer", async () => {
    const { result } = renderHook(() => useWorkspaceListing("workspace-1"));
    const snapshot: ListWorkspaceFilesResult = { visibility: { status: "ready", rules: [] }, files: [{ path: "a.md", kind: "file" }], folders: [] };
    listWorkspaceFiles.mockResolvedValueOnce(snapshot);
    await act(async () => { await result.current.refreshFiles(); });
    const stale = deferred<ListWorkspaceFilesResult>();
    listWorkspaceFiles.mockReturnValueOnce(stale.promise);
    const pending = result.current.refreshFiles();
    listWorkspaceFiles.mockResolvedValueOnce({ visibility: { status: "ready", rules: [] }, files: [{ ...snapshot.files[0] }], folders: [] });
    await act(async () => { await result.current.refreshFiles(); });
    await act(async () => {
      stale.resolve({ visibility: { status: "ready", rules: [] }, files: [{ path: "stale.md", kind: "file" }], cached: true });
      await pending;
    });
    expect(result.current.files).toBe(snapshot.files);
    expect(result.current.filesRevalidated).toBe(true);
    expect(result.current.fileListingCommit).toEqual({ request: 3, listingSource: "fresh" });
  });
});

 it("commits policy-only changes while keeping file and folder indexes", async () => {
  const { result } = renderHook(() => useWorkspaceListing("A"));
  const answer: ListWorkspaceFilesResult = { files: [{ path: "private.md", kind: "file" }], folders: [], visibility: { status: "ready", rules: [] } };
  listWorkspaceFiles.mockResolvedValueOnce(answer);
  await act(async () => { await result.current.refreshFiles(); });
  const files = result.current.files;
  const old = deferred<ListWorkspaceFilesResult>();
  listWorkspaceFiles.mockReturnValueOnce(old.promise);
  const pending = result.current.refreshFiles();
  listWorkspaceFiles.mockResolvedValueOnce({ ...answer, visibility: { status: "ready", rules: [{ path: "private.md", visibility: "hidden" }] } });
  await act(async () => { await result.current.refreshFiles(); });
  expect(result.current.visibility.rules).toEqual([{ path: "private.md", visibility: "hidden" }]);
  await act(async () => { old.resolve(answer); await pending; });
  expect(result.current.visibility.rules).toEqual([{ path: "private.md", visibility: "hidden" }]);
  expect(result.current.files).toBe(files);
 });
 it("cannot deliver A's verdicts into B, including a reused hook", async () => {
  const { result, rerender } = renderHook(({ workspaceId }) => useWorkspaceListing(workspaceId), { initialProps: { workspaceId: "A" } });
  listWorkspaceFiles.mockResolvedValueOnce({ files: [], visibility: { status: "ready", rules: [{ path: "B.md", visibility: "hidden" }] } });
  await act(async () => { await result.current.refreshFiles(); });
  const old = deferred<ListWorkspaceFilesResult>();
  listWorkspaceFiles.mockReturnValueOnce(old.promise);
  const pending = result.current.refreshFiles();
  rerender({ workspaceId: "B" });
  expect(result.current.visibility.status).toBe("unavailable");
  listWorkspaceFiles.mockResolvedValueOnce({ files: [{ path: "B.md", kind: "file" }], visibility: { status: "ready", rules: [] } });
  await act(async () => { await result.current.refreshFiles(); });
  await act(async () => { old.resolve({ files: [], visibility: { status: "ready", rules: [{ path: "B.md", visibility: "hidden" }] } }); await pending; });
  expect(result.current.files[0]?.path).toBe("B.md");
  expect(result.current.visibility.rules).toEqual([]);
 });

 it("round2 withholds a stale ready verdict after refresh failure and rejects earlier recovery", async () => {
  const { result } = renderHook(() => useWorkspaceListing("A"));
  const answer: ListWorkspaceFilesResult = { files: [{ path: "private.md", kind: "file" }], visibility: { status: "ready", rules: [] } };
  listWorkspaceFiles.mockResolvedValueOnce(answer);
  await act(async () => { await result.current.refreshFiles(); });
  const old = deferred<ListWorkspaceFilesResult>();
  listWorkspaceFiles.mockReturnValueOnce(old.promise);
  const pending = result.current.refreshFiles();
  listWorkspaceFiles.mockRejectedValueOnce(new Error("policy refresh failed"));
  await act(async () => { await expect(result.current.refreshFiles()).rejects.toThrow("policy refresh failed"); });
  expect(result.current.visibility.status).toBe("unavailable");
  await act(async () => { old.resolve(answer); await pending; });
  expect(result.current.visibility.status).toBe("unavailable");
  listWorkspaceFiles.mockResolvedValueOnce(answer);
  await act(async () => { await result.current.refreshFiles(); });
  expect(result.current.visibility.status).toBe("ready");
 });
 it("round2 settles B after the last outstanding request from A finishes", async () => {
  const { result, rerender } = renderHook(({ workspaceId }) => useWorkspaceListing(workspaceId), { initialProps: { workspaceId: "A" } });
  const old = deferred<ListWorkspaceFilesResult>();
  listWorkspaceFiles.mockReturnValueOnce(old.promise);
  const pending = result.current.refreshFiles();
  rerender({ workspaceId: "B" });
  const answer: ListWorkspaceFilesResult = { files: [], visibility: { status: "ready", rules: [] } };
  listWorkspaceFiles.mockResolvedValueOnce(answer);
  await act(async () => { await result.current.refreshFiles(); });
  const settled = result.current.listingsSettled;
  await act(async () => { old.resolve(answer); await pending; });
  expect(result.current.listingsSettled).toBe(settled + 1);
 });

 it("preserves equal rule references across repeated reads", async () => {
  const { result } = renderHook(() => useWorkspaceListing("A"));
  const answer: ListWorkspaceFilesResult = { files: [], visibility: { status: "ready", rules: [{ path: "private/**", visibility: "hidden" }] } };
  listWorkspaceFiles.mockResolvedValueOnce(answer);
  await act(async () => { await result.current.refreshFiles(); });
  const visibility = result.current.visibility;
  listWorkspaceFiles.mockResolvedValueOnce({ ...answer, visibility: { ...answer.visibility, rules: answer.visibility.rules.map(rule => ({ ...rule })) } });
  await act(async () => { await result.current.refreshFiles(); });
  expect(result.current.visibility).toBe(visibility);
 });

 it("withholds immediately after a policy event and cannot accept pre-event rules", async () => {
  const { result } = renderHook(() => useWorkspaceListing("A"));
  const answer: ListWorkspaceFilesResult = { files: [], visibility: { status: "ready", rules: [] } };
  listWorkspaceFiles.mockResolvedValueOnce(answer);
  await act(async () => { await result.current.refreshFiles(); });
  const old = deferred<ListWorkspaceFilesResult>();
  listWorkspaceFiles.mockReturnValueOnce(old.promise);
  const pending = result.current.refreshFiles();
  act(() => { result.current.invalidateVisibility(); });
  expect(result.current.visibility.status).toBe("unavailable");
  await act(async () => { old.resolve(answer); await pending; });
  expect(result.current.visibility.status).toBe("unavailable");
  listWorkspaceFiles.mockResolvedValueOnce(answer);
  await act(async () => { await result.current.refreshFiles(); });
  expect(result.current.visibility.status).toBe("ready");
 });
