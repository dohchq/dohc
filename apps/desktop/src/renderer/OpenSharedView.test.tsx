// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenSharedView } from "./OpenSharedView";
import { deferred } from "../testing/deferred";
import type { GetRelayReceivedShareResult, ShareAccess } from "../ipc/bridgeContract";

const bridgeMock = {
  cloudStatus: vi.fn(),
  openSharedView: vi.fn(),
  mountShare: vi.fn(),
  getRelayReceivedShare: vi.fn(),
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
  rootPath: "/home/sam/dohc/shared",
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
  bridgeMock.pickWorkspaceRoot.mockResolvedValue("/home/sam/dohc/shared");
  bridgeMock.getDefaultShareRoot.mockImplementation(
    async ({ shareId }: { shareId: string }) => `/home/sam/dohc/shared/${shareId}`,
  );
  bridgeMock.openSharedView.mockResolvedValue({ workspace: SHARED_VIEW });
  bridgeMock.getRelayReceivedShare.mockResolvedValue({ found: false });
  bridgeMock.mountShare.mockResolvedValue({
    workspace: {
      ...SHARED_VIEW,
      shareView: undefined,
      shareMounts: [
        { shareId: "share-1", label: "granter", granterEmail: "granter@dohc.test", access: "edit" },
      ],
    },
    mount: { shareId: "share-1", label: "granter", status: "updated", changedPaths: 3 },
  });
});

afterEach(() => {
  cleanup();
});

// The folder chip shows its path with PathLine, so the whole path is its title.
const shownFolder = () =>
  screen.queryByTestId("open-share-choose-folder")?.getAttribute("title") ?? null;
const findFolder = (path: string) => waitFor(() => expect(shownFolder()).toBe(path));

describe("OpenSharedView", () => {
  function expectMissingInput(reason: string | null) {
    const start = screen.getByTestId<HTMLButtonElement>("open-share-start");
    expect(start.getAttribute("aria-describedby")).toBe(reason ? "open-share-missing-input" : null);
    expect(document.getElementById("open-share-missing-input")?.textContent ?? null).toBe(reason);
    if (reason) expect(start.disabled).toBe(true);
  }

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

    expect(screen.getByTestId("open-share-start").textContent).toBe("Adding the share…");
    expectMissingInput(null);
    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    expect(
      screen.getByText("If you go back, dohc keeps adding the share to shared-with-me/."),
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
    await findFolder("/home/sam/dohc/shared");
    await user.click(screen.getByTestId("open-share-start"));

    expect(screen.getByTestId("open-share-start").textContent).toBe("Opening the share…");
    expectMissingInput(null);
    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    expect(
      screen.getByText("If you go back, dohc keeps opening the share into the folder you chose."),
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

    expect((await screen.findByTestId("open-share-mode-mount")).getAttribute("aria-checked")).toBe(
      "true",
    );
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
    expect(onMounted).toHaveBeenCalledWith("granter", "edit");
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

    expect((await screen.findByTestId("open-share-error")).textContent).toContain(
      "already added to this workspace",
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

    await act(async () => rootA.resolve("/home/sam/dohc/shared/share-a"));
    expect(shownFolder()).not.toBe("/home/sam/dohc/shared/share-a");
    expect(button.disabled).toBe(true);

    await act(async () => rootB.resolve("/home/sam/dohc/shared/share-b"));
    await findFolder("/home/sam/dohc/shared/share-b");
    await user.click(button);
    await waitFor(() =>
      expect(bridgeMock.openSharedView).toHaveBeenCalledWith({
        shareCode: "dohc-share:share-b:http://r.test",
        rootPath: "/home/sam/dohc/shared/share-b",
      }),
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
    await findFolder("/home/sam/dohc/shared/share-1");
    expect(screen.queryByTestId("cloud-sync-panel")).toBeNull();
    await user.click(screen.getByTestId("open-share-start"));
    const panel = await screen.findByTestId("cloud-sync-panel");
    expect(panel.parentElement).toBe(document.activeElement);
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
  });
});

describe("OpenSharedView defaults for a pasted code", () => {
  const CODE = "dohc-share:share-1:http://localhost:1788";
  const OTHER_CODE = "dohc-share:share-2:http://localhost:1788";

  function received(access: ShareAccess, shareId = "share-1"): GetRelayReceivedShareResult {
    return {
      found: true,
      share: {
        shareId,
        granterEmail: "granter@dohc.test",
        genericChatWritable: false,
        grantId: `grant-${shareId}`,
        generation: 1,
        createdAtMs: 1,
        shareCode: `dohc-share:${shareId}:http://localhost:1788`,
        selector: { paths: ["docs"], versionId: null },
        access,
      },
    };
  }

  function renderInWorkspace() {
    render(
      <OpenSharedView
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        mountInto={{ workspaceId: "ws-host", onMounted: () => {} }}
      />,
    );
  }

  function modeChecked(mode: "mount" | "separate"): string | null {
    return screen.getByTestId(`open-share-mode-${mode}`).getAttribute("aria-checked");
  }

  it("holds Open while the relay answers, then defaults an Edit code to Open separately", async () => {
    const lookup = deferred<GetRelayReceivedShareResult>();
    bridgeMock.getRelayReceivedShare.mockReturnValue(lookup.promise);
    renderInWorkspace();
    fireEvent.change(await screen.findByTestId("open-share-code"), {
      target: { value: CODE },
    });

    const start = screen.getByTestId<HTMLButtonElement>("open-share-start");
    await waitFor(() => expect(start.textContent).toBe("Checking the share…"));
    expect(start.disabled).toBe(true);
    // Neither half looks chosen, so nobody confirms a default that may move.
    expect(modeChecked("mount")).toBe("false");
    expect(modeChecked("separate")).toBe("false");
    // Enter reaches open() without the button.
    fireEvent.keyDown(screen.getByTestId("open-share-code"), { key: "Enter" });
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();

    await act(async () => lookup.resolve(received("edit")));
    await waitFor(() => expect(modeChecked("separate")).toBe("true"));
    expect(screen.getByText(/Open separately to edit shared Markdown/)).toBeTruthy();
    await waitFor(() => expect(start.disabled).toBe(false));
    expect(start.textContent).toBe("Open share");
    expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledExactlyOnceWith({
      shareId: "share-1",
    });
  });

  it("keeps the mode the person picked when the answer lands", async () => {
    const lookup = deferred<GetRelayReceivedShareResult>();
    bridgeMock.getRelayReceivedShare.mockReturnValue(lookup.promise);
    const user = userEvent.setup();
    renderInWorkspace();
    fireEvent.change(await screen.findByTestId("open-share-code"), {
      target: { value: CODE },
    });
    const start = screen.getByTestId<HTMLButtonElement>("open-share-start");
    await waitFor(() => expect(start.textContent).toBe("Checking the share…"));

    await user.click(screen.getByTestId("open-share-mode-mount"));
    expect(start.disabled).toBe(false);
    await act(async () => lookup.resolve(received("edit")));
    expect(modeChecked("mount")).toBe("true");
    expect(start.textContent).toBe("Add share");
  });

  it("does not let code A's late answer decide code B, and keeps it for A", async () => {
    const answers = new Map([
      ["share-1", deferred<GetRelayReceivedShareResult>()],
      ["share-2", deferred<GetRelayReceivedShareResult>()],
    ]);
    bridgeMock.getRelayReceivedShare.mockImplementation(
      ({ shareId }: { shareId: string }) => answers.get(shareId)!.promise,
    );
    renderInWorkspace();
    const input = await screen.findByTestId("open-share-code");
    const start = screen.getByTestId<HTMLButtonElement>("open-share-start");
    fireEvent.change(input, { target: { value: CODE } });
    await waitFor(() => expect(start.textContent).toBe("Checking the share…"));
    fireEvent.change(input, { target: { value: OTHER_CODE } });
    await waitFor(() => expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledTimes(2));

    await act(async () => answers.get("share-1")!.resolve(received("edit", "share-1")));
    expect(start.textContent).toBe("Checking the share…");
    expect(modeChecked("mount")).toBe("false");
    expect(modeChecked("separate")).toBe("false");

    await act(async () => answers.get("share-2")!.resolve(received("view", "share-2")));
    await waitFor(() => expect(start.textContent).toBe("Add share"));
    expect(modeChecked("mount")).toBe("true");

    fireEvent.change(input, { target: { value: CODE } });
    await waitFor(() => expect(modeChecked("separate")).toBe("true"));
    expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledTimes(2);
  });

  it("asks after an inline sign-in, then defaults an Edit code to Open separately", async () => {
    vi.useFakeTimers();
    try {
      const signedOut = { connected: false, serverUrl: "https://dohc.example.test" };
      bridgeMock.cloudStatus
        .mockResolvedValueOnce(signedOut)
        .mockResolvedValueOnce(signedOut)
        .mockResolvedValue({
          connected: true,
          email: "recipient@dohc.test",
          serverUrl: "https://dohc.example.test",
          relayUrl: "http://localhost:1788",
        });
      bridgeMock.cloudLoginStart.mockResolvedValue({
        userCode: "ABCD",
        verificationUri: "https://dohc.example.test/device",
      });
      bridgeMock.cloudLoginPoll.mockResolvedValue({
        status: "complete",
        email: "recipient@dohc.test",
      });
      bridgeMock.getRelayReceivedShare.mockResolvedValue(received("edit"));
      renderInWorkspace();
      await act(async () => {});
      fireEvent.change(screen.getByTestId("open-share-code"), { target: { value: CODE } });
      await act(async () => {});
      expect(bridgeMock.getRelayReceivedShare).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("open-share-start"));
      await act(async () => {});
      fireEvent.click(screen.getByTestId("cloud-connect-start"));
      await act(async () => {});
      // CloudLogin polls the approval every 3 s.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await act(async () => {});

      expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledExactlyOnceWith({
        shareId: "share-1",
      });
      expect(modeChecked("separate")).toBe("true");
      expect(screen.getByTestId("open-share-start").textContent).toBe("Open share");
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("opening a membership", () => {
  const share = {
    shareId: "member-1",
    subjectName: "Community",
    sharerName: "Ana",
    granterEmail: "ana@example.test",
    access: "comment",
    selector: { kind: "workspace", role: "member" },
    shareCode: "dohc-share:member-1:http://localhost:1788",
  } as RelayShareReceivedRow;
  let progress: ((event: { workspaceId: string; shareId: string; files: number }) => void) | null =
    null;
  const unsubscribe = vi.fn();
  beforeEach(() => {
    progress = null;
    Object.assign(bridgeMock, {
      onSharedViewPullProgress: vi.fn((listener: typeof progress) => {
        progress = listener;
        return unsubscribe;
      }),
    });
    bridgeMock.getDefaultShareRoot.mockImplementation(
      async ({ name }: { name?: string }) => `/home/sam/dohc/${name}`,
    );
  });
  const renderMembership = (props: { onWorkspaceReady?: () => void } = {}) =>
    render(
      <OpenSharedView
        onWorkspaceReady={props.onWorkspaceReady ?? (() => {})}
        onBack={() => {}}
        resolvedShare={{ shareId: share.shareId, shareCode: share.shareCode, share }}
        mountInto={{ workspaceId: "host", onMounted: () => {} }}
      />,
    );

  it("asks only for a folder named after the workspace, and states the role and level", async () => {
    renderMembership();
    expect(screen.getByRole("heading").textContent).toBe("Open Community");
    expect(screen.getByTestId("open-share-summary").textContent).toBe(
      "Member · Ana lets members comment",
    );
    // A whole workspace is never a folder inside another one.
    expect(screen.queryByTestId("open-share-mode-mount")).toBeNull();
    await findFolder("/home/sam/dohc/Community");
    // The folder's own name stays whole however long the path is.
    expect(
      within(screen.getByTestId("open-share-choose-folder")).getByText("Community"),
    ).toBeTruthy();
    expect(bridgeMock.getDefaultShareRoot).toHaveBeenCalledWith({
      shareId: "member-1",
      name: "Community",
    });
    expect(screen.getByTestId("open-share-start").textContent).toBe("Open workspace");
  });

  it("counts the files its first pull reads", async () => {
    const opened = deferred<{ workspace: typeof SHARED_VIEW }>();
    bridgeMock.openSharedView.mockReturnValue(opened.promise);
    const ready = vi.fn();
    renderMembership({ onWorkspaceReady: ready });
    await waitFor(() =>
      expect(screen.getByTestId<HTMLButtonElement>("open-share-start").disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId("open-share-start"));
    await waitFor(() =>
      expect(screen.getByTestId("open-share-start").textContent).toBe("Opening the workspace…"),
    );
    expect(bridgeMock.openSharedView).toHaveBeenCalledWith({
      shareCode: share.shareCode,
      rootPath: "/home/sam/dohc/Community",
    });
    // Another share's pull says nothing here.
    act(() => progress!({ workspaceId: "w", shareId: "other", files: 9 }));
    expect(screen.queryByTestId("open-share-progress")).toBeNull();
    expect(
      screen.getByText("If you go back, dohc keeps opening Community into the folder you chose."),
    ).toBeTruthy();
    act(() => progress!({ workspaceId: "w", shareId: "member-1", files: 1 }));
    expect(screen.getByTestId("open-share-start").textContent).toBe("Opening the workspace…");
    expect(screen.getByTestId("open-share-progress").textContent).toBe("Copied 1 file so far.");
    act(() => progress!({ workspaceId: "w", shareId: "member-1", files: 120 }));
    expect(screen.getByTestId("open-share-progress").textContent).toBe("Copied 120 files so far.");
    await act(async () => {
      opened.resolve({ workspace: SHARED_VIEW });
    });
    expect(ready).toHaveBeenCalledWith(SHARED_VIEW);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("shows the cause above Try again, which opens the same folder again", async () => {
    bridgeMock.openSharedView.mockRejectedValueOnce(
      new Error(
        "dohc could not finish reading Community: relay went away. What arrived stays in /home/sam/dohc/Community. Try again continues from there.",
      ),
    );
    renderMembership();
    await waitFor(() =>
      expect(screen.getByTestId<HTMLButtonElement>("open-share-start").disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId("open-share-start"));
    const error = await screen.findByTestId("open-share-error");
    expect(error.textContent).toContain("relay went away");
    const retry = screen.getByTestId("open-share-start");
    expect(retry.textContent).toBe("Try again");
    // The cause sits above the button that acts on it.
    expect(error.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(retry);
    await waitFor(() => expect(bridgeMock.openSharedView).toHaveBeenCalledTimes(2));
    expect(bridgeMock.openSharedView.mock.calls[1]![0]).toEqual({
      shareCode: share.shareCode,
      rootPath: "/home/sam/dohc/Community",
    });
  });
});
