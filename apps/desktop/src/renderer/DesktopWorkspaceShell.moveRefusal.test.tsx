// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { WORKSPACE, makeBridge, renderShell } from "./DesktopWorkspaceShell.testHarness";

// #3089: what main sends when the engine refuses a person's move of a shared
// live page whose accepted edit isn't in the file yet, as the two-daemon test
// meets it.
const LIVE_MOVE_REFUSAL = new Error(
  "Error invoking remote method 'desktop:move-workspace-path': Error: dohc could not move a.md. This action is unavailable for shared live files. Continue editing at the current location.",
);
const REFUSAL_WORDS = "This action is unavailable for shared live files.";

const shownRows = () => screen.queryAllByRole("listitem").filter((row) => row.hasAttribute("data-notice-row"));

async function noticeRows(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("notice-center-toggle"));
  const rows = shownRows().filter((row) => row.textContent?.includes(REFUSAL_WORDS));
  await user.click(screen.getByTestId("notice-center-toggle"));
  return rows;
}

async function rename(user: ReturnType<typeof userEvent.setup>) {
  const row = (await screen.findAllByTestId("tree-row")).find((candidate) => candidate.dataset.path === "a.md")!;
  await user.click(row);
  await user.keyboard("{F2}");
  const input = await screen.findByTestId("tree-edit-input");
  await user.clear(input);
  await user.type(input, "renamed.md{Enter}");
}

function refusedOnce() {
  const moveWorkspacePath = vi.fn().mockRejectedValueOnce(LIVE_MOVE_REFUSAL).mockResolvedValue({ path: "renamed.md", undo: { available: false, reason: "" } });
  return Object.assign(makeBridge(Promise.resolve(null)), { moveWorkspacePath });
}

it("a refused move's Try again runs the same move, and its success clears the toast and the Notices row", async () => {
  const bridge = refusedOnce();
  const user = userEvent.setup();
  renderShell(bridge);
  await rename(user);
  const toast = await screen.findByTestId("workspace-shell-error");
  expect(toast.textContent).toContain(REFUSAL_WORDS);
  expect(await noticeRows(user)).toHaveLength(1);
  await user.click(within(screen.getByTestId("workspace-shell-error")).getByTestId("workspace-shell-error-retry"));
  await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(2));
  expect(bridge.moveWorkspacePath.mock.calls[1]).toEqual(bridge.moveWorkspacePath.mock.calls[0]);
  expect(bridge.moveWorkspacePath.mock.calls[0]![0]).toMatchObject({ workspaceId: WORKSPACE.workspaceId, fromPath: "a.md", toPath: "renamed.md" });
  await waitFor(() => expect(screen.queryByTestId("workspace-shell-error")).toBeNull());
  expect(await noticeRows(user)).toEqual([]);
});

it("a later rename of the same page from the Explorer clears the refused move's toast and Notices row", async () => {
  const bridge = refusedOnce();
  const user = userEvent.setup();
  renderShell(bridge);
  await rename(user);
  await screen.findByTestId("workspace-shell-error");
  expect(await noticeRows(user)).toHaveLength(1);
  await rename(user);
  await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByTestId("workspace-shell-error")).toBeNull());
  expect(await noticeRows(user)).toEqual([]);
});
