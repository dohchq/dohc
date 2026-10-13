// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../../ipc/bridgeContract";
import { useShareMounts } from "./useShareMounts";

afterEach(cleanup);

it("keeps newer mount props when an older registry reload resolves", async () => {
  const mounts: NonNullable<WorkspaceSummary["shareMounts"]> = [
    { shareId: "share-1", label: "alex", granterEmail: null },
  ];
  const oldRegistry: WorkspaceSummary[] = [{
    workspaceId: "ws-1", rootPath: "C:/workspace", kind: "personal", mode: "local-first", shareMounts: mounts,
  }];
  let resolve!: (registry: WorkspaceSummary[]) => void;
  const pending = new Promise<WorkspaceSummary[]>((done) => { resolve = done; });
  const refreshWorkspaceRegistry = vi.fn().mockReturnValue(pending);
  const onExplorerPathsChanged = vi.fn();
  const refreshFiles = vi.fn().mockResolvedValue(undefined);
  const reportShellError = vi.fn();
  const showSuccessNotice = vi.fn();
  const { result, rerender } = renderHook(
    ({ shareMounts }) => useShareMounts(
      "ws-1", shareMounts, refreshWorkspaceRegistry, onExplorerPathsChanged,
      refreshFiles, reportShellError, showSuccessNotice,
    ),
    { initialProps: { shareMounts: mounts } },
  );

  act(() => result.current.onMountsChanged());
  expect(refreshWorkspaceRegistry).toHaveBeenCalledTimes(1);
  rerender({ shareMounts: [] });
  expect(result.current.mountCount).toBe(0);
  expect(onExplorerPathsChanged).toHaveBeenCalledTimes(1);

  await act(async () => { resolve(oldRegistry); await pending; });
  expect(result.current.mountCount).toBe(0);
  // A subsequent registry snapshot must not repeat the removal.
  rerender({ shareMounts: [] });
  expect(onExplorerPathsChanged).toHaveBeenCalledTimes(1);
  expect(reportShellError).not.toHaveBeenCalled();
});

// A failed Remove keeps Try again in Notices, and Try again removes it.
it("reports a failed unmount with Try again", async () => {
  const unmountShare = vi.fn()
    .mockRejectedValueOnce(new Error("disk busy"))
    .mockResolvedValueOnce({ folderLeft: false });
  vi.stubGlobal("dohcDesktop", { unmountShare });
  const reportShellError = vi.fn();
  const showSuccessNotice = vi.fn();
  const mounts = [{ shareId: "share-1", label: "alex", granterEmail: null }];
  const { result } = renderHook(() => useShareMounts(
    "ws-1", mounts, vi.fn().mockResolvedValue([]), vi.fn(),
    vi.fn().mockResolvedValue(undefined), reportShellError, showSuccessNotice,
  ));

  await act(async () => { await result.current.unmountShare("shared-with-me/alex"); });
  expect(reportShellError).toHaveBeenCalledWith("Couldn't remove the share.", expect.any(Error), expect.any(Function));
  const retry = reportShellError.mock.calls[0]![2] as () => void;
  await act(async () => { retry(); });
  await vi.waitFor(() => expect(showSuccessNotice).toHaveBeenCalledWith("Removed alex from this workspace."));
  expect(unmountShare).toHaveBeenNthCalledWith(2, { workspaceId: "ws-1", shareId: "share-1" });
  vi.unstubAllGlobals();
});

// Each announced refresh's summary replaces the last one's row: a clean
// refresh clears an earlier failure, and repeated refreshes keep one row.
it("reports every announced share refresh under one kind", async () => {
  const refresh = vi.fn()
    .mockResolvedValueOnce({ results: [{ label: "alex", status: "damaged", changedPaths: 0 }] })
    .mockResolvedValueOnce({ results: [{ label: "alex", status: "unchanged", changedPaths: 0 }] })
    .mockRejectedValueOnce(new Error("relay down"));
  vi.stubGlobal("dohcDesktop", { refreshShareMounts: refresh });
  const reportShellError = vi.fn();
  const showSuccessNotice = vi.fn();
  const { result } = renderHook(() => useShareMounts(
    "ws-1", [{ shareId: "share-1", label: "alex", granterEmail: null }], vi.fn().mockResolvedValue([]), vi.fn(),
    vi.fn().mockResolvedValue(undefined), reportShellError, showSuccessNotice,
  ));

  await act(async () => { await result.current.refreshShareMounts(true); });
  await act(async () => { await result.current.refreshShareMounts(true); });
  await act(async () => { await result.current.refreshShareMounts(true); });

  expect(reportShellError.mock.calls.map((call) => call[3])).toEqual(["share-refresh", "share-refresh"]);
  expect(showSuccessNotice).toHaveBeenCalledWith(expect.stringContaining("Shares refreshed"), undefined, "share-refresh");
  vi.unstubAllGlobals();
});

// A refresh that finishes after a newer one must not replace the newer
// one's row: here the older success would erase the newer failure.
it("lets only the newest announced refresh write its summary", async () => {
  let finishFiles!: () => void;
  const filesListed = new Promise<void>((done) => { finishFiles = done; });
  const refresh = vi.fn()
    .mockResolvedValueOnce({ results: [{ label: "alex", status: "updated", changedPaths: 1 }] })
    .mockRejectedValueOnce(new Error("relay down"));
  vi.stubGlobal("dohcDesktop", { refreshShareMounts: refresh });
  const reportShellError = vi.fn();
  const showSuccessNotice = vi.fn();
  const refreshFiles = vi.fn().mockReturnValueOnce(filesListed).mockResolvedValue(undefined);
  // Stable arguments: a new mounts array each render would re-commit forever.
  const mounts = [{ shareId: "share-1", label: "alex", granterEmail: null }];
  const refreshRegistry = vi.fn().mockResolvedValue([]);
  const onPathsChanged = vi.fn();
  const { result } = renderHook(() => useShareMounts(
    "ws-1", mounts, refreshRegistry, onPathsChanged, refreshFiles, reportShellError, showSuccessNotice,
  ));

  let older!: Promise<void>;
  act(() => { older = result.current.refreshShareMounts(true); });
  await vi.waitFor(() => expect(refreshFiles).toHaveBeenCalledTimes(1));
  await act(async () => { await result.current.refreshShareMounts(true); });
  expect(reportShellError).toHaveBeenCalledWith("Couldn't refresh shares.", expect.any(Error), null, "share-refresh");

  await act(async () => { finishFiles(); await older; });
  expect(showSuccessNotice).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
