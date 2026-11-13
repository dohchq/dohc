// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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

const shownRows = () =>
  screen.queryAllByRole("listitem").filter((row) => row.hasAttribute("data-notice-row"));

async function noticeRows(user: ReturnType<typeof userEvent.setup>, words = REFUSAL_WORDS) {
  await user.click(screen.getByTestId("notice-center-toggle"));
  const rows = shownRows().filter((row) => row.textContent?.includes(words));
  await user.click(screen.getByTestId("notice-center-toggle"));
  return rows;
}

async function rename(user: ReturnType<typeof userEvent.setup>, name = "renamed.md") {
  const row = (await screen.findAllByTestId("tree-row")).find(
    (candidate) => candidate.dataset.path === "a.md",
  )!;
  await user.click(row);
  await user.keyboard("{F2}");
  const input = await screen.findByTestId("tree-edit-input");
  await user.clear(input);
  await user.type(input, `${name}{Enter}`);
}

const listing = (...paths: string[]) => ({
  visibility: { status: "ready" as const, rules: [] },
  files: paths.map((path) => ({ path, kind: "file" as const })),
  // Each file's folder, as main lists it.
  folders: [
    ...new Set(
      paths
        .filter((path) => path.includes("/"))
        .map((path) => path.slice(0, path.lastIndexOf("/"))),
    ),
  ],
});

const listed = (marker: string) =>
  screen.queryAllByTestId("tree-row").some((row) => row.dataset.path === marker);

// The shell hears of a change made outside the tree as workspace activity,
// then lists the files again. `marker` is a file only this listing holds, so
// its row in the tree shows that the listing has landed. Activity that names
// its `changed` paths lists through main's cache.
async function listAfterActivity(
  bridge: ReturnType<typeof makeBridge>,
  paths: string[],
  marker: string,
  changed?: string[],
) {
  bridge.listWorkspaceFiles.mockResolvedValue(listing(...paths, marker));
  act(() =>
    bridge.emitWorkspaceActivity({
      workspaceId: WORKSPACE.workspaceId,
      ...(changed ? { paths: changed } : {}),
    }),
  );
  await waitFor(() => expect(listed(marker)).toBe(true));
}

const allowedCache = (bridge: ReturnType<typeof makeBridge>) =>
  bridge.listWorkspaceFiles.mock.calls.map(([payload]) => payload.allowCached === true);

function refusedOnce() {
  const moveWorkspacePath = vi
    .fn()
    .mockRejectedValueOnce(LIVE_MOVE_REFUSAL)
    .mockResolvedValue({ path: "renamed.md", undo: { available: false, reason: "" } });
  return Object.assign(makeBridge(Promise.resolve(null)), { moveWorkspacePath });
}

const BATCH_WORDS = `dohc could not move "a.md" and "b.md".`;

function refusedBatch() {
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    moveWorkspacePath: vi.fn().mockRejectedValue(LIVE_MOVE_REFUSAL),
  });
  bridge.listWorkspaceFiles.mockResolvedValue(listing("a.md", "b.md", "docs/z.md", "notes/n.md"));
  return bridge;
}

// Selects a.md and b.md, then drags them onto `folder`.
async function dragSelection(user: ReturnType<typeof userEvent.setup>, folder: string) {
  const row = async (path: string) =>
    (await screen.findAllByTestId("tree-row")).find(
      (candidate) => candidate.dataset.path === path,
    )!;
  await user.click(await row("a.md"));
  await user.keyboard("{Shift>}");
  await user.click(await row("b.md"));
  await user.keyboard("{/Shift}");
  const dataTransfer = {
    effectAllowed: "move",
    dropEffect: "move",
    files: [],
    types: [],
    setData: vi.fn(),
  };
  fireEvent.dragStart(await row("a.md"), { dataTransfer });
  fireEvent.dragOver(await row(folder), { dataTransfer });
  fireEvent.drop(await row(folder), { dataTransfer });
}

async function failWhileListed(
  bridge: ReturnType<typeof makeBridge> & { moveWorkspacePath: ReturnType<typeof vi.fn> },
  user: ReturnType<typeof userEvent.setup>,
  during: string[],
  cause: unknown,
  after = during,
) {
  const held = deferred<never>();
  bridge.moveWorkspacePath.mockImplementationOnce(() => held.promise);
  await rename(user);
  await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(1));
  await listAfterActivity(bridge, during, "c.md");
  bridge.listWorkspaceFiles.mockResolvedValue(listing(...after, "refreshed.md"));
  held.reject(cause);
  await waitFor(() => expect(listed("refreshed.md")).toBe(true));
}

it("a refused move's Try again runs the same move, and its success clears the toast and the Notices row", async () => {
  const bridge = refusedOnce();
  const user = userEvent.setup();
  renderShell(bridge);
  await rename(user);
  const toast = await screen.findByTestId("workspace-shell-error");
  expect(toast.textContent).toContain(REFUSAL_WORDS);
  expect(await noticeRows(user)).toHaveLength(1);
  await user.click(
    within(screen.getByTestId("workspace-shell-error")).getByTestId("workspace-shell-error-retry"),
  );
  await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(2));
  expect(bridge.moveWorkspacePath.mock.calls[1]).toEqual(bridge.moveWorkspacePath.mock.calls[0]);
  expect(bridge.moveWorkspacePath.mock.calls[0]![0]).toMatchObject({
    workspaceId: WORKSPACE.workspaceId,
    fromPath: "a.md",
    toPath: "renamed.md",
  });
  await waitFor(() => expect(screen.queryByTestId("workspace-shell-error")).toBeNull());
  expect(await noticeRows(user)).toEqual([]);
});

it("a dragged selection's failed notice goes once an agent makes one of its moves through the CLI or MCP", async () => {
  const bridge = refusedBatch();
  const user = userEvent.setup();
  renderShell(bridge);
  await dragSelection(user, "docs");
  await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(2));
  expect(bridge.moveWorkspacePath.mock.calls.map(([input]) => input.toPath).sort()).toEqual([
    "docs/a.md",
    "docs/b.md",
  ]);
  expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(BATCH_WORDS);
  expect(await noticeRows(user, BATCH_WORDS)).toHaveLength(1);
  // A change that leaves both files where they were keeps the notice.
  await listAfterActivity(bridge, ["a.md", "b.md", "docs/z.md", "notes/n.md"], "c.md");
  expect(await noticeRows(user, BATCH_WORDS)).toHaveLength(1);
  // The agent moves a.md into docs.
  await listAfterActivity(bridge, ["docs/a.md", "b.md", "docs/z.md", "notes/n.md"], "d.md", [
    "a.md",
    "docs/a.md",
  ]);
  await waitFor(() => expect(screen.queryByTestId("workspace-shell-error")).toBeNull());
  expect(await noticeRows(user, BATCH_WORDS)).toEqual([]);
});

it("a failed move keeps its toast and Notices row when a listing during the move showed it made, and main undid it", async () => {
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), { moveWorkspacePath: vi.fn() });
  const user = userEvent.setup();
  renderShell(bridge);
  await failWhileListed(bridge, user, ["renamed.md", "b.md"], LIVE_MOVE_REFUSAL, ["a.md", "b.md"]);
  expect(screen.getByTestId("workspace-shell-error").textContent).toContain(REFUSAL_WORDS);
  expect(await noticeRows(user)).toHaveLength(1);
  // A listing through main's cache can join a walk that started mid-move.
  // The full listing that confirms it shows a.md back.
  bridge.listWorkspaceFiles
    .mockResolvedValueOnce(listing("renamed.md", "b.md", "d.md"))
    .mockResolvedValue(listing("a.md", "b.md", "e.md"));
  act(() =>
    bridge.emitWorkspaceActivity({
      workspaceId: WORKSPACE.workspaceId,
      paths: ["a.md", "renamed.md"],
    }),
  );
  await waitFor(() => expect(listed("e.md")).toBe(true));
  expect(allowedCache(bridge).slice(-2)).toEqual([true, false]);
  expect(screen.getByTestId("workspace-shell-error").textContent).toContain(REFUSAL_WORDS);
  expect(await noticeRows(user)).toHaveLength(1);
});
