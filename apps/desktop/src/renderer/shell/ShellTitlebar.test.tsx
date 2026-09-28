// @vitest-environment jsdom
import "../../testing/legendListMock";
// Collection dependencies read these observers during module evaluation.
// Preload them before tests so an unfinished import cannot clean up a later test's globals.
vi.hoisted(() => {
  class ObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): never[] { return []; }
  }
  Object.assign(globalThis, { ResizeObserver: ObserverStub, IntersectionObserver: ObserverStub });
});
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DesktopWorkspaceShell } from "../DesktopWorkspaceShell";
import {
  WORKSPACE,
  makeBridge,
  renderShell,
  shellBootstrapProps,
} from "../DesktopWorkspaceShell.testHarness";

describe("workspace manager route", () => {
  it("shows a failed manager open in the shell error with a retry", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    vi.stubGlobal("dohcDesktop", bridge);
    const onManageWorkspaces = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new Error("Error invoking remote method 'desktop:open-workspace-manager': Error: No display."),
      )
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(
      <DesktopWorkspaceShell
        workspace={WORKSPACE}
        workspaces={[WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
        onManageWorkspaces={onManageWorkspaces}
      />,
    );
    await user.click(await screen.findByTestId("workspace-switcher"));
    await user.click(screen.getByTestId("workspace-switcher-manage"));

    const banner = await screen.findByTestId("workspace-shell-error");
    expect(banner.textContent).toContain("Couldn't open the workspace manager.");
    expect(banner.textContent).toContain("No display.");

    await user.click(screen.getByTestId("workspace-shell-error-retry"));
    expect(onManageWorkspaces).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByTestId("workspace-shell-error")).toBeNull());
  });
});

describe("native workbench context menus", () => {
  it("routes workspace status context menu commands to panel actions", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.showWorkbenchMenu.mockResolvedValue("open-history");
    renderShell(bridge);

    // The title bar carries the workspace name the removed bottom bar showed,
    // and the status context menu opens from that name.
    const workspaceLabel = await screen.findByTestId("status-workspace");
    expect(workspaceLabel.textContent).toBe("personal");
    fireEvent.contextMenu(workspaceLabel);

    await waitFor(() => {
      expect(bridge.showWorkbenchMenu).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        context: "status",
      });
    });
    // The command lands: the History view becomes the active rail entry.
    await waitFor(() => {
      expect(
        screen.getByTestId("activity-history").getAttribute("aria-current"),
      ).toBe("page");
    });
  });

  it("routes workspace status update commands to the updater bridge", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.showWorkbenchMenu.mockResolvedValue("install-update");

    renderShell(bridge);

    fireEvent.contextMenu(await screen.findByTestId("status-workspace"));

    await waitFor(() => {
      expect(bridge.installUpdate).toHaveBeenCalledOnce();
    });
  });

  it("opens settings from the workspace status context menu", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.showWorkbenchMenu.mockResolvedValue("settings");
    renderShell(bridge);

    fireEvent.contextMenu(await screen.findByTestId("status-workspace"));

    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
  });
});
