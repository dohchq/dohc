// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ShareHandoffStatus } from "../ipc/bridgeContract";
import { PRIVACY_DENIED_WORDS } from "../ipc/errorWords";
import { CollectionFieldWriteHost } from "./collections/recordFieldWrites";
import { DesktopRoot } from "./DesktopRoot";
import type { Workspace } from "./DesktopWorkspaceShell";
import { makeBridge, OTHER_WORKSPACE, renderShell, WORKSPACE } from "./DesktopWorkspaceShell.testHarness";

const INSIDE_SETTINGS = "This folder is inside the folder that holds dohc's own settings, so it cannot be a workspace.";
const refused = (channel: string, message: string) =>
  new Error(`Error invoking remote method '${channel}': WorkspaceFolderRefusalError: ${message}`);

// The real DesktopRoot over a registry that Remove from list changes, as
// main's forget does.
function renderRoot(registry: Workspace[], openFailure: Error) {
  let listed = registry;
  const bridge = makeBridge(Promise.resolve(null));
  bridge.openWorkspace.mockRejectedValueOnce(openFailure);
  const root = Object.assign(bridge, {
    windowRole: "workspace" as const,
    getWorkspaceRegistry: vi.fn(async () => ({ workspaces: listed })),
    forgetWorkspace: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      listed = listed.filter((workspace) => workspace.workspaceId !== workspaceId);
    }),
    listNotices: vi.fn(async () => ({ account: null, notices: [] })),
    onNoticesChanged: vi.fn(() => () => undefined),
    onWorkspacePathOpenFailed: vi.fn(() => () => undefined),
    takeWorkspacePathOpenFailures: vi.fn(async () => []),
    readOldWindowState: vi.fn(async () => null),
    onOldWindowStateChanged: vi.fn(() => () => undefined),
    onShareHandoffStatus: vi.fn(() => () => undefined),
    getShareHandoffStatus: vi.fn(async (): Promise<ShareHandoffStatus> => ({ status: "idle" })),
    onWorkspaceActivated: vi.fn(() => () => undefined),
    getDefaultWorkspaceRoot: vi.fn(async () => "/home/sam/dohc"),
  });
  vi.stubGlobal("dohcDesktop", root);
  render(
    <>
      <CollectionFieldWriteHost />
      <DesktopRoot />
    </>,
  );
  return root;
}

async function openedNext(bridge: ReturnType<typeof renderRoot>) {
  await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
  expect(bridge.openWorkspace).toHaveBeenLastCalledWith({ workspaceId: OTHER_WORKSPACE.workspaceId });
  expect(screen.queryByTestId("workspace-open-failed")).toBeNull();
}

describe("a listed workspace dohc can't open", () => {
  it("offers Remove from list when the folder can never be a workspace, then opens the next workspace", async () => {
    const bridge = renderRoot([WORKSPACE, OTHER_WORKSPACE], refused("desktop:open-workspace", INSIDE_SETTINGS));

    const recovery = await screen.findByTestId("workspace-open-failed");
    expect(recovery.textContent).toContain("Couldn’t open this workspace");
    expect(recovery.textContent).toContain(INSIDE_SETTINGS);
    const remove = within(recovery).getByRole("button", { name: "Remove from list" });
    expect(document.activeElement).toBe(remove);
    expect(within(recovery).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(recovery).getByTestId("workspace-open-failed-folder").textContent).toBe(WORKSPACE.rootPath);
    expect(recovery.textContent).not.toContain("Choose another workspace from the title bar");
    expect(within(recovery).getByRole("button", { name: "Copy details" })).toBeTruthy();

    fireEvent.click(remove);
    await waitFor(() => expect(bridge.forgetWorkspace).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId }));
    expect(screen.queryByTestId("workspace-remove-confirm")).toBeNull();
    await openedNext(bridge);
  });

  it("shows the empty startup screen when the refused workspace was the only one", async () => {
    const bridge = renderRoot([WORKSPACE], refused("desktop:open-workspace", INSIDE_SETTINGS));

    fireEvent.click(within(await screen.findByTestId("workspace-open-failed")).getByRole("button", { name: "Remove from list" }));
    await screen.findByTestId("workspace-manager");
    expect(bridge.forgetWorkspace).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("workspace-shell")).toBeNull();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("says what goes with a synced workspace before it leaves the list", async () => {
    const synced: Workspace = { ...WORKSPACE, sync: "on" };
    const bridge = renderRoot([synced, OTHER_WORKSPACE], refused("desktop:open-workspace", INSIDE_SETTINGS));

    fireEvent.click(within(await screen.findByTestId("workspace-open-failed")).getByRole("button", { name: "Remove from list" }));
    const ask = await screen.findByTestId("workspace-remove-confirm");
    expect(ask.textContent).toContain("Sync turns off.");
    expect(bridge.forgetWorkspace).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByTestId("workspace-remove-confirm-button"));
    await waitFor(() => expect(bridge.forgetWorkspace).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId }));
    await openedNext(bridge);
  });

  it("keeps Try again when the folder may come back, such as on a drive that is not connected", async () => {
    const bridge = renderRoot([WORKSPACE, OTHER_WORKSPACE], new Error(
      "Error invoking remote method 'desktop:open-workspace': Error [ENOENT]: ENOENT: no such file or directory, stat '/home/sam/dohc/personal'",
    ));

    const recovery = await screen.findByTestId("workspace-open-failed");
    expect(recovery.textContent).toContain("The file or folder is not there anymore.");
    expect(within(recovery).getByTestId("workspace-open-failed-folder").textContent).toBe(WORKSPACE.rootPath);
    expect(recovery.textContent).toContain("Choose another workspace from the title bar.");
    expect(within(recovery).queryByRole("button", { name: "Remove from list" })).toBeNull();
    expect(within(recovery).getByRole("button", { name: "Copy details" })).toBeTruthy();

    fireEvent.click(within(recovery).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.openWorkspace).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    expect(bridge.forgetWorkspace).not.toHaveBeenCalled();
  });
});

describe("Open folder on a folder that can't be a workspace", () => {
  const PICKED = "/home/sam/.config/dohc/notes";

  function folderBridge(attachFailure: Error, platform: NodeJS.Platform = "linux") {
    return Object.assign(makeBridge(Promise.resolve(null), platform), {
      pickWorkspaceRoot: vi.fn(async (): Promise<string | null> => PICKED),
      attachWorkspaceFolder: vi.fn(async (_input: { rootPath: string }): Promise<Workspace> => {
        throw attachFailure;
      }),
    });
  }

  it("leads with the reason, offers Choose another folder, and keeps the folder in Details", async () => {
    const bridge = folderBridge(refused("desktop:attach-workspace-folder", INSIDE_SETTINGS));
    const user = userEvent.setup();
    renderShell(bridge);
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));

    act(() => bridge.emitMenuCommand("open-workspace"));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent?.startsWith(INSIDE_SETTINGS)).toBe(true);
    expect(toast.textContent).not.toContain(PICKED);
    expect(within(toast).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(toast).queryByTestId("workspace-shell-error-copy")).toBeNull();
    await user.click(within(toast).getByRole("button", { name: "Details" }));
    await user.click(within(toast).getByRole("button", { name: "Copy details" }));
    expect((await navigator.clipboard.readText()).split("\n")).toContain(`Chosen folder: ${PICKED}`);

    await user.click(within(toast).getByRole("button", { name: "Choose another folder" }));
    await waitFor(() => expect(bridge.pickWorkspaceRoot).toHaveBeenCalledTimes(2));
  });

  it("leads with System Settings when macOS refuses the folder, and still offers another folder", async () => {
    const bridge = folderBridge(new Error(
      `Error invoking remote method 'desktop:attach-workspace-folder': Error [privacy-denied]: EPERM: operation not permitted, scandir '${PICKED}'`,
    ), "darwin");
    renderShell(bridge);
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));

    act(() => bridge.emitMenuCommand("open-workspace"));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(PRIVACY_DENIED_WORDS);
    expect(within(toast).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(toast).getByTestId("workspace-shell-error-action").textContent).toBe("Open System Settings");
    fireEvent.click(within(toast).getByTestId("workspace-shell-error-additional-action"));
    await waitFor(() => expect(bridge.pickWorkspaceRoot).toHaveBeenCalledTimes(2));
  });
});
