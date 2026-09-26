// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StopAndRestorePersonResult } from "../ipc/bridgeContract";
import { StopAndRestoreDialog, useStopAndRestore } from "./StopAndRestoreDialog";

const WORKSPACE = "workspace";
const ANA = { userId: "user_ana", label: "ana@example.com (Edit)" };
const row = (overrides: Record<string, unknown>) => ({
  shareId: "share", workspaceId: WORKSPACE, grantId: "grant", recipientUserId: "user_ana", recipientEmail: "ana@example.com",
  access: "edit", revokedAtMs: null, generation: 1, createdAtMs: 1, shareCode: "code", selector: { paths: ["trip"], versionId: null },
  ...overrides,
});

function fixture(results: Array<StopAndRestorePersonResult | Error>) {
  const stopAndRestorePerson = vi.fn(async () => {
    const next = results.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  const undoStopAndRestore = vi.fn(async () => undefined);
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
    stopAndRestorePerson,
    undoStopAndRestore,
  } as unknown as typeof window.dohcDesktop;
  const release = vi.fn();
  const props = {
    onBeforeRestore: vi.fn(async () => release),
    onRestored: vi.fn(),
    onOpenFile: vi.fn(),
    onError: vi.fn<(fallback: string, error: unknown, retry: () => void) => void>(),
  };
  // The shell's part: it holds the dialog and the files put back.
  let shell!: ReturnType<typeof useStopAndRestore>;
  function Shell() {
    shell = useStopAndRestore(WORKSPACE);
    const session = shell.session;
    return session ? (
      <StopAndRestoreDialog
        key={session.key}
        workspaceId={WORKSPACE}
        person={session.person}
        start={session.start}
        receipts={shell.receipts}
        onRetry={shell.retry}
        onClose={shell.close}
        {...props}
      />
    ) : null;
  }
  render(<Shell />);
  act(() => shell.open(ANA));
  return { props, release, stopAndRestorePerson, undoStopAndRestore, shell: () => shell };
}

afterEach(() => {
  cleanup();
  delete window.dohcDesktop;
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
    errorMessage: null,
  }]);
  const person = await screen.findByRole("combobox", { name: "Person to stop" });
  expect([...(person as HTMLSelectElement).options].map((option) => option.text)).toEqual(["ana@example.com", "bob@example.com"]);
  expect(screen.getByText("ana@example.com loses Edit access to this workspace. Share again to give it back.")).toBeTruthy();

  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("Stopped ana@example.com's access and restored 1 file.")).toBeTruthy();
  expect(f.stopAndRestorePerson).toHaveBeenCalledWith({ workspaceId: WORKSPACE, userId: "user_ana" });
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.props.onRestored).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Undid 2 runs of automations ana@example.com wrote.")).toBeTruthy();
  fireEvent.click(screen.getByText("trip/packing/automations.yaml"));
  expect(f.props.onOpenFile).toHaveBeenCalledWith("trip/packing/automations.yaml");
  expect(screen.getByText("Someone changed it after ana@example.com.")).toBeTruthy();
  expect(screen.getByText("This Collection holds files someone else added.")).toBeTruthy();
  expect(screen.getByText("dohc could not restore it. This action is unavailable for shared live files.")).toBeTruthy();

  fireEvent.click(screen.getByTestId("stop-and-restore-undo"));
  expect(await screen.findByText("Put back 1 file as ana@example.com left them. Their access stays stopped.")).toBeTruthy();
  expect(f.undoStopAndRestore).toHaveBeenCalledWith({ workspaceId: WORKSPACE, restoredMomentIds: ["back-1"] });
  expect(screen.queryByTestId("stop-and-restore-undo")).toBeNull();
});

it("says access stopped while changes are still arriving, and tries again", async () => {
  const f = fixture([
    { status: "waiting" },
    { status: "restored", restored: [], review: [], runsUndone: 0, runsLeft: 0, errorMessage: null },
  ]);
  fireEvent.change(await screen.findByRole("combobox", { name: "Person to stop" }), { target: { value: "user_bob" } });
  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("Access stopped. dohc has not received all of bob@example.com's changes yet. Try again in a moment.")).toBeTruthy();
  expect(f.props.onRestored).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Try again"));
  expect(await screen.findByText("Stopped bob@example.com's access and restored 0 files.")).toBeTruthy();
  expect(f.stopAndRestorePerson).toHaveBeenLastCalledWith({ workspaceId: WORKSPACE, userId: "user_bob" });
});

it("reports failures through the shell, and a Try again after closing opens the dialog again with Undo for every file", async () => {
  const f = fixture([
    {
      status: "restored",
      restored: [{ path: "trip/packing/automations.yaml", restoredMomentId: "back-1" }],
      review: [],
      runsUndone: 0,
      runsLeft: 0,
      errorMessage: "The workspace engine is not running.",
    },
    new Error("dohc could not reach the relay."),
    { status: "restored", restored: [{ path: "trip/packing/collection.yaml", restoredMomentId: "back-2" }], review: [], runsUndone: 1, runsLeft: 0, errorMessage: null },
  ]);
  await screen.findByRole("combobox", { name: "Person to stop" });
  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("Stopped ana@example.com's access and restored 1 file.")).toBeTruthy();
  const [fallback, error] = f.props.onError.mock.calls[0]!;
  expect(fallback).toBe("dohc could not stop ana@example.com and restore their changes.");
  expect((error as Error).message).toBe("The workspace engine is not running.");
  expect(screen.queryByRole("alert")).toBeNull();

  // The person closes the dialog, then uses Try again from the Notices row.
  fireEvent.click(screen.getByText("Close"));
  expect(screen.queryByTestId("stop-and-restore-dialog")).toBeNull();
  act(() => f.props.onError.mock.calls[0]![2]());
  await waitFor(() => expect(f.props.onError).toHaveBeenCalledTimes(2));
  expect((f.props.onError.mock.calls[1]![1] as Error).message).toBe("dohc could not reach the relay.");
  // The reopened dialog keeps the earlier outcome and its Undo.
  expect(await screen.findByText("Stopped ana@example.com's access and restored 1 file.")).toBeTruthy();
  expect(screen.getByTestId("stop-and-restore-undo")).toBeTruthy();

  act(() => f.props.onError.mock.calls[1]![2]());
  expect(await screen.findByText("Stopped ana@example.com's access and restored 2 files.")).toBeTruthy();
  fireEvent.click(screen.getByTestId("stop-and-restore-undo"));
  await waitFor(() => expect(f.undoStopAndRestore).toHaveBeenCalledWith({ workspaceId: WORKSPACE, restoredMomentIds: ["back-1", "back-2"] }));
  expect(f.shell().receipts.get(WORKSPACE, "user_ana")).toEqual([]);
});
