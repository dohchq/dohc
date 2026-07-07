// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudLogin } from "./CloudLogin";

const bridgeMock = {
  cloudStatus: vi.fn(),
  cloudEnableSync: vi.fn(),
  cloudLoginStart: vi.fn(),
  cloudLoginPoll: vi.fn(),
  cloudLogout: vi.fn(),
  openExternalUrl: vi.fn(),
};

vi.mock("./bridge", () => ({
  bridge: () => bridgeMock,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  bridgeMock.cloudStatus.mockResolvedValue({ connected: false, workspaceSynced: false });
  bridgeMock.cloudEnableSync.mockResolvedValue(undefined);
  bridgeMock.cloudLoginStart.mockResolvedValue({
    userCode: "ABCD",
    verificationUri: "https://cloud.dohc.dev/device",
  });
  bridgeMock.cloudLogout.mockResolvedValue(undefined);
  bridgeMock.openExternalUrl.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CloudLogin", () => {
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

  it("reports logout failures", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: true,
    });
    bridgeMock.cloudLogout.mockRejectedValueOnce(new Error("offline"));

    render(<CloudLogin workspaceId="ws-1" />);
    fireEvent.click(await screen.findByTestId("cloud-disconnect"));

    await waitFor(() =>
      expect(screen.getByTestId("cloud-login-error").textContent).toContain(
        "Couldn't disconnect",
      ),
    );
  });

  it("clears stale sync errors when switching workspaces", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: false,
    });
    bridgeMock.cloudEnableSync.mockRejectedValueOnce(
      new Error("already claimed by another workspace"),
    );

    const { rerender } = render(<CloudLogin workspaceId="old" />);
    fireEvent.click(await screen.findByTestId("cloud-enable-sync"));
    await screen.findByTestId("cloud-sync-error");

    rerender(<CloudLogin workspaceId="new" />);

    await waitFor(() => expect(screen.queryByTestId("cloud-sync-error")).toBeNull());
    expect(
      (screen.getByTestId("cloud-enable-sync") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows the copyable sync code for a synced workspace (0P-C join handle)", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: true,
      serverUrl: "http://localhost:1786",
      relayUrl: "http://localhost:1788",
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

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

  it("omits the sync code when the session has no relay (nothing to join through)", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: true,
      serverUrl: "http://localhost:1786",
    });
    render(<CloudLogin workspaceId="ws-1" />);
    await screen.findByTestId("cloud-workspace-synced");
    expect(screen.queryByTestId("cloud-sync-code-block")).toBeNull();
  });

  it("does not let a stale enable-sync result mark the next workspace as synced", async () => {
    const oldEnable = deferred<void>();
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: false,
    });
    bridgeMock.cloudEnableSync.mockReturnValueOnce(oldEnable.promise);

    const { rerender } = render(<CloudLogin workspaceId="old" />);
    fireEvent.click(await screen.findByTestId("cloud-enable-sync"));
    await waitFor(() =>
      expect(screen.getByTestId("cloud-enable-sync").textContent).toBe(
        "Enabling sync…",
      ),
    );

    rerender(<CloudLogin workspaceId="new" />);

    await waitFor(() => {
      const button = screen.getByTestId("cloud-enable-sync") as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe("Sync this workspace");
    });
    await act(async () => {
      oldEnable.resolve();
    });

    expect(screen.queryByTestId("cloud-workspace-synced")).toBeNull();
  });

  it("prompts for a passphrase when synced secrets need protection", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: false,
    });
    bridgeMock.cloudEnableSync
      .mockRejectedValueOnce(new Error("Passphrase required to protect synced secrets."))
      .mockResolvedValueOnce(undefined);

    render(<CloudLogin workspaceId="ws-1" />);
    fireEvent.click(await screen.findByTestId("cloud-enable-sync"));

    const input = await screen.findByTestId("cloud-sync-passphrase");
    expect(screen.getByTestId("cloud-sync-error").textContent).toContain("passphrase");
    expect((screen.getByTestId("cloud-enable-sync") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "shared passphrase" } });
    fireEvent.click(screen.getByTestId("cloud-enable-sync"));

    await waitFor(() =>
      expect(bridgeMock.cloudEnableSync).toHaveBeenLastCalledWith({
        workspaceId: "ws-1",
        passphrase: "shared passphrase",
      }),
    );
    await screen.findByTestId("cloud-workspace-synced");
  });

  it("protects an already-synced workspace with a passphrase when the local key is present", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: true,
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

  it("unlocks protected files later when a synced workspace is missing its local key", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({
      connected: true,
      email: "ice@dohc.dev",
      workspaceSynced: true,
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
