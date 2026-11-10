// @vitest-environment jsdom
import { StrictMode, useState } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { HeldNoteChangeResult } from "../ipc/bridgeContract";
import { HeldNoteDrop, waitingAuthors } from "./HeldNoteDrop";
import { useShellError } from "./shell/useShellError";
import { NoticeCenter, WorkspaceErrorToast } from "./workbench/NoticeCenter";

const heldNoteChange = vi.hoisted(() => vi.fn());
vi.mock("./bridge", () => ({ bridge: () => ({ heldNoteChange }) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); });
const token = "a".repeat(64);
const review: HeldNoteChangeResult = { path: "note.md", token, authors: [{kind: "human", humanName: "Ice"}, {kind: "agent", agentName: "Codex"}], held: true, historyMomentId: null };

function Harness() {
  const notices = useShellError("workspace");
  const [held, setHeld] = useState(true);
  return <>
    {held ? <HeldNoteDrop workspaceId="workspace" path="note.md" onError={notices.reportButtonError}
      onNotice={(message, undo) => { setHeld(false); notices.showSuccessNotice(message, undo); }} /> : null}
    {notices.shellErrors.map(error => <WorkspaceErrorToast key={error.id}
      error={{...error, canRetry: error.retry !== null, actionLabel: error.action?.label}}
      onAction={notices.runShellErrorAction} onRetry={notices.retryShellError} />)}
  </>;
}

it("names the waiting authors, cancels safely, and offers Undo after the band disappears", async () => {
  const user = userEvent.setup();
  heldNoteChange.mockImplementation(async (input: {action: string}) => ({...review, held: input.action !== "drop", historyMomentId: input.action === "review" ? null : "history"}));
  render(<StrictMode><Harness /></StrictMode>);
  await user.click(screen.getByRole("button", {name: "Drop"}));
  const dialog = await screen.findByRole("dialog", {name: "Drop the held change?"});
  expect(within(dialog).getByText("Waiting edits by Ice, Codex.")).toBeTruthy();
  expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toContain("Waiting edits by Ice, Codex.");
  expect(dialog.textContent).toContain("History keeps the waiting text");
  await user.click(within(dialog).getByRole("button", {name: "Cancel"}));
  expect(heldNoteChange.mock.calls.map(([input]) => input.action)).toEqual(["review"]);
  await user.click(screen.getByRole("button", {name: "Drop"}));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", {name: "Drop"}));
  const toast = await screen.findByRole("status");
  expect(toast.textContent).toContain("Dropped the held change");
  await user.click(within(toast).getByRole("button", {name: "Undo"}));
  await waitFor(() => expect(heldNoteChange.mock.calls.map(([input]) => input.action)).toEqual(["review", "review", "drop", "undo"]));
  expect(heldNoteChange.mock.calls.at(-1)?.[0]).toEqual({workspaceId: "workspace", path: "note.md", action: "undo", token});
  await screen.findByText("Restored the held change");
});

it("keeps Undo when an engine event removes the band before the Drop reply", async () => {
  const onNotice = vi.fn();
  const user = userEvent.setup();
  let finish!: (result: HeldNoteChangeResult) => void;
  heldNoteChange.mockResolvedValueOnce(review).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const mounted = render(<HeldNoteDrop workspaceId="workspace" path="note.md" onNotice={onNotice} />);
  await user.click(screen.getByRole("button", {name: "Drop"}));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", {name: "Drop"}));
  mounted.unmount();
  await act(async () => finish({...review, held: false, historyMomentId: "history"}));
  expect(onNotice).toHaveBeenCalledWith("Dropped the held change", expect.any(Function));
});

it("states unknown provenance without presenting an opaque identity as a name", () => {
  expect(waitingAuthors([{kind: "named", userId: "private-id"}])).toBe("dohc does not know who made the waiting edits.");
  expect(waitingAuthors([{humanName: "Ice"}, {kind: "unattributed"}])).toBe("Waiting edits by Ice. Some edits have no known author.");
});

it("drops a late review when the workspace changes", async () => {
  const user = userEvent.setup();
  let finish!: (result: HeldNoteChangeResult) => void;
  heldNoteChange.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const mounted = render(<HeldNoteDrop workspaceId="first" path="note.md" />);
  await user.click(screen.getByRole("button", {name: "Drop"}));
  mounted.rerender(<HeldNoteDrop workspaceId="second" path="note.md" />);
  await act(async () => finish(review));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", {name: "Drop"}).hasAttribute("disabled")).toBe(false);
});

it("keeps a refused Drop in Notices after its toast closes and retries with a new review", async () => {
  function FailureHarness() {
    const notices = useShellError("workspace");
    return <>
      <HeldNoteDrop workspaceId="workspace" path="note.md" onError={notices.reportButtonError} />
      <NoticeCenter workspaceId="workspace" syncStatus={null} agentActive={false} conflictSummaries={[]}
        onOpenHistory={() => {}} onOpenSettings={() => {}} onOpenConflicts={() => {}}
        onRefreshShareView={() => {}} onRebuildEngineStore={() => {}}
        workspaceErrors={notices.shellErrors.map(error => ({...error, canRetry: error.retry !== null}))}
        onHideWorkspaceError={notices.hideShellError} onRetryWorkspaceError={notices.retryShellError} />
    </>;
  }
  const user = userEvent.setup();
  heldNoteChange.mockResolvedValueOnce(review).mockRejectedValueOnce(new Error("The note changed."))
    .mockResolvedValueOnce({...review, token: "b".repeat(64)});
  render(<FailureHarness />);
  await user.click(screen.getByRole("button", {name: "Drop"}));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", {name: "Drop"}));
  const toast = await screen.findByRole("alert");
  expect(toast.textContent).toContain("dohc could not drop the held change");
  await user.click(within(toast).getByRole("button", {name: "Dismiss workspace error"}));
  await user.click(screen.getByRole("button", {name: /Notices/u}));
  expect(screen.getByText(/dohc could not drop the held change/u)).toBeTruthy();
  await user.click(screen.getByRole("button", {name: "Try again"}));
  expect(await screen.findByRole("dialog", {name: "Drop the held change?"})).toBeTruthy();
  expect(heldNoteChange.mock.calls.map(([input]) => input.action)).toEqual(["review", "drop", "review"]);
});
