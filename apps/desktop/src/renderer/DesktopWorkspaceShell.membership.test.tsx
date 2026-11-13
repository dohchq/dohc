// @vitest-environment jsdom
import { ObserverStub } from "./DesktopWorkspaceShell.testSupport";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "./DesktopWorkspaceShell";
import { DesktopWorkspaceShell, SHARE_VIEW, makeShareBridge, shellBootstrapProps } from "./DesktopWorkspaceShell.testHarness";

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

  function withGroup(access: "view" | "comment" | "edit", checked: Awaited<ReturnType<ReturnType<typeof makeShareBridge>["checkSharedViewAccess"]>>) {
    const bridge = makeShareBridge();
    bridge.listChatChannels.mockResolvedValue({ channels: [{
      id: "launch", name: "Launch team", slug: "launch-team", kind: "channel",
      createdAtMs: 1, updatedAtMs: 1, threadCount: 1, unreadCount: 0, wireId: "launch",
    }], fileThreads: [] });
    bridge.listChannelThreads.mockResolvedValue({ threads: [] });
    bridge.checkSharedViewAccess.mockResolvedValue(checked);
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, { ...JOINED, shareView: { ...JOINED.shareView!, access } }));
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

  it.each([
    ["comment", "member", false, false],
    ["edit", "member", true, false],
    ["edit", "admin", true, true],
  ] as const)("at %s, a %s gets New file %s and New folder %s in the Explorer", async (access, role, page, folder) => {
    const bridge = withGroup(access, { status: "current", access, role });
    await waitFor(() => expect(bridge.checkSharedViewAccess).toHaveBeenCalled());
    const header = within(await screen.findByTestId("explorer-files-header"));
    await waitFor(() => expect(header.queryByRole("button", { name: "New folder" }) !== null).toBe(folder));
    expect(header.queryByRole("button", { name: "New file" }) !== null).toBe(page);
  });

  it("applies a level change at once, with a toast and a Notices row", async () => {
    const bridge = withGroup("comment", { status: "current", access: "view", role: "member", levelChanged: true });
    const toast = await screen.findByTestId("workspace-shell-notice");
    expect(toast.textContent).toContain("Members can now view.");
    expect(screen.getByTestId("notice-toasts").contains(toast)).toBe(true);
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(await within(screen.getByTestId("notice-center")).findByText("Members can now view.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("activity-chats"));
    fireEvent.click(await screen.findByTestId("chats-channel"));
    expect((await screen.findByTestId("chats-readonly-note")).textContent).toBe("Only people who can comment post here.");
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
    expect(bridge.checkSharedViewAccess).toHaveBeenCalled();
  });

  it("names who changed the level in the toast and its Notices row", async () => {
    withGroup("comment", { status: "current", access: "view", role: "member", levelChanged: true, levelChangedBy: "Ana" });
    const toast = await screen.findByTestId("workspace-shell-notice");
    expect(toast.textContent).toContain("Ana changed members to View.");
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(await within(screen.getByTestId("notice-center")).findByText("Ana changed members to View.")).toBeTruthy();
  });

  it("says nothing when the check finds the level it already had", async () => {
    const bridge = withGroup("comment", { status: "current", access: "comment", role: "member" });
    await waitFor(() => expect(bridge.checkSharedViewAccess).toHaveBeenCalled());
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
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
