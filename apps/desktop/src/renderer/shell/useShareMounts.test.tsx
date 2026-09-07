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
  const showShellNotice = vi.fn();
  const { result, rerender } = renderHook(
    ({ shareMounts }) => useShareMounts(
      "ws-1", shareMounts, refreshWorkspaceRegistry, onExplorerPathsChanged,
      refreshFiles, reportShellError, showShellNotice,
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
