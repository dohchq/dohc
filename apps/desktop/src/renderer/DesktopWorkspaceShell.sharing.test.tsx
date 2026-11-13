// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import "./CollectionPage";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "./DesktopWorkspaceShell";
import { deferred } from "../testing/deferred";
import { DesktopWorkspaceShell, WORKSPACE, STORED_STATE, storedStateWithTabs, renderShell, shellBootstrapProps, SHARE_VIEW, makeShareBridge, settleShareView } from "./DesktopWorkspaceShell.testHarness";

describe("share background work readiness", () => {
  const EDIT_SHARE: Workspace = {
    ...SHARE_VIEW,
    shareView: { ...SHARE_VIEW.shareView!, access: "edit" },
  };

  it("discards a refresh failure from a retired workspace", async () => {
    const bridge = makeShareBridge();
    const refresh = deferred<Awaited<ReturnType<typeof bridge.refreshSharedView>>>();
    bridge.refreshSharedView.mockImplementationOnce(() => refresh.promise);
    const nextWorkspace = { ...WORKSPACE, workspaceId: "next-workspace" };
    const shell = (workspace: Workspace) => <DesktopWorkspaceShell
      workspace={workspace} workspaces={[EDIT_SHARE, nextWorkspace]}
      {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />;
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(EDIT_SHARE));
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledOnce());
    view.rerender(shell(nextWorkspace));
    await act(async () => { refresh.reject(new Error("This window changed workspaces.")); });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await userEvent.setup().click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-center").textContent).not.toContain("Couldn't refresh the shared view.");
  });

  it.each(["Collections", "workspace files"] as const)("discards a background %s failure from a retired workspace", async (read) => {
    const bridge = makeShareBridge();
    const pending = deferred<never>();
    if (read === "Collections") bridge.dataset.mockImplementationOnce(() => pending.promise);
    const nextWorkspace = { ...WORKSPACE, workspaceId: "next-workspace" };
    const shell = (workspace: Workspace) => <DesktopWorkspaceShell
      workspace={workspace} workspaces={[EDIT_SHARE, nextWorkspace]}
      {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />;
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(EDIT_SHARE));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    await settleShareView();
    if (read === "Collections") {
      expect(bridge.dataset).toHaveBeenCalledOnce();
    } else {
      const calls = bridge.listWorkspaceFiles.mock.calls.length;
      bridge.listWorkspaceFiles.mockImplementationOnce(() => pending.promise);
      act(() => bridge.emitWorkspaceActivity({ workspaceId: EDIT_SHARE.workspaceId }));
      await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(calls + 1));
    }
    view.rerender(shell(nextWorkspace));
    await act(async () => { pending.reject(new Error("This window changed workspaces.")); });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await userEvent.setup().click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-center").textContent).not.toContain(`Could not ${read === "Collections" ? "read Collections" : "refresh workspace files"}.`);
  });

});

describe("shared view editing", () => {
  async function editToggleDisabled(
    shareView: NonNullable<Workspace["shareView"]>,
  ): Promise<boolean> {
    const bridge = makeShareBridge(Promise.resolve(storedStateWithTabs(["a.md"])));
    renderShell(bridge, { ...SHARE_VIEW, shareView });
    const toggle = await screen.findByTestId("markdown-edit-toggle");
    // The toggle mounts disabled while the file is still opening, a moment
    // `findByTestId` does not wait out. Wait for the open to settle before
    // reading `disabled` (the read-only cases below can't tell the
    // difference either way).
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    return toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true";
  }

  it("keeps the editor read-only for a damaged marker that still names edit", async () => {
    expect(
      await editToggleDisabled({
        shareId: "share-1",
        granterEmail: "sam@dohc.test",
        access: "edit",
        damaged: true,
      }),
      "dropping the damaged test acts on a level dohc could not read",
    ).toBe(true);
  });

});

describe("shared view with an unreadable grant", () => {
  const damaged = {
    ...SHARE_VIEW,
    shareView: {
      shareId: "share-1",
      recipientUserId: "recipient",
      granterEmail: "sam@dohc.test",
      damaged: true as const,
    },
  };

  it("opens chat read-only, because an unreadable grant grants no writes", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge, damaged);

    await settleShareView();
    await screen.findByTestId("about-rail");
    expect(
      (await screen.findByTestId("linked-chat-readonly-note")).textContent,
      "an unreadable level must not open the composer",
    ).toBe("Chats are read-only in this shared view.");
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
  });

});
