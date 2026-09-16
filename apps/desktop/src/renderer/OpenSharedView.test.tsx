// @vitest-environment jsdom
import { configure } from "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenSharedView } from "./OpenSharedView";
import { deferred } from "../testing/deferred";

// Same deadline discipline as FileInspector.test.tsx. These tests type
// 40-character share codes keystroke by keystroke through jsdom, honest work
// a busy machine stretches: measured 2026-08-03 on a 24-process load (12 runs)
// the slowest test ran 1.73s against RTL's 1s default assertion window and
// vitest's 5s default test deadline — both inside the loaded-healthy range on
// a heavier box. 5s/15s sit ~3x/8x above the measured range.
configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 15_000 });

const bridgeMock = {
  cloudStatus: vi.fn(),
  openSharedView: vi.fn(),
  mountShare: vi.fn(),
  pickWorkspaceRoot: vi.fn(),
  getDefaultShareRoot: vi.fn(),
  createLocalWorkspace: vi.fn(),
  createWorkspaceFile: vi.fn(),
  createWorkspaceFolder: vi.fn(),
  writeWorkspaceText: vi.fn(),
  writeWorkspaceAsset: vi.fn(),
  cloudLoginStart: vi.fn(),
  cloudLoginPoll: vi.fn(),
  cloudLogout: vi.fn(),
  openExternalUrl: vi.fn(),
};

vi.mock("./bridge", () => ({
  bridge: () => bridgeMock,
}));

const SHARED_VIEW = {
  workspaceId: "ws-shared-view",
  rootPath: "/home/ice/dohc/shared",
  kind: "personal" as const,
  mode: "local-first" as const,
  shareView: { shareId: "share-1", granterEmail: "granter@dohc.test" },
};

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMock.cloudStatus.mockResolvedValue({
    connected: true,
    email: "recipient@dohc.test",
  });
  bridgeMock.pickWorkspaceRoot.mockResolvedValue("/home/ice/dohc/shared");
  bridgeMock.getDefaultShareRoot.mockImplementation(async ({ shareId }: { shareId: string }) =>
    `/home/ice/dohc/shared/${shareId}`,
  );
  bridgeMock.openSharedView.mockResolvedValue({ workspace: SHARED_VIEW });
  bridgeMock.mountShare.mockResolvedValue({
    workspace: { ...SHARED_VIEW, shareView: undefined },
    mount: { shareId: "share-1", label: "granter", status: "updated", changedPaths: 3 },
  });
});

afterEach(() => {
  cleanup();
});

describe("OpenSharedView", () => {
  it("keeps Back available while adding a share and ignores the late result after leaving", async () => {
    const pending = deferred<{
      workspace: typeof SHARED_VIEW;
      mount: {
        shareId: string;
        label: string;
        status: string;
        changedPaths: number;
      };
    }>();
    bridgeMock.mountShare.mockReturnValue(pending.promise);
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onOpened = vi.fn();
    const onWorkspaceReady = vi.fn();
    const onMounted = vi.fn();
    const { unmount } = render(
      <OpenSharedView
        onWorkspaceReady={onWorkspaceReady}
        onBack={onBack}
        onOpened={onOpened}
        resolvedShare={{
          shareId: "share-1",
          shareCode: "ordinary-received-share-code",
        }}
        mountInto={{ workspaceId: "ws-host", onMounted }}
      />,
    );

    await user.click(screen.getByTestId("open-share-start"));

    expect(screen.getByTestId("open-share-start").textContent).toBe(
      "Adding the share…",
    );
    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    expect(
      screen.getByText(
        "If you go back, dohc keeps adding the share to shared-with-me/.",
      ),
    ).toBeTruthy();

    await user.click(back);
    expect(onBack).toHaveBeenCalledOnce();

    unmount();
    await act(async () => {
      pending.resolve({
        workspace: SHARED_VIEW,
        mount: {
          shareId: "share-1",
          label: "granter",
          status: "updated",
          changedPaths: 3,
        },
      });
    });
    expect(onOpened).not.toHaveBeenCalled();
    expect(onWorkspaceReady).not.toHaveBeenCalled();
    expect(onMounted).not.toHaveBeenCalled();
  });

  it("keeps Back available while opening separately and ignores the late result after leaving", async () => {
    const pending = deferred<{ workspace: typeof SHARED_VIEW }>();
    bridgeMock.openSharedView.mockReturnValue(pending.promise);
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onOpened = vi.fn();
    const onWorkspaceReady = vi.fn();
    const onMounted = vi.fn();
    const { unmount } = render(
      <OpenSharedView
        onWorkspaceReady={onWorkspaceReady}
        onBack={onBack}
        onOpened={onOpened}
        resolvedShare={{
          shareId: "share-1",
          shareCode: "ordinary-received-share-code",
        }}
        mountInto={{ workspaceId: "ws-host", onMounted }}
      />,
    );

    await user.click(screen.getByTestId("open-share-mode-separate"));
    await user.click(screen.getByTestId("open-share-choose-folder"));
    await screen.findByText("/home/ice/dohc/shared");
    await user.click(screen.getByTestId("open-share-start"));

    expect(screen.getByTestId("open-share-start").textContent).toBe(
      "Opening the share…",
    );
    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    expect(
      screen.getByText(
        "If you go back, dohc keeps opening the share into the folder you chose.",
      ),
    ).toBeTruthy();

    await user.click(back);
    expect(onBack).toHaveBeenCalledOnce();

    unmount();
    await act(async () => {
      pending.resolve({ workspace: SHARED_VIEW });
    });
    expect(onOpened).not.toHaveBeenCalled();
    expect(onWorkspaceReady).not.toHaveBeenCalled();
    expect(onMounted).not.toHaveBeenCalled();
  });

  it("opens a pre-resolved received share into its suggested first-run folder", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    const onOpened = vi.fn();
    render(
      <OpenSharedView
        onWorkspaceReady={onReady}
        onBack={() => {}}
        onOpened={onOpened}
        resolvedShare={{
          shareId: "share-1",
          shareCode: "ordinary-received-share-code",
        }}
      />,
    );

    await screen.findByTestId("open-share-start");
    expect(screen.queryByTestId("open-share-code")).toBeNull();
    expect(bridgeMock.cloudStatus).not.toHaveBeenCalled();
    expect(bridgeMock.pickWorkspaceRoot).not.toHaveBeenCalled();
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
    expect(bridgeMock.createLocalWorkspace).not.toHaveBeenCalled();
    expect(bridgeMock.createWorkspaceFile).not.toHaveBeenCalled();
    expect(bridgeMock.createWorkspaceFolder).not.toHaveBeenCalled();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    expect(bridgeMock.writeWorkspaceAsset).not.toHaveBeenCalled();

    await screen.findByText("/home/ice/dohc/shared/share-1");
    expect(bridgeMock.pickWorkspaceRoot).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("open-share-start"));

    await waitFor(() =>
      expect(bridgeMock.openSharedView).toHaveBeenCalledWith({
        shareCode: "ordinary-received-share-code",
        rootPath: "/home/ice/dohc/shared/share-1",
      }),
    );
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
    expect(onOpened).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-shared-view" }),
    );
  });

  it("defaults a pre-resolved received share to mount in an active workspace", async () => {
    const user = userEvent.setup();
    const onMounted = vi.fn();
    const onOpened = vi.fn();
    render(
      <OpenSharedView
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        onOpened={onOpened}
        resolvedShare={{
          shareId: "share-1",
          shareCode: "ordinary-received-share-code",
        }}
        mountInto={{ workspaceId: "ws-host", onMounted }}
      />,
    );

    expect(
      (await screen.findByTestId("open-share-mode-mount")).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(screen.queryByTestId("open-share-code")).toBeNull();
    expect(screen.queryByTestId("open-share-choose-folder")).toBeNull();
    expect(screen.getByTestId("open-share-mode-separate")).toBeTruthy();
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("open-share-start"));

    await waitFor(() =>
      expect(bridgeMock.mountShare).toHaveBeenCalledWith({
        workspaceId: "ws-host",
        shareCode: "ordinary-received-share-code",
      }),
    );
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
    expect(onOpened).toHaveBeenCalledOnce();
    expect(onMounted).toHaveBeenCalledWith("granter");
  });

  it("opens the pasted share code into a read-only view and hands over the workspace", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    render(<OpenSharedView onWorkspaceReady={onReady} onBack={() => {}} />);

    await user.type(
      await screen.findByTestId("open-share-code"),
      "dohc-share:share-1:http://localhost:1788",
    );
    await user.click(screen.getByTestId("open-share-choose-folder"));
    await screen.findByText("/home/ice/dohc/shared");
    await user.click(screen.getByTestId("open-share-start"));

    await waitFor(() =>
      expect(bridgeMock.openSharedView).toHaveBeenCalledWith({
        shareCode: "dohc-share:share-1:http://localhost:1788",
        rootPath: "/home/ice/dohc/shared",
      }),
    );
    await waitFor(() =>
      expect(onReady).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "ws-shared-view" }),
      ),
    );
  });

  it("defaults to mounting into the host workspace when opened from inside one", async () => {
    const user = userEvent.setup();
    const onMounted = vi.fn();
    render(
      <OpenSharedView
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        mountInto={{ workspaceId: "ws-host", onMounted }}
      />,
    );

    // Mount mode is the default: no folder picker, the primary action says so.
    expect(
      (await screen.findByTestId("open-share-mode-mount")).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByTestId("open-share-choose-folder")).toBeNull();

    await user.type(
      screen.getByTestId("open-share-code"),
      "dohc-share:share-1:http://localhost:1788",
    );
    await user.click(screen.getByTestId("open-share-start"));

    await waitFor(() =>
      expect(bridgeMock.mountShare).toHaveBeenCalledWith({
        workspaceId: "ws-host",
        shareCode: "dohc-share:share-1:http://localhost:1788",
      }),
    );
    await waitFor(() => expect(onMounted).toHaveBeenCalledWith("granter"));
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
  });

  it("surfaces a mount failure in the dialog error slot", async () => {
    const user = userEvent.setup();
    bridgeMock.mountShare.mockRejectedValue(
      new Error("This share is already added to this workspace."),
    );
    render(
      <OpenSharedView
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        mountInto={{ workspaceId: "ws-host", onMounted: () => {} }}
      />,
    );

    await user.type(
      await screen.findByTestId("open-share-code"),
      "dohc-share:share-1:http://localhost:1788",
    );
    await user.click(screen.getByTestId("open-share-start"));

    expect(
      (await screen.findByTestId("open-share-error")).textContent,
    ).toContain("already added to this workspace");
  });

  it("can still open a separate read-only view from inside a workspace", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    render(
      <OpenSharedView
        onWorkspaceReady={onReady}
        onBack={() => {}}
        mountInto={{ workspaceId: "ws-host", onMounted: () => {} }}
      />,
    );

    await user.click(await screen.findByTestId("open-share-mode-separate"));
    await user.type(
      screen.getByTestId("open-share-code"),
      "dohc-share:share-1:http://localhost:1788",
    );
    await user.click(screen.getByTestId("open-share-choose-folder"));
    await screen.findByText("/home/ice/dohc/shared");
    await user.click(screen.getByTestId("open-share-start"));

    await waitFor(() => expect(bridgeMock.openSharedView).toHaveBeenCalled());
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
  });

  it("suggests a folder for the share so the person need not pick one", async () => {
    const user = userEvent.setup();
    render(<OpenSharedView onWorkspaceReady={() => {}} onBack={() => {}} />);
    const button = (await screen.findByTestId("open-share-start")) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.type(screen.getByTestId("open-share-code"), "dohc-share:trip:http://r.test");
    await screen.findByText("/home/ice/dohc/shared/trip");
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(bridgeMock.pickWorkspaceRoot).not.toHaveBeenCalled();
    // A chosen folder wins over the suggestion.
    await user.click(screen.getByTestId("open-share-choose-folder"));
    await screen.findByText("/home/ice/dohc/shared");
    await user.click(button);
    await waitFor(() =>
      expect(bridgeMock.openSharedView).toHaveBeenCalledWith({
        shareCode: "dohc-share:trip:http://r.test",
        rootPath: "/home/ice/dohc/shared",
      }),
    );
  });

  it("never opens share B into the folder suggested for share A", async () => {
    const rootA = deferred<string>();
    const rootB = deferred<string>();
    bridgeMock.getDefaultShareRoot.mockImplementation(({ shareId }: { shareId: string }) =>
      shareId === "share-a" ? rootA.promise : rootB.promise,
    );
    const user = userEvent.setup();
    render(<OpenSharedView onWorkspaceReady={() => {}} onBack={() => {}} />);
    const input = await screen.findByTestId("open-share-code");
    const button = screen.getByTestId("open-share-start") as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "dohc-share:share-a:http://r.test" } });
    await waitFor(() =>
      expect(bridgeMock.getDefaultShareRoot).toHaveBeenCalledWith({ shareId: "share-a" }),
    );
    fireEvent.change(input, { target: { value: "dohc-share:share-b:http://r.test" } });
    await waitFor(() =>
      expect(bridgeMock.getDefaultShareRoot).toHaveBeenCalledWith({ shareId: "share-b" }),
    );

    // A's answer lands while B is pending: nothing to open into yet.
    await act(async () => rootA.resolve("/home/ice/dohc/shared/share-a"));
    expect(screen.queryByText("/home/ice/dohc/shared/share-a")).toBeNull();
    expect(button.disabled).toBe(true);

    await act(async () => rootB.resolve("/home/ice/dohc/shared/share-b"));
    await screen.findByText("/home/ice/dohc/shared/share-b");
    await user.click(button);
    await waitFor(() =>
      expect(bridgeMock.openSharedView).toHaveBeenCalledWith({
        shareCode: "dohc-share:share-b:http://r.test",
        rootPath: "/home/ice/dohc/shared/share-b",
      }),
    );
  });

  it("drops a pending suggestion when the code turns invalid or the mode changes", async () => {
    const rootA = deferred<string>();
    bridgeMock.getDefaultShareRoot.mockReturnValue(rootA.promise);
    const user = userEvent.setup();
    render(
      <OpenSharedView
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        mountInto={{ workspaceId: "ws-host", onMounted: () => {} }}
      />,
    );
    await user.click(await screen.findByTestId("open-share-mode-separate"));
    const input = screen.getByTestId("open-share-code");
    const button = screen.getByTestId("open-share-start") as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "dohc-share:share-a:http://r.test" } });
    await waitFor(() => expect(bridgeMock.getDefaultShareRoot).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "dohc-share:share-a" } });
    await act(async () => rootA.resolve("/home/ice/dohc/shared/share-a"));
    expect(screen.queryByText("/home/ice/dohc/shared/share-a")).toBeNull();
    expect(button.disabled).toBe(true);

    // A second in-flight answer must not survive a switch to mount mode.
    const rootAgain = deferred<string>();
    bridgeMock.getDefaultShareRoot.mockReturnValue(rootAgain.promise);
    fireEvent.change(input, { target: { value: "dohc-share:share-a:http://r.test" } });
    await waitFor(() => expect(bridgeMock.getDefaultShareRoot).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("open-share-mode-mount"));
    await act(async () => rootAgain.resolve("/home/ice/dohc/shared/share-a"));
    // Back to separate: a fresh request, still pending, so the answer that
    // landed during mount mode must not show.
    bridgeMock.getDefaultShareRoot.mockReturnValue(deferred<string>().promise);
    await user.click(screen.getByTestId("open-share-mode-separate"));
    await waitFor(() => expect(bridgeMock.getDefaultShareRoot).toHaveBeenCalledTimes(3));
    expect(screen.queryByText("/home/ice/dohc/shared/share-a")).toBeNull();
    expect(button.disabled).toBe(true);
  });

  it("surfaces the handler's honest error copy, stripped of IPC noise", async () => {
    bridgeMock.openSharedView.mockRejectedValue(
      new Error(
        "Error invoking remote method 'desktop:open-shared-view': Error: No share matches that code for your account. Check the code and that you're signed in with the account it was shared with.",
      ),
    );
    const user = userEvent.setup();
    render(<OpenSharedView onWorkspaceReady={() => {}} onBack={() => {}} />);
    await user.type(
      await screen.findByTestId("open-share-code"),
      "dohc-share:share-9:http://localhost:1788",
    );
    await user.click(screen.getByTestId("open-share-choose-folder"));
    await screen.findByText("/home/ice/dohc/shared");
    await user.click(screen.getByTestId("open-share-start"));

    const error = await screen.findByTestId("open-share-error");
    expect(error.textContent).toBe(
      "No share matches that code for your account. Check the code and that you're signed in with the account it was shared with.",
    );
  });

  it("asks for sign-in only when Open is pressed without a session", async () => {
    const user = userEvent.setup();
    bridgeMock.cloudStatus.mockResolvedValue({ connected: false });
    render(<OpenSharedView onWorkspaceReady={() => {}} onBack={() => {}} />);
    await user.type(
      await screen.findByTestId("open-share-code"),
      "dohc-share:share-1:http://localhost:1788",
    );
    await screen.findByText("/home/ice/dohc/shared/share-1");
    expect(screen.queryByTestId("cloud-sync-panel")).toBeNull();
    await user.click(screen.getByTestId("open-share-start"));
    expect(await screen.findByTestId("cloud-sync-panel")).toBeTruthy();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
  });
});
