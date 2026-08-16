// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedByMeList } from "./SharedByMeList";

const bridgeMock = {
  listRelayShares: vi.fn(),
  listShareProposals: vi.fn(),
  readShareProposalDiff: vi.fn(),
  settleShareProposal: vi.fn(),
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
  bridgeMock.listShareProposals.mockResolvedValue({ proposals: [] });
  bridgeMock.revokeRelayShare.mockResolvedValue(undefined);
  bridgeMock.writeClipboardText.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("SharedByMeList", () => {
  it("lists active shares and ends one on request", async () => {
    const user = userEvent.setup();
    render(<SharedByMeList workspaceId="ws-1" />);

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
    render(<SharedByMeList workspaceId="ws-1" />);

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
    render(<SharedByMeList workspaceId="ws-1" />);

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
    render(<SharedByMeList workspaceId="ws-1" />);
    await screen.findByTestId("shared-by-me-row");
    await user.click(screen.getByTestId("shared-by-me-copy"));
    expect(bridgeMock.writeClipboardText).toHaveBeenCalledWith({
      text: "dohc-share:share-1:http://relay.test",
    });
  });

  // The row states what is waiting and opens the review that decides it
  // (#646 PR3a). A grant inventory with a count is still an inventory.
  it("counts the changes waiting on a row and opens the review", async () => {
    const user = userEvent.setup();
    bridgeMock.listShareProposals.mockResolvedValue({
      proposals: [
        {
          proposalId: "proposal-old",
          shareId: "share-1",
          proposedByEmail: "friend@dohc.test",
          createdAtMs: 1000,
          files: [
            { opIndex: 0, path: "docs/plan.md", operation: "write", drifted: false },
          ],
        },
        {
          proposalId: "proposal-new",
          shareId: "share-1",
          proposedByEmail: "friend@dohc.test",
          createdAtMs: 2000,
          files: [
            { opIndex: 0, path: "docs/notes.md", operation: "write", drifted: false },
          ],
        },
      ],
    });
    bridgeMock.readShareProposalDiff.mockResolvedValue({
      path: "docs/plan.md",
      drifted: false,
      operation: "write",
      currentText: "before",
      incomingText: "after",
    });
    render(<SharedByMeList workspaceId="ws-1" />);

    const review = await screen.findByTestId("shared-by-me-review");
    expect(review.textContent).toBe("Review changes (2)");
    expect(review.dataset.openChanges).toBe("2");

    // The oldest waiting submission opens first — the sender who waited
    // longest is decided first.
    await user.click(review);
    await screen.findByTestId("proposal-review-dialog");
    expect(bridgeMock.readShareProposalDiff).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      proposalId: "proposal-old",
      opIndex: 0,
    });
  });

  // A share with nothing waiting must not grow a control that reviews
  // nothing: the row would ask for a decision nobody submitted.
  it("shows no review control when nothing is waiting", async () => {
    render(<SharedByMeList workspaceId="ws-1" />);
    await screen.findByTestId("shared-by-me-row");
    expect(
      screen.queryByTestId("shared-by-me-review"),
      "MUTATION: offering a review for a share with no waiting changes",
    ).toBeNull();
  });

  // The listing is workspace-scoped and a share view is refused it. A refusal
  // must cost the inventory nothing — ending a share stays possible.
  it("still lists shares when the changes listing is refused", async () => {
    bridgeMock.listShareProposals.mockRejectedValue(
      new Error("Share views cannot review changes."),
    );
    render(<SharedByMeList workspaceId="ws-1" />);
    await screen.findByTestId("shared-by-me-row");
    expect(screen.queryByTestId("shared-by-me-error")).toBeNull();
    expect(screen.queryByTestId("shared-by-me-revoke")).not.toBeNull();
  });

  it("shows calm empty and error states", async () => {
    bridgeMock.listRelayShares.mockResolvedValue({ granted: [] });
    render(<SharedByMeList workspaceId="ws-1" />);
    await screen.findByTestId("shared-by-me-empty");
    cleanup();

    bridgeMock.listRelayShares.mockRejectedValue(
      new Error(
        "Error invoking remote method 'desktop:list-relay-shares': Error: Sign in to dohc Cloud first.",
      ),
    );
    render(<SharedByMeList workspaceId="ws-1" />);
    const error = await screen.findByTestId("shared-by-me-error");
    expect(error.textContent).toBe("Sign in to dohc Cloud first.");
  });
});
