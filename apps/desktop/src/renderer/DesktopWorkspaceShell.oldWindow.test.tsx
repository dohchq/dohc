// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CollectionFieldWriteHost } from "./collections/recordFieldWrites";
import { DesktopWorkspaceShell, WORKSPACE, makeBridge, shellBootstrapProps } from "./DesktopWorkspaceShell.testHarness";

type OldWindow = { openElsewhere: boolean } | null;

function renderShell(bridge: ReturnType<typeof makeBridge>, oldWindow: OldWindow) {
  vi.stubGlobal("dohcDesktop", bridge);
  const shell = (old: OldWindow) => (
    <>
      <CollectionFieldWriteHost />
      <DesktopWorkspaceShell
        workspace={WORKSPACE}
        workspaces={[WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
        oldWindow={old}
      />
    </>
  );
  const view = render(shell(oldWindow));
  return (old: OldWindow) => view.rerender(shell(old));
}

const workbenchInert = () => screen.getByTestId("workspace-workbench").hasAttribute("inert");

// What the window receives when main marks a call on the workspace it has stopped.
const stoppedCall = (channel: string, stopped: "read" | "call") =>
  new Error(`Error invoking remote method '${channel}': Error [stopped=${stopped}]: This workspace is no longer open in this window.`);
const KEPT_TYPING_FAILED = "dohc could not check for typing it kept in History.";

describe("a window Forget left showing its workspace", () => {
  it("stops the workbench and follows whether another window shows the workspace", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    const show = renderShell(bridge, null);
    await waitFor(() => expect(workbenchInert()).toBe(false));
    expect(screen.queryByTestId("workspace-old-window")).toBeNull();

    show({ openElsewhere: true });
    const state = await screen.findByTestId("workspace-old-window");
    expect(state.getAttribute("role")).toBe("alert");
    expect(within(state).getByRole("heading").textContent).toBe("This workspace is open in another window.");
    expect(within(state).getAllByRole("button").map((button) => button.textContent)).toEqual(["Go to that window"]);
    const go = within(state).getByRole("button", { name: "Go to that window" });
    expect(document.activeElement).toBe(go);
    expect(workbenchInert()).toBe(true);
    await user.click(go);
    expect(bridge.goToWorkspaceWindow).toHaveBeenCalledExactlyOnceWith({});
    expect(bridge.closeThisWindow).not.toHaveBeenCalled();

    // The other window closed.
    show({ openElsewhere: false });
    const stopped = screen.getByTestId("workspace-old-window");
    expect(within(stopped).getByRole("heading").textContent).toBe("This window can't edit this workspace anymore.");
    expect(within(stopped).getAllByRole("button").map((button) => button.textContent)).toEqual(["Close this window"]);
    const close = within(stopped).getByRole("button", { name: "Close this window" });
    expect(document.activeElement).toBe(close);
    expect(workbenchInert()).toBe(true);
    await user.click(close);
    expect(bridge.closeThisWindow).toHaveBeenCalledOnce();

    // The workspace opened in another window again.
    show({ openElsewhere: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Go to that window" }));
  });

  it("closes the command palette and answers no workspace shortcut or menu command while it is stopped", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    const show = renderShell(bridge, null);
    await waitFor(() => expect(workbenchInert()).toBe(false));
    await user.keyboard("{Control>}k{/Control}");
    await screen.findByTestId("command-palette");

    show({ openElsewhere: false });
    await screen.findByTestId("workspace-old-window");
    await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByTestId("command-palette")).toBeNull();
    // On macOS a shortcut the window leaves alone comes back from the native menu.
    act(() => bridge.emitMenuCommand("command-palette"));
    expect(screen.queryByTestId("command-palette")).toBeNull();
    // A command that needs no workspace still runs.
    const checks = bridge.checkForUpdates.mock.calls.length;
    act(() => bridge.emitMenuCommand("check-updates"));
    await waitFor(() => expect(bridge.checkForUpdates).toHaveBeenCalledTimes(checks + 1));
  });

  it("reports no read that failed after the workspace stopped, and reports other calls without Try again", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const show = renderShell(bridge, null);
    await waitFor(() => expect(workbenchInert()).toBe(false));
    await waitFor(() => expect(bridge.getCaptureRecoveryStatus).toHaveBeenCalled());
    // Main stopped the workspace before this window heard: workspace activity
    // runs the window's reads again, and each one fails.
    const reads = bridge.getCaptureRecoveryStatus.mock.calls.length;
    bridge.getCaptureRecoveryStatus.mockRejectedValue(stoppedCall("desktop:get-capture-recovery-status", "read"));
    act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId }));
    await waitFor(() => expect(bridge.getCaptureRecoveryStatus.mock.calls.length).toBeGreaterThan(reads));
    show({ openElsewhere: false });
    await screen.findByTestId("workspace-old-window");
    act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId }));
    await waitFor(() => expect(bridge.getCaptureRecoveryStatus.mock.calls.length).toBeGreaterThan(reads + 1));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(document.body.textContent).not.toContain(KEPT_TYPING_FAILED);

    // Any other failed call is still reported, with nothing to try again.
    bridge.goToWorkspaceWindow.mockRejectedValueOnce(stoppedCall("desktop:go-to-workspace-window", "call"));
    show({ openElsewhere: true });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Go to that window" }));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc could not go to that window.");
    expect(within(toast).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("offers no Try again on a row filed before the workspace stopped", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getCaptureRecoveryStatus.mockRejectedValue(new Error("The disk is busy."));
    const show = renderShell(bridge, null);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(KEPT_TYPING_FAILED);
    expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();

    show({ openElsewhere: false });
    await screen.findByTestId("workspace-old-window");
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain(KEPT_TYPING_FAILED);
    expect(within(screen.getByTestId("workspace-shell-error")).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("says when it could not go to that window", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.goToWorkspaceWindow.mockRejectedValueOnce(new Error("The window closed."));
    const user = userEvent.setup();
    renderShell(bridge, { openElsewhere: true });
    await user.click(await screen.findByRole("button", { name: "Go to that window" }));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc could not go to that window.");
    await user.click(within(toast).getByRole("button", { name: "Try again" }));
    expect(bridge.goToWorkspaceWindow).toHaveBeenCalledTimes(2);
  });
});
