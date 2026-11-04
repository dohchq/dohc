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
async function listAfterActivity(bridge: ReturnType<typeof makeBridge>, paths: string[], marker: string, cached = false) {
  bridge.listWorkspaceFiles.mockResolvedValue({ ...listing(...paths, marker), ...(cached ? { cached: true } : {}) });
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

it("a failed move's toast and Notices row stay when its file goes but nothing arrives where it was going", async () => {
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), { moveWorkspacePath: vi.fn().mockRejectedValue(LIVE_MOVE_REFUSAL) });
  const user = userEvent.setup();
  renderShell(bridge);
  await rename(user);
  await screen.findByTestId("workspace-shell-error");
  // A delete of a.md, or a move of it to another name.
  await listAfterActivity(bridge, ["b.md"], "c.md");
  expect(screen.getByTestId("workspace-shell-error").textContent).toContain(REFUSAL_WORDS);
  expect(await noticeRows(user)).toHaveLength(1);
});

const TAKEN_WORDS = "renamed.md already exists.";
const TAKEN = new Error(`Error invoking remote method 'desktop:move-workspace-path': Error: ${TAKEN_WORDS} Choose another destination, or move with overwrite.`);

// Renames a.md to renamed.md from the tree, and fails it with `cause` after a
// listing of `during` lands while the rename runs. Resolves once the listing
// the tree asks for after the failure, of `after`, has landed.
async function failWhileListed(bridge: ReturnType<typeof makeBridge> & { moveWorkspacePath: ReturnType<typeof vi.fn> }, user: ReturnType<typeof userEvent.setup>, during: string[], cause: unknown, after = during) {
  const held = deferred<never>();
  bridge.moveWorkspacePath.mockImplementationOnce(() => held.promise);
  await rename(user);
  await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(1));
  await listAfterActivity(bridge, during, "c.md");
  bridge.listWorkspaceFiles.mockResolvedValue(listing(...after, "refreshed.md"));
  held.reject(cause);
  await waitFor(() => expect(screen.queryAllByTestId("tree-row").some((row) => row.dataset.path === "refreshed.md")).toBe(true));
}

// The agent's move lands before the tree's own attempt fails.
it("a failed move's toast and Notices row go when the listing after the failure shows the same move made", async () => {
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), { moveWorkspacePath: vi.fn() });
  const user = userEvent.setup();
  renderShell(bridge);
  await failWhileListed(bridge, user, ["renamed.md", "b.md"], LIVE_MOVE_REFUSAL);
  await waitFor(() => expect(screen.queryByTestId("workspace-shell-error")).toBeNull());
  expect(await noticeRows(user)).toEqual([]);
});

// Main moves the file on disk before the engine records the move, and undoes
// it when the engine refuses. A listing taken in between shows the move made.
it("a failed move keeps its toast and Notices row when a listing during the move showed it made, and main undid it", async () => {
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), { moveWorkspacePath: vi.fn() });
  const user = userEvent.setup();
  renderShell(bridge);
  await failWhileListed(bridge, user, ["renamed.md", "b.md"], LIVE_MOVE_REFUSAL, ["a.md", "b.md"]);
  expect(screen.getByTestId("workspace-shell-error").textContent).toContain(REFUSAL_WORDS);
  expect(await noticeRows(user)).toHaveLength(1);
  // Main's cache can still hold the walk taken mid-move.
  await listAfterActivity(bridge, ["renamed.md", "b.md"], "d.md", true);
  expect(screen.getByTestId("workspace-shell-error").textContent).toContain(REFUSAL_WORDS);
  expect(await noticeRows(user)).toHaveLength(1);
});

// With renamed.md already there, a listing without a.md could be a delete, so
// an agent's overwrite keeps the row. Its Try again then says why it fails,
// and the person can dismiss it.
it("after an agent overwrites the taken name, the failed move's Try again says the file is gone, and its row dismisses", async () => {
  const GONE_WORDS = "The file or folder is not there anymore.";
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), { moveWorkspacePath: vi.fn() });
  const user = userEvent.setup();
  renderShell(bridge);
  await failWhileListed(bridge, user, ["a.md", "b.md", "renamed.md"], TAKEN);
  await listAfterActivity(bridge, ["b.md", "renamed.md"], "d.md");
  expect(await noticeRows(user, TAKEN_WORDS)).toHaveLength(1);
  // What main sends for a move whose source is gone.
  bridge.moveWorkspacePath.mockRejectedValueOnce(new Error("Error invoking remote method 'desktop:move-workspace-path': Error [ENOENT]: ENOENT: no such file or directory, lstat 'a.md'"));
  await user.click(screen.getByTestId("notice-center-toggle"));
  const row = () => shownRows().find((candidate) => [TAKEN_WORDS, GONE_WORDS].some((words) => candidate.textContent?.includes(words)));
  await user.click(within(row()!).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(row()?.textContent).toContain(`dohc could not change these files. ${GONE_WORDS}`));
  expect(shownRows().filter((candidate) => candidate.textContent?.includes(TAKEN_WORDS))).toEqual([]);
  await user.click(within(row()!).getByRole("button", { name: "Dismiss notice" }));
  await waitFor(() => expect(row()).toBeUndefined());
});

it("a move that failed onto a taken name loses its row once that name is free and an agent makes the move", async () => {
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), { moveWorkspacePath: vi.fn() });
  const user = userEvent.setup();
  renderShell(bridge);
  await failWhileListed(bridge, user, ["a.md", "b.md", "renamed.md"], TAKEN);
  expect(await noticeRows(user, TAKEN_WORDS)).toHaveLength(1);
  // renamed.md is deleted, then the agent moves a.md there.
  await listAfterActivity(bridge, ["a.md", "b.md"], "d.md");
  expect(await noticeRows(user, TAKEN_WORDS)).toHaveLength(1);
  await listAfterActivity(bridge, ["renamed.md", "b.md"], "e.md");
  await waitFor(() => expect(screen.queryByTestId("workspace-shell-error")).toBeNull());
  expect(await noticeRows(user, TAKEN_WORDS)).toEqual([]);
});

// After the person moves the file again from the tree, to any name, the
// failed move's Try again would fail, so its row goes.
it("a later move of the same file from the tree, to another name, takes the failed move's toast and Notices row", async () => {
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    moveWorkspacePath: vi.fn().mockRejectedValueOnce(LIVE_MOVE_REFUSAL).mockResolvedValue({ path: "other.md", undo: { available: false, reason: "" } }),
  });
  const user = userEvent.setup();
  renderShell(bridge);
  await rename(user);
  await screen.findByTestId("workspace-shell-error");
  expect(await noticeRows(user)).toHaveLength(1);
  await rename(user, "other.md");
  await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(2));
  expect(bridge.moveWorkspacePath).toHaveBeenLastCalledWith(expect.objectContaining({ fromPath: "a.md", toPath: "other.md" }));
  await waitFor(() => expect(screen.queryByTestId("workspace-shell-error")).toBeNull());
  expect(await noticeRows(user)).toEqual([]);
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
