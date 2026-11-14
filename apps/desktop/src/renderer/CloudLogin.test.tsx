// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

    expect((await screen.findByTestId("cloud-connection-unknown")).textContent).toBe("Try again");
    expect(screen.queryByTestId("cloud-server-url")).toBeNull();
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc could not check this connection.");
    expect(screen.getByTestId("workspace-shell-error-details")).toBeTruthy();

    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));

    expect(await screen.findByTestId("cloud-server-url")).toBeTruthy();
    expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("rejects a server address that is not an origin", async () => {
    render(<CloudLogin />);
    await screen.findByTestId("cloud-server-url");
    fireEvent.change(screen.getByTestId("cloud-server-url"), {
      target: { value: "https://dohc.example.test/api" },
    });
    fireEvent.click(screen.getByTestId("cloud-connect-start"));

    expect(screen.getByTestId("cloud-connection-error").textContent).toBe(
      "Enter a server address like https://dohc.example.com.",
    );
    const serverUrl = screen.getByTestId("cloud-server-url");
    expect(serverUrl.getAttribute("aria-invalid")).toBe("true");
    expect(serverUrl.getAttribute("aria-describedby")).toBe("cloud-connection-error");
    expect(document.activeElement).toBe(serverUrl);
    expect(bridgeMock.cloudLoginStart).not.toHaveBeenCalled();
  });

  it.each([
    ["off this machine", "http://dohc.example.test", false],
    ["off this machine under the e2e switch", "http://dohc.example.test", true],
  ])(
    "asks for https when the address is plain http %s",
    async (_where, address, insecureLoopback) => {
      bridgeMock.insecureLoopbackServersForTests = insecureLoopback;
      render(<CloudLogin />);
      await screen.findByTestId("cloud-server-url");
      fireEvent.change(screen.getByTestId("cloud-server-url"), {
        target: { value: address },
      });
      fireEvent.click(screen.getByTestId("cloud-connect-start"));

      expect(screen.getByTestId("cloud-connection-error").textContent).toBe(
        "Enter an HTTPS server address.",
      );
      expect(bridgeMock.cloudLoginStart).not.toHaveBeenCalled();
    },
  );

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
      <CloudLogin
        onConnected={onConnected}
        onConnectionError={() => undefined}
        initialServerUrl={initialServerUrl}
      />
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

  it("stays connected when the check after a failed disconnect still finds a session", async () => {
    bridgeMock.cloudStatus.mockResolvedValue(CONNECTED);
    bridgeMock.cloudLogout.mockRejectedValueOnce(new Error("offline"));

    render(<CloudLogin />);
    fireEvent.click(await screen.findByTestId("cloud-disconnect"));

    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain("offline");
    expect(screen.getByTestId("cloud-connected")).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByTestId("cloud-disconnect") as HTMLButtonElement).disabled).toBe(false),
    );
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

  it("signs in again to the session's server without disconnecting", async () => {
    vi.useFakeTimers();
    const onConnected = vi.fn();
    bridgeMock.cloudStatus.mockResolvedValue(CONNECTED);
    bridgeMock.cloudLoginPoll.mockResolvedValueOnce({ status: "complete", email: "ice@dohc.dev" });

    render(<CloudLogin renew handOffSession onConnected={onConnected} />);
    await act(async () => {});
    await act(async () => {});

    expect(bridgeMock.cloudLoginStart).toHaveBeenCalledWith({
      serverUrl: "https://dohc.example.test",
    });
    expect(screen.getByTestId("cloud-user-code").textContent).toBe("ABCD");
    expect(screen.queryByTestId("cloud-server-url")).toBeNull();
    expect(screen.queryByTestId("cloud-connected")).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(bridgeMock.cloudLogout).not.toHaveBeenCalled();
    expect(bridgeMock.cloudEnableSync).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the start fails",
      () => bridgeMock.cloudLoginStart.mockRejectedValueOnce(new Error("offline")),
      null,
    ],
    [
      "the browser denies it",
      () => bridgeMock.cloudLoginPoll.mockResolvedValueOnce({ status: "denied" }),
      "The request was denied in the browser.",
    ],
  ] as const)("signs in again at the same server after %s", async (_, arrange, refusal) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onConnectionError = vi.fn();
    bridgeMock.cloudStatus.mockResolvedValue(CONNECTED);
    arrange();

    render(<CloudLogin renew handOffSession onConnectionError={onConnectionError} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    const renew = await screen.findByTestId("cloud-renew");
    expect(screen.queryByTestId("cloud-server-url")).toBeNull();
    expect(within(renew).getByTestId("cloud-renew-server").textContent).toBe(
      "https://dohc.example.test",
    );
    expect(screen.queryByTestId("cloud-login-refused")?.textContent ?? null).toBe(refusal);
    for (const [report] of onConnectionError.mock.calls)
      expect(report.serverUrl).toBe("https://dohc.example.test");
    fireEvent.click(within(renew).getByTestId("cloud-renew-start"));
    await waitFor(() => expect(bridgeMock.cloudLoginStart).toHaveBeenCalledTimes(2));
    for (const [request] of bridgeMock.cloudLoginStart.mock.calls) {
      expect(request).toEqual({ serverUrl: "https://dohc.example.test" });
    }
    expect(bridgeMock.cloudLogout).not.toHaveBeenCalled();
  });

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

    await act(async () => {
      fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));
    });

    expect(screen.getByTestId("settings-row-account").textContent).toContain("ice@dohc.dev");
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(3);
    expect(bridgeMock.cloudLoginStart).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });
});
