// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useReducer, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessAnswer, AccessShareRow } from "@dohc/workspace-contracts/access";
import type { ShareCopyResult } from "@dohc/workspace-contracts/share-copy";
import type { ResendRelayShareInvitationResult, ShareProposalRow } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { automationShareWarning } from "../automationShareCheck";
import { ShellErrorReporter, ShellNoticeClear } from "../shell/useShellError";
import { COPY_FEEDBACK_MS } from "../ui/CopyButton";
import { WorkspaceSessionProvider } from "../workspace/workspaceSession";
import type { AccessFacts } from "./accessReason";
import { SharingView, waitingByShare, type ShareMount, type SharingFocus } from "./SharingView";

type Lane = "granted" | "received";
type AutomationStop = Parameters<typeof automationShareWarning>[0][number];
const bridgeMock = {
  listSharingAccess:
    vi.fn<(input: { workspaceId: string; lane: Lane; cursor?: string }) => Promise<AccessAnswer>>(),
  requestAccessRefresh:
    vi.fn<
      (input: {
        workspaceId: string;
        reason: string;
        wait?: true;
      }) => Promise<{ status: string } | undefined>
    >(),
  revokeRelayShare:
    vi.fn<
      (input: { shareId: string }) => Promise<{ undo?: { undoId: string; expiresAtMs: number } }>
    >(),
  getRelayReceivedShare: vi.fn<(input: { shareId: string }) => Promise<unknown>>(),
  mountShare: vi.fn<(input: { workspaceId: string; shareCode: string }) => Promise<unknown>>(),
  leaveRelayShare:
    vi.fn<(input: { shareId: string; ended: boolean }) => Promise<{ left: boolean }>>(),
  getShareCopyDetails:
    vi.fn<(input: { shareId: string; grantId: string }) => Promise<ShareCopyResult>>(),
  dismissShareSkips:
    vi.fn<(input: { workspaceId: string; shareId: string; generation: number }) => Promise<void>>(),
  automationShareImpact:
    vi.fn<
      (input: {
        workspaceId: string;
        recipientEmail: string | null;
        paths: string[];
        access: "edit";
      }) => Promise<{ stops: AutomationStop[] }>
    >(),
  resendRelayShareInvitation:
    vi.fn<
      (input: {
        workspaceId: string;
        shareId: string;
        grantId: string;
      }) => Promise<ResendRelayShareInvitationResult>
    >(),
  retuneRelayShareGrant:
    vi.fn<
      (input: {
        workspaceId: string;
        shareId: string;
        grantId: string;
        access: string;
      }) => Promise<{ access: "view" | "comment" | "edit"; generation: number }>
    >(),
  revokeRelayShareGrant:
    vi.fn<
      (input: {
        workspaceId: string;
        shareId: string;
        grantId: string;
      }) => Promise<{ undo: { undoId: string; expiresAtMs: number } }>
    >(),
};

const notices = { report: vi.fn(), clear: vi.fn() };
const clearNotice = vi.fn<(identity: string) => void>();
const shareRemovals = { removed: vi.fn(), failed: vi.fn(), agentDisconnected: vi.fn() };
const callbacks = {
  onReviewConflicts: vi.fn(),
  onReviewChanges: vi.fn(),
  onMountsChanged: vi.fn(),
  onOpenMembership: vi.fn(),
  onShowSharing: vi.fn(),
  onFocused: vi.fn(),
  onUnmount: vi.fn(async (_path: string) => undefined),
  reportError: vi.fn(),
  onShare: vi.fn(),
  onOpenShare: vi.fn(),
  openSyncSettings: vi.fn(),
  connect: vi.fn(),
};
const SYNCED: AccessFacts = {
  cloud: { connected: true, workspaceSynced: true, workspaceSyncConnected: true },
  shareView: false,
};
const RECONNECTING: AccessFacts = {
  cloud: { connected: true, workspaceSynced: true, workspaceSyncConnected: false },
  shareView: false,
};
const SIGNED_OUT: AccessFacts = {
  cloud: { connected: false, workspaceSynced: true, workspaceSyncConnected: false },
  shareView: false,
};
const contexts = new Map<
  AccessFacts,
  { facts: AccessFacts; openSyncSettings: () => void; connect: () => void }
>();
function contextFor(facts: AccessFacts) {
  let context = contexts.get(facts);
  if (!context)
    contexts.set(
      facts,
      (context = {
        facts,
        openSyncSettings: callbacks.openSyncSettings,
        connect: callbacks.connect,
      }),
    );
  return context;
}

beforeEach(() => {
  for (const mock of [
    ...Object.values(bridgeMock),
    notices.report,
    notices.clear,
    clearNotice,
    shareRemovals.removed,
    shareRemovals.failed,
    ...Object.values(callbacks),
  ])
    mock.mockReset();
  bridgeMock.requestAccessRefresh.mockResolvedValue(undefined);
  bridgeMock.automationShareImpact.mockResolvedValue({ stops: [] });
  bridgeMock.getShareCopyDetails.mockResolvedValue({
    status: "active",
    shareCode: "dohc-share:share-1:https://relay.test",
  });
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
    ref: null,
    rows: [],
    visibility: "visible",
    unknownReason: null,
    coverage: {
      kind: lane === "granted" ? "granted" : "received-account",
      complete: true,
      observation: "interval",
    },
    checkedAtMs: CHECKED_AT,
    freshness: "fresh",
    nextCursor: null,
    ...overrides,
  };
}
const UNKNOWN = (lane: Lane) =>
  answer(lane, {
    visibility: "unknown",
    unknownReason: "not-listed-yet",
    coverage: { kind: "unavailable", complete: false, observation: "interval" },
    checkedAtMs: null,
    freshness: "unknown",
  });
function granted(overrides: Partial<AccessShareRow> = {}): AccessShareRow {
  return {
    kind: "share",
    shareId: "share-1",
    grantId: "grant-1",
    via: "named",
    granterUserId: "owner",
    granterEmail: "owner@example.com",
    recipientUserId: "sam",
    recipientEmail: "sam@example.com",
    subjectName: null,
    sharerName: null,
    selector: { paths: ["notes/product-plan.md"], versionId: null },
    access: "edit",
    status: "active",
    generation: 1,
    ...overrides,
  };
}
function received(overrides: Partial<AccessShareRow> = {}): AccessShareRow {
  return granted({
    shareId: "in-1",
    grantId: "in-grant-1",
    via: "received",
    granterUserId: "sam-id",
    granterEmail: "sam@example.com",
    sharerName: "Sam",
    recipientUserId: "me",
    recipientEmail: null,
    subjectName: "funnel.csv",
    selector: { paths: ["data/funnel.csv"], versionId: null },
    access: "view",
    ...overrides,
  });
}

function answerWith(answers: Partial<Record<Lane, AccessAnswer | Error>>) {
  bridgeMock.listSharingAccess.mockImplementation(async ({ lane }) => {
    const value = answers[lane] ?? answer(lane);
    if (value instanceof Error) throw value;
    return value;
  });
}

function View(props: {
  workspaceId?: string;
  facts?: AccessFacts;
  shareView?: boolean;
  conflictCount?: number | null;
  proposals?: ShareProposalRow[];
  mounts?: ShareMount[];
  open?: boolean;
  focus?: SharingFocus;
  notSentWhileOpen?: string[];
}) {
  const [sharesRevision, sharesChanged] = useReducer((revision: number) => revision + 1, 0);
  // The shell: showing Sharing on a row sets its focus until the view has used it.
  const [shown, setShown] = useState<SharingFocus | null>(null);
  const showSharing = (target: SharingFocus) => {
    callbacks.onShowSharing(target);
    setShown(target);
  };
  const focused = () => {
    callbacks.onFocused();
    setShown(null);
  };
  const openTaken = () =>
    setShown((focus) => (focus?.open ? { lane: focus.lane, shareId: focus.shareId } : focus));
  const removals = useMemo(
    () => ({
      removed: (removal: Parameters<typeof shareRemovals.removed>[0]) => {
        shareRemovals.removed(removal);
        sharesChanged();
      },
      failed: shareRemovals.failed,
      agentDisconnected: shareRemovals.agentDisconnected,
    }),
    [],
  );
  if (props.open === false) return null;
  return (
    <ShellNoticeClear.Provider value={clearNotice}>
      <WorkspaceSessionProvider workspaceId={props.workspaceId ?? "workspace-a"}>
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
          focus={shown ?? props.focus ?? null}
          onFocused={focused}
          notSentWhileOpen={props.notSentWhileOpen ?? []}
          onOpenMembership={callbacks.onOpenMembership}
          onShowSharing={showSharing}
          onOpenTaken={openTaken}
          onShare={callbacks.onShare}
          onOpenShare={callbacks.onOpenShare}
        />
      </WorkspaceSessionProvider>
    </ShellNoticeClear.Provider>
  );
}

async function openMenu(row: HTMLElement) {
  await userEvent.click(within(row).getByRole("button", { name: "Share actions" }));
  return screen.getByRole("menu");
}

const LANE_NAME = { granted: /^Shared by me/, received: /^Shared with me/ };
async function showLane(lane: Lane) {
  await userEvent.click(await screen.findByRole("radio", { name: LANE_NAME[lane] }));
}

async function openEnded(lane: Lane) {
  const toggle = await screen.findByTestId(`sharing-${lane}-ended-toggle`);
  if (toggle.getAttribute("aria-expanded") !== "true") await userEvent.click(toggle);
}

async function receivedRow(options: { ended?: boolean } = {}) {
  await showLane("received");
  if (options.ended) await openEnded("received");
  return screen.findByTestId("sharing-received-row");
}

async function grantedRow(shareId: string) {
  return (await screen.findAllByTestId("sharing-granted-row")).find((row) =>
    (row.dataset.shareIds ?? "").split(" ").includes(shareId),
  )!;
}

async function people(item: HTMLElement) {
  const toggle = within(item).getByTestId("sharing-item-toggle");
  if (toggle.getAttribute("aria-expanded") !== "true") await userEvent.click(toggle);
  return within(item).getAllByTestId("sharing-person");
}

async function personMenu(person: HTMLElement) {
  await userEvent.click(person.querySelector<HTMLElement>('button[aria-haspopup="menu"]')!);
  return screen.getByRole("menu", { hidden: true });
}

const menuItem = (menu: HTMLElement, name: string | RegExp) =>
  within(menu).getByRole("menuitem", { hidden: true, name });
const menuRows = (menu: HTMLElement) =>
  [...menu.querySelectorAll('[role^="menuitem"]')].map((row) => row.getAttribute("data-testid"));

async function choose(row: HTMLElement, name: string) {
  const shown = within(row).queryByRole("button", { name });
  if (shown) return userEvent.click(shown);
  return userEvent.click(within(await openMenu(row)).getByRole("menuitem", { name }));
}

describe("the Sharing view's two lists", () => {
  it("lists this workspace's shares and the account's, each with its count and who can do what", async () => {
    answerWith({
      granted: answer("granted", {
        rows: [
          granted(),
          granted({ grantId: "grant-2", recipientEmail: "nova@example.com" }),
          granted({
            shareId: "share-2",
            grantId: "grant-3",
            selector: { paths: ["research/competitors.md"], versionId: null },
            access: "view",
          }),
        ],
      }),
      received: answer("received", { rows: [received()] }),
    });
    render(<View />);

    const grantedRows = await screen.findAllByTestId("sharing-granted-row");
    expect(grantedRows).toHaveLength(2);
    expect(grantedRows[0]!.textContent).toBe("competitors.mdsam@example.com can view");
    const [who] = within(grantedRows[0]!).getAllByTestId("sharing-row-who");
    expect([...who!.children].map((part) => [part.textContent, part.className])).toEqual([
      ["sam@example.com", "truncate"],
      [" can view", "shrink-0 whitespace-pre"],
    ]);
    expect(within(grantedRows[1]!).getByTestId("sharing-row-who").className.split(" ")).toEqual(
      expect.arrayContaining(["line-clamp-2", "text-balance"]),
    );
    expect(grantedRows[1]!.textContent).toBe("product-plan.md2 people");
    expect(within(grantedRows[1]!).getByText("product-plan").parentElement!.className).toContain(
      "text-ink",
    );
    expect(within(grantedRows[1]!).getByTestId("sharing-row-who").getAttribute("title")).toBe(
      "sam@example.com can edit\nnova@example.com can edit",
    );
    expect(screen.getByTestId("sharing-granted-count").textContent).toBe("2");
    expect(screen.getByTestId("sharing-received-count").textContent).toBe("1");
    expect(screen.getByTestId("sharing-granted-freshness").getAttribute("data-state")).toBe(
      "fresh",
    );
    expect(screen.getByTestId("sharing-granted-freshness-scope").textContent).toBe(
      "for this workspace",
    );
    const row = await receivedRow();
    expect(within(row).getByText("funnel").parentElement!.className).toContain("text-ink");
    expect(within(row).getByTestId("sharing-row-level").textContent).toBe("Can view");
    expect(screen.getByTestId("sharing-received-freshness-scope").textContent).toBe(
      "for your account",
    );
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledTimes(1);
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      reason: "sharing-open",
    });
  });

  it("notes on a live share the new notes it covers that the server has no file for yet", async () => {
    answerWith({
      granted: answer("granted", {
        rows: [
          granted(),
          granted({
            shareId: "share-2",
            grantId: "grant-2",
            selector: { paths: ["research/competitors.md"], versionId: null },
          }),
          granted({
            shareId: "share-3",
            grantId: "grant-3",
            status: "revoked",
            selector: { paths: ["notes/old.md"], versionId: null },
          }),
          granted({
            shareId: "share-4",
            grantId: "grant-4",
            selector: { paths: ["notes/product-plan.md"], versionId: "version-1" },
          }),
        ],
      }),
    });
    render(<View notSentWhileOpen={["notes/old.md", "notes/product-plan.md"]} />);
    await openEnded("granted");
    const rows = await screen.findAllByTestId("sharing-granted-row");
    const note = (shareId: string) =>
      within(rows.find((row) => row.dataset.shareId === shareId)!).queryByTestId("sharing-row-note")
        ?.textContent ?? null;
    expect(note("share-1")).toBe(
      "This note has not been sent yet. Leave it or close its tab to send it.",
    );
    expect(note("share-2")).toBeNull();
    // An ended share has no link left to show the note.
    expect(note("share-3")).toBeNull();
    // The read names notes by path only, and a share of a version sends from that version.
    expect(note("share-4")).toBeNull();
  });

  it("files a failed read in Notices and reads again from Try again", async () => {
    answerWith({ received: new Error("offline") });
    render(<View />);
    await showLane("received");
    const failed = await screen.findByTestId("sharing-received-failed");
    expect(failed.querySelector("p")!.textContent).toBe(
      "dohc could not check shares to your account.",
    );
    expect(notices.report).toHaveBeenCalledWith(
      expect.objectContaining({ identity: "sharing-received" }),
    );
    answerWith({ received: answer("received", { rows: [received()] }) });
    await userEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("sharing-received-row")).toBeTruthy();
    expect(notices.clear).toHaveBeenCalledWith("sharing-received");
  });

  it("pages with the list's cursor and keeps the rows it has", async () => {
    bridgeMock.listSharingAccess.mockImplementation(async ({ lane, cursor }) =>
      lane === "received"
        ? answer("received")
        : cursor === "page-2"
          ? answer("granted", {
              rows: [
                granted({
                  shareId: "share-2",
                  grantId: "grant-2",
                  selector: { paths: ["research/competitors.md"], versionId: null },
                }),
              ],
            })
          : answer("granted", { rows: [granted()], nextCursor: "page-2" }),
    );
    render(<View />);
    const count = await screen.findByTestId("sharing-granted-count");
    expect(within(count).getByText("1+").getAttribute("aria-hidden")).toBe("true");
    expect(within(count).getByText("1 or more shares").className).toContain("sr-only");
    await userEvent.click(screen.getByTestId("sharing-granted-more"));
    await waitFor(() => expect(screen.getAllByTestId("sharing-granted-row")).toHaveLength(2));
    expect(bridgeMock.listSharingAccess).toHaveBeenLastCalledWith({
      workspaceId: "workspace-a",
      lane: "granted",
      cursor: "page-2",
    });
    expect(screen.queryByTestId("sharing-granted-more")).toBeNull();
  });

  it("keeps an earlier page's out-of-date mark after the next page reads fresh", async () => {
    bridgeMock.listSharingAccess.mockImplementation(async ({ lane, cursor }) =>
      lane === "received"
        ? answer("received")
        : cursor === "page-2"
          ? answer("granted", {
              rows: [
                granted({
                  shareId: "share-2",
                  grantId: "grant-2",
                  selector: { paths: ["research/competitors.md"], versionId: null },
                }),
              ],
            })
          : answer("granted", { rows: [granted()], nextCursor: "page-2", freshness: "stale" }),
    );
    render(<View />);
    await userEvent.click(await screen.findByTestId("sharing-granted-more"));
    await waitFor(() => expect(screen.getAllByTestId("sharing-granted-row")).toHaveLength(2));
    expect(screen.getByTestId("sharing-granted-freshness").getAttribute("data-state")).toBe(
      "stale",
    );
  });

  it("keeps what is loaded when Show more fails, and loads the same page from Try again", async () => {
    let offline = true;
    bridgeMock.listSharingAccess.mockImplementation(async ({ lane, cursor }) => {
      if (lane === "received") return answer("received");
      if (cursor !== "page-2")
        return answer("granted", {
          rows: [
            granted(),
            granted({
              shareId: "share-2",
              grantId: "grant-2",
              status: "revoked",
              subjectName: "budget.csv",
              selector: null,
              access: null,
            }),
          ],
          nextCursor: "page-2",
        });
      if (offline) throw new Error("offline");
      return answer("granted", {
        rows: [
          granted({
            shareId: "share-2",
            grantId: "grant-3",
            recipientUserId: "nova",
            recipientEmail: "nova@example.com",
            subjectName: "budget.csv",
            selector: { paths: ["budget.csv"], versionId: null },
          }),
        ],
      });
    });
    render(<View />);
    await grantedRow("share-1");
    await userEvent.click(screen.getByTestId("sharing-granted-more"));

    const failed = await screen.findByTestId("sharing-granted-more-failed");
    expect(failed.querySelector("p")!.textContent).toBe(
      "dohc could not load more shares from this workspace.",
    );
    expect(screen.queryByTestId("sharing-granted-failed")).toBeNull();
    expect(screen.queryByTestId("sharing-granted-more")).toBeNull();
    expect(screen.getAllByTestId("sharing-granted-row")).toHaveLength(2);
    expect((await grantedRow("share-1")).dataset.status).toBe("active");
    expect((await grantedRow("share-2")).dataset.status).toBe("unconfirmed");
    expect(notices.report).toHaveBeenCalledWith(
      expect.objectContaining({ identity: "sharing-granted" }),
    );

    offline = false;
    const reads = bridgeMock.listSharingAccess.mock.calls.length;
    await userEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("sharing-granted-count").textContent).toBe("2"));
    expect(bridgeMock.listSharingAccess.mock.calls.slice(reads)).toEqual([
      [{ workspaceId: "workspace-a", lane: "granted", cursor: "page-2" }],
    ]);
    expect((await grantedRow("share-2")).dataset.status).toBe("active");
    expect(screen.queryByTestId("sharing-granted-more-failed")).toBeNull();
    expect(notices.clear).toHaveBeenCalledWith("sharing-granted");
  });

  it("never paints a slow answer for one workspace into another", async () => {
    const slow = deferred<AccessAnswer>();
    bridgeMock.listSharingAccess.mockImplementation(async ({ workspaceId, lane }) =>
      workspaceId === "workspace-a" && lane === "granted"
        ? slow.promise
        : answer(lane, {
            rows:
              workspaceId === "workspace-b" && lane === "granted"
                ? [granted({ shareId: "share-b", selector: { paths: ["b.md"], versionId: null } })]
                : [],
          }),
    );
    const { rerender } = render(<View workspaceId="workspace-a" />);
    await waitFor(() =>
      expect(bridgeMock.listSharingAccess).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        lane: "granted",
      }),
    );
    rerender(<View workspaceId="workspace-b" />);
    const row = await screen.findByTestId("sharing-granted-row");
    slow.resolve(
      answer("granted", {
        rows: [granted({ shareId: "share-a", selector: { paths: ["a.md"], versionId: null } })],
      }),
    );
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
    expect(bridgeMock.listSharingAccess).not.toHaveBeenCalledWith(
      expect.objectContaining({ lane: "granted" }),
    );
  });
});

describe("the actions Settings offers on a share", () => {
  it("ends a share after it asks, then reports the removal with its Undo and reads again", async () => {
    answerWith({ granted: answer("granted", { rows: [granted()] }) });
    const undo = { undoId: "undo-1", expiresAtMs: Date.now() + 600_000 };
    bridgeMock.revokeRelayShare.mockResolvedValue({ undo });
    render(<View />);
    const row = await screen.findByTestId("sharing-granted-row");
    await userEvent.click(
      within(await openMenu(row)).getByRole("menuitem", { hidden: true, name: "End share…" }),
    );
    const confirm = screen.getByTestId("sharing-end-confirm");
    expect(confirm.textContent).toContain(
      "End this share with 1 person? Updates stop for sam@example.com, and their copy stays read-only.",
    );
    expect(document.activeElement).toBe(screen.getByTestId("sharing-end-cancel"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("sharing-end-confirm")).toBeNull();
    expect(bridgeMock.revokeRelayShare).not.toHaveBeenCalled();
    const opener = within(row).getByRole("button", { name: "Share actions" });
    expect(document.activeElement).toBe(opener);

    await userEvent.click(
      within(await openMenu(row)).getByRole("menuitem", { hidden: true, name: "End share…" }),
    );
    await userEvent.click(screen.getByTestId("sharing-end-cancel"));
    expect(screen.queryByTestId("sharing-end-confirm")).toBeNull();
    expect(document.activeElement).toBe(opener);

    await userEvent.click(
      within(await openMenu(row)).getByRole("menuitem", { hidden: true, name: "End share…" }),
    );
    await userEvent.click(screen.getByTestId("sharing-end"));
    await waitFor(() => expect(shareRemovals.removed).toHaveBeenCalledOnce());
    expect(bridgeMock.revokeRelayShare).toHaveBeenCalledWith({ shareId: "share-1" });
    expect(shareRemovals.removed).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-a",
        shareId: "share-1",
        undo,
        message: "Ended the share of notes/product-plan.md with sam@example.com.",
        restoredMessage: "Restored the share of notes/product-plan.md with sam@example.com.",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("sharing-end-confirm")).toBeNull());
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledTimes(2);
  });

  it("follows a Notices Try again that ends the share after the view closed and reopened", async () => {
    let rows = [granted()];
    bridgeMock.listSharingAccess.mockImplementation(async ({ lane }) =>
      answer(lane, { rows: lane === "granted" ? rows : [] }),
    );
    bridgeMock.revokeRelayShare.mockRejectedValueOnce(new Error("relay down"));
    const { rerender } = render(<View />);
    const row = await screen.findByTestId("sharing-granted-row");
    await userEvent.click(
      within(await openMenu(row)).getByRole("menuitem", { hidden: true, name: "End share…" }),
    );
    await userEvent.click(screen.getByTestId("sharing-end"));
    await waitFor(() => expect(shareRemovals.failed).toHaveBeenCalledOnce());

    rerender(<View open={false} />);
    rerender(<View />);
    await waitFor(() =>
      expect(screen.getByTestId("sharing-granted-row").getAttribute("data-status")).toBe("active"),
    );

    rows = [granted({ status: "revoked", selector: null, access: null })];
    bridgeMock.revokeRelayShare.mockResolvedValue({});
    const retry = shareRemovals.failed.mock.calls[0]![0].retry!;
    await act(async () => retry());
    await openEnded("granted");
    await waitFor(() =>
      expect(screen.getByTestId("sharing-granted-row").getAttribute("data-status")).toBe("revoked"),
    );
    expect(shareRemovals.removed).toHaveBeenCalledOnce();
  });

  it("adds a share sent to the account with its code, then tells the shell", async () => {
    answerWith({ received: answer("received", { rows: [received()] }) });
    bridgeMock.getRelayReceivedShare.mockResolvedValue({
      found: true,
      share: { shareCode: "code-1" },
    });
    bridgeMock.mountShare.mockResolvedValue({});
    render(<View />);
    const row = await receivedRow();
    await choose(row, "Add to workspace");
    await waitFor(() => expect(callbacks.onMountsChanged).toHaveBeenCalledOnce());
    expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledWith({ shareId: "in-1" });
    expect(bridgeMock.mountShare).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      shareCode: "code-1",
    });
  });

  it("shows a workspace the account joined by its name and role, and opens it", async () => {
    answerWith({
      received: answer("received", {
        rows: [
          received({
            shareId: "member",
            subjectName: "Community",
            selector: { kind: "workspace", role: "member" },
            access: "comment",
            granterEmail: null,
          }),
          received({
            shareId: "admin",
            grantId: "admin",
            subjectName: "Garden club",
            selector: { kind: "workspace", role: "admin" },
            access: "comment",
            granterEmail: null,
          }),
        ],
      }),
    });
    render(<View />);
    await showLane("received");
    const [member, admin] = await screen.findAllByTestId("sharing-received-row");
    expect(within(member!).getByText("Community")).toBeTruthy();
    expect(within(member!).getByTestId("sharing-row-who").textContent).toBe(
      "Member · Sam lets members comment",
    );
    expect(within(admin!).getByTestId("sharing-row-who").textContent).toBe(
      "Admin · Sam owns this workspace",
    );
    expect(member!.textContent).not.toContain("@");
    const share = {
      shareId: "member",
      shareCode: "code-member",
      selector: { kind: "workspace", role: "member" },
      access: "comment",
    };
    bridgeMock.getRelayReceivedShare.mockResolvedValue({ found: true, share });
    const open = within(await openMenu(member!)).getByRole("menuitem", { name: "Open" });
    expect(open.getAttribute("aria-disabled")).not.toBe("true");
    await userEvent.click(open);
    // The shell asks for a folder: Open hands it the share the relay states now.
    await waitFor(() => expect(callbacks.onOpenMembership).toHaveBeenCalledWith(share));
    expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledWith({ shareId: "member" });
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
  });

  it("reports a membership that ended before Open, with Try again", async () => {
    answerWith({
      received: answer("received", {
        rows: [
          received({
            shareId: "member",
            subjectName: "Community",
            selector: { kind: "workspace", role: "member" },
            access: "comment",
          }),
        ],
      }),
    });
    bridgeMock.getRelayReceivedShare.mockResolvedValue({
      found: false,
      removed: { message: "The owner removed your access." },
    });
    render(<View />);
    const row = await receivedRow();
    await userEvent.click(within(await openMenu(row)).getByRole("menuitem", { name: "Open" }));
    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
    expect(callbacks.reportError.mock.calls[0]![0]).toBe("dohc could not open Community.");
    expect((callbacks.reportError.mock.calls[0]![1] as Error).message).toBe(
      "The owner removed your access.",
    );
    expect(callbacks.onOpenMembership).not.toHaveBeenCalled();
    const share = { shareId: "member", shareCode: "member-code" };
    bridgeMock.getRelayReceivedShare.mockResolvedValue({ found: true, share });
    act(() => callbacks.reportError.mock.calls[0]![2]());
    await waitFor(() => expect(callbacks.onOpenMembership).toHaveBeenCalledWith(share));
  });

  it("shows Sharing again and opens the share when Try again comes after Sharing closed", async () => {
    answerWith({
      received: answer("received", {
        rows: [
          received({
            shareId: "member",
            subjectName: "Community",
            selector: { kind: "workspace", role: "member" },
          }),
        ],
      }),
    });
    bridgeMock.getRelayReceivedShare.mockRejectedValueOnce(new Error("The server is unavailable."));
    const { rerender } = render(<View />);
    const row = await receivedRow();
    await userEvent.click(within(await openMenu(row)).getByRole("menuitem", { name: "Open" }));
    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
    // The side panel shows another view; the Notices row keeps Try again.
    rerender(<View open={false} />);
    const share = { shareId: "member", shareCode: "member-code" };
    bridgeMock.getRelayReceivedShare.mockResolvedValue({ found: true, share });
    act(() => callbacks.reportError.mock.calls[0]![2]());
    expect(callbacks.onShowSharing).toHaveBeenCalledOnce();
    rerender(<View />);
    await waitFor(() => expect(callbacks.onOpenMembership).toHaveBeenCalledWith(share));
    expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledTimes(2);
  });

  it("opens a Try again's share once, even when Sharing closes before its list answers", async () => {
    answerWith({
      received: answer("received", {
        rows: [
          received({
            shareId: "member",
            subjectName: "Community",
            selector: { kind: "workspace", role: "member" },
          }),
        ],
      }),
    });
    bridgeMock.getRelayReceivedShare.mockRejectedValueOnce(new Error("The server is unavailable."));
    const { rerender } = render(<View />);
    const row = await receivedRow();
    await userEvent.click(within(await openMenu(row)).getByRole("menuitem", { name: "Open" }));
    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
    rerender(<View open={false} />);
    const share = { shareId: "member", shareCode: "member-code" };
    bridgeMock.listSharingAccess.mockReturnValue(deferred<AccessAnswer>().promise);
    bridgeMock.getRelayReceivedShare.mockResolvedValue({ found: true, share });
    act(() => callbacks.reportError.mock.calls[0]![2]());
    rerender(<View />);
    await waitFor(() => expect(callbacks.onOpenMembership).toHaveBeenCalledOnce());
    // The list never answered, so the focus is still waiting to scroll.
    rerender(<View open={false} />);
    rerender(<View />);
    await act(async () => {});
    expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledTimes(2);
    expect(callbacks.onOpenMembership).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"])(
    "drops a late membership Open %s after switching workspaces",
    async (outcome) => {
      answerWith({
        received: answer("received", {
          rows: [
            received({
              shareId: "member",
              subjectName: "Community",
              selector: { kind: "workspace", role: "member" },
            }),
          ],
        }),
      });
      const pending = deferred<unknown>();
      bridgeMock.getRelayReceivedShare.mockReturnValueOnce(pending.promise);
      const { rerender } = render(<View />);
      const row = await receivedRow();
      await userEvent.click(within(await openMenu(row)).getByRole("menuitem", { name: "Open" }));
      rerender(<View workspaceId="workspace-b" />);
      await act(async () => {
        if (outcome === "success")
          pending.resolve({ found: true, share: { shareId: "member", shareCode: "member-code" } });
        else pending.reject(new Error("Workspace A is unavailable."));
      });
      expect(callbacks.onOpenMembership).not.toHaveBeenCalled();
      expect(callbacks.reportError).not.toHaveBeenCalled();
    },
  );

  it("reports a share that could not be added, with Try again", async () => {
    answerWith({ received: answer("received", { rows: [received()] }) });
    bridgeMock.getRelayReceivedShare.mockResolvedValue({
      found: true,
      share: { shareCode: "code-1" },
    });
    bridgeMock.mountShare.mockRejectedValueOnce(new Error("disk full"));
    bridgeMock.mountShare.mockResolvedValue({});
    render(<View />);
    const row = await receivedRow();
    const reads = bridgeMock.listSharingAccess.mock.calls.length;
    await choose(row, "Add to workspace");
    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
    expect(callbacks.reportError.mock.calls[0]![0]).toBe(
      "dohc could not add this share to the workspace.",
    );
    expect(bridgeMock.listSharingAccess.mock.calls).toHaveLength(reads);
    await act(async () => callbacks.reportError.mock.calls[0]![2]());
    await waitFor(() => expect(callbacks.onMountsChanged).toHaveBeenCalledOnce());
  });

  it("says a share the owner removed is no longer shared with you when it is added, and reads the list again", async () => {
    let rows = [
      received(),
      received({
        shareId: "in-2",
        grantId: "in-grant-2",
        subjectName: "roadmap.md",
        selector: { paths: ["notes/roadmap.md"], versionId: null },
      }),
    ];
    bridgeMock.listSharingAccess.mockImplementation(async ({ lane }) =>
      answer(lane, { rows: lane === "received" ? rows : [] }),
    );
    bridgeMock.getRelayReceivedShare
      .mockResolvedValueOnce({ found: false, removed: { message: "Sam stopped sharing this." } })
      .mockResolvedValueOnce({ found: false });
    render(<View />);
    await showLane("received");
    const byShare = async (shareId: string) =>
      (await screen.findAllByTestId("sharing-received-row")).find(
        (row) => row.dataset.shareId === shareId,
      )!;
    const gone = await byShare("in-1");
    rows = [rows[1]!];
    await choose(gone, "Add to workspace");
    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
    expect(callbacks.reportError.mock.calls[0]![0]).toBe("Sam stopped sharing this.");
    await waitFor(() =>
      expect(
        screen.getAllByTestId("sharing-received-row").map((row) => row.dataset.shareId),
      ).toEqual(["in-2"]),
    );
    expect(bridgeMock.listSharingAccess).toHaveBeenLastCalledWith({
      workspaceId: "workspace-a",
      lane: "received",
    });

    await choose(await byShare("in-2"), "Add to workspace");
    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledTimes(2));
    expect(callbacks.reportError.mock.calls[1]![0]).toBe("This item is no longer shared with you.");
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
  });

  it("leaves a share after a confirm, and reads the list again", async () => {
    answerWith({ received: answer("received", { rows: [received()] }) });
    bridgeMock.leaveRelayShare.mockResolvedValue({ left: true });
    render(<View />);
    const row = await receivedRow();
    await choose(row, "Leave share…");
    expect(bridgeMock.leaveRelayShare).not.toHaveBeenCalled();
    const confirm = within(row).getByTestId("sharing-leave-confirm");
    expect(confirm.textContent).toContain(
      "You lose access to funnel.csv. To regain access, ask Sam to share it again.",
    );
    expect(document.activeElement).toBe(within(confirm).getByTestId("sharing-leave-cancel"));

    answerWith({ received: answer("received", { rows: [] }) });
    await userEvent.click(within(confirm).getByTestId("sharing-leave"));

    await waitFor(() => expect(screen.queryByTestId("sharing-received-row")).toBeNull());
    expect(bridgeMock.leaveRelayShare).toHaveBeenCalledExactlyOnceWith({
      shareId: "in-1",
      ended: false,
    });
    expect(callbacks.onUnmount).not.toHaveBeenCalled();
    expect(callbacks.reportError).not.toHaveBeenCalled();
  });

  it("leaves first, then takes the share's folder out of the workspace", async () => {
    answerWith({ received: answer("received", { rows: [received()] }) });
    const order: string[] = [];
    callbacks.onUnmount.mockImplementation(async () => {
      order.push("unmount");
    });
    bridgeMock.leaveRelayShare.mockImplementation(async () => {
      order.push("leave");
      return { left: true };
    });
    const mount: ShareMount = {
      shareId: "in-1",
      label: "funnel",
      granterEmail: "sam@example.com",
      access: "view",
    };
    render(<View mounts={[mount]} />);
    const row = await receivedRow();
    await choose(row, "Leave share…");
    expect(within(row).getByTestId("sharing-leave-confirm").textContent).toContain(
      "its folder leaves this workspace",
    );
    await userEvent.click(within(row).getByTestId("sharing-leave"));

    await waitFor(() => expect(order).toEqual(["leave", "unmount"]));
    expect(callbacks.onUnmount).toHaveBeenCalledWith("shared-with-me/funnel");
  });

  it("takes a share the owner ended off the list, and reports a failure with Try again", async () => {
    answerWith({
      received: answer("received", {
        rows: [received({ status: "removed", selector: null, access: null })],
      }),
    });
    bridgeMock.leaveRelayShare.mockRejectedValueOnce(new Error("offline"));
    bridgeMock.leaveRelayShare.mockResolvedValue({ left: true });
    render(<View />);
    const row = await receivedRow({ ended: true });
    expect(row.dataset.status).toBe("removed");
    expect(within(row).queryByRole("button", { name: "Share actions" })).toBeNull();
    await choose(row, "Remove from list");

    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
    expect(callbacks.reportError.mock.calls[0]![0]).toBe(
      "dohc could not remove this share from your list.",
    );
    answerWith({ received: answer("received", { rows: [] }) });
    await act(async () => callbacks.reportError.mock.calls[0]![2]());
    await waitFor(() => expect(screen.queryByTestId("sharing-received-row")).toBeNull());
    expect(bridgeMock.leaveRelayShare).toHaveBeenCalledTimes(2);
    expect(bridgeMock.leaveRelayShare).toHaveBeenLastCalledWith({ shareId: "in-1", ended: true });
  });

  it("takes an ended share's folder and its row away in one step", async () => {
    answerWith({
      received: answer("received", {
        rows: [received({ status: "removed", selector: null, access: null })],
      }),
    });
    bridgeMock.leaveRelayShare.mockResolvedValue({ left: true });
    const mount: ShareMount = {
      shareId: "in-1",
      label: "funnel",
      granterEmail: "sam@example.com",
      access: "view",
      ended: true,
    };
    render(<View mounts={[mount]} />);
    const row = await receivedRow({ ended: true });
    await choose(row, "Remove from workspace");

    await waitFor(() =>
      expect(callbacks.onUnmount).toHaveBeenCalledExactlyOnceWith("shared-with-me/funnel"),
    );
    expect(bridgeMock.leaveRelayShare).toHaveBeenCalledExactlyOnceWith({
      shareId: "in-1",
      ended: true,
    });
  });

  it("leaves access the owner restored alone when a stale row is cleared", async () => {
    answerWith({
      received: answer("received", {
        rows: [received({ status: "removed", selector: null, access: null })],
      }),
    });
    bridgeMock.leaveRelayShare.mockResolvedValue({ left: false });
    const mount: ShareMount = {
      shareId: "in-1",
      label: "funnel",
      granterEmail: "sam@example.com",
      access: "view",
    };
    render(<View mounts={[mount]} />);
    const row = await receivedRow({ ended: true });
    answerWith({ received: answer("received", { rows: [received()] }) });
    await choose(row, "Remove from workspace");

    await waitFor(() =>
      expect(screen.getByTestId("sharing-received-row").dataset.status).toBe("active"),
    );
    expect(callbacks.onUnmount).toHaveBeenCalledExactlyOnceWith("shared-with-me/funnel");
    expect(callbacks.reportError).not.toHaveBeenCalled();
  });

  it("removes an ended share's folder even when the server cannot be reached", async () => {
    answerWith({
      received: answer("received", {
        rows: [received({ status: "removed", selector: null, access: null })],
      }),
    });
    bridgeMock.leaveRelayShare.mockRejectedValue(new Error("offline"));
    const mount: ShareMount = {
      shareId: "in-1",
      label: "funnel",
      granterEmail: "sam@example.com",
      access: "view",
      ended: true,
    };
    render(<View mounts={[mount]} />);
    const row = await receivedRow({ ended: true });
    await choose(row, "Remove from workspace");

    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
    expect(callbacks.onUnmount).toHaveBeenCalledExactlyOnceWith("shared-with-me/funnel");
    await act(async () => callbacks.reportError.mock.calls[0]![2]());
    expect(callbacks.onUnmount).toHaveBeenCalledOnce();
    expect(bridgeMock.leaveRelayShare).toHaveBeenCalledTimes(2);
  });

  it("ends a share dohc cannot read, so its reverse path stays", async () => {
    answerWith({
      granted: answer("granted", {
        rows: [granted({ status: "damaged", selector: null, access: null })],
      }),
    });
    bridgeMock.revokeRelayShare.mockResolvedValue({});
    render(<View />);
    await openEnded("granted");
    const row = await screen.findByTestId("sharing-granted-row");
    expect(within(row).getByTestId("sharing-row-status").textContent).toBe("Damaged");
    const end = within(await openMenu(row)).getByRole("menuitem", {
      hidden: true,
      name: "End share…",
    });
    expect(end.className).toContain("text-danger");
    await userEvent.click(end);
    await userEvent.click(screen.getByTestId("sharing-end"));
    await waitFor(() =>
      expect(bridgeMock.revokeRelayShare).toHaveBeenCalledWith({ shareId: "share-1" }),
    );
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
    return (
      <ShellErrorReporter.Provider value={reportFailure}>
        <View {...props} />
      </ShellErrorReporter.Provider>
    );
  }
  const INVITING = {
    status: "active" as const,
    shareCode: "dohc-share:share-1:https://relay.test",
    browserInvitationUrl: "https://drive.test/s/edit/grant-1",
  };
  const ROWS = [
    granted(),
    granted({ shareId: "share-dep", grantId: "dep", via: "dependent", access: "view" }),
    granted({
      shareId: "share-link",
      grantId: "link",
      via: "link",
      recipientEmail: null,
      recipientUserId: null,
    }),
    granted({
      shareId: "share-bad",
      grantId: "bad",
      status: "damaged",
      selector: null,
      access: null,
    }),
    granted({
      shareId: "share-chat",
      grantId: "chat",
      selector: { kind: "chat", channelWireId: "wire-1" },
      access: "read-write",
    }),
  ];
  const rowOf = grantedRow;

  it("offers a person's invitation or code from their one menu, and nothing for a link or a chat", async () => {
    answerWith({ granted: answer("granted", { rows: ROWS }) });
    bridgeMock.getShareCopyDetails.mockResolvedValue(INVITING);
    render(<CopyView />);
    const item = await rowOf("share-1");
    const [named, dependent] = await people(item);
    await waitFor(() => expect(bridgeMock.getShareCopyDetails).toHaveBeenCalledOnce());
    expect(bridgeMock.getShareCopyDetails).toHaveBeenCalledWith({
      shareId: "share-1",
      grantId: "grant-1",
    });
    expect(named!.querySelectorAll("button")).toHaveLength(1);
    await userEvent.click(menuItem(await personMenu(named!), "Copy invitation"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(INVITING.browserInvitationUrl));
    expect(screen.queryByRole("menu", { hidden: true })).toBeNull();
    await waitFor(() =>
      expect(within(named!).getByTestId("sharing-person-detail").textContent).toBe(
        "Invitation copied",
      ),
    );

    expect(dependent!.querySelectorAll("button")).toHaveLength(1);
    expect(within(dependent!).getByTestId("sharing-person-level").textContent).toBe("Can view");
    await userEvent.click(menuItem(await personMenu(dependent!), "Copy code"));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(INVITING.shareCode));
    await waitFor(() =>
      expect(within(dependent!).getByTestId("sharing-person-detail").textContent).toBe(
        "Share code copied",
      ),
    );

    expect(within(item).getByTestId("sharing-link").textContent).toBe(
      "Anyone with the linkCan edit",
    );
    expect(within(item).getByTestId("sharing-link").querySelector("button")).toBeNull();
    const [member] = await people(await rowOf("share-chat"));
    expect(member!.querySelector("button")).toBeNull();
    const actions = within(item).getByTestId("sharing-granted-actions");
    expect(actions.parentElement).toBe(
      within(item).getByTestId("sharing-item-toggle").parentElement,
    );
    expect(actions.className.split(" ")).not.toContain("absolute");
  });

  it("offers Resend invitation under Copy invitation to a person invited by email, and not to one who joined through a link", async () => {
    answerWith({
      granted: answer("granted", {
        rows: [
          ...ROWS,
          granted({
            shareId: "share-new",
            grantId: "new",
            recipientUserId: null,
            recipientEmail: "new@example.com",
          }),
        ],
      }),
    });
    bridgeMock.getShareCopyDetails.mockResolvedValue(INVITING);
    render(<CopyView />);
    const [named, dependent, pending] = await people(await rowOf("share-1"));
    const offered = async (person: HTMLElement) => {
      const names = within(await personMenu(person))
        .getAllByRole("menuitem", { hidden: true })
        .map((row) => row.textContent);
      await userEvent.keyboard("{Escape}");
      return names;
    };

    expect(within(named!).getByTestId("sharing-person-detail").textContent).toBe(
      "Invited by email",
    );
    expect(await offered(named!)).toEqual([
      "Copy invitation",
      "Resend invitation",
      "Copy share code",
      "Remove access",
    ]);
    expect(within(pending!).getByTestId("sharing-person-detail").textContent).toBe(
      "Pending invite",
    );
    expect(await offered(pending!)).toContain("Resend invitation");
    expect(within(dependent!).getByTestId("sharing-person-detail").textContent).toBe(
      "Joined through a link",
    );
    expect(await offered(dependent!)).toEqual(["Copy code", "Remove access"]);
    expect(bridgeMock.resendRelayShareInvitation).not.toHaveBeenCalled();
  });

  it("resends an invitation once, cannot be picked again while it is sent, and says each answer on the person's second line", async () => {
    answerWith({ granted: answer("granted", { rows: [granted()] }) });
    let sent: (answer: ResendRelayShareInvitationResult) => void = () => undefined;
    bridgeMock.resendRelayShareInvitation.mockReturnValueOnce(
      new Promise((resolve) => {
        sent = resolve;
      }),
    );
    render(<CopyView />);
    const [person] = await people(await rowOf("share-1"));
    const detail = within(person!).getByTestId("sharing-person-detail");

    await userEvent.click(menuItem(await personMenu(person!), "Resend invitation"));
    expect(bridgeMock.resendRelayShareInvitation).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace-a",
      shareId: "share-1",
      grantId: "grant-1",
    });
    expect(screen.queryByRole("menu", { hidden: true })).toBeNull();
    expect(detail.textContent).toBe("Sending email…");

    const held = menuItem(await personMenu(person!), /^Resend invitation/);
    expect(held.getAttribute("aria-disabled")).toBe("true");
    expect(held.textContent).toBe("Resend invitationdohc is sending the email.");
    await userEvent.click(held);
    await userEvent.keyboard("{Escape}");
    expect(bridgeMock.resendRelayShareInvitation).toHaveBeenCalledOnce();
    expect(within(person!).getByTestId("sharing-person-access-grant-1")).toHaveProperty(
      "disabled",
      false,
    );

    await act(async () => sent({ invitationEmail: "sent" }));
    expect(detail.textContent).toBe("Email invitation sent.");
    expect(within(person!).getByRole("status").textContent).toBe("Email invitation sent.");

    const limited = {
      invitationEmail: "limit" as const,
      invitationEmailLimit: { limit: 50, windowHours: 24, sent: 50 },
    };
    for (const [next, words] of [
      [{ invitationEmail: "unavailable" }, "This server does not send email."],
      [limited, "No email sent: 50 of 50 invitation emails used in the last 24 hours."],
      [{ invitationEmail: "recent" }, "Sent recently. Wait a minute before trying again."],
    ] as const) {
      bridgeMock.resendRelayShareInvitation.mockResolvedValueOnce(next);
      await userEvent.click(menuItem(await personMenu(person!), "Resend invitation"));
      await waitFor(() => expect(detail.textContent).toBe(words));
    }
    expect(bridgeMock.resendRelayShareInvitation).toHaveBeenCalledTimes(4);
    expect(reportFailure).not.toHaveBeenCalled();

    await userEvent.click(menuItem(await personMenu(person!), "Copy invitation"));
    await waitFor(() => expect(detail.textContent).toBe("Invitation copied"));
    await waitFor(() => expect(detail.textContent).toBe("Invited by email"), {
      timeout: 2 * COPY_FEEDBACK_MS,
    });
  });

  it("says a resend failed on the person's second line and to the shell, and shows a Try again from Notices on the row while it sends", async () => {
    answerWith({ granted: answer("granted", { rows: [granted()] }) });
    bridgeMock.resendRelayShareInvitation.mockResolvedValueOnce({ invitationEmail: "failed" });
    render(<CopyView />);
    const [person] = await people(await rowOf("share-1"));
    const detail = within(person!).getByTestId("sharing-person-detail");

    await userEvent.click(menuItem(await personMenu(person!), "Resend invitation"));
    await waitFor(() =>
      expect(reportFailure).toHaveBeenCalledExactlyOnceWith({
        message: "dohc could not email sam@example.com their invitation.",
        cause: undefined,
        identity: "share-invitation-email:grant-1",
        retry: expect.any(Function),
      }),
    );
    expect(detail.textContent).toBe("dohc could not send the email.");
    expect(detail.querySelector(".text-danger")).not.toBeNull();
    expect(clearNotice).not.toHaveBeenCalled();

    const down = new Error("relay down");
    bridgeMock.resendRelayShareInvitation.mockRejectedValueOnce(down);
    await act(async () => void reportFailure.mock.calls[0]![0].retry());
    expect(bridgeMock.resendRelayShareInvitation).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenCalledTimes(2);
    expect(reportFailure.mock.calls[1]![0]).toMatchObject({
      cause: down,
      identity: "share-invitation-email:grant-1",
    });

    let sent: (answer: ResendRelayShareInvitationResult) => void = () => undefined;
    bridgeMock.resendRelayShareInvitation.mockReturnValueOnce(
      new Promise((resolve) => {
        sent = resolve;
      }),
    );
    await act(async () => void reportFailure.mock.calls[1]![0].retry());
    expect(bridgeMock.resendRelayShareInvitation).toHaveBeenLastCalledWith({
      workspaceId: "workspace-a",
      shareId: "share-1",
      grantId: "grant-1",
    });
    expect(detail.textContent).toBe("Sending email…");
    const held = menuItem(await personMenu(person!), /^Resend invitation/);
    expect(held.getAttribute("aria-disabled")).toBe("true");
    await userEvent.keyboard("{Escape}");

    await act(async () => sent({ invitationEmail: "sent" }));
    expect(clearNotice).toHaveBeenCalledExactlyOnceWith("share-invitation-email:grant-1");
    expect(reportFailure).toHaveBeenCalledTimes(2);
    expect(detail.textContent).toBe("Email invitation sent.");
  });

  it("keeps the notice when its Try again is pressed while the person's resend is under way", async () => {
    answerWith({ granted: answer("granted", { rows: [granted()] }) });
    bridgeMock.resendRelayShareInvitation.mockResolvedValueOnce({ invitationEmail: "failed" });
    render(<CopyView />);
    const [person] = await people(await rowOf("share-1"));
    await userEvent.click(menuItem(await personMenu(person!), "Resend invitation"));
    await waitFor(() => expect(reportFailure).toHaveBeenCalledOnce());
    const tryAgain: () => void | false = reportFailure.mock.calls[0]![0].retry;

    let sent: (answer: ResendRelayShareInvitationResult) => void = () => undefined;
    bridgeMock.resendRelayShareInvitation.mockReturnValueOnce(
      new Promise((resolve) => {
        sent = resolve;
      }),
    );
    await userEvent.click(menuItem(await personMenu(person!), "Resend invitation"));
    expect(bridgeMock.resendRelayShareInvitation).toHaveBeenCalledTimes(2);

    expect(tryAgain()).toBe(false);
    expect(bridgeMock.resendRelayShareInvitation).toHaveBeenCalledTimes(2);

    await act(async () => sent({ invitationEmail: "sent" }));
    bridgeMock.resendRelayShareInvitation.mockResolvedValueOnce({ invitationEmail: "sent" });
    let ran: void | false = false;
    await act(async () => {
      ran = tryAgain();
    });
    expect(ran).toBeUndefined();
    expect(bridgeMock.resendRelayShareInvitation).toHaveBeenCalledTimes(3);
  });

  it("shows a resend under way, and then its answer, on a person's row that was closed and opened again", async () => {
    answerWith({ granted: answer("granted", { rows: [granted()] }) });
    const sends: Array<(answer: ResendRelayShareInvitationResult) => void> = [];
    bridgeMock.resendRelayShareInvitation.mockImplementation(
      () =>
        new Promise((resolve) => {
          sends.push(resolve);
        }),
    );
    render(<CopyView />);
    const item = await rowOf("share-1");
    const toggle = within(item).getByTestId("sharing-item-toggle");
    const detail = () =>
      within(within(item).getByTestId("sharing-person")).getByTestId("sharing-person-detail")
        .textContent;
    const [person] = await people(item);
    await userEvent.click(menuItem(await personMenu(person!), "Resend invitation"));
    expect(detail()).toBe("Sending email…");

    await userEvent.click(toggle);
    expect(within(item).queryByTestId("sharing-person")).toBeNull();
    await userEvent.click(toggle);
    expect(detail()).toBe("Sending email…");
    const [reopened] = await people(item);
    expect(
      menuItem(await personMenu(reopened!), /^Resend invitation/).getAttribute("aria-disabled"),
    ).toBe("true");
    await userEvent.keyboard("{Escape}");
    expect(bridgeMock.resendRelayShareInvitation).toHaveBeenCalledOnce();
    await act(async () => sends[0]!({ invitationEmail: "sent" }));
    expect(detail()).toBe("Email invitation sent.");

    await userEvent.click(menuItem(await personMenu(reopened!), "Resend invitation"));
    await userEvent.click(toggle);
    await act(async () => sends[1]!({ invitationEmail: "unavailable" }));
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith({
      message: "dohc could not email sam@example.com their invitation.",
      cause: new Error("This server does not send email."),
      identity: "share-invitation-email:grant-1",
      retry: expect.any(Function),
    });
    await userEvent.click(toggle);
    expect(detail()).toBe("This server does not send email.");

    await userEvent.click(toggle);
    await userEvent.click(toggle);
    expect(detail()).toBe("Invited by email");
  });

  it("puts a person's levels first in their menu, then Copy invitation, Resend invitation, Copy share code and Remove access", async () => {
    answerWith({ granted: answer("granted", { rows: ROWS }) });
    bridgeMock.getShareCopyDetails.mockResolvedValue(INVITING);
    render(<CopyView />);
    const [named, dependent] = await people(await rowOf("share-1"));
    const menu = await personMenu(named!);
    expect(menuRows(menu)).toEqual([
      "sharing-person-access-grant-1-view",
      "sharing-person-access-grant-1-edit",
      "sharing-person-copy-grant-1",
      "sharing-person-resend-grant-1",
      "sharing-person-copy-code-grant-1",
      "sharing-person-remove-grant-1",
    ]);
    expect(
      within(menu)
        .getAllByRole("menuitem", { hidden: true })
        .map((row) => row.textContent),
    ).toEqual(["Copy invitation", "Resend invitation", "Copy share code", "Remove access"]);
    await userEvent.click(menuItem(menu, "Copy share code"));
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(INVITING.shareCode));
    await waitFor(() =>
      expect(within(named!).getByTestId("sharing-person-detail").textContent).toBe(
        "Share code copied",
      ),
    );
    expect(
      within(await personMenu(dependent!))
        .getAllByRole("menuitem", { hidden: true })
        .map((row) => row.textContent),
    ).toEqual(["Copy code", "Remove access"]);
  });

  it("copies the same thing again from a failed copy's Try again, whatever was copied since", async () => {
    answerWith({ granted: answer("granted", { rows: ROWS }) });
    bridgeMock.getShareCopyDetails.mockResolvedValue(INVITING);
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<CopyView />);
    const [named] = await people(await rowOf("share-1"));
    await waitFor(() => expect(bridgeMock.getShareCopyDetails).toHaveBeenCalledOnce());
    await userEvent.click(menuItem(await personMenu(named!), "Copy invitation"));
    await waitFor(() => expect(reportFailure).toHaveBeenCalledOnce());
    expect(writeText).toHaveBeenLastCalledWith(INVITING.browserInvitationUrl);
    const detail = within(named!).getByTestId("sharing-person-detail");
    await waitFor(() => expect(detail.textContent).toBe("Could not copy"));
    expect(detail.querySelector(".text-danger")).not.toBeNull();
    const copyInvitationAgain = reportFailure.mock.calls[0]![0].retry as () => void;

    await userEvent.click(menuItem(await personMenu(named!), "Copy share code"));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(INVITING.shareCode));
    await act(async () => copyInvitationAgain());
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(3));
    expect(writeText).toHaveBeenLastCalledWith(INVITING.browserInvitationUrl);
    expect(reportFailure).toHaveBeenCalledOnce();
  });

  it("offers no copy while a change to Edit is under way, and the browser invitation once the relay confirms it", async () => {
    answerWith({
      granted: answer("granted", {
        rows: [
          granted({ access: "view" }),
          granted({
            shareId: "share-2",
            grantId: "grant-2",
            recipientUserId: "nova",
            recipientEmail: "nova@example.com",
          }),
        ],
      }),
    });
    bridgeMock.getShareCopyDetails.mockResolvedValue(INVITING);
    const change = deferred<{ access: "edit"; generation: number }>();
    bridgeMock.retuneRelayShareGrant.mockReturnValueOnce(change.promise);
    render(<CopyView />);
    const [person] = await people(await rowOf("share-1"));
    await waitFor(() => expect(bridgeMock.getShareCopyDetails).toHaveBeenCalledOnce());
    const level = within(person!).getByTestId("sharing-person-access-grant-1");
    expect(menuRows(await personMenu(person!))).not.toContain("sharing-person-copy-code-grant-1");
    await userEvent.click(screen.getByTestId("sharing-person-access-grant-1-edit"));
    expect(level.textContent).toBe("Can edit");
    expect(level).toHaveProperty("disabled", true);
    await userEvent.click(level);
    expect(screen.queryByRole("menu", { hidden: true })).toBeNull();
    expect(writeText).not.toHaveBeenCalled();

    await act(async () => change.resolve({ access: "edit", generation: 3 }));
    await waitFor(() => expect(level).toHaveProperty("disabled", false));
    const confirmed = await personMenu(person!);
    expect(menuRows(confirmed)).toContain("sharing-person-copy-code-grant-1");
    await userEvent.click(menuItem(confirmed, "Copy invitation"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith(INVITING.browserInvitationUrl),
    );
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("lets only the copy asked for last reach the clipboard, whichever lookup answers last", async () => {
    answerWith({ granted: answer("granted", { rows: ROWS }) });
    const slow = deferred<ShareCopyResult>();
    bridgeMock.getShareCopyDetails
      .mockResolvedValueOnce(INVITING)
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(INVITING);
    render(<CopyView />);
    const [named] = await people(await rowOf("share-1"));
    await waitFor(() => expect(bridgeMock.getShareCopyDetails).toHaveBeenCalledOnce());
    await userEvent.click(menuItem(await personMenu(named!), "Copy invitation"));
    await waitFor(() => expect(bridgeMock.getShareCopyDetails).toHaveBeenCalledTimes(2));
    await userEvent.click(menuItem(await personMenu(named!), "Copy share code"));
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(INVITING.shareCode));
    const detail = within(named!).getByTestId("sharing-person-detail");
    await waitFor(() => expect(detail.textContent).toBe("Share code copied"));

    await act(async () => slow.resolve(INVITING));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledExactlyOnceWith(INVITING.shareCode);
    expect(detail.textContent).toBe("Share code copied");
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("names the copy that ran on the person's line, also when Try again runs it from Notices", async () => {
    answerWith({ granted: answer("granted", { rows: ROWS }) });
    bridgeMock.getShareCopyDetails.mockResolvedValue(INVITING);
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<CopyView />);
    const [named] = await people(await rowOf("share-1"));
    await waitFor(() => expect(bridgeMock.getShareCopyDetails).toHaveBeenCalledOnce());
    const detail = within(named!).getByTestId("sharing-person-detail");
    await userEvent.click(menuItem(await personMenu(named!), "Copy invitation"));
    await waitFor(() => expect(detail.textContent).toBe("Could not copy"));
    const copyInvitationAgain = reportFailure.mock.calls[0]![0].retry as () => void;
    await userEvent.click(menuItem(await personMenu(named!), "Copy share code"));
    await waitFor(() => expect(detail.textContent).toBe("Share code copied"));

    await act(async () => copyInvitationAgain());
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(INVITING.browserInvitationUrl));
    await waitFor(() => expect(detail.textContent).toBe("Invitation copied"));
    await waitFor(() =>
      expect(within(named!).getByRole("status").textContent).toBe("Invitation copied"),
    );
  });

  it("offers one copy for a person who can edit on a server that makes no browser invitations", async () => {
    answerWith({ granted: answer("granted", { rows: ROWS }) });
    render(<CopyView />);
    const [named] = await people(await rowOf("share-1"));
    await waitFor(() => expect(bridgeMock.getShareCopyDetails).toHaveBeenCalledOnce());
    await act(async () => {});
    const menu = await personMenu(named!);
    expect(
      within(menu)
        .getAllByRole("menuitem", { hidden: true })
        .map((row) => row.textContent),
    ).toEqual(["Copy invitation", "Resend invitation", "Remove access"]);
    await userEvent.click(menuItem(menu, "Copy invitation"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith("dohc-share:share-1:https://relay.test"),
    );
  });

  it("copies by the level the relay confirmed for a person, not by an older listed one", async () => {
    answerWith({ granted: answer("granted", { rows: [granted()] }) });
    bridgeMock.getShareCopyDetails.mockResolvedValue(INVITING);
    bridgeMock.retuneRelayShareGrant.mockResolvedValue({ access: "view", generation: 3 });
    render(<CopyView />);
    const [person] = await people(await rowOf("share-1"));
    await waitFor(() => expect(bridgeMock.getShareCopyDetails).toHaveBeenCalledOnce());
    const level = within(person!).getByTestId("sharing-person-access-grant-1");
    await userEvent.click(level);
    await userEvent.click(screen.getByTestId("sharing-person-access-grant-1-view"));
    await waitFor(() => expect(level).toHaveProperty("disabled", false));
    expect(level.textContent).toBe("Can view");

    const menu = await personMenu(person!);
    expect(
      within(menu).queryByRole("menuitem", { hidden: true, name: "Copy share code" }),
    ).toBeNull();
    await userEvent.click(
      within(menu).getByRole("menuitem", { hidden: true, name: "Copy invitation" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(INVITING.shareCode));
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("copies from the keyboard, says so on the person's second line, and puts focus back on their menu", async () => {
    answerWith({ granted: answer("granted", { rows: ROWS }) });
    bridgeMock.getShareCopyDetails.mockResolvedValue(INVITING);
    render(<CopyView />);
    const item = await rowOf("share-1");
    const toggle = within(item).getByTestId("sharing-item-toggle");
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    const [named] = within(item).getAllByTestId("sharing-person");
    const detail = within(named!).getByTestId("sharing-person-detail");
    expect(detail.textContent).toBe("Invited by email");
    const trigger = within(named!).getByTestId("sharing-person-access-grant-1");
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const menu = screen.getByRole("menu", { hidden: true });
    expect(document.activeElement).toBe(screen.getByTestId("sharing-person-access-grant-1-edit"));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(menuItem(menu, "Copy invitation"));
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(INVITING.browserInvitationUrl));
    expect(screen.queryByRole("menu", { hidden: true })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await waitFor(() => expect(detail.textContent).toBe("Invitation copied"));
    await waitFor(() =>
      expect(within(named!).getByRole("status").textContent).toBe("Invitation copied"),
    );
    await waitFor(() => expect(detail.textContent).toBe("Invited by email"), {
      timeout: 2 * COPY_FEEDBACK_MS,
    });
  });

  it("reads the list again for a share that ended since, and reports nothing to fix", async () => {
    answerWith({ granted: answer("granted", { rows: ROWS }) });
    bridgeMock.getShareCopyDetails.mockResolvedValue({ status: "ended" });
    render(<CopyView />);
    const [named] = await people(await rowOf("share-1"));
    await waitFor(() => expect(bridgeMock.getShareCopyDetails).toHaveBeenCalledOnce());
    const reads = bridgeMock.listSharingAccess.mock.calls.length;
    await userEvent.click(
      within(await personMenu(named!)).getByRole("menuitem", {
        hidden: true,
        name: "Copy invitation",
      }),
    );
    await waitFor(() =>
      expect(bridgeMock.listSharingAccess.mock.calls.length).toBeGreaterThan(reads),
    );
    expect(bridgeMock.listSharingAccess).toHaveBeenLastCalledWith({
      workspaceId: "workspace-a",
      lane: "granted",
    });
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
    expect(target.getAttribute("aria-expanded")).toBe("false");
    await userEvent.tab();
    expect(document.activeElement).toBe(
      within(dependent).getByRole("button", { name: "Share actions" }),
    );
    // No row is left in the tab order by the jump.
    expect(target.hasAttribute("tabindex")).toBe(false);
    for (const row of await screen.findAllByTestId("sharing-granted-row")) {
      expect(row.querySelector("[data-sharing-row-focus]")!.hasAttribute("tabindex")).toBe(false);
    }
  });
});

describe("mounts and their skipped changes", () => {
  const GONE: ShareMount = {
    shareId: "gone-1",
    label: "notes",
    granterEmail: "sam@example.com",
    access: "view",
  };
  const skippedOps = {
    ops: [
      {
        originId: "origin-sam",
        originSeq: 4,
        opKind: "write",
        code: "share-boundary-violation",
        detail: "outside",
        atMs: 1,
      },
    ],
    more: 0,
    generation: 2,
  };

  it("keeps a mount removable when the account's list is unknown, without claiming it was removed", async () => {
    answerWith({ received: UNKNOWN("received") });
    render(<View facts={SIGNED_OUT} mounts={[GONE]} />);
    const row = await receivedRow();
    expect(row.dataset.status).toBe("unlisted");
    expect(within(row).queryByTestId("sharing-row-status")).toBeNull();
    expect(
      within(await openMenu(row)).getByRole("menuitem", {
        hidden: true,
        name: "Remove from workspace",
      }),
    ).toBeTruthy();
  });

  it("dismisses skipped changes, and shows them again from the row's menu", async () => {
    answerWith({ received: answer("received", { rows: [received()] }) });
    bridgeMock.dismissShareSkips.mockResolvedValue(undefined);
    const mount: ShareMount = {
      shareId: "in-1",
      label: "funnel",
      granterEmail: "sam@example.com",
      access: "view",
      skippedOps,
    };
    const { rerender } = render(<View mounts={[mount]} />);
    const row = await receivedRow();
    expect(within(row).getAllByTestId("sharing-skipped")).toHaveLength(1);

    await userEvent.click(within(row).getByRole("button", { name: "Dismiss skipped changes" }));
    expect(within(row).queryByTestId("sharing-skipped")).toBeNull();
    expect(document.activeElement).toBe(within(row).getByTestId("sharing-received-menu"));
    expect(bridgeMock.dismissShareSkips).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      shareId: "in-1",
      generation: 2,
    });
    await waitFor(() => expect(callbacks.onMountsChanged).toHaveBeenCalledOnce());

    const seen = { ...skippedOps, acknowledgedGeneration: 2 };
    rerender(<View mounts={[{ ...mount, skippedOps: seen }]} />);
    expect(within(row).queryByTestId("sharing-skipped")).toBeNull();
    await userEvent.click(
      within(await openMenu(row)).getByRole("menuitem", {
        hidden: true,
        name: "Show skipped changes",
      }),
    );
    expect(within(row).getAllByTestId("sharing-skipped")).toHaveLength(1);
  });

  it("brings the lines back and files a failed Dismiss with Try again", async () => {
    answerWith({ received: answer("received", { rows: [received()] }) });
    bridgeMock.dismissShareSkips
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(undefined);
    render(
      <View
        mounts={[
          { shareId: "in-1", label: "funnel", granterEmail: null, access: "view", skippedOps },
        ]}
      />,
    );
    const row = await receivedRow();
    await userEvent.click(within(row).getByTestId("sharing-skipped-dismiss"));
    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
    expect(callbacks.reportError.mock.calls[0]![0]).toBe(
      "dohc could not dismiss the skipped changes.",
    );
    expect(within(row).getAllByTestId("sharing-skipped")).toHaveLength(1);
    act(() => (callbacks.reportError.mock.calls[0]![2] as () => void)());
    await waitFor(() => expect(bridgeMock.dismissShareSkips).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(row).queryByTestId("sharing-skipped")).toBeNull());
  });
});

describe("one list at a time", () => {
  it("switches between the two lists, each with its count, and by the arrow keys", async () => {
    answerWith({
      granted: answer("granted", { rows: [granted()] }),
      received: answer("received", {
        rows: [received(), received({ shareId: "in-2", grantId: "in-grant-2" })],
      }),
    });
    render(<View />);
    await screen.findByTestId("sharing-granted-row");
    const group = screen.getByRole("radiogroup", { name: "Sharing" });
    const [byMe, withMe] = within(group).getAllByRole("radio");
    expect(byMe!.textContent).toBe("Shared by meBy me1");
    expect(within(byMe!).getByText("Shared by me").className).toContain("sr-only");
    expect(within(byMe!).getByText("By me").getAttribute("aria-hidden")).toBe("true");
    expect(byMe!.getAttribute("title")).toBe("Shared by me");
    expect(byMe!.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(withMe!.textContent).toBe("Shared with meWith me2"));
    expect(within(withMe!).getByText("With me").getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByTestId("sharing-received")).toBeNull();

    byMe!.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(withMe!.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(withMe);
    expect(await screen.findAllByTestId("sharing-received-row")).toHaveLength(2);
    expect(screen.queryByTestId("sharing-granted")).toBeNull();

    await userEvent.keyboard("{ArrowLeft}");
    expect(await screen.findByTestId("sharing-granted-row")).toBeTruthy();
  });

  it("opens on the list Settings search asked for, and on an ended share inside Ended", async () => {
    answerWith({
      received: answer("received", {
        rows: [received({ status: "removed", selector: null, access: null })],
      }),
    });
    render(<View focus={{ lane: "received", shareId: "in-1" }} />);
    const row = await screen.findByTestId("sharing-received-row");
    await waitFor(() =>
      expect(document.activeElement).toBe(row.querySelector("[data-sharing-row-focus]")),
    );
    expect(
      screen.getByRole("radio", { name: LANE_NAME.received }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(callbacks.onFocused).toHaveBeenCalledOnce();
  });

  it("draws no switch in a shared view", async () => {
    answerWith({ received: answer("received", { rows: [received()] }) });
    render(<View shareView />);
    expect(await screen.findByTestId("sharing-received-row")).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByTestId("sharing-received-count").textContent).toBe("1");
  });
});

describe("Shared by me, by what is shared", () => {
  const SEPARATE = [
    granted(),
    granted({
      shareId: "share-2",
      grantId: "grant-2",
      recipientUserId: "nova",
      recipientEmail: "nova@example.com",
      access: "view",
    }),
    granted({
      shareId: "share-3",
      grantId: "grant-3",
      via: "link",
      recipientUserId: null,
      recipientEmail: null,
      access: "view",
    }),
    granted({
      shareId: "share-4",
      grantId: "grant-4",
      selector: { paths: ["research/competitors.md"], versionId: null },
    }),
  ];

  it("says an invited person has not signed in yet while their invitation is pending", async () => {
    answerWith({
      granted: answer("granted", {
        rows: [granted({ recipientUserId: null, recipientEmail: "new@example.com" })],
      }),
    });
    render(<View />);
    const item = await screen.findByTestId("sharing-granted-row");
    await userEvent.click(within(item).getByTestId("sharing-item-toggle"));

    expect(within(item).getByTestId("sharing-person").textContent).toBe(
      "Nnew@example.comCan editPending invite",
    );
  });

  it("shows several shares of one file as one item with all its people and its link", async () => {
    answerWith({ granted: answer("granted", { rows: SEPARATE }) });
    render(<View />);
    const rows = await screen.findAllByTestId("sharing-granted-row");
    expect(rows.map((row) => row.dataset.shareIds)).toEqual(["share-4", "share-1 share-2 share-3"]);
    const item = rows[1]!;
    expect(within(item).getByTestId("sharing-row-who").textContent).toBe(
      "2 people and anyone with the link",
    );
    const toggle = within(item).getByTestId("sharing-item-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(item).queryByTestId("sharing-person")).toBeNull();

    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const rowsOfPeople = within(item).getAllByTestId("sharing-person");
    expect(rowsOfPeople.map((person) => person.textContent)).toEqual([
      "Ssam@example.comCan editInvited by email",
      "Nnova@example.comCan viewInvited by email",
    ]);
    expect(within(item).getByTestId("sharing-link").textContent).toBe(
      "Anyone with the linkCan view",
    );

    await userEvent.click(within(item).getByRole("button", { name: "Open Share…" }));
    expect(callbacks.onShare).toHaveBeenCalledExactlyOnceWith({
      kind: "paths",
      paths: ["notes/product-plan.md"],
    });
  });

  it("keeps an item open when its list is read again", async () => {
    answerWith({ granted: answer("granted", { rows: SEPARATE }) });
    const { rerender } = render(<View />);
    const item = await grantedRow("share-1");
    await people(item);
    expect(within(item).getByTestId("sharing-link")).toBeTruthy();
    answerWith({ granted: answer("granted", { rows: SEPARATE.slice(0, 2) }) });
    rerender(<View facts={RECONNECTING} />);
    await waitFor(() => expect(screen.queryByTestId("sharing-link")).toBeNull());
    expect(within(await grantedRow("share-1")).getAllByTestId("sharing-person")).toHaveLength(2);
  });

  it("puts what has changes to review first, then goes by name", async () => {
    answerWith({ granted: answer("granted", { rows: SEPARATE }) });
    render(
      <View
        proposals={[
          {
            proposalId: "proposal-1",
            shareId: "share-2",
            proposedByEmail: "nova@example.com",
            createdAtMs: 1,
            ops: 1,
          },
        ]}
      />,
    );
    const rows = await screen.findAllByTestId("sharing-granted-row");
    expect(rows.map((row) => row.dataset.shareId)).toEqual(["share-1", "share-4"]);
    await userEvent.click(within(rows[0]!).getByRole("button", { name: "Review changes" }));
    expect(callbacks.onReviewChanges).toHaveBeenCalledWith("proposal-1");
    expect(within(rows[1]!).queryByTestId("sharing-review")).toBeNull();
  });

  it("changes a person's level in place, and a stale listing does not undo it", async () => {
    let rows = [granted({ access: "view" })];
    bridgeMock.listSharingAccess.mockImplementation(async ({ lane }) =>
      answer(lane, { rows: lane === "granted" ? rows : [] }),
    );
    const changed = deferred<{ access: "edit"; generation: number }>();
    bridgeMock.retuneRelayShareGrant.mockReturnValue(changed.promise);
    const { rerender } = render(<View />);
    const [person] = await people(await grantedRow("share-1"));
    const trigger = within(person!).getByTestId("sharing-person-access-grant-1");
    expect(trigger.textContent).toBe("Can view");
    await userEvent.click(trigger);
    expect(
      screen
        .getAllByRole("menuitemradio", { hidden: true })
        .map((option) => option.getAttribute("data-testid")),
    ).toEqual(["sharing-person-access-grant-1-view", "sharing-person-access-grant-1-edit"]);
    await userEvent.click(screen.getByTestId("sharing-person-access-grant-1-edit"));
    expect(bridgeMock.retuneRelayShareGrant).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace-a",
      shareId: "share-1",
      grantId: "grant-1",
      access: "edit",
    });
    expect(trigger).toHaveProperty("disabled", true);

    const reads = bridgeMock.listSharingAccess.mock.calls.length;
    await act(async () => changed.resolve({ access: "edit", generation: 3 }));
    await waitFor(() => expect(trigger.textContent).toBe("Can edit"));
    expect(trigger).toHaveProperty("disabled", false);
    await waitFor(() =>
      expect(bridgeMock.listSharingAccess.mock.calls.length).toBeGreaterThan(reads),
    );
    expect(trigger.textContent).toBe("Can edit");

    rows = [granted({ access: "view", generation: 4 })];
    rerender(<View facts={RECONNECTING} />);
    await waitFor(() =>
      expect(screen.getByTestId("sharing-person-access-grant-1").textContent).toBe("Can view"),
    );
  });

  it("shows a new level at once on the person and the item, and puts both back when the relay refuses", async () => {
    answerWith({ granted: answer("granted", { rows: [granted({ access: "comment" })] }) });
    const refused = deferred<{ access: "view"; generation: number }>();
    bridgeMock.retuneRelayShareGrant.mockReturnValueOnce(refused.promise);
    render(<View />);
    const item = await grantedRow("share-1");
    const [person] = await people(item);
    const who = within(item).getByTestId("sharing-row-who");
    const trigger = within(person!).getByTestId("sharing-person-access-grant-1");
    await userEvent.click(trigger);
    expect(
      screen
        .getAllByRole("menuitemradio", { hidden: true })
        .map((option) => option.getAttribute("data-testid")),
    ).toEqual([
      "sharing-person-access-grant-1-view",
      "sharing-person-access-grant-1-comment",
      "sharing-person-access-grant-1-edit",
    ]);
    await userEvent.click(screen.getByTestId("sharing-person-access-grant-1-view"));
    expect(trigger.textContent).toBe("Can view");
    expect(who.textContent).toBe("sam@example.com can view");

    const cause = new Error("relay down");
    await act(async () => refused.reject(cause));
    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
    expect(callbacks.reportError.mock.calls[0]![0]).toBe(
      "dohc could not change sam@example.com's access to notes/product-plan.md.",
    );
    expect(callbacks.reportError.mock.calls[0]![1]).toBe(cause);
    expect(trigger.textContent).toBe("Can comment");
    expect(who.textContent).toBe("sam@example.com can comment");
    expect(trigger).toHaveProperty("disabled", false);
    expect(within(person!).queryByRole("alert")).toBeNull();

    bridgeMock.retuneRelayShareGrant.mockResolvedValue({ access: "view", generation: 2 });
    await act(async () => callbacks.reportError.mock.calls[0]![2]());
    expect(bridgeMock.retuneRelayShareGrant).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(who.textContent).toBe("sam@example.com can view"));
    expect(trigger.textContent).toBe("Can view");
  });

  it("asks before a change to Can edit that would stop an automation, in Share's words, and changes nothing until told", async () => {
    const stops: AutomationStop[] = [
      {
        automationId: "collection:Trip#spend",
        automationName: "Spend",
        collectionPath: "Trip",
        target: "Budget",
        action: "change",
      },
    ];
    const warning = automationShareWarning(stops, "sam@example.com")!;
    answerWith({ granted: answer("granted", { rows: [granted({ access: "view" })] }) });
    const check = deferred<{ stops: AutomationStop[] }>();
    bridgeMock.automationShareImpact.mockReturnValueOnce(check.promise);
    bridgeMock.automationShareImpact.mockResolvedValue({ stops });
    bridgeMock.retuneRelayShareGrant.mockResolvedValue({ access: "edit", generation: 2 });
    render(<View />);
    const [person] = await people(await grantedRow("share-1"));
    const level = within(person!).getByTestId("sharing-person-access-grant-1");
    await userEvent.click(level);
    await userEvent.click(screen.getByTestId("sharing-person-access-grant-1-edit"));
    expect(bridgeMock.automationShareImpact).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace-a",
      recipientEmail: "sam@example.com",
      paths: ["notes/product-plan.md"],
      access: "edit",
    });
    expect(level).toHaveProperty("disabled", true);
    expect(level.textContent).toBe("Can view");

    await act(async () => check.resolve({ stops }));
    const confirm = await within(person!).findByTestId("sharing-access-confirm");
    expect(warning).toContain("sam@example.com");
    expect(confirm.textContent).toBe(`${warning}CancelChange to Can edit`);
    expect(level).toHaveProperty("disabled", false);
    expect(level.textContent).toBe("Can view");
    expect(bridgeMock.retuneRelayShareGrant).not.toHaveBeenCalled();

    await userEvent.click(within(confirm).getByTestId("sharing-access-cancel"));
    expect(screen.queryByTestId("sharing-access-confirm")).toBeNull();
    expect(bridgeMock.retuneRelayShareGrant).not.toHaveBeenCalled();

    await userEvent.click(level);
    await userEvent.click(screen.getByTestId("sharing-person-access-grant-1-edit"));
    const again = await within(person!).findByTestId("sharing-access-confirm");
    await userEvent.click(within(again).getByTestId("sharing-access"));
    await waitFor(() =>
      expect(bridgeMock.retuneRelayShareGrant).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "workspace-a",
        shareId: "share-1",
        grantId: "grant-1",
        access: "edit",
      }),
    );
    await waitFor(() => expect(level.textContent).toBe("Can edit"));
    expect(screen.queryByTestId("sharing-access-confirm")).toBeNull();
    expect(bridgeMock.automationShareImpact).toHaveBeenCalledTimes(2);
  });

  it("changes to Can edit at once when the check cannot run, and never checks a change to Can view", async () => {
    answerWith({ granted: answer("granted", { rows: [granted({ access: "view" })] }) });
    bridgeMock.automationShareImpact.mockRejectedValueOnce(new Error("offline"));
    bridgeMock.retuneRelayShareGrant
      .mockResolvedValueOnce({ access: "edit", generation: 2 })
      .mockResolvedValueOnce({ access: "view", generation: 3 });
    render(<View />);
    const [person] = await people(await grantedRow("share-1"));
    const level = within(person!).getByTestId("sharing-person-access-grant-1");
    await userEvent.click(level);
    await userEvent.click(screen.getByTestId("sharing-person-access-grant-1-edit"));
    await waitFor(() => expect(level.textContent).toBe("Can edit"));
    await waitFor(() => expect(level).toHaveProperty("disabled", false));
    expect(screen.queryByTestId("sharing-access-confirm")).toBeNull();
    expect(bridgeMock.automationShareImpact).toHaveBeenCalledOnce();

    await userEvent.click(level);
    await userEvent.click(screen.getByTestId("sharing-person-access-grant-1-view"));
    await waitFor(() => expect(bridgeMock.retuneRelayShareGrant).toHaveBeenCalledTimes(2));
    expect(bridgeMock.automationShareImpact).toHaveBeenCalledOnce();
  });

  it("keeps a change that is under way when its item closes or the list is switched, and ignores an older answer", async () => {
    answerWith({ granted: answer("granted", { rows: [granted({ access: "view" })] }) });
    const first = deferred<{ access: "edit"; generation: number }>();
    bridgeMock.retuneRelayShareGrant.mockReturnValueOnce(first.promise);
    render(<View />);
    const access = () => screen.getByTestId("sharing-person-access-grant-1");
    const [person] = await people(await grantedRow("share-1"));
    await userEvent.click(access());
    await userEvent.click(screen.getByTestId("sharing-person-access-grant-1-edit"));
    expect(access()).toHaveProperty("disabled", true);
    expect(person!.querySelectorAll("button")).toHaveLength(1);

    const toggle = within(await grantedRow("share-1")).getByTestId("sharing-item-toggle");
    await userEvent.click(toggle);
    expect(screen.queryByTestId("sharing-person")).toBeNull();
    await userEvent.click(toggle);
    expect(access().textContent).toBe("Can edit");
    expect(access()).toHaveProperty("disabled", true);

    await showLane("received");
    await showLane("granted");
    const [again] = await people(await grantedRow("share-1"));
    expect(access().textContent).toBe("Can edit");
    expect(access()).toHaveProperty("disabled", true);
    expect(again!.querySelectorAll("button")).toHaveLength(1);

    await act(async () => first.resolve({ access: "edit", generation: 5 }));
    await waitFor(() => expect(access()).toHaveProperty("disabled", false));
    expect(access().textContent).toBe("Can edit");

    bridgeMock.retuneRelayShareGrant.mockResolvedValueOnce({ access: "view", generation: 3 });
    await userEvent.click(access());
    await userEvent.click(screen.getByTestId("sharing-person-access-grant-1-view"));
    await waitFor(() => expect(bridgeMock.retuneRelayShareGrant).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(access()).toHaveProperty("disabled", false));
    expect(access().textContent).toBe("Can edit");
    expect(within(await grantedRow("share-1")).getByTestId("sharing-row-who").textContent).toBe(
      "sam@example.com can edit",
    );
  });

  it("removes one person from a share of several and leaves the others", async () => {
    answerWith({
      granted: answer("granted", {
        rows: [
          granted(),
          granted({
            grantId: "grant-2",
            recipientUserId: "nova",
            recipientEmail: "nova@example.com",
          }),
        ],
      }),
    });
    const undo = { undoId: "undo-1", expiresAtMs: Date.now() + 600_000 };
    bridgeMock.revokeRelayShareGrant.mockResolvedValue({ undo });
    render(<View />);
    const [, nova] = await people(await grantedRow("share-1"));
    await userEvent.click(
      within(await personMenu(nova!)).getByRole("menuitem", {
        hidden: true,
        name: "Remove access",
      }),
    );
    const confirm = within(nova!).getByTestId("sharing-end-confirm");
    expect(confirm.textContent).toContain(
      "Remove nova@example.com's access to product-plan.md? Their access ends. Copies they already made stay with them.",
    );
    expect(document.activeElement).toBe(within(confirm).getByTestId("sharing-end-cancel"));
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove access" }));
    await waitFor(() => expect(shareRemovals.removed).toHaveBeenCalledOnce());
    expect(bridgeMock.revokeRelayShareGrant).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace-a",
      shareId: "share-1",
      grantId: "grant-2",
    });
    expect(bridgeMock.revokeRelayShare).not.toHaveBeenCalled();
    expect(shareRemovals.removed).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      shareId: "share-1",
      undo,
      message: "Removed nova@example.com's access to notes/product-plan.md.",
      restoredMessage: "Restored nova@example.com's access to notes/product-plan.md.",
    });
    await waitFor(() => expect(screen.queryByTestId("sharing-end-confirm")).toBeNull());
  });

  it("never ends the whole share from a person's row, even when that person is the only one listed", async () => {
    answerWith({
      granted: answer("granted", { rows: [granted()], nextCursor: "page-2" }),
    });
    const undo = { undoId: "undo-1", expiresAtMs: Date.now() + 600_000 };
    bridgeMock.revokeRelayShareGrant.mockRejectedValueOnce(new Error("relay down"));
    bridgeMock.revokeRelayShareGrant.mockResolvedValue({ undo });
    render(<View />);
    const [sam] = await people(await grantedRow("share-1"));
    await userEvent.click(
      within(await personMenu(sam!)).getByRole("menuitem", { hidden: true, name: "Remove access" }),
    );
    expect(within(sam!).getByTestId("sharing-end-confirm").textContent).toContain(
      "Remove sam@example.com's access to product-plan.md?",
    );
    await userEvent.click(within(sam!).getByRole("button", { name: "Remove access" }));
    await waitFor(() => expect(shareRemovals.failed).toHaveBeenCalledOnce());
    expect(shareRemovals.failed.mock.calls[0]![0]).toMatchObject({
      workspaceId: "workspace-a",
      message: "dohc could not remove sam@example.com's access to notes/product-plan.md.",
    });
    await act(async () => shareRemovals.failed.mock.calls[0]![0].retry());
    await waitFor(() => expect(shareRemovals.removed).toHaveBeenCalledOnce());
    expect(shareRemovals.removed.mock.calls[0]![0]).toMatchObject({ shareId: "share-1", undo });
    expect(bridgeMock.revokeRelayShareGrant).toHaveBeenLastCalledWith({
      workspaceId: "workspace-a",
      shareId: "share-1",
      grantId: "grant-1",
    });
    expect(bridgeMock.revokeRelayShare).not.toHaveBeenCalled();
  });

  it("removes a person who joined through a link by their own grant", async () => {
    answerWith({
      granted: answer("granted", {
        rows: [
          granted({
            shareId: "share-link",
            grantId: "link",
            via: "link",
            recipientUserId: null,
            recipientEmail: null,
          }),
          granted({ shareId: "share-link", grantId: "joined", via: "dependent" }),
        ],
      }),
    });
    bridgeMock.revokeRelayShareGrant.mockResolvedValue({
      undo: { undoId: "undo-1", expiresAtMs: Date.now() + 600_000 },
    });
    render(<View />);
    const [sam] = await people(await grantedRow("share-link"));
    await userEvent.click(
      within(await personMenu(sam!)).getByRole("menuitem", { hidden: true, name: "Remove access" }),
    );
    expect(within(sam!).getByTestId("sharing-end-confirm").textContent).toBe(
      "Remove sam@example.com's access to product-plan.md? Their link access ends, though they can join again while the link is active. End the link in Share to keep them out.CancelRemove access",
    );
    await userEvent.click(within(sam!).getByRole("button", { name: "Remove access" }));
    await waitFor(() =>
      expect(bridgeMock.revokeRelayShareGrant).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "workspace-a",
        shareId: "share-link",
        grantId: "joined",
      }),
    );
    expect(bridgeMock.revokeRelayShare).not.toHaveBeenCalled();
  });

  it("removes an invitation nobody has used by its own grant, and says only that", async () => {
    answerWith({
      granted: answer("granted", {
        rows: [
          granted(),
          granted({
            grantId: "grant-2",
            recipientUserId: null,
            recipientEmail: "nova@example.com",
          }),
        ],
      }),
    });
    const undo = { undoId: "undo-1", expiresAtMs: Date.now() + 600_000 };
    bridgeMock.revokeRelayShareGrant.mockResolvedValue({ undo });
    render(<View />);
    const [, nova] = await people(await grantedRow("share-1"));
    const menu = await personMenu(nova!);
    expect(within(menu).queryByRole("menuitem", { hidden: true, name: "End share…" })).toBeNull();
    await userEvent.click(
      within(menu).getByRole("menuitem", { hidden: true, name: "Remove access" }),
    );
    expect(within(nova!).getByTestId("sharing-end-confirm").textContent).toBe(
      "Remove nova@example.com's access to product-plan.md? Their pending email invitation ends.CancelRemove access",
    );
    await userEvent.click(within(nova!).getByRole("button", { name: "Remove access" }));
    await waitFor(() => expect(shareRemovals.removed).toHaveBeenCalledOnce());
    expect(bridgeMock.revokeRelayShareGrant).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace-a",
      shareId: "share-1",
      grantId: "grant-2",
    });
    expect(bridgeMock.revokeRelayShare).not.toHaveBeenCalled();
    expect(shareRemovals.removed).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      shareId: "share-1",
      undo,
      message: "Removed nova@example.com's email invitation to notes/product-plan.md.",
      restoredMessage: "Restored nova@example.com's email invitation to notes/product-plan.md.",
    });
  });

  it("says how many people End share ends, and that a link keeps working", async () => {
    answerWith({ granted: answer("granted", { rows: SEPARATE }) });
    bridgeMock.revokeRelayShare.mockResolvedValue({});
    render(
      <View
        proposals={[
          {
            proposalId: "proposal-1",
            shareId: "share-2",
            proposedByEmail: "nova@example.com",
            createdAtMs: 1,
            ops: 1,
          },
        ]}
      />,
    );
    const item = await grantedRow("share-1");
    await userEvent.click(
      within(await openMenu(item)).getByRole("menuitem", { hidden: true, name: "End share…" }),
    );
    expect(within(item).getByTestId("sharing-end-confirm").textContent).toBe(
      "End this share with 2 people and decline 1 change nova@example.com sent? Undo restores the share, not the declined change. Anyone with the link keeps access. End links in Share.CancelEnd share",
    );
    await userEvent.click(within(item).getByTestId("sharing-end"));
    await waitFor(() => expect(bridgeMock.revokeRelayShare).toHaveBeenCalledTimes(2));
    expect(bridgeMock.revokeRelayShare.mock.calls.map(([input]) => input.shareId)).toEqual([
      "share-1",
      "share-2",
    ]);

    const other = await grantedRow("share-4");
    await userEvent.click(
      within(await openMenu(other)).getByRole("menuitem", { hidden: true, name: "End share…" }),
    );
    expect(within(other).getByTestId("sharing-end-confirm").textContent).toContain(
      "End this share with 1 person? Updates stop for sam@example.com, and their copy stays read-only.Cancel",
    );
  });

  it("says on End share that shares not shown yet stay as they are, and loads none of them", async () => {
    answerWith({
      granted: answer("granted", { rows: [granted(), SEPARATE[3]!], nextCursor: "page-2" }),
    });
    render(<View />);
    const item = await grantedRow("share-1");
    await userEvent.click(
      within(await openMenu(item)).getByRole("menuitem", { hidden: true, name: "End share…" }),
    );
    expect(within(item).getByTestId("sharing-end-confirm").textContent).toBe(
      "End this share with 1 person? Updates stop for sam@example.com, and their copy stays read-only. Not every share is loaded yet. Any others stay unchanged.CancelEnd share",
    );
    expect(bridgeMock.listSharingAccess).not.toHaveBeenCalledWith(
      expect.objectContaining({ cursor: expect.anything() }),
    );
  });

  it("holds an open Remove access while that person's level is changing", async () => {
    answerWith({ granted: answer("granted", { rows: [granted({ access: "view" })] }) });
    const change = deferred<{ access: "edit"; generation: number }>();
    bridgeMock.retuneRelayShareGrant.mockReturnValueOnce(change.promise);
    render(<View />);
    const [person] = await people(await grantedRow("share-1"));
    await userEvent.click(
      within(await personMenu(person!)).getByRole("menuitem", {
        hidden: true,
        name: "Remove access",
      }),
    );
    const confirm = within(person!).getByTestId("sharing-end-confirm");
    const remove = within(confirm).getByTestId("sharing-end");
    expect(remove).toHaveProperty("disabled", false);

    await userEvent.click(within(person!).getByTestId("sharing-person-access-grant-1"));
    await userEvent.click(screen.getByTestId("sharing-person-access-grant-1-edit"));
    expect(bridgeMock.retuneRelayShareGrant).toHaveBeenCalledOnce();
    expect(remove).toHaveProperty("disabled", true);
    expect(remove.textContent).toBe("Remove access");
    const why = within(confirm).getByTestId("sharing-end-held");
    expect(why.textContent).toBe("Changing access…");
    expect(remove.getAttribute("aria-describedby")).toBe(why.id);
    await userEvent.click(remove);
    expect(bridgeMock.revokeRelayShareGrant).not.toHaveBeenCalled();

    await act(async () => change.resolve({ access: "edit", generation: 2 }));
    await waitFor(() => expect(remove).toHaveProperty("disabled", false));
    expect(within(confirm).queryByTestId("sharing-end-held")).toBeNull();
  });

  it("starts no level change from a Try again while that person's removal is under way", async () => {
    answerWith({ granted: answer("granted", { rows: [granted({ access: "view" })] }) });
    bridgeMock.retuneRelayShareGrant.mockRejectedValueOnce(new Error("relay down"));
    bridgeMock.revokeRelayShareGrant.mockReturnValueOnce(
      deferred<{ undo: { undoId: string; expiresAtMs: number } }>().promise,
    );
    render(<View />);
    const [person] = await people(await grantedRow("share-1"));
    const level = within(person!).getByTestId("sharing-person-access-grant-1");
    await userEvent.click(level);
    await userEvent.click(screen.getByTestId("sharing-person-access-grant-1-edit"));
    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
    const changeAgain = callbacks.reportError.mock.calls[0]![2] as () => void | false;

    await userEvent.click(
      within(await personMenu(person!)).getByRole("menuitem", {
        hidden: true,
        name: "Remove access",
      }),
    );
    await userEvent.click(within(person!).getByTestId("sharing-end"));
    expect(bridgeMock.revokeRelayShareGrant).toHaveBeenCalledOnce();
    expect(changeAgain()).toBe(false);
    expect(bridgeMock.retuneRelayShareGrant).toHaveBeenCalledOnce();
  });

  it("starts no removal from a Try again while that person's level is changing", async () => {
    answerWith({ granted: answer("granted", { rows: [granted({ access: "view" })] }) });
    bridgeMock.revokeRelayShareGrant.mockRejectedValueOnce(new Error("relay down"));
    render(<View />);
    const [person] = await people(await grantedRow("share-1"));
    const level = within(person!).getByTestId("sharing-person-access-grant-1");
    await userEvent.click(
      within(await personMenu(person!)).getByRole("menuitem", {
        hidden: true,
        name: "Remove access",
      }),
    );
    await userEvent.click(within(person!).getByTestId("sharing-end"));
    await waitFor(() => expect(shareRemovals.failed).toHaveBeenCalledOnce());
    const removeAgain = shareRemovals.failed.mock.calls[0]![0].retry as () => void | false;
    await waitFor(() => expect(level).toHaveProperty("disabled", false));

    const change = deferred<{ access: "edit"; generation: number }>();
    bridgeMock.retuneRelayShareGrant.mockReturnValueOnce(change.promise);
    await userEvent.click(level);
    await userEvent.click(screen.getByTestId("sharing-person-access-grant-1-edit"));
    expect(bridgeMock.retuneRelayShareGrant).toHaveBeenCalledOnce();
    expect(removeAgain()).toBe(false);
    expect(bridgeMock.revokeRelayShareGrant).toHaveBeenCalledOnce();

    bridgeMock.revokeRelayShareGrant.mockResolvedValue({
      undo: { undoId: "undo-1", expiresAtMs: Date.now() + 600_000 },
    });
    await act(async () => change.resolve({ access: "edit", generation: 2 }));
    await waitFor(() => expect(level).toHaveProperty("disabled", false));
    let ran: void | false = false;
    await act(async () => {
      ran = removeAgain();
    });
    expect(ran).not.toBe(false);
    await waitFor(() => expect(shareRemovals.removed).toHaveBeenCalledOnce());
  });

  it("takes a failed change's notice back once a later change for that person works", async () => {
    answerWith({ granted: answer("granted", { rows: [granted({ access: "view" })] }) });
    bridgeMock.retuneRelayShareGrant.mockRejectedValueOnce(new Error("relay down"));
    render(<View />);
    const [person] = await people(await grantedRow("share-1"));
    const level = within(person!).getByTestId("sharing-person-access-grant-1");
    await userEvent.click(level);
    await userEvent.click(screen.getByTestId("sharing-person-access-grant-1-edit"));
    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
    expect(callbacks.reportError.mock.calls[0]![3]).toBe("share-access:grant-1");
    expect(clearNotice).not.toHaveBeenCalled();

    bridgeMock.retuneRelayShareGrant.mockResolvedValue({ access: "edit", generation: 2 });
    await userEvent.click(level);
    await userEvent.click(screen.getByTestId("sharing-person-access-grant-1-edit"));
    await waitFor(() => expect(level.textContent).toBe("Can edit"));
    expect(clearNotice).toHaveBeenCalledExactlyOnceWith("share-access:grant-1");
    expect(callbacks.reportError).toHaveBeenCalledOnce();
  });

  it("offers no End share on an item that has only links, and says where links end", async () => {
    answerWith({ granted: answer("granted", { rows: [SEPARATE[2]!] }) });
    render(<View />);
    const item = await grantedRow("share-3");
    expect(within(item).queryByRole("button", { name: "Share actions" })).toBeNull();
    await userEvent.click(within(item).getByTestId("sharing-item-toggle"));
    expect(within(item).getByTestId("sharing-links-note").textContent).toBe("End links in Share.");
    expect(within(item).getByRole("button", { name: "Open Share…" })).toBeTruthy();
  });

  it("opens the oldest waiting change of all an item's shares", async () => {
    answerWith({ granted: answer("granted", { rows: SEPARATE }) });
    render(
      <View
        proposals={[
          {
            proposalId: "newer",
            shareId: "share-1",
            proposedByEmail: "sam@example.com",
            createdAtMs: 9,
            ops: 1,
          },
          {
            proposalId: "oldest",
            shareId: "share-2",
            proposedByEmail: "nova@example.com",
            createdAtMs: 2,
            ops: 1,
          },
        ]}
      />,
    );
    const item = await grantedRow("share-1");
    await userEvent.click(within(item).getByTestId("sharing-review"));
    expect(callbacks.onReviewChanges).toHaveBeenLastCalledWith("oldest");
    await userEvent.click(
      within(await openMenu(item)).getByRole("menuitem", {
        hidden: true,
        name: "Review changes (2)",
      }),
    );
    expect(callbacks.onReviewChanges).toHaveBeenCalledTimes(2);
    expect(callbacks.onReviewChanges).toHaveBeenLastCalledWith("oldest");
  });

  it("holds a share whose grants are not all loaded among the live items, and counts only what it knows", async () => {
    const pageOne = [
      granted(),
      granted({
        shareId: "share-2",
        grantId: "grant-2",
        status: "revoked",
        subjectName: "budget.csv",
        selector: null,
        access: null,
      }),
    ];
    bridgeMock.listSharingAccess.mockImplementation(async ({ lane, cursor }) =>
      lane === "received"
        ? answer("received")
        : cursor === "page-2"
          ? answer("granted", {
              rows: [
                granted({
                  shareId: "share-2",
                  grantId: "grant-3",
                  recipientUserId: "nova",
                  recipientEmail: "nova@example.com",
                  subjectName: "budget.csv",
                  selector: { paths: ["budget.csv"], versionId: null },
                }),
              ],
            })
          : answer("granted", { rows: pageOne, nextCursor: "page-2" }),
    );
    render(<View />);
    const held = await grantedRow("share-2");
    expect(held.dataset.status).toBe("unconfirmed");
    expect(within(held).getByTestId("sharing-row-who").textContent).toBe(
      "Show more to see who has it",
    );
    expect(screen.queryByTestId("sharing-granted-ended")).toBeNull();
    expect(screen.getByTestId("sharing-granted-count").textContent).toBe("1+1 or more shares");

    await userEvent.click(screen.getByTestId("sharing-granted-more"));
    await waitFor(() => expect(screen.getByTestId("sharing-granted-count").textContent).toBe("2"));
    const loaded = await grantedRow("share-2");
    expect(loaded.dataset.status).toBe("active");
    expect(within(loaded).getByTestId("sharing-row-who").textContent).toBe(
      "nova@example.com can edit",
    );
  });

  it("draws no expansion control on a held item with nothing to show, and keeps it a keyboard stop", async () => {
    bridgeMock.listSharingAccess.mockImplementation(async ({ lane, cursor }) =>
      lane === "received"
        ? answer("received")
        : cursor === "page-2"
          ? answer("granted", {
              rows: [
                granted({
                  shareId: "share-2",
                  grantId: "grant-3",
                  subjectName: "budget.csv",
                  selector: { paths: ["budget.csv"], versionId: null },
                }),
              ],
            })
          : answer("granted", {
              rows: [
                granted(),
                granted({
                  shareId: "share-2",
                  grantId: "grant-2",
                  status: "revoked",
                  subjectName: "budget.csv",
                  selector: null,
                  access: null,
                }),
              ],
              nextCursor: "page-2",
            }),
    );
    render(<View focus={{ lane: "granted", shareId: "share-2" }} />);
    const held = await grantedRow("share-2");
    expect(held.querySelector("[aria-expanded]")).toBeNull();
    expect(within(held).queryByTestId("sharing-item-toggle")).toBeNull();
    const row = within(held).getByRole("group", {
      name: "budget.csv, Show more to see who has it",
    });
    await waitFor(() => expect(document.activeElement).toBe(row));
    await userEvent.tab();
    expect(document.activeElement).not.toBe(row);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(row);

    await userEvent.click(screen.getByTestId("sharing-granted-more"));
    await waitFor(() => expect(screen.getByTestId("sharing-granted-count").textContent).toBe("2"));
    const toggle = within(await grantedRow("share-2")).getByTestId("sharing-item-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(await grantedRow("share-2")).getAllByTestId("sharing-person")).toHaveLength(1);
  });

  it("calls a share ended once its listing ends with only a revoked grant", async () => {
    answerWith({
      granted: answer("granted", {
        rows: [
          granted(),
          granted({
            shareId: "share-2",
            grantId: "grant-2",
            status: "revoked",
            selector: null,
            access: null,
          }),
        ],
      }),
    });
    render(<View />);
    await grantedRow("share-1");
    expect(screen.getByTestId("sharing-granted-ended-count").textContent).toBe("1");
    expect(screen.getByTestId("sharing-granted-count").textContent).toBe("1");
  });

  it("says whose access a level is, and cuts a long address with its whole value in a tooltip", async () => {
    const address = "a-very-long-name-that-does-not-fit@a-long-company-name.example.com";
    answerWith({
      granted: answer("granted", { rows: [granted({ recipientEmail: address })] }),
    });
    render(<View />);
    const [person] = await people(await grantedRow("share-1"));
    const name = within(person!).getByTestId("sharing-person-name");
    expect(name.textContent).toBe(address);
    expect(name.getAttribute("title")).toBe(address);
    expect(name.className.split(" ")).toContain("truncate");
    expect(name.className).not.toContain("break-all");
    const trigger = within(person!).getByRole("button", {
      name: `Access for ${address}: Can edit`,
    });
    expect(trigger.textContent).toBe("Can edit");
    expect(trigger.getAttribute("aria-describedby")).toBeNull();
  });

  it("keeps ended and damaged shares out of the list, in Ended", async () => {
    answerWith({
      granted: answer("granted", {
        rows: [
          granted(),
          granted({
            shareId: "share-old",
            grantId: "grant-old",
            status: "revoked",
            subjectName: "budget.csv",
            selector: null,
            access: null,
          }),
          granted({
            shareId: "share-bad",
            grantId: "grant-bad",
            status: "damaged",
            selector: null,
            access: null,
          }),
        ],
      }),
    });
    render(<View />);
    const live = await screen.findAllByTestId("sharing-granted-row");
    expect(live.map((row) => row.dataset.status)).toEqual(["active"]);
    expect(screen.getByTestId("sharing-granted-count").textContent).toBe("1");
    const ended = screen.getByTestId("sharing-granted-ended");
    expect(within(ended).getByTestId("sharing-granted-ended-count").textContent).toBe("2");
    expect(within(ended).getByRole("img", { name: "1 damaged share" })).toBeTruthy();
    expect(within(ended).queryByTestId("sharing-granted-row")).toBeNull();

    await openEnded("granted");
    const rows = within(ended).getAllByTestId("sharing-granted-row");
    expect(rows.map((row) => row.dataset.status)).toEqual(["revoked", "damaged"]);
    expect(rows[0]!.textContent).toBe("budget.csvWith sam@example.com");
    expect(within(rows[0]!).queryByRole("button")).toBeNull();
    expect(within(rows[1]!).getByTestId("sharing-row-status").textContent).toBe("Damaged");
  });
});

describe("Shared with me, by who shared", () => {
  const FROM_TWO = [
    received(),
    received({
      shareId: "in-2",
      grantId: "in-grant-2",
      subjectName: "roadmap.md",
      selector: { paths: ["notes/roadmap.md"], versionId: null },
      access: "edit",
    }),
    received({
      shareId: "in-3",
      grantId: "in-grant-3",
      granterUserId: "ana-id",
      sharerName: null,
      granterEmail: "ana@example.com",
      subjectName: "budget.csv",
      selector: { paths: ["budget.csv"], versionId: null },
    }),
  ];
  const RECEIVED_SHARE = {
    shareId: "in-2",
    shareCode: "code-2",
    access: "edit",
    selector: { paths: ["notes/roadmap.md"], versionId: null },
  };

  it("groups shares under who sent them, by name, each with its level and one action", async () => {
    answerWith({ received: answer("received", { rows: FROM_TWO }) });
    render(<View />);
    await showLane("received");
    const senders = await screen.findAllByTestId("sharing-sender");
    expect(senders.map((sender) => within(sender).getByRole("heading").textContent)).toEqual([
      "Aana@example.com",
      "SSam",
    ]);
    expect(within(senders[1]!).getByRole("heading").getAttribute("title")).toBe(
      "Sam (sam@example.com)",
    );
    const rows = within(senders[1]!).getAllByTestId("sharing-received-row");
    expect(rows.map((row) => row.dataset.shareId)).toEqual(["in-1", "in-2"]);
    expect(rows.map((row) => within(row).getByTestId("sharing-row-level").textContent)).toEqual([
      "Can view",
      "Can edit",
    ]);
    expect(rows.map((row) => within(row).getByTestId("sharing-row-primary").textContent)).toEqual([
      "Add to workspace",
      "Open to edit",
    ]);
    const menu = await openMenu(rows[1]!);
    expect(
      within(menu)
        .getAllByRole("menuitem", { hidden: true })
        .map((item) => item.textContent),
    ).toEqual(["Add to workspace", "Leave share…"]);
  });

  it("hands the shell an edit share to open in its own window", async () => {
    answerWith({ received: answer("received", { rows: FROM_TWO }) });
    bridgeMock.getRelayReceivedShare.mockResolvedValue({ found: true, share: RECEIVED_SHARE });
    render(<View />);
    await showLane("received");
    const row = (await screen.findAllByTestId("sharing-received-row")).find(
      (each) => each.dataset.shareId === "in-2",
    )!;
    await userEvent.click(within(row).getByRole("button", { name: "Open to edit" }));
    await waitFor(() =>
      expect(callbacks.onOpenShare).toHaveBeenCalledExactlyOnceWith({
        shareId: "in-2",
        shareCode: "code-2",
        liveEditing: true,
        share: expect.objectContaining({ shareId: "in-2" }),
      }),
    );
    expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledExactlyOnceWith({ shareId: "in-2" });
    expect(bridgeMock.mountShare).not.toHaveBeenCalled();
  });

  it("reports a share that could not be opened, with Try again", async () => {
    answerWith({ received: answer("received", { rows: FROM_TWO }) });
    bridgeMock.getRelayReceivedShare.mockRejectedValueOnce(new Error("offline"));
    bridgeMock.getRelayReceivedShare.mockResolvedValue({ found: true, share: RECEIVED_SHARE });
    render(<View />);
    await showLane("received");
    const row = (await screen.findAllByTestId("sharing-received-row")).find(
      (each) => each.dataset.shareId === "in-2",
    )!;
    await userEvent.click(within(row).getByRole("button", { name: "Open to edit" }));
    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
    expect(callbacks.reportError.mock.calls[0]![0]).toBe("dohc could not open this share.");
    expect(callbacks.onOpenShare).not.toHaveBeenCalled();
    await act(async () => callbacks.reportError.mock.calls[0]![2]());
    await waitFor(() => expect(callbacks.onOpenShare).toHaveBeenCalledOnce());
  });

  it("says a share added to the workspace is there, and that an edit share's copy is read-only", async () => {
    answerWith({ received: answer("received", { rows: FROM_TWO }) });
    render(
      <View
        mounts={[
          { shareId: "in-1", label: "funnel", granterEmail: "sam@example.com", access: "view" },
          { shareId: "in-2", label: "roadmap", granterEmail: "sam@example.com", access: "edit" },
        ]}
      />,
    );
    await showLane("received");
    const rows = await screen.findAllByTestId("sharing-received-row");
    const byShare = (shareId: string) => rows.find((row) => row.dataset.shareId === shareId)!;
    const view = within(byShare("in-1")).getByTestId("sharing-mounted");
    expect(view.textContent).toBe("In this workspace");
    expect(view.getAttribute("title")).toBe("shared-with-me/funnel");
    expect(within(byShare("in-1")).queryByTestId("sharing-row-primary")).toBeNull();
    expect(within(byShare("in-2")).getByTestId("sharing-mounted").textContent).toBe(
      "In this workspace as a read-only copy",
    );
    expect(within(byShare("in-2")).getByTestId("sharing-row-primary").textContent).toBe(
      "Open to edit",
    );
    expect(within(byShare("in-3")).queryByTestId("sharing-mounted")).toBeNull();
  });

  it("gives each ended share its own action, and no action for all of them", async () => {
    const ended = (shareId: string) =>
      received({
        shareId,
        grantId: `${shareId}-grant`,
        status: "removed",
        selector: null,
        access: null,
      });
    answerWith({
      received: answer("received", {
        rows: [received(), ended("gone-1"), ended("gone-2"), ended("gone-3")],
      }),
    });
    bridgeMock.leaveRelayShare.mockResolvedValue({ left: true });
    render(
      <View
        mounts={[
          { shareId: "gone-3", label: "kept", granterEmail: "sam@example.com", access: "view" },
        ]}
      />,
    );
    await showLane("received");
    const live = await screen.findAllByTestId("sharing-received-row");
    expect(live.map((row) => row.dataset.shareId)).toEqual(["in-1"]);
    expect(screen.getByTestId("sharing-received-count").textContent).toBe("1");
    expect(screen.getByTestId("sharing-received-ended-count").textContent).toBe("3");

    await openEnded("received");
    const group = screen.getByTestId("sharing-received-ended");
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Ended3", "Remove from list", "Remove from list", "Remove from workspace"]);
    expect(screen.queryByRole("button", { name: "Remove all" })).toBeNull();

    await userEvent.click(within(group).getAllByRole("button", { name: "Remove from list" })[0]!);
    await waitFor(() =>
      expect(bridgeMock.leaveRelayShare).toHaveBeenCalledExactlyOnceWith({
        shareId: "gone-1",
        ended: true,
      }),
    );
  });

  it("puts a copy whose record says it ended in Ended, also when the list is unknown or not all loaded", async () => {
    const ENDED_COPY: ShareMount = {
      shareId: "over-1",
      label: "old-notes",
      granterEmail: "sam@example.com",
      access: "view",
      ended: true,
    };
    answerWith({ received: UNKNOWN("received") });
    const { unmount } = render(<View facts={SIGNED_OUT} mounts={[ENDED_COPY]} />);
    await showLane("received");
    await screen.findByTestId("sharing-received-ended");
    expect(screen.queryByTestId("sharing-sender")).toBeNull();
    expect(screen.queryByTestId("sharing-mounted")).toBeNull();
    await openEnded("received");
    const row = screen.getByTestId("sharing-received-row");
    expect(row.dataset.status).toBe("removed");
    expect(within(row).getByRole("button", { name: "Remove from workspace" })).toBeTruthy();
    unmount();

    answerWith({
      received: answer("received", { rows: [received()], nextCursor: "page-2" }),
    });
    render(<View mounts={[ENDED_COPY]} />);
    await showLane("received");
    const sender = await screen.findByTestId("sharing-sender");
    expect(
      within(sender)
        .getAllByTestId("sharing-received-row")
        .map((each) => each.dataset.shareId),
    ).toEqual(["in-1"]);
    expect(screen.getByTestId("sharing-received-ended-count").textContent).toBe("1");
    await openEnded("received");
    expect(
      within(screen.getByTestId("sharing-received-ended")).getByTestId("sharing-received-row")
        .dataset.shareId,
    ).toBe("over-1");
  });

  it("calls a copy whose record says it ended ended, and keeps it ended after its folder goes until a newer list", async () => {
    const other = received({
      shareId: "in-2",
      grantId: "in-grant-2",
      subjectName: "roadmap.md",
      selector: { paths: ["notes/roadmap.md"], versionId: null },
    });
    const listedBefore = Date.now() - 60_000;
    let listing = answer("received", { rows: [received()], checkedAtMs: listedBefore });
    bridgeMock.listSharingAccess.mockImplementation(async ({ lane }) =>
      lane === "received" ? listing : answer(lane),
    );
    const liveShareIds = () =>
      screen
        .queryAllByTestId("sharing-sender")
        .flatMap((sender) => within(sender).getAllByTestId("sharing-received-row"))
        .map((each) => each.dataset.shareId);
    const { rerender } = render(
      <View
        mounts={[
          {
            shareId: "in-1",
            label: "funnel",
            granterEmail: "sam@example.com",
            access: "view",
            ended: true,
          },
        ]}
      />,
    );
    await showLane("received");
    await screen.findByTestId("sharing-received-ended");
    expect(screen.queryByTestId("sharing-sender")).toBeNull();
    expect(screen.getByTestId("sharing-received-count").textContent).toBe("0");
    expect(screen.getByTestId("sharing-received-ended-count").textContent).toBe("1");
    await openEnded("received");
    const row = screen.getByTestId("sharing-received-row");
    expect(row.dataset.status).toBe("removed");
    expect(within(row).queryByTestId("sharing-mounted")).toBeNull();
    expect(within(row).queryByRole("button", { name: "Share actions" })).toBeNull();
    listing = answer("received", { rows: [received(), other], checkedAtMs: listedBefore });
    await userEvent.click(within(row).getByRole("button", { name: "Remove from workspace" }));
    await waitFor(() =>
      expect(callbacks.onUnmount).toHaveBeenCalledExactlyOnceWith("shared-with-me/funnel"),
    );
    expect(bridgeMock.leaveRelayShare).not.toHaveBeenCalled();

    rerender(<View mounts={[]} />);
    await waitFor(() => expect(liveShareIds()).toEqual(["in-2"]));
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledTimes(2);
    const ended = within(screen.getByTestId("sharing-received-ended")).getByTestId(
      "sharing-received-row",
    );
    expect(ended.dataset.shareId).toBe("in-1");
    expect(ended.dataset.status).toBe("removed");
    expect(within(ended).queryByRole("button")).toBeNull();
    expect(screen.getByTestId("sharing-received-count").textContent).toBe("1");

    listing = answer("received", {
      rows: [received(), other],
      checkedAtMs: Date.now() + 60_000,
    });
    rerender(<View mounts={[]} facts={RECONNECTING} />);
    await waitFor(() => expect(liveShareIds()).toEqual(["in-1", "in-2"]));
    expect(screen.queryByTestId("sharing-received-ended")).toBeNull();
  });

  it("keeps a removed ended copy under Ended when Sharing is left and opened again on a list read since", async () => {
    let listing = answer("received", { rows: [received()], checkedAtMs: Date.now() - 60_000 });
    bridgeMock.listSharingAccess.mockImplementation(async ({ lane }) =>
      lane === "received" ? listing : answer(lane),
    );
    const { rerender } = render(
      <View
        mounts={[
          {
            shareId: "in-1",
            label: "funnel",
            granterEmail: "sam@example.com",
            access: "view",
            ended: true,
          },
        ]}
      />,
    );
    await showLane("received");
    await openEnded("received");
    await userEvent.click(
      within(screen.getByTestId("sharing-received-row")).getByRole("button", {
        name: "Remove from workspace",
      }),
    );
    await waitFor(() => expect(callbacks.onUnmount).toHaveBeenCalledOnce());

    rerender(<View open={false} mounts={[]} />);
    listing = answer("received", {
      rows: [received({ status: "removed", selector: null, access: null })],
      checkedAtMs: Date.now() + 60_000,
    });
    const refreshes = bridgeMock.requestAccessRefresh.mock.calls.length;
    rerender(<View mounts={[]} />);
    await showLane("received");
    await screen.findByTestId("sharing-received-ended");
    expect(bridgeMock.requestAccessRefresh.mock.calls.length).toBeGreaterThan(refreshes);
    expect(screen.queryByTestId("sharing-sender")).toBeNull();
    expect(screen.getByTestId("sharing-received-count").textContent).toBe("0");
    await openEnded("received");
    const ended = screen.getByTestId("sharing-received-row");
    expect(ended.dataset.status).toBe("removed");
    expect(within(ended).getByRole("button").textContent).toBe("Remove from list");
  });

  it("shows a copy's level from the list its actions go by, and from the copy's record only without one", async () => {
    const mounts: ShareMount[] = [
      { shareId: "in-1", label: "funnel", granterEmail: "sam@example.com", access: "view" },
    ];
    answerWith({ received: answer("received", { rows: [received({ access: "edit" })] }) });
    const { unmount } = render(<View mounts={mounts} />);
    const row = await receivedRow();
    expect(within(row).getByTestId("sharing-row-level").textContent).toBe("Can edit");
    expect(within(row).getByTestId("sharing-row-primary").textContent).toBe("Open to edit");
    expect(within(row).getByTestId("sharing-mounted").textContent).toBe(
      "In this workspace as a read-only copy",
    );
    unmount();

    answerWith({ received: UNKNOWN("received") });
    render(<View facts={SIGNED_OUT} mounts={mounts} />);
    const local = await receivedRow();
    expect(within(local).getByTestId("sharing-row-level").textContent).toBe("Can view");
    expect(within(local).queryByTestId("sharing-row-primary")).toBeNull();
  });

  it("counts only the shares the list confirms are live", async () => {
    answerWith({
      granted: answer("granted", { rows: [granted()] }),
      received: answer("received", {
        rows: [
          received(),
          received({
            shareId: "in-bad",
            grantId: "in-grant-bad",
            status: "damaged",
            selector: null,
            access: null,
          }),
        ],
        nextCursor: "page-2",
      }),
    });
    render(
      <View
        mounts={[
          { shareId: "local-1", label: "local", granterEmail: "kim@example.com", access: "view" },
        ]}
      />,
    );
    await showLane("received");
    const rows = await screen.findAllByTestId("sharing-received-row");
    expect(rows.map((row) => row.dataset.status).sort()).toEqual(["active", "damaged", "unlisted"]);
    expect(screen.getByTestId("sharing-received-count").textContent).toBe("1+1 or more shares");
  });

  it("keeps two senders with one name apart, by who they are", async () => {
    answerWith({
      received: answer("received", {
        rows: [
          received(),
          received({
            shareId: "in-2",
            grantId: "in-grant-2",
            granterUserId: "other-sam-id",
            granterEmail: "sam@other.example",
            subjectName: "roadmap.md",
            selector: { paths: ["notes/roadmap.md"], versionId: null },
          }),
          received({
            shareId: "in-3",
            grantId: "in-grant-3",
            granterEmail: "sam.new@example.com",
            subjectName: "budget.csv",
            selector: { paths: ["budget.csv"], versionId: null },
          }),
        ],
      }),
    });
    render(<View />);
    await showLane("received");
    const senders = await screen.findAllByTestId("sharing-sender");
    expect(senders.map((sender) => sender.dataset.sender)).toEqual([
      "user:sam-id",
      "user:other-sam-id",
    ]);
    expect(senders.map((sender) => within(sender).getByRole("heading").textContent)).toEqual([
      "SSam (sam@example.com)",
      "SSam (sam@other.example)",
    ]);
    expect(
      senders.map((sender) =>
        within(sender)
          .getAllByTestId("sharing-received-row")
          .map((row) => row.dataset.shareId),
      ),
    ).toEqual([["in-3", "in-1"], ["in-2"]]);
  });

  describe("Open to edit", () => {
    const EDITS = [
      FROM_TWO[1]!,
      received({
        shareId: "in-4",
        grantId: "in-grant-4",
        subjectName: "agenda.md",
        selector: { paths: ["notes/agenda.md"], versionId: null },
        access: "edit",
      }),
    ];
    const found = (shareId: string, access = "edit") => ({
      found: true,
      share: { ...RECEIVED_SHARE, shareId, shareCode: `code-${shareId}`, access },
    });
    async function openRow(shareId: string) {
      const row = (await screen.findAllByTestId("sharing-received-row")).find(
        (each) => each.dataset.shareId === shareId,
      )!;
      await userEvent.click(within(row).getByRole("button", { name: "Open to edit" }));
    }

    it("opens the share asked for last, whichever lookup answers last", async () => {
      answerWith({ received: answer("received", { rows: EDITS }) });
      const slow = deferred<unknown>();
      const fast = deferred<unknown>();
      bridgeMock.getRelayReceivedShare.mockImplementation(({ shareId }) =>
        shareId === "in-2" ? slow.promise : fast.promise,
      );
      render(<View />);
      await showLane("received");
      await openRow("in-2");
      await openRow("in-4");
      await act(async () => fast.resolve(found("in-4")));
      await waitFor(() =>
        expect(callbacks.onOpenShare).toHaveBeenCalledExactlyOnceWith({
          shareId: "in-4",
          shareCode: "code-in-4",
          liveEditing: true,
          share: expect.objectContaining({ shareId: "in-4" }),
        }),
      );
      await act(async () => slow.resolve(found("in-2")));
      expect(callbacks.onOpenShare).toHaveBeenCalledOnce();
      expect(callbacks.reportError).not.toHaveBeenCalled();
    });

    it("does nothing with a lookup that answers after the list was switched or the view closed", async () => {
      answerWith({ received: answer("received", { rows: EDITS }) });
      const switched = deferred<unknown>();
      const closed = deferred<unknown>();
      bridgeMock.getRelayReceivedShare
        .mockReturnValueOnce(switched.promise)
        .mockReturnValueOnce(closed.promise);
      const { rerender } = render(<View />);
      await showLane("received");
      await openRow("in-2");
      await showLane("granted");
      await act(async () => switched.resolve(found("in-2")));
      expect(callbacks.onOpenShare).not.toHaveBeenCalled();

      await showLane("received");
      await openRow("in-4");
      rerender(<View open={false} />);
      await act(async () => closed.reject(new Error("offline")));
      expect(callbacks.onOpenShare).not.toHaveBeenCalled();
      expect(callbacks.reportError).not.toHaveBeenCalled();
    });

    it("says a share the owner removed is no longer shared with you, and reads the list again", async () => {
      let rows = EDITS;
      bridgeMock.listSharingAccess.mockImplementation(async ({ lane }) =>
        answer(lane, { rows: lane === "received" ? rows : [] }),
      );
      bridgeMock.getRelayReceivedShare
        .mockResolvedValueOnce({
          found: false,
          removed: { message: "Sam removed your access to roadmap.md." },
        })
        .mockResolvedValueOnce({ found: false });
      render(<View />);
      await showLane("received");
      await screen.findAllByTestId("sharing-received-row");
      rows = [EDITS[1]!];
      await openRow("in-2");
      await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
      expect(callbacks.reportError.mock.calls[0]![0]).toBe(
        "Sam removed your access to roadmap.md.",
      );
      await waitFor(() =>
        expect(
          screen.getAllByTestId("sharing-received-row").map((row) => row.dataset.shareId),
        ).toEqual(["in-4"]),
      );
      expect(bridgeMock.listSharingAccess).toHaveBeenLastCalledWith({
        workspaceId: "workspace-a",
        lane: "received",
      });

      await openRow("in-4");
      await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledTimes(2));
      expect(callbacks.reportError.mock.calls[1]![0]).toBe(
        "This item is no longer shared with you.",
      );
      expect(callbacks.onOpenShare).not.toHaveBeenCalled();
    });

    it("does not open a share the owner has since made view only, says so, and reads the list again", async () => {
      answerWith({ received: answer("received", { rows: EDITS }) });
      bridgeMock.getRelayReceivedShare.mockResolvedValue(found("in-2", "view"));
      render(<View />);
      await showLane("received");
      const reads = bridgeMock.listSharingAccess.mock.calls.length;
      await openRow("in-2");
      await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledOnce());
      expect(callbacks.reportError.mock.calls[0]![0]).toBe(
        "The owner changed your access to this share. It no longer opens to edit.",
      );
      expect(callbacks.onOpenShare).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(bridgeMock.listSharingAccess.mock.calls.length).toBeGreaterThan(reads),
      );
      expect(bridgeMock.listSharingAccess).toHaveBeenLastCalledWith({
        workspaceId: "workspace-a",
        lane: "received",
      });
    });
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

it("marks both lists as possibly out of date while a paced check waits, then reads them again", async () => {
  vi.useFakeTimers();
  try {
    let rows: AccessShareRow[] = [];
    bridgeMock.requestAccessRefresh.mockImplementation(async (input) => {
      if (!input.wait) return { status: "paced" };
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      rows = [granted()];
      return { status: "joined" };
    });
    bridgeMock.listSharingAccess.mockImplementation(async ({ lane }) =>
      lane === "granted" ? answer("granted", { rows }) : answer("received"),
    );
    render(<View />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Sharing shows one list at a time; both read while the check waits.
    const freshness = async (lane: Lane) => {
      act(() => screen.getByRole("radio", { name: LANE_NAME[lane] }).click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      return screen.getByTestId(`sharing-${lane}-freshness`);
    };
    for (const lane of ["received", "granted"] as const) {
      const mark = await freshness(lane);
      expect(mark.getAttribute("data-state")).toBe("stale");
      expect(mark.textContent).toContain("May be out of date");
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    for (const lane of ["received", "granted"] as const)
      expect((await freshness(lane)).getAttribute("data-state")).toBe("fresh");
    expect(screen.getAllByTestId("sharing-granted-row")).toHaveLength(1);
    expect(bridgeMock.requestAccessRefresh.mock.calls.filter(([input]) => input.wait)).toHaveLength(
      1,
    );
  } finally {
    vi.useRealTimers();
  }
});
