// @vitest-environment jsdom
import { ObserverStub } from "./DesktopWorkspaceShell.testSupport";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("lists the workspace's Groups in Chats with no way to post or add a Group", async () => {
    const bridge = makeShareBridge();
    bridge.listChatChannels.mockResolvedValue({ channels: [{
      id: "launch", name: "Launch team", slug: "launch-team", kind: "channel",
      createdAtMs: 1, updatedAtMs: 1, threadCount: 1, unreadCount: 0, wireId: "launch",
    }], fileThreads: [] });
    bridge.listChannelThreads.mockResolvedValue({ threads: [] });
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, JOINED));
    fireEvent.click(await screen.findByTestId("activity-chats"));
    expect((await screen.findByTestId("chats-channel")).textContent).toContain("Launch team");
    expect(screen.queryByTestId("chats-off")).toBeNull();
    expect(screen.queryByTestId("chats-new-channel")).toBeNull();
    fireEvent.click(screen.getByTestId("chats-channel"));
    expect((await screen.findByTestId("chats-readonly-note")).textContent).toBe("This group is read-only for you.");
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
