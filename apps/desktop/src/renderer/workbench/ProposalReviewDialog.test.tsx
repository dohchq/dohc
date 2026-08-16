// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SHARE_PROPOSAL_OPS } from "@dohc/security-contract/share-proposal-bound";
import { ProposalReviewDialog } from "./ProposalReviewDialog";

const bridgeMock = {
  readShareProposalChanges: vi.fn(),
  readShareProposalFileContent: vi.fn(),
  settleShareProposal: vi.fn(),
};

vi.mock("../bridge", () => ({
  bridge: () => bridgeMock,
}));

function changes(overrides: Record<string, unknown> = {}) {
  return {
    proposedByEmail: "friend@dohc.test",
    files: [fileRow()],
    ...overrides,
  };
}

// A metadata row. The review lists these; content arrives only when a row is
// opened.
function fileRow(overrides: Record<string, unknown> = {}) {
  return {
    opIndex: 0,
    path: "docs/plan.md",
    operation: "write",
    drifted: false,
    afterByteLength: 10,
    ...overrides,
  };
}

// Open one file of the review, by its row.
async function openFile(user: ReturnType<typeof userEvent.setup>, index = 0) {
  const toggles = await screen.findAllByTestId("proposal-review-file-toggle");
  await user.click(toggles[index]!);
}

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMock.readShareProposalChanges.mockResolvedValue(changes());
  bridgeMock.readShareProposalFileContent.mockResolvedValue({
    currentText: "one\ntwo\n",
    incomingText: "one\nthree\n",
  });
  bridgeMock.settleShareProposal.mockResolvedValue({ state: "accepted" });
});

afterEach(() => {
  cleanup();
});

function renderDialog(props: { proposalId?: string; onSettled?: () => void } = {}) {
  const onClose = vi.fn();
  const onSettled = props.onSettled ?? vi.fn();
  const view = render(
    <ProposalReviewDialog
      workspaceId="ws-1"
      proposalId={props.proposalId ?? "proposal-1"}
      onSettled={onSettled}
      onClose={onClose}
    />,
  );
  return { ...view, onClose, onSettled };
}

describe("ProposalReviewDialog", () => {
  it("names the sender, and shows a diff once a file is opened", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect((await screen.findByRole("dialog")).textContent).toContain(
      "Changes from friend@dohc.test",
    );
    const file = await screen.findByTestId("proposal-review-file");
    expect(file.dataset.proposalPath).toBe("docs/plan.md");
    expect(file.textContent).toContain("Changed");
    await openFile(user);
    expect(
      (await screen.findByTestId("proposal-review-diff-lines")).textContent,
    ).toContain("three");
  });

  // The whole review is ONE read. It used to be a listing plus one read per
  // file, and each of those re-read the entire listing from the relay.
  it("reads the whole review once, however many files it holds", async () => {
    bridgeMock.readShareProposalChanges.mockResolvedValue(
      changes({
        files: [0, 1, 2, 3, 4].map((opIndex) =>
          fileRow({ opIndex, path: `docs/f-${opIndex}.md` }),
        ),
      }),
    );
    renderDialog();

    expect(await screen.findAllByTestId("proposal-review-file")).toHaveLength(5);
    expect(
      bridgeMock.readShareProposalChanges.mock.calls,
      "MUTATION: a read per file makes a five-file review six round trips",
    ).toHaveLength(1);
    expect(bridgeMock.readShareProposalChanges).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      proposalId: "proposal-1",
    });
  });

  // The whole point of the lazy read. A review carrying what a fortnight of
  // work changes must OPEN — and opening it must not fetch a single file's
  // content, because fetching all of them is what made it impossible before.
  it("opens a review of the full bound without fetching any content", async () => {
    bridgeMock.readShareProposalChanges.mockResolvedValue(
      changes({
        files: Array.from({ length: MAX_SHARE_PROPOSAL_OPS }, (_ignored, opIndex) =>
          fileRow({ opIndex, path: `docs/f-${opIndex}.md` }),
        ),
      }),
    );
    renderDialog();

    expect(await screen.findAllByTestId("proposal-review-file")).toHaveLength(
      MAX_SHARE_PROPOSAL_OPS,
    );
    expect(
      bridgeMock.readShareProposalFileContent,
      "MUTATION: fetching content to draw the list restores the eager read this bound depends on",
    ).not.toHaveBeenCalled();
    // Every row still says what it is without its content.
    expect(screen.getAllByTestId("proposal-review-file-toggle")[0]!.textContent).toContain(
      "docs/f-0.md",
    );
    expect(screen.getByTestId("proposal-review-accept").hasAttribute("disabled")).toBe(
      false,
    );
  });

  // Opening one file fetches THAT file, and only that file.
  it("fetches one file's content when its row is opened", async () => {
    const user = userEvent.setup();
    bridgeMock.readShareProposalChanges.mockResolvedValue(
      changes({
        files: [0, 1, 2].map((opIndex) =>
          fileRow({ opIndex, path: `docs/f-${opIndex}.md` }),
        ),
      }),
    );
    renderDialog();
    await screen.findAllByTestId("proposal-review-file");

    await openFile(user, 1);

    await waitFor(() =>
      expect(screen.getByTestId("proposal-review-diff-lines")).toBeTruthy(),
    );
    expect(
      bridgeMock.readShareProposalFileContent.mock.calls,
      "MUTATION: opening one file must not fetch the ones the granter did not open",
    ).toHaveLength(1);
    expect(bridgeMock.readShareProposalFileContent).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      proposalId: "proposal-1",
      opIndex: 1,
    });
    // Exactly one file is open, so exactly one diff is drawn.
    expect(screen.getAllByTestId("proposal-review-diff-lines")).toHaveLength(1);
  });

  // Closing and reopening shows what was already read. A refetch per toggle
  // would turn one impatient granter into a stream of relay round trips.
  it("reads one file's content once, however often its row is toggled", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByTestId("proposal-review-file");

    await openFile(user);
    await screen.findByTestId("proposal-review-diff-lines");
    await openFile(user);
    await openFile(user);
    await screen.findByTestId("proposal-review-diff-lines");

    expect(
      bridgeMock.readShareProposalFileContent.mock.calls,
      "MUTATION: refetching on every toggle makes reading a file cost one round trip per click",
    ).toHaveLength(1);
  });

  // One file this surface cannot read must not take the review down with it.
  it("states a file it could not read, and keeps both decisions available", async () => {
    const user = userEvent.setup();
    bridgeMock.readShareProposalFileContent.mockRejectedValue(
      new Error("Error: dohc could not read that file."),
    );
    renderDialog();
    await screen.findByTestId("proposal-review-file");

    await openFile(user);

    expect(
      (await screen.findByTestId("proposal-review-file-error")).textContent,
    ).toContain("dohc could not read that file.");
    expect(
      screen.getByTestId("proposal-review-decline").hasAttribute("disabled"),
      "MUTATION: one unreadable file that disables Decline leaves the granter unable to answer the rest",
    ).toBe(false);
    expect(screen.getByTestId("proposal-review-accept").hasAttribute("disabled")).toBe(
      false,
    );

    // A failure is not a permanent verdict on that file. Reopening tries again.
    bridgeMock.readShareProposalFileContent.mockResolvedValue({
      currentText: "one\n",
      incomingText: "two\n",
    });
    await openFile(user);
    await openFile(user);
    expect(
      (await screen.findByTestId("proposal-review-diff-lines")).textContent,
      "MUTATION: caching a failed read leaves a transient relay error looking permanent",
    ).toContain("two");
  });

  // The relay could not state who sent them. The review still works, and the
  // dialog names an unknown account the way the share banner does.
  it("names an unknown sender the way the share surfaces already do", async () => {
    bridgeMock.readShareProposalChanges.mockResolvedValue(
      changes({ proposedByEmail: null }),
    );
    renderDialog();
    expect((await screen.findByRole("dialog")).textContent).toContain(
      "Changes from another dohc user",
    );
  });

  // Drift is the one thing review has to say that a diff cannot: the
  // granter's copy moved after the recipient sent this.
  it("states drift on the file that drifted, and only on that file", async () => {
    bridgeMock.readShareProposalChanges.mockResolvedValue(
      changes({
        files: [
          fileRow({ drifted: true }),
          fileRow({
            opIndex: 1,
            path: "docs/notes.md",
            operation: "delete",
            afterByteLength: null,
          }),
        ],
      }),
    );
    renderDialog();

    const files = await screen.findAllByTestId("proposal-review-file");
    expect(files).toHaveLength(2);
    const drift = screen.getAllByTestId("proposal-review-drift");
    expect(
      drift.map((line) => line.textContent),
      "MUTATION: dropping the drift line hides that the granter's copy moved",
    ).toEqual(["This file changed since they sent it."]);
    expect(files[0]!.dataset.drifted).toBe("true");
    expect(files[1]!.dataset.drifted).toBeUndefined();
    expect(files[1]!.textContent).toContain("Removed");
  });

  // A change this surface cannot PREVIEW is still a change the granter has to
  // answer. Binary content, content over the text bound, and a blob the relay
  // would not serve all arrive as no incoming side — and the granter must
  // still be able to say no.
  it("keeps both decisions available for a change it cannot preview", async () => {
    bridgeMock.readShareProposalChanges.mockResolvedValue(
      changes({
        files: [fileRow({ path: "docs/diagram.png" })],
      }),
    );
    renderDialog();

    await screen.findByTestId("proposal-review-file");
    expect(
      screen.getByTestId("proposal-review-decline").hasAttribute("disabled"),
      "MUTATION: failing the read on unpreviewable content leaves the granter unable to decline it",
    ).toBe(false);
    expect(screen.getByTestId("proposal-review-accept").hasAttribute("disabled")).toBe(
      false,
    );
  });

  // Decline is the safe exit: it moves nothing into this workspace. A granter
  // who cannot READ a proposal must still be able to refuse it — otherwise
  // the only way out is ending the share, which discards the recipient's work
  // without asking.
  it("still offers Decline when the review cannot be read at all", async () => {
    const user = userEvent.setup();
    bridgeMock.readShareProposalChanges.mockRejectedValue(
      new Error(
        "Error invoking remote method 'desktop:read-share-proposal-changes': " +
          "Error: dohc could not read those changes.",
      ),
    );
    renderDialog();

    await screen.findByRole("alert");
    expect(
      screen.getByTestId("proposal-review-decline").hasAttribute("disabled"),
      "MUTATION: a read failure that disables Decline leaves the granter holding a proposal they can neither see nor answer",
    ).toBe(false);
    // Accept is the opposite: it writes, so it stays disabled.
    expect(screen.getByTestId("proposal-review-accept").hasAttribute("disabled")).toBe(
      true,
    );

    await user.click(screen.getByTestId("proposal-review-decline"));
    await waitFor(() =>
      expect(bridgeMock.settleShareProposal).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        proposalId: "proposal-1",
        decision: "decline",
      }),
    );
  });

  it("accepts the whole submission", async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn();
    const { onClose } = renderDialog({ onSettled });

    await user.click(await screen.findByTestId("proposal-review-accept"));
    await waitFor(() =>
      expect(bridgeMock.settleShareProposal).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        proposalId: "proposal-1",
        decision: "accept",
      }),
    );
    expect(onSettled).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("declines the whole submission", async () => {
    const user = userEvent.setup();
    bridgeMock.settleShareProposal.mockResolvedValue({ state: "declined" });
    renderDialog();

    await user.click(await screen.findByTestId("proposal-review-decline"));
    await waitFor(() =>
      expect(bridgeMock.settleShareProposal).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        proposalId: "proposal-1",
        decision: "decline",
      }),
    );
  });

  it("states a refused decision instead of closing over it", async () => {
    const user = userEvent.setup();
    bridgeMock.settleShareProposal.mockRejectedValue(
      new Error(
        "Error invoking remote method 'desktop:settle-share-proposal': Error: This share was ended.",
      ),
    );
    const { onClose } = renderDialog();

    await user.click(await screen.findByTestId("proposal-review-accept"));
    expect((await screen.findByTestId("proposal-review-error")).textContent).toBe(
      "This share was ended.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says so when the submission is already settled, and still lets go", async () => {
    const user = userEvent.setup();
    bridgeMock.readShareProposalChanges.mockRejectedValue(
      new Error(
        "Error invoking remote method 'desktop:read-share-proposal-changes': " +
          "Error: dohc could not find those changes. Refresh, then try again.",
      ),
    );
    const { onClose } = renderDialog();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "dohc could not find those changes. Refresh, then try again.",
    );
    expect(screen.getByTestId("proposal-review-accept").hasAttribute("disabled")).toBe(
      true,
    );
    await user.click(screen.getByTestId("proposal-review-later"));
    expect(onClose).toHaveBeenCalled();
  });

  // The renderer async-state invariant: a slow answer for one submission must
  // never repaint the window that replaced it.
  it("drops an answer that belongs to a replaced window", async () => {
    let releaseFirst: (() => void) | null = null;
    bridgeMock.readShareProposalChanges.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          if (releaseFirst === null) {
            releaseFirst = () =>
              resolve(changes({ proposedByEmail: "stale@dohc.test" }));
            return;
          }
          resolve(changes({ proposedByEmail: "current@dohc.test" }));
        }),
    );

    const { rerender } = renderDialog();
    await waitFor(() => expect(releaseFirst).not.toBeNull());
    rerender(
      <ProposalReviewDialog
        workspaceId="ws-1"
        proposalId="proposal-2"
        onSettled={() => {}}
        onClose={() => {}}
      />,
    );
    expect((await screen.findByRole("dialog")).textContent).toContain(
      "Changes from current@dohc.test",
    );

    // Let the retired answer settle all the way through, so the assertion
    // below sees what it WOULD have painted.
    releaseFirst!();
    for (let flush = 0; flush < 4; flush += 1) {
      await act(async () => {});
    }
    expect(
      screen.getByRole("dialog").textContent,
      "MUTATION: dropping the liveness token repaints a replaced window",
    ).not.toContain("stale@dohc.test");
    expect(screen.getByRole("dialog").textContent).toContain(
      "Changes from current@dohc.test",
    );
  });
});
