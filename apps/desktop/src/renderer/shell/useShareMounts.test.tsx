// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../../ipc/bridgeContract";
import { useShareMounts } from "./useShareMounts";

afterEach(cleanup);

it.each([false, true])("keeps newer mount props when an older registry reload resolves (folder left: %s)", async (folderLeft) => {
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

  act(() => result.current.onSettingsFilesChanged(folderLeft ? { folderLeftShareId: "share-1" } : undefined));
  expect(refreshWorkspaceRegistry).toHaveBeenCalledTimes(1);
  rerender({ shareMounts: [] });
  expect(result.current.mountCount).toBe(0);
  expect(onExplorerPathsChanged).toHaveBeenCalledTimes(folderLeft ? 0 : 1);

  await act(async () => { resolve(oldRegistry); await pending; });
  expect(result.current.mountCount).toBe(0);
  // A subsequent registry snapshot must not repeat the removal or consume a lost exemption.
  rerender({ shareMounts: [] });
  expect(onExplorerPathsChanged).toHaveBeenCalledTimes(folderLeft ? 0 : 1);
  expect(reportShellError).not.toHaveBeenCalled();
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
  expect(showSuccessNotice).toHaveBeenCalledWith(expect.stringContaining("Shares refreshed"), "share-refresh");
  vi.unstubAllGlobals();
});
