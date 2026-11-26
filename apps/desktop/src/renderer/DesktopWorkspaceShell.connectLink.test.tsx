// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CollectionFieldWriteHost } from "./collections/recordFieldWrites";
import {
  DesktopWorkspaceShell,
  makeBridge,
  shellBootstrapProps,
  WORKSPACE,
} from "./DesktopWorkspaceShell.testHarness";

describe("a dohc://connect link in an open workspace", () => {
  it("waits for Open a share to close, then fills in the address", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.cloudStatus.mockResolvedValue({
      connected: false,
      email: "",
      serverUrl: "",
      workspaceSynced: false,
    });
    vi.stubGlobal("dohcDesktop", bridge);
    let shown = 0;
    let deliver: (serverUrl: string) => void = () => undefined;
    // Holds the request until the shell shows it, as DesktopRoot does.
    function Root() {
      const [connectServerUrl, setConnectServerUrl] = useState<string | null>(null);
      deliver = setConnectServerUrl;
      const onConnectServerShown = useCallback(() => {
        shown += 1;
        setConnectServerUrl(null);
      }, []);
      return (
        <>
          <CollectionFieldWriteHost />
          <DesktopWorkspaceShell
            workspace={WORKSPACE}
            workspaces={[WORKSPACE]}
            {...shellBootstrapProps(bridge)}
            onSwitchWorkspace={() => {}}
            connectServerUrl={connectServerUrl}
            onConnectServerShown={onConnectServerShown}
          />
        </>
      );
    }
    render(<Root />);
    fireEvent.click(await screen.findByTestId("workspace-switcher"));
    fireEvent.click(await screen.findByTestId("workspace-switcher-open-share"));
    expect(await screen.findByTestId("open-shared-view")).toBeTruthy();

    act(() => deliver("https://drive.example"));
    expect(shown).toBe(0);
    expect(screen.queryByTestId("cloud-sync-panel")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect((screen.getByTestId("cloud-server-url") as HTMLInputElement).value).toBe(
        "https://drive.example",
      ),
    );
    expect(shown).toBe(1);
    expect(screen.queryByTestId("cloud-login-pending")).toBeNull();
  });
});
