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
  selector: { paths: ["docs"], versionId: null, access: "view" },
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

  // Every row carries its level (#646). A badge shown only on some rows
  // teaches the reader nothing when it is absent.
  it("shows the level on every row, at whatever level the share carries", async () => {
    bridgeMock.listRelayShares.mockResolvedValue({
      granted: [
        ACTIVE_SHARE,
        {
          ...ACTIVE_SHARE,
          shareId: "share-2",
          selector: { paths: ["notes"], versionId: null, access: "comment" },
        },
        {
          ...ACTIVE_SHARE,
          shareId: "share-3",
          selector: { paths: ["plans"], versionId: null, access: "edit" },
        },
      ],
    });
    render(<SharedByMeList />);

    const badges = await screen.findAllByTestId("share-access-badge");
    expect(badges.map((badge) => badge.textContent)).toEqual([
      "View",
      "Comment",
      "Edit",
    ]);
  });

  // A row the relay cannot read has no code worth handing out: the
  // recipient's own open would refuse it. Ending the share must survive,
  // because a share you cannot end is worse than one you cannot copy.
  it("hides Copy code for an unreadable row but keeps End share", async () => {
    bridgeMock.listRelayShares.mockResolvedValue({
      granted: [{ ...ACTIVE_SHARE, selector: null, damaged: true }],
    });
    render(<SharedByMeList />);

    await screen.findByTestId("shared-by-me-row");
    expect(
      screen.queryByTestId("shared-by-me-copy"),
      "MUTATION: handing out a code for a share the relay cannot read",
    ).toBeNull();
    expect(screen.queryByTestId("shared-by-me-revoke")).not.toBeNull();
    expect(screen.queryByTestId("share-access-badge")).toBeNull();
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
