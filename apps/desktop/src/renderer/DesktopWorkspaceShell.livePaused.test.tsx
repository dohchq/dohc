// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OwnerLiveQuarantine, SyncStatusResult } from "../ipc/bridgeContract";
import type { Workspace } from "./DesktopWorkspaceShell";
import { LIVE_EDITING_PAUSED_REASON } from "./readOnlyReasons";
import { DesktopWorkspaceShell, WORKSPACE, OTHER_WORKSPACE, SHARE_VIEW, SYNC_STATUS, makeBridge, renderShell, enterMarkdownSource, shellBootstrapProps } from "./DesktopWorkspaceShell.testHarness";

// While this computer's queue for a note takes no more edits, the engine
// refuses each one, so the note's editor stays read-only instead of taking
// typing it then sets aside. Each way out of the pause makes it editable again.
describe("a note whose live editing is paused", () => {
  const ROW: OwnerLiveQuarantine = { objectId: "object-a", path: "a.md", reason: "invalid-update", storedOn: "this-computer",
    incident: "outbox:delivery:0", recovery: "paused" };
  const withRows = (...rows: OwnerLiveQuarantine[]): SyncStatusResult => ({ ...SYNC_STATUS, ownerLiveQuarantines: rows });

  async function openNote(bridge: ReturnType<typeof makeBridge>) {
    const user = userEvent.setup();
    const row = (await screen.findAllByTestId("tree-row")).find((candidate) => candidate.dataset.path === "a.md")!;
    await user.click(row);
    await screen.findByTestId("view-markdown");
    return { user, toggle: async () => await screen.findByTestId("markdown-edit-toggle"), status: (next: SyncStatusResult) => {
      bridge.getSyncStatus.mockResolvedValue(next);
      const reads = bridge.getSyncStatus.mock.calls.length;
      act(() => bridge.emitWorkspaceActivity());
      return waitFor(() => expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(reads));
    } };
  }

  const expectPaused = async (toggle: () => Promise<HTMLElement>) => {
    await waitFor(async () => expect((await toggle()).getAttribute("aria-disabled")).toBe("true"));
    expect((await toggle()).getAttribute("title")).toBe(LIVE_EDITING_PAUSED_REASON);
  };

  it("stays read-only while Try again waits, and edits once the queue sends", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => withRows(ROW));
    renderShell(bridge);
    const note = await openNote(bridge);
    await expectPaused(note.toggle);
    // Typing at a read-only note keeps nothing aside and writes nothing.
    await note.user.click(await note.toggle());
    await note.user.keyboard("Lost?");
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
    const toast = await screen.findByTestId("workspace-shell-error");
    await note.user.click(within(toast).getByRole("button", { name: "Try again" }));
    expect(bridge.retryOwnerLiveQuarantine).toHaveBeenCalledOnce();
    await note.status(withRows({ ...ROW, recovery: "retrying" }));
    await expectPaused(note.toggle);
    // The server took the queue: main lists the note no more.
    await note.status(SYNC_STATUS);
    const editor = await enterMarkdownSource(note.user);
    await note.user.type(editor, "Back");
    expect(editor.textContent).toContain("Back");
  });

  it("stays read-only while Stop runs, and edits once Stop releases the note", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => withRows({ ...ROW, recovery: "stopping" }));
    renderShell(bridge);
    const note = await openNote(bridge);
    await expectPaused(note.toggle);
    // Stop took the kept edits and released the note from its queue.
    await note.status(withRows({ ...ROW, recovery: "stopped-kept" }));
    await waitFor(async () => expect((await note.toggle()).getAttribute("aria-disabled")).not.toBe("true"));
    expect(await enterMarkdownSource(note.user)).toBeTruthy();
  });

  it("stays read-only after a recovery copy while the queue holds the edits, and edits once they are cleared", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => withRows(ROW));
    renderShell(bridge);
    const note = await openNote(bridge);
    await expectPaused(note.toggle);
    await note.user.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    const row = within(notices).getByText("Live editing paused for a.md").closest("li")!;
    await note.user.click(within(row).getByRole("button", { name: "Save recovery copy" }));
    await waitFor(() => expect(bridge.saveOwnerLiveRecoveryCopy).toHaveBeenCalledOnce());
    // A copy leaves the queue, and the engine still refuses edits to it.
    await note.status(withRows(ROW));
    await expectPaused(note.toggle);
    await note.status(SYNC_STATUS);
    await waitFor(async () => expect((await note.toggle()).getAttribute("aria-disabled")).not.toBe("true"));
  });

  it("stays read-only while too many edits wait, and edits once they reach the server", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => ({ ...SYNC_STATUS, ownerLivePausedPaths: ["a.md"] }));
    renderShell(bridge);
    const note = await openNote(bridge);
    await expectPaused(note.toggle);
    await note.status(SYNC_STATUS);
    await waitFor(async () => expect((await note.toggle()).getAttribute("aria-disabled")).not.toBe("true"));
  });

  it.each([
    ["the server keeps", { ...ROW, storedOn: "server" as const, incident: "server:1" }],
    ["the server keeps, with a recovery copy saved", { ...ROW, storedOn: "server" as const, incident: "server:1", recovery: "copied" as const }],
  ])("stays read-only while %s", async (_case, row) => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => withRows(row));
    renderShell(bridge);
    await expectPaused((await openNote(bridge)).toggle);
  });

  it.each([
    ["kept after a restore", { ...ROW, saveOnly: true as const }],
    ["the server keeps in an earlier copy of the workspace", { ...ROW, storedOn: "server" as const, incident: "server:1", earlier: true as const }],
    ["a finished Stop could not write", { ...ROW, recovery: "not-written" as const }],
  ])("edits a note whose edits %s", async (_case, row) => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => withRows(row));
    renderShell(bridge);
    const note = await openNote(bridge);
    expect(await enterMarkdownSource(note.user)).toBeTruthy();
  });

  it("edits a received share's note at a listed path", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    // Main answers with the owner's own lists, whose path a share's note shares.
    bridge.openWorkspace = vi.fn(async () => withRows(ROW));
    bridge.getSyncStatus = vi.fn(async () => withRows(ROW));
    renderShell(bridge, { ...SHARE_VIEW, shareView: { ...SHARE_VIEW.shareView!, access: "edit" } });
    const note = await openNote(bridge);
    await note.status(withRows(ROW));
    expect((await note.toggle()).getAttribute("aria-disabled")).not.toBe("true");
    expect((await note.toggle()).getAttribute("title")).not.toBe(LIVE_EDITING_PAUSED_REASON);
  });

  it("edits the same path in another workspace", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    let current: Workspace = WORKSPACE;
    bridge.getSyncStatus = vi.fn(async () => current.workspaceId === WORKSPACE.workspaceId ? withRows(ROW) : SYNC_STATUS);
    const shell = (workspace: Workspace) => (
      <DesktopWorkspaceShell key={workspace.workspaceId} workspace={workspace} workspaces={[WORKSPACE, OTHER_WORKSPACE]}
        {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />
    );
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(WORKSPACE));
    const note = await openNote(bridge);
    await expectPaused(note.toggle);
    current = OTHER_WORKSPACE;
    view.rerender(shell(OTHER_WORKSPACE));
    const other = await openNote(bridge);
    expect(await enterMarkdownSource(other.user)).toBeTruthy();
  });
});
