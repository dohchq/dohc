// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { SyncStatusResult } from "../ipc/bridgeContract";
import { deferred } from "../testing/deferred";
import { makeBridge, renderShell, SYNC_STATUS, WORKSPACE } from "./DesktopWorkspaceShell.testHarness";

afterEach(() => localStorage.clear());

it.each([false, true].flatMap(dismissed => [false, true].map(readFailed => ({ dismissed, readFailed }))))(
  "preserves saved copy state on remount, dismissed=$dismissed, readFailed=$readFailed", async ({ dismissed, readFailed }) => {
  const user = userEvent.setup();
  const status: SyncStatusResult = { ...SYNC_STATUS, outsideWriteCopies: [["n.md", "n (kept copy).md", "copy-n-1"]] };
  const firstBridge = makeBridge(Promise.resolve(null));
  firstBridge.getSyncStatus.mockResolvedValue(status);
  const first = renderShell(firstBridge);
  expect((await screen.findByTestId("workspace-shell-notice")).textContent).toContain("Kept a copy of n.md");
  if (dismissed) {
    await user.click(screen.getByTestId("notice-center-toggle"));
    const row = within(screen.getByTestId("notice-center")).getByText("Kept a copy of n.md").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Dismiss notice" }));
  }
  const key = `dohc:outside-write-copies:${WORKSPACE.workspaceId}`;
  const saved = localStorage.getItem(key);
  expect(JSON.parse(saved!)["copy-n-1"].dismissed).toBe(dismissed);
  first.unmount();

  const answer = deferred<SyncStatusResult>();
  const nextBridge = makeBridge(Promise.resolve(null));
  nextBridge.getSyncStatus.mockImplementation(() => answer.promise);
  renderShell(nextBridge);
  await waitFor(() => expect(nextBridge.getSyncStatus).toHaveBeenCalled());
  expect(localStorage.getItem(key)).toBe(saved);
  await act(async () => answer.resolve({ ...SYNC_STATUS,
    ...(readFailed ? { outsideWriteCopyReadError: "local state not opened" } : {}) }));
  if (readFailed) {
    expect(within(await screen.findByTestId("workspace-shell-error")).getByText("dohc could not list every kept copy")).toBeTruthy();
  }
  expect(localStorage.getItem(key)).toBe(saved);
  expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
  nextBridge.getSyncStatus.mockResolvedValue({ ...status, outsideWriteCopyReadError: null });
  const refreshed = nextBridge.getSyncStatus.mock.calls.length;
  act(() => nextBridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId }));
  await waitFor(() => expect(nextBridge.getSyncStatus.mock.calls.length).toBeGreaterThan(refreshed));
  await user.click(screen.getByTestId("notice-center-toggle"));
  const row = within(screen.getByTestId("notice-center")).queryByText("Kept a copy of n.md");
  expect(row !== null).toBe(!dismissed);
  expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
  expect(localStorage.getItem(key)).toBe(saved);
  expect(screen.queryByText("dohc could not list every kept copy")).toBeNull();
});

it("shows one kept-copy list failure with its cause, retries, and clears it on recovery", async () => {
  const user = userEvent.setup();
  const bridge = makeBridge(Promise.resolve(null));
  let readError: string | null = "C:\\workspace\\.dohc\\local\\outside-write-copies\\broken.json\nInvalid JSON";
  bridge.getSyncStatus.mockImplementation(async () => ({ ...SYNC_STATUS, outsideWriteCopies: [], outsideWriteCopyReadError: readError }));
  renderShell(bridge);
  const title = "dohc could not list every kept copy";
  const message = "To find a copy that isn't listed, look beside its file for (kept copy) in the name.";
  const toast = await screen.findByTestId("workspace-shell-error");
  expect(within(toast).getByText(title)).toBeTruthy();
  expect(within(toast).getByText(message)).toBeTruthy();
  await user.click(within(toast).getByRole("button", { name: "Copy error details" }));
  expect(await navigator.clipboard.readText()).toContain(readError.replaceAll("\n", " "));
  await user.click(screen.getByTestId("notice-center-toggle"));
  const rows = () => within(screen.getByTestId("notice-center")).getAllByText(title);
  expect(rows()).toHaveLength(1);
  const refreshed = bridge.getSyncStatus.mock.calls.length;
  act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId }));
  await waitFor(() => expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(refreshed));
  expect(rows()).toHaveLength(1);
  const listed = bridge.listKeptCopies.mock.calls.length;
  await user.click(within(rows()[0]!.closest("li")!).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(bridge.listKeptCopies.mock.calls.length).toBeGreaterThan(listed));
  await user.click(screen.getByTestId("notice-center-toggle"));
  expect(rows()).toHaveLength(1);
  expect(within(rows()[0]!.closest("li")!).getByText(message)).toBeTruthy();
  readError = null;
  const beforeRecovery = bridge.getSyncStatus.mock.calls.length;
  act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId }));
  await waitFor(() => expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(beforeRecovery));
  await waitFor(() => expect(screen.queryByText(title)).toBeNull());
});
