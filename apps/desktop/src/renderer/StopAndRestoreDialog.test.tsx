// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingStopAndRestoresResult, StopAndRestoreResult, UndoStopAndRestorePayload, UndoStopAndRestoreResult } from "../ipc/bridgeContract";
import { StopAndRestoreDialog, useStopAndRestore } from "./StopAndRestoreDialog";
import { captureOrphanedDraft, resetOrphanedDrafts } from "./orphanedDrafts";
import { enqueueCollectionFieldWrite, resetCollectionFieldWritesForTests, setCollectionFieldWriteAccess } from "./collections/recordFieldWrites";

const KEPT = { id: "f".repeat(32), path: "trip/Tasks/Untitled.md", field: "Finished on", recordId: null };
const WORKSPACE = "workspace";
const ANA = { target: { kind: "person", userId: "user_ana" }, label: "ana@example.com (Edit)" } as const;
const LINK = { target: { kind: "link", grantId: "grant-link" }, label: "Edit link" } as const;
const onCollectionAutomationsChanged = () => () => undefined;

it("dismisses unfinished progress through the workspace operation and keeps the files-step wording", async () => {
  const dismissStopAndRestore = vi.fn(async () => {});
  const result = {status: "restored" as const, restored: [], review: [], runsUndone: 0, runsLeft: 0,
    keptFields: [], fieldsMissing: 0, runChangesKept: 0, wroteAutomations: false, sendsMessages: false, unfinished: {step: "files" as const, message: "Interrupted"}};
  window.dohcDesktop = {dismissStopAndRestore, onCollectionAutomationsChanged,
    pendingStopAndRestores: async () => [{target: ANA.target, label: ANA.label, result, receipts: [], filesUndone: true}]} as unknown as typeof window.dohcDesktop;
  const onError = vi.fn();
  const h = renderHook(() => useStopAndRestore(WORKSPACE, {ready: true, onError}));
  await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  expect(onError.mock.calls[0]![0]).toBe("dohc stopped before restoring every file.");
  await act(async () => {expect(await h.result.current.dismiss(onError.mock.calls[0]![3])).toBe(true);});
  expect(dismissStopAndRestore).toHaveBeenCalledWith({workspaceId: WORKSPACE, target: ANA.target});
  expect(h.result.current.receipts.shown(WORKSPACE, ANA.target)).toBeNull();
});

it("recovers saved totals once and preserves a newer in-memory outcome across workspace switches", async () => {
  const result: Extract<StopAndRestoreResult, {status: "restored"}> = {status: "restored", restored: [], review: [], runsUndone: 2, runsLeft: 0,
    keptFields: [], fieldsMissing: 0, runChangesKept: 0, wroteAutomations: true, sendsMessages: false, unfinished: {step: "runs", message: "Conflict"}};
  const pending = vi.fn(async () => [{target: ANA.target, label: ANA.label, result, receipts: [], filesUndone: false}]);
  window.dohcDesktop = {pendingStopAndRestores: pending, onCollectionAutomationsChanged} as unknown as typeof window.dohcDesktop;
  const onError = vi.fn();
  const h = renderHook(({workspaceId, ready}) => useStopAndRestore(workspaceId, {ready, onError}), {initialProps: {workspaceId: WORKSPACE, ready: true}});
  await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  act(() => h.result.current.receipts.show(WORKSPACE, ANA.target, {result: {...result, runsUndone: 3}, undone: true}));
  h.rerender({workspaceId: "other", ready: false});
  h.rerender({workspaceId: WORKSPACE, ready: true});
  await waitFor(() => expect(pending).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(h.result.current.receipts.runs(WORKSPACE, ANA.target).runsUndone).toBe(2);
  expect(h.result.current.receipts.shown(WORKSPACE, ANA.target)?.result.runsUndone).toBe(3);
});

it("reads unfinished progress again once the workspace's automations open", async () => {
  const result = {status: "restored" as const, restored: [], review: [], runsUndone: 0, runsLeft: 0,
    keptFields: [], fieldsMissing: 0, runChangesKept: 0, wroteAutomations: false, sendsMessages: false, unfinished: {step: "files" as const, message: "Interrupted"}};
  // Main answers nothing until the automation store opens.
  let opened = false;
  let changed: ((event: {workspaceId: string}) => void) | undefined;
  const pending = vi.fn(async () => opened ? [{target: ANA.target, label: ANA.label, result, receipts: [], filesUndone: false}] : []);
  window.dohcDesktop = {pendingStopAndRestores: pending, onCollectionAutomationsChanged: (listener: typeof changed) => {
    changed = listener;
    return () => {changed = undefined;};
  }} as unknown as typeof window.dohcDesktop;
  const onError = vi.fn();
  const h = renderHook(() => useStopAndRestore(WORKSPACE, {ready: true, onError}));
  await waitFor(() => expect(pending).toHaveBeenCalledTimes(1));
  await act(async () => {});
  opened = true;
  act(() => changed?.({workspaceId: "other"}));
  expect(pending).toHaveBeenCalledTimes(1);
  act(() => changed?.({workspaceId: WORKSPACE}));
  await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  expect(onError.mock.calls[0]![0]).toBe("dohc stopped before restoring every file.");
  h.unmount();
  expect(changed).toBeUndefined();
});

it.each(["pending", "not-accepted"] as const)("reports %s shared reversals with the matching run count", async state => {
  const draft = {outboxId: "outbox", appendKey: "reverse/Status", nativeHeadSequence: 2,
    binding: {workspaceId: WORKSPACE, mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
      currentPath: "trip/task.md", selectorPaths: ["trip"], restoreFenceGeneration: 0}};
  fixture([{status: "restored", restored: [], review: [], runsUndone: state === "pending" ? 1 : 0, runsLeft: state === "pending" ? 0 : 1, keptFields: [], fieldsMissing: 0,
    runChangesKept: 0, wroteAutomations: true, sendsMessages: false, unfinished: null,
    sharedReversals: [{recordId: "record", field: "Status", draft, state}]}]);
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText(state === "pending"
    ? "Reversals saved on this computer. The shared host has not accepted them yet."
    : "Reversals saved on this computer. The shared host did not accept them. Try Undo again in Run History.")).toBeTruthy();
  expect(screen.queryByText(/^Undid 1 run/) !== null).toBe(state === "pending");
  expect(screen.queryByText(/^dohc could not undo/) !== null).toBe(state === "not-accepted");
});
const row = (overrides: Record<string, unknown>) => ({
  shareId: "share", workspaceId: WORKSPACE, grantId: "grant", recipientUserId: "user_ana", recipientEmail: "ana@example.com",
  access: "edit", revokedAtMs: null, generation: 1, createdAtMs: 1, shareCode: "code", selector: { paths: ["trip"], versionId: null },
  ...overrides,
});

it("shows that runs from a reviewed automations file were kept", async () => {
  fixture([{status: "restored", restored: [], review: [{path: "trip/automations.yaml", reason: "restore-refused", detail: "Changed on this device since the last saved version. Runs from this file's automations were kept."}], runsUndone: 0, runsLeft: 0, keptFields: [], fieldsMissing: 0, runChangesKept: 0, wroteAutomations: true, sendsMessages: false, unfinished: null}]);
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText(/Runs from this file's automations were kept\./)).toBeTruthy();
});

function fixture(results: Array<StopAndRestoreResult | Error>, first: typeof ANA | typeof LINK = ANA, recovered?: PendingStopAndRestoresResult) {
  const stopAndRestore = vi.fn(async () => {
    const next = results.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  const restoredPaths = new Map(results.flatMap(result => !(result instanceof Error) && result.status === "restored"
    ? result.restored.map(file => [file.restoredMomentId, file.path] as const) : []));
  const undoStopAndRestore = vi.fn(async ({ restoredMomentIds }: UndoStopAndRestorePayload): Promise<UndoStopAndRestoreResult> => ({
    errorMessage: null,
    files: [...restoredMomentIds].reverse().map(momentId => ({ momentId, kind: "restored" as const,
      receipt: { path: restoredPaths.get(momentId)!, restoredMomentId: `undo-${momentId}` },
    })),
  }));
  window.dohcDesktop = {
    listRelayShares: async () => ({
      granted: [
        row({}),
        row({ grantId: "bob", recipientUserId: "user_bob", recipientEmail: "bob@example.com" }),
        row({ grantId: "viewer", recipientUserId: "user_cy", recipientEmail: "cy@example.com", access: "view" }),
        row({ grantId: "elsewhere", recipientUserId: "user_di", recipientEmail: "di@example.com", workspaceId: "other" }),
      ],
      received: [],
    }),
    listRelayShareLinks: async () => ({
      supportedLinkAccess: ["view", "comment", "edit"],
      links: [
        { shareId: "s", grantId: "grant-link", selector: { paths: ["trip"], versionId: null }, access: "edit", status: "active" },
        { shareId: "s", grantId: "grant-view", selector: { paths: ["trip"], versionId: null }, access: "view", status: "active" },
        { shareId: "s", grantId: "grant-ended", selector: { paths: ["notes"], versionId: null }, access: "edit", status: "revoked" },
      ],
      independentGrants: [],
    }),
    stopAndRestore,
    pendingStopAndRestores: async () => recovered ?? [],
    onCollectionAutomationsChanged,
    undoStopAndRestore,
  } as unknown as typeof window.dohcDesktop;
  const release = vi.fn();
  const props = {
    onBeforeRestore: vi.fn(async () => release),
    onRestored: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenCollection: vi.fn(),
    onError: vi.fn<(fallback: string, error: unknown, retry: () => void, identity: string) => void>(),
    onSettled: vi.fn<(identity: string) => void>(),
  };
  // The shell's part: it holds the dialog and the files put back.
  let shell!: ReturnType<typeof useStopAndRestore>;
  function Shell() {
    shell = useStopAndRestore(WORKSPACE, {ready: recovered !== undefined, onError: props.onError});
    const session = shell.session;
    return session ? (
      <StopAndRestoreDialog
        key={session.key}
        workspaceId={WORKSPACE}
        target={session.target}
        start={session.start}
        receipts={shell.receipts}
        onRetry={shell.retry}
        onClose={shell.close}
        {...props}
      />
    ) : null;
  }
  render(<Shell />);
  if (recovered === undefined) act(() => shell.open(first));
  return { props, release, stopAndRestore, undoStopAndRestore, shell: () => shell };
}

it("recovers unfinished runs after relaunch and opens Try again from the Notice", async () => {
  const result: StopAndRestoreResult = {status: "restored", restored: [], review: [], runsUndone: 1, runsLeft: 0,
    keptFields: [], fieldsMissing: 0, runChangesKept: 0, wroteAutomations: true, sendsMessages: false,
    unfinished: {step: "runs", message: "Resolve the conflict."}};
  const f = fixture([new Error("Still blocked")], ANA, [{target: ANA.target, label: ANA.label, result, receipts: [], filesUndone: true}]);
  await waitFor(() => expect(f.props.onError).toHaveBeenCalledWith("dohc has not finished undoing runs.",
    expect.any(Error), expect.any(Function), expect.any(String)));
  act(() => f.props.onError.mock.calls[0]![2]());
  expect(await screen.findByText("dohc has not finished undoing runs.")).toBeTruthy();
  expect(screen.getByRole("button", {name: "Try again"})).toBeTruthy();
  expect(f.undoStopAndRestore).not.toHaveBeenCalled();
});

it("resumes a saved file Undo from the Notice after relaunch", async () => {
  const result: StopAndRestoreResult = {status: "restored", restored: [], review: [], runsUndone: 0, runsLeft: 0,
    keptFields: [], fieldsMissing: 0, runChangesKept: 0, wroteAutomations: false, sendsMessages: false,
    unfinished: {step: "files", message: "Interrupted Undo"}};
  const f = fixture([], ANA, [{target: ANA.target, label: ANA.label, result,
    receipts: [{path: "trip/a.txt", restoredMomentId: "a"}], filesUndone: false, undoingFiles: true}]);
  await waitFor(() => expect(f.props.onError).toHaveBeenCalled());
  act(() => f.props.onError.mock.calls[0]![2]());
  await waitFor(() => expect(f.undoStopAndRestore).toHaveBeenCalled());
  expect(f.stopAndRestore).not.toHaveBeenCalled();
});

it("states that restoring a recipient creation removes its file and offers Undo", async () => {
  fixture([{ status: "restored", restored: [{ path: "trip/Tasks/Socks.md", restoredMomentId: "removed", removed: true }],
    review: [], runsUndone: 0, runsLeft: 0, keptFields: [], fieldsMissing: 0, runChangesKept: 0,
    wroteAutomations: false, sendsMessages: false, unfinished: null }]);
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("Removed 1 created file.")).toBeTruthy();
  expect(screen.getByTestId("stop-and-restore-undo")).toBeTruthy();
});

afterEach(() => {
  cleanup();
  resetOrphanedDrafts();
  resetCollectionFieldWritesForTests();
  localStorage.clear();
  delete window.dohcDesktop;
});

it("undoes intended files even when the first receipt batch was not saved, and lists recovered files", async () => {
  const f = fixture([{status: "restored", restored: [], review: [], runsUndone: 0, runsLeft: 0,
    keptFields: [], fieldsMissing: 0, runChangesKept: 0, wroteAutomations: false, sendsMessages: false,
    canUndoFiles: true, unfinished: {step: "files", message: "Barrier failed"}}]);
  f.undoStopAndRestore.mockResolvedValueOnce({errorMessage: null,
    recovered: [{path: "trip/unconfirmed.txt", restoredMomentId: "unconfirmed"}],
    files: [{kind: "restored", momentId: "unconfirmed", receipt: {path: "trip/unconfirmed.txt", restoredMomentId: "undo-unconfirmed"}}]});
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  fireEvent.click(await screen.findByTestId("stop-and-restore-undo"));
  await waitFor(() => expect(f.undoStopAndRestore).toHaveBeenCalledWith({workspaceId: WORKSPACE, target: ANA.target, reviewPaths: [], restoredMomentIds: []}));
  await waitFor(() => expect(f.shell().receipts.shown(WORKSPACE, ANA.target)?.result.restored).toEqual([{path: "trip/unconfirmed.txt", restoredMomentId: "unconfirmed"}]));
});

it("does not offer Undo when reading the changes failed before any file intent", async () => {
  const f = fixture([{status: "restored", restored: [], review: [], runsUndone: 0, runsLeft: 0,
    keptFields: [], fieldsMissing: 0, runChangesKept: 0, wroteAutomations: false, sendsMessages: false,
    unfinished: {step: "files", message: "Could not read their changes."}}]);
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  await screen.findByRole("button", {name: "Try again"});
  expect(screen.queryByTestId("stop-and-restore-undo")).toBeNull();
  expect(f.undoStopAndRestore).not.toHaveBeenCalled();
});

it("passes queued, failed and set-aside paths to Stop and restore", async () => {
  const result: StopAndRestoreResult = {status: "restored", restored: [], review: [], runsUndone: 0, runsLeft: 0, runChangesKept: 0,
    wroteAutomations: false, sendsMessages: false, keptFields: [], fieldsMissing: 0, unfinished: null};
  const f = fixture([result, result]);
  act(() => {
    enqueueCollectionFieldWrite(WORKSPACE, "trip", {recordId: "one", recordPath: "trip/queued.md", field: "Status", value: "KEEP"});
    enqueueCollectionFieldWrite("other", "trip", {recordId: "two", recordPath: "trip/other.md", field: "Status", value: "KEEP"});
    captureOrphanedDraft(WORKSPACE, "trip/draft.md", "Owner text KEEP");
  });
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  await waitFor(() => expect(f.stopAndRestore).toHaveBeenCalledWith({workspaceId: WORKSPACE, target: ANA.target, label: "ana@example.com", reviewPaths: ["trip/queued.md", "trip/draft.md"]}));
  act(() => setCollectionFieldWriteAccess(WORKSPACE, "No connection"));
  f.stopAndRestore.mockClear();
  // A retained failure contributes the same path on a later attempt.
  act(() => f.shell().retry(WORKSPACE, ANA, "stop"));
  await waitFor(() => expect(f.stopAndRestore).toHaveBeenCalledWith({workspaceId: WORKSPACE, target: ANA.target, label: ANA.label, reviewPaths: ["trip/queued.md", "trip/draft.md"]}));
});

it("stops the chosen person after one confirm, lists files to check with why, and undoes the restores", async () => {
  const f = fixture([{
    status: "restored",
    restored: [{ path: "trip/packing/collection.yaml", restoredMomentId: "back-1" }],
    review: [
      { path: "trip/packing/automations.yaml", reason: "changed-since" },
      { path: "trip/ideas/collection.yaml", reason: "folder-in-use" },
      { path: "trip/live.md", reason: "restore-refused", detail: "This action is unavailable for shared live files." },
    ],
    runsUndone: 2,
    runsLeft: 0,
    keptFields: [], fieldsMissing: 0, runChangesKept: 0, wroteAutomations: false, sendsMessages: false,
    unfinished: null,
  }]);
  const person = await screen.findByRole("combobox", { name: "Who to stop" });
  expect([...(person as HTMLSelectElement).options].map((option) => option.text)).toEqual(["ana@example.com", "bob@example.com", "Edit link to trip"]);
  expect(screen.getByText("ana@example.com loses Edit access to this workspace. Share again to give it back.")).toBeTruthy();

  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("Stopped ana@example.com's access and restored 1 file.")).toBeTruthy();
  expect(f.stopAndRestore).toHaveBeenCalledWith({ workspaceId: WORKSPACE, target: { kind: "person", userId: "user_ana" }, label: "ana@example.com", reviewPaths: [] });
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.props.onRestored).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Undid 2 runs of automations ana@example.com changed.")).toBeTruthy();
  fireEvent.click(screen.getByText("trip/packing/automations.yaml"));
  expect(f.props.onOpenFile).toHaveBeenCalledWith("trip/packing/automations.yaml");
  expect(screen.getByText("Another author changed it after ana@example.com.")).toBeTruthy();
  expect(screen.getByText("This Collection holds files someone else added.")).toBeTruthy();
  expect(screen.getByText("dohc could not restore it. This action is unavailable for shared live files.")).toBeTruthy();

  fireEvent.click(screen.getByTestId("stop-and-restore-undo"));
  expect(await screen.findByText("Put back 1 file as ana@example.com left them. Their access stays stopped.")).toBeTruthy();
  expect(f.undoStopAndRestore).toHaveBeenCalledWith({ workspaceId: WORKSPACE, target: ANA.target, reviewPaths: [], restoredMomentIds: ["back-1"] });
  expect(screen.queryByTestId("stop-and-restore-undo")).toBeNull();
});

it("lists Undo refusals and retries only the files not put back", async () => {
  const f = fixture([{
    status: "restored", restored: [{ path: "docs/old.md", restoredMomentId: "old" },
      { path: "notes/middle.md", restoredMomentId: "middle" }, { path: "docs/new.md", restoredMomentId: "new" }],
    review: [], runsUndone: 0, runsLeft: 0, keptFields: [], fieldsMissing: 0, runChangesKept: 0,
    wroteAutomations: false, sendsMessages: false, unfinished: null,
  }]);
  f.undoStopAndRestore.mockResolvedValueOnce({ files: [
    { momentId: "new", kind: "restored", receipt: { path: "docs/new.md", restoredMomentId: "undo-new" } },
    { momentId: "middle", kind: "refused", detail: "This history moment is no longer available." },
    { momentId: "old", kind: "restored", receipt: { path: "docs/old.md", restoredMomentId: "undo-old" } },
  ], errorMessage: null });
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  fireEvent.click(await screen.findByTestId("stop-and-restore-undo"));
  expect(await screen.findByText("Put back 2 files as ana@example.com left them. Their access stays stopped.")).toBeTruthy();
  expect(screen.getByText("dohc could not restore it. This history moment is no longer available.")).toBeTruthy();
  expect(f.shell().receipts.get(WORKSPACE, ANA.target)).toEqual([{ path: "notes/middle.md", restoredMomentId: "middle" }]);
  fireEvent.click(screen.getByTestId("stop-and-restore-undo"));
  expect(await screen.findByText("Put back 3 files as ana@example.com left them. Their access stays stopped.")).toBeTruthy();
  expect(f.undoStopAndRestore).toHaveBeenLastCalledWith({ workspaceId: WORKSPACE, target: ANA.target, reviewPaths: [], restoredMomentIds: ["middle"] });
  expect(f.shell().receipts.get(WORKSPACE, ANA.target)).toEqual([]);
  expect(screen.queryByText("dohc could not restore it. This history moment is no longer available.")).toBeNull();
});

it("names the rules file it can't read on the file's row, from a restore and from Undo", async () => {
  const f = fixture([{
    status: "restored", restored: [{ path: "docs/new.md", restoredMomentId: "new" }],
    review: [{ path: "docs/old.md", reason: "rules-unreadable", unreadable: [".dohc/visibility.toml"] }],
    runsUndone: 0, runsLeft: 0, keptFields: [], fieldsMissing: 0, runChangesKept: 0,
    wroteAutomations: false, sendsMessages: false, unfinished: null,
  }]);
  f.undoStopAndRestore.mockResolvedValueOnce({ files: [
    { momentId: "new", kind: "rules-unreadable", unreadable: [".dohc/files.toml", ".dohc/visibility.toml"] },
  ], errorMessage: null });
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText(
    "dohc could not restore this file because it can't read .dohc/visibility.toml. Fix the file, then try again.",
  )).toBeTruthy();
  fireEvent.click(screen.getByTestId("stop-and-restore-undo"));
  expect(await screen.findByText(
    "dohc could not restore this file because it can't read .dohc/files.toml and .dohc/visibility.toml. Fix the files, then try again.",
  )).toBeTruthy();
  expect(f.shell().receipts.get(WORKSPACE, ANA.target)).toEqual([{ path: "docs/new.md", restoredMomentId: "new" }]);
});

it("keeps partial Undo outcomes on an unexpected error and retries only remaining receipts", async () => {
  const f = fixture([{
    status: "restored", restored: [{ path: "docs/old.md", restoredMomentId: "old" },
      { path: "notes/middle.md", restoredMomentId: "middle" }, { path: "docs/new.md", restoredMomentId: "new" }],
    review: [], runsUndone: 0, runsLeft: 0, keptFields: [], fieldsMissing: 0, runChangesKept: 0,
    wroteAutomations: false, sendsMessages: false, unfinished: null,
  }]);
  f.undoStopAndRestore.mockResolvedValueOnce({ files: [
    { momentId: "new", kind: "restored", receipt: { path: "docs/new.md", restoredMomentId: "undo-new" } },
  ], errorMessage: "The workspace engine is not running." });
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  fireEvent.click(await screen.findByTestId("stop-and-restore-undo"));
  expect(await screen.findByText("Put back 1 file as ana@example.com left them. Their access stays stopped.")).toBeTruthy();
  expect(f.shell().receipts.get(WORKSPACE, ANA.target)).toEqual([
    { path: "docs/old.md", restoredMomentId: "old" }, { path: "notes/middle.md", restoredMomentId: "middle" },
  ]);
  expect(f.props.onError).toHaveBeenCalledTimes(1);
  const [fallback, error, retry, identity] = f.props.onError.mock.calls[0]!;
  expect(fallback).toBe("dohc could not undo the restore.");
  expect((error as Error).message).toBe("The workspace engine is not running.");
  // Only the initial Stop settled; the partial Undo keeps its retry notice.
  expect(f.props.onSettled.mock.calls).toEqual([[identity]]);
  act(() => f.shell().close());
  act(() => retry());
  expect(await screen.findByText("Put back 3 files as ana@example.com left them. Their access stays stopped.")).toBeTruthy();
  expect(f.undoStopAndRestore.mock.calls).toEqual([
    [{ workspaceId: WORKSPACE, target: ANA.target, reviewPaths: [], restoredMomentIds: ["old", "middle", "new"] }],
    [{ workspaceId: WORKSPACE, target: ANA.target, reviewPaths: [], restoredMomentIds: ["old", "middle"] }],
  ]);
  expect(f.shell().receipts.get(WORKSPACE, ANA.target)).toEqual([]);
  expect(f.props.onSettled.mock.calls).toEqual([[identity], [identity]]);
  expect(screen.queryByTestId("stop-and-restore-undo")).toBeNull();
});

it("says access stopped while changes are still arriving, and tries again", async () => {
  const f = fixture([
    { status: "waiting" },
    { status: "restored", restored: [], review: [], runsUndone: 0, runsLeft: 0, keptFields: [], fieldsMissing: 0, runChangesKept: 0, wroteAutomations: false, sendsMessages: false, unfinished: null },
  ]);
  fireEvent.change(await screen.findByRole("combobox", { name: "Who to stop" }), { target: { value: "person:user_bob" } });
  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("Access stopped. dohc has not received all of bob@example.com's changes yet. Try again in a moment.")).toBeTruthy();
  expect(f.props.onRestored).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Try again"));
  expect(await screen.findByText("Stopped bob@example.com's access and restored 0 files.")).toBeTruthy();
  expect(f.stopAndRestore).toHaveBeenLastCalledWith({ workspaceId: WORKSPACE, target: { kind: "person", userId: "user_bob" }, label: "bob@example.com", reviewPaths: [] });
});

it("reports failures through the shell, and a Try again after closing opens the dialog again with Undo for every file", async () => {
  const f = fixture([
    {
      status: "restored",
      restored: [{ path: "trip/packing/automations.yaml", restoredMomentId: "back-1" }],
      review: [],
      runsUndone: 0,
      runsLeft: 0,
      keptFields: [], fieldsMissing: 0, runChangesKept: 0, wroteAutomations: false, sendsMessages: false,
      unfinished: { step: "files", message: "The workspace engine is not running." },
    },
    new Error("dohc could not reach the relay."),
    { status: "restored", restored: [{ path: "trip/packing/collection.yaml", restoredMomentId: "back-2" }], review: [], runsUndone: 1, runsLeft: 0, keptFields: [], fieldsMissing: 0, runChangesKept: 0, wroteAutomations: false, sendsMessages: false, unfinished: null },
  ]);
  await screen.findByRole("combobox", { name: "Who to stop" });
  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("Stopped ana@example.com's access and restored 1 file.")).toBeTruthy();
  expect(screen.getByText("dohc has not finished restoring files.")).toBeTruthy();
  const [fallback, error] = f.props.onError.mock.calls[0]!;
  expect(fallback).toBe("Stopped ana@example.com's access. dohc has not finished restoring their changes.");
  expect((error as Error).message).toBe("The workspace engine is not running.");
  expect(screen.queryByRole("alert")).toBeNull();

  // The person closes the dialog, then uses Try again from the Notices row.
  fireEvent.click(screen.getByText("Close"));
  expect(screen.queryByTestId("stop-and-restore-dialog")).toBeNull();
  act(() => f.props.onError.mock.calls[0]![2]());
  await waitFor(() => expect(f.props.onError).toHaveBeenCalledTimes(2));
  // Access stopped on the first try, so the failure says so.
  expect(f.props.onError.mock.calls[1]![0]).toBe("Stopped ana@example.com's access. dohc has not finished restoring their changes.");
  expect((f.props.onError.mock.calls[1]![1] as Error).message).toBe("dohc could not reach the relay.");
  // The reopened dialog keeps the earlier outcome and its Undo.
  expect(await screen.findByText("Stopped ana@example.com's access and restored 1 file.")).toBeTruthy();
  expect(screen.getByTestId("stop-and-restore-undo")).toBeTruthy();

  act(() => f.props.onError.mock.calls[1]![2]());
  expect(await screen.findByText("Stopped ana@example.com's access and restored 2 files.")).toBeTruthy();
  fireEvent.click(screen.getByTestId("stop-and-restore-undo"));
  await waitFor(() => expect(f.undoStopAndRestore).toHaveBeenCalledWith({ workspaceId: WORKSPACE, target: ANA.target, reviewPaths: [], restoredMomentIds: ["back-1", "back-2"] }));
  expect(f.shell().receipts.get(WORKSPACE, ANA.target)).toEqual([]);
});

it("ends a whole Edit link, says it stops for everyone, and never claims its automations' effects are all undone", async () => {
  const f = fixture([{
    status: "restored",
    restored: [{ path: "trip/packing/automations.yaml", restoredMomentId: "back-1" }],
    review: [{ path: "trip/packing/collection.yaml", reason: "changed-since" }],
    keptFields: [], fieldsMissing: 0, runsUndone: 1, runsLeft: 1, runChangesKept: 2, wroteAutomations: true, sendsMessages: true, unfinished: null,
  }], LINK);
  const who = await screen.findByRole("combobox", { name: "Who to stop" });
  expect((who as HTMLSelectElement).value).toBe("link:grant-link");
  expect(screen.getByText("Edit link to trip stops working for everyone who has it, including people who opened it in dohc. Share again to give access back.")).toBeTruthy();

  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("Ended Edit link to trip and restored 1 file.")).toBeTruthy();
  expect(f.stopAndRestore).toHaveBeenCalledWith({ workspaceId: WORKSPACE, target: { kind: "link", grantId: "grant-link" }, label: "Edit link to trip", reviewPaths: [] });
  expect(screen.getByText("Undid 1 run of automations changed through Edit link to trip.")).toBeTruthy();
  expect(screen.getByText("dohc could not undo 1 run of automations changed through Edit link to trip. Undo each from its Collection's run history.")).toBeTruthy();
  expect(screen.getByText("Undo left 2 changes from those runs. Check each Collection's run history.")).toBeTruthy();
  expect(screen.getByText("Messages and notices from automations changed through Edit link to trip stay sent.")).toBeTruthy();
  expect(screen.getByText("Runs on your other computers are not undone here. Undo them from the run history on each computer.")).toBeTruthy();
  expect(screen.getByText("Another author changed it after the link.")).toBeTruthy();

  fireEvent.click(screen.getByTestId("stop-and-restore-undo"));
  expect(await screen.findByText("Put back 1 file as Edit link to trip left them. The link stays ended.")).toBeTruthy();
  expect(f.undoStopAndRestore).toHaveBeenCalledWith({ workspaceId: WORKSPACE, target: LINK.target, reviewPaths: [], restoredMomentIds: ["back-1"] });
});

it("carries forward what undoing runs found when a try stopped part way", async () => {
  const none = { keptFields: [], fieldsMissing: 0, review: [], runsLeft: 0, wroteAutomations: true, sendsMessages: false };
  const f = fixture([
    { status: "restored", restored: [], ...none, runsUndone: 1, runChangesKept: 2, unfinished: { step: "runs", message: "The workspace engine is not running." } },
    { status: "restored", restored: [], ...none, runsUndone: 1, runChangesKept: 1, unfinished: null },
  ]);
  await screen.findByRole("combobox", { name: "Who to stop" });
  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("Undo left 2 changes from those runs. Check each Collection's run history.")).toBeTruthy();
  act(() => f.props.onError.mock.calls[0]![2]());
  expect(await screen.findByText("Undid 2 runs of automations ana@example.com changed.")).toBeTruthy();
  expect(screen.getByText("Undo left 3 changes from those runs. Check each Collection's run history.")).toBeTruthy();
});

it("keeps the runs a try undid after the files are undone, and after the dialog closed during the try", async () => {
  const none = { keptFields: [], fieldsMissing: 0, review: [], runsLeft: 0, wroteAutomations: true, sendsMessages: false };
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const f = fixture([
    { status: "restored", restored: [{ path: "trip/a.yaml", restoredMomentId: "back-1" }], ...none, runsUndone: 2, runChangesKept: 1, unfinished: null },
    { status: "restored", restored: [], ...none, runsUndone: 0, runChangesKept: 0, unfinished: null },
  ]);
  const first = f.stopAndRestore.getMockImplementation()!;
  f.stopAndRestore.mockImplementationOnce(async () => {
    await gate;
    return await first();
  });
  await screen.findByRole("combobox", { name: "Who to stop" });
  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  // The owner closes the dialog while the try runs.
  fireEvent.click(screen.getByText("Close"));
  await act(async () => { finish(); await gate; });
  await waitFor(() => expect(f.props.onRestored).toHaveBeenCalledTimes(1));

  act(() => f.shell().retry(WORKSPACE, ANA, "undo"));
  expect(await screen.findByText("Put back 1 file as ana@example.com left them. Their access stays stopped.")).toBeTruthy();
  expect(screen.getByText("Undid 2 runs of automations ana@example.com changed.")).toBeTruthy();

  // A new try passes over the runs already undone, and still names them.
  act(() => f.shell().retry(WORKSPACE, ANA, "stop"));
  expect(await screen.findByText("Stopped ana@example.com's access and restored 0 files.")).toBeTruthy();
  expect(screen.getByText("Undid 2 runs of automations ana@example.com changed.")).toBeTruthy();
  expect(screen.getByText("Undo left 1 change from those runs. Check each Collection's run history.")).toBeTruthy();
});

it("shows each kept change once: fields at a later value, fields on records that left, and the rest", async () => {
  const none = { review: [], runsLeft: 0, wroteAutomations: true, sendsMessages: false };
  const f = fixture([
    { status: "restored", restored: [], ...none, runsUndone: 1, runChangesKept: 4, keptFields: [KEPT, { ...KEPT, id: "1".repeat(32), field: "Field 1" }], fieldsMissing: 1, unfinished: { step: "runs", message: "The workspace engine is not running." } },
    // The retry undoes the run the first try stopped on. It reports the same
    // 2 fields still kept, and no missing field or other change of its own.
    { status: "restored", restored: [], ...none, runsUndone: 1, runChangesKept: 2, keptFields: [KEPT, { ...KEPT, id: "1".repeat(32), field: "Field 1" }], fieldsMissing: 0, unfinished: null },
  ]);
  await screen.findByRole("combobox", { name: "Who to stop" });
  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("2 fields kept a later value.")).toBeTruthy();
  expect(screen.getByText("1 field was on records no longer in their Collection.")).toBeTruthy();
  expect(screen.getByText("Undo left 1 other change from those runs. Check each Collection's run history.")).toBeTruthy();
  expect(screen.getByTestId("stop-and-restore-outcome").textContent).not.toMatch(/\b4\b/);

  // Kept fields a retry reports replace the earlier try's; missing fields and other changes add up.
  act(() => f.props.onError.mock.calls[0]![2]());
  expect(await screen.findByText("Undid 2 runs of automations ana@example.com changed.")).toBeTruthy();
  expect(screen.getByText("2 fields kept a later value.")).toBeTruthy();
  expect(screen.getByText("1 field was on records no longer in their Collection.")).toBeTruthy();
  expect(screen.getByText("Undo left 1 other change from those runs. Check each Collection's run history.")).toBeTruthy();
});

it("shows no other-changes line when the fields account for every kept change", async () => {
  fixture([{
    status: "restored", restored: [], review: [], runsLeft: 0, wroteAutomations: true, sendsMessages: false,
    runsUndone: 1, runChangesKept: 3, keptFields: [KEPT, { ...KEPT, id: "1".repeat(32), field: "Field 1" }], fieldsMissing: 1, unfinished: null,
  }]);
  await screen.findByRole("combobox", { name: "Who to stop" });
  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("2 fields kept a later value.")).toBeTruthy();
  expect(screen.getByText("1 field was on records no longer in their Collection.")).toBeTruthy();
  expect(screen.getByTestId("stop-and-restore-outcome").textContent).not.toMatch(/Undo left|\b3\b/);
});

it("says before it runs that runs of automations they changed are undone", async () => {
  fixture([]);
  await screen.findByRole("combobox", { name: "Who to stop" });
  expect(screen.getByText("Each file they changed directly goes back to how it was before their first change. Collections they created are removed. Runs of automations they changed are undone on this computer and your server. You can undo the file changes, not the runs.")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Who to stop" }), { target: { value: "link:grant-link" } });
  expect(screen.getByText("Each file changed through it goes back to how it was before its first change. Collections created through it are removed. Runs of automations changed through it are undone on this computer and your server. You can undo the file changes, not the runs.")).toBeTruthy();
});

it("never shows runs it did not finish undoing as done, and tries again from the dialog", async () => {
  const none = { review: [], runsLeft: 0, keptFields: [], fieldsMissing: 0, runChangesKept: 0, wroteAutomations: true, sendsMessages: false };
  const sync = "dohc could not sync this workspace with your server, so it stopped undoing runs part way. Try again.";
  const f = fixture([
    { status: "restored", restored: [{ path: "trip/packing/automations.yaml", restoredMomentId: "back-1" }], ...none, runsUndone: 0, unfinished: { step: "runs", message: sync } },
    { status: "restored", restored: [], ...none, runsUndone: 1, unfinished: { step: "runs", message: sync } },
    { status: "restored", restored: [], ...none, runsUndone: 1, unfinished: null },
  ]);
  await screen.findByRole("combobox", { name: "Who to stop" });
  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  // What finished, then what did not, with no run counted as undone.
  expect(await screen.findByText("Stopped ana@example.com's access and restored 1 file.")).toBeTruthy();
  expect(screen.getByText("dohc has not finished undoing runs of automations ana@example.com changed.")).toBeTruthy();
  expect(screen.getByTestId("stop-and-restore-outcome").textContent).not.toMatch(/Undid/);
  const [fallback, error, retry] = f.props.onError.mock.calls[0]!;
  expect(fallback).toBe("Stopped ana@example.com's access. dohc has not finished undoing runs of automations they changed.");
  expect((error as Error).message).toBe(sync);
  expect(typeof retry).toBe("function");

  // A try that undoes some runs and stops again names each count once.
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Undid 1 run of automations ana@example.com changed.")).toBeTruthy();
  expect(screen.getByText("dohc has not finished undoing runs.")).toBeTruthy();
  expect(screen.getByText("Stopped ana@example.com's access and restored 1 file.")).toBeTruthy();
  expect(f.props.onError).toHaveBeenCalledTimes(2);

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Undid 2 runs of automations ana@example.com changed.")).toBeTruthy();
  expect(screen.getByTestId("stop-and-restore-outcome").textContent).not.toMatch(/not finished/);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.getByTestId("stop-and-restore-undo")).toBeTruthy();
  expect(f.props.onError).toHaveBeenCalledTimes(2);
  // Every failure named the same row, and the finished try removed it.
  const identity = f.props.onError.mock.calls[0]![3];
  expect(f.props.onError.mock.calls[1]![3]).toBe(identity);
  expect(f.props.onSettled).toHaveBeenCalledWith(identity);
});

it("gives each person their own Notices row", async () => {
  const unfinished = (): StopAndRestoreResult => ({ status: "restored", restored: [], review: [], runsUndone: 0, runsLeft: 0, keptFields: [], fieldsMissing: 0, runChangesKept: 0,
    wroteAutomations: true, sendsMessages: false, unfinished: { step: "runs", message: "dohc stopped." } });
  const f = fixture([unfinished(), unfinished()]);
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  await waitFor(() => expect(f.props.onError).toHaveBeenCalledTimes(1));
  act(() => f.shell().open({ target: { kind: "person", userId: "user_bob" }, label: "bob@example.com" }));
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  await waitFor(() => expect(f.props.onError).toHaveBeenCalledTimes(2));
  expect(f.props.onError.mock.calls[0]![3]).not.toBe(f.props.onError.mock.calls[1]![3]);
});

it("after Undo of the files, keeps Try again and the Notice for unfinished runs", async () => {
  const f = fixture([{
    status: "restored", restored: [{ path: "trip/packing/automations.yaml", restoredMomentId: "back-1" }], review: [], runsUndone: 1, runsLeft: 0,
    keptFields: [], fieldsMissing: 0, runChangesKept: 0, wroteAutomations: true, sendsMessages: false, unfinished: { step: "runs", message: "dohc stopped." },
  }]);
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  const identity = await waitFor(() => f.props.onError.mock.calls[0]![3]);
  fireEvent.click(screen.getByTestId("stop-and-restore-undo"));
  expect(await screen.findByText("dohc has not finished undoing runs.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(f.props.onSettled).not.toHaveBeenCalledWith(identity);
  expect(f.props.onError).toHaveBeenLastCalledWith("dohc has not finished undoing runs.", expect.any(Error), expect.any(Function), identity);
});

it("keeps what an earlier try showed when a retry stops before it reads their changes", async () => {
  const f = fixture([
    {
      status: "restored", restored: [{ path: "trip/packing/automations.yaml", restoredMomentId: "back-1" }],
      review: [{ path: "trip/packing/collection.yaml", reason: "changed-since" }],
      runsUndone: 1, runsLeft: 0, keptFields: [KEPT], fieldsMissing: 0, runChangesKept: 1, wroteAutomations: true, sendsMessages: true,
      unfinished: { step: "runs", message: "dohc stopped." },
    },
    {
      status: "restored", restored: [], review: [], runsUndone: 0, runsLeft: 0, keptFields: [KEPT], fieldsMissing: 0, runChangesKept: 1,
      wroteAutomations: false, sendsMessages: false, unfinished: { step: "files", message: "dohc could not reach your server." },
    },
  ]);
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("1 field kept a later value.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("dohc has not finished restoring files.")).toBeTruthy();
  expect(screen.getByText("Stopped ana@example.com's access and restored 1 file.")).toBeTruthy();
  expect(screen.getByText("Undid 1 run of automations ana@example.com changed.")).toBeTruthy();
  expect(screen.queryByText("dohc has not finished undoing runs.")).toBeNull();
  expect(screen.getByText("1 field kept a later value.")).toBeTruthy();
  expect(screen.getByText("Messages and notices from automations ana@example.com changed stay sent.")).toBeTruthy();
  expect(screen.getByText("trip/packing/collection.yaml")).toBeTruthy();
  expect(f.props.onError.mock.calls[1]![0]).toBe("Stopped ana@example.com's access. dohc has not finished restoring their changes.");
});

it("offers Undo for fresh files after an earlier unfinished restore's files were undone", async () => {
  const result = {status: "restored" as const, review: [], runsLeft: 0, keptFields: [], fieldsMissing: 0,
    runChangesKept: 0, wroteAutomations: true, sendsMessages: false};
  const f = fixture([
    {...result, restored: [{path: "trip/old.md", restoredMomentId: "old"}], runsUndone: 2,
      unfinished: {step: "runs", message: "Interrupted"}},
    {...result, restored: [{path: "trip/new.md", restoredMomentId: "new"}], runsUndone: 1, unfinished: null},
  ]);
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  fireEvent.click(await screen.findByTestId("stop-and-restore-undo"));
  await waitFor(() => expect(screen.queryByTestId("stop-and-restore-undo")).toBeNull());
  act(() => {f.shell().close();});
  act(() => {f.shell().open(ANA);});
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("Stopped ana@example.com's access and restored 1 file.")).toBeTruthy();
  expect(screen.getByText("Undid 1 run of automations ana@example.com changed.")).toBeTruthy();
  expect(screen.getByTestId("stop-and-restore-undo")).toBeTruthy();
  expect(f.shell().receipts.get(WORKSPACE, ANA.target)).toEqual([{path: "trip/new.md", restoredMomentId: "new"}]);
});

it("does not say runs are unfinished after an earlier try finished them, when a later try stops at the files", async () => {
  const f = fixture([
    {
      status: "restored", restored: [{ path: "trip/packing/automations.yaml", restoredMomentId: "back-1" }], review: [],
      runsUndone: 2, runsLeft: 0, keptFields: [], fieldsMissing: 0, runChangesKept: 0, wroteAutomations: true, sendsMessages: false, unfinished: null,
    },
    {
      status: "restored", restored: [], review: [], runsUndone: 0, runsLeft: 0, keptFields: [], fieldsMissing: 0, runChangesKept: 0,
      wroteAutomations: false, sendsMessages: false, unfinished: { step: "files", message: "dohc could not reach your server." },
    },
  ]);
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("Undid 2 runs of automations ana@example.com changed.")).toBeTruthy();
  // Stop and restore again, from History.
  act(() => f.shell().retry(WORKSPACE, ANA, "stop"));
  expect(await screen.findByText("dohc has not finished restoring files.")).toBeTruthy();
  expect(screen.getByText("Undid 2 runs of automations ana@example.com changed.")).toBeTruthy();
  expect(screen.getByTestId("stop-and-restore-outcome").textContent).not.toMatch(/not finished undoing runs/);
});

it("shows one kept record and field across retry, and opens that record", async () => {
  const result: StopAndRestoreResult = {
    status: "restored", restored: [], review: [{ path: "trip/Tasks/automations.yaml", reason: "changed-since" }],
    runsUndone: 1, runsLeft: 0, keptFields: [KEPT], fieldsMissing: 0, runChangesKept: 1,
    wroteAutomations: true, sendsMessages: false, unfinished: { step: "runs", message: "The workspace engine is not running." },
  };
  const f = fixture([result, { ...result, runsUndone: 0, unfinished: null }]);
  await screen.findByRole("combobox", { name: "Who to stop" });
  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  await screen.findByText("1 field kept a later value.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull());
  const button = screen.getByRole("button", { name: KEPT.path });
  expect(screen.getAllByRole("button", { name: KEPT.path })).toHaveLength(1);
  const row = within(button.closest("li")!);
  expect(row.getByText(KEPT.field)).toBeTruthy();
  expect(row.getByText("Restore it from this record's History.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "trip/Tasks/automations.yaml" })).toBeTruthy();
  fireEvent.click(button);
  expect(f.props.onOpenFile).toHaveBeenCalledExactlyOnceWith(KEPT.path);
});

it("keeps an unlocated field visible without an open button", async () => {
  fixture([{
    status: "restored", restored: [], review: [], runsUndone: 1, runsLeft: 0,
    keptFields: [{ ...KEPT, path: null, field: "Status" }], fieldsMissing: 0, runChangesKept: 1,
    wroteAutomations: true, sendsMessages: false, unfinished: null,
  }]);
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("Status")).toBeTruthy();
  const row = screen.getByText("Status").closest("li")!;
  expect(within(row).getByText("Find this record in its Collection to restore the field.")).toBeTruthy();
  expect(within(row).queryByRole("button")).toBeNull();
});

it("distinguishes dataset records and opens their Collection for manual restoration", async () => {
  const f = fixture([{
    status: "restored", restored: [], review: [], runsUndone: 2, runsLeft: 0,
    keptFields: [
      { ...KEPT, path: "Budget", recordId: "a", field: "Status" },
      { ...KEPT, id: "a".repeat(32), path: "Budget", recordId: 7, field: "Status" },
    ], fieldsMissing: 0, runChangesKept: 2, wroteAutomations: true, sendsMessages: false, unfinished: null,
  }]);
  fireEvent.click(await screen.findByTestId("stop-and-restore-confirm"));
  for (const record of ["a", 7]) {
    const row = within((await screen.findByText(`Record ${record} · Status`)).closest("li")!);
    expect(row.getByText("Check previous values in Collection History. Edit this record to restore the field.")).toBeTruthy();
    fireEvent.click(row.getByRole("button", { name: "Budget" }));
  }
  expect(f.props.onOpenCollection.mock.calls).toEqual([["Budget"], ["Budget"]]);
  expect(f.props.onOpenFile).not.toHaveBeenCalled();
});
