// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { WORKSPACE, makeBridge, renderShell } from "./DesktopWorkspaceShell.testHarness";

// #3089: what main sends when the engine refuses a person's move of a shared
// live page whose accepted edit isn't in the file yet, as the two-daemon test
// meets it.
const LIVE_MOVE_REFUSAL = new Error(
  "Error invoking remote method 'desktop:move-workspace-path': Error: dohc could not move a.md. This action is unavailable for shared live files. Continue editing at the current location.",
);
const REFUSAL_WORDS = "This action is unavailable for shared live files.";

const shownRows = () => screen.queryAllByRole("listitem").filter((row) => row.hasAttribute("data-notice-row"));

async function noticeRows(user: ReturnType<typeof userEvent.setup>, words = REFUSAL_WORDS) {
  await user.click(screen.getByTestId("notice-center-toggle"));
  const rows = shownRows().filter((row) => row.textContent?.includes(words));
  await user.click(screen.getByTestId("notice-center-toggle"));
  return rows;
}

async function rename(user: ReturnType<typeof userEvent.setup>, name = "renamed.md") {
  const row = (await screen.findAllByTestId("tree-row")).find((candidate) => candidate.dataset.path === "a.md")!;
  await user.click(row);
  await user.keyboard("{F2}");
  const input = await screen.findByTestId("tree-edit-input");
  await user.clear(input);
  await user.type(input, `${name}{Enter}`);
}

const listing = (...paths: string[]) => ({
  visibility: { status: "ready" as const, rules: [] },
  files: paths.map((path) => ({ path, kind: "file" as const })),
  folders: [],
});

// The shell hears of a change made outside the tree as workspace activity,
// then lists the files again. `marker` is a file only this listing holds, so
// its row in the tree shows that the listing has landed.
async function listAfterActivity(bridge: ReturnType<typeof makeBridge>, paths: string[], marker: string) {
  bridge.listWorkspaceFiles.mockResolvedValue(listing(...paths, marker));
  act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId }));
  await waitFor(() => expect(screen.queryAllByTestId("tree-row").some((row) => row.dataset.path === marker)).toBe(true));
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

// The timeout path: a move held by a guard that gave up still succeeds, and
// the guard itself reports nothing.
it("a move that waited out the guard leaves no toast, Notices row or move identity", async () => {
  const held = deferred<{ path: string; undo: { available: false; reason: string } }>();
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), { moveWorkspacePath: vi.fn(() => held.promise) });
  const user = userEvent.setup();
  renderShell(bridge);
  await rename(user);
  await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(1));
  held.resolve({ path: "renamed.md", undo: { available: false, reason: "" } });
  await waitFor(() => expect(screen.queryAllByTestId("tree-row").some((row) => row.dataset.path === "renamed.md")).toBe(true));
  expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  await user.click(screen.getByTestId("notice-center-toggle"));
  expect(shownRows().filter((row) => row.textContent?.includes("a.md"))).toEqual([]);
});

// #3095: an agent's move through the CLI or MCP runs in main, which records it
// like any other change. Both reach this window by one path: workspace
// activity, then a new listing. So one test covers both.
it("a failed move's toast and Notices row go once an agent makes the same move through the CLI or MCP", async () => {
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), { moveWorkspacePath: vi.fn().mockRejectedValue(LIVE_MOVE_REFUSAL) });
  const user = userEvent.setup();
  renderShell(bridge);
  await rename(user);
  await screen.findByTestId("workspace-shell-error");
  expect(await noticeRows(user)).toHaveLength(1);
  // A change that leaves a.md where it was keeps the failure.
  await listAfterActivity(bridge, ["a.md", "b.md"], "c.md");
  expect(screen.getByTestId("workspace-shell-error").textContent).toContain(REFUSAL_WORDS);
  expect(await noticeRows(user)).toHaveLength(1);
  // The agent's move of a.md to renamed.md.
  await listAfterActivity(bridge, ["renamed.md", "b.md"], "d.md");
  await waitFor(() => expect(screen.queryByTestId("workspace-shell-error")).toBeNull());
  expect(await noticeRows(user)).toEqual([]);
  expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(1);
});

// The same move is the same source and destination. A move of the file to
// another name has not made the move that failed.
it("a different move of the same file keeps the failed move's Notices row", async () => {
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    moveWorkspacePath: vi.fn().mockRejectedValueOnce(LIVE_MOVE_REFUSAL).mockResolvedValue({ path: "other.md", undo: { available: false, reason: "" } }),
  });
  const user = userEvent.setup();
  renderShell(bridge);
  await rename(user);
  await screen.findByTestId("workspace-shell-error");
  await rename(user, "other.md");
  await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(2));
  expect(bridge.moveWorkspacePath).toHaveBeenLastCalledWith(expect.objectContaining({ fromPath: "a.md", toPath: "other.md" }));
  await listAfterActivity(bridge, ["other.md", "b.md"], "c.md");
  expect(await noticeRows(user)).toHaveLength(1);
});

// A rename refused while History is off has no Try again. The person renames
// the page again from the tree once History records again.
it("a rename refused while History is off goes from the toast and Notices once the same rename succeeds from the tree", async () => {
  const TITLE = `dohc can't rename "a.md" while History is off`;
  const BODY = "Without History, dohc can't check whether this page has live editing on. Restart dohc to try again.";
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    moveWorkspacePath: vi.fn()
      .mockRejectedValueOnce(new Error(`Error invoking remote method 'desktop:move-workspace-path': HistoryOffError: ${TITLE}\n${BODY}`))
      .mockResolvedValue({ path: "renamed.md", undo: { available: false, reason: "" } }),
  });
  const user = userEvent.setup();
  renderShell(bridge);
  await rename(user);
  const toast = await screen.findByTestId("workspace-shell-error");
  expect(toast.textContent).toContain(TITLE);
  expect(await noticeRows(user, TITLE)).toHaveLength(1);
  await rename(user);
  await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(2));
  expect(bridge.moveWorkspacePath.mock.calls[1]).toEqual(bridge.moveWorkspacePath.mock.calls[0]);
  await waitFor(() => expect(screen.queryByTestId("workspace-shell-error")).toBeNull());
  expect(await noticeRows(user, TITLE)).toEqual([]);
});
