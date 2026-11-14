// @vitest-environment jsdom
import { ObserverStub } from "./DesktopWorkspaceShell.testSupport";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "./DesktopWorkspaceShell";
import { chatTabPath } from "./workbench/workbenchState";
import { editorTabTestId } from "../testPins";
import { DesktopWorkspaceShell, SHARE_VIEW, makeShareBridge, shellBootstrapProps, storedStateWithTabs } from "./DesktopWorkspaceShell.testHarness";

const JOINED: Workspace = {
  ...SHARE_VIEW,
  rootPath: "/home/ana/dohc/Community",
  shareView: { ...SHARE_VIEW.shareView!, access: "comment", subjectName: "Community", sharerName: "Sam", membership: true },
};
const ENDED: Workspace = { ...JOINED, shareView: { ...JOINED.shareView!, ended: true } };

function shell(bridge: ReturnType<typeof makeShareBridge>, workspace: Workspace) {
  return <DesktopWorkspaceShell workspace={workspace} workspaces={[workspace]}
    {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => undefined} />;
}

describe("a joined workspace", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ObserverStub);
    vi.stubGlobal("IntersectionObserver", ObserverStub);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("looks like an owned workspace, says its level once in the workspace menu, and holds its pull", async () => {
    const bridge = makeShareBridge();
    bridge.listWorkspaceFiles.mockResolvedValue({ visibility: { status: "ready" as const, rules: [] }, files: [{ path: "plan.md", kind: "file" }], folders: [] });
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, JOINED));
    await waitFor(() => expect(screen.getAllByTestId("tree-row").some(row => row.dataset.path === "plan.md")).toBe(true));
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledWith({ workspaceId: JOINED.workspaceId, trigger: "held" }));
    expect(screen.queryByTestId("shared-view-banner")).toBeNull();
    expect(screen.queryByTestId("shared-view-refresh")).toBeNull();
    expect(screen.getByTestId("activity-chats")).toBeTruthy();
    fireEvent.click(screen.getByTestId("workspace-switcher"));
    expect(screen.getByTestId("workspace-switcher-level").textContent).toBe("You can comment");
    expect(screen.getAllByText("You can comment")).toHaveLength(1);
  });

  // Controls the level does not allow are absent, not disabled.
  it.each(["view", "comment"] as const)("shows a page at %s with no Edit toggle, opening or open", async (access) => {
    const bridge = makeShareBridge(Promise.resolve(storedStateWithTabs(["a.md"])));
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, { ...JOINED, shareView: { ...JOINED.shareView!, access } }));
    expect(await screen.findByTestId("document-menu-trigger")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("markdown-open-state")).toBeNull());
    expect(screen.queryByTestId("markdown-edit-toggle")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("keeps the Edit toggle for a member at Edit", async () => {
    const bridge = makeShareBridge(Promise.resolve(storedStateWithTabs(["a.md"])));
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, { ...JOINED, shareView: { ...JOINED.shareView!, access: "edit" } }));
    const toggle = await screen.findByTestId("markdown-edit-toggle");
    await waitFor(() => expect(screen.queryByTestId("markdown-open-state")).toBeNull());
    expect(toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true").toBe(false);
  });

  function withGroup(access: "view" | "comment" | "edit", checked: Awaited<ReturnType<ReturnType<typeof makeShareBridge>["checkSharedViewAccess"]>>,
    uiState: Parameters<typeof makeShareBridge>[0] = undefined) {
    const bridge = makeShareBridge(uiState);
    bridge.listChatChannels.mockResolvedValue({ channels: [{
      id: "launch", name: "Launch team", slug: "launch-team", kind: "channel",
      createdAtMs: 1, updatedAtMs: 1, threadCount: 1, unreadCount: 0, wireId: "launch",
    }], fileThreads: [] });
    bridge.listChannelThreads.mockResolvedValue({ threads: [] });
    bridge.checkSharedViewAccess.mockResolvedValue(checked);
    vi.stubGlobal("dohcDesktop", bridge);
    // The view keeps the role the relay last named; the check names it again.
    const role = "role" in checked ? checked.role : undefined;
    render(shell(bridge, { ...JOINED, shareView: { ...JOINED.shareView!, access, ...(role ? { role } : {}) } }));
    return bridge;
  }

  it.each(["comment", "edit"] as const)("posts in a Group at %s, with no New group for a member", async (access) => {
    const bridge = withGroup(access, { status: "current", access, role: "member" });
    fireEvent.click(await screen.findByTestId("activity-chats"));
    expect((await screen.findByTestId("chats-channel")).textContent).toContain("Launch team");
    expect(screen.queryByTestId("chats-off")).toBeNull();
    await waitFor(() => expect(bridge.checkSharedViewAccess).toHaveBeenCalled());
    expect(screen.queryByTestId("chats-new-channel")).toBeNull();
    fireEvent.click(screen.getByTestId("chats-channel"));
    expect(await screen.findByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
    expect(screen.queryByTestId("chats-share-channel")).toBeNull();
  });

  it("names a Group's restored tab before the tab is shown", async () => {
    const launch = chatTabPath({ kind: "channel", id: "launch" });
    withGroup("comment", { status: "current", access: "comment", role: "member" }, Promise.resolve(storedStateWithTabs(["a.md", launch], "a.md")));
    await waitFor(() => expect(screen.getByTestId(editorTabTestId(launch)).textContent).toContain("Launch team"));
  });

  it("shows no composer at View, only the line that says who posts", async () => {
    withGroup("view", { status: "current", access: "view", role: "member" });
    fireEvent.click(await screen.findByTestId("activity-chats"));
    fireEvent.click(await screen.findByTestId("chats-channel"));
    expect((await screen.findByTestId("chats-readonly-note")).textContent).toBe("Only people who can comment post here.");
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
  });

  it("offers New group to an admin once the relay names the role", async () => {
    withGroup("view", { status: "current", access: "view", role: "admin" });
    fireEvent.click(await screen.findByTestId("activity-chats"));
    expect(await screen.findByTestId("chats-new-channel")).toBeTruthy();
  });

  // The view keeps the role from when it opened, so New group does not wait
  // for the access check.
  it("offers New group to an admin before the access check answers", async () => {
    const bridge = makeShareBridge();
    bridge.listChatChannels.mockResolvedValue({ channels: [], fileThreads: [] });
    bridge.checkSharedViewAccess.mockReturnValue(new Promise(() => undefined));
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, { ...JOINED, shareView: { ...JOINED.shareView!, role: "admin" } }));
    fireEvent.click(await screen.findByTestId("activity-chats"));
    expect(await screen.findByTestId("chats-new-channel")).toBeTruthy();
  });

  it.each([
    ["comment", "member", false, false],
    ["edit", "member", true, false],
    ["edit", "admin", true, true],
  ] as const)("at %s, a %s gets New page %s and New folder %s in the Explorer", async (access, role, page, folder) => {
    const bridge = withGroup(access, { status: "current", access, role });
    await waitFor(() => expect(bridge.checkSharedViewAccess).toHaveBeenCalled());
    const header = within(await screen.findByTestId("explorer-files-header"));
    await waitFor(() => expect(header.queryByRole("button", { name: "New folder" }) !== null).toBe(folder));
    expect(header.queryByRole("button", { name: "New page" }) !== null).toBe(page);
    expect(header.queryByRole("button", { name: "New file" })).toBeNull();
  });

  it("applies a level change at once, with a toast and a Notices row", async () => {
    const bridge = withGroup("comment", { status: "current", access: "view", role: "member", levelChanged: true });
    const toast = await screen.findByTestId("workspace-shell-notice");
    expect(toast.textContent).toContain("Members can now view only.");
    expect(screen.getByTestId("notice-toasts").contains(toast)).toBe(true);
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(await within(screen.getByTestId("notice-center")).findByText("Members can now view only.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("activity-chats"));
    fireEvent.click(await screen.findByTestId("chats-channel"));
    expect((await screen.findByTestId("chats-readonly-note")).textContent).toBe("Only people who can comment post here.");
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
    expect(bridge.checkSharedViewAccess).toHaveBeenCalled();
  });

  it("shows the new level in About's Access at once", async () => {
    const bridge = withGroup("comment", { status: "current", access: "view", role: "member", levelChanged: true },
      Promise.resolve({ ...storedStateWithTabs(["a.md"]), aboutVisible: true }));
    bridge.getObjectAccess.mockImplementation(async (input) => ({
      ref: input.ref, visibility: "visible" as const, unknownReason: null, checkedAtMs: 0, freshness: "fresh" as const, nextCursor: null,
      coverage: { kind: "received-own-grant" as const, complete: true, observation: "interval" as const },
      rows: [{ kind: "share" as const, shareId: "share-1", grantId: "grant-1", via: "received" as const, granterUserId: "ana", granterEmail: null,
        recipientUserId: "sam", recipientEmail: null, subjectName: "Community", sharerName: "Ana", selector: { kind: "workspace" as const, role: "member" as const },
        access: "comment" as const, status: "active" as const, generation: 1 }],
    }));
    await screen.findByTestId("workspace-shell-notice");
    // A file's Access starts open.
    const row = await screen.findByTestId("about-access-row");
    expect(within(row).getByText("Can view")).toBeTruthy();
  });

  it("names who changed the level in the toast and its Notices row", async () => {
    withGroup("comment", { status: "current", access: "view", role: "member", levelChanged: true, levelChangedBy: "Ana" });
    const toast = await screen.findByTestId("workspace-shell-notice");
    expect(toast.textContent).toContain("Ana now lets members view only.");
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(await within(screen.getByTestId("notice-center")).findByText("Ana now lets members view only.")).toBeTruthy();
  });

  it("says nothing when the check finds the level it already had", async () => {
    const bridge = withGroup("comment", { status: "current", access: "comment", role: "member" });
    await waitFor(() => expect(bridge.checkSharedViewAccess).toHaveBeenCalled());
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
  });

  // File comments follow the member's level, like Groups do.
  it.each(["comment", "edit"] as const)("offers Comment on this file at %s", async (access) => {
    const bridge = makeShareBridge(Promise.resolve(storedStateWithTabs(["a.md"])));
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, { ...JOINED, shareView: { ...JOINED.shareView!, access } }));
    expect(await screen.findByTestId("linked-chat-new")).toBeTruthy();
    expect(screen.queryByTestId("linked-chat-readonly-note")).toBeNull();
  });

  it.each([
    ["at View", { access: "view" as const }, "Only people who can comment post here."],
    ["after the membership ends", { ended: true }, "Your membership ended."],
  ])("says who comments %s, with no comment control", async (_, change, note) => {
    const bridge = makeShareBridge(Promise.resolve(storedStateWithTabs(["a.md"])));
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, { ...JOINED, shareView: { ...JOINED.shareView!, ...change } }));
    expect((await screen.findByTestId("linked-chat-readonly-note")).textContent).toBe(note);
    expect(screen.queryByTestId("linked-chat-new")).toBeNull();
  });

  it("shows the ended band and keeps the copy readable after the membership ends", async () => {
    const bridge = makeShareBridge();
    bridge.listWorkspaceFiles.mockResolvedValue({ visibility: { status: "ready" as const, rules: [] }, files: [{ path: "plan.md", kind: "file" }], folders: [] });
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, ENDED));
    const band = await screen.findByTestId("shared-view-banner");
    expect(band.dataset.ended).toBe("true");
    expect(band.textContent).toBe("Your membership ended. This copy stays on this computer.");
    await waitFor(() => expect(screen.getAllByTestId("tree-row").some(row => row.dataset.path === "plan.md")).toBe(true));
    expect(screen.queryByTestId("shared-view-refresh")).toBeNull();
    expect(screen.queryByTestId("share-changes-send")).toBeNull();
    fireEvent.click(screen.getByTestId("workspace-switcher"));
    expect(screen.queryByTestId("workspace-switcher-level")).toBeNull();
    expect(bridge.refreshSharedView).not.toHaveBeenCalled();
  });
});
