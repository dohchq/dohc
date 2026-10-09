// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessAnswer, AccessShareRow } from "@dohc/workspace-contracts/access";
import type { EngineMomentRecord, ListEngineMomentsResponse } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { formatShortTime } from "../time";
import { AboutAccess, AboutHistory, accessReasonFor, type AboutFile, type AccessFacts } from "./About";

const bridgeMock = {
  getObjectAccess: vi.fn<(input: { workspaceId: string; ref: unknown; cursor?: string }) => Promise<AccessAnswer>>(),
  requestAccessRefresh: vi.fn<(input: { workspaceId: string; reason: string }) => Promise<void>>(),
  listEngineMoments: vi.fn<(input: { workspaceId: string; objectId?: string; limit?: number }) => Promise<ListEngineMomentsResponse>>(),
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
    coverage: { kind: "granted", complete: true, observation: "interval" },
    checkedAtMs: CHECKED_AT,
    freshness: "fresh",
    nextCursor: null,
    ...overrides,
  };
}

// What main answers when it has no observation to read: no coverage at all.
const UNKNOWN = answer({
  coverage: { kind: "unavailable", complete: false, observation: "interval" },
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
      path={props.path ?? "docs/plan.md"}
      expanded={open}
      onToggle={() => setOpen((current) => !current)}
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
    expect(notices.clear).toHaveBeenCalledWith("about-access:docs/plan.md");
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
    expect(screen.getByTestId("about-access-answer")).toBeTruthy();
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
    expect(screen.getByTestId("about-access-freshness").textContent).toBe("Checked");
    expect(within(result).getByText(formatShortTime(CHECKED_AT))).toBeTruthy();
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

  it("says an empty answer covers only what it checked, never that nobody has access", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(answer());
    render(<Access />);
    expect((await screen.findByTestId("about-access-empty")).textContent).toBe(
      "No share from this workspace includes this file.",
    );
    expect(screen.getByTestId("about-access-count").textContent).toBe("0");
  });

  it("names a received file's own grant within its coverage", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(
      answer({
        coverage: { kind: "received-own-grant", complete: true, observation: "interval" },
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
    ["other-account", OTHER_ACCOUNT, "This workspace syncs with another account. Connect that account to check who has access.", "Connect server", connect],
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

  it.each([
    ["hidden", "Shares do not include this file."],
    ["missing", "This file is no longer available at this path."],
  ] as const)("says what main found for a %s file whatever the account", async (visibility, words) => {
    bridgeMock.getObjectAccess.mockResolvedValue({ ...UNKNOWN, visibility });
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
      identity: "about-access:docs/plan.md",
      message: expect.stringContaining("disk is busy"),
      cause: error,
      retry: expect.any(Function),
    });
    await userEvent.setup().click(within(failed).getByText("Try again"));
    await screen.findByTestId("about-access-empty");
    expect(notices.clear).toHaveBeenLastCalledWith("about-access:docs/plan.md");
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
    expect(notices.clear).toHaveBeenCalledWith("about-access:docs/plan.md");
    // Each file files its own row, cleared before the next file reports.
    expect(notices.report.mock.calls.map(([failure]) => failure.identity)).toEqual([
      "about-access:docs/plan.md", "about-access:docs/other.md",
    ]);
    unmount();
    expect(notices.clear).toHaveBeenLastCalledWith("about-access:docs/other.md");
  });

  it("ends a row when the read key changes, even for the same path", async () => {
    bridgeMock.getObjectAccess.mockRejectedValue(new Error("disk is busy"));
    const { rerender } = render(<Access workspaceId="workspace-a" path="docs/plan.md" />);
    await waitFor(() => expect(notices.report).toHaveBeenCalledTimes(1));
    const clears = notices.clear.mock.calls.length;
    rerender(<Access workspaceId="workspace-b" path="docs/plan.md" />);
    expect(notices.clear.mock.calls.slice(clears).map(([identity]) => identity)).toContain("about-access:docs/plan.md");
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
    nextBeforeMomentOrder: more ? 1 : null,
    latestMomentOrder: 4,
    activeVersionId: "main",
    protectedTruncated: false,
  };
}

function HistorySection(props: {
  workspaceId?: string;
  objectId?: string;
  file?: AboutFile;
  revision?: number;
  onOpenMoment?: (id: string, path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <AboutHistory
      workspaceId={props.workspaceId ?? "workspace-a"}
      path="docs/plan.md"
      file={props.file ?? { status: "ready", objectId: props.objectId ?? "object-1" }}
      revision={props.revision ?? 0}
      expanded={open}
      onToggle={() => setOpen((current) => !current)}
      onOpenMoment={props.onOpenMoment ?? (() => undefined)}
      notices={notices}
    />
  );
}

describe("About History", () => {
  it("reads the file's newest changes by its object id and opens one", async () => {
    bridgeMock.listEngineMoments.mockResolvedValue(
      page([moment({ agentAuthorName: "Nova", summary: "Tightened the plan" }), moment({ id: "moment-2" })], true),
    );
    const onOpenMoment = vi.fn();
    render(<HistorySection onOpenMoment={onOpenMoment} />);
    const rows = await screen.findAllByTestId("about-history-open");
    expect(bridgeMock.listEngineMoments).toHaveBeenCalledWith({ workspaceId: "workspace-a", objectId: "object-1", limit: 5 });
    expect(rows[0]!.textContent).toContain("Tightened the plan");
    expect(rows[0]!.getAttribute("title")).toBe("Nova");
    expect(rows[1]!.textContent).toContain("Edited plan.md");
    expect(rows[1]!.getAttribute("title")).toBe("Live edit");
    expect(screen.getByTestId("about-history-count").textContent).toBe("2+");
    await userEvent.setup().click(rows[0]!);
    expect(onOpenMoment).toHaveBeenCalledWith("moment-1", "docs/plan.md");
  });

  it("keeps its place while the file's read runs, and offers that read's Try again when it fails", async () => {
    const { rerender } = render(<HistorySection file={{ status: "loading" }} />);
    expect(screen.getByTestId("about-history-toggle")).toBeTruthy();
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

  it("shows loading lines, then says when the file has no changes", async () => {
    const pending = deferred<ListEngineMomentsResponse>();
    bridgeMock.listEngineMoments.mockReturnValue(pending.promise);
    render(<HistorySection />);
    expect(screen.queryByTestId("about-history-empty")).toBeNull();
    expect(screen.queryByTestId("about-history-count")).toBeNull();
    await act(async () => pending.resolve(page([])));
    expect(screen.getByTestId("about-history-empty").textContent).toBe("History has no changes to this file yet.");
    expect(screen.getByTestId("about-history-count").textContent).toBe("0");
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
    expect(await screen.findAllByTestId("about-history-open")).toHaveLength(1);
    expect(notices.clear).toHaveBeenLastCalledWith("about-history:docs/plan.md");
  });

  it("draws History still updating in the section, files no row, and reads again on Try again", async () => {
    bridgeMock.listEngineMoments.mockResolvedValueOnce({ status: "updating" }).mockResolvedValue(page([moment()]));
    render(<HistorySection />);
    const held = await screen.findByTestId("about-history-held");
    expect(held.textContent).toContain("Workspace is still updating. Try again.");
    expect(screen.queryByTestId("about-history-empty")).toBeNull();
    expect(notices.report).not.toHaveBeenCalled();
    await userEvent.setup().click(within(held).getByText("Try again"));
    expect(await screen.findAllByTestId("about-history-open")).toHaveLength(1);
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
    expect((await screen.findByTestId("about-history-open")).textContent).toContain("Second file");
    await act(async () => forFirst.resolve(page([moment({ summary: "First file" })])));
    expect(screen.getAllByTestId("about-history-open").map((row) => row.dataset.momentId)).toEqual(["moment-b"]);
  });

  it("keeps its rows while it reads again after History grows", async () => {
    bridgeMock.listEngineMoments.mockResolvedValueOnce(page([moment({ summary: "Older" })]));
    const { rerender } = render(<HistorySection revision={1} />);
    await screen.findByTestId("about-history-open");
    const next = deferred<ListEngineMomentsResponse>();
    bridgeMock.listEngineMoments.mockReturnValueOnce(next.promise);
    rerender(<HistorySection revision={2} />);
    expect(screen.getByTestId("about-history-open").textContent).toContain("Older");
    await act(async () => next.resolve(page([moment({ id: "moment-new", summary: "Newer" }), moment({ summary: "Older" })])));
    expect(screen.getAllByTestId("about-history-open")).toHaveLength(2);
  });
});
