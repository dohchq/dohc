// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareHandoffSurface } from "./ShareHandoffSurface";

const REFUSED_COPY =
  "dohc couldn't open this share link. It may have expired or already been used. Go back to the share page in your browser and choose Open in dohc again.";
const NETWORK_COPY =
  "dohc couldn't reach dohc Cloud. Check your connection, then choose Try again.";
const BUSY_COPY =
  "dohc Cloud is busy right now. Wait a moment, then choose Try again.";
const MISSING_COPY =
  "dohc couldn't find this share in your account. The person who shared it may have ended it.";

const bridgeMock = {
  cloudStatus: vi.fn(),
  listRelayShares: vi.fn(),
  retryShareHandoff: vi.fn(),
  dismissShareHandoff: vi.fn(),
  openSharedView: vi.fn(),
  mountShare: vi.fn(),
  pickWorkspaceRoot: vi.fn(),
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
  rootPath: "/home/ice/dohc/shared",
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

function grantedShare(shareId: string, shareCode: string, grantId: string) {
  return {
    shareId,
    workspaceId: "ws-granter",
    recipientUserId: "recipient-user",
    recipientEmail: "recipient@dohc.test",
    grantId,
    generation: 1,
    createdAtMs: 1,
    revokedAtMs: null,
    shareCode,
    selector: { paths: ["notes"], versionId: null },
    access: "view" as const,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

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
  bridgeMock.retryShareHandoff.mockResolvedValue(undefined);
  bridgeMock.dismissShareHandoff.mockResolvedValue(undefined);
  bridgeMock.pickWorkspaceRoot.mockResolvedValue("/home/ice/dohc/shared");
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
        screen.getByText("Sign in to open the share from your browser."),
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

  it("keeps Back and a parameterless manual retry when dohc Cloud is busy", async () => {
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
      screen.getByText("Sign in to open the share from your browser."),
    ).toBeTruthy();
    expect(bridgeMock.listRelayShares).not.toHaveBeenCalled();
    expect(bridgeMock.retryShareHandoff).not.toHaveBeenCalled();
    expect(bridgeMock.dismissShareHandoff).not.toHaveBeenCalled();
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
  });

  it("selects only the exact ordinary received row and waits for first-run confirmation", async () => {
    const user = userEvent.setup();
    const onOpened = vi.fn();
    bridgeMock.listRelayShares.mockResolvedValue({
      granted: [
        grantedShare(
          "share-exact",
          "forbidden-granted-row-code",
          "forbidden-grant-id",
        ),
      ],
      received: [
        receivedShare("share-other", "wrong-received-row-code"),
        receivedShare("share-exact", "ordinary-exact-share-code"),
      ],
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

    await user.click(screen.getByTestId("open-share-choose-folder"));
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("open-share-start"));

    await waitFor(() =>
      expect(bridgeMock.openSharedView).toHaveBeenCalledWith({
        shareCode: "ordinary-exact-share-code",
        rootPath: "/home/ice/dohc/shared",
      }),
    );
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
    expect(onOpened).toHaveBeenCalledOnce();
  });

  it("defaults an exact received row to mount in an active workspace and keeps separate available", async () => {
    const user = userEvent.setup();
    const onMounted = vi.fn();
    const onOpened = vi.fn();
    bridgeMock.listRelayShares.mockResolvedValue({
      granted: [],
      received: [receivedShare("share-exact", "ordinary-exact-share-code")],
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

  it("re-reads inventory without retrying redemption when the exact row is missing", async () => {
    const user = userEvent.setup();
    bridgeMock.listRelayShares
      .mockResolvedValueOnce({
        granted: [
          grantedShare(
            "share-exact",
            "forbidden-granted-row-code",
            "forbidden-grant-id",
          ),
        ],
        received: [receivedShare("share-other", "wrong-received-row-code")],
      })
      .mockResolvedValueOnce({
        granted: [],
        received: [receivedShare("share-exact", "ordinary-exact-share-code")],
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
    expect(bridgeMock.listRelayShares).toHaveBeenCalledOnce();
    expect(bridgeMock.retryShareHandoff).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByTestId("open-shared-view")).toBeTruthy();
    expect(bridgeMock.listRelayShares).toHaveBeenCalledTimes(2);
    expect(bridgeMock.retryShareHandoff).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
  });

  it("keeps network copy and Try again when received-share inventory fails", async () => {
    const user = userEvent.setup();
    bridgeMock.listRelayShares
      .mockRejectedValueOnce(new Error("inventory unavailable"))
      .mockResolvedValueOnce({
        granted: [],
        received: [receivedShare("share-exact", "ordinary-exact-share-code")],
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
    expect(bridgeMock.listRelayShares).toHaveBeenCalledTimes(2);
    expect(bridgeMock.retryShareHandoff).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
  });

  it("does not let stale inventory repaint a newer share id or a settled failure", async () => {
    const first = deferred<{
      granted: ReturnType<typeof grantedShare>[];
      received: ReturnType<typeof receivedShare>[];
    }>();
    const second = deferred<{
      granted: ReturnType<typeof grantedShare>[];
      received: ReturnType<typeof receivedShare>[];
    }>();
    bridgeMock.listRelayShares
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
        granted: [],
        received: [receivedShare("share-second", "second-share-code")],
      });
    });
    expect(await screen.findByTestId("open-share-start")).toBeTruthy();

    await act(async () => {
      first.resolve({
        granted: [],
        received: [receivedShare("share-first", "first-share-code")],
      });
    });
    await userEvent.setup().click(screen.getByTestId("open-share-start"));
    await waitFor(() =>
      expect(bridgeMock.mountShare).toHaveBeenCalledWith({
        workspaceId: "ws-host",
        shareCode: "second-share-code",
      }),
    );

    const third = deferred<{
      granted: ReturnType<typeof grantedShare>[];
      received: ReturnType<typeof receivedShare>[];
    }>();
    bridgeMock.listRelayShares.mockReturnValueOnce(third.promise);
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
        granted: [],
        received: [receivedShare("share-third", "third-share-code")],
      });
    });
    expect(screen.getByText(REFUSED_COPY)).toBeTruthy();
    expect(screen.queryByTestId("open-shared-view")).toBeNull();
  });

  it("ignores inventory completion after unmount", async () => {
    const inventory = deferred<{
      granted: ReturnType<typeof grantedShare>[];
      received: ReturnType<typeof receivedShare>[];
    }>();
    bridgeMock.listRelayShares.mockReturnValue(inventory.promise);
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
      inventory.resolve({
        granted: [],
        received: [receivedShare("share-exact", "ordinary-exact-share-code")],
      });
    });

    expect(bridgeMock.pickWorkspaceRoot).not.toHaveBeenCalled();
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
  });

  it("dismisses from Back without mounting and sends no payload", async () => {
    const user = userEvent.setup();
    render(
      <ShareHandoffSurface
        status={{ status: "failed-refused", statusId: "status-refused" }}
        onWorkspaceReady={() => {}}
        onBack={() =>
          void bridgeMock.dismissShareHandoff({ statusId: "status-refused" })
        }
        onOpened={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(bridgeMock.dismissShareHandoff).toHaveBeenCalledOnce();
    expect(bridgeMock.dismissShareHandoff.mock.calls[0]).toEqual([
      { statusId: "status-refused" },
    ]);
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
    expect(bridgeMock.openSharedView).not.toHaveBeenCalled();
  });

  it("does not expose forbidden handoff or granted-row values", async () => {
    const forbidden = [
      "handoff-code-secret",
      "bearer-token-secret",
      "grant-id-secret",
      "https://relay.secret.test",
      "raw-response-secret",
      "https://share.secret.test/open/complete-link",
    ];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    bridgeMock.listRelayShares.mockResolvedValue({
      granted: [
        grantedShare(
          "share-exact",
          `${forbidden[3]}:${forbidden[5]}`,
          forbidden[2]!,
        ),
      ],
      received: [receivedShare("share-exact", "ordinary-exact-share-code")],
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

    const rendered = container.textContent ?? "";
    const bridgeCalls = JSON.stringify(
      Object.values(bridgeMock).flatMap((mock) => mock.mock.calls),
    );
    const consoleCalls = JSON.stringify([
      ...consoleError.mock.calls,
      ...consoleLog.mock.calls,
    ]);
    for (const secret of forbidden) {
      expect(rendered).not.toContain(secret);
      expect(bridgeCalls).not.toContain(secret);
      expect(consoleCalls).not.toContain(secret);
    }
  });
});
