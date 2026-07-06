// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JoinSyncedWorkspace } from "./JoinSyncedWorkspace";

const bridgeMock = {
  cloudStatus: vi.fn(),
  cloudJoinWorkspace: vi.fn(),
  pickWorkspaceRoot: vi.fn(),
  cloudLoginStart: vi.fn(),
  cloudLoginPoll: vi.fn(),
  cloudLogout: vi.fn(),
  openExternalUrl: vi.fn(),
};

vi.mock("./bridge", () => ({
  bridge: () => bridgeMock,
}));

const JOINED = {
  workspaceId: "ws-joined",
  rootPath: "/home/ice/dohc/notes",
  kind: "personal" as const,
  mode: "local-first" as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMock.cloudStatus.mockResolvedValue({
    connected: true,
    email: "ice@dohc.dev",
  });
  bridgeMock.pickWorkspaceRoot.mockResolvedValue("/home/ice/dohc/notes");
  bridgeMock.cloudJoinWorkspace.mockResolvedValue({ workspace: JOINED });
});

afterEach(() => {
  cleanup();
});

async function fillJoinForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    await screen.findByTestId("join-sync-code"),
    "dohc-sync:ws-joined:http://localhost:1788",
  );
  await user.click(screen.getByTestId("join-choose-folder"));
  await screen.findByText("/home/ice/dohc/notes");
}

describe("JoinSyncedWorkspace", () => {
  it("joins with the pasted code and picked folder, then opens the workspace", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    render(<JoinSyncedWorkspace onWorkspaceReady={onReady} onBack={() => {}} />);
    await fillJoinForm(user);

    await user.click(screen.getByTestId("join-workspace-start"));
    await waitFor(() =>
      expect(bridgeMock.cloudJoinWorkspace).toHaveBeenCalledWith({
        syncCode: "dohc-sync:ws-joined:http://localhost:1788",
        rootPath: "/home/ice/dohc/notes",
      }),
    );
    await waitFor(() =>
      expect(onReady).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "ws-joined" }),
      ),
    );
  });

  it("stays disabled until both a code and a folder exist", async () => {
    const user = userEvent.setup();
    render(<JoinSyncedWorkspace onWorkspaceReady={() => {}} onBack={() => {}} />);
    const button = (await screen.findByTestId(
      "join-workspace-start",
    )) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.type(screen.getByTestId("join-sync-code"), "dohc-sync:x:http://r.test");
    expect(button.disabled).toBe(true);
    await user.click(screen.getByTestId("join-choose-folder"));
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it("shows the handler's product-voiced error without the Electron wrapper", async () => {
    const user = userEvent.setup();
    bridgeMock.cloudJoinWorkspace.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:cloud-join-workspace': Error: " +
          "No synced workspace matches that code for your account. Check the code and that you're signed in with the same account.",
      ),
    );
    render(<JoinSyncedWorkspace onWorkspaceReady={() => {}} onBack={() => {}} />);
    await fillJoinForm(user);
    await user.click(screen.getByTestId("join-workspace-start"));
    const error = await screen.findByTestId("join-error");
    expect(error.textContent).toContain("No synced workspace matches that code");
    expect(error.textContent).not.toContain("remote method");
  });

  it("surfaces a first-sync warning and lets the user open the workspace deliberately", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    bridgeMock.cloudJoinWorkspace.mockResolvedValueOnce({
      workspace: JOINED,
      warning:
        "The workspace was added, but the first sync didn't finish. It will keep trying — check your connection.",
    });
    render(<JoinSyncedWorkspace onWorkspaceReady={onReady} onBack={() => {}} />);
    await fillJoinForm(user);
    await user.click(screen.getByTestId("join-workspace-start"));

    expect((await screen.findByTestId("join-warning")).textContent).toContain(
      "first sync didn't finish",
    );
    expect(onReady).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("join-open-anyway"));
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-joined" }),
    );
  });

  it("gates on sign-in and unlocks after the embedded login completes", async () => {
    const user = userEvent.setup();
    bridgeMock.cloudStatus
      .mockResolvedValueOnce({ connected: false }) // panel gate
      .mockResolvedValueOnce({ connected: false }) // embedded CloudLogin check
      .mockResolvedValue({ connected: true, email: "ice@dohc.dev" });
    bridgeMock.cloudLoginStart.mockResolvedValue({
      userCode: "ABCD",
      verificationUri: "https://cloud.dohc.dev/device",
    });
    bridgeMock.cloudLoginPoll.mockResolvedValue({
      status: "complete",
      email: "ice@dohc.dev",
    });

    render(<JoinSyncedWorkspace onWorkspaceReady={() => {}} onBack={() => {}} />);
    expect(
      await screen.findByText(/sign in first, then paste the code/i),
    ).toBeTruthy();

    await user.click(await screen.findByTestId("cloud-connect-start"));
    // CloudLogin polls every 3s; the completion callback re-checks the gate.
    await screen.findByTestId("join-sync-code", undefined, { timeout: 6000 });
  }, 10_000);
});
