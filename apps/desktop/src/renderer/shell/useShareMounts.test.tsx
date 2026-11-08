// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../../ipc/bridgeContract";
import { useShareMounts } from "./useShareMounts";
import { shareUnjournalableNotice } from "../shareUnjournalableNotice";

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
  const reportShellFailure = vi.fn();
  const clearIdentity = vi.fn();
  const { result, rerender } = renderHook(
    ({ shareMounts }) => useShareMounts(
      "ws-1", shareMounts, refreshWorkspaceRegistry, onExplorerPathsChanged,
      refreshFiles, reportShellError, showSuccessNotice, reportShellFailure, clearIdentity, vi.fn(),
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
    vi.fn().mockResolvedValue(undefined), reportShellError, showSuccessNotice, vi.fn(), vi.fn(), vi.fn(),
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
    vi.fn().mockResolvedValue(undefined), reportShellError, showSuccessNotice, vi.fn(), vi.fn(), vi.fn(),
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
  const reportShellFailure = vi.fn();
  const clearIdentity = vi.fn();
  const { result } = renderHook(() => useShareMounts(
    "ws-1", mounts, refreshRegistry, onPathsChanged, refreshFiles, reportShellError, showSuccessNotice,
    reportShellFailure, clearIdentity, vi.fn(),
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

const REFUSAL_WORDS =
  "dohc did not update alex because it could not read " +
  "shared-with-me/alex/.dohc/local/share-refresh/share-collision-record.json. " +
  "It keeps a refresh from replacing your own files.";

function mountRows() {
  const reportShellError = vi.fn();
  const showSuccessNotice = vi.fn();
  const reportShellFailure = vi.fn();
  const clearIdentity = vi.fn();
  const clearKind = vi.fn();
  const mounts = [
    { shareId: "share-1", label: "alex", granterEmail: null },
    { shareId: "share-2", label: "kim", granterEmail: null },
  ];
  const registry = vi.fn().mockResolvedValue([]);
  const onPathsChanged = vi.fn();
  const refreshFiles = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(
    ({ shareMounts }) => useShareMounts(
      "ws-1", shareMounts, registry, onPathsChanged, refreshFiles, reportShellError, showSuccessNotice,
      reportShellFailure, clearIdentity, clearKind,
    ),
    { initialProps: { shareMounts: mounts } },
  );
  return { ...hook, reportShellError, showSuccessNotice, reportShellFailure, clearIdentity, clearKind };
}

const refused = { shareId: "share-1", label: "alex", status: "failed", changedPaths: 0, errorKind: "collision-record" };
const kimUpdated = { shareId: "share-2", label: "kim", status: "updated", changedPaths: 1 };

// The record keeps the person's own files apart while dohc can't read it, so
// the row has no × and ends only when that share's refresh completes.
it("keeps a share's collision-record refusal in Notices until that share refreshes", async () => {
  const refresh = vi.fn()
    .mockResolvedValueOnce({ results: [refused, kimUpdated] })
    .mockResolvedValueOnce({ results: [refused, kimUpdated] })
    .mockResolvedValue({ results: [{ ...refused, status: "unchanged", errorKind: undefined }, kimUpdated] });
  vi.stubGlobal("dohcDesktop", { refreshShareMounts: refresh });
  const { result, reportShellError, reportShellFailure, clearIdentity, clearKind } = mountRows();

  // A refresh the person starts toasts the refused share's row every time.
  // One share refreshed, so the summary says so beside it.
  await act(async () => { await result.current.refreshShareMounts(true); });
  expect(reportShellFailure).toHaveBeenCalledOnce();
  expect(reportShellFailure).toHaveBeenCalledWith({
    message: REFUSAL_WORDS,
    retry: expect.any(Function),
    noDismiss: true,
    kind: "share-collision-record",
    identity: "share-mount-collision-record:share-1",
  });
  expect(clearIdentity).not.toHaveBeenCalledWith("share-mount-collision-record:share-1");
  expect(reportShellError).toHaveBeenCalledWith(
    "Refreshed 1 of 2 shares. 1 file updated.", null, expect.any(Function), "share-refresh",
  );
  expect(clearKind).not.toHaveBeenCalled();

  // A polled refusal of the same share updates its row without a new toast.
  await act(async () => { await result.current.refreshShareMounts(); });
  expect(reportShellFailure).toHaveBeenCalledTimes(2);
  expect(reportShellFailure.mock.calls[1]![0]).toMatchObject({ message: REFUSAL_WORDS, repeat: true });
  expect(reportShellError).toHaveBeenCalledOnce();

  // Try again refreshes as the person asked, and the completed refresh ends the row.
  const retry = reportShellFailure.mock.calls[0]![0].retry as () => void;
  await act(async () => { retry(); });
  await vi.waitFor(() => expect(clearIdentity).toHaveBeenCalledWith("share-mount-collision-record:share-1"));
  expect(refresh).toHaveBeenCalledTimes(3);
  expect(reportShellFailure).toHaveBeenCalledTimes(2);
  vi.unstubAllGlobals();
});

const kimRefused = { ...refused, shareId: "share-2", label: "kim" };

// Each refused share's row is the toast, so a summary would only repeat it.
// The row an earlier refresh's summary left ends.
it.each([
  { name: "one share", results: [refused] },
  { name: "two shares", results: [refused, kimRefused] },
])("answers a refresh the person starts with only the rows of $name it refused", async ({ results }) => {
  vi.stubGlobal("dohcDesktop", { refreshShareMounts: vi.fn().mockResolvedValue({ results }) });
  const { result, reportShellError, showSuccessNotice, reportShellFailure, clearKind } = mountRows();

  await act(async () => { await result.current.refreshShareMounts(true); });
  expect(reportShellFailure.mock.calls.map(([row]) => row)).toEqual(results.map((row) => ({
    message: expect.stringContaining(`dohc did not update ${row.label} because`),
    retry: expect.any(Function),
    noDismiss: true,
    kind: "share-collision-record",
    identity: `share-mount-collision-record:${row.shareId}`,
  })));
  expect(reportShellError).not.toHaveBeenCalled();
  expect(showSuccessNotice).not.toHaveBeenCalled();
  expect(clearKind).toHaveBeenCalledWith("share-refresh");
  vi.unstubAllGlobals();
});

// A newer refresh writes the share's row, so this one's summary still answers
// the person.
it("keeps the summary of a refresh the person starts when a newer one writes the rows", async () => {
  let finishPressed!: (value: unknown) => void;
  const refresh = vi.fn()
    .mockReturnValueOnce(new Promise((done) => { finishPressed = done; }))
    .mockResolvedValueOnce({ results: [refused] });
  vi.stubGlobal("dohcDesktop", { refreshShareMounts: refresh });
  const { result, reportShellError, reportShellFailure, clearKind } = mountRows();

  let pressed!: Promise<void>;
  act(() => { pressed = result.current.refreshShareMounts(true); });
  await act(async () => { await result.current.refreshShareMounts(); });
  expect(reportShellFailure).toHaveBeenCalledOnce();

  await act(async () => { finishPressed({ results: [refused] }); await pressed; });
  expect(reportShellFailure).toHaveBeenCalledOnce();
  expect(reportShellError).toHaveBeenCalledWith(
    "dohc could not refresh 1 share.", null, expect.any(Function), "share-refresh",
  );
  expect(clearKind).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it("tells the person when dohc set aside a share's collision record", async () => {
  vi.stubGlobal("dohcDesktop", {
    refreshShareMounts: vi.fn().mockResolvedValue({
      results: [{ shareId: "share-1", label: "alex", status: "updated", changedPaths: 2, collisionRecordQuarantined: true }],
    }),
  });
  const { result, showSuccessNotice, reportShellFailure, clearIdentity, clearKind } = mountRows();
  const setAside = {
    message:
      "dohc could not read its record of your files with the same path as a file in alex. " +
      "dohc keeps these files apart.",
    identity: "share-mount-collision-record-set-aside:share-1",
    tone: "warning",
  };

  await act(async () => { await result.current.refreshShareMounts(); });
  expect(reportShellFailure).toHaveBeenCalledWith(setAside);
  expect(clearIdentity).toHaveBeenCalledWith("share-mount-collision-record:share-1");

  // From a refresh the person starts, the warning is the toast, and the
  // summary goes into Notices without one.
  reportShellFailure.mockClear();
  await act(async () => { await result.current.refreshShareMounts(true); });
  expect(reportShellFailure.mock.calls.map(([row]) => row)).toEqual([
    setAside,
    { message: "Shares refreshed — 2 files updated.", tone: "success", kind: "share-refresh", quiet: true },
  ]);
  // The last summary ends first, so its open toast can't come back.
  expect(clearKind).toHaveBeenCalledWith("share-refresh");
  expect(showSuccessNotice).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it("ends a removed share's refusal row", () => {
  const { rerender, clearIdentity } = mountRows();
  rerender({ shareMounts: [{ shareId: "share-2", label: "kim", granterEmail: null }] });
  expect(clearIdentity).toHaveBeenCalledWith("share-mount-collision-record:share-1");
  expect(clearIdentity).not.toHaveBeenCalledWith("share-mount-collision-record:share-2");
});

// An older poll that finishes late must not refile a row a newer refresh ended.
it("lets only the newest refresh write a share's rows", async () => {
  let finishOlder!: (value: unknown) => void;
  const refresh = vi.fn()
    .mockReturnValueOnce(new Promise((done) => { finishOlder = done; }))
    .mockResolvedValueOnce({ results: [{ ...refused, status: "unchanged", errorKind: undefined }, kimUpdated] });
  vi.stubGlobal("dohcDesktop", { refreshShareMounts: refresh });
  const { result, reportShellFailure, clearIdentity } = mountRows();

  let older!: Promise<void>;
  act(() => { older = result.current.refreshShareMounts(); });
  await act(async () => { await result.current.refreshShareMounts(); });
  expect(clearIdentity).toHaveBeenCalledWith("share-mount-collision-record:share-1");

  await act(async () => { finishOlder({ results: [refused, kimUpdated] }); await older; });
  expect(reportShellFailure).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

// The older refresh set the record aside, so the newer one finds no record to
// report. The older refresh's row is the only one the person gets.
it("files an older refresh's set-aside row", async () => {
  let finishOlder!: (value: unknown) => void;
  const refresh = vi.fn()
    .mockReturnValueOnce(new Promise((done) => { finishOlder = done; }))
    .mockResolvedValueOnce({ results: [{ shareId: "share-1", label: "alex", status: "unchanged", changedPaths: 0 }] });
  vi.stubGlobal("dohcDesktop", { refreshShareMounts: refresh });
  const { result, reportShellFailure } = mountRows();

  let older!: Promise<void>;
  act(() => { older = result.current.refreshShareMounts(); });
  await act(async () => { await result.current.refreshShareMounts(); });
  expect(reportShellFailure).not.toHaveBeenCalled();

  await act(async () => {
    finishOlder({ results: [{ shareId: "share-1", label: "alex", status: "failed", changedPaths: 0, collisionRecordQuarantined: true }] });
    await older;
  });
  expect(reportShellFailure).toHaveBeenCalledOnce();
  expect(reportShellFailure).toHaveBeenCalledWith(expect.objectContaining({
    identity: "share-mount-collision-record-set-aside:share-1",
  }));
  vi.unstubAllGlobals();
});


it.each([false, true])("reports kept mount paths and clears them after refresh (%s)", async (announce) => {
  const refresh = vi.fn()
    .mockResolvedValueOnce({ results: [{ shareId: "share-1", label: "alex", status: "unchanged", changedPaths: 0,
      unjournalablePaths: [
        { path: "docs/blocked/a.md", reason: "local-collision", owner: "docs/blocked" },
        { path: "docs/blocked/b.md", reason: "local-collision", owner: "docs/blocked" },
      ] }] })
    .mockResolvedValueOnce({ results: [{ shareId: "share-1", label: "alex", status: "unchanged", changedPaths: 0 }] });
  vi.stubGlobal("dohcDesktop", { refreshShareMounts: refresh });
  const { result, showSuccessNotice, reportShellFailure, clearIdentity } = mountRows();
  try {
    await act(async () => { await result.current.refreshShareMounts(announce); });
    expect(reportShellFailure).toHaveBeenCalledWith({
      message: "dohc could not receive shared-with-me/alex/docs/blocked. A file from this machine already uses this path. Move or rename the file, then refresh.",
      identity: "share-mount-kept-paths:share-1",
      tone: "warning",
      retry: expect.any(Function),
      paths: [
        "shared-with-me/alex/docs/blocked",
        "shared-with-me/alex/docs/blocked/a.md",
        "shared-with-me/alex/docs/blocked/b.md",
      ],
      noDismiss: true,
      ...(announce ? {} : { repeat: true }),
    });
    expect(clearIdentity).not.toHaveBeenCalledWith("share-mount-kept-paths:share-1");
    // From a refresh the person starts, the warning is the toast, and the
    // summary goes into Notices without one.
    if (announce) {
      expect(reportShellFailure).toHaveBeenLastCalledWith(
        { message: "Shares refreshed — 0 files updated.", tone: "success", kind: "share-refresh", quiet: true },
      );
      expect(showSuccessNotice).not.toHaveBeenCalled();
    }
    const filed = reportShellFailure.mock.calls.length;
    const retry = reportShellFailure.mock.calls[0]![0].retry as () => void;
    await act(async () => { retry(); });
    await vi.waitFor(() => expect(clearIdentity).toHaveBeenCalledWith("share-mount-kept-paths:share-1"));
    expect(refresh).toHaveBeenNthCalledWith(2, { workspaceId: "ws-1" });
    // With no warning left, the summary is the toast.
    expect(showSuccessNotice).toHaveBeenCalledWith(expect.stringContaining("Shares refreshed"), undefined, "share-refresh");
    expect(reportShellFailure).toHaveBeenCalledTimes(filed);
    expect(shareUnjournalableNotice([
      { path: "notes.md", reason: "local-collision" },
      { path: "docs/blocked/a.md", reason: "local-collision", owner: "docs/blocked" },
      { path: "docs/blocked/b.md", reason: "local-collision", owner: "docs/blocked" },
    ])).toBe(
      "dohc could not receive notes.md, docs/blocked. Files from this machine already use these paths. Move or rename the files, then refresh.",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it("includes both spellings in notice details", async () => {
  vi.stubGlobal("dohcDesktop", {
    refreshShareMounts: vi.fn().mockResolvedValue({ results: [{
      shareId: "share-1", label: "alex", status: "unchanged", changedPaths: 0,
      unjournalablePaths: [{ path: "docs/Notes.md", reason: "spelling-collision", owner: "docs/notes.md" }],
    }] }),
  });
  const { result, reportShellFailure } = mountRows();
  try {
    await act(async () => { await result.current.refreshShareMounts(); });
    expect(reportShellFailure).toHaveBeenCalledWith(expect.objectContaining({
      message: "dohc could not receive shared-with-me/alex/docs/Notes.md. This machine treats shared-with-me/alex/docs/Notes.md and shared-with-me/alex/docs/notes.md as the same name. Ask the person who shared the files to rename one of them.",
      paths: ["shared-with-me/alex/docs/Notes.md", "shared-with-me/alex/docs/notes.md"],
    }));
  } finally {
    vi.unstubAllGlobals();
  }
});

it("includes every kept mount path in notice details", async () => {
  const paths = ["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md"];
  vi.stubGlobal("dohcDesktop", {
    refreshShareMounts: vi.fn().mockResolvedValue({ results: [{
      shareId: "share-1", label: "alex", status: "unchanged", changedPaths: 0,
      unjournalablePaths: paths.map(path => ({ path, reason: "local-collision" })),
    }] }),
  });
  const { result, reportShellFailure } = mountRows();
  try {
    await act(async () => { await result.current.refreshShareMounts(); });
    expect(reportShellFailure).toHaveBeenCalledWith(expect.objectContaining({
      message: "dohc could not receive shared-with-me/alex/docs/a.md, shared-with-me/alex/docs/b.md, shared-with-me/alex/docs/c.md, and 1 more. Files from this machine already use these paths. Move or rename the files, then refresh.",
      paths: paths.map(path => `shared-with-me/alex/${path}`),
    }));
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps the latest mount path notice when an earlier refresh finishes", async () => {
  let finishOlder!: (value: unknown) => void;
  const refresh = vi.fn()
    .mockReturnValueOnce(new Promise(done => { finishOlder = done; }))
    .mockResolvedValueOnce({ results: [{ shareId: "share-1", label: "alex", status: "unchanged", changedPaths: 0,
      unjournalablePaths: [{ path: "docs/a.md", reason: "local-collision" }] }] });
  vi.stubGlobal("dohcDesktop", { refreshShareMounts: refresh });
  const { result, reportShellFailure, clearIdentity } = mountRows();
  try {
    let older!: Promise<void>;
    act(() => { older = result.current.refreshShareMounts(); });
    await act(async () => { await result.current.refreshShareMounts(); });
    expect(reportShellFailure).toHaveBeenCalledWith(expect.objectContaining({ identity: "share-mount-kept-paths:share-1" }));
    await act(async () => {
      finishOlder({ results: [{ shareId: "share-1", label: "alex", status: "unchanged", changedPaths: 0 }] });
      await older;
    });
    expect(clearIdentity).not.toHaveBeenCalledWith("share-mount-kept-paths:share-1");
  } finally {
    vi.unstubAllGlobals();
  }
});
