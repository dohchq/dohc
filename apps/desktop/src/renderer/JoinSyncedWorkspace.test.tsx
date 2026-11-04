// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  rootPath: "/home/sam/dohc/notes",
  kind: "personal" as const,
  mode: "local-first" as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMock.cloudStatus.mockResolvedValue({
    connected: true,
    email: "ice@dohc.dev",
  });
  bridgeMock.pickWorkspaceRoot.mockResolvedValue("/home/sam/dohc/notes");
  bridgeMock.cloudJoinWorkspace.mockResolvedValue({ workspace: JOINED });
});

afterEach(() => {
  cleanup();
});

function expectFieldError(field: HTMLElement, id: string, message: string) {
  const alert = document.getElementById(id);
  expect(alert?.getAttribute("role")).toBe("alert");
  expect(alert?.textContent).toBe(message);
  // A button takes no aria-invalid; the folder chip carries only the description.
  if (field.tagName !== "BUTTON") expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(field.getAttribute("aria-describedby")).toBe(id);
}

async function fillJoinForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    await screen.findByTestId("join-sync-code"),
    "dohc-sync:ws-joined:http://localhost:1788",
  );
  await user.click(screen.getByTestId("join-choose-folder"));
  await screen.findByText("/home/sam/dohc/notes");
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
        rootPath: "/home/sam/dohc/notes",
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
            "Passphrase required to unlock synced secrets. Files stay in /home/sam/dohc/notes. Choose another empty folder to try again.",
        ),
      )
      .mockResolvedValueOnce({ workspace: JOINED });
    render(<JoinSyncedWorkspace onWorkspaceReady={onReady} onBack={() => {}} />);
    await fillJoinForm(user);

    await user.click(screen.getByTestId("join-workspace-start"));
    const passphrase = await screen.findByLabelText("Protected-file passphrase");
    expect(passphrase).toBe(screen.getByTestId("join-sync-passphrase"));
    await waitFor(() => expect(document.activeElement).toBe(passphrase));
    expectFieldError(passphrase, "join-sync-passphrase-error", "Enter the protected-file passphrase.");
    expect(screen.queryByTestId("join-error")).toBeNull();
    expect(screen.getByTestId("join-used-folder").textContent).toBe("Files stay in /home/sam/dohc/notes.");
    expect(screen.getByTestId("join-choose-folder").textContent).toContain("Choose another empty folder");

    await user.type(passphrase, "shared protected-files passphrase");
    expect(passphrase.getAttribute("aria-invalid")).toBeNull();
    // The first folder holds the earlier attempt's files: Join asks for another.
    await user.type(passphrase, "{Enter}");
    expect(bridgeMock.cloudJoinWorkspace).toHaveBeenCalledTimes(1);
    const chip = screen.getByTestId("join-choose-folder");
    expectFieldError(chip, "join-choose-folder-error", "Choose an empty folder.");
    expect(document.activeElement).toBe(chip);
    bridgeMock.pickWorkspaceRoot.mockResolvedValue("/home/sam/dohc/retry");
    await user.click(screen.getByTestId("join-choose-folder"));
    await user.click(screen.getByTestId("join-workspace-start"));
    await waitFor(() =>
      expect(bridgeMock.cloudJoinWorkspace).toHaveBeenLastCalledWith({
        syncCode: "dohc-sync:ws-joined:http://localhost:1788",
        rootPath: "/home/sam/dohc/retry",
        passphrase: "shared protected-files passphrase",
      }),
    );
    await waitFor(() => expect(onReady).toHaveBeenCalledWith(JOINED));
  });

  it("says when the passphrase did not unlock, selects it, and asks for another folder", async () => {
    const user = userEvent.setup();
    bridgeMock.cloudJoinWorkspace
      .mockRejectedValueOnce(new Error("Passphrase required to unlock synced secrets."))
      // Main's words for a wrong passphrase (cloudIpc.ts join failure).
      .mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'desktop:cloud-join-workspace': Error: " +
            "Passphrase could not unlock synced secrets. Files stay in /home/sam/dohc/retry. Choose another empty folder to try again.",
        ),
      );
    render(<JoinSyncedWorkspace onWorkspaceReady={() => {}} onBack={() => {}} />);
    await fillJoinForm(user);
    await user.click(screen.getByTestId("join-workspace-start"));
    const passphrase = (await screen.findByTestId("join-sync-passphrase")) as HTMLInputElement;
    await user.type(passphrase, "wrong passphrase");
    bridgeMock.pickWorkspaceRoot.mockResolvedValue("/home/sam/dohc/retry");
    await user.click(screen.getByTestId("join-choose-folder"));
    await user.click(screen.getByTestId("join-workspace-start"));

    await waitFor(() =>
      expectFieldError(passphrase, "join-sync-passphrase-error", "That passphrase didn't unlock the protected files."),
    );
    expect(document.activeElement).toBe(passphrase);
    expect(passphrase.selectionStart).toBe(0);
    expect(passphrase.selectionEnd).toBe("wrong passphrase".length);
    expect(screen.queryByTestId("join-error")).toBeNull();
    expect(screen.getByTestId("join-used-folder").textContent).toBe("Files stay in /home/sam/dohc/retry.");
    expect(screen.getByTestId("join-choose-folder").textContent).toContain("Choose another empty folder");

    // Leaving the field keeps the error; editing clears it.
    await user.tab();
    expect(document.getElementById("join-sync-passphrase-error")).not.toBeNull();
    await user.type(passphrase, "x");
    expect(document.getElementById("join-sync-passphrase-error")).toBeNull();
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

    bridgeMock.pickWorkspaceRoot.mockResolvedValue("/home/sam/dohc/other");
    await user.click(screen.getByTestId("join-choose-folder"));
    await user.click(screen.getByTestId("join-workspace-start"));
    await waitFor(() =>
      expect(bridgeMock.cloudJoinWorkspace).toHaveBeenLastCalledWith({
        syncCode: "dohc-sync:ws-other:http://localhost:1788",
        rootPath: "/home/sam/dohc/other",
      }),
    );
  });

  it("labels the code field with its step title", async () => {
    render(<JoinSyncedWorkspace onWorkspaceReady={() => {}} onBack={() => {}} />);
    expect(await screen.findByLabelText("Enter the code from your other machine")).toBe(
      screen.getByTestId("join-sync-code"),
    );
  });

  it("keeps Join on and shows what each empty field needs, focusing the first", async () => {
    const user = userEvent.setup();
    render(<JoinSyncedWorkspace onWorkspaceReady={() => {}} onBack={() => {}} />);
    const button = (await screen.findByTestId("join-workspace-start")) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    await user.click(button);
    const code = screen.getByTestId("join-sync-code");
    expectFieldError(code, "join-sync-code-error", "Enter a workspace code.");
    expectFieldError(screen.getByTestId("join-choose-folder"), "join-choose-folder-error", "Choose an empty folder.");
    expect(document.activeElement).toBe(code);
    expect(bridgeMock.cloudJoinWorkspace).not.toHaveBeenCalled();

    // Typing clears the code's error; picking a folder clears the folder's.
    await user.type(code, "dohc-sync:x:http://r.test");
    expect(screen.queryByText("Enter a workspace code.")).toBeNull();
    await user.click(screen.getByTestId("join-choose-folder"));
    await waitFor(() => expect(screen.queryByText("Choose an empty folder.")).toBeNull());
    await user.click(button);
    await waitFor(() => expect(bridgeMock.cloudJoinWorkspace).toHaveBeenCalledTimes(1));
  });

  it("checks the code when focus leaves it, not on each key", async () => {
    const user = userEvent.setup();
    render(<JoinSyncedWorkspace onWorkspaceReady={() => {}} onBack={() => {}} />);
    const code = await screen.findByTestId("join-sync-code");
    await user.click(code);
    await user.type(code, "x{Backspace}");
    expect(screen.queryByText("Enter a workspace code.")).toBeNull();
    await user.tab();
    expectFieldError(code, "join-sync-code-error", "Enter a workspace code.");
  });

  it("says Joining… while the join runs", async () => {
    const user = userEvent.setup();
    bridgeMock.cloudJoinWorkspace.mockImplementationOnce(() => new Promise(() => {}));
    render(<JoinSyncedWorkspace onWorkspaceReady={() => {}} onBack={() => {}} />);
    await fillJoinForm(user);
    const button = screen.getByTestId("join-workspace-start") as HTMLButtonElement;
    await user.click(button);
    await waitFor(() => expect(button.textContent).toBe("Joining…"));
    expect(button.disabled).toBe(true);
  });

  it("keeps a failed connection check apart from signed out, with Try again", async () => {
    const user = userEvent.setup();
    const onConnectionError = vi.fn();
    bridgeMock.cloudStatus.mockRejectedValueOnce(new Error("engine down"));
    render(
      <JoinSyncedWorkspace
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        onConnectionError={onConnectionError}
      />,
    );
    const failed = await screen.findByTestId("join-check-failed");
    expect(screen.queryByTestId("cloud-sync-panel")).toBeNull();
    expect(onConnectionError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "dohc could not check your server connection.",
        serverUrl: null,
      }),
    );

    await user.click(within(failed).getByRole("button", { name: "Try again" }));
    await screen.findByTestId("join-sync-code");
    expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(2);
  });

  it("lets the notice's Try again run the check while the panel is open", async () => {
    const onConnectionError = vi.fn();
    bridgeMock.cloudStatus.mockRejectedValueOnce(new Error("engine down"));
    render(
      <JoinSyncedWorkspace
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        onConnectionError={onConnectionError}
      />,
    );
    await screen.findByTestId("join-check-failed");
    const report = onConnectionError.mock.calls[0]?.[0] as { retry: () => boolean };
    act(() => {
      expect(report.retry()).toBe(true);
    });
    await screen.findByTestId("join-sync-code");
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

  // The in-flight join cannot be backed out of silently.
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
    // change): the stale resolution must not navigate into the workspace.
    unmount();
    resolveJoin({ workspace: JOINED });
    await Promise.resolve();
    await Promise.resolve();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("gates on the server connection and unlocks after the embedded login completes", async () => {
    const user = userEvent.setup();
    bridgeMock.cloudStatus
      .mockResolvedValueOnce({ connected: false }) // panel gate
      // Embedded CloudLogin check: a known server address prefills its field.
      .mockResolvedValueOnce({ connected: false, serverUrl: "https://dohc.example.test" })
      .mockResolvedValue({
        connected: true,
        email: "ice@dohc.dev",
        serverUrl: "https://dohc.example.test",
      });
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
      await screen.findByText(/connect your server first, then enter the code/i),
    ).toBeTruthy();

    await user.click(await screen.findByTestId("cloud-connect-start"));
    // CloudLogin polls every 3s; the completion callback re-checks the gate.
    await screen.findByTestId("join-sync-code");
  });
});
