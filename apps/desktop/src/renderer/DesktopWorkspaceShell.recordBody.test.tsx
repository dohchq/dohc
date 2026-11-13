// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { useState } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceUiState } from "../ipc/bridgeContract";
import type { CollectionPageProps } from "./CollectionPage";
import { deferred } from "../testing/deferred";
import { editorTabTestId } from "../testPins";
import { collectionTabPath } from "./workbench/workbenchState";
import { SHARE_VIEW, STORED_STATE, enterMarkdownSource, holdHistory, makeBridge, makeShareBridge, renderShell, storedStateWithTabs } from "./DesktopWorkspaceShell.testHarness";

// The shell, its file view and the file's editor are real. The Collection's
// page stands aside: it shows what the shell kept for its record panel, draws
// the body the shell gives it for one record's file, and asks the shell to
// save that body before the record leaves the panel, as the page does.
// The file of the record the stand-in page shows open.
const shown = vi.hoisted(() => ({ path: "a.md" }));
beforeEach(() => {
  shown.path = "a.md";
});
vi.mock("./CollectionPage", () => ({
  CollectionPage: (props: CollectionPageProps) => {
    const [open, setOpen] = useState(true);
    const [asked, setAsked] = useState(false);
    const body = open ? props.renderRecordBody?.(shown.path) : null;
    // A body the page then asks the shell for and does not draw, as a render React throws away would.
    if (asked) props.renderRecordBody?.("b.md");
    return (
      <div data-testid="collection-page">
        <output aria-label="Open record">{props.initialOpenRecord ?? "none"}</output>
        <output aria-label="Panel width">{props.initialRecordPanelWidth}</output>
        <output aria-label="Record History">{props.onOpenRecordHistory ? "offered" : "none"}</output>
        <button onClick={() => props.onOpenRecordChange?.("rec_a")}>Open record a</button>
        <button onClick={() => props.onRecordPanelWidthChange?.(640)}>Widen the panel</button>
        <button onClick={() => props.settleRecordBody?.(() => { setOpen(false); props.onOpenRecordChange?.(null); })}>Close the record</button>
        <button onClick={() => setAsked(true)}>Ask for a body and draw none</button>
        {open ? <aside aria-label="Record a">{body}</aside> : null}
      </div>
    );
  },
}));

const tasksTab = collectionTabPath("tasks");
const withTab: WorkspaceUiState = storedStateWithTabs([tasksTab, "b.md"], tasksTab);

function collectionShell(state: WorkspaceUiState = withTab) {
  const bridge = holdHistory(makeBridge(Promise.resolve(state)));
  bridge.listWorkspaceFiles.mockResolvedValue({
    visibility: { status: "ready", rules: [] },
    files: [{ path: "a.md", kind: "file" }, { path: "b.md", kind: "file" }, { path: "tasks/collection.yaml", kind: "file" }],
    folders: ["tasks"],
  });
  renderShell(bridge);
  /** The layout the shell last asked main to save. */
  const saved = () => bridge.setWorkspaceUiState.mock.calls.at(-1)?.[0].state;
  return { bridge, saved };
}
const record = () => screen.getByRole("complementary", { name: "Record a" });
const tab = () => screen.getByTestId(editorTabTestId(tasksTab));

/** Types into the body's text, as source, and waits for the shell to show it unsaved. */
async function typeInBody() {
  const user = userEvent.setup();
  await within(await screen.findByRole("complementary", { name: "Record a" })).findByTestId("view-markdown");
  const editor = await enterMarkdownSource(user, record());
  await user.type(editor, "Draft!");
  await waitFor(() => expect(within(tab()).queryByTestId("tab-dirty")).not.toBeNull());
  return { user, editor };
}

it("opens a document Collection's tab with the record and the panel width its saved layout kept, and saves both with the layout", async () => {
  const { saved } = collectionShell({ ...withTab, openRecords: { [tasksTab]: "rec_kept" }, recordPanelWidth: 512 });
  expect((await screen.findByRole("status", { name: "Open record" })).textContent).toBe("rec_kept");
  expect(screen.getByRole("status", { name: "Panel width" }).textContent).toBe("512");
  expect(screen.getByRole("status", { name: "Record History" }).textContent).toBe("offered");

  fireEvent.click(screen.getByRole("button", { name: "Open record a" }));
  await waitFor(() => expect(saved()?.openRecords).toEqual({ [tasksTab]: "rec_a" }));
  fireEvent.click(screen.getByRole("button", { name: "Widen the panel" }));
  await waitFor(() => expect(saved()?.recordPanelWidth).toBe(640));
  fireEvent.click(screen.getByRole("button", { name: "Close the record" }));
  await waitFor(() => expect(saved()?.openRecords).toEqual({}));
});

it("draws a record's body as the file's own document, without the title and the properties a file tab shows, and takes no focus for it", async () => {
  collectionShell();
  const body = await within(await screen.findByRole("complementary", { name: "Record a" })).findByTestId("view-markdown");
  await waitFor(() => expect(within(record()).getByTestId("markdown-edit-toggle")).toHaveProperty("disabled", false));
  expect(within(record()).queryByTestId("page-identity")).toBeNull();
  expect(within(record()).queryByTestId("properties-panel")).toBeNull();
  expect(body.contains(document.activeElement)).toBe(false);

  // The same file in a tab shows its title and its properties.
  fireEvent.click(screen.getAllByTestId("tree-row").find((row) => row.dataset.path === "a.md")!);
  expect(await screen.findByTestId("page-identity")).toBeTruthy();
  expect(screen.queryByTestId("collection-page")).toBeNull();
});

it.each([
  { place: "a share opened with View access", share: true, folder: "tasks" },
  { place: "a share received under shared-with-me", share: false, folder: "shared-with-me/sam/tasks" },
])("offers no edit in the body of a record in $place", async ({ share, folder }) => {
  shown.path = `${folder}/a.md`;
  const tab = collectionTabPath(folder);
  const bridge = holdHistory(share ? makeShareBridge(Promise.resolve(storedStateWithTabs([tab]))) : makeBridge(Promise.resolve(storedStateWithTabs([tab]))));
  bridge.listWorkspaceFiles.mockResolvedValue({
    visibility: { status: "ready", rules: [] },
    files: [{ path: shown.path, kind: "file" }, { path: `${folder}/collection.yaml`, kind: "file" }],
    folders: folder.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/")),
  });
  renderShell(bridge, share ? SHARE_VIEW : undefined);
  await within(await screen.findByRole("complementary", { name: "Record a" })).findByTestId("view-markdown");
  // The body is the file's own view, which is read-only by the file's rule: its toggle to the editor is off, and nothing in it takes typing.
  const edit = await within(record()).findByTestId("markdown-edit-toggle");
  await waitFor(() => expect(within(record()).queryByTestId("markdown-open-state")).toBeNull());
  expect(edit.hasAttribute("disabled") || edit.getAttribute("aria-disabled") === "true").toBe(true);
  expect(record().querySelector('[contenteditable="true"]')).toBeNull();
  expect(within(record()).queryByRole("textbox")).toBeNull();
});

it("marks the Collection's tab unsaved for text typed in the body, saves it before the record leaves the panel, and keeps the record when it cannot be saved", async () => {
  const { bridge } = collectionShell();
  bridge.writeWorkspaceText = vi.fn(async () => { throw new Error("disk full"); });
  const { editor } = await typeInBody();

  fireEvent.click(screen.getByRole("button", { name: "Close the record" }));
  await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
  expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain("dohc could not save this record's page. The record stays open.");
  expect(editor.isConnected).toBe(true);
  expect(editor.textContent).toContain("Draft!");

  // The save goes through, and only then does the record leave.
  const save = deferred<{ status: "written"; contentHash: string }>();
  const write = vi.fn(() => save.promise);
  bridge.writeWorkspaceText = write;
  fireEvent.click(screen.getByRole("button", { name: "Close the record" }));
  await waitFor(() => expect(write).toHaveBeenCalled());
  expect(write.mock.calls[0]).toEqual([expect.objectContaining({ relativePath: "a.md", text: expect.stringContaining("Draft!") })]);
  expect(editor.isConnected).toBe(true);
  await act(async () => {
    save.resolve({ status: "written", contentHash: "b".repeat(64) });
    await save.promise;
  });
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "Record a" })).toBeNull());
  expect(within(tab()).queryByTestId("tab-dirty")).toBeNull();
});

it("keeps the Collection's tab open when the text typed in its record's body cannot be saved, and closes it once it is", async () => {
  const { bridge } = collectionShell();
  bridge.writeWorkspaceText = vi.fn(async () => { throw new Error("disk full"); });
  const { user, editor } = await typeInBody();

  await user.click(within(tab()).getByRole("button", { name: /^Close / }));
  await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
  expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain("disk full");
  expect(tab()).toBeTruthy();
  expect(editor.isConnected).toBe(true);

  bridge.writeWorkspaceText = vi.fn(async () => ({ status: "written" as const, contentHash: "b".repeat(64) }));
  await user.click(within(tab()).getByRole("button", { name: /^Close / }));
  await waitFor(() => expect(screen.queryByTestId(editorTabTestId(tasksTab))).toBeNull());
  expect(bridge.writeWorkspaceText).toHaveBeenCalledWith(expect.objectContaining({ relativePath: "a.md", text: expect.stringContaining("Draft!") }));
});

it("takes Ctrl+/ for the body's Source only while focus is in the body", async () => {
  collectionShell();
  await within(await screen.findByRole("complementary", { name: "Record a" })).findByTestId("view-markdown");
  const toggle = () => within(record()).getByTestId<HTMLButtonElement>("markdown-edit-toggle");
  // The toggle names the next surface. The body opens in its editor, so the next one is Source.
  await waitFor(() => expect(toggle().textContent).toBe("Source"));
  expect(toggle().disabled).toBe(false);
  expect(record().contains(document.activeElement)).toBe(false);

  // Focus is on the Collection's page, outside the record's body: the shortcut is not the body's.
  const outside = screen.getByRole("button", { name: "Open record a" });
  outside.focus();
  fireEvent.keyDown(outside, { key: "/", ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
  expect(toggle().textContent).toBe("Source");

  // Focus is in the body: the shortcut shows its Source, and takes it back, as in the file's own tab.
  toggle().focus();
  fireEvent.keyDown(toggle(), { key: "/", ctrlKey: true });
  await waitFor(() => expect(toggle().textContent).toBe("WYSIWYG"));
  fireEvent.keyDown(toggle(), { key: "/", ctrlKey: true });
  await waitFor(() => expect(toggle().textContent).toBe("Source"));
});

it.each([
  { asks: "saves the text typed in a record's body before the record's file opens in another editor group", askFirst: false },
  { asks: "counts only the body a Collection's tab draws as open, and not one its page asked for and did not draw", askFirst: true },
])("$asks", async ({ askFirst }) => {
  const { bridge } = collectionShell({
    ...STORED_STATE,
    editorGroups: [
      { id: "primary", tabs: [tasksTab], activeTab: tasksTab, size: 0.5 },
      { id: "secondary", tabs: ["b.md"], activeTab: "b.md", size: 0.5 },
    ],
    activeEditorGroup: "primary",
  });
  const { user } = await typeInBody();
  if (askFirst) fireEvent.click(screen.getByRole("button", { name: "Ask for a body and draw none" }));
  const save = deferred<{ status: "written"; contentHash: string }>();
  const write = vi.fn(() => save.promise);
  bridge.writeWorkspaceText = write;

  // The other group takes the next open.
  const other = screen.getByRole("region", { name: "Editor group 2" });
  await user.click(within(other).getByTestId(editorTabTestId("b.md")));
  await user.click(screen.getAllByTestId("tree-row").find((row) => row.dataset.path === "a.md")!);
  await waitFor(() => expect(write).toHaveBeenCalled());
  expect(write.mock.calls[0]).toEqual([expect.objectContaining({ relativePath: "a.md", text: expect.stringContaining("Draft!") })]);
  expect(within(other).queryByTestId(editorTabTestId("a.md"))).toBeNull();

  await act(async () => {
    save.resolve({ status: "written", contentHash: "b".repeat(64) });
    await save.promise;
  });
  expect(await within(other).findByTestId(editorTabTestId("a.md"))).toBeTruthy();
});
