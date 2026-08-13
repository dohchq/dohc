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

  it("prompts for the protected-file passphrase and retries the product join", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    bridgeMock.cloudJoinWorkspace
      .mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'desktop:cloud-join-workspace': Error: " +
            "Passphrase required to unlock synced secrets.",
        ),
      )
      .mockResolvedValueOnce({ workspace: JOINED });
    render(<JoinSyncedWorkspace onWorkspaceReady={onReady} onBack={() => {}} />);
    await fillJoinForm(user);

    await user.click(screen.getByTestId("join-workspace-start"));
    const passphrase = await screen.findByTestId("join-sync-passphrase");
    expect(screen.getByTestId("join-error").textContent).toContain(
      "Enter the protected-file passphrase",
    );
    expect((screen.getByTestId("join-workspace-start") as HTMLButtonElement).disabled).toBe(
      true,
    );

    await user.type(passphrase, "shared protected-files passphrase");
    await user.click(screen.getByTestId("join-workspace-start"));
    await waitFor(() =>
      expect(bridgeMock.cloudJoinWorkspace).toHaveBeenLastCalledWith({
        syncCode: "dohc-sync:ws-joined:http://localhost:1788",
        rootPath: "/home/ice/dohc/notes",
        passphrase: "shared protected-files passphrase",
      }),
    );
    await waitFor(() => expect(onReady).toHaveBeenCalledWith(JOINED));
  });

  it("drops the protected-file passphrase when the workspace code changes", async () => {
    const user = userEvent.setup();
    bridgeMock.cloudJoinWorkspace
      .mockRejectedValueOnce(
        new Error("Passphrase required to unlock synced secrets."),
      )
      .mockResolvedValueOnce({ workspace: JOINED });
    render(<JoinSyncedWorkspace onWorkspaceReady={() => {}} onBack={() => {}} />);
    await fillJoinForm(user);

    await user.click(screen.getByTestId("join-workspace-start"));
    await user.type(
      await screen.findByTestId("join-sync-passphrase"),
      "workspace A passphrase",
    );

    const code = screen.getByTestId("join-sync-code");
    await user.clear(code);
    await user.type(code, "dohc-sync:ws-other:http://localhost:1788");
    expect(screen.queryByTestId("join-sync-passphrase")).toBeNull();

    await user.click(screen.getByTestId("join-workspace-start"));
    await waitFor(() =>
      expect(bridgeMock.cloudJoinWorkspace).toHaveBeenLastCalledWith({
        syncCode: "dohc-sync:ws-other:http://localhost:1788",
        rootPath: "/home/ice/dohc/notes",
      }),
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

  // 0P-C gate fixes: the in-flight join cannot be backed out of silently,
  // and a created-but-warned workspace only offers "Open workspace".
  it("disables Back while a join is in flight and ignores a resolve after unmount", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    let resolveJoin!: (value: { workspace: typeof JOINED }) => void;
    bridgeMock.cloudJoinWorkspace.mockImplementationOnce(
      () =>
        new Promise<{ workspace: typeof JOINED }>((resolve) => {
          resolveJoin = resolve;
        }),
    );
    const { unmount } = render(
      <JoinSyncedWorkspace onWorkspaceReady={onReady} onBack={() => {}} />,
    );
    await fillJoinForm(user);
    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    await user.click(screen.getByTestId("join-workspace-start"));
    await waitFor(() => expect(bridgeMock.cloudJoinWorkspace).toHaveBeenCalled());
    expect(back.disabled).toBe(true);

    // The parent swaps the view away mid-request (e.g. first-run state
    // change): the stale resolution must NOT navigate into the workspace.
    unmount();
    resolveJoin({ workspace: JOINED });
    await Promise.resolve();
    await Promise.resolve();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("removes Back once the workspace exists (warning state) — only Open workspace remains", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    bridgeMock.cloudJoinWorkspace.mockResolvedValueOnce({
      workspace: JOINED,
      warning: "The workspace was added, but the first sync didn't finish.",
    });
    render(<JoinSyncedWorkspace onWorkspaceReady={onReady} onBack={() => {}} />);
    await fillJoinForm(user);
    await user.click(screen.getByTestId("join-workspace-start"));
    await screen.findByTestId("join-warning");
    // The workspace is durably created: "back as if nothing happened" is a
    // lie, so the affordance is gone and Open workspace is the way forward.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByTestId("join-open-anyway")).toBeTruthy();
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
