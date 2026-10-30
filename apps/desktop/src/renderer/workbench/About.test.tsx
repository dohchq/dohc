// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessAnswer, AccessShareRow } from "@dohc/workspace-contracts/access";
import type { ChatFileMentionsPage } from "@dohc/workspace-contracts/chat-file-mentions";
import type { LinksInResult } from "@dohc/workspace-contracts/links";
import { DaemonRefusalError } from "@dohc/workspace-engine-client";
import type { ActorPresentation, ChatFileMentionRecord, DohcDesktopBridge, EngineMomentRecord, ListEngineMomentsResponse } from "../../ipc/bridgeContract";
import { ipcWireError } from "../../ipc/errorWords";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { deferred } from "../../testing/deferred";
import { historyCursor, historyPageFields } from "../../testing/historyPageFixture";
import { formatChatTime, formatShortTime } from "../time";
import { AboutAccess, AboutHistory, AboutHistoryView, AboutHeader, AboutLinks, accessReasonFor, type AboutFile } from "./About";
import type { AccessFacts } from "./accessReason";
import { setChosenColors } from "./chosenColors";
import { settingsWithAgent } from "../../testing/agentSettings";

const bridgeMock = {
  getObjectAccess: vi.fn<(input: { workspaceId: string; ref: unknown; cursor?: string }) => Promise<AccessAnswer>>(),
  requestAccessRefresh: vi.fn<(input: { workspaceId: string; reason: string }) => Promise<void>>(),
  listEngineMoments: vi.fn<(input: { workspaceId: string; objectId?: string; limit?: number }) => Promise<ListEngineMomentsResponse>>(),
  linksIn: vi.fn<DohcDesktopBridge["linksIn"]>(),
  chatFileMentionsPage: vi.fn<DohcDesktopBridge["chatFileMentionsPage"]>(),
};

// The shell's error hook: the same object every render, as the shell's is.
const notices = { report: vi.fn(), clear: vi.fn() };
const openSyncSettings = vi.fn();
const connect = vi.fn();
// A workspace that syncs, with its account signed in.
const SYNCED: AccessFacts = { cloud: { connected: true, workspaceSynced: true, workspaceSyncConnected: true }, shareView: false };
const NOT_SYNCED: AccessFacts = { cloud: { connected: true, workspaceSynced: false, workspaceSyncConnected: false }, shareView: false };
const SIGNED_OUT: AccessFacts = { cloud: { connected: false, workspaceSynced: true, workspaceSyncConnected: false }, shareView: false };
const OTHER_ACCOUNT: AccessFacts = { cloud: { connected: true, workspaceSynced: true, workspaceSyncConnected: false }, shareView: false };
const CHECKING: AccessFacts = { cloud: "checking", shareView: false };
const UNREADABLE: AccessFacts = { cloud: "unreadable", shareView: false };

beforeEach(() => {
  for (const mock of [...Object.values(bridgeMock), notices.report, notices.clear, openSyncSettings, connect]) mock.mockReset();
  bridgeMock.requestAccessRefresh.mockResolvedValue(undefined);
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CHECKED_AT = Date.UTC(2026, 9, 9, 9, 30);

function answer(overrides: Partial<AccessAnswer> = {}): AccessAnswer {
  return {
    ref: { kind: "path", path: "docs/plan.md", versionId: null },
    rows: [],
    visibility: "visible",
    unknownReason: null, coverage: { kind: "granted", complete: true, observation: "interval" },
    checkedAtMs: CHECKED_AT,
    freshness: "fresh",
    nextCursor: null,
    ...overrides,
  };
}

// What main answers when it has no observation to read: no coverage at all.
const UNKNOWN = answer({
  unknownReason: "not-listed-yet", coverage: { kind: "unavailable", complete: false, observation: "interval" },
  checkedAtMs: null,
  freshness: "unknown",
});

function share(overrides: Partial<AccessShareRow> = {}): AccessShareRow {
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
    selector: { paths: ["docs"], versionId: null },
    access: "edit",
    status: "active",
    generation: 1,
    ...overrides,
  };
}

// One context per facts object, the same object every render as the shell's.
const contexts = new Map<AccessFacts, { facts: AccessFacts; openSyncSettings: () => void; connect: () => void }>();
function contextFor(facts: AccessFacts) {
  let context = contexts.get(facts);
  if (!context) {
    context = { facts, openSyncSettings, connect };
    contexts.set(facts, context);
  }
  return context;
}

function Access(props: { workspaceId?: string; path?: string; open?: boolean; facts?: AccessFacts }) {
  const [open, setOpen] = useState(props.open ?? true);
  return (
    <AboutAccess
      workspaceId={props.workspaceId ?? "workspace-a"}
      subject={{ kind: "path", path: props.path ?? "docs/plan.md" }}
      expanded={open}
      onToggle={() => setOpen((current) => !current)}
      notices={notices}
      context={contextFor(props.facts ?? SYNCED)}
    />
  );
}

function ChatAccess(props: { channelWireId: string; received: boolean | null; facts?: AccessFacts }) {
  return (
    <AboutAccess
      workspaceId="workspace-a"
      subject={{ kind: "chat", channelWireId: props.channelWireId }}
      received={props.received}
      expanded
      onToggle={() => undefined}
      notices={notices}
      context={contextFor(props.facts ?? SYNCED)}
    />
  );
}

describe("the cause of an Access answer that covers nothing", () => {
  it("follows main for the workspace's own files", () => {
    expect(accessReasonFor(CHECKING, "docs/plan.md")).toBe("checking");
    expect(accessReasonFor(NOT_SYNCED, "docs/plan.md")).toBe("not-synced");
    // Not syncing comes first: signing in would not give it a list.
    expect(accessReasonFor({ ...NOT_SYNCED, cloud: { connected: false, workspaceSynced: false, workspaceSyncConnected: false } }, "docs/plan.md")).toBe("not-synced");
    expect(accessReasonFor(SIGNED_OUT, "docs/plan.md")).toBe("signed-out");
    expect(accessReasonFor(OTHER_ACCOUNT, "docs/plan.md")).toBe("other-account");
    expect(accessReasonFor(SYNCED, "docs/plan.md")).toBe("unexplained");
  });

  it("asks only for an account for files a share sent here, whether or not the workspace syncs", () => {
    const signedOutLocal: AccessFacts = { cloud: { connected: false, workspaceSynced: false, workspaceSyncConnected: false }, shareView: false };
    expect(accessReasonFor(signedOutLocal, "shared-with-me/alex/notes.md")).toBe("signed-out");
    expect(accessReasonFor(NOT_SYNCED, "shared-with-me/alex/notes.md")).toBe("unexplained");
    expect(accessReasonFor({ ...signedOutLocal, shareView: true }, "notes.md")).toBe("signed-out");
    // Signed in, main may still refuse a share sent to another account or
    // server; the renderer cannot tell that from a list not yet received.
    expect(accessReasonFor({ ...NOT_SYNCED, shareView: true }, "notes.md")).toBe("unexplained");
    expect(accessReasonFor({ ...CHECKING, shareView: true }, "notes.md")).toBe("checking");
  });

  it("names nothing once the server connection could not be read: the shell reports that failure", () => {
    expect(accessReasonFor(UNREADABLE, "docs/plan.md")).toBe("unexplained");
    expect(accessReasonFor({ ...UNREADABLE, shareView: true }, "notes.md")).toBe("unexplained");
  });
});

describe("About Access", () => {
  it("asks nothing while closed, then refreshes and reads when opened", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(answer({ rows: [share()] }));
    render(<Access open={false} />);
    expect(bridgeMock.requestAccessRefresh).not.toHaveBeenCalled();
    expect(bridgeMock.getObjectAccess).not.toHaveBeenCalled();
    expect(screen.queryByTestId("about-access-count")).toBeNull();

    await userEvent.setup().click(screen.getByTestId("about-access-toggle"));
    expect(screen.getByTestId("about-access-toggle").getAttribute("aria-expanded")).toBe("true");
    await screen.findByTestId("about-access-answer");
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledWith({ workspaceId: "workspace-a", reason: "access-expand" });
    expect(bridgeMock.getObjectAccess).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      ref: { kind: "path", path: "docs/plan.md", versionId: null },
    });
    expect(bridgeMock.requestAccessRefresh.mock.invocationCallOrder[0]).toBeLessThan(
      bridgeMock.getObjectAccess.mock.invocationCallOrder[0]!,
    );
    expect(notices.clear).toHaveBeenCalledWith("about-access:file:docs/plan.md");
  });

  it("shows nothing it has not read while the answer loads", async () => {
    const pending = deferred<AccessAnswer>();
    bridgeMock.getObjectAccess.mockReturnValue(pending.promise);
    render(<Access />);
    await waitFor(() => expect(bridgeMock.getObjectAccess).toHaveBeenCalled());
    expect(screen.queryByTestId("about-access-answer")).toBeNull();
    expect(screen.queryByTestId("about-access-empty")).toBeNull();
    expect(screen.queryByTestId("about-access-count")).toBeNull();
    await act(async () => pending.resolve(answer()));
    expect(screen.getByTestId("about-access-empty")).toBeTruthy();
  });

  it("lists each grant with its person or link and its level, and counts only active grants", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(
      answer({
        rows: [
          share({ via: "link", grantId: "grant-link", recipientEmail: null, recipientUserId: null, access: "view" }),
          share(),
          share({ grantId: "grant-old", recipientEmail: "kim@example.com", status: "revoked", access: null }),
          share({ grantId: "grant-gone", recipientEmail: "lee@example.com", status: "removed", access: null }),
        ],
      }),
    );
    render(<Access />);
    const result = await screen.findByTestId("about-access-answer");
    expect(result.dataset.freshness).toBe("fresh");
    expect(result.dataset.coverage).toBe("granted");
    // A fresh answer keeps when it was checked in its head's tooltip.
    expect(screen.queryByTestId("about-access-freshness")).toBeNull();
    expect(screen.getByTitle(`Checked ${formatChatTime(CHECKED_AT).label}`)).toBeTruthy();
    const rows = screen.getAllByTestId("about-access-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Anyone with the link", "Ssam@example.com", "Kkim@example.comended", "Llee@example.comended",
    ]);
    expect(within(rows[0]!).getByRole("img", { name: "View" })).toBeTruthy();
    expect(within(rows[1]!).getByRole("img", { name: "Edit" })).toBeTruthy();
    expect(within(rows[2]!).queryByRole("img")).toBeNull();
    // Two grants give access now; the two ended ones stay listed.
    expect(screen.getByTestId("about-access-count").textContent).toBe("2");
  });

  it("shows Only you when a complete answer finds no share from this workspace", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(answer());
    render(<Access />);
    expect((await screen.findByTestId("about-access-empty")).textContent).toBe("Only you");
    expect(screen.queryByTestId("about-access-count")).toBeNull();
  });

  it("claims nothing for a listing that did not finish, and shows only its freshness", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(
      answer({ coverage: { kind: "granted", complete: false, observation: "interval" } }),
    );
    render(<Access />);
    expect(await screen.findByTestId("about-access-freshness")).toBeTruthy();
    expect(screen.queryByTestId("about-access-empty")).toBeNull();
    expect(screen.queryByTestId("about-access-row")).toBeNull();
  });

  it("says no share to you includes a received file it finds nothing for", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(
      answer({ unknownReason: null, coverage: { kind: "received-own-grant", complete: true, observation: "interval" } }),
    );
    render(<Access />);
    expect((await screen.findByTestId("about-access-empty")).textContent).toBe("No share to you includes this file.");
  });

  it("names a received file's own grant within its coverage", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(
      answer({
        unknownReason: null, coverage: { kind: "received-own-grant", complete: true, observation: "interval" },
        rows: [share({ via: "received", sharerName: "Ice de Vera", access: "comment" })],
      }),
    );
    render(<Access />);
    const row = await screen.findByTestId("about-access-row");
    expect(row.textContent).toContain("You");
    expect(row.getAttribute("title")).toBe("Shared by Ice de Vera");
    expect(within(row).getByRole("img", { name: "Comment" })).toBeTruthy();
  });

  it("keeps a stale list and marks it settled but old", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(answer({ freshness: "stale", rows: [share()] }));
    render(<Access />);
    const result = await screen.findByTestId("about-access-answer");
    expect(result.dataset.freshness).toBe("stale");
    const mark = screen.getByTestId("about-access-freshness");
    expect(mark.textContent).toBe("May be out of date");
    expect(mark.getAttribute("data-state")).toBe("stale");
    expect(mark.querySelector(".lucide-clock")).toBeTruthy();
    expect(screen.getAllByTestId("about-access-row")).toHaveLength(1);
    expect(screen.getByTestId("about-access-count").textContent).toBe("1");
  });

  it("tells a cause it cannot name apart from no access, and checks again on Try again", async () => {
    bridgeMock.getObjectAccess.mockResolvedValueOnce(UNKNOWN).mockResolvedValue(answer());
    render(<Access />);
    const unknown = await screen.findByTestId("about-access-unknown");
    expect(unknown.dataset.reason).toBe("unexplained");
    expect(unknown.textContent).toContain(
      "Access information is unavailable for this file. This does not mean that no one has access.",
    );
    expect(screen.getByTestId("about-access-freshness").textContent).toBe("Unknown");
    expect(screen.queryByTestId("about-access-empty")).toBeNull();
    expect(screen.queryByTestId("about-access-count")).toBeNull();

    await userEvent.setup().click(within(unknown).getByText("Try again"));
    await screen.findByTestId("about-access-empty");
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["not-synced", NOT_SYNCED, "Shares need sync, and this workspace does not sync.", "Sync and sharing", openSyncSettings],
    ["signed-out", SIGNED_OUT, "Connect your server to check who has access.", "Connect server", connect],
    ["other-account", OTHER_ACCOUNT, "dohc could not confirm this workspace's account, so it isn't syncing. Resume sync to check who has access.", "Sync and sharing", openSyncSettings],
  ] as const)("says why an answer covers nothing when %s, with the one action that can change it", async (reason, facts, words, label, action) => {
    bridgeMock.getObjectAccess.mockResolvedValue(UNKNOWN);
    render(<Access facts={facts} />);
    const unknown = await screen.findByTestId("about-access-unknown");
    expect(unknown.dataset.reason).toBe(reason);
    expect(unknown.textContent).toContain(words);
    // A cause dohc can name is not a failure: no red mark, and no Try again
    // that can never succeed.
    expect(screen.queryByTestId("about-access-freshness")).toBeNull();
    expect(within(unknown).queryByText("Try again")).toBeNull();
    expect(screen.queryByTestId("about-access-count")).toBeNull();
    await userEvent.setup().click(within(unknown).getByText(label));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("asks who has access to a file shared here, not what others share", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(UNKNOWN);
    render(<Access path="shared-with-me/alex/notes.md" facts={SIGNED_OUT} />);
    const unknown = await screen.findByTestId("about-access-unknown");
    expect(unknown.dataset.reason).toBe("signed-out");
    expect(unknown.querySelector("p")?.textContent).toBe("Connect your server to check who has access.");
    await userEvent.setup().click(within(unknown).getByRole("button", { name: "Connect server" }));
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["hidden", "Shares do not include this file."],
    ["missing", "This file is no longer available at this path."],
  ] as const)("says what main found for a %s file whatever the account", async (visibility, words) => {
    bridgeMock.getObjectAccess.mockResolvedValue({ ...UNKNOWN, visibility, unknownReason: null });
    render(<Access facts={SIGNED_OUT} />);
    const unknown = await screen.findByTestId("about-access-unknown");
    expect(unknown.dataset.reason).toBe(visibility);
    expect(unknown.textContent).toBe(words);
    expect(within(unknown).queryByRole("button")).toBeNull();
  });

  it("still reads when the refresh request fails, and the answer says how current it is", async () => {
    bridgeMock.requestAccessRefresh.mockRejectedValue(new Error("offline"));
    bridgeMock.getObjectAccess.mockResolvedValue(answer({ freshness: "stale" }));
    render(<Access />);
    expect((await screen.findByTestId("about-access-answer")).dataset.freshness).toBe("stale");
    expect(notices.report).not.toHaveBeenCalled();
  });

  it("reports a failed read to the shell, shows only Try again, and clears the row once a read answers", async () => {
    const error = new Error("disk is busy");
    bridgeMock.getObjectAccess.mockRejectedValueOnce(error).mockResolvedValue(answer());
    render(<Access />);
    const failed = await screen.findByTestId("about-access-failed");
    expect(failed.textContent).toBe("Try again");
    expect(notices.report).toHaveBeenCalledWith({
      identity: "about-access:file:docs/plan.md",
      message: expect.stringContaining("disk is busy"),
      cause: error,
      retry: expect.any(Function),
    });
    await userEvent.setup().click(within(failed).getByText("Try again"));
    await screen.findByTestId("about-access-empty");
    expect(notices.clear).toHaveBeenLastCalledWith("about-access:file:docs/plan.md");
  });

  it("reads again from its Notices row's Try again", async () => {
    bridgeMock.getObjectAccess.mockRejectedValueOnce(new Error("disk is busy")).mockResolvedValue(answer());
    render(<Access />);
    await waitFor(() => expect(notices.report).toHaveBeenCalledTimes(1));
    act(() => (notices.report.mock.calls[0]![0].retry as () => void)());
    await screen.findByTestId("about-access-empty");
  });

  it("takes a file's row with it when the file leaves About, so rows never pile up", async () => {
    bridgeMock.getObjectAccess.mockRejectedValue(new Error("disk is busy"));
    const { rerender, unmount } = render(<Access path="docs/plan.md" />);
    await waitFor(() => expect(notices.report).toHaveBeenCalledTimes(1));
    rerender(<Access path="docs/other.md" />);
    await waitFor(() => expect(notices.report).toHaveBeenCalledTimes(2));
    expect(notices.clear).toHaveBeenCalledWith("about-access:file:docs/plan.md");
    // Each file files its own row, cleared before the next file reports.
    expect(notices.report.mock.calls.map(([failure]) => failure.identity)).toEqual([
      "about-access:file:docs/plan.md", "about-access:file:docs/other.md",
    ]);
    unmount();
    expect(notices.clear).toHaveBeenLastCalledWith("about-access:file:docs/other.md");
  });

  it("ends a row when the read key changes, even for the same path", async () => {
    bridgeMock.getObjectAccess.mockRejectedValue(new Error("disk is busy"));
    const { rerender } = render(<Access workspaceId="workspace-a" path="docs/plan.md" />);
    await waitFor(() => expect(notices.report).toHaveBeenCalledTimes(1));
    const clears = notices.clear.mock.calls.length;
    rerender(<Access workspaceId="workspace-b" path="docs/plan.md" />);
    expect(notices.clear.mock.calls.slice(clears).map(([identity]) => identity)).toContain("about-access:file:docs/plan.md");
  });

  it("neither reports nor clears when workspace A's read fails after the switch to B", async () => {
    const forA = deferred<AccessAnswer>();
    bridgeMock.getObjectAccess.mockImplementation(({ workspaceId }) =>
      workspaceId === "workspace-a" ? forA.promise : Promise.resolve(answer()));
    const { rerender } = render(<Access workspaceId="workspace-a" />);
    await waitFor(() => expect(bridgeMock.getObjectAccess).toHaveBeenCalledTimes(1));
    rerender(<Access workspaceId="workspace-b" />);
    await screen.findByTestId("about-access-empty");
    const clears = notices.clear.mock.calls.length;
    await act(async () => {
      forA.reject(new Error("disk is busy"));
      await forA.promise.catch(() => undefined);
    });
    expect(notices.report).not.toHaveBeenCalled();
    expect(notices.clear.mock.calls.length).toBe(clears);
    expect(screen.queryByTestId("about-access-failed")).toBeNull();
  });

  it("claims nothing and asks no refresh while the server connection is read, then refreshes once it is", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(UNKNOWN);
    const { rerender } = render(<Access facts={CHECKING} />);
    await waitFor(() => expect(bridgeMock.getObjectAccess).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(screen.queryByTestId("about-access-unknown")).toBeNull();
    expect(screen.queryByTestId("about-access-freshness")).toBeNull();
    expect(bridgeMock.requestAccessRefresh).not.toHaveBeenCalled();
    rerender(<Access facts={SIGNED_OUT} />);
    expect((await screen.findByTestId("about-access-unknown")).dataset.reason).toBe("signed-out");
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes once per sign-in, though the status is read twice through checking", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(answer());
    const { rerender } = render(<Access facts={SIGNED_OUT} />);
    await screen.findByTestId("about-access-empty");
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledTimes(1);
    // The session changes: "changing", then "ready", each read from scratch.
    for (const facts of [CHECKING, SYNCED, CHECKING, SYNCED]) {
      rerender(<Access facts={facts} />);
      await act(async () => undefined);
    }
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledTimes(2);
  });

  it("names no cause, and stops loading, once the server connection could not be read", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(UNKNOWN);
    render(<Access facts={UNREADABLE} />);
    const unknown = await screen.findByTestId("about-access-unknown");
    expect(unknown.dataset.reason).toBe("unexplained");
    expect(within(unknown).getByText("Try again")).toBeTruthy();
  });

  it("refreshes and reads again when Connect server changes the connection", async () => {
    bridgeMock.getObjectAccess.mockResolvedValueOnce(UNKNOWN).mockResolvedValue(answer({ rows: [share()] }));
    const { rerender } = render(<Access facts={SIGNED_OUT} />);
    await screen.findByTestId("about-access-unknown");
    rerender(<Access facts={SYNCED} />);
    expect(await screen.findByTestId("about-access-row")).toBeTruthy();
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("about-access-unknown")).toBeNull();
  });

  it("never shows workspace A's answer after a switch to workspace B", async () => {
    const forA = deferred<AccessAnswer>();
    bridgeMock.getObjectAccess.mockImplementation(({ workspaceId }) =>
      workspaceId === "workspace-a" ? forA.promise : Promise.resolve(answer({ rows: [share({ recipientEmail: "b@example.com" })] })),
    );
    const { rerender } = render(<Access workspaceId="workspace-a" />);
    await waitFor(() => expect(bridgeMock.getObjectAccess).toHaveBeenCalledTimes(1));
    rerender(<Access workspaceId="workspace-b" />);
    expect((await screen.findByTestId("about-access-row")).textContent).toContain("b@example.com");

    await act(async () => forA.resolve(answer({ rows: [share({ recipientEmail: "a@example.com" })] })));
    expect(screen.getAllByTestId("about-access-row").map((row) => row.textContent)).toEqual(["Bb@example.com"]);
  });

  it("reads a newly opened file without asking main to refresh again", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(answer());
    const { rerender } = render(<Access path="docs/plan.md" />);
    await screen.findByTestId("about-access-empty");
    rerender(<Access path="docs/other.md" />);
    await waitFor(() =>
      expect(bridgeMock.getObjectAccess).toHaveBeenLastCalledWith({
        workspaceId: "workspace-a",
        ref: { kind: "path", path: "docs/other.md", versionId: null },
      }),
    );
    expect(bridgeMock.requestAccessRefresh).toHaveBeenCalledTimes(1);
  });

  it("asks about a chat by its wire identity, in a chat's words", async () => {
    bridgeMock.getObjectAccess.mockResolvedValueOnce(answer({ ref: { kind: "chat", channelWireId: "wire-general" } }))
      .mockRejectedValueOnce(new Error("disk is busy"));
    const { rerender } = render(<ChatAccess channelWireId="wire-general" received={false} />);
    expect((await screen.findByTestId("about-access-empty")).textContent).toBe("Only you");
    expect(bridgeMock.getObjectAccess).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      ref: { kind: "chat", channelWireId: "wire-general" },
    });
    rerender(<ChatAccess channelWireId="wire-launch" received={false} />);
    await screen.findByTestId("about-access-failed");
    expect(notices.report).toHaveBeenCalledWith(expect.objectContaining({ identity: "about-access:chat:wire-launch" }));
    expect(notices.clear).toHaveBeenCalledWith("about-access:chat:wire-general");
  });

  it("keeps a file named like a chat apart from that chat", async () => {
    bridgeMock.getObjectAccess.mockRejectedValue(new Error("disk is busy"));
    const { unmount } = render(<Access path="chat:abc" />);
    await waitFor(() => expect(notices.report).toHaveBeenCalledTimes(1));
    unmount();
    render(<ChatAccess channelWireId="abc" received={false} />);
    await waitFor(() => expect(notices.report).toHaveBeenCalledTimes(2));
    expect(notices.report.mock.calls.map(([failure]) => failure.identity)).toEqual([
      "about-access:file:chat:abc", "about-access:chat:abc",
    ]);
  });

  it.each([
    [false, NOT_SYNCED, "not-synced"],
    [true, NOT_SYNCED, "unexplained"],
    [true, SIGNED_OUT, "signed-out"],
    [null, SIGNED_OUT, "unexplained"],
  ] as const)("explains an unknown chat answer by its share lane (received %s)", async (received, facts, reason) => {
    bridgeMock.getObjectAccess.mockResolvedValue({ ...UNKNOWN, ref: { kind: "chat", channelWireId: "wire-general" } });
    render(<ChatAccess channelWireId="wire-general" received={received} facts={facts} />);
    const unknown = await screen.findByTestId("about-access-unknown");
    expect(unknown.dataset.reason).toBe(reason);
    if (reason === "unexplained") {
      expect(unknown.textContent).toContain("Access information is unavailable for this chat.");
    }
  });

  it("says a chat main cannot find is gone", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue({ ...UNKNOWN, visibility: "missing", unknownReason: null });
    render(<ChatAccess channelWireId="wire-general" received={false} />);
    expect((await screen.findByTestId("about-access-unknown")).textContent).toBe("This chat is no longer in this workspace.");
  });

  it("names a hidden local chat in a share view as a chat", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue({ ...UNKNOWN, ref: { kind: "chat", channelWireId: "wire-local" }, visibility: "hidden", unknownReason: null });
    render(<ChatAccess channelWireId="wire-local" received={false} facts={{ ...SYNCED, shareView: true }} />);
    const unknown = await screen.findByTestId("about-access-unknown");
    expect(unknown.dataset.reason).toBe("hidden");
    expect(unknown.textContent).toBe("Shares do not include this chat.");
    expect(within(unknown).queryByRole("button")).toBeNull();
  });

  it("does not read again when only the chat's share lane becomes known", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(answer());
    const { rerender } = render(<ChatAccess channelWireId="wire-general" received={null} />);
    await screen.findByTestId("about-access-empty");
    rerender(<ChatAccess channelWireId="wire-general" received={false} />);
    await act(async () => undefined);
    expect(bridgeMock.getObjectAccess).toHaveBeenCalledTimes(1);
  });

  it("reads the next page from the answer's cursor", async () => {
    bridgeMock.getObjectAccess
      .mockResolvedValueOnce(answer({ rows: [share()], nextCursor: "page-2" }))
      .mockResolvedValueOnce(answer({ rows: [share({ grantId: "grant-2", recipientEmail: "kim@example.com" })] }));
    render(<Access />);
    expect((await screen.findByTestId("about-access-count")).textContent).toBe("1+");
    await userEvent.setup().click(screen.getByTestId("about-access-more"));
    await waitFor(() => expect(screen.getAllByTestId("about-access-row")).toHaveLength(2));
    expect(bridgeMock.getObjectAccess).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-2" }));
    expect(screen.queryByTestId("about-access-more")).toBeNull();
  });

  it("reads from the start when the listing changed under its cursor", async () => {
    bridgeMock.getObjectAccess
      .mockResolvedValueOnce(answer({ rows: [share()], nextCursor: "page-2" }))
      // Main refuses a cursor from an older listing with an unknown answer.
      .mockResolvedValueOnce({ ...UNKNOWN, visibility: "unknown" })
      .mockResolvedValueOnce(answer({ rows: [share(), share({ grantId: "grant-new", recipientEmail: "new@example.com" })] }));
    render(<Access />);
    await screen.findByTestId("about-access-more");
    await userEvent.setup().click(screen.getByTestId("about-access-more"));
    await waitFor(() => expect(screen.getAllByTestId("about-access-row")).toHaveLength(2));
    expect(screen.getAllByTestId("about-access-row")[1]!.textContent).toContain("new@example.com");
    expect(bridgeMock.getObjectAccess.mock.calls[2]![0]).not.toHaveProperty("cursor");
    expect(screen.queryByTestId("about-access-unknown")).toBeNull();
  });
});

type LinksPage = NonNullable<LinksInResult>;
type LinkRecord = LinksPage["entries"][number];

// A link from `source` at `line`, its words marked in the line around them.
function link(source: string, line: number, ordinal = 0): LinkRecord {
  const title = source.split("/").at(-1)!.replace(/\.md$/, "");
  const snippet = `${title} cites [[plan]] here.`;
  const start = snippet.indexOf("[[");
  return { source, title, ordinal, span: [start, start + 8], line, snippet, highlightStart: start, highlightEnd: start + 8 };
}

function linksPage(entries: LinkRecord[], overrides: Partial<LinksPage> = {}): LinksPage {
  return {
    versionId: "main", subject: { path: "docs/plan.md", objectId: "plan" }, entries, unchecked: [],
    complete: true, indexBuilding: false, mountsCovered: true, nextCursor: null, ...overrides,
  };
}

function chatLink(id: string, overrides: Partial<ChatFileMentionRecord> = {}): ChatFileMentionRecord {
  return {
    attachment: {
      attachmentId: `attachment-${id}`, threadId: `thread-${id}`, messageId: `message-${id}`, targetKind: "file",
      objectId: "plan", pathHint: "docs/plan.md", createdAtMs: CHECKED_AT,
    },
    message: { id: `message-${id}`, authorDisplayName: "Sam", preview: `See docs/plan.md ${id}`, createdAtMs: CHECKED_AT },
    thread: { id: `thread-${id}`, title: `Thread ${id}`, createdAtMs: CHECKED_AT, updatedAtMs: CHECKED_AT },
    ...overrides,
  };
}

function chatPage(entries: ChatFileMentionRecord[], nextCursor: string | null = null): NonNullable<ChatFileMentionsPage> {
  return {
    versionId: "main", subject: { objectId: "plan", path: "docs/plan.md" }, entries, unchecked: [], complete: true,
    indexBuilding: false, mountsCovered: true, sharedChannelRowsUncovered: 0, nextCursor,
  };
}

// How the engine refuses a read while it reads a new workspace's files.
const updating = (channel: string) => new Error(`Error invoking remote method '${channel}': ${String(ipcWireError(new DaemonRefusalError(
  { code: "OVERLOADED", message: "Workspace is still updating. Try again.", retry: "afterBackoff" }, null)))}`);

// IntersectionObserver for rows that are in view: it reports once on
// observe, as the browser's first report does. What it returns scrolls every
// observed row out of view and back, so each reports again.
function observeAllInView() {
  const live = new Set<() => void>();
  vi.stubGlobal("IntersectionObserver", class {
    private report: (() => void) | null = null;
    private readonly callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      const report = () =>
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      this.report = report;
      live.add(report);
      void Promise.resolve().then(() => {
        if (live.has(report)) report();
      });
    }
    disconnect() {
      if (this.report) live.delete(this.report);
    }
  });
  return async () => {
    for (let pass = 0; pass < 3; pass += 1) {
      act(() => {
        for (const report of live) report();
      });
      await settleAll();
    }
  };
}

// IntersectionObserver reported by hand. `watching` waits until React has
// run the effect that observes `target`, with an observer other than
// `before`; `report` says the row came into view.
type Observed = { callback: IntersectionObserverCallback; target: Element | null; live: boolean };
function observeByHand() {
  const observers: Observed[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    private readonly record: Observed;
    constructor(callback: IntersectionObserverCallback) {
      this.record = { callback, target: null, live: true };
      observers.push(this.record);
    }
    observe(target: Element) {
      this.record.target = target;
    }
    disconnect() {
      this.record.live = false;
    }
  });
  return {
    watching: (target: Element, before?: Observed) => waitFor(() => {
      const live = observers.filter((entry) => entry.live);
      expect(live).toHaveLength(1);
      expect(live[0]).not.toBe(before);
      expect(live[0]!.target).toBe(target);
      return live[0]!;
    }),
    report: (observer: Observed) =>
      observer.callback([{ isIntersecting: true, target: observer.target! } as IntersectionObserverEntry], {} as IntersectionObserver),
  };
}

// Lets every answer, render and observer report that is already due land.
async function settleAll() {
  for (let round = 0; round < 6; round += 1) await act(async () => {});
}

const openLink = vi.fn<(path: string, line: number) => void>();
const openChat = vi.fn<(mention: ChatFileMentionRecord) => void>();

function Links(props: { workspaceId?: string; path?: string; revision?: number; open?: boolean; chats?: boolean }) {
  const [open, setOpen] = useState(props.open ?? true);
  return (
    <AboutLinks
      workspaceId={props.workspaceId ?? "workspace-a"}
      path={props.path ?? "docs/plan.md"}
      revision={props.revision ?? 0}
      expanded={open}
      onToggle={() => setOpen((current) => !current)}
      onOpenLink={openLink}
      {...(props.chats ? { onOpenChat: openChat } : {})}
      notices={notices}
    />
  );
}

const linkRows = () => screen.queryAllByTestId("about-link");

describe("About Links", () => {
  beforeEach(() => {
    openLink.mockReset();
    openChat.mockReset();
  });

  it("reads one page of links, draws each on one line with its file in the tooltip, and opens the file at the linking line", async () => {
    bridgeMock.linksIn.mockResolvedValue(linksPage([link("notes/alpha.md", 2), link("notes/alpha.md", 9, 1), link("notes/beta.md", 5)]));
    render(<Links />);

    await waitFor(() => expect(linkRows()).toHaveLength(3));
    expect(bridgeMock.linksIn).toHaveBeenCalledOnce();
    expect(bridgeMock.linksIn).toHaveBeenCalledWith({ workspaceId: "workspace-a", subject: { path: "docs/plan.md" } });
    expect(screen.getByTestId("about-links-count").textContent).toBe("3");
    // Each row is the linking file's title, then what it says; its path is in the tooltip.
    const rows = linkRows();
    expect(rows.map((row) => row.textContent)).toEqual([
      "alphaalpha cites [[plan]] here.",
      "alphaalpha cites [[plan]] here.",
      "betabeta cites [[plan]] here.",
    ]);
    expect(rows.map((row) => row.getAttribute("title"))).toEqual([
      "alpha cites [[plan]] here.\nnotes/alpha.md",
      "alpha cites [[plan]] here.\nnotes/alpha.md",
      "beta cites [[plan]] here.\nnotes/beta.md",
    ]);
    expect(rows[0]!.querySelector("mark")?.textContent).toBe("[[plan]]");

    await userEvent.setup().click(rows[1]!);
    expect(openLink).toHaveBeenCalledWith("notes/alpha.md", 9);
  });

  it("asks nothing while closed, reads when opened, and keeps its rows while it reads again on opening", async () => {
    bridgeMock.linksIn.mockResolvedValue(linksPage([link("notes/alpha.md", 2)]));
    const user = userEvent.setup();
    render(<Links open={false} />);
    await act(async () => {});
    expect(bridgeMock.linksIn).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new Event("focus")));
    expect(bridgeMock.linksIn).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("about-links-toggle"));
    await waitFor(() => expect(linkRows()).toHaveLength(1));
    await user.click(screen.getByTestId("about-links-toggle"));
    expect(screen.getByTestId("about-links-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(linkRows()).toHaveLength(0);

    const again = deferred<LinksPage>();
    bridgeMock.linksIn.mockReturnValueOnce(again.promise);
    await user.click(screen.getByTestId("about-links-toggle"));
    expect(linkRows()).toHaveLength(1);
    await act(async () => again.resolve(linksPage([link("notes/beta.md", 4)])));
    expect(linkRows()[0]!.dataset.path).toBe("notes/beta.md");
    expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2);
  });

  it("reads the next page on Show more and adds it below", async () => {
    bridgeMock.linksIn
      .mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2)], { nextCursor: "after-alpha" }))
      .mockResolvedValueOnce(linksPage([link("notes/beta.md", 5)]));
    render(<Links />);
    await waitFor(() => expect(linkRows()).toHaveLength(1));
    expect(screen.getByTestId("about-links-count").textContent).toBe("1+");

    await userEvent.setup().click(screen.getByTestId("about-links-more"));
    await waitFor(() => expect(linkRows()).toHaveLength(2));
    expect(bridgeMock.linksIn).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", subject: { path: "docs/plan.md" }, cursor: "after-alpha" });
    expect(screen.getByTestId("about-links-count").textContent).toBe("2");
    expect(screen.queryByTestId("about-links-more")).toBeNull();
  });

  it("reads the next page when Show more scrolls into view, and past a page with no rows", async () => {
    const intersection = observeByHand();
    bridgeMock.linksIn
      .mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2)], { nextCursor: "one" }))
      .mockResolvedValueOnce(linksPage([], { nextCursor: "two" }))
      .mockResolvedValueOnce(linksPage([link("notes/beta.md", 5)]));
    render(<Links />);
    const more = await screen.findByTestId("about-links-more");
    // React makes the observer in an effect, after the first page is drawn.
    const first = await intersection.watching(more);
    act(() => intersection.report(first));

    // The empty page leaves Show more in view. Once it lands, the same row is
    // observed again, and reads on when it is seen.
    const second = await intersection.watching(more, first);
    expect(screen.getByTestId("about-links-more")).toBe(more);
    expect(bridgeMock.linksIn.mock.calls.map(([input]) => input.cursor)).toEqual([undefined, "one"]);
    act(() => intersection.report(second));
    await waitFor(() => expect(linkRows()).toHaveLength(2));
    expect(bridgeMock.linksIn.mock.calls.map(([input]) => input.cursor)).toEqual([undefined, "one", "two"]);
  });

  it("reads after the page that just landed when Show more is seen before React draws it", async () => {
    const intersection = observeByHand();
    const second = deferred<LinksPage>();
    bridgeMock.linksIn
      .mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2)], { nextCursor: "one" }))
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(linksPage([link("notes/beta.md", 5)]));
    render(<Links />);
    const more = await screen.findByTestId("about-links-more");
    const observer = await intersection.watching(more);
    act(() => intersection.report(observer));
    expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2);

    // React draws nothing inside one act until it ends. The page lands, which
    // clears its Notices identity, and Show more is seen again before React
    // draws that page.
    const landedBefore = notices.clear.mock.calls.length;
    await act(async () => {
      second.resolve(linksPage([], { nextCursor: "two" }));
      await vi.waitFor(() => expect(notices.clear.mock.calls.length).toBeGreaterThan(landedBefore));
      intersection.report(observer);
    });
    await waitFor(() => expect(bridgeMock.linksIn).toHaveBeenCalledTimes(3));
    expect(bridgeMock.linksIn.mock.calls.map(([input]) => input.cursor)).toEqual([undefined, "one", "two"]);
  });

  it("asks once for a page that keeps failing, files one Notices row, and asks again only on Try again", async () => {
    const scrollBack = observeAllInView();
    bridgeMock.linksIn
      .mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2)], { nextCursor: "one" }))
      .mockRejectedValue(new Error("engine unavailable"));
    render(<Links />);
    await waitFor(() => expect(notices.report).toHaveBeenCalledOnce());
    await settleAll();
    // Show more is still in view, and asks nothing more, though it scrolls
    // out of view and back.
    await scrollBack();
    expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2);
    expect(notices.report).toHaveBeenCalledOnce();
    expect(linkRows()).toHaveLength(1);
    expect(screen.getByTestId("about-links-more")).toBeTruthy();

    bridgeMock.linksIn
      .mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2)], { nextCursor: "one" }))
      .mockResolvedValueOnce(linksPage([link("notes/beta.md", 5)]));
    const report = notices.report.mock.calls[0]![0] as { retry: () => void };
    await act(async () => report.retry());
    await waitFor(() => expect(linkRows()).toHaveLength(2));
    expect(bridgeMock.linksIn.mock.calls.map(([input]) => input.cursor)).toEqual([undefined, "one", undefined, "one"]);
  });

  it("waits out the gathering's backoff when the next page is refused while the workspace updates", async () => {
    vi.useFakeTimers();
    try {
      const scrollBack = observeAllInView();
      bridgeMock.linksIn
        .mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2)], { nextCursor: "one" }))
        .mockRejectedValueOnce(updating("desktop:links-in"))
        .mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2)], { nextCursor: "one" }))
        .mockResolvedValue(linksPage([link("notes/beta.md", 5)]));
      render(<Links />);
      await settleAll();
      // Scrolled out of view and back, Show more waits for the gathering too.
      await scrollBack();
      expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("status").textContent).toBe("Gathering links");
      expect(notices.report).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTimeAsync(249));
      expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      // The read from the start lands, and Show more, still in view, reads on.
      await settleAll();
      expect(bridgeMock.linksIn.mock.calls.map(([input]) => input.cursor)).toEqual([undefined, "one", undefined, "one"]);
      expect(linkRows()).toHaveLength(2);
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses chat rows coming into view after a failed page too, while pressing Show more still asks at once", async () => {
    const scrollBack = observeAllInView();
    bridgeMock.linksIn.mockResolvedValue(linksPage([]));
    bridgeMock.chatFileMentionsPage
      .mockResolvedValueOnce(chatPage([chatLink("one")], "after-one"))
      .mockRejectedValueOnce(new Error("chats unavailable"))
      .mockResolvedValueOnce(chatPage([chatLink("two")]));
    render(<Links chats />);
    await waitFor(() => expect(notices.report).toHaveBeenCalledOnce());
    await scrollBack();
    expect(bridgeMock.chatFileMentionsPage).toHaveBeenCalledTimes(2);
    expect(notices.report).toHaveBeenCalledOnce();

    await userEvent.setup().click(screen.getByTestId("about-chat-links-more"));
    await waitFor(() => expect(screen.getAllByTestId("chat-file-mention")).toHaveLength(2));
    expect(bridgeMock.chatFileMentionsPage.mock.calls.map(([input]) => input.cursor)).toEqual([undefined, "after-one", "after-one"]);
  });

  it("reads Show more after a read again lands, so a page never lands on rows that read replaced", async () => {
    bridgeMock.linksIn.mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2), link("notes/removed.md", 3)], { nextCursor: "first" }));
    const view = render(<Links revision={0} />);
    await waitFor(() => expect(linkRows()).toHaveLength(2));

    const again = deferred<LinksPage>();
    bridgeMock.linksIn.mockReturnValueOnce(again.promise).mockResolvedValueOnce(linksPage([link("notes/gamma.md", 7)]));
    view.rerender(<Links revision={1} />);
    await waitFor(() => expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2));
    await userEvent.setup().dblClick(screen.getByTestId("about-links-more"));
    expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2);

    await act(async () => again.resolve(linksPage([link("notes/alpha.md", 2), link("notes/beta.md", 5)], { nextCursor: "after-beta" })));
    await waitFor(() => expect(linkRows()).toHaveLength(3));
    expect(linkRows().map((row) => row.dataset.path)).toEqual(["notes/alpha.md", "notes/beta.md", "notes/gamma.md"]);
    expect(bridgeMock.linksIn.mock.calls.map(([input]) => input.cursor)).toEqual([undefined, undefined, "after-beta"]);
  });

  it("asks for one page however often Show more is pressed while that page is read", async () => {
    bridgeMock.linksIn.mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2)], { nextCursor: "after-alpha" }));
    render(<Links />);
    await waitFor(() => expect(linkRows()).toHaveLength(1));
    const next = deferred<LinksPage>();
    bridgeMock.linksIn.mockReturnValueOnce(next.promise);
    const user = userEvent.setup();
    await user.dblClick(screen.getByTestId("about-links-more"));
    await user.click(screen.getByTestId("about-links-more"));
    expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2);

    await act(async () => next.resolve(linksPage([link("notes/beta.md", 5)])));
    expect(linkRows()).toHaveLength(2);
    expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2);
  });

  it("reads one chat page at a time too, after a read again of the chats lands", async () => {
    bridgeMock.linksIn.mockResolvedValue(linksPage([]));
    bridgeMock.chatFileMentionsPage.mockResolvedValueOnce(chatPage([chatLink("one"), chatLink("removed")], "first"));
    const view = render(<Links chats revision={0} />);
    await waitFor(() => expect(screen.getAllByTestId("chat-file-mention")).toHaveLength(2));

    const again = deferred<NonNullable<ChatFileMentionsPage>>();
    bridgeMock.chatFileMentionsPage.mockReturnValueOnce(again.promise).mockResolvedValueOnce(chatPage([chatLink("three")]));
    view.rerender(<Links chats revision={1} />);
    await waitFor(() => expect(bridgeMock.chatFileMentionsPage).toHaveBeenCalledTimes(2));
    await userEvent.setup().dblClick(screen.getByTestId("about-chat-links-more"));
    expect(bridgeMock.chatFileMentionsPage).toHaveBeenCalledTimes(2);

    await act(async () => again.resolve(chatPage([chatLink("one"), chatLink("two")], "after-two")));
    await waitFor(() => expect(screen.getAllByTestId("chat-file-mention")).toHaveLength(3));
    expect(screen.queryByText(/removed/)).toBeNull();
    expect(bridgeMock.chatFileMentionsPage.mock.calls.map(([input]) => input.cursor)).toEqual([undefined, undefined, "after-two"]);
  });

  it("hands keyboard focus to the first row a page adds, and keeps Show more the same control while pages remain", async () => {
    bridgeMock.linksIn
      .mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2)], { nextCursor: "one" }))
      .mockResolvedValueOnce(linksPage([link("notes/beta.md", 5)], { nextCursor: "two" }))
      .mockResolvedValueOnce(linksPage([link("notes/gamma.md", 7)]));
    const user = userEvent.setup();
    render(<Links />);
    await waitFor(() => expect(linkRows()).toHaveLength(1));
    const more = screen.getByTestId("about-links-more");

    more.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(linkRows()).toHaveLength(2));
    expect(document.activeElement).toBe(linkRows()[1]);
    expect(screen.getByTestId("about-links-more")).toBe(more);

    // The last page takes Show more away, and focus still lands on its first row.
    more.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(linkRows()).toHaveLength(3));
    expect(screen.queryByTestId("about-links-more")).toBeNull();
    expect(document.activeElement).toBe(linkRows()[2]);
  });

  it("hands focus to the first chat row a page adds, unless the person moved focus on", async () => {
    const second = deferred<NonNullable<ChatFileMentionsPage>>();
    bridgeMock.linksIn.mockResolvedValue(linksPage([]));
    bridgeMock.chatFileMentionsPage
      .mockResolvedValueOnce(chatPage([chatLink("one")], "after-one"))
      .mockResolvedValueOnce(chatPage([chatLink("two")], "after-two"))
      .mockReturnValueOnce(second.promise);
    const user = userEvent.setup();
    render(<Links chats />);
    const more = await screen.findByTestId("about-chat-links-more");

    more.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getAllByTestId("chat-file-mention")).toHaveLength(2));
    expect(document.activeElement).toBe(screen.getAllByTestId("chat-file-mention")[1]);

    more.focus();
    await user.keyboard("{Enter}");
    screen.getByTestId("about-links-toggle").focus();
    await act(async () => second.resolve(chatPage([chatLink("three")])));
    expect(screen.getAllByTestId("chat-file-mention")).toHaveLength(3);
    expect(document.activeElement).toBe(screen.getByTestId("about-links-toggle"));
  });

  it("keeps focus in About on the Links head when a link opens another file, as Search keeps its own", async () => {
    bridgeMock.linksIn.mockResolvedValue(linksPage([link("notes/alpha.md", 2), link("docs/plan.md", 9)]));
    const user = userEvent.setup();
    render(<Links />);
    await waitFor(() => expect(linkRows()).toHaveLength(2));

    linkRows()[0]!.focus();
    await user.keyboard("{Enter}");
    expect(openLink).toHaveBeenCalledWith("notes/alpha.md", 2);
    expect(document.activeElement).toBe(screen.getByTestId("about-links-toggle"));

    // A link from the file to itself leaves About on the same file, and focus on the row.
    linkRows()[1]!.focus();
    await user.keyboard("{Enter}");
    expect(openLink).toHaveBeenLastCalledWith("docs/plan.md", 9);
    expect(document.activeElement).toBe(linkRows()[1]);
  });

  it("reads again from the start until it holds as many rows, as the workspace changes or the window returns", async () => {
    bridgeMock.linksIn
      .mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2)], { nextCursor: "one" }))
      .mockResolvedValueOnce(linksPage([link("notes/beta.md", 5)]));
    const view = render(<Links revision={0} />);
    await waitFor(() => expect(linkRows()).toHaveLength(1));
    await userEvent.setup().click(screen.getByTestId("about-links-more"));
    await waitFor(() => expect(linkRows()).toHaveLength(2));

    const last = deferred<LinksPage>();
    bridgeMock.linksIn
      .mockResolvedValueOnce(linksPage([link("notes/alpha.md", 3)], { nextCursor: "one" }))
      .mockReturnValueOnce(last.promise);
    view.rerender(<Links revision={1} />);
    await waitFor(() => expect(bridgeMock.linksIn).toHaveBeenCalledTimes(4));
    // The rows stay until the read holds as many as they are.
    expect(linkRows().map((row) => row.dataset.line)).toEqual(["2", "5"]);
    await act(async () => last.resolve(linksPage([link("notes/gamma.md", 7)])));
    expect(linkRows().map((row) => row.dataset.path)).toEqual(["notes/alpha.md", "notes/gamma.md"]);
    expect(bridgeMock.linksIn.mock.calls.slice(2).map(([input]) => input.cursor)).toEqual([undefined, "one"]);

    bridgeMock.linksIn
      .mockResolvedValueOnce(linksPage([link("notes/alpha.md", 4)], { nextCursor: "one" }))
      .mockResolvedValueOnce(linksPage([]));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(linkRows().map((row) => row.dataset.line)).toEqual(["4"]));
    expect(bridgeMock.linksIn).toHaveBeenCalledTimes(6);
  });

  it("says Gathering links only while the index builds, reading again sooner first, then at most every eight seconds", async () => {
    vi.useFakeTimers();
    try {
      bridgeMock.linksIn.mockResolvedValue(linksPage([link("notes/alpha.md", 2)], { complete: false, indexBuilding: true }));
      render(<Links />);
      await act(async () => {});
      expect(screen.getByRole("status").textContent).toBe("Gathering links");
      expect(screen.getByTestId("about-links-count").textContent).toBe("1+");
      for (const delay of [250, 500, 1000, 2000, 4000, 8000, 8000]) {
        const count = bridgeMock.linksIn.mock.calls.length;
        await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
        expect(bridgeMock.linksIn).toHaveBeenCalledTimes(count);
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(bridgeMock.linksIn).toHaveBeenCalledTimes(count + 1);
      }
      bridgeMock.linksIn.mockResolvedValue(linksPage([link("notes/alpha.md", 2), link("notes/beta.md", 5)]));
      await act(async () => vi.advanceTimersByTimeAsync(8000));
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByTestId("about-links-count").textContent).toBe("2");
      const count = bridgeMock.linksIn.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(16_000));
      expect(bridgeMock.linksIn).toHaveBeenCalledTimes(count);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads one page again once the index is built, though sparse pages grew the list while it built", async () => {
    vi.useFakeTimers();
    try {
      bridgeMock.linksIn
        .mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2)], { complete: false, indexBuilding: true, nextCursor: "sparse" }))
        .mockResolvedValueOnce(linksPage([link("notes/beta.md", 5)], { complete: false, indexBuilding: true }))
        .mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2), link("notes/beta.md", 5), link("notes/gamma.md", 7)], { nextCursor: "dense" }));
      render(<Links />);
      await act(async () => {});
      fireClick(screen.getByTestId("about-links-more"));
      await act(async () => {});
      expect(linkRows()).toHaveLength(2);
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(bridgeMock.linksIn).toHaveBeenCalledTimes(3);
      expect(bridgeMock.linksIn.mock.calls[2]![0]).not.toHaveProperty("cursor");
      expect(linkRows()).toHaveLength(3);
      expect(screen.getByTestId("about-links-count").textContent).toBe("3+");
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gathers while the engine still reads the workspace's files, for files and chats, and files no Notices row", async () => {
    vi.useFakeTimers();
    try {
      bridgeMock.linksIn.mockRejectedValueOnce(updating("desktop:links-in")).mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2)]));
      bridgeMock.chatFileMentionsPage
        .mockRejectedValueOnce(updating("desktop:chat-file-mentions-page")).mockResolvedValueOnce(chatPage([chatLink("general")]));
      render(<Links chats />);
      await act(async () => {});
      expect(screen.getByRole("status").textContent).toBe("Gathering links");
      expect(screen.getByTestId("about-links-count").textContent).toBe("0+");
      await act(async () => vi.advanceTimersByTimeAsync(250));
      expect(linkRows()).toHaveLength(1);
      expect(screen.getAllByTestId("chat-file-mention")).toHaveLength(1);
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByTestId("about-links-count").textContent).toBe("2");
      expect(notices.report).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops gathering when a chat read fails after the workspace updated, and offers Try again", async () => {
    vi.useFakeTimers();
    try {
      bridgeMock.linksIn.mockResolvedValue(linksPage([link("notes/alpha.md", 2)]));
      bridgeMock.chatFileMentionsPage
        .mockRejectedValueOnce(updating("desktop:chat-file-mentions-page"))
        .mockRejectedValueOnce(new Error("chats unavailable"));
      render(<Links chats />);
      await act(async () => {});
      expect(screen.getByRole("status").textContent).toBe("Gathering links");

      await act(async () => vi.advanceTimersByTimeAsync(250));
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByTestId("about-chat-links-failed")).toBeTruthy();
      expect(notices.report).toHaveBeenCalledOnce();
      expect(notices.report.mock.calls[0]![0]).toMatchObject({ identity: "about-chat-links:docs/plan.md" });
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(bridgeMock.chatFileMentionsPage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not gather lasting omissions, such as files too large to read or uncovered shares", async () => {
    vi.useFakeTimers();
    try {
      bridgeMock.linksIn.mockResolvedValue(linksPage([link("notes/alpha.md", 2)], { complete: false, mountsCovered: false, unchecked: ["large.md"] }));
      render(<Links />);
      await act(async () => {});
      expect(linkRows()).toHaveLength(1);
      expect(screen.queryByRole("status")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(bridgeMock.linksIn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops gathering when the section closes", async () => {
    vi.useFakeTimers();
    try {
      bridgeMock.linksIn.mockResolvedValue(linksPage([], { complete: false, indexBuilding: true }));
      render(<Links />);
      await act(async () => {});
      expect(screen.getByRole("status").textContent).toBe("Gathering links");
      fireClick(screen.getByTestId("about-links-toggle"));
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(bridgeMock.linksIn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws only the head, with a 0 and no chevron, when nothing links here", async () => {
    bridgeMock.linksIn.mockResolvedValue(linksPage([]));
    bridgeMock.chatFileMentionsPage.mockResolvedValue(chatPage([]));
    render(<Links chats />);
    await waitFor(() => expect(bridgeMock.chatFileMentionsPage).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByTestId("about-links-count").textContent).toBe("0");
    expect(screen.queryByTestId("about-links-toggle")).toBeNull();
  });

  it("reads nothing for a file under shared-with-me/, and says dohc does not list its links yet", async () => {
    render(<Links path="shared-with-me/Sam/plan.md" chats />);
    expect((await screen.findByTestId("about-links-shared")).textContent).toBe(
      "dohc does not list links into files shared with you yet.",
    );
    await act(async () => {});
    expect(bridgeMock.linksIn).not.toHaveBeenCalled();
    expect(bridgeMock.chatFileMentionsPage).not.toHaveBeenCalled();
    expect(screen.queryByTestId("about-links-count")).toBeNull();
  });

  it("reports a failed read to the shell, shows only Try again, and clears the row once a read answers", async () => {
    const error = new Error("engine unavailable");
    bridgeMock.linksIn.mockRejectedValueOnce(error).mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2)]));
    render(<Links />);
    await screen.findByTestId("about-links-failed");
    expect(notices.report).toHaveBeenCalledOnce();
    const report = notices.report.mock.calls[0]![0] as { identity: string; message: string; cause: unknown; retry: () => void };
    expect(report).toMatchObject({ identity: "about-links:docs/plan.md", message: expect.stringContaining("engine unavailable"), cause: error });
    expect(screen.getByTestId("about-links-failed").textContent).toBe("Try again");

    await act(async () => report.retry());
    await waitFor(() => expect(linkRows()).toHaveLength(1));
    expect(notices.clear).toHaveBeenCalledWith("about-links:docs/plan.md");
  });

  it("keeps its rows when a read again fails, and reports it", async () => {
    bridgeMock.linksIn.mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2)])).mockRejectedValueOnce(new Error("busy"));
    const view = render(<Links revision={0} />);
    await waitFor(() => expect(linkRows()).toHaveLength(1));
    view.rerender(<Links revision={1} />);
    await waitFor(() => expect(notices.report).toHaveBeenCalledOnce());
    expect(linkRows()).toHaveLength(1);
    expect(screen.queryByTestId("about-links-failed")).toBeNull();
  });

  it("never shows a reply for a file or workspace it left, nor asks for its next page", async () => {
    const old = deferred<LinksPage>();
    bridgeMock.linksIn.mockReturnValueOnce(old.promise).mockResolvedValueOnce(linksPage([link("notes/current.md", 2)]));
    const view = render(<Links workspaceId="workspace-a" path="docs/plan.md" />);
    view.rerender(<Links workspaceId="workspace-b" path="docs/other.md" />);
    await waitFor(() => expect(linkRows()).toHaveLength(1));
    await act(async () => old.resolve(linksPage([link("notes/stale.md", 2)], { nextCursor: "stale-next" })));
    expect(linkRows().map((row) => row.dataset.path)).toEqual(["notes/current.md"]);
    expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2);
    expect(bridgeMock.linksIn).toHaveBeenLastCalledWith({ workspaceId: "workspace-b", subject: { path: "docs/other.md" } });
  });

  it("neither reports nor clears when the file it left fails after the switch", async () => {
    const old = deferred<LinksPage>();
    bridgeMock.linksIn.mockReturnValueOnce(old.promise).mockResolvedValueOnce(linksPage([]));
    const view = render(<Links path="docs/plan.md" />);
    view.rerender(<Links path="docs/other.md" />);
    await waitFor(() => expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2));
    await act(async () => {});
    notices.clear.mockReset();
    await act(async () => old.reject(new Error("late")));
    expect(notices.report).not.toHaveBeenCalled();
    expect(notices.clear).not.toHaveBeenCalled();
  });

  it("lists the chats that link here as their own rows and opens one, only where chats are read", async () => {
    bridgeMock.linksIn.mockResolvedValue(linksPage([link("notes/alpha.md", 2)]));
    bridgeMock.chatFileMentionsPage.mockResolvedValue(chatPage([
      chatLink("general", { channelKind: "channel", channelName: "general" }),
      chatLink("file-thread"),
    ]));
    render(<Links chats />);
    const rows = await screen.findAllByTestId("chat-file-mention");
    expect(bridgeMock.chatFileMentionsPage).toHaveBeenCalledWith({ workspaceId: "workspace-a", subject: { path: "docs/plan.md" } });
    // Where it was said and when, then who said what.
    const when = formatShortTime(CHECKED_AT);
    expect(rows.map((row) => row.textContent)).toEqual([
      `general${when}Sam See docs/plan.md general`,
      `Thread file-thread${when}Sam See docs/plan.md file-thread`,
    ]);
    expect(rows[0]!.querySelector("time")?.getAttribute("title")).toBeTruthy();
    expect(screen.getByTestId("about-links-count").textContent).toBe("3");

    await userEvent.setup().click(rows[1]!);
    expect(openChat).toHaveBeenCalledWith(expect.objectContaining({ attachment: expect.objectContaining({ attachmentId: "attachment-file-thread" }) }));

    cleanup();
    bridgeMock.chatFileMentionsPage.mockClear();
    render(<Links />);
    await waitFor(() => expect(linkRows()).toHaveLength(1));
    expect(bridgeMock.chatFileMentionsPage).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chat-file-mention")).toBeNull();
  });

  it("paints file links without waiting for the chats that link here", async () => {
    const chats = deferred<NonNullable<ChatFileMentionsPage>>();
    bridgeMock.linksIn.mockResolvedValue(linksPage([link("notes/alpha.md", 2)]));
    bridgeMock.chatFileMentionsPage.mockReturnValue(chats.promise);
    render(<Links chats />);
    await waitFor(() => expect(linkRows()).toHaveLength(1));
    expect(screen.queryByTestId("about-links-count")).toBeNull();
    await act(async () => chats.resolve(chatPage([chatLink("general")])));
    expect(screen.getByTestId("about-links-count").textContent).toBe("2");
  });

  it("reads the next page of chats that link here, shows a row repeated across pages once, and focuses the row it adds", async () => {
    bridgeMock.linksIn.mockResolvedValue(linksPage([]));
    bridgeMock.chatFileMentionsPage
      .mockResolvedValueOnce(chatPage([chatLink("one")], "next"))
      .mockResolvedValueOnce(chatPage([chatLink("one"), chatLink("two")]));
    const user = userEvent.setup();
    render(<Links chats />);
    const more = await screen.findByTestId("about-chat-links-more");
    more.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getAllByTestId("chat-file-mention")).toHaveLength(2));
    expect(bridgeMock.chatFileMentionsPage).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", subject: { path: "docs/plan.md" }, cursor: "next" });
    // The repeated row is a new record, the same row by key; the last page
    // took Show more away, and focus lands on the row it added.
    expect(screen.queryByTestId("about-chat-links-more")).toBeNull();
    expect(document.activeElement).toBe(screen.getAllByTestId("chat-file-mention")[1]);
    expect(document.activeElement?.getAttribute("data-thread-id")).toBe("thread-two");
  });

  it.each(["chat-mention-access-changed", "chat-mention-version-changed"])(
    "drops chat rows and reads once from the start when their cursor's %s",
    async (reason) => {
      const refusal = () => new Error(`Error invoking remote method 'desktop:chat-file-mentions-page': ${String(ipcWireError(new DaemonRefusalError({ code: "CONFLICT", message: reason, retry: "no" }, null)))}`);
      const restarted = deferred<NonNullable<ChatFileMentionsPage>>();
      bridgeMock.linksIn.mockResolvedValue(linksPage([link("notes/alpha.md", 2)]));
      bridgeMock.chatFileMentionsPage
        .mockResolvedValueOnce(chatPage([chatLink("old")], "next"))
        .mockRejectedValueOnce(refusal())
        .mockReturnValueOnce(restarted.promise);
      render(<Links chats />);
      await userEvent.setup().click(await screen.findByTestId("about-chat-links-more"));
      await waitFor(() => expect(bridgeMock.chatFileMentionsPage).toHaveBeenCalledTimes(3));
      expect(bridgeMock.chatFileMentionsPage.mock.calls[2]![0]).toEqual({ workspaceId: "workspace-a", subject: { path: "docs/plan.md" } });
      expect(screen.queryByTestId("chat-file-mention")).toBeNull();
      expect(notices.report).not.toHaveBeenCalled();

      await act(async () => restarted.reject(refusal()));
      expect(notices.report).toHaveBeenCalledOnce();
      expect(notices.report.mock.calls[0]![0]).toMatchObject({ identity: "about-chat-links:docs/plan.md" });
      expect(screen.getByTestId("about-chat-links-failed")).toBeTruthy();
      expect(linkRows()).toHaveLength(1);
      expect(bridgeMock.chatFileMentionsPage).toHaveBeenCalledTimes(3);
    },
  );
});

function fireClick(element: HTMLElement) {
  act(() => element.click());
}

function moment(overrides: Partial<EngineMomentRecord> = {}): EngineMomentRecord {
  return {
    id: "moment-1",
    versionId: "main",
    path: "docs/plan.md",
    recordedAtMs: Date.UTC(2026, 9, 9, 10, 0),
    operation: "write",
    origin: "ydoc",
    momentOrder: 4,
    ...overrides,
  };
}

function page(moments: EngineMomentRecord[], more = false): ListEngineMomentsResponse {
  return {
    moments,
    nextCursor: more ? historyCursor(1) : null,
    latestMomentOrder: 4,
    activeVersionId: "main", ...historyPageFields,

  };
}

function HistorySection(props: {
  workspaceId?: string;
  objectId?: string;
  file?: AboutFile;
  revision?: number;
  paused?: boolean;
  onOpenMoment?: (id: string, path: string) => void;
  onOpenHistory?: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <AboutHistory
      workspaceId={props.workspaceId ?? "workspace-a"}
      path="docs/plan.md"
      file={props.file ?? { status: "ready", objectId: props.objectId ?? "object-1" }}
      revision={props.revision ?? 0}
      paused={props.paused ?? false}
      expanded={open}
      onToggle={() => setOpen((current) => !current)}
      onOpenMoment={props.onOpenMoment ?? (() => undefined)}
      {...(props.onOpenHistory ? { onOpenHistory: props.onOpenHistory } : {})}
      notices={notices}
    />
  );
}

// What a section shows under its header: the body its toggle controls.
const sectionBody = (id: string) =>
  document.getElementById(screen.getByTestId(`about-${id}-toggle`).getAttribute("aria-controls")!)!;
// The lines of the delayed skeleton, when it is all a section's body shows.
const loadingLines = (id: string) =>
  sectionBody(id).querySelectorAll(":scope > .dohc-reveal-if-slow:only-child > span");

describe("About History", () => {
  it("reads the file's newest changes by its object id and opens one", async () => {
    bridgeMock.listEngineMoments.mockResolvedValue(
      page([moment({ agentAuthorName: "Nova", summary: "Tightened the plan" }), moment({ id: "moment-2" })], true),
    );
    const onOpenMoment = vi.fn();
    render(<HistorySection onOpenMoment={onOpenMoment} />);
    const rows = await screen.findAllByTestId("engine-moment-open");
    expect(bridgeMock.listEngineMoments).toHaveBeenCalledWith({ workspaceId: "workspace-a", objectId: "object-1", limit: 20 });
    // Who made the change and when, then what it changed.
    expect(within(rows[0]!).getByTestId("engine-moment-source").textContent).toBe("Nova");
    expect(rows[0]!.textContent).toContain("Tightened the plan");
    expect(within(rows[1]!).getByTestId("engine-moment-source").textContent).toBe("Live edit");
    expect(rows[1]!.textContent).toContain("Edited");
    expect(screen.getByTestId("about-history-count").textContent).toBe("2+");
    await userEvent.setup().click(rows[0]!);
    expect(onOpenMoment).toHaveBeenCalledWith("moment-1", "docs/plan.md");
  });

  it("keeps its place while the file's read runs or waits, and offers that read's Try again when it fails", async () => {
    const { rerender } = render(<HistorySection file={{ status: "loading" }} />);
    expect(screen.getByTestId("about-history-toggle")).toBeTruthy();
    expect(screen.queryByTestId("about-history-count")).toBeNull();
    expect(loadingLines("history")).toHaveLength(2);
    expect(screen.queryByTestId("about-history-updating")).toBeNull();
    // While the engine reads the workspace in, History says it is adding changes.
    rerender(<HistorySection file={{ status: "updating" }} />);
    expect(screen.getByTestId("about-history-updating").textContent).toBe("Adding recent changes to History");
    expect(screen.queryByTestId("about-history-count")).toBeNull();
    const retry = vi.fn();
    rerender(<HistorySection file={{ status: "failed", retry }} />);
    await userEvent.setup().click(within(screen.getByTestId("about-history-failed")).getByText("Try again"));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(bridgeMock.listEngineMoments).not.toHaveBeenCalled();
    // The file's own read reports its failure; History adds no second row.
    expect(notices.report).not.toHaveBeenCalled();
  });

  it("says History does not track a file with no object id", () => {
    render(<HistorySection file={{ status: "ready", objectId: null }} />);
    expect(screen.getByTestId("about-history-untracked").textContent).toBe("History does not track this file yet.");
    expect(bridgeMock.listEngineMoments).not.toHaveBeenCalled();
  });

  it("shows loading lines, then only the head when the file has no changes", async () => {
    const pending = deferred<ListEngineMomentsResponse>();
    bridgeMock.listEngineMoments.mockReturnValue(pending.promise);
    render(<HistorySection />);
    expect(loadingLines("history")).toHaveLength(2);
    expect(screen.queryByTestId("about-history-count")).toBeNull();
    await act(async () => pending.resolve(page([])));
    expect(screen.getByTestId("about-history-count").textContent).toBe("0");
    expect(screen.queryByTestId("about-history-toggle")).toBeNull();
  });

  it("reports a failed read to the shell and reads again on Try again", async () => {
    const error = new Error("engine stopped");
    bridgeMock.listEngineMoments.mockRejectedValueOnce(error).mockResolvedValue(page([moment()]));
    render(<HistorySection />);
    const failed = await screen.findByTestId("about-history-failed");
    expect(failed.textContent).toBe("Try again");
    expect(notices.report).toHaveBeenCalledWith({
      identity: "about-history:docs/plan.md",
      message: expect.stringContaining("engine stopped"),
      cause: error,
      retry: expect.any(Function),
    });
    await userEvent.setup().click(within(failed).getByText("Try again"));
    expect(await screen.findAllByTestId("engine-moment-open")).toHaveLength(1);
    expect(notices.clear).toHaveBeenLastCalledWith("about-history:docs/plan.md");
  });

  // History can finish taking in changes without adding one, so no newer
  // revision is sure to come: the section reads again by itself.
  it("says History is still updating with no control, files no row, and reads again by itself", async () => {
    const next = deferred<ListEngineMomentsResponse>();
    bridgeMock.listEngineMoments.mockResolvedValueOnce({ status: "updating" }).mockImplementationOnce(() => next.promise);
    render(<HistorySection />);
    const line = await screen.findByTestId("about-history-updating");
    expect(line.textContent).toBe("Adding recent changes to History");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(notices.report).not.toHaveBeenCalled();
    await waitFor(() => expect(bridgeMock.listEngineMoments).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("about-history-updating")).toBe(line);
    await act(async () => {
      next.resolve(page([moment()]));
      await next.promise;
    });
    expect(await screen.findAllByTestId("engine-moment-open")).toHaveLength(1);
  });

  // A paused History may be missing changes: its line replaces taking in
  // changes, heads the rows a read still answers, and stands in for none.
  it("says History is paused in place of updating, then above the rows a paused read answers", async () => {
    bridgeMock.listEngineMoments.mockResolvedValueOnce({ status: "updating" }).mockResolvedValue(page([moment()]));
    const { rerender } = render(<HistorySection paused />);
    const line = await screen.findByTestId("about-history-paused");
    expect(line.textContent).toBe("History paused");
    expect(screen.queryByTestId("about-history-updating")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    const [row] = await screen.findAllByTestId("engine-moment-open");
    const heading = screen.getByTestId("about-history-paused");
    expect(heading.compareDocumentPosition(row!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notices.report).not.toHaveBeenCalled();
    // History recovers: the rows stay and the line goes.
    rerender(<HistorySection paused={false} />);
    expect(screen.queryByTestId("about-history-paused")).toBeNull();
    expect(screen.getAllByTestId("engine-moment-open")).toHaveLength(1);
  });

  it("keeps a real failure's Try again while History is paused", async () => {
    bridgeMock.listEngineMoments.mockRejectedValueOnce(new Error("engine stopped")).mockResolvedValue(page([moment()]));
    render(<HistorySection paused />);
    const failed = await screen.findByTestId("about-history-failed");
    expect(screen.queryByTestId("about-history-paused")).toBeNull();
    await userEvent.setup().click(within(failed).getByText("Try again"));
    expect(await screen.findAllByTestId("engine-moment-open")).toHaveLength(1);
    expect(screen.getByTestId("about-history-paused")).toBeTruthy();
  });

  it("says History is paused, not that the file has no changes, when a paused read answers none", async () => {
    bridgeMock.listEngineMoments.mockResolvedValue(page([]));
    render(<HistorySection paused />);
    expect(await screen.findByTestId("about-history-paused")).toBeTruthy();
    expect(sectionBody("history").textContent).toBe(screen.getByTestId("about-history-paused").textContent);
  });

  // A read History's growth starts replaces the one an updating answer
  // scheduled, so that read's answer is the one that lands.
  it("reads once when History grows before the read an updating answer scheduled", async () => {
    vi.useFakeTimers();
    try {
      const grown = deferred<ListEngineMomentsResponse>();
      bridgeMock.listEngineMoments.mockResolvedValueOnce({ status: "updating" }).mockImplementationOnce(() => grown.promise);
      const { rerender } = render(<HistorySection revision={1} />);
      await settleAll();
      expect(screen.getByTestId("about-history-updating")).toBeTruthy();
      await act(async () => vi.advanceTimersByTimeAsync(100));
      rerender(<HistorySection revision={2} />);
      await settleAll();
      expect(bridgeMock.listEngineMoments).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(8_000));
      expect(bridgeMock.listEngineMoments).toHaveBeenCalledTimes(2);
      await act(async () => {
        grown.resolve(page([moment()]));
        await grown.promise;
      });
      expect(screen.getAllByTestId("engine-moment-open")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws History hidden by rules it can't read in the section, with no row", async () => {
    bridgeMock.listEngineMoments.mockResolvedValue({
      status: "policy-unreadable",
      unreadable: [".dohc/files.toml"],
      policyErrors: ["line 3: expected a table"],
    });
    render(<HistorySection />);
    const held = await screen.findByTestId("about-history-held");
    expect(held.textContent).toContain("dohc can't read .dohc/files.toml, so History is hidden. Fix the file, then try again.");
    expect(notices.report).not.toHaveBeenCalled();
  });

  it("keeps its row while History fails again as it grows, so the shell replaces it", async () => {
    bridgeMock.listEngineMoments.mockRejectedValue(new Error("engine stopped"));
    const { rerender } = render(<HistorySection revision={1} />);
    await waitFor(() => expect(notices.report).toHaveBeenCalledTimes(1));
    const clears = notices.clear.mock.calls.length;
    rerender(<HistorySection revision={2} />);
    await waitFor(() => expect(notices.report).toHaveBeenCalledTimes(2));
    // The same file and read key: the row stays, and the second report
    // replaces it, keeping its toast (useShellError's `repeat`).
    expect(notices.clear.mock.calls.length).toBe(clears);
  });

  it("never shows another file's changes after a switch", async () => {
    const forFirst = deferred<ListEngineMomentsResponse>();
    bridgeMock.listEngineMoments.mockImplementation(({ objectId }) =>
      objectId === "object-1" ? forFirst.promise : Promise.resolve(page([moment({ id: "moment-b", summary: "Second file" })])),
    );
    const { rerender } = render(<HistorySection objectId="object-1" />);
    await waitFor(() => expect(bridgeMock.listEngineMoments).toHaveBeenCalledTimes(1));
    rerender(<HistorySection objectId="object-2" />);
    expect((await screen.findByTestId("engine-moment-open")).textContent).toContain("Second file");
    await act(async () => forFirst.resolve(page([moment({ summary: "First file" })])));
    expect(screen.getAllByTestId("engine-moment-open").map((row) => row.dataset.momentId)).toEqual(["moment-b"]);
  });

  it("folds an agent's run into one row and shows the three latest rows", async () => {
    const agent = { kind: "agent" as const, agentId: "nova", agentRunId: "run", onBehalfOf: "device" };
    const run = ["run-1", "run-2", "run-3"].map((id) =>
      moment({ id, agentAuthorName: "Nova", authors: [agent], authorPresentations: [{ group: "agent:nova", hue: null, self: false }] }));
    const edits = ["edit-1", "edit-2", "edit-3"].map((id) => moment({ id }));
    bridgeMock.listEngineMoments.mockResolvedValue(page([...run, ...edits]));
    render(<HistorySection />);
    const rows = await screen.findAllByTestId("engine-moment-open");
    expect(rows.map((row) => row.dataset.momentId)).toEqual(["run-1", "edit-1", "edit-2"]);
    const fold = screen.getByTestId("engine-moment-run-toggle");
    expect(fold.getAttribute("aria-label")).toBe("3 changes");
    expect(screen.getByTestId("about-history-count").textContent).toBe("3+");
    // The run opens in place, its earlier edits under its newest.
    await userEvent.setup().click(fold);
    expect(screen.getAllByTestId("engine-moment-open").map((row) => row.dataset.momentId))
      .toEqual(["run-1", "run-2", "run-3", "edit-1", "edit-2"]);
  });

  it("opens the full History from its head", async () => {
    bridgeMock.listEngineMoments.mockResolvedValue(page([moment()]));
    const onOpenHistory = vi.fn();
    const { rerender } = render(<HistorySection onOpenHistory={onOpenHistory} />);
    await userEvent.setup().click(screen.getByTestId("about-history-all"));
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    rerender(<HistorySection />);
    expect(screen.queryByTestId("about-history-all")).toBeNull();
  });

  it("keeps its rows while it reads again after History grows", async () => {
    bridgeMock.listEngineMoments.mockResolvedValueOnce(page([moment({ summary: "Older" })]));
    const { rerender } = render(<HistorySection revision={1} />);
    await screen.findByTestId("engine-moment-open");
    const next = deferred<ListEngineMomentsResponse>();
    bridgeMock.listEngineMoments.mockReturnValueOnce(next.promise);
    rerender(<HistorySection revision={2} />);
    expect(screen.getByTestId("engine-moment-open").textContent).toContain("Older");
    await act(async () => next.resolve(page([moment({ id: "moment-new", summary: "Newer" }), moment({ summary: "Older" })])));
    expect(screen.getAllByTestId("engine-moment-open")).toHaveLength(2);
  });
});

describe("About History authors", () => {
  const token = (hue: ActorPresentation["hue"], self = false): ActorPresentation => ({ group: "g", hue, self });
  function row(fields: Partial<EngineMomentRecord>) {
    render(<AboutHistoryView view={{ status: "ready", moments: [moment(fields)], more: false }}
      expanded onToggle={() => undefined} onOpenMoment={() => undefined} />);
    return screen.getByTestId("engine-moment-open");
  }
  afterEach(() => setChosenColors(DEFAULT_USER_SETTINGS));

  it.each([
    ["a person you shared with", { namedAuthor: { userId: "sam", label: "Sam Rivera" }, authors: [{ kind: "named", userId: "sam", grantId: "g", grantGeneration: 1 }] }, "Sam Rivera"],
    ["a live account holder", { liveAuthorName: "Owner Account", authors: [{ kind: "human", humanId: "owner", humanName: "Owner Account" }] }, "Owner Account"],
    ["this computer's person", { personAuthorName: "Ice", authors: [{ kind: "human", humanId: "device" }] }, "Ice"],
  ] as const)("draws %s with the hue main gave them", (_kind, fields, name) => {
    const plum = row({ ...fields, authors: [...fields.authors], authorPresentations: [token("plum")] }).querySelector(`[title="${name}"]`);
    expect(plum?.className).toContain("text-hue-plum");
    cleanup();
    // A person main left neutral stays neutral; no name picks a colour here.
    expect(row({ ...fields, authors: [...fields.authors], authorPresentations: [token(null)] }).querySelector(`[title="${name}"]`)?.className).toContain("bg-panel-2");
  });

  it("applies your chosen colour to your own moments only", () => {
    setChosenColors({ ...DEFAULT_USER_SETTINGS, appearance: { ...DEFAULT_USER_SETTINGS.appearance, yourColor: "rose" } });
    const authors = [{ kind: "human" as const, humanId: "device" }];
    expect(row({ personAuthorName: "Ice", authors, authorPresentations: [token("teal", true)] }).querySelector('[title="Ice"]')?.className).toContain("text-hue-rose");
    cleanup();
    expect(row({ namedAuthor: { userId: "sam", label: "Sam" }, authors: [{ kind: "named", userId: "sam", grantId: "g", grantGeneration: 1 }],
      authorPresentations: [token("teal")] }).querySelector('[title="Sam"]')?.className).toContain("text-hue-teal");
  });

  it("keeps agents in the agent voice, automations bare, link holders marked, and several authors on the origin mark", () => {
    setChosenColors(settingsWithAgent({ hue: "teal" }));
    const agent = { kind: "agent" as const, agentId: "nova", agentRunId: "run", onBehalfOf: "device" };
    expect(row({ agentAuthorName: "Nova", authors: [agent], authorPresentations: [token(null, true)] }).querySelector('[title="Nova"]')?.className).toContain("text-hue-teal");
    cleanup();
    expect(row({ agentAuthorName: "Pat", authors: [agent], authorPresentations: [token(null)] }).querySelector('[title="Pat"]')?.className).toContain("text-agent");
    cleanup();
    const automation = row({ automationAuthor: { name: "Stamp" }, authors: [{ kind: "automation", automationId: "collection:Tasks#stamp", depth: 1 }], authorPresentations: [token(null)] });
    expect(automation.querySelector('[title="Stamp"] svg')).not.toBeNull();
    cleanup();
    for (const fields of [
      { linkAuthor: { kind: "link", grantId: "g", grantGeneration: 1, principalId: "p" }, authors: [{ kind: "link", grantId: "g", grantGeneration: 1, principalId: "p" }] },
      { liveAuthorName: "Link holder Anonymous", authors: [{ kind: "link", publicPrincipalId: "public_1", label: "Anonymous" }] },
    ] as const) {
      const link = row({ ...fields, authors: [...fields.authors], authorPresentations: [token(null)] });
      expect(link.querySelector(".border-dashed")).not.toBeNull();
      expect(link.querySelector("span[title]")).toBeNull();
      cleanup();
    }
    const several = row({ authors: [{ kind: "named", userId: "sam", grantId: "g", grantGeneration: 1 }, agent],
      authorLabels: ["Sam", "Nova"], authorPresentations: [token("plum"), token(null, true)] });
    expect(several.querySelector('[title="Sam"], [title="Nova"]')).toBeNull();
    expect(several.querySelector(".lucide-pen-line")).not.toBeNull();
  });
});

it.each(["light", "dark"])("matches a person's About avatar to their face in %s theme", (theme) => {
  const peer = { faceToken: "sam", sessionToken: "sam-session", isSelf: false, displayName: "Sam Rivera", paletteSlot: 4, state: null, updatedAtMs: 0 };
  const subject = { kind: "person" as const, name: "Sam Rivera", channelWireId: "dm", received: false, present: [
    { ...peer, faceToken: "you", isSelf: true, paletteSlot: 0 }, peer,
  ] };
  const view = render(<div data-theme={theme}><AboutHeader subject={subject} /></div>);
  const header = screen.getByTestId("about-header");
  const avatar = header.querySelector('[title="Sam Rivera"]');
  const face = header.querySelectorAll(".dohc-presence-faces > span")[1];
  for (const mark of [avatar, face]) {
    expect(mark?.className).toContain("text-hue-indigo");
    expect(mark?.className).toContain("bg-hue-indigo/15");
  }
  view.rerender(<AboutHeader subject={{ ...subject, present: [] }} />);
  expect(screen.getByTestId("about-header").querySelector('[title="Sam Rivera"]')?.className).toContain("bg-panel-2");
});
