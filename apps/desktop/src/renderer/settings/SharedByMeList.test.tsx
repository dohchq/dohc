// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedByMeList } from "./SharedByMeList";

const bridgeMock = {
  listRelayShares: vi.fn(),
  revokeRelayShare: vi.fn(),
  writeClipboardText: vi.fn(),
};

vi.mock("../bridge", () => ({
  bridge: () => bridgeMock,
}));

const ACTIVE_SHARE = {
  shareId: "share-1",
  workspaceId: "ws-remote",
  recipientUserId: "friend",
  recipientEmail: "friend@dohc.test",
  selector: { paths: ["docs"], versionId: null },
  createdAtMs: 1000,
  revokedAtMs: null,
  shareCode: "dohc-share:share-1:http://relay.test",
};

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMock.listRelayShares.mockResolvedValue({ granted: [ACTIVE_SHARE] });
  bridgeMock.revokeRelayShare.mockResolvedValue(undefined);
  bridgeMock.writeClipboardText.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("SharedByMeList", () => {
  it("lists active shares and ends one on request", async () => {
    const user = userEvent.setup();
    render(<SharedByMeList />);

    const row = await screen.findByTestId("shared-by-me-row");
    expect(row.textContent).toContain("docs");
    expect(row.textContent).toContain("Shared with friend@dohc.test");

    bridgeMock.listRelayShares.mockResolvedValue({
      granted: [{ ...ACTIVE_SHARE, revokedAtMs: 2000 }],
    });
    await user.click(screen.getByTestId("shared-by-me-revoke"));
    await waitFor(() =>
      expect(bridgeMock.revokeRelayShare).toHaveBeenCalledWith({ shareId: "share-1" }),
    );
    // After the refresh the row reads as ended, with no revoke affordance.
    await screen.findByText("Ended — was shared with friend@dohc.test");
    expect(screen.queryByTestId("shared-by-me-revoke")).toBeNull();
  });

  it("copies the share code for re-sending", async () => {
    const user = userEvent.setup();
    render(<SharedByMeList />);
    await screen.findByTestId("shared-by-me-row");
    await user.click(screen.getByTestId("shared-by-me-copy"));
    expect(bridgeMock.writeClipboardText).toHaveBeenCalledWith({
      text: "dohc-share:share-1:http://relay.test",
    });
  });

  it("shows calm empty and error states", async () => {
    bridgeMock.listRelayShares.mockResolvedValue({ granted: [] });
    render(<SharedByMeList />);
    await screen.findByTestId("shared-by-me-empty");
    cleanup();

    bridgeMock.listRelayShares.mockRejectedValue(
      new Error(
        "Error invoking remote method 'desktop:list-relay-shares': Error: Sign in to dohc Cloud first.",
      ),
    );
    render(<SharedByMeList />);
    const error = await screen.findByTestId("shared-by-me-error");
    expect(error.textContent).toBe("Sign in to dohc Cloud first.");
  });
});
