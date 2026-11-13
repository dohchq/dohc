// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessAnswer, AccessShareRow } from "@dohc/workspace-contracts/access";
import type { ShareCopyResult } from "@dohc/workspace-contracts/share-copy";
import type { ShareProposalRow } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { ShellErrorReporter } from "../shell/useShellError";
import type { AccessFacts } from "./accessReason";
import { SharingView, waitingByShare, type ShareMount, type SharingFocus } from "./SharingView";

type Lane = "granted" | "received";
const bridgeMock = {
  listSharingAccess: vi.fn<(input: { workspaceId: string; lane: Lane; cursor?: string }) => Promise<AccessAnswer>>(),
  requestAccessRefresh: vi.fn<(input: { workspaceId: string; reason: string }) => Promise<void>>(),
  revokeRelayShare: vi.fn<(input: { shareId: string }) => Promise<{ undo?: { undoId: string; expiresAtMs: number } }>>(),
  getRelayReceivedShare: vi.fn<(input: { shareId: string }) => Promise<unknown>>(),
  mountShare: vi.fn<(input: { workspaceId: string; shareCode: string }) => Promise<unknown>>(),
  getShareCopyDetails: vi.fn<(input: { shareId: string; grantId: string }) => Promise<ShareCopyResult>>(),
  dismissShareSkips: vi.fn<(input: { workspaceId: string; shareId: string; generation: number }) => Promise<void>>(),
};

const notices = { report: vi.fn(), clear: vi.fn() };
const shareRemovals = { removed: vi.fn(), failed: vi.fn(), agentDisconnected: vi.fn() };
const callbacks = {
  onReviewConflicts: vi.fn(),
  onReviewChanges: vi.fn(),
  onMountsChanged: vi.fn(),
  onFocused: vi.fn(),
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
  // The invitation probe's answer, unless a test says otherwise: no invitations.
  bridgeMock.getShareCopyDetails.mockResolvedValue({ status: "active", shareCode: "dohc-share:share-1:https://relay.test" });
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
    unknownReason: null, coverage: { kind: lane === "granted" ? "granted" : "received-account", complete: true, observation: "interval" },
    checkedAtMs: CHECKED_AT, freshness: "fresh", nextCursor: null, ...overrides,
  };
}
const UNKNOWN = (lane: Lane) => answer(lane, {
  visibility: "unknown", unknownReason: "not-listed-yet", coverage: { kind: "unavailable", complete: false, observation: "interval" }, checkedAtMs: null, freshness: "unknown",
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

// Stands in for the shell: its removal notices count each removal, and the
// count outlives the view, which `open` closes and reopens.
function View(props: {
  workspaceId?: string; facts?: AccessFacts; shareView?: boolean; conflictCount?: number | null;
  proposals?: ShareProposalRow[]; mounts?: ShareMount[]; open?: boolean; focus?: SharingFocus;
}) {
  const [sharesRevision, sharesChanged] = useReducer((revision: number) => revision + 1, 0);
  const removals = useMemo(() => ({
    removed: (removal: Parameters<typeof shareRemovals.removed>[0]) => {
      shareRemovals.removed(removal);
      sharesChanged();
    },
    failed: shareRemovals.failed,
    agentDisconnected: shareRemovals.agentDisconnected,
  }), []);
  if (props.open === false) return null;
  return (
    <SharingView
      sharesRevision={sharesRevision}
      workspaceId={props.workspaceId ?? "workspace-a"}
      shareView={props.shareView ?? false}
      context={contextFor(props.facts ?? SYNCED)}
      notices={notices}
      conflictCount={props.conflictCount ?? null}
      onReviewConflicts={callbacks.onReviewConflicts}
      proposals={props.proposals ?? []}
      onReviewChanges={callbacks.onReviewChanges}
      mounts={props.mounts ?? []}
      onMountsChanged={callbacks.onMountsChanged}
      onUnmount={callbacks.onUnmount}
      shareRemovals={removals}
      reportError={callbacks.reportError}
      focus={props.focus ?? null}
      onFocused={callbacks.onFocused}
    />
  );
}

async function openMenu(row: HTMLElement) {
  await userEvent.click(within(row).getByRole("button", { name: "Share actions" }));
  return screen.getByRole("menu");
}

describe("the Sharing view's two lists", () => {
  it("lists this workspace's shares and the account's, each with its count and who can do what", async () => {
    answerWith({
      granted: answer("granted", { rows: [granted(), granted({ grantId: "grant-2", recipientEmail: "nova@example.com" }),
        granted({ shareId: "share-2", grantId: "grant-3", selector: { paths: ["research/competitors.md"], versionId: null }, access: "view" })] }),
      received: answer("received", { rows: [received()] }),
    });
    render(<View />);

    const grantedRows = await screen.findAllByTestId("sharing-granted-row");
    expect(grantedRows).toHaveLength(2);
    expect(grantedRows[0]!.textContent).toBe("product-plan.md2 people can edit");
    // A live share's name is content, in ink.
    expect(within(grantedRows[0]!).getByText("product-plan").parentElement!.className).toContain("text-ink");
    // The count's tooltip names each person with their level, one per line.
    expect(within(grantedRows[0]!).getByTestId("sharing-row-who").getAttribute("title"))
      .toBe("sam@example.com can edit\nnova@example.com can edit");
    expect(grantedRows[1]!.textContent).toBe("competitors.mdsam@example.com can view");
    expect(screen.getByTestId("sharing-granted-count").textContent).toBe("2");
    const receivedRow = await screen.findByTestId("sharing-received-row");
    expect(receivedRow.textContent).toBe("funnel.csvSam lets you view");
    expect(within(receivedRow).getByTestId("sharing-row-who").getAttribute("title")).toBe("Sam (sam@example.com) lets you view");
    expect(screen.getByTestId("sharing-received-count").textContent).toBe("1");
    expect(screen.getByTestId("sharing-granted-freshness").getAttribute("data-state")).toBe("fresh");
    // Each list says what it covers, rows or not.
    expect(screen.getByTestId("sharing-granted-freshness-scope").textContent).toBe("for this workspace");
    expect(screen.getByTestId("sharing-received-freshness-scope").textContent).toBe("for your account");
    // Opening the view asks main to check again once, for both lists.
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledTimes(1);
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledWith({ workspaceId: "workspace-a", reason: "sharing-open" });
  });

  it("files a failed read in Notices and reads again from Try again", async () => {
    answerWith({ received: new Error("offline") });
    render(<View />);
    const failed = await screen.findByTestId("sharing-received-failed");
    // The list says it could not load, in one line; the cause stays in Notices.
    expect(failed.querySelector("p")!.textContent).toBe("dohc could not check the shares to your account.");
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
    const count = await screen.findByTestId("sharing-granted-count");
    // "1+" on screen, read as "1 or more shares".
    expect(within(count).getByText("1+").getAttribute("aria-hidden")).toBe("true");
    expect(within(count).getByText("1 or more shares").className).toContain("sr-only");
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

  it("follows a Notices Try again that ends the share after the view closed and reopened", async () => {
    let rows = [granted()];
    bridgeMock.listSharingAccess.mockImplementation(async ({ lane }) => answer(lane, { rows: lane === "granted" ? rows : [] }));
    bridgeMock.revokeRelayShare.mockRejectedValueOnce(new Error("relay down"));
    const { rerender } = render(<View />);
    const row = await screen.findByTestId("sharing-granted-row");
    await userEvent.click(within(await openMenu(row)).getByRole("menuitem", { name: "End share…" }));
    await userEvent.click(screen.getByTestId("sharing-end"));
    await waitFor(() => expect(shareRemovals.failed).toHaveBeenCalledOnce());

    rerender(<View open={false} />);
    rerender(<View />);
    await waitFor(() => expect(screen.getByTestId("sharing-granted-row").getAttribute("data-status")).toBe("active"));

    // The relay answers this time, and the list now has the share ended.
    rows = [granted({ status: "revoked", selector: null, access: null })];
    bridgeMock.revokeRelayShare.mockResolvedValue({});
    const retry = shareRemovals.failed.mock.calls[0]![0].retry!;
    await act(async () => retry());
    await waitFor(() => expect(screen.getByTestId("sharing-granted-row").getAttribute("data-status")).toBe("revoked"));
    expect(shareRemovals.removed).toHaveBeenCalledOnce();
  });

  it("adds a share sent to the account with its code, then tells the shell", async () => {
    answerWith({ received: answer("received", { rows: [received()] }) });
    bridgeMock.getRelayReceivedShare.mockResolvedValue({ found: true, share: { shareCode: "code-1" } });
    bridgeMock.mountShare.mockResolvedValue({});
    render(<View />);
    const row = await screen.findByTestId("sharing-received-row");
    await userEvent.click(within(await openMenu(row)).getByRole("menuitem", { name: "Add to workspace" }));
    await waitFor(() => expect(callbacks.onMountsChanged).toHaveBeenCalledOnce());
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

  it("ends a share dohc cannot read, so its reverse path stays", async () => {
    answerWith({ granted: answer("granted", { rows: [granted({ status: "damaged", selector: null, access: null })] }) });
    bridgeMock.revokeRelayShare.mockResolvedValue({});
    render(<View />);
    const row = await screen.findByTestId("sharing-granted-row");
    expect(within(row).getByTestId("sharing-row-status").textContent).toBe("Damaged");
    const end = within(await openMenu(row)).getByRole("menuitem", { name: "End share…" });
    // Ending removes access, so it reads in the danger color.
    expect(end.className).toContain("text-danger");
    await userEvent.click(end);
    await userEvent.click(screen.getByTestId("sharing-end"));
    await waitFor(() => expect(bridgeMock.revokeRelayShare).toHaveBeenCalledWith({ shareId: "share-1" }));
  });
});

describe("copying a share's code or invitation", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();
  const reportFailure = vi.fn();
  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    reportFailure.mockReset();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });
  function CopyView(props: { focus?: SharingFocus; open?: boolean; facts?: AccessFacts }) {
    return <ShellErrorReporter.Provider value={reportFailure}><View {...props} /></ShellErrorReporter.Provider>;
  }
  const INVITING = {
    status: "active" as const, shareCode: "dohc-share:share-1:https://relay.test", browserInvitationUrl: "https://drive.test/s/edit/grant-1",
  };
  const ROWS = [
    // A live edit named to one person: the code and the browser invitation.
    granted(),
    // A grant a link depends on: the code only.
    granted({ shareId: "share-dep", grantId: "dep", via: "dependent", access: "view" }),
    // A link, a damaged share and a chat: nothing to copy.
    granted({ shareId: "share-link", grantId: "link", via: "link", recipientEmail: null, recipientUserId: null }),
    granted({ shareId: "share-bad", grantId: "bad", status: "damaged", selector: null, access: null }),
    granted({ shareId: "share-chat", grantId: "chat", selector: { kind: "chat", channelWireId: "wire-1" }, access: "read-write" }),
  ];
  const rowOf = async (shareId: string) =>
    (await screen.findAllByTestId("sharing-granted-row")).find((row) => row.dataset.shareId === shareId)!;

  it("offers a copy only on a live named or dependent row, and an invitation only for one person's live edit", async () => {
    answerWith({ granted: answer("granted", { rows: ROWS }) });
    bridgeMock.getShareCopyDetails.mockResolvedValue(INVITING);
    render(<CopyView />);
    const named = await rowOf("share-1");
    expect(within(named).getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(await within(named).findByRole("button", { name: "Copy invitation" })).toBeTruthy();
    // The server was asked once, for the first row that could have an invitation.
    expect(bridgeMock.getShareCopyDetails).toHaveBeenCalledOnce();
    expect(bridgeMock.getShareCopyDetails).toHaveBeenCalledWith({ shareId: "share-1", grantId: "grant-1" });
    const dependent = await rowOf("share-dep");
    expect(within(dependent).getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(within(dependent).queryByRole("button", { name: "Copy invitation" })).toBeNull();
    for (const shareId of ["share-link", "share-bad", "share-chat"]) {
      expect(within(await rowOf(shareId)).queryByRole("button", { name: /^Copy/ })).toBeNull();
    }
    // The actions sit over the end of the row's last line, so no row changes
    // height; they show on hover, keyboard focus, and while their menu is open.
    const actions = within(named).getByTestId("sharing-granted-actions");
    expect(actions.parentElement).toBe(named.querySelector("[data-sharing-row-focus]"));
    expect(actions.className.split(" ")).toEqual(expect.arrayContaining([
      "absolute", "bottom-0", "opacity-0", "pointer-events-none", "group-hover:opacity-100",
      "keyboard:group-focus-within:opacity-100", "has-[[aria-expanded=true]]:opacity-100",
    ]));
  });


  it("reads the list again for a share that ended since, and reports nothing to fix", async () => {
    answerWith({ granted: answer("granted", { rows: ROWS }) });
    bridgeMock.getShareCopyDetails.mockResolvedValue({ status: "ended" });
    render(<CopyView />);
    const named = await rowOf("share-1");
    const reads = bridgeMock.listSharingAccess.mock.calls.length;
    fireEvent.click(within(named).getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(bridgeMock.listSharingAccess.mock.calls.length).toBeGreaterThan(reads));
    expect(bridgeMock.listSharingAccess).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", lane: "granted" });
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledTimes(2);
    expect(writeText).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("opens on the row Settings search found, focused, then lets go of the request", async () => {
    answerWith({ granted: answer("granted", { rows: ROWS }) });
    render(<CopyView focus={{ lane: "granted", shareId: "share-dep" }} />);
    const dependent = await rowOf("share-dep");
    const target = dependent.querySelector<HTMLElement>("[data-sharing-row-focus]")!;
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(callbacks.onFocused).toHaveBeenCalledOnce();
    // Focus on the row shows its actions to the keyboard.
    await userEvent.tab();
    expect(document.activeElement).toBe(within(dependent).getByRole("button", { name: "Copy code" }));
    // The row was focusable for the jump only: a click no longer selects it.
    expect(target.hasAttribute("tabindex")).toBe(false);
    for (const row of await screen.findAllByTestId("sharing-granted-row")) {
      expect(row.querySelector("[data-sharing-row-focus]")!.hasAttribute("tabindex")).toBe(false);
    }
  });
});

describe("mounts and their skipped changes", () => {
  const GONE: ShareMount = { shareId: "gone-1", label: "notes", granterEmail: "sam@example.com", access: "view" };
  const skippedOps = {
    ops: [{ originId: "origin-sam", originSeq: 4, opKind: "write", code: "share-boundary-violation", detail: "outside", atMs: 1 }],
    more: 0, generation: 2,
  };

  it("keeps a mount removable when the account's list is unknown, without claiming it was removed", async () => {
    answerWith({ received: UNKNOWN("received") });
    render(<View facts={SIGNED_OUT} mounts={[GONE]} />);
    const row = await screen.findByTestId("sharing-received-row");
    expect(row.dataset.status).toBe("unlisted");
    expect(within(row).queryByTestId("sharing-row-status")).toBeNull();
    expect(within(await openMenu(row)).getByRole("menuitem", { name: "Remove from workspace" })).toBeTruthy();
  });

  it("dismisses skipped changes, and shows them again from the row's menu", async () => {
    answerWith({ received: answer("received", { rows: [received()] }) });
    bridgeMock.dismissShareSkips.mockResolvedValue(undefined);
    const mount: ShareMount = { shareId: "in-1", label: "funnel", granterEmail: "sam@example.com", access: "view", skippedOps };
    const { rerender } = render(<View mounts={[mount]} />);
    const row = await screen.findByTestId("sharing-received-row");
    expect(within(row).getAllByTestId("sharing-skipped")).toHaveLength(1);

    // One Dismiss for the mount, named for what it dismisses.
    await userEvent.click(within(row).getByRole("button", { name: "Dismiss skipped changes" }));
    expect(within(row).queryByTestId("sharing-skipped")).toBeNull();
    // Focus lands on the menu that holds the way back.
    expect(document.activeElement).toBe(within(row).getByTestId("sharing-received-menu"));
    expect(bridgeMock.dismissShareSkips).toHaveBeenCalledWith({ workspaceId: "workspace-a", shareId: "in-1", generation: 2 });
    await waitFor(() => expect(callbacks.onMountsChanged).toHaveBeenCalledOnce());

    // The shell reads the record again: seen, and still kept.
    const seen = { ...skippedOps, acknowledgedGeneration: 2 };
    rerender(<View mounts={[{ ...mount, skippedOps: seen }]} />);
    expect(within(row).queryByTestId("sharing-skipped")).toBeNull();
    await userEvent.click(within(await openMenu(row)).getByRole("menuitem", { name: "Show skipped changes" }));
    expect(within(row).getAllByTestId("sharing-skipped")).toHaveLength(1);
  });

  it("brings the lines back and files a failed Dismiss with Try again", async () => {
    answerWith({ received: answer("received", { rows: [received()] }) });
    bridgeMock.dismissShareSkips.mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce(undefined);
    render(<View mounts={[{ shareId: "in-1", label: "funnel", granterEmail: null, access: "view", skippedOps }]} />);
    const row = await screen.findByTestId("sharing-received-row");
    await userEvent.click(within(row).getByTestId("sharing-skipped-dismiss"));
    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
    expect(callbacks.reportError.mock.calls[0]![0]).toBe("dohc could not dismiss the skipped changes.");
    expect(within(row).getAllByTestId("sharing-skipped")).toHaveLength(1);
    act(() => (callbacks.reportError.mock.calls[0]![2] as () => void)());
    await waitFor(() => expect(bridgeMock.dismissShareSkips).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(row).queryByTestId("sharing-skipped")).toBeNull());
  });
});

describe("grouping and waiting changes", () => {
  it("counts waiting changes per share and keeps the oldest", () => {
    const waiting = waitingByShare([
      { proposalId: "b", shareId: "s", proposedByEmail: null, createdAtMs: 5, ops: 1 },
      { proposalId: "a", shareId: "s", proposedByEmail: null, createdAtMs: 1, ops: 1 },
    ]);
    expect(waiting.get("s")).toMatchObject({ count: 2, oldestProposalId: "a" });
  });
});
