// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareHandoffSurface } from "./ShareHandoffSurface";
import { deferred } from "../testing/deferred";

const REFUSED_COPY =
  "dohc couldn't open this share link. It may have expired or already been used. Go back to the share page in your browser and choose Open in dohc again.";
const NETWORK_COPY =
  "dohc couldn't reach the server. Check your connection, then choose Try again.";
const BUSY_COPY =
  "The server is busy right now. Wait a moment, then choose Try again.";
const MISSING_COPY =
  "dohc couldn't find this share in your account. The person who shared it may have ended it.";
const WRONG_SERVER_COPY =
  "This share link belongs to a different server (https://relay-a.example) than the one you're signed in to. Sign in to that server, then choose Open in dohc again.";

const bridgeMock = {
  cloudStatus: vi.fn(),
  getRelayReceivedShare: vi.fn(),
  listRelayShares: vi.fn(),
  acceptShareHandoff: vi.fn(),
  retryShareHandoff: vi.fn(),
  dismissShareHandoff: vi.fn(),
  openSharedView: vi.fn(),
  mountShare: vi.fn(),
  pickWorkspaceRoot: vi.fn(),
  getDefaultShareRoot: vi.fn(),
  createLocalWorkspace: vi.fn(),
  attachWorkspaceFolder: vi.fn(),
  createWorkspaceFile: vi.fn(),
  createWorkspaceFolder: vi.fn(),
  importWorkspaceFiles: vi.fn(),
  writeWorkspaceText: vi.fn(),
  writeWorkspaceAsset: vi.fn(),
};

vi.mock("./bridge", () => ({
  bridge: () => bridgeMock,
}));

vi.mock("./CloudLogin", () => ({
  CloudLogin: (props: { onConnected?: () => void }) => (
    <button
      type="button"
      data-testid="existing-cloud-login"
      onClick={props.onConnected}
    >
      Complete existing login
    </button>
  ),
}));

const SHARED_VIEW = {
  workspaceId: "ws-shared-view",
  rootPath: "/home/sam/dohc/shared",
  kind: "personal" as const,
  mode: "local-first" as const,
  shareView: { shareId: "share-exact", granterEmail: "granter@dohc.test" },
};

function receivedShare(shareId: string, shareCode: string, grantId = `grant-${shareId}`) {
  return {
    shareId,
    granterEmail: "granter@dohc.test",
    grantId,
    generation: 1,
    createdAtMs: 1,
    shareCode,
    selector: { paths: ["notes"], versionId: null },
    access: "view" as const,
  };
}

it("opens an Edit handoff as a standalone live view while mounts remain read-only", async () => {
  bridgeMock.getRelayReceivedShare.mockResolvedValue({found: true,
    share: {...receivedShare("share-edit", "edit-code"), access: "edit"}});
  const onWorkspaceReady = vi.fn();
  render(<ShareHandoffSurface status={{status: "done", statusId: "edit-status", shareId: "share-edit"}}
    onWorkspaceReady={onWorkspaceReady} onBack={() => {}} onOpened={() => {}}
    mountInto={{workspaceId: "host", onMounted: vi.fn()}} />);
  const user = userEvent.setup();
  expect(await screen.findByTestId("open-share-choose-folder")).toBeTruthy();
  expect(screen.getByTestId("open-share-mode-separate").getAttribute("aria-checked")).toBe("true");
  await user.click(screen.getByTestId("open-share-choose-folder"));
  await user.click(screen.getByTestId("open-share-start"));
  await waitFor(() => expect(bridgeMock.openSharedView).toHaveBeenCalledWith({shareCode: "edit-code", rootPath: "/home/sam/dohc/shared"}));
  expect(bridgeMock.mountShare).not.toHaveBeenCalled();
  expect(onWorkspaceReady).toHaveBeenCalled();
});

type ExactReceivedShareResult =
  | { found: false }
  | { found: true; share: ReturnType<typeof receivedShare> };

function placementProps(placement: "first-run" | "workspace") {
  return placement === "workspace"
    ? {
        mountInto: {
          workspaceId: "ws-host",
          onMounted: vi.fn(),
        },
      }
    : {};
}

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMock.cloudStatus.mockResolvedValue({
    connected: true,
    email: "recipient@dohc.test",
  });
  bridgeMock.acceptShareHandoff.mockResolvedValue(undefined);
  bridgeMock.retryShareHandoff.mockResolvedValue(undefined);
  bridgeMock.dismissShareHandoff.mockResolvedValue(undefined);
  bridgeMock.pickWorkspaceRoot.mockResolvedValue("/home/sam/dohc/shared");
  bridgeMock.getDefaultShareRoot.mockImplementation(
    async ({ shareId }: { shareId: string }) => `/home/sam/dohc/shared/${shareId}`,
  );
  bridgeMock.openSharedView.mockResolvedValue({ workspace: SHARED_VIEW });
  bridgeMock.mountShare.mockResolvedValue({
    workspace: { ...SHARED_VIEW, shareView: undefined },
    mount: {
      shareId: "share-exact",
      label: "granter",
      status: "updated",
      changedPaths: 3,
    },
  });
});

afterEach(() => {
  cleanup();
});

describe("ShareHandoffSurface", () => {
  it.each(["first-run", "workspace"] as const)(
    "requires acceptance with exact identity copy in the %s placement",
    async (placement) => {
      const user = userEvent.setup();
      const onBack = vi.fn();
      render(
        <ShareHandoffSurface
          status={{
            status: "waiting-for-acceptance",
            statusId: "accept-current",
            email: "current-account@dohc.test",
          }}
          onWorkspaceReady={() => {}}
          onBack={onBack}
          onOpened={() => {}}
          {...placementProps(placement)}
        />,
      );

      expect(screen.getByRole("heading", { name: "Open a share" })).toBeTruthy();
      expect(
        screen.getByText("You're signed in as current-account@dohc.test."),
      ).toBeTruthy();
      expect(
        screen.getByText(
          "If you open this share, the person who shared it will see that email.",
        ),
      ).toBeTruthy();
      expect(
        screen.getAllByRole("button").map((button) => button.textContent),
      ).toEqual(["Agree and open", "Cancel"]);

      await user.click(screen.getByRole("button", { name: "Agree and open" }));
      expect(bridgeMock.acceptShareHandoff).toHaveBeenCalledOnce();
      expect(bridgeMock.acceptShareHandoff).toHaveBeenCalledWith({
        statusId: "accept-current",
      });

      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onBack).toHaveBeenCalledOnce();
    },
  );

  it("binds the mouse's back button to Cancel while waiting for acceptance", () => {
    const onBack = vi.fn();
    const { unmount } = render(
      <ShareHandoffSurface
        status={{
          status: "waiting-for-acceptance",
          statusId: "accept-current",
          email: "current-account@dohc.test",
        }}
        onWorkspaceReady={() => {}}
        onBack={onBack}
        onOpened={() => {}}
      />,
    );

    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Agree and open", "Cancel"]);

    fireEvent.mouseUp(window, { button: 0 });
    expect(onBack).not.toHaveBeenCalled();

    fireEvent.mouseUp(window, { button: 3 });
    expect(onBack).toHaveBeenCalledOnce();
    expect(bridgeMock.acceptShareHandoff).not.toHaveBeenCalled();

    unmount();
    fireEvent.mouseUp(window, { button: 3 });
    expect(onBack).toHaveBeenCalledOnce();
  });

  it.each(["first-run", "workspace"] as const)(
    "shows the exact wrong-server refusal with only Back in the %s placement",
    async (placement) => {
      const onBack = vi.fn();
      render(
        <ShareHandoffSurface
          status={{
            status: "failed-wrong-server",
            statusId: "wrong-server-current",
            linkRelayUrl: "https://relay-a.example",
          }}
          onWorkspaceReady={() => {}}
          onBack={onBack}
          onOpened={() => {}}
          {...placementProps(placement)}
        />,
      );

      expect(screen.getByRole("heading", { name: "Open a share" })).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toBe(WRONG_SERVER_COPY);
      expect(
        screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Back"]);

      await userEvent.setup().click(screen.getByRole("button", { name: "Back" }));
      expect(onBack).toHaveBeenCalledOnce();
      expect(bridgeMock.acceptShareHandoff).not.toHaveBeenCalled();
      expect(bridgeMock.retryShareHandoff).not.toHaveBeenCalled();
    },
  );

  it.each(["first-run", "workspace"] as const)(
    "renders settled status controls and exact copy in the %s placement",
    async (placement) => {
      const user = userEvent.setup();
      const props = placementProps(placement);
      const { rerender } = render(
        <ShareHandoffSurface
          status={{ status: "waiting-for-sign-in", statusId: "status-test" }}
          onWorkspaceReady={() => {}}
          onBack={() => {}}
          onOpened={() => {}}
          {...props}
        />,
      );

      expect(
        screen.getByText("Connect your server to open the share from your browser."),
      ).toBeTruthy();
      expect(screen.getByTestId("existing-cloud-login")).toBeTruthy();

      rerender(
        <ShareHandoffSurface
          status={{ status: "redeeming", statusId: "status-test" }}
          onWorkspaceReady={() => {}}
          onBack={() => {}}
          onOpened={() => {}}
          {...props}
        />,
      );
      expect(screen.getByText("Opening share…")).toBeTruthy();
      expect(screen.queryByTestId("existing-cloud-login")).toBeNull();

      rerender(
        <ShareHandoffSurface
          status={{ status: "failed-refused", statusId: "status-test" }}
          onWorkspaceReady={() => {}}
          onBack={() => {}}
          onOpened={() => {}}
          {...props}
        />,
      );
      expect(screen.getByText(REFUSED_COPY)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

      rerender(
        <ShareHandoffSurface
          status={{ status: "failed-network", statusId: "status-test" }}
          onWorkspaceReady={() => {}}
          onBack={() => {}}
          onOpened={() => {}}
          {...props}
        />,
      );
      expect(screen.getByText(NETWORK_COPY)).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(bridgeMock.retryShareHandoff).toHaveBeenCalledOnce();
      expect(bridgeMock.retryShareHandoff.mock.calls[0]).toEqual([]);
    },
  );

  it("keeps Back and a parameterless manual retry when the server is busy", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(
      <ShareHandoffSurface
        status={{ status: "failed-busy", statusId: "status-test" }}
        onWorkspaceReady={() => {}}
        onBack={onBack}
        onOpened={() => {}}
      />,
    );

    expect(screen.getByText(BUSY_COPY)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(bridgeMock.retryShareHandoff).toHaveBeenCalledOnce();
    expect(bridgeMock.retryShareHandoff.mock.calls[0]).toEqual([]);
  });

  it("keeps completed login dependent on the next main-process status event", async () => {
    const user = userEvent.setup();
    render(
      <ShareHandoffSurface
        status={{ status: "waiting-for-sign-in", statusId: "status-test" }}
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        onOpened={() => {}}
      />,
    );

    await user.click(screen.getByTestId("existing-cloud-login"));

    expect(
      screen.getByText("Connect your server to open the share from your browser."),
    ).toBeTruthy();
    expect(bridgeMock.getRelayReceivedShare).not.toHaveBeenCalled();
    expect(bridgeMock.listRelayShares).not.toHaveBeenCalled();
    expect(bridgeMock.retryShareHandoff).not.toHaveBeenCalled();
    expect(bridgeMock.dismissShareHandoff).not.toHaveBeenCalled();
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
  });

  it("opens the exact redeemed share independently of the capped inventory", async () => {
    const target = receivedShare("share-exact", "ordinary-exact-share-code");
    bridgeMock.getRelayReceivedShare.mockResolvedValue({
      found: true,
      share: target,
    });
    bridgeMock.listRelayShares.mockResolvedValue({
      granted: [],
      received: Array.from({ length: 1_000 }, (_, index) =>
        receivedShare(`share-unrelated-${index}`, `unrelated-code-${index}`),
      ),
    });

    render(
      <ShareHandoffSurface
        status={{
          status: "done",
          statusId: "status-test",
          shareId: "share-exact",
        }}
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        onOpened={() => {}}
      />,
    );

    await vi.waitFor(() =>
      expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledWith({
        shareId: "share-exact",
      }),
    );
    expect(bridgeMock.listRelayShares).not.toHaveBeenCalled();
    expect(await screen.findByTestId("open-share-start")).toBeTruthy();
  });

  it("uses the exact ordinary received result and opens into its suggested folder", async () => {
    const user = userEvent.setup();
    const onOpened = vi.fn();
    bridgeMock.getRelayReceivedShare.mockResolvedValue({
      found: true,
      share: receivedShare("share-exact", "ordinary-exact-share-code"),
    });

    render(
      <ShareHandoffSurface
        status={{
          status: "done",
          statusId: "status-test",
          shareId: "share-exact",
        }}
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        onOpened={onOpened}
      />,
    );

    expect(await screen.findByTestId("open-share-start")).toBeTruthy();
    expect(screen.queryByTestId("open-share-code")).toBeNull();
    expect(bridgeMock.pickWorkspaceRoot).not.toHaveBeenCalled();
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
    expect(bridgeMock.createLocalWorkspace).not.toHaveBeenCalled();
    expect(bridgeMock.attachWorkspaceFolder).not.toHaveBeenCalled();
    expect(bridgeMock.createWorkspaceFile).not.toHaveBeenCalled();
    expect(bridgeMock.createWorkspaceFolder).not.toHaveBeenCalled();
    expect(bridgeMock.importWorkspaceFiles).not.toHaveBeenCalled();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    expect(bridgeMock.writeWorkspaceAsset).not.toHaveBeenCalled();
    expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledWith({
      shareId: "share-exact",
    });

    await screen.findByText("/home/sam/dohc/shared/share-exact");
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("open-share-start"));

    await waitFor(() =>
      expect(bridgeMock.openSharedView).toHaveBeenCalledWith({
        shareCode: "ordinary-exact-share-code",
        rootPath: "/home/sam/dohc/shared/share-exact",
      }),
    );
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
    expect(onOpened).toHaveBeenCalledOnce();
  });

  it("defaults an exact received row to mount in an active workspace and keeps separate available", async () => {
    const user = userEvent.setup();
    const onMounted = vi.fn();
    const onOpened = vi.fn();
    bridgeMock.getRelayReceivedShare.mockResolvedValue({
      found: true,
      share: receivedShare("share-exact", "ordinary-exact-share-code"),
    });

    render(
      <ShareHandoffSurface
        status={{
          status: "done",
          statusId: "status-test",
          shareId: "share-exact",
        }}
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        onOpened={onOpened}
        mountInto={{ workspaceId: "ws-host", onMounted }}
      />,
    );

    expect(
      (await screen.findByTestId("open-share-mode-mount")).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(screen.getByTestId("open-share-mode-separate")).toBeTruthy();
    expect(screen.queryByTestId("open-share-code")).toBeNull();
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("open-share-start"));

    await waitFor(() =>
      expect(bridgeMock.mountShare).toHaveBeenCalledWith({
        workspaceId: "ws-host",
        shareCode: "ordinary-exact-share-code",
      }),
    );
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
    expect(onMounted).toHaveBeenCalledWith("granter");
    expect(onOpened).toHaveBeenCalledOnce();
  });

  it("checks the exact share again without retrying redemption when it is missing", async () => {
    const user = userEvent.setup();
    bridgeMock.getRelayReceivedShare
      .mockResolvedValueOnce({ found: false })
      .mockResolvedValueOnce({
        found: true,
        share: receivedShare("share-exact", "ordinary-exact-share-code"),
      });

    render(
      <ShareHandoffSurface
        status={{
          status: "done",
          statusId: "status-test",
          shareId: "share-exact",
        }}
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        onOpened={() => {}}
      />,
    );

    expect(await screen.findByText(MISSING_COPY)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(screen.queryByText(NETWORK_COPY)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByTestId("open-shared-view")).toBeNull();
    expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledOnce();
    expect(bridgeMock.retryShareHandoff).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByTestId("open-shared-view")).toBeTruthy();
    expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledTimes(2);
    expect(bridgeMock.retryShareHandoff).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
  });

  it("keeps network copy and Try again when exact received-share lookup fails", async () => {
    const user = userEvent.setup();
    bridgeMock.getRelayReceivedShare
      .mockRejectedValueOnce(new Error("lookup unavailable"))
      .mockResolvedValueOnce({
        found: true,
        share: receivedShare("share-exact", "ordinary-exact-share-code"),
      });

    render(
      <ShareHandoffSurface
        status={{
          status: "done",
          statusId: "status-test",
          shareId: "share-exact",
        }}
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        onOpened={() => {}}
      />,
    );

    expect(await screen.findByText(NETWORK_COPY)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText(MISSING_COPY)).toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("open-shared-view")).toBeTruthy();
    expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledTimes(2);
    expect(bridgeMock.retryShareHandoff).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
  });

  it("does not let a stale exact lookup repaint a newer share id or a settled failure", async () => {
    const first = deferred<ExactReceivedShareResult>();
    const second = deferred<ExactReceivedShareResult>();
    bridgeMock.getRelayReceivedShare
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onMounted = vi.fn();
    const { rerender } = render(
      <ShareHandoffSurface
        status={{
          status: "done",
          statusId: "status-first",
          shareId: "share-first",
        }}
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        onOpened={() => {}}
        mountInto={{ workspaceId: "ws-host", onMounted }}
      />,
    );

    rerender(
      <ShareHandoffSurface
        status={{
          status: "done",
          statusId: "status-second",
          shareId: "share-second",
        }}
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        onOpened={() => {}}
        mountInto={{ workspaceId: "ws-host", onMounted }}
      />,
    );
    await act(async () => {
      second.resolve({
        found: true,
        share: receivedShare("share-second", "second-share-code"),
      });
    });
    expect(await screen.findByTestId("open-share-start")).toBeTruthy();

    await act(async () => {
      first.resolve({
        found: true,
        share: receivedShare("share-first", "first-share-code"),
      });
    });
    await userEvent.setup().click(screen.getByTestId("open-share-start"));
    await waitFor(() =>
      expect(bridgeMock.mountShare).toHaveBeenCalledWith({
        workspaceId: "ws-host",
        shareCode: "second-share-code",
      }),
    );

    const third = deferred<ExactReceivedShareResult>();
    bridgeMock.getRelayReceivedShare.mockReturnValueOnce(third.promise);
    rerender(
      <ShareHandoffSurface
        status={{
          status: "done",
          statusId: "status-third",
          shareId: "share-third",
        }}
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        onOpened={() => {}}
      />,
    );
    rerender(
      <ShareHandoffSurface
        status={{ status: "failed-refused", statusId: "status-refused" }}
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        onOpened={() => {}}
      />,
    );
    await act(async () => {
      third.resolve({
        found: true,
        share: receivedShare("share-third", "third-share-code"),
      });
    });
    expect(screen.getByText(REFUSED_COPY)).toBeTruthy();
    expect(screen.queryByTestId("open-shared-view")).toBeNull();
  });

  it("ignores exact lookup completion after unmount", async () => {
    const lookup = deferred<ExactReceivedShareResult>();
    bridgeMock.getRelayReceivedShare.mockReturnValue(lookup.promise);
    const { unmount } = render(
      <ShareHandoffSurface
        status={{
          status: "done",
          statusId: "status-test",
          shareId: "share-exact",
        }}
        onWorkspaceReady={() => {}}
        onBack={() => {}}
        onOpened={() => {}}
      />,
    );

    unmount();
    await act(async () => {
      lookup.resolve({
        found: true,
        share: receivedShare("share-exact", "ordinary-exact-share-code"),
      });
    });

    expect(bridgeMock.pickWorkspaceRoot).not.toHaveBeenCalled();
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
  });

  it("calls the supplied Back callback without mounting or opening", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(
      <ShareHandoffSurface
        status={{ status: "failed-refused", statusId: "status-refused" }}
        onWorkspaceReady={() => {}}
        onBack={onBack}
        onOpened={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(onBack).toHaveBeenCalledOnce();
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
  });

  it("does not expose the received share code before an explicit open", async () => {
    const receivedShareCode = "received-row-share-code-secret";
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const consoleLog = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    try {
      bridgeMock.getRelayReceivedShare.mockResolvedValue({
        found: true,
        share: receivedShare("share-exact", receivedShareCode),
      });

      const { container } = render(
        <ShareHandoffSurface
          status={{
            status: "done",
            statusId: "status-test",
            shareId: "share-exact",
          }}
          onWorkspaceReady={() => {}}
          onBack={() => {}}
          onOpened={() => {}}
        />,
      );
      expect(await screen.findByTestId("open-shared-view")).toBeTruthy();
      expect(bridgeMock.openSharedView).not.toHaveBeenCalled();

      const rendered = container.textContent ?? "";
      const unrelatedBridgeCalls = JSON.stringify(
        Object.values(bridgeMock).flatMap((mock) => mock.mock.calls),
      );
      const consoleCalls = JSON.stringify([
        ...consoleError.mock.calls,
        ...consoleLog.mock.calls,
      ]);
      expect(rendered).not.toContain(receivedShareCode);
      expect(unrelatedBridgeCalls).not.toContain(receivedShareCode);
      expect(consoleCalls).not.toContain(receivedShareCode);
    } finally {
      consoleError.mockRestore();
      consoleLog.mockRestore();
    }
  });
});
