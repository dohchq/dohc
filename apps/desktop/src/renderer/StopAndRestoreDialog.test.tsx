// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StopAndRestoreResult } from "../ipc/bridgeContract";
import { StopAndRestoreDialog, useStopAndRestore } from "./StopAndRestoreDialog";

const WORKSPACE = "workspace";
const ANA = { target: { kind: "person", userId: "user_ana" }, label: "ana@example.com (Edit)" } as const;
const LINK = { target: { kind: "link", grantId: "grant-link" }, label: "Edit link" } as const;
const row = (overrides: Record<string, unknown>) => ({
  shareId: "share", workspaceId: WORKSPACE, grantId: "grant", recipientUserId: "user_ana", recipientEmail: "ana@example.com",
  access: "edit", revokedAtMs: null, generation: 1, createdAtMs: 1, shareCode: "code", selector: { paths: ["trip"], versionId: null },
  ...overrides,
});

function fixture(results: Array<StopAndRestoreResult | Error>, first: typeof ANA | typeof LINK = ANA) {
  const stopAndRestore = vi.fn(async () => {
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
  act(() => shell.open(first));
  return { props, release, stopAndRestore, undoStopAndRestore, shell: () => shell };
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
    fieldsKept: 0, fieldsMissing: 0, runChangesKept: 0, wroteAutomations: false, sendsMessages: false,
    errorMessage: null,
  }]);
  const person = await screen.findByRole("combobox", { name: "Who to stop" });
  expect([...(person as HTMLSelectElement).options].map((option) => option.text)).toEqual(["ana@example.com", "bob@example.com", "Edit link to trip"]);
  expect(screen.getByText("ana@example.com loses Edit access to this workspace. Share again to give it back.")).toBeTruthy();

  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("Stopped ana@example.com's access and restored 1 file.")).toBeTruthy();
  expect(f.stopAndRestore).toHaveBeenCalledWith({ workspaceId: WORKSPACE, target: { kind: "person", userId: "user_ana" } });
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
    { status: "restored", restored: [], review: [], runsUndone: 0, runsLeft: 0, fieldsKept: 0, fieldsMissing: 0, runChangesKept: 0, wroteAutomations: false, sendsMessages: false, errorMessage: null },
  ]);
  fireEvent.change(await screen.findByRole("combobox", { name: "Who to stop" }), { target: { value: "person:user_bob" } });
  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("Access stopped. dohc has not received all of bob@example.com's changes yet. Try again in a moment.")).toBeTruthy();
  expect(f.props.onRestored).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Try again"));
  expect(await screen.findByText("Stopped bob@example.com's access and restored 0 files.")).toBeTruthy();
  expect(f.stopAndRestore).toHaveBeenLastCalledWith({ workspaceId: WORKSPACE, target: { kind: "person", userId: "user_bob" } });
});

it("reports failures through the shell, and a Try again after closing opens the dialog again with Undo for every file", async () => {
  const f = fixture([
    {
      status: "restored",
      restored: [{ path: "trip/packing/automations.yaml", restoredMomentId: "back-1" }],
      review: [],
      runsUndone: 0,
      runsLeft: 0,
      fieldsKept: 0, fieldsMissing: 0, runChangesKept: 0, wroteAutomations: false, sendsMessages: false,
      errorMessage: "The workspace engine is not running.",
    },
    new Error("dohc could not reach the relay."),
    { status: "restored", restored: [{ path: "trip/packing/collection.yaml", restoredMomentId: "back-2" }], review: [], runsUndone: 1, runsLeft: 0, fieldsKept: 0, fieldsMissing: 0, runChangesKept: 0, wroteAutomations: false, sendsMessages: false, errorMessage: null },
  ]);
  await screen.findByRole("combobox", { name: "Who to stop" });
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
  expect(f.shell().receipts.get(WORKSPACE, ANA.target)).toEqual([]);
});

it("ends a whole Edit link, says it stops for everyone, and never claims its automations' effects are all undone", async () => {
  const f = fixture([{
    status: "restored",
    restored: [{ path: "trip/packing/automations.yaml", restoredMomentId: "back-1" }],
    review: [{ path: "trip/packing/collection.yaml", reason: "changed-since" }],
    fieldsKept: 0, fieldsMissing: 0, runsUndone: 1, runsLeft: 1, runChangesKept: 2, wroteAutomations: true, sendsMessages: true, errorMessage: null,
  }], LINK);
  const who = await screen.findByRole("combobox", { name: "Who to stop" });
  expect((who as HTMLSelectElement).value).toBe("link:grant-link");
  expect(screen.getByText("Edit link to trip stops working for everyone who has it, including people who opened it in dohc. Share again to give access back.")).toBeTruthy();

  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("Ended Edit link to trip and restored 1 file.")).toBeTruthy();
  expect(f.stopAndRestore).toHaveBeenCalledWith({ workspaceId: WORKSPACE, target: { kind: "link", grantId: "grant-link" } });
  expect(screen.getByText("Undid 1 run of automations written through Edit link to trip.")).toBeTruthy();
  expect(screen.getByText("dohc could not undo 1 run of automations written through Edit link to trip. Undo each from its Collection's run history.")).toBeTruthy();
  expect(screen.getByText("2 changes from those runs stay as they are. Undo cannot reverse them, or someone changed them since.")).toBeTruthy();
  expect(screen.getByText("Messages and notices from automations written through Edit link to trip stay sent.")).toBeTruthy();
  expect(screen.getByText("Runs on your other computers are not undone here. Undo them from the run history on each computer.")).toBeTruthy();
  expect(screen.getByText("Someone changed it after the link.")).toBeTruthy();

  fireEvent.click(screen.getByTestId("stop-and-restore-undo"));
  expect(await screen.findByText("Put back 1 file as Edit link to trip left them. The link stays ended.")).toBeTruthy();
  expect(f.undoStopAndRestore).toHaveBeenCalledWith({ workspaceId: WORKSPACE, restoredMomentIds: ["back-1"] });
});

it("carries forward what undoing runs found when a try stopped part way", async () => {
  const none = { fieldsKept: 0, fieldsMissing: 0, review: [], runsLeft: 0, wroteAutomations: true, sendsMessages: false };
  const f = fixture([
    { status: "restored", restored: [], ...none, runsUndone: 1, runChangesKept: 2, errorMessage: "The workspace engine is not running." },
    { status: "restored", restored: [], ...none, runsUndone: 1, runChangesKept: 1, errorMessage: null },
  ]);
  await screen.findByRole("combobox", { name: "Who to stop" });
  fireEvent.click(screen.getByTestId("stop-and-restore-confirm"));
  expect(await screen.findByText("2 changes from those runs stay as they are. Undo cannot reverse them, or someone changed them since.")).toBeTruthy();
  act(() => f.props.onError.mock.calls[0]![2]());
  expect(await screen.findByText("Undid 2 runs of automations ana@example.com wrote.")).toBeTruthy();
  expect(screen.getByText("3 changes from those runs stay as they are. Undo cannot reverse them, or someone changed them since.")).toBeTruthy();
});

it("keeps the runs a try undid after the files are undone, and after the dialog closed during the try", async () => {
  const none = { fieldsKept: 0, fieldsMissing: 0, review: [], runsLeft: 0, wroteAutomations: true, sendsMessages: false };
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const f = fixture([
    { status: "restored", restored: [{ path: "trip/a.yaml", restoredMomentId: "back-1" }], ...none, runsUndone: 2, runChangesKept: 1, errorMessage: null },
    { status: "restored", restored: [], ...none, runsUndone: 0, runChangesKept: 0, errorMessage: null },
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
  expect(screen.getByText("Undid 2 runs of automations ana@example.com wrote.")).toBeTruthy();

  // A new try passes over the runs already undone, and still names them.
  act(() => f.shell().retry(WORKSPACE, ANA, "stop"));
  expect(await screen.findByText("Stopped ana@example.com's access and restored 0 files.")).toBeTruthy();
  expect(screen.getByText("Undid 2 runs of automations ana@example.com wrote.")).toBeTruthy();
  expect(screen.getByText("1 change from those runs stay as they are. Undo cannot reverse them, or someone changed them since.")).toBeTruthy();
});
