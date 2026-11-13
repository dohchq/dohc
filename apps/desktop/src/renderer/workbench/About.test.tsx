// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessAnswer, AccessShareRow } from "@dohc/workspace-contracts/access";
import type { ChatFileMentionsPage } from "@dohc/workspace-contracts/chat-file-mentions";
import type { LinksInResult } from "@dohc/workspace-contracts/links";
import { DaemonRefusalError } from "@dohc/workspace-engine-client";
import type { ChatFileMentionRecord, DohcDesktopBridge, EngineMomentRecord, ListEngineMomentsResponse } from "../../ipc/bridgeContract";
import { ipcWireError } from "../../ipc/errorWords";
import { deferred } from "../../testing/deferred";
import { historyCursor, historyPageFields } from "../../testing/historyPageFixture";
import { AboutAccess, AboutHistory, AboutLinks, type AboutFile } from "./About";
import type { AccessFacts } from "./accessReason";

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

function Access(props: { workspaceId?: string; path?: string; open?: boolean; facts?: AccessFacts; sharing?: boolean }) {
  const [open, setOpen] = useState(props.open ?? true);
  return (
    <AboutAccess
      workspaceId={props.workspaceId ?? "workspace-a"}
      subject={{ kind: "path", path: props.path ?? "docs/plan.md" }}
      expanded={open}
      onToggle={() => setOpen((current) => !current)}
      notices={notices}
      context={{ ...contextFor(props.facts ?? SYNCED), sharing: props.sharing ?? false }}
    />
  );
}

describe("About Access", () => {
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
    expect(screen.getAllByTestId("about-access-row").map((row) => row.textContent)).toEqual(["Bb@example.comCan edit"]);
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

  it.each(["chat-mention-access-changed"])(
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

describe("About History", () => {
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

});
