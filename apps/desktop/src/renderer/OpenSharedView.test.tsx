// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenSharedView } from "./OpenSharedView";

const bridgeMock = {
  cloudStatus: vi.fn(),
  openSharedView: vi.fn(),
  pickWorkspaceRoot: vi.fn(),
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
  bridgeMock.openSharedView.mockResolvedValue({ workspace: SHARED_VIEW });
});

afterEach(() => {
  cleanup();
});

describe("OpenSharedView", () => {
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

  it("stays disabled until both a code and a folder exist", async () => {
    const user = userEvent.setup();
    render(<OpenSharedView onWorkspaceReady={() => {}} onBack={() => {}} />);
    const button = (await screen.findByTestId("open-share-start")) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.type(screen.getByTestId("open-share-code"), "dohc-share:x:http://r.test");
    expect(button.disabled).toBe(true);
    await user.click(screen.getByTestId("open-share-choose-folder"));
    await screen.findByText("/home/ice/dohc/shared");
    expect(button.disabled).toBe(false);
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

  it("gates on a signed-in dohc Cloud session first", async () => {
    bridgeMock.cloudStatus.mockResolvedValue({ connected: false });
    render(<OpenSharedView onWorkspaceReady={() => {}} onBack={() => {}} />);
    await screen.findByText(
      "Shares are addressed to your dohc Cloud account — sign in first, then paste the code you received.",
    );
    expect(screen.queryByTestId("open-share-code")).toBeNull();
  });
});
