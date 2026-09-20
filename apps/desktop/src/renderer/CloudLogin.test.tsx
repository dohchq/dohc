// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudStatusResult } from "../ipc/bridgeContract";
import { CloudLogin } from "./CloudLogin";

import { deferred } from "../testing/deferred";
const bridgeMock = {
  cloudStatus: vi.fn(),
  cloudEnableSync: vi.fn(),
  cloudLoginStart: vi.fn(),
  cloudLoginPoll: vi.fn(),
  cloudLogout: vi.fn(),
  openExternalUrl: vi.fn(),
  platform: "linux",
  // A panel with no owner above it raises its own notices through the shell's
  // notice center, which follows the update feed while it is mounted.
  getUpdateState: vi.fn(),
  onUpdateState: vi.fn(),
};

vi.mock("./bridge", () => ({
  bridge: () => bridgeMock,
}));

beforeEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  bridgeMock.cloudStatus.mockResolvedValue({
    connected: false,
    workspaceSynced: false,
  });
  bridgeMock.cloudEnableSync.mockResolvedValue(undefined);
  bridgeMock.cloudLoginStart.mockResolvedValue({
    userCode: "ABCD",
    verificationUri: "https://cloud.dohc.dev/device",
  });
  bridgeMock.cloudLogout.mockResolvedValue(undefined);
  bridgeMock.openExternalUrl.mockResolvedValue(undefined);
  bridgeMock.getUpdateState.mockResolvedValue({ status: "idle", message: "Up to date" });
  bridgeMock.onUpdateState.mockReturnValue(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CloudLogin", () => {
  it("sends a failed status check to the toast and keeps the panel honest", async () => {
    bridgeMock.cloudStatus
      .mockRejectedValueOnce(new Error("engine unavailable"))
      .mockResolvedValueOnce({ connected: false, workspaceSynced: false });

    render(<CloudLogin workspaceId="ws-1" />);

    // The panel says only what it knows. The failure is a notice.
    expect((await screen.findByTestId("cloud-connection-unknown")).textContent).toBe(
      "dohc doesn’t know whether this machine is connected.",
    );
    expect(screen.queryByTestId("cloud-server-url")).toBeNull();
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc could not check this connection.");
    expect(screen.getByTestId("workspace-shell-error-copy")).toBeTruthy();

    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));

    expect(await screen.findByTestId("cloud-server-url")).toBeTruthy();
    expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("keeps a connection failure in Notices with a report to copy", async () => {
    bridgeMock.cloudStatus.mockRejectedValue(new Error("engine unavailable"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<CloudLogin workspaceId="ws-1" />);
    await screen.findByTestId("workspace-shell-error");

    fireEvent.click(screen.getByLabelText("Dismiss workspace error"));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    const row = await screen.findByTestId("notice-shell-error-1");
    expect(row.textContent).toContain("dohc could not check this connection.");

    fireEvent.click(screen.getByTestId("notice-shell-error-1-copy"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("Error: dohc could not check this connection."),
      ),
    );
  });

  it("asks for one server address and links the setup guide", async () => {
    render(<CloudLogin workspaceId="ws-1" />);

    expect((await screen.findByTestId("cloud-server-url") as HTMLInputElement).placeholder).toBe(
      "https://dohc.example.com",
    );
    expect(screen.queryByTestId("cloud-relay-url")).toBeNull();
    expect(screen.getByTestId("cloud-connect-start").textContent).toBe("Connect server");

    fireEvent.click(screen.getByTestId("cloud-setup-guide"));
    await waitFor(() =>
      expect(bridgeMock.openExternalUrl).toHaveBeenCalledWith({
        url: "https://github.com/dohc-ai/dohc/blob/main/docs/how-to/self-host.md",
      }),
    );
  });

  it("names dohc Drive as coming soon without an action, and not when embedded", async () => {
    const { unmount } = render(<CloudLogin workspaceId="ws-1" />);

    const comingSoon = await screen.findByTestId("cloud-drive-coming-soon");
    expect(comingSoon.textContent).toContain("Coming soon");
    expect(comingSoon.querySelector("button")).toBeNull();
    expect(comingSoon.querySelector("a")).toBeNull();
    unmount();

    render(<CloudLogin workspaceId="ws-1" embedded />);
    await screen.findByTestId("cloud-server-url");
    expect(screen.queryByTestId("cloud-drive-coming-soon")).toBeNull();
  });

  it("names a missing server address instead of starting a login", async () => {
    render(<CloudLogin workspaceId="ws-1" />);
    await screen.findByTestId("cloud-server-url");

    fireEvent.click(screen.getByTestId("cloud-connect-start"));

    const error = screen.getByRole("alert");
    expect(error.textContent).toBe("Enter the address of your server.");
    const serverUrl = screen.getByTestId("cloud-server-url");
    expect(serverUrl.getAttribute("aria-invalid")).toBe("true");
    expect(serverUrl.getAttribute("aria-describedby")).toBe(error.id);
    expect(document.activeElement).toBe(serverUrl);
    expect(bridgeMock.cloudLoginStart).not.toHaveBeenCalled();
  });

  it("rejects a server address that is not an origin", async () => {
    render(<CloudLogin workspaceId="ws-1" />);
    await screen.findByTestId("cloud-server-url");
    fireEvent.change(screen.getByTestId("cloud-server-url"), {
      target: { value: "https://dohc.example.test/api" },
    });
    fireEvent.click(screen.getByTestId("cloud-connect-start"));

    expect(screen.getByTestId("cloud-connection-error").textContent).toBe(
      "Enter the server address like https://dohc.example.com.",
    );
    const serverUrl = screen.getByTestId("cloud-server-url");
    expect(serverUrl.getAttribute("aria-invalid")).toBe("true");
    expect(serverUrl.getAttribute("aria-describedby")).toBe("cloud-connection-error");
    expect(document.activeElement).toBe(serverUrl);
    expect(bridgeMock.cloudLoginStart).not.toHaveBeenCalled();
  });

  it("asks for https when the address is plain http off this machine", async () => {
    render(<CloudLogin workspaceId="ws-1" />);
    await screen.findByTestId("cloud-server-url");
    fireEvent.change(screen.getByTestId("cloud-server-url"), {
      target: { value: "http://dohc.example.test" },
    });
    fireEvent.click(screen.getByTestId("cloud-connect-start"));

    expect(screen.getByTestId("cloud-connection-error").textContent).toBe(
      "Enter an https address. dohc allows http only for localhost.",
    );
    expect(bridgeMock.cloudLoginStart).not.toHaveBeenCalled();
  });

  it("submits the normalized server address with Enter", async () => {
    const user = userEvent.setup();
    render(<CloudLogin workspaceId="ws-1" />);

    await user.type(
      await screen.findByTestId("cloud-server-url"),
      "HTTPS://Dohc.Example.Test:443/{Enter}",
    );

    await waitFor(() =>
      expect(bridgeMock.cloudLoginStart).toHaveBeenCalledWith({
        serverUrl: "https://dohc.example.test",
      }),
    );
  });

  it("uses loopback only when the user enters it", async () => {
    render(<CloudLogin workspaceId="ws-1" />);
    await screen.findByTestId("cloud-server-url");
    fireEvent.change(screen.getByTestId("cloud-server-url"), {
      target: { value: "http://localhost:1786" },
    });
    fireEvent.click(screen.getByTestId("cloud-connect-start"));

    await waitFor(() =>
      expect(bridgeMock.cloudLoginStart).toHaveBeenCalledWith({
        serverUrl: "http://localhost:1786",
      }),
    );
  });

  it("keeps the main process's own reason when a connection fails", async () => {
    bridgeMock.cloudLoginStart.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:cloud-login-start': Error: dohc found no dohc server at https://dohc.example.test.",
      ),
    );

    render(<CloudLogin workspaceId="ws-1" />);
    fireEvent.change(await screen.findByTestId("cloud-server-url"), {
      target: { value: "https://dohc.example.test" },
    });
    fireEvent.click(screen.getByTestId("cloud-connect-start"));

    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "dohc found no dohc server at https://dohc.example.test.",
    );
    // The form is back, with the address the attempt used, and says nothing
    // about the failure itself.
    expect((screen.getByTestId("cloud-server-url") as HTMLInputElement).value).toBe(
      "https://dohc.example.test",
    );
    expect(screen.queryByTestId("cloud-connection-error")).toBeNull();
  });

  it("hands a connection failure to the surface that owns notices", async () => {
    const onConnectionError = vi.fn();
    bridgeMock.cloudLoginStart
      .mockRejectedValueOnce(new Error("dohc couldn't reach that server."))
      .mockResolvedValueOnce({
        userCode: "ABCD",
        verificationUri: "https://cloud.dohc.dev/device",
      });

    render(<CloudLogin workspaceId="ws-1" onConnectionError={onConnectionError} />);
    fireEvent.change(await screen.findByTestId("cloud-server-url"), {
      target: { value: "https://dohc.example.test" },
    });
    fireEvent.click(screen.getByTestId("cloud-connect-start"));

    await waitFor(() => expect(onConnectionError).toHaveBeenCalledTimes(1));
    // No panel of its own: the owner raises the toast and the Notices row.
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(screen.queryByTestId("connection-notices")).toBeNull();

    const report = onConnectionError.mock.calls[0]?.[0];
    expect(report.message).toBe("dohc couldn't reach that server.");
    expect(report.serverUrl).toBe("https://dohc.example.test");

    // The retry reruns the same address while this panel is still the one
    // that made the attempt.
    expect(report.retry()).toBe(true);
    await waitFor(() =>
      expect(bridgeMock.cloudLoginStart).toHaveBeenLastCalledWith({
        serverUrl: "https://dohc.example.test",
      }),
    );
  });

  it("refuses a retry once the panel that made the attempt is gone", async () => {
    const onConnectionError = vi.fn();
    bridgeMock.cloudLoginStart.mockRejectedValueOnce(new Error("offline"));

    const { unmount } = render(
      <CloudLogin workspaceId="ws-1" onConnectionError={onConnectionError} />,
    );
    fireEvent.change(await screen.findByTestId("cloud-server-url"), {
      target: { value: "https://dohc.example.test" },
    });
    fireEvent.click(screen.getByTestId("cloud-connect-start"));
    await waitFor(() => expect(onConnectionError).toHaveBeenCalledTimes(1));

    unmount();
    const report = onConnectionError.mock.calls[0]?.[0];
    // False is what tells the owner to reopen the panel instead.
    expect(report.retry()).toBe(false);
    expect(bridgeMock.cloudLoginStart).toHaveBeenCalledTimes(1);
  });

  it("starts from the address the owner hands back when it reopens the panel", async () => {
    render(
      <CloudLogin
        workspaceId="ws-1"
        onConnectionError={() => undefined}
        initialServerUrl="https://dohc.example.test"
      />,
    );

    expect(
      ((await screen.findByTestId("cloud-server-url")) as HTMLInputElement).value,
    ).toBe("https://dohc.example.test");
  });

  // The owner can hand that address back while this panel is already on
  // screen: the user reopened it before choosing Try again on the notice.
  it("re-scopes an open panel to a retry address, and leaves ordinary renders alone", async () => {
    const panel = (initialServerUrl: string) => (
      <CloudLogin
        workspaceId="ws-1"
        onConnectionError={() => undefined}
        initialServerUrl={initialServerUrl}
      />
    );
    const { rerender } = render(panel(""));
    const field = (await screen.findByTestId("cloud-server-url")) as HTMLInputElement;
    expect(field.value).toBe("");
    const checks = bridgeMock.cloudStatus.mock.calls.length;

    // An ordinary render passes the same address and must not take the field
    // away from someone typing in it.
    fireEvent.change(field, { target: { value: "https://typed.example.test" } });
    rerender(panel(""));
    expect((screen.getByTestId("cloud-server-url") as HTMLInputElement).value).toBe(
      "https://typed.example.test",
    );
    expect(bridgeMock.cloudStatus.mock.calls.length).toBe(checks);

    rerender(panel("https://dohc.example.test"));

    await waitFor(() =>
      expect((screen.getByTestId("cloud-server-url") as HTMLInputElement).value).toBe(
        "https://dohc.example.test",
      ),
    );
    expect(bridgeMock.cloudStatus.mock.calls.length).toBeGreaterThan(checks);
  });

  it("ignores stale status responses after switching workspaces", async () => {
    const oldStatus = deferred<{
      connected: boolean;
      email?: string;
      workspaceSynced?: boolean;
    }>();
    bridgeMock.cloudStatus.mockImplementation((payload?: { workspaceId?: string }) =>
      payload?.workspaceId === "old"
        ? oldStatus.promise
          : Promise.resolve({
              connected: true,
              email: "new@dohc.dev",
              workspaceSynced: true,
              workspaceSyncConnected: true,
            }),
    );

    const { rerender } = render(<CloudLogin workspaceId="old" />);
    rerender(<CloudLogin workspaceId="new" />);

    await screen.findByTestId("cloud-connected-email");
    await act(async () => {
      oldStatus.resolve({ connected: true, email: "old@dohc.dev", workspaceSynced: false });
    });

    await waitFor(() =>
      expect(screen.getByTestId("cloud-connected-email").textContent).toBe("new@dohc.dev"),
    );
  });

  it("ignores stale login poll completions after the workspace changes", async () => {
    vi.useFakeTimers();
    const poll = deferred<{ status: "complete"; email: string }>();
    bridgeMock.cloudLoginPoll.mockImplementationOnce(() => poll.promise);
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: false,
      workspaceSynced: false,
      serverUrl: "https://dohc.example.test",
    });

    const { rerender } = render(<CloudLogin workspaceId="old" />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("cloud-connect-start"));
    await act(async () => {});
    expect(screen.getByTestId("cloud-login-pending")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await act(async () => {
      rerender(<CloudLogin workspaceId="new" />);
    });
    await act(async () => {
      poll.resolve({ status: "complete", email: "old@dohc.dev" });
    });

    expect(screen.getByTestId("cloud-connect-start")).toBeTruthy();
    expect(screen.queryByText("old@dohc.dev")).toBeNull();
  });

  it("names the connected server and account", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      serverUrl: "https://dohc.example.test",
      workspaceSynced: false,
    });

    render(<CloudLogin workspaceId="ws-1" />);

    expect((await screen.findByTestId("cloud-connected-server")).textContent).toBe(
      "https://dohc.example.test",
    );
    expect(screen.getByTestId("cloud-connected-email").textContent).toBe("ice@dohc.dev");
  });

  it("names the server the way the server names itself, beside its address", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      serverUrl: "https://dohc.example.test",
      serverName: "Vera's server",
      workspaceSynced: false,
    });

    render(<CloudLogin workspaceId="ws-1" />);

    expect(
      (await screen.findByTestId("cloud-connected-server-name")).textContent,
    ).toBe("Vera's server");
    expect(screen.getByTestId("cloud-connected-server").textContent).toBe(
      "https://dohc.example.test",
    );
    expect(screen.getByTestId("cloud-connected").textContent).toContain(
      "This machine is connected to Vera's server as ice@dohc.dev.",
    );
  });

  it("says a private server needs network access, and stays quiet for a public one", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      serverUrl: "https://dohc.example.test",
      networkAccess: "private",
      workspaceSynced: false,
    });

    const { unmount } = render(<CloudLogin workspaceId="ws-1" />);

    expect((await screen.findByTestId("cloud-network-access")).textContent).toBe(
      "This server is on a private network. Everyone you share with needs access to that network, from every device they use.",
    );
    unmount();

    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      serverUrl: "https://dohc.example.test",
      networkAccess: "public",
      workspaceSynced: false,
    });
    render(<CloudLogin workspaceId="ws-1" />);
    await screen.findByTestId("cloud-connected");
    expect(screen.queryByTestId("cloud-network-access")).toBeNull();
  });

  it("says disconnecting reaches every workspace on this machine", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      serverUrl: "https://dohc.example.test",
      workspaceSynced: false,
    });

    render(<CloudLogin workspaceId="ws-1" />);

    expect((await screen.findByTestId("cloud-connected")).textContent).toContain(
      "Disconnecting stops sync for every workspace on this machine.",
    );
  });

  // Main clears the credentials before the cleanup that can fail, so a failed
  // disconnect says nothing about the session. Each outcome comes from the
  // status check that follows, never from the rejection.
  it("shows the connect form when a failed disconnect ended the session anyway", async () => {
    bridgeMock.cloudStatus
      .mockResolvedValueOnce({
        connected: true,
        email: "ice@dohc.dev",
        serverUrl: "https://dohc.example.test",
        workspaceSynced: true,
        workspaceSyncConnected: true,
      })
      .mockResolvedValueOnce({ connected: false, workspaceSynced: false });
    bridgeMock.cloudLogout.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:cloud-logout': Error: dohc could not stop sync for Notes.",
      ),
    );

    render(<CloudLogin workspaceId="ws-1" />);
    fireEvent.click(await screen.findByTestId("cloud-disconnect"));

    expect(await screen.findByTestId("cloud-server-url")).toBeTruthy();
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
      "dohc could not stop sync for Notes.",
    );
    expect(screen.queryByTestId("cloud-connected")).toBeNull();
    expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(2);
  });

  it("stays connected when the check after a failed disconnect still finds a session", async () => {
    bridgeMock.cloudStatus
      .mockResolvedValueOnce({
        connected: true,
        email: "ice@dohc.dev",
        serverUrl: "https://dohc.example.test",
        workspaceSynced: true,
        workspaceSyncConnected: true,
      })
      .mockResolvedValueOnce({
        connected: true,
        email: "ice@dohc.dev",
        serverUrl: "https://dohc.example.test",
        workspaceSynced: true,
        workspaceSyncConnected: true,
      });
    bridgeMock.cloudLogout.mockRejectedValueOnce(new Error("offline"));

    render(<CloudLogin workspaceId="ws-1" />);
    fireEvent.click(await screen.findByTestId("cloud-disconnect"));

    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "offline",
    );
    expect(screen.getByTestId("cloud-connected")).toBeTruthy();
    // The same button is the retry once the check has answered.
    await waitFor(() =>
      expect(
        (screen.getByTestId("cloud-disconnect") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("admits it cannot tell when the check after a failed disconnect also fails", async () => {
    bridgeMock.cloudStatus
      .mockResolvedValueOnce({
        connected: true,
        email: "ice@dohc.dev",
        serverUrl: "https://dohc.example.test",
        workspaceSynced: false,
      })
      .mockRejectedValueOnce(new Error("engine unavailable"));
    bridgeMock.cloudLogout.mockRejectedValueOnce(new Error("offline"));

    render(<CloudLogin workspaceId="ws-1" />);
    fireEvent.click(await screen.findByTestId("cloud-disconnect"));

    expect(await screen.findByTestId("cloud-connection-unknown")).toBeTruthy();
    // Neither the connect form nor the connected panel would be true here.
    expect(screen.queryByTestId("cloud-server-url")).toBeNull();
    expect(screen.queryByTestId("cloud-connected")).toBeNull();
    // One notice for the one failure, and it carries the way to ask again.
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain("offline");

    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));
    await waitFor(() => expect(bridgeMock.cloudLogout).toHaveBeenCalledTimes(2));
  });

  it("enables sync for an unsynced workspace", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: false,
    });

    render(<CloudLogin workspaceId="ws-1" />);

    fireEvent.click(await screen.findByTestId("cloud-enable-sync"));
    await waitFor(() =>
      expect(bridgeMock.cloudEnableSync).toHaveBeenCalledWith({
        workspaceId: "ws-1",
      }),
    );
    expect(await screen.findByTestId("cloud-workspace-synced")).toBeTruthy();
  });

  it("prompts before an unsynced workspace enrolls its protected-file key", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: false,
      workspaceSecretState: "protected-key-present",
    });
    bridgeMock.cloudEnableSync
      .mockRejectedValueOnce(
        new Error("Passphrase required to protect synced secrets."),
      )
      .mockResolvedValueOnce(undefined);

    render(<CloudLogin workspaceId="ws-1" />);
    fireEvent.click(await screen.findByTestId("cloud-enable-sync"));
    const input = await screen.findByTestId("cloud-sync-passphrase");
    const enable = screen.getByTestId("cloud-enable-sync") as HTMLButtonElement;
    expect(screen.getByTestId("cloud-sync-error").textContent).toBe(
      "Enter at least 8 characters to protect synced secrets.",
    );
    fireEvent.change(input, { target: { value: "1234567" } });
    expect(enable.disabled).toBe(true);
    expect(bridgeMock.cloudEnableSync).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: "12345678" } });
    expect(enable.disabled).toBe(false);
    fireEvent.click(screen.getByTestId("cloud-enable-sync"));

    await waitFor(() =>
      expect(bridgeMock.cloudEnableSync).toHaveBeenLastCalledWith({
        workspaceId: "ws-1",
        passphrase: "12345678",
      }),
    );
    expect(await screen.findByTestId("cloud-workspace-synced")).toBeTruthy();
  });

  it("states the minimum when the engine rejects an enrollment passphrase", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: false,
      workspaceSecretState: "protected-key-present",
    });
    bridgeMock.cloudEnableSync.mockRejectedValueOnce(
      new Error("Passphrase must be at least 8 characters."),
    );

    render(<CloudLogin workspaceId="ws-1" />);
    fireEvent.click(await screen.findByTestId("cloud-enable-sync"));

    expect((await screen.findByTestId("cloud-sync-error")).textContent).toBe(
      "Enter at least 8 characters to protect synced secrets.",
    );
    expect(screen.getByTestId("cloud-sync-passphrase")).toBeTruthy();
  });

  it("shows the copyable sync code for a synced workspace", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: true,
      workspaceSyncConnected: true,
      serverUrl: "http://localhost:1786",
      relayUrl: "http://localhost:1788",
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<CloudLogin workspaceId="ws-1" />);
    const code = await screen.findByTestId("cloud-sync-code");
    expect(code.textContent).toBe("dohc-sync:ws-1:http://localhost:1788");
    expect(screen.getByTestId("cloud-sync-code-block").textContent).toContain(
      "Add this workspace on another machine",
    );

    fireEvent.click(screen.getByTestId("cloud-copy-sync-code"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("dohc-sync:ws-1:http://localhost:1788"),
    );
  });

  it("shows a recovery state when this account cannot use the workspace remote", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "other@dohc.dev",
      workspaceSynced: true,
      workspaceSyncConnected: false,
      relayUrl: "http://localhost:1788",
    });

    render(<CloudLogin workspaceId="ws-1" />);

    expect((await screen.findByTestId("cloud-workspace-relink")).textContent).toContain(
      "Sync is paused",
    );
    expect(screen.queryByTestId("cloud-workspace-synced")).toBeNull();
    expect(screen.queryByTestId("cloud-sync-code-block")).toBeNull();
    fireEvent.click(screen.getByTestId("cloud-relink-workspace"));
    await waitFor(() =>
      expect(bridgeMock.cloudEnableSync).toHaveBeenCalledWith({
        workspaceId: "ws-1",
      }),
    );
    expect(await screen.findByTestId("cloud-workspace-synced")).toBeTruthy();
  });

  // A claim, relay, or engine failure is nothing the panel can fix, so it
  // leaves through the same toast and Notices row as every other operational
  // failure. Passphrase problems stay in the field.
  it("sends a failed enable sync to Notices and retries it from there", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: false,
      relayUrl: "http://localhost:1788",
    });
    bridgeMock.cloudEnableSync
      .mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'desktop:cloud-enable-sync': Error: This workspace is already claimed by another account.",
        ),
      )
      .mockResolvedValueOnce(undefined);

    render(<CloudLogin workspaceId="ws-1" />);
    fireEvent.click(await screen.findByTestId("cloud-enable-sync"));

    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(
      "This workspace is already claimed by another account.",
    );
    expect(screen.queryByTestId("cloud-sync-error")).toBeNull();
    expect(screen.queryByTestId("cloud-sync-passphrase")).toBeNull();

    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));

    expect(await screen.findByTestId("cloud-workspace-synced")).toBeTruthy();
    expect(bridgeMock.cloudEnableSync).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("refreshes fail-closed workspace verification after login completes", async () => {
    vi.useFakeTimers();
    bridgeMock.cloudStatus
      .mockResolvedValueOnce({
        connected: false,
        workspaceSynced: true,
        serverUrl: "http://localhost:1786",
      })
      .mockResolvedValueOnce({
        connected: true,
        email: "ice@dohc.dev",
        workspaceSynced: true,
        workspaceSyncConnected: false,
        serverUrl: "http://localhost:1786",
        relayUrl: "http://localhost:1788",
      });
    bridgeMock.cloudLoginPoll.mockResolvedValueOnce({
      status: "complete",
      email: "ice@dohc.dev",
    });

    render(<CloudLogin workspaceId="ws-1" />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("cloud-connect-start"));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByTestId("cloud-workspace-relink")).toBeTruthy();
    expect(screen.queryByTestId("cloud-workspace-synced")).toBeNull();
    expect(screen.queryByTestId("cloud-sync-code-block")).toBeNull();
    expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(2);
  });

  // The approval happened in the browser, but only main can say what this
  // machine's session is. A failed refresh is an operational failure, so the
  // panel stops claiming to know and the notice carries the way to ask again.
  it("sends a failed post-login status refresh to Notices instead of claiming a session", async () => {
    vi.useFakeTimers();
    const onConnected = vi.fn();
    bridgeMock.cloudStatus
      .mockResolvedValueOnce({
        connected: false,
        workspaceSynced: true,
        workspaceSyncConnected: true,
        workspaceSecretState: "protected-key-missing",
        serverUrl: "http://localhost:1786",
        relayUrl: "http://localhost:1788",
      })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        connected: true,
        email: "ice@dohc.dev",
        workspaceSynced: true,
        workspaceSyncConnected: true,
        workspaceSecretState: "protected-key-missing",
        serverUrl: "http://localhost:1786",
        relayUrl: "http://localhost:1788",
      });
    bridgeMock.cloudLoginPoll.mockResolvedValueOnce({
      status: "complete",
      email: "ice@dohc.dev",
    });

    render(<CloudLogin workspaceId="ws-1" onConnected={onConnected} />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("cloud-connect-start"));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByTestId("cloud-connection-unknown")).toBeTruthy();
    expect(screen.queryByTestId("cloud-connected-email")).toBeNull();
    expect(screen.queryByTestId("cloud-workspace-synced")).toBeNull();
    expect(screen.queryByTestId("cloud-sync-code-block")).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
      "dohc could not check this connection after sign-in.",
    );

    // Try again runs the check, not the whole login: the approval still holds.
    await act(async () => {
      fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));
    });

    expect(screen.getByTestId("cloud-connected-email").textContent).toBe("ice@dohc.dev");
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(3);
    expect(bridgeMock.cloudLoginStart).toHaveBeenCalledTimes(1);
    // The host learns about the session the recheck found.
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  // The poll proves the browser approved. Only the status that follows can
  // say whether this machine ended up with a session.
  it("stays disconnected when the status after a completed login reports no session", async () => {
    vi.useFakeTimers();
    const onConnected = vi.fn();
    bridgeMock.cloudStatus
      .mockResolvedValueOnce({
        connected: false,
        workspaceSynced: false,
        serverUrl: "http://localhost:1786",
      })
      .mockResolvedValueOnce({
        connected: false,
        workspaceSynced: false,
        serverUrl: "http://localhost:1786",
      });
    bridgeMock.cloudLoginPoll.mockResolvedValueOnce({
      status: "complete",
      email: "ice@dohc.dev",
    });

    render(<CloudLogin workspaceId="ws-1" onConnected={onConnected} />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("cloud-connect-start"));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.queryByTestId("cloud-connected-email")).toBeNull();
    expect(screen.getByTestId("cloud-server-url")).toBeTruthy();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("ignores a stale post-login status refresh after switching workspaces (%s)", async (outcome) => {
    vi.useFakeTimers();
    const oldStatus = deferred<CloudStatusResult>();
    const onConnected = vi.fn();
    bridgeMock.cloudStatus
      .mockResolvedValueOnce({
        connected: false,
        workspaceSynced: true,
        serverUrl: "http://localhost:1786",
      })
      .mockImplementationOnce(() => oldStatus.promise)
      .mockResolvedValueOnce({
        connected: true,
        email: "new@dohc.dev",
        workspaceSynced: false,
      });
    bridgeMock.cloudLoginPoll.mockResolvedValueOnce({
      status: "complete",
      email: "old@dohc.dev",
    });

    const { rerender } = render(<CloudLogin workspaceId="old" onConnected={onConnected} />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("cloud-connect-start"));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(2);

    rerender(<CloudLogin workspaceId="new" onConnected={onConnected} />);
    await act(async () => {});
    await act(async () => {
      if (outcome === "reject") {
        oldStatus.reject(new Error("old workspace offline"));
      } else {
        oldStatus.resolve({
          connected: true,
          email: "old@dohc.dev",
          workspaceSynced: true,
          workspaceSyncConnected: true,
        });
      }
    });

    expect(screen.getByTestId("cloud-connected-email").textContent).toBe("new@dohc.dev");
    expect(screen.getByTestId("cloud-enable-sync")).toBeTruthy();
    expect(screen.queryByTestId("cloud-workspace-synced")).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("omits the sync code when the session has no relay (nothing to join through)", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: true,
      workspaceSyncConnected: true,
      serverUrl: "http://localhost:1786",
    });
    render(<CloudLogin workspaceId="ws-1" />);
    await screen.findByTestId("cloud-workspace-synced");
    expect(screen.queryByTestId("cloud-sync-code-block")).toBeNull();
  });

  it("protects an already-synced workspace with a passphrase when the local key is present", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: true,
      workspaceSyncConnected: true,
      workspaceSecretState: "protected-key-present",
    });

    render(<CloudLogin workspaceId="ws-1" />);
    fireEvent.click(await screen.findByTestId("cloud-protect-secrets"));

    const input = await screen.findByTestId("cloud-sync-passphrase");
    expect((screen.getByTestId("cloud-protect-secrets") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(input, { target: { value: "shared passphrase" } });
    fireEvent.click(screen.getByTestId("cloud-protect-secrets"));

    await waitFor(() =>
      expect(bridgeMock.cloudEnableSync).toHaveBeenLastCalledWith({
        workspaceId: "ws-1",
        passphrase: "shared passphrase",
      }),
    );
  });

  // Switch workspaces while cloudEnableSync is pending to observe its stale-result guard.
  it("does not let a stale protect result mark the next workspace as synced", async () => {
    const staleEnable = deferred<void>();
    bridgeMock.cloudStatus.mockImplementation(async (payload) => ({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: payload?.workspaceId === "old",
      workspaceSyncConnected: payload?.workspaceId === "old",
      ...(payload?.workspaceId === "old"
        ? { workspaceSecretState: "protected-key-present" as const }
        : {}),
    }));
    bridgeMock.cloudEnableSync.mockReturnValueOnce(staleEnable.promise);

    const { rerender } = render(<CloudLogin workspaceId="old" />);
    fireEvent.click(await screen.findByTestId("cloud-protect-secrets"));
    fireEvent.change(await screen.findByTestId("cloud-sync-passphrase"), {
      target: { value: "shared passphrase" },
    });
    fireEvent.click(screen.getByTestId("cloud-protect-secrets"));
    await waitFor(() => expect(bridgeMock.cloudEnableSync).toHaveBeenCalled());

    rerender(<CloudLogin workspaceId="new" />);
    await screen.findByTestId("cloud-enable-sync");

    await act(async () => {
      staleEnable.resolve();
    });

    expect(screen.queryByTestId("cloud-workspace-synced")).toBeNull();
  });

  it("unlocks protected files later when a synced workspace is missing its local key", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: true,
      workspaceSyncConnected: true,
      workspaceSecretState: "protected-key-missing",
    });

    render(<CloudLogin workspaceId="ws-1" />);
    fireEvent.click(await screen.findByTestId("cloud-unlock-secrets"));

    const input = await screen.findByTestId("cloud-sync-passphrase");
    expect((screen.getByTestId("cloud-unlock-secrets") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(input, { target: { value: "shared passphrase" } });
    fireEvent.click(screen.getByTestId("cloud-unlock-secrets"));

    await waitFor(() =>
      expect(bridgeMock.cloudEnableSync).toHaveBeenLastCalledWith({
        workspaceId: "ws-1",
        passphrase: "shared passphrase",
      }),
    );
    await waitFor(() => expect(screen.getByTestId("cloud-protect-secrets")).toBeTruthy());
  });

  it("surfaces an unlock failure and keeps the passphrase prompt open", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: true,
      workspaceSyncConnected: true,
      workspaceSecretState: "protected-key-missing",
    });
    // The main-process wording the renderer keys off (/passphrase/ + /could not/).
    bridgeMock.cloudEnableSync.mockRejectedValue(
      new Error("Passphrase could not unlock synced secrets."),
    );

    render(<CloudLogin workspaceId="ws-1" />);
    fireEvent.click(await screen.findByTestId("cloud-unlock-secrets"));

    const input = await screen.findByTestId("cloud-sync-passphrase");
    fireEvent.change(input, { target: { value: "wrong passphrase" } });
    fireEvent.click(screen.getByTestId("cloud-unlock-secrets"));

    await waitFor(() =>
      expect(screen.getByTestId("cloud-sync-error").textContent).toContain(
        "couldn't unlock synced secrets",
      ),
    );
    // The prompt stays open for a retry rather than vanishing on failure.
    expect(screen.getByTestId("cloud-sync-passphrase")).toBeTruthy();
    expect(screen.queryByTestId("cloud-protect-secrets")).toBeNull();
  });
});
