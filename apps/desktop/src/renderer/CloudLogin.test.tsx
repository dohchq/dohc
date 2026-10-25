// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  onCloudSessionChanged: vi.fn(),
  openExternalUrl: vi.fn(),
  platform: "linux",
  insecureLoopbackServersForTests: false,
  // A panel with no owner above it raises its own notices through the shell's
  // notice center, which follows the update feed while it is mounted.
  getUpdateState: vi.fn(),
  onUpdateState: vi.fn(),
};

vi.mock("./bridge", () => ({
  bridge: () => bridgeMock,
}));

const CONNECTED: CloudStatusResult = {
  connected: true,
  email: "ice@dohc.dev",
  serverUrl: "https://dohc.example.test",
};

beforeEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  bridgeMock.cloudStatus.mockResolvedValue({ connected: false });
  bridgeMock.cloudLoginStart.mockResolvedValue({
    userCode: "ABCD",
    verificationUri: "https://cloud.dohc.dev/device",
  });
  bridgeMock.cloudLogout.mockResolvedValue(undefined);
  bridgeMock.onCloudSessionChanged.mockReturnValue(() => undefined);
  bridgeMock.openExternalUrl.mockResolvedValue(undefined);
  bridgeMock.getUpdateState.mockResolvedValue({ status: "idle", message: "Up to date" });
  bridgeMock.onUpdateState.mockReturnValue(() => undefined);
  bridgeMock.insecureLoopbackServersForTests = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CloudLogin", () => {
  it("sends a failed status check to the toast and keeps the panel honest", async () => {
    bridgeMock.cloudStatus
      .mockRejectedValueOnce(new Error("engine unavailable"))
      .mockResolvedValueOnce({ connected: false });

    render(<CloudLogin />);

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
    bridgeMock.cloudStatus.mockRejectedValue(new Error(
      "Error invoking remote method 'desktop:cloud-status': DaemonRefusalError [WORKSPACE_UNAVAILABLE]: workspace handle is unavailable",
    ));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<CloudLogin />);
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
    // Copy keeps the refusal the words came from, on its own line.
    expect(writeText.mock.calls[0]![0]).toContain(
      "Cause: DaemonRefusalError [WORKSPACE_UNAVAILABLE]: workspace handle is unavailable",
    );
  });

  it("closes from the X beside its heading when a dialog hosts it", async () => {
    const onClose = vi.fn();
    render(<CloudLogin onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks for one server address and links the setup guide", async () => {
    render(<CloudLogin />);

    expect((await screen.findByTestId("cloud-server-url") as HTMLInputElement).placeholder).toBe(
      "https://dohc.example.com",
    );
    expect(screen.queryByTestId("cloud-relay-url")).toBeNull();
    expect(screen.getByTestId("cloud-connect-start").textContent).toBe("Connect server");
    // The status check asks about the session only: syncing a workspace is a
    // setting, not part of connecting.
    expect(bridgeMock.cloudStatus).toHaveBeenCalledWith();

    fireEvent.click(screen.getByTestId("cloud-setup-guide"));
    await waitFor(() =>
      expect(bridgeMock.openExternalUrl).toHaveBeenCalledWith({
        url: "https://github.com/dohchq/dohc/blob/main/docs/how-to/self-host.md",
      }),
    );
  });

  it("names dohc Drive as coming soon without an action, and not when embedded", async () => {
    const { unmount } = render(<CloudLogin />);

    const comingSoon = await screen.findByTestId("cloud-drive-coming-soon");
    expect(comingSoon.textContent).toContain("Coming soon");
    expect(comingSoon.querySelector("button")).toBeNull();
    expect(comingSoon.querySelector("a")).toBeNull();
    unmount();

    render(<CloudLogin embedded />);
    await screen.findByTestId("cloud-server-url");
    expect(screen.queryByTestId("cloud-drive-coming-soon")).toBeNull();
  });

  it("names a missing server address instead of starting a login", async () => {
    render(<CloudLogin />);
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
    render(<CloudLogin />);
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

  it.each([
    ["off this machine", "http://dohc.example.test", false],
    ["on this machine", "http://localhost:1786", false],
    ["off this machine under the e2e switch", "http://dohc.example.test", true],
  ])("asks for https when the address is plain http %s", async (_where, address, insecureLoopback) => {
    bridgeMock.insecureLoopbackServersForTests = insecureLoopback;
    render(<CloudLogin />);
    await screen.findByTestId("cloud-server-url");
    fireEvent.change(screen.getByTestId("cloud-server-url"), {
      target: { value: address },
    });
    fireEvent.click(screen.getByTestId("cloud-connect-start"));

    expect(screen.getByTestId("cloud-connection-error").textContent).toBe(
      "dohc connects to servers only over https. Enter an https address.",
    );
    expect(bridgeMock.cloudLoginStart).not.toHaveBeenCalled();
  });

  it("submits the normalized server address with Enter", async () => {
    const user = userEvent.setup();
    render(<CloudLogin />);

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

  it("uses a plain http loopback server under the e2e switch", async () => {
    bridgeMock.insecureLoopbackServersForTests = true;
    render(<CloudLogin />);
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

    render(<CloudLogin />);
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

    render(<CloudLogin onConnectionError={onConnectionError} />);
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

    const { unmount } = render(<CloudLogin onConnectionError={onConnectionError} />);
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
      <CloudLogin onConnectionError={() => undefined} initialServerUrl={initialServerUrl} />
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

  it("ignores a login poll that completes after a retry address re-scoped the panel", async () => {
    vi.useFakeTimers();
    const poll = deferred<{ status: "complete"; email: string }>();
    const onConnected = vi.fn();
    bridgeMock.cloudLoginPoll.mockImplementationOnce(() => poll.promise);
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: false,
      serverUrl: "https://dohc.example.test",
    });

    const panel = (initialServerUrl: string) => (
      <CloudLogin onConnected={onConnected} onConnectionError={() => undefined} initialServerUrl={initialServerUrl} />
    );
    const { rerender } = render(panel(""));
    await act(async () => {});
    fireEvent.click(screen.getByTestId("cloud-connect-start"));
    await act(async () => {});
    expect(screen.getByTestId("cloud-login-pending")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await act(async () => {
      rerender(panel("https://other.example.test"));
    });
    await act(async () => {
      poll.resolve({ status: "complete", email: "old@dohc.dev" });
    });

    expect(screen.getByTestId("cloud-connect-start")).toBeTruthy();
    expect(screen.queryByText("old@dohc.dev")).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
  });

  // Outside a workspace there is no Settings page, so a session found here
  // shows the same account row, with Disconnect, and nothing about syncing.
  it("shows the account row for a session it finds, and no sync switch", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({ ...CONNECTED, networkAccess: "private" });

    render(<CloudLogin embedded />);

    const row = await screen.findByTestId("settings-row-account");
    expect(row.textContent).toContain("ice@dohc.dev");
    expect(within(row).getByTestId("cloud-connected-server").textContent).toBe(
      "https://dohc.example.test",
    );
    expect(within(row).getByTestId("cloud-network-access").textContent).toBe("Private network");
    expect(within(row).getByTestId("cloud-disconnect-explanation").textContent).toBe(
      "Stops sync for every workspace on this machine. Your files stay where they are.",
    );
    expect(screen.queryByRole("switch")).toBeNull();
    expect(bridgeMock.cloudEnableSync).not.toHaveBeenCalled();
  });

  // The join and share screens hear only a sign-in or a recheck. A host that
  // asks for the hand-off also hears a session the first check finds.
  it("announces a session the first check finds only to a host that asks for the hand-off", async () => {
    bridgeMock.cloudStatus.mockResolvedValue(CONNECTED);
    const onConnected = vi.fn();
    const { unmount } = render(<CloudLogin embedded onConnected={onConnected} />);
    await screen.findByTestId("settings-row-account");
    expect(onConnected).not.toHaveBeenCalled();
    unmount();

    render(<CloudLogin handOffSession onConnected={onConnected} />);
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
  });

  it("hands off nothing when the first check finds nobody signed in", async () => {
    const onConnected = vi.fn();
    render(<CloudLogin handOffSession onConnected={onConnected} />);
    await screen.findByTestId("cloud-server-url");
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("shows the connect form once Disconnect succeeds", async () => {
    bridgeMock.cloudStatus.mockResolvedValue(CONNECTED);

    render(<CloudLogin />);
    fireEvent.click(await screen.findByTestId("cloud-disconnect"));

    expect(await screen.findByTestId("cloud-server-url")).toBeTruthy();
    expect(bridgeMock.cloudLogout).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // Main clears the credentials before the cleanup that can fail, so a failed
  // disconnect says nothing about the session. Each outcome comes from the
  // status check that follows, never from the rejection.
  it("shows the connect form when a failed disconnect ended the session anyway", async () => {
    bridgeMock.cloudStatus
      .mockResolvedValueOnce(CONNECTED)
      .mockResolvedValueOnce({ connected: false });
    bridgeMock.cloudLogout.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:cloud-logout': Error: dohc could not stop sync for Notes.",
      ),
    );

    render(<CloudLogin />);
    fireEvent.click(await screen.findByTestId("cloud-disconnect"));

    expect(await screen.findByTestId("cloud-server-url")).toBeTruthy();
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
      "dohc could not stop sync for Notes.",
    );
    expect(screen.queryByTestId("cloud-connected")).toBeNull();
    expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(2);
  });

  it("stays connected when the check after a failed disconnect still finds a session", async () => {
    bridgeMock.cloudStatus.mockResolvedValue(CONNECTED);
    bridgeMock.cloudLogout.mockRejectedValueOnce(new Error("offline"));

    render(<CloudLogin />);
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
      .mockResolvedValueOnce(CONNECTED)
      .mockRejectedValueOnce(new Error("engine unavailable"));
    bridgeMock.cloudLogout.mockRejectedValueOnce(new Error("offline"));

    render(<CloudLogin />);
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

  it("announces a completed sign-in to the host", async () => {
    vi.useFakeTimers();
    const onConnected = vi.fn();
    bridgeMock.cloudStatus
      .mockResolvedValueOnce({ connected: false, serverUrl: "https://dohc.example.test" })
      .mockResolvedValueOnce({ ...CONNECTED, serverUrl: "https://dohc.example.test" });
    bridgeMock.cloudLoginPoll.mockResolvedValueOnce({ status: "complete", email: "ice@dohc.dev" });

    render(<CloudLogin onConnected={onConnected} />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("cloud-connect-start"));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("settings-row-account").textContent).toContain("ice@dohc.dev");
  });

  // The approval happened in the browser, but only main can say what this
  // machine's session is. A failed refresh is an operational failure, so the
  // panel stops claiming to know and the notice carries the way to ask again.
  it("sends a failed post-login status refresh to Notices instead of claiming a session", async () => {
    vi.useFakeTimers();
    const onConnected = vi.fn();
    bridgeMock.cloudStatus
      .mockResolvedValueOnce({ connected: false, serverUrl: "https://dohc.example.test" })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ...CONNECTED, serverUrl: "https://dohc.example.test" });
    bridgeMock.cloudLoginPoll.mockResolvedValueOnce({
      status: "complete",
      email: "ice@dohc.dev",
    });

    render(<CloudLogin onConnected={onConnected} />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("cloud-connect-start"));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByTestId("cloud-connection-unknown")).toBeTruthy();
    expect(screen.queryByTestId("settings-row-account")).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
      "dohc could not check this connection after sign-in.",
    );

    // Try again runs the check, not the whole login: the approval still holds.
    await act(async () => {
      fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));
    });

    expect(screen.getByTestId("settings-row-account").textContent).toContain("ice@dohc.dev");
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
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: false,
      serverUrl: "https://dohc.example.test",
    });
    bridgeMock.cloudLoginPoll.mockResolvedValueOnce({
      status: "complete",
      email: "ice@dohc.dev",
    });

    render(<CloudLogin onConnected={onConnected} />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("cloud-connect-start"));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.queryByTestId("settings-row-account")).toBeNull();
    expect(screen.getByTestId("cloud-server-url")).toBeTruthy();
    expect(onConnected).not.toHaveBeenCalled();
  });
});
