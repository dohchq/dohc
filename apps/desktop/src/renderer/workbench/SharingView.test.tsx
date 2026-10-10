// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessAnswer, AccessShareRow } from "@dohc/workspace-contracts/access";
import type { ShareProposalRow } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import type { AccessFacts } from "./About";
import { groupShares, SharingView, waitingByShare, type ShareMount } from "./SharingView";

type Lane = "granted" | "received";
const bridgeMock = {
  listSharingAccess: vi.fn<(input: { workspaceId: string; lane: Lane; cursor?: string }) => Promise<AccessAnswer>>(),
  requestAccessRefresh: vi.fn<(input: { workspaceId: string; reason: string }) => Promise<void>>(),
  revokeRelayShare: vi.fn<(input: { shareId: string }) => Promise<{ undo?: { undoId: string; expiresAtMs: number } }>>(),
  getRelayReceivedShare: vi.fn<(input: { shareId: string }) => Promise<unknown>>(),
  mountShare: vi.fn<(input: { workspaceId: string; shareCode: string }) => Promise<unknown>>(),
};

const notices = { report: vi.fn(), clear: vi.fn() };
const shareRemovals = { removed: vi.fn(), failed: vi.fn() };
const callbacks = {
  onReviewConflicts: vi.fn(),
  onReviewChanges: vi.fn(),
  onMounted: vi.fn(),
  onUnmount: vi.fn(async (_path: string) => undefined),
  reportError: vi.fn(),
  openSyncSettings: vi.fn(),
  connect: vi.fn(),
};
const SYNCED: AccessFacts = { cloud: { connected: true, workspaceSynced: true, workspaceSyncConnected: true }, shareView: false };
const SIGNED_OUT: AccessFacts = { cloud: { connected: false, workspaceSynced: true, workspaceSyncConnected: false }, shareView: false };
const contexts = new Map<AccessFacts, { facts: AccessFacts; openSyncSettings: () => void; connect: () => void }>();
function contextFor(facts: AccessFacts) {
  let context = contexts.get(facts);
  if (!context) contexts.set(facts, (context = { facts, openSyncSettings: callbacks.openSyncSettings, connect: callbacks.connect }));
  return context;
}

beforeEach(() => {
  for (const mock of [...Object.values(bridgeMock), notices.report, notices.clear, shareRemovals.removed, shareRemovals.failed, ...Object.values(callbacks)]) mock.mockReset();
  bridgeMock.requestAccessRefresh.mockResolvedValue(undefined);
  callbacks.onUnmount.mockResolvedValue(undefined);
  vi.stubGlobal("dohcDesktop", bridgeMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CHECKED_AT = Date.UTC(2026, 9, 9, 9, 30);
function answer(lane: Lane, overrides: Partial<AccessAnswer> = {}): AccessAnswer {
  return {
    ref: null, rows: [], visibility: "visible",
    coverage: { kind: lane === "granted" ? "granted" : "received-account", complete: true, observation: "interval" },
    checkedAtMs: CHECKED_AT, freshness: "fresh", nextCursor: null, ...overrides,
  };
}
const UNKNOWN = (lane: Lane) => answer(lane, {
  visibility: "unknown", coverage: { kind: "unavailable", complete: false, observation: "interval" }, checkedAtMs: null, freshness: "unknown",
});
function granted(overrides: Partial<AccessShareRow> = {}): AccessShareRow {
  return {
    kind: "share", shareId: "share-1", grantId: "grant-1", via: "named",
    granterUserId: "owner", granterEmail: "owner@example.com", recipientUserId: "sam", recipientEmail: "sam@example.com",
    subjectName: null, sharerName: null, selector: { paths: ["notes/product-plan.md"], versionId: null },
    access: "edit", status: "active", generation: 1, ...overrides,
  };
}
function received(overrides: Partial<AccessShareRow> = {}): AccessShareRow {
  return granted({
    shareId: "in-1", grantId: "in-grant-1", via: "received", granterEmail: "sam@example.com", sharerName: "Sam",
    recipientUserId: "me", recipientEmail: null, subjectName: "funnel.csv", selector: { paths: ["data/funnel.csv"], versionId: null },
    access: "view", ...overrides,
  });
}

// Answers per lane, read from the workspace and cursor each call names.
function answerWith(answers: Partial<Record<Lane, AccessAnswer | Error>>) {
  bridgeMock.listSharingAccess.mockImplementation(async ({ lane }) => {
    const value = answers[lane] ?? answer(lane);
    if (value instanceof Error) throw value;
    return value;
  });
}

function View(props: {
  workspaceId?: string; facts?: AccessFacts; shareView?: boolean; conflictCount?: number | null;
  proposals?: ShareProposalRow[]; mounts?: ShareMount[];
}) {
  return (
    <SharingView
      workspaceId={props.workspaceId ?? "workspace-a"}
      shareView={props.shareView ?? false}
      context={contextFor(props.facts ?? SYNCED)}
      notices={notices}
      conflictCount={props.conflictCount ?? null}
      onReviewConflicts={callbacks.onReviewConflicts}
      proposals={props.proposals ?? []}
      onReviewChanges={callbacks.onReviewChanges}
      mounts={props.mounts ?? []}
      onMounted={callbacks.onMounted}
      onUnmount={callbacks.onUnmount}
      shareRemovals={shareRemovals}
      reportError={callbacks.reportError}
    />
  );
}

async function openMenu(row: HTMLElement) {
  await userEvent.click(within(row).getByRole("button", { name: "Share actions" }));
  return screen.getByRole("menu");
}

describe("the Sharing view's two lists", () => {
  it("lists this workspace's shares and the account's, each with its count, folder, faces and level", async () => {
    answerWith({
      granted: answer("granted", { rows: [granted(), granted({ grantId: "grant-2", recipientEmail: "nova@example.com" }),
        granted({ shareId: "share-2", grantId: "grant-3", selector: { paths: ["research/competitors.md"], versionId: null }, access: "view" })] }),
      received: answer("received", { rows: [received()] }),
    });
    render(<View />);

    const grantedRows = await screen.findAllByTestId("sharing-granted-row");
    expect(grantedRows).toHaveLength(2);
    expect(grantedRows[0]!.textContent).toContain("product-plan.md");
    expect(grantedRows[0]!.textContent).toContain("notes/");
    expect(within(grantedRows[0]!).getByRole("img", { name: "Edit" })).toBeTruthy();
    expect(screen.getByTestId("sharing-granted-count").textContent).toBe("2");
    const receivedRow = await screen.findByTestId("sharing-received-row");
    expect(receivedRow.textContent).toContain("funnel.csv");
    expect(receivedRow.textContent).toContain("from Sam");
    expect(within(receivedRow).getByRole("img", { name: "View" })).toBeTruthy();
    expect(screen.getByTestId("sharing-received-count").textContent).toBe("1");
    expect(screen.getByTestId("sharing-granted-freshness").getAttribute("data-state")).toBe("fresh");
    // Opening the view asks main to check again once, for both lists.
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledTimes(1);
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledWith({ workspaceId: "workspace-a", reason: "sharing-open" });
  });

  it("shows loading lines until each list answers", async () => {
    const pending = deferred<AccessAnswer>();
    bridgeMock.listSharingAccess.mockReturnValue(pending.promise);
    render(<View />);
    await waitFor(() => expect(bridgeMock.listSharingAccess).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("sharing-granted-answer")).toBeNull();
    expect(screen.queryByTestId("sharing-received-answer")).toBeNull();
    pending.resolve(answer("granted"));
    expect(await screen.findByTestId("sharing-granted-empty")).toBeTruthy();
  });

  it("says an empty list holds no shares within its coverage, not that nothing is shared", async () => {
    answerWith({});
    render(<View />);
    expect((await screen.findByTestId("sharing-granted-empty")).textContent).toContain("No shares from this workspace.");
    expect((await screen.findByTestId("sharing-received-empty")).textContent).toBe("No shares to your account.");
    expect(screen.getByTestId("sharing-granted-count").textContent).toBe("0");
  });

  it("marks a stale list as possibly out of date and keeps its rows", async () => {
    answerWith({ granted: answer("granted", { freshness: "stale", rows: [granted()] }) });
    render(<View />);
    const mark = await screen.findByTestId("sharing-granted-freshness");
    expect(mark.getAttribute("data-state")).toBe("stale");
    expect(mark.textContent).toContain("May be out of date");
    expect(screen.getByTestId("sharing-granted-row")).toBeTruthy();
  });

  it("explains an unknown list in About's words, with no count and no empty claim", async () => {
    answerWith({ granted: UNKNOWN("granted"), received: UNKNOWN("received") });
    render(<View />);
    const unknown = await screen.findByTestId("sharing-granted-unknown");
    expect(unknown.getAttribute("data-reason")).toBe("unexplained");
    expect(unknown.textContent).toContain("This does not mean that nothing is shared.");
    expect(screen.queryByTestId("sharing-granted-count")).toBeNull();
    expect(screen.queryByTestId("sharing-granted-empty")).toBeNull();
    await userEvent.click(within(unknown).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledTimes(2));
  });

  it("asks a signed-out person to connect their server", async () => {
    answerWith({ granted: UNKNOWN("granted"), received: UNKNOWN("received") });
    render(<View facts={SIGNED_OUT} />);
    const unknown = await screen.findByTestId("sharing-received-unknown");
    expect(unknown.getAttribute("data-reason")).toBe("signed-out");
    await userEvent.click(within(unknown).getByRole("button", { name: "Connect server" }));
    expect(callbacks.connect).toHaveBeenCalledOnce();
  });

  it("files a failed read in Notices and reads again from Try again", async () => {
    answerWith({ received: new Error("offline") });
    render(<View />);
    const failed = await screen.findByTestId("sharing-received-failed");
    expect(notices.report).toHaveBeenCalledWith(expect.objectContaining({ identity: "sharing-received" }));
    answerWith({ received: answer("received", { rows: [received()] }) });
    await userEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("sharing-received-row")).toBeTruthy();
    expect(notices.clear).toHaveBeenCalledWith("sharing-received");
  });

  it("pages with the list's cursor and keeps the rows it has", async () => {
    bridgeMock.listSharingAccess.mockImplementation(async ({ lane, cursor }) => lane === "received" ? answer("received")
      : cursor === "page-2" ? answer("granted", { rows: [granted({ shareId: "share-2", grantId: "grant-2" })] })
        : answer("granted", { rows: [granted()], nextCursor: "page-2" }));
    render(<View />);
    expect((await screen.findByTestId("sharing-granted-count")).textContent).toBe("1+");
    await userEvent.click(screen.getByTestId("sharing-granted-more"));
    await waitFor(() => expect(screen.getAllByTestId("sharing-granted-row")).toHaveLength(2));
    expect(bridgeMock.listSharingAccess).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", lane: "granted", cursor: "page-2" });
    expect(screen.queryByTestId("sharing-granted-more")).toBeNull();
  });

  it("never paints a slow answer for one workspace into another", async () => {
    const slow = deferred<AccessAnswer>();
    bridgeMock.listSharingAccess.mockImplementation(async ({ workspaceId, lane }) =>
      workspaceId === "workspace-a" && lane === "granted" ? slow.promise
        : answer(lane, { rows: workspaceId === "workspace-b" && lane === "granted" ? [granted({ shareId: "share-b", selector: { paths: ["b.md"], versionId: null } })] : [] }));
    const { rerender } = render(<View workspaceId="workspace-a" />);
    await waitFor(() => expect(bridgeMock.listSharingAccess).toHaveBeenCalledWith({ workspaceId: "workspace-a", lane: "granted" }));
    rerender(<View workspaceId="workspace-b" />);
    const row = await screen.findByTestId("sharing-granted-row");
    slow.resolve(answer("granted", { rows: [granted({ shareId: "share-a", selector: { paths: ["a.md"], versionId: null } })] }));
    await slow.promise;
    await Promise.resolve();
    expect(screen.getAllByTestId("sharing-granted-row")).toEqual([row]);
    expect(row.getAttribute("data-share-id")).toBe("share-b");
  });

  it("leaves out Shared by me in a shared view", async () => {
    answerWith({});
    render(<View shareView />);
    expect(await screen.findByTestId("sharing-received-empty")).toBeTruthy();
    expect(screen.queryByTestId("sharing-granted")).toBeNull();
    expect(bridgeMock.listSharingAccess).not.toHaveBeenCalledWith(expect.objectContaining({ lane: "granted" }));
  });
});

describe("the actions Settings offers on a share", () => {
  it("ends a share after it asks, then reports the removal with its Undo and reads again", async () => {
    answerWith({ granted: answer("granted", { rows: [granted()] }) });
    const undo = { undoId: "undo-1", expiresAtMs: Date.now() + 600_000 };
    bridgeMock.revokeRelayShare.mockResolvedValue({ undo });
    render(<View />);
    const row = await screen.findByTestId("sharing-granted-row");
    await userEvent.click(within(await openMenu(row)).getByRole("menuitem", { name: "End share…" }));
    const confirm = screen.getByTestId("sharing-end-confirm");
    expect(confirm.textContent).toContain("End this share? sam@example.com keeps a read-only copy and stops receiving updates.");
    // Focus lands on Cancel, and Escape takes the question back.
    expect(document.activeElement).toBe(screen.getByTestId("sharing-end-cancel"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("sharing-end-confirm")).toBeNull();
    expect(bridgeMock.revokeRelayShare).not.toHaveBeenCalled();

    await userEvent.click(within(await openMenu(row)).getByRole("menuitem", { name: "End share…" }));
    await userEvent.click(screen.getByTestId("sharing-end"));
    await waitFor(() => expect(shareRemovals.removed).toHaveBeenCalledOnce());
    expect(bridgeMock.revokeRelayShare).toHaveBeenCalledWith({ shareId: "share-1" });
    expect(shareRemovals.removed).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-a", shareId: "share-1", undo,
      message: "Ended the share of notes/product-plan.md with sam@example.com.",
      restoredMessage: "Restored the share of notes/product-plan.md with sam@example.com.",
    }));
    await waitFor(() => expect(screen.queryByTestId("sharing-end-confirm")).toBeNull());
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledTimes(2);
  });

  it("counts the changes ending a share declines, and files a refused end with Try again", async () => {
    answerWith({ granted: answer("granted", { rows: [granted()] }) });
    bridgeMock.revokeRelayShare.mockRejectedValue(new Error("relay down"));
    const proposals = [1, 2].map((n) => ({ proposalId: `proposal-${n}`, shareId: "share-1", proposedByEmail: "sam@example.com", createdAtMs: n, ops: 1 }));
    render(<View proposals={proposals} />);
    const row = await screen.findByTestId("sharing-granted-row");
    await userEvent.click(within(await openMenu(row)).getByRole("menuitem", { name: "End share…" }));
    expect(screen.getByTestId("sharing-end-confirm").textContent).toContain("decline 2 changes sam@example.com sent");
    await userEvent.click(screen.getByTestId("sharing-end"));
    await waitFor(() => expect(shareRemovals.failed).toHaveBeenCalledOnce());
    expect(shareRemovals.failed.mock.calls[0]![0]).toMatchObject({
      workspaceId: "workspace-a", message: "dohc could not end the share of notes/product-plan.md with sam@example.com.",
    });
  });

  it("opens the oldest waiting change for review, from the row and from its menu", async () => {
    answerWith({ granted: answer("granted", { rows: [granted()] }) });
    const proposals = [
      { proposalId: "newer", shareId: "share-1", proposedByEmail: null, createdAtMs: 20, ops: 1 },
      { proposalId: "older", shareId: "share-1", proposedByEmail: null, createdAtMs: 10, ops: 1 },
    ];
    render(<View proposals={proposals} />);
    const row = await screen.findByTestId("sharing-granted-row");
    await userEvent.click(within(row).getByTestId("sharing-review"));
    expect(callbacks.onReviewChanges).toHaveBeenLastCalledWith("older");
    await userEvent.click(within(await openMenu(row)).getByRole("menuitem", { name: "Review changes (2)" }));
    expect(callbacks.onReviewChanges).toHaveBeenCalledTimes(2);
  });

  it("keeps an ended share listed by its label, marked ended, with nothing left to end", async () => {
    answerWith({ granted: answer("granted", { rows: [granted({ status: "revoked", selector: null, access: null, subjectName: "plan.md" })] }) });
    render(<View />);
    const row = await screen.findByTestId("sharing-granted-row");
    expect(row.textContent).toContain("plan.md");
    expect(within(row).getByTestId("sharing-row-status").textContent).toBe("ended");
    expect(within(row).queryByRole("button", { name: "Share actions" })).toBeNull();
    expect(screen.getByTestId("sharing-granted-count").textContent).toBe("0");
  });

  it("offers no End share for a link or a chat: those end where they were made", async () => {
    answerWith({ granted: answer("granted", { rows: [
      granted({ shareId: "link-share", grantId: "link", via: "link", recipientEmail: null, recipientUserId: null }),
      granted({ shareId: "chat-share", grantId: "chat", selector: { kind: "chat", channelWireId: "wire-1" }, access: "read-write" }),
    ] }) });
    render(<View />);
    const rows = await screen.findAllByTestId("sharing-granted-row");
    for (const row of rows) expect(within(row).queryByRole("button", { name: "Share actions" })).toBeNull();
  });

  it("adds a share sent to the account with its code, then tells the shell", async () => {
    answerWith({ received: answer("received", { rows: [received()] }) });
    bridgeMock.getRelayReceivedShare.mockResolvedValue({ found: true, share: { shareCode: "code-1" } });
    bridgeMock.mountShare.mockResolvedValue({});
    render(<View />);
    const row = await screen.findByTestId("sharing-received-row");
    await userEvent.click(within(await openMenu(row)).getByRole("menuitem", { name: "Add to workspace" }));
    await waitFor(() => expect(callbacks.onMounted).toHaveBeenCalledOnce());
    expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledWith({ shareId: "in-1" });
    expect(bridgeMock.mountShare).toHaveBeenCalledWith({ workspaceId: "workspace-a", shareCode: "code-1" });
  });

  it("reports a share that could not be added, with Try again", async () => {
    answerWith({ received: answer("received", { rows: [received()] }) });
    bridgeMock.getRelayReceivedShare.mockResolvedValue({ found: false, removed: { message: "Sam stopped sharing this." } });
    render(<View />);
    const row = await screen.findByTestId("sharing-received-row");
    await userEvent.click(within(await openMenu(row)).getByRole("menuitem", { name: "Add to workspace" }));
    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
    expect(callbacks.reportError.mock.calls[0]![0]).toBe("dohc could not add this share to the workspace.");
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
  });

  it("removes an added share through the shell, and shows its pinned level", async () => {
    answerWith({ received: answer("received", { rows: [received({ access: "edit" })] }) });
    const mount: ShareMount = { shareId: "in-1", label: "funnel", granterEmail: "sam@example.com", access: "view" };
    render(<View mounts={[mount]} />);
    const row = await screen.findByTestId("sharing-received-row");
    expect(within(row).getByTestId("sharing-mounted")).toBeTruthy();
    expect(within(row).getByRole("img", { name: "View" })).toBeTruthy();
    await userEvent.click(within(await openMenu(row)).getByRole("menuitem", { name: "Remove from workspace" }));
    expect(callbacks.onUnmount).toHaveBeenCalledWith("shared-with-me/funnel");
  });
});

describe("the sync state the rail's button showed", () => {
  it("shows the conflict count first, with Review, only while there is a conflict", async () => {
    answerWith({});
    const { rerender } = render(<View conflictCount={3} />);
    const row = await screen.findByTestId("sharing-conflicts");
    expect(row.textContent).toContain("3 files changed on two machines");
    await userEvent.click(within(row).getByRole("button", { name: "Review" }));
    expect(callbacks.onReviewConflicts).toHaveBeenCalledOnce();
    rerender(<View conflictCount={1} />);
    expect(screen.getByTestId("sharing-conflicts").textContent).toContain("A file changed on two machines");
    rerender(<View conflictCount={null} />);
    expect(screen.queryByTestId("sharing-conflicts")).toBeNull();
  });
});

describe("grouping and waiting changes", () => {
  it("joins a share's grants across pages into one row", () => {
    const groups = groupShares([granted(), granted({ grantId: "grant-2" }), granted({ shareId: "share-2", grantId: "grant-3" })]);
    expect(groups.map((group) => [group.shareId, group.rows.length])).toEqual([["share-1", 2], ["share-2", 1]]);
  });

  it("counts waiting changes per share and keeps the oldest", () => {
    const waiting = waitingByShare([
      { proposalId: "b", shareId: "s", proposedByEmail: null, createdAtMs: 5, ops: 1 },
      { proposalId: "a", shareId: "s", proposedByEmail: null, createdAtMs: 1, ops: 1 },
    ]);
    expect(waiting.get("s")).toMatchObject({ count: 2, oldestProposalId: "a" });
  });
});
