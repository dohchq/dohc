// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OwnerLiveQuarantine, SyncStatusResult } from "../ipc/bridgeContract";
import type { Workspace } from "./DesktopWorkspaceShell";
import { LIVE_EDITING_PAUSED_REASON } from "./readOnlyReasons";
import {
  DesktopWorkspaceShell,
  WORKSPACE,
  OTHER_WORKSPACE,
  SYNC_STATUS,
  makeBridge,
  renderShell,
  enterMarkdownSource,
  shellBootstrapProps,
} from "./DesktopWorkspaceShell.testHarness";

describe("a note whose live editing is paused", () => {
  const ROW: OwnerLiveQuarantine = {
    objectId: "object-a",
    path: "a.md",
    reason: "invalid-update",
    storedOn: "this-computer",
    incident: "outbox:delivery:0",
    recovery: "paused",
  };
  const withRows = (...rows: OwnerLiveQuarantine[]): SyncStatusResult => ({
    ...SYNC_STATUS,
    ownerLiveQuarantines: rows,
  });

  async function openNote(bridge: ReturnType<typeof makeBridge>) {
    const user = userEvent.setup();
    const row = (await screen.findAllByTestId("tree-row")).find(
      (candidate) => candidate.dataset.path === "a.md",
    )!;
    await user.click(row);
    await screen.findByTestId("view-markdown");
    return {
      user,
      toggle: async () => await screen.findByTestId("markdown-edit-toggle"),
      status: (next: SyncStatusResult) => {
        bridge.getSyncStatus.mockResolvedValue(next);
        const reads = bridge.getSyncStatus.mock.calls.length;
        act(() => bridge.emitWorkspaceActivity());
        return waitFor(() => expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(reads));
      },
    };
  }

  const expectPaused = async (
    toggle: () => Promise<HTMLElement>,
    reason = LIVE_EDITING_PAUSED_REASON,
  ) => {
    await waitFor(async () => expect((await toggle()).getAttribute("aria-disabled")).toBe("true"));
    expect((await toggle()).getAttribute("title")).toBe(reason);
  };

  it("stays read-only while Try again waits, and edits once the queue sends", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => withRows(ROW));
    renderShell(bridge);
    const note = await openNote(bridge);
    await expectPaused(note.toggle);
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
    await note.status(SYNC_STATUS);
    const editor = await enterMarkdownSource(note.user);
    await note.user.type(editor, "Back");
    expect(editor.textContent).toContain("Back");
  });

  it("edits the same path in another workspace", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    let current: Workspace = WORKSPACE;
    bridge.getSyncStatus = vi.fn(async () =>
      current.workspaceId === WORKSPACE.workspaceId ? withRows(ROW) : SYNC_STATUS,
    );
    const shell = (workspace: Workspace) => (
      <DesktopWorkspaceShell
        key={workspace.workspaceId}
        workspace={workspace}
        workspaces={[WORKSPACE, OTHER_WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />
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
