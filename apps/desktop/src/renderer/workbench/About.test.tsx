// @vitest-environment jsdom
import { formatChatTime } from "../time";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessAnswer, AccessShareRow } from "@dohc/workspace-contracts/access";
import type { ChatFileMentionsPage } from "@dohc/workspace-contracts/chat-file-mentions";
import type { LinksInResult } from "@dohc/workspace-contracts/links";
import { readStoredRoster } from "@dohc/automation-executor/roster-listing";
import { DaemonRefusalError } from "@dohc/workspace-engine-client";
import { createAccessQuery } from "../../access/accessQuery";
import type {
  ChatFileMentionRecord,
  DohcDesktopBridge,
  EngineMomentRecord,
  ListEngineMomentsResponse,
} from "../../ipc/bridgeContract";
import { ipcWireError } from "../../ipc/errorWords";
import { deferred } from "../../testing/deferred";
import { historyCursor, historyPageFields } from "../../testing/historyPageFixture";
import { AboutAccess, AboutHistory, AboutLinks, type AboutFile } from "./About";
import type { AccessFacts } from "./accessReason";

const bridgeMock = {
  getObjectAccess:
    vi.fn<
      (input: { workspaceId: string; ref: unknown; cursor?: string }) => Promise<AccessAnswer>
    >(),
  requestAccessRefresh:
    vi.fn<
      (input: {
        workspaceId: string;
        reason: string;
        wait?: true;
      }) => Promise<{ status: string } | undefined>
    >(),
  listEngineMoments:
    vi.fn<
      (input: {
        workspaceId: string;
        objectId?: string;
        limit?: number;
      }) => Promise<ListEngineMomentsResponse>
    >(),
  linksIn: vi.fn<DohcDesktopBridge["linksIn"]>(),
  chatFileMentionsPage: vi.fn<DohcDesktopBridge["chatFileMentionsPage"]>(),
  workspaceMembers: vi.fn<DohcDesktopBridge["workspaceMembers"]>(),
};

const notices = { report: vi.fn(), clear: vi.fn() };
const openSyncSettings = vi.fn();
const connect = vi.fn();
const SYNCED: AccessFacts = {
  cloud: { connected: true, workspaceSynced: true, workspaceSyncConnected: true },
  shareView: false,
};
beforeEach(() => {
  for (const mock of [
    ...Object.values(bridgeMock),
    notices.report,
    notices.clear,
    openSyncSettings,
    connect,
  ])
    mock.mockReset();
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
    unknownReason: null,
    coverage: { kind: "granted", complete: true, observation: "interval" },
    checkedAtMs: CHECKED_AT,
    freshness: "fresh",
    nextCursor: null,
    ...overrides,
  };
}

const UNKNOWN = answer({
  unknownReason: "not-listed-yet",
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

const contexts = new Map<
  AccessFacts,
  { facts: AccessFacts; openSyncSettings: () => void; connect: () => void }
>();
function contextFor(facts: AccessFacts) {
  let context = contexts.get(facts);
  if (!context) {
    context = { facts, openSyncSettings, connect };
    contexts.set(facts, context);
  }
  return context;
}

function Access(props: {
  workspaceId?: string;
  path?: string;
  open?: boolean;
  facts?: AccessFacts;
  sharing?: boolean;
  membershipLevel?: "view" | "comment" | "edit";
  membershipEnded?: boolean;
  ownName?: string;
  otherAccount?: { email: string | null };
}) {
  const [open, setOpen] = useState(props.open ?? true);
  return (
    <AboutAccess
      workspaceId={props.workspaceId ?? "workspace-a"}
      subject={{ kind: "path", path: props.path ?? "docs/plan.md" }}
      expanded={open}
      onToggle={() => setOpen((current) => !current)}
      notices={notices}
      context={{
        ...contextFor(props.facts ?? SYNCED),
        sharing: props.sharing ?? false,
        ...(props.membershipLevel ? { membershipLevel: props.membershipLevel } : {}),
        ...(props.membershipEnded ? { membershipEnded: true } : {}),
        ...(props.otherAccount ? { otherAccount: props.otherAccount } : {}),
        ...(props.ownName ? { ownName: props.ownName } : {}),
      }}
    />
  );
}

describe("About Access", () => {
  it("lists each grant with its person or link and its level, and counts only active grants", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(
      answer({
        rows: [
          share({
            via: "link",
            grantId: "grant-link",
            recipientEmail: null,
            recipientUserId: null,
            access: "view",
          }),
          share(),
          share({
            grantId: "grant-old",
            recipientEmail: "kim@example.com",
            status: "revoked",
            access: null,
          }),
          share({
            grantId: "grant-gone",
            recipientEmail: "lee@example.com",
            status: "removed",
            access: null,
          }),
        ],
      }),
    );
    render(<Access />);
    const result = await screen.findByTestId("about-access-answer");
    expect(result.dataset.freshness).toBe("fresh");
    expect(result.dataset.coverage).toBe("granted");
    expect(screen.queryByTestId("about-access-freshness")).toBeNull();
    expect(screen.getByTitle(`Checked ${formatChatTime(CHECKED_AT).label}`)).toBeTruthy();
    const rows = screen.getAllByTestId("about-access-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Anyone with the linkCan view",
      "Ssam@example.comCan edit",
      "Kkim@example.comEnded",
      "Llee@example.comEnded",
    ]);
    expect(within(rows[0]!).getByText("Can view")).toBeTruthy();
    expect(within(rows[1]!).getByText("Can edit")).toBeTruthy();
    expect(within(rows[1]!).getByText("Can edit").classList.contains("text-muted")).toBe(true);
    expect(within(rows[2]!).queryByRole("img")).toBeNull();
    expect(screen.getByTestId("about-access-count").textContent).toBe("2");
    expect(rows.map((row) => row.querySelector(".flex-1")!.classList.contains("text-ink"))).toEqual(
      [true, true, false, false],
    );
  });

  // The owner's Access lists the people the Members page lists, with the
  // owner, their roles and the members' level once, beside the file's other shares.
  it("lists an owned workspace's people by name and role, with the members' level once", async () => {
    const membership = (grantId: string, recipientEmail: string, access: "comment" | "edit") =>
      share({
        shareId: "membership",
        grantId,
        recipientUserId: grantId,
        recipientEmail,
        selector: { kind: "workspace" },
        access,
      });
    bridgeMock.getObjectAccess.mockResolvedValue(
      answer({
        rows: [
          membership("m-sam", "sam@example.com", "comment"),
          membership("m-kai", "kai@example.com", "edit"),
          share({
            shareId: "link-1",
            grantId: "link-grant",
            via: "link",
            recipientUserId: null,
            recipientEmail: null,
            access: "view",
          }),
        ],
      }),
    );
    const person = (
      memberId: string,
      role: "owner" | "admin" | "member",
      name: string | null,
      email: string,
      state: "active" | "invited" | "removed" = "active",
    ) => ({
      memberId,
      role,
      state,
      name,
      email,
      invitedAtMs: null,
      joinedAtMs: 1,
      removedAtMs: state === "removed" ? 2 : null,
    });
    bridgeMock.workspaceMembers.mockResolvedValue({
      status: "ready",
      view: {
        workspaceId: "workspace-a",
        workspaceName: "Lisbon trip",
        viewer: { memberId: "owner", role: "owner" },
        memberLevel: "comment",
        inviteLink: { enabled: false, url: null },
        people: [
          person("owner", "owner", "Ana Ruiz", "ana@example.com"),
          person("m-kai", "admin", "Kai", "kai@example.com"),
          person("m-sam", "member", null, "sam@example.com"),
          person("m-lee", "member", null, "lee@example.com", "invited"),
          person("m-old", "member", "Old", "old@example.com", "removed"),
        ],
      },
    });
    render(<Access />);
    await waitFor(() => expect(screen.getAllByTestId("about-access-person")).toHaveLength(3));
    expect(screen.getAllByTestId("about-access-person").map((row) => row.textContent)).toEqual([
      "AAna RuizYouOwner",
      "KKaiAdmin",
      "Ssam@example.comMember",
    ]);
    expect(screen.getByTestId("about-access-member-level").textContent).toBe("Members can comment");
    // The memberships become the people list; the link stays a share row.
    expect(screen.getAllByTestId("about-access-row").map((row) => row.dataset.via)).toEqual([
      "link",
    ]);
    expect(screen.queryByText("Can edit")).toBeNull();
    expect(screen.getByTestId("about-access-count").textContent).toBe("4");
  });

  it("lists the workspace's members, not Only you, for a tracked file with no share", async () => {
    // A relay that lists no Members page leaves main's rows.
    bridgeMock.workspaceMembers.mockResolvedValue({ status: "refused" });
    const member = (grantId: string, recipientEmail: string, access: "comment" | "edit") => ({
      shareId: "membership",
      grantId,
      granterUserId: "owner",
      granterEmail: "owner@example.com",
      recipientUserId: grantId,
      recipientEmail,
      subjectName: null,
      sharerName: null,
      generation: 1,
      status: "active" as const,
      selector: { kind: "workspace" as const },
      access,
    });
    const listing = readStoredRoster({
      grants: [
        member("ana", "ana@example.com", "comment"),
        member("ben", "ben@example.com", "edit"),
      ],
      links: [],
      formerGrants: [],
      endedGrants: [],
    })!;
    bridgeMock.getObjectAccess.mockResolvedValue(
      createAccessQuery().answer({
        observation: { listing, checkedAtMs: CHECKED_AT, freshness: "fresh" },
        recipientUserId: "owner",
        cursorScope: "scope",
        ref: { kind: "path", path: "docs/plan.md", versionId: null },
        coverage: "granted",
      }),
    );
    render(<Access />);
    const rows = await screen.findAllByTestId("about-access-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Aana@example.comCan comment",
      "Bben@example.comCan edit",
    ]);
    expect(screen.queryByTestId("about-access-empty")).toBeNull();
    expect(screen.queryByText("Only you")).toBeNull();
  });

  // Your own row reads "You", and its avatar takes the letter of your name, not of "You".
  it("marks your own row with your name's letter", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(
      answer({
        unknownReason: null,
        coverage: { kind: "received-own-grant", complete: true, observation: "interval" },
        rows: [
          share({
            via: "received",
            sharerName: "Sam",
            subjectName: "Community",
            access: "comment",
            selector: { kind: "workspace", role: "member" },
          }),
        ],
      }),
    );
    render(<Access ownName="ana" />);
    const row = await screen.findByTestId("about-access-row");
    const avatar = row.querySelector<HTMLElement>("span[aria-hidden]")!;
    expect(avatar.textContent).toBe("A");
    expect(row.textContent).toBe("AYouCan comment");
  });

  // Members answers only the account that joined. The band says why, with Switch account, so Access
  // says only why it lists no one, and offers no Try again that could not succeed.
  it.each(["lee@dohc.test", null] as const)(
    "says another account is signed in, in place of Members, for %s",
    async (email) => {
      bridgeMock.workspaceMembers.mockRejectedValue(
        new Error(
          "This computer is signed in to a different account than the one the owner invited.",
        ),
      );
      bridgeMock.getObjectAccess.mockResolvedValue(
        answer({
          unknownReason: null,
          coverage: { kind: "received-own-grant", complete: true, observation: "interval" },
          rows: [
            share({
              via: "received",
              sharerName: "Ana",
              subjectName: "Lisbon trip",
              access: "edit",
              selector: { kind: "workspace", role: "member" },
            }),
          ],
        }),
      );
      render(<Access membershipLevel="edit" otherAccount={{ email }} />);
      const note = await screen.findByTestId("about-access-other-account");
      expect(note.textContent).toBe("Signed in as another account");
      expect(screen.queryByTestId("about-access-failed")).toBeNull();
      expect(within(note).queryByRole("button")).toBeNull();
      expect(screen.queryByTestId("about-access-count")).toBeNull();
      expect(bridgeMock.workspaceMembers).not.toHaveBeenCalled();
      expect(notices.report).not.toHaveBeenCalled();
    },
  );

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

  it("neither reports nor clears when workspace A's read fails after the switch to B", async () => {
    const forA = deferred<AccessAnswer>();
    bridgeMock.getObjectAccess.mockImplementation(({ workspaceId }) =>
      workspaceId === "workspace-a" ? forA.promise : Promise.resolve(answer()),
    );
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

  it("never shows workspace A's answer after a switch to workspace B", async () => {
    const forA = deferred<AccessAnswer>();
    bridgeMock.getObjectAccess.mockImplementation(({ workspaceId }) =>
      workspaceId === "workspace-a"
        ? forA.promise
        : Promise.resolve(answer({ rows: [share({ recipientEmail: "b@example.com" })] })),
    );
    const { rerender } = render(<Access workspaceId="workspace-a" />);
    await waitFor(() => expect(bridgeMock.getObjectAccess).toHaveBeenCalledTimes(1));
    rerender(<Access workspaceId="workspace-b" />);
    expect((await screen.findByTestId("about-access-row")).textContent).toContain("b@example.com");

    await act(async () =>
      forA.resolve(answer({ rows: [share({ recipientEmail: "a@example.com" })] })),
    );
    expect(screen.getAllByTestId("about-access-row").map((row) => row.textContent)).toEqual([
      "Bb@example.comCan edit",
    ]);
  });

  it("reads from the start when the listing changed under its cursor", async () => {
    bridgeMock.getObjectAccess
      .mockResolvedValueOnce(answer({ rows: [share()], nextCursor: "page-2" }))
      .mockResolvedValueOnce({ ...UNKNOWN, visibility: "unknown" })
      .mockResolvedValueOnce(
        answer({
          rows: [share(), share({ grantId: "grant-new", recipientEmail: "new@example.com" })],
        }),
      );
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

function link(source: string, line: number, ordinal = 0): LinkRecord {
  const title = source.split("/").at(-1)!.replace(/\.md$/, "");
  const snippet = `${title} cites [[plan]] here.`;
  const start = snippet.indexOf("[[");
  return {
    source,
    title,
    ordinal,
    span: [start, start + 8],
    line,
    snippet,
    highlightStart: start,
    highlightEnd: start + 8,
  };
}

function linksPage(entries: LinkRecord[], overrides: Partial<LinksPage> = {}): LinksPage {
  return {
    versionId: "main",
    subject: { path: "docs/plan.md", objectId: "plan" },
    entries,
    unchecked: [],
    complete: true,
    indexBuilding: false,
    mountsCovered: true,
    nextCursor: null,
    ...overrides,
  };
}

function chatLink(
  id: string,
  overrides: Partial<ChatFileMentionRecord> = {},
): ChatFileMentionRecord {
  return {
    attachment: {
      attachmentId: `attachment-${id}`,
      threadId: `thread-${id}`,
      messageId: `message-${id}`,
      targetKind: "file",
      objectId: "plan",
      pathHint: "docs/plan.md",
      createdAtMs: CHECKED_AT,
    },
    message: {
      id: `message-${id}`,
      authorDisplayName: "Sam",
      preview: `See docs/plan.md ${id}`,
      createdAtMs: CHECKED_AT,
    },
    thread: {
      id: `thread-${id}`,
      title: `Thread ${id}`,
      createdAtMs: CHECKED_AT,
      updatedAtMs: CHECKED_AT,
    },
    ...overrides,
  };
}

function chatPage(
  entries: ChatFileMentionRecord[],
  nextCursor: string | null = null,
): NonNullable<ChatFileMentionsPage> {
  return {
    versionId: "main",
    subject: { objectId: "plan", path: "docs/plan.md" },
    entries,
    unchecked: [],
    complete: true,
    indexBuilding: false,
    mountsCovered: true,
    sharedChannelRowsUncovered: 0,
    nextCursor,
  };
}

// IntersectionObserver for rows that are in view: it reports once on
// observe, as the browser's first report does. What it returns scrolls every
// observed row out of view and back, so each reports again.
function observeAllInView() {
  const live = new Set<() => void>();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private report: (() => void) | null = null;
      private readonly callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        const report = () =>
          this.callback(
            [{ isIntersecting: true, target } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        this.report = report;
        live.add(report);
        void Promise.resolve().then(() => {
          if (live.has(report)) report();
        });
      }
      disconnect() {
        if (this.report) live.delete(this.report);
      }
    },
  );
  return async () => {
    for (let pass = 0; pass < 3; pass += 1) {
      act(() => {
        for (const report of live) report();
      });
      await settleAll();
    }
  };
}

async function settleAll() {
  for (let round = 0; round < 6; round += 1) await act(async () => {});
}

const openLink = vi.fn<(path: string, line: number) => void>();
const openChat = vi.fn<(mention: ChatFileMentionRecord) => void>();

function Links(props: {
  workspaceId?: string;
  path?: string;
  revision?: number;
  open?: boolean;
  chats?: boolean;
}) {
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
    expect(bridgeMock.linksIn.mock.calls.map(([input]) => input.cursor)).toEqual([
      undefined,
      "one",
      undefined,
      "one",
    ]);
  });

  it("reads Show more after a read again lands, so a page never lands on rows that read replaced", async () => {
    bridgeMock.linksIn.mockResolvedValueOnce(
      linksPage([link("notes/alpha.md", 2), link("notes/removed.md", 3)], { nextCursor: "first" }),
    );
    const view = render(<Links revision={0} />);
    await waitFor(() => expect(linkRows()).toHaveLength(2));

    const again = deferred<LinksPage>();
    bridgeMock.linksIn
      .mockReturnValueOnce(again.promise)
      .mockResolvedValueOnce(linksPage([link("notes/gamma.md", 7)]));
    view.rerender(<Links revision={1} />);
    await waitFor(() => expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2));
    await userEvent.setup().dblClick(screen.getByTestId("about-links-more"));
    expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2);

    await act(async () =>
      again.resolve(
        linksPage([link("notes/alpha.md", 2), link("notes/beta.md", 5)], {
          nextCursor: "after-beta",
        }),
      ),
    );
    await waitFor(() => expect(linkRows()).toHaveLength(3));
    expect(linkRows().map((row) => row.dataset.path)).toEqual([
      "notes/alpha.md",
      "notes/beta.md",
      "notes/gamma.md",
    ]);
    expect(bridgeMock.linksIn.mock.calls.map(([input]) => input.cursor)).toEqual([
      undefined,
      undefined,
      "after-beta",
    ]);
  });

  // A joined workspace's pull changes its files again and again while it
  // lands, each time before the read from the start answers. A read the next
  // one replaced still fills the lists while they show nothing, so they never
  // stay loading while answers arrive.
  it("shows a replaced first read's rows while nothing is shown, until the newer read lands", async () => {
    const first = deferred<LinksPage>(),
      second = deferred<LinksPage>();
    const firstChats = deferred<NonNullable<ChatFileMentionsPage>>(),
      secondChats = deferred<NonNullable<ChatFileMentionsPage>>();
    bridgeMock.linksIn.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    bridgeMock.chatFileMentionsPage
      .mockReturnValueOnce(firstChats.promise)
      .mockReturnValueOnce(secondChats.promise);
    const view = render(<Links chats revision={0} />);
    await waitFor(() => expect(bridgeMock.linksIn).toHaveBeenCalledTimes(1));
    view.rerender(<Links chats revision={1} />);
    await waitFor(() => expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2));
    expect(bridgeMock.chatFileMentionsPage).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve(linksPage([link("notes/alpha.md", 2)]));
      firstChats.resolve(chatPage([chatLink("one")]));
    });
    expect(linkRows().map((row) => row.dataset.path)).toEqual(["notes/alpha.md"]);
    expect(screen.getAllByTestId("chat-file-mention")).toHaveLength(1);

    await act(async () => {
      second.resolve(linksPage([link("notes/alpha.md", 2), link("notes/beta.md", 5)]));
      secondChats.resolve(chatPage([chatLink("one"), chatLink("two")]));
    });
    expect(linkRows().map((row) => row.dataset.path)).toEqual(["notes/alpha.md", "notes/beta.md"]);
    expect(screen.getAllByTestId("chat-file-mention")).toHaveLength(2);
  });

  it("keeps the newer read's rows when a replaced read answers after it", async () => {
    const first = deferred<LinksPage>(),
      second = deferred<LinksPage>();
    bridgeMock.linksIn.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<Links revision={0} />);
    await waitFor(() => expect(bridgeMock.linksIn).toHaveBeenCalledTimes(1));
    view.rerender(<Links revision={1} />);
    await waitFor(() => expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve(linksPage([link("notes/beta.md", 5)])));
    expect(linkRows().map((row) => row.dataset.path)).toEqual(["notes/beta.md"]);
    await act(async () => first.resolve(linksPage([link("notes/removed.md", 3)])));
    expect(linkRows().map((row) => row.dataset.path)).toEqual(["notes/beta.md"]);
  });

  it("asks for one page however often Show more is pressed while that page is read", async () => {
    bridgeMock.linksIn.mockResolvedValueOnce(
      linksPage([link("notes/alpha.md", 2)], { nextCursor: "after-alpha" }),
    );
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
    expect(linkRows().map((row) => row.dataset.line)).toEqual(["2", "5"]);
    await act(async () => last.resolve(linksPage([link("notes/gamma.md", 7)])));
    expect(linkRows().map((row) => row.dataset.path)).toEqual(["notes/alpha.md", "notes/gamma.md"]);
    expect(bridgeMock.linksIn.mock.calls.slice(2).map(([input]) => input.cursor)).toEqual([
      undefined,
      "one",
    ]);

    bridgeMock.linksIn
      .mockResolvedValueOnce(linksPage([link("notes/alpha.md", 4)], { nextCursor: "one" }))
      .mockResolvedValueOnce(linksPage([]));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(linkRows().map((row) => row.dataset.line)).toEqual(["4"]));
    expect(bridgeMock.linksIn).toHaveBeenCalledTimes(6);
  });

  it("reports a failed read to the shell, shows only Try again, and clears the row once a read answers", async () => {
    const error = new Error("engine unavailable");
    bridgeMock.linksIn
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(linksPage([link("notes/alpha.md", 2)]));
    render(<Links />);
    await screen.findByTestId("about-links-failed");
    expect(notices.report).toHaveBeenCalledOnce();
    const report = notices.report.mock.calls[0]![0] as {
      identity: string;
      message: string;
      cause: unknown;
      retry: () => void;
    };
    expect(report).toMatchObject({
      identity: "about-links:docs/plan.md",
      message: expect.stringContaining("engine unavailable"),
      cause: error,
    });
    expect(screen.getByTestId("about-links-failed").textContent).toBe("Try again");

    await act(async () => report.retry());
    await waitFor(() => expect(linkRows()).toHaveLength(1));
    expect(notices.clear).toHaveBeenCalledWith("about-links:docs/plan.md");
  });

  it("never shows a reply for a file or workspace it left, nor asks for its next page", async () => {
    const old = deferred<LinksPage>();
    bridgeMock.linksIn
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(linksPage([link("notes/current.md", 2)]));
    const view = render(<Links workspaceId="workspace-a" path="docs/plan.md" />);
    view.rerender(<Links workspaceId="workspace-b" path="docs/other.md" />);
    await waitFor(() => expect(linkRows()).toHaveLength(1));
    await act(async () =>
      old.resolve(linksPage([link("notes/stale.md", 2)], { nextCursor: "stale-next" })),
    );
    expect(linkRows().map((row) => row.dataset.path)).toEqual(["notes/current.md"]);
    expect(bridgeMock.linksIn).toHaveBeenCalledTimes(2);
    expect(bridgeMock.linksIn).toHaveBeenLastCalledWith({
      workspaceId: "workspace-b",
      subject: { path: "docs/other.md" },
    });
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
    expect(bridgeMock.chatFileMentionsPage).toHaveBeenLastCalledWith({
      workspaceId: "workspace-a",
      subject: { path: "docs/plan.md" },
      cursor: "next",
    });
    expect(screen.queryByTestId("about-chat-links-more")).toBeNull();
    expect(document.activeElement).toBe(screen.getAllByTestId("chat-file-mention")[1]);
    expect(document.activeElement?.getAttribute("data-thread-id")).toBe("thread-two");
  });

  it.each(["chat-mention-access-changed"])(
    "drops chat rows and reads once from the start when their cursor's %s",
    async (reason) => {
      const refusal = () =>
        new Error(
          `Error invoking remote method 'desktop:chat-file-mentions-page': ${String(ipcWireError(new DaemonRefusalError({ code: "CONFLICT", message: reason, retry: "no" }, null)))}`,
        );
      const restarted = deferred<NonNullable<ChatFileMentionsPage>>();
      bridgeMock.linksIn.mockResolvedValue(linksPage([link("notes/alpha.md", 2)]));
      bridgeMock.chatFileMentionsPage
        .mockResolvedValueOnce(chatPage([chatLink("old")], "next"))
        .mockRejectedValueOnce(refusal())
        .mockReturnValueOnce(restarted.promise);
      render(<Links chats />);
      await userEvent.setup().click(await screen.findByTestId("about-chat-links-more"));
      await waitFor(() => expect(bridgeMock.chatFileMentionsPage).toHaveBeenCalledTimes(3));
      expect(bridgeMock.chatFileMentionsPage.mock.calls[2]![0]).toEqual({
        workspaceId: "workspace-a",
        subject: { path: "docs/plan.md" },
      });
      expect(screen.queryByTestId("chat-file-mention")).toBeNull();
      expect(notices.report).not.toHaveBeenCalled();

      await act(async () => restarted.reject(refusal()));
      expect(notices.report).toHaveBeenCalledOnce();
      expect(notices.report.mock.calls[0]![0]).toMatchObject({
        identity: "about-chat-links:docs/plan.md",
      });
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
    activeVersionId: "main",
    ...historyPageFields,
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
      objectId === "object-1"
        ? forFirst.promise
        : Promise.resolve(page([moment({ id: "moment-b", summary: "Second file" })])),
    );
    const { rerender } = render(<HistorySection objectId="object-1" />);
    await waitFor(() => expect(bridgeMock.listEngineMoments).toHaveBeenCalledTimes(1));
    rerender(<HistorySection objectId="object-2" />);
    expect((await screen.findByTestId("engine-moment-open")).textContent).toContain("Second file");
    await act(async () => forFirst.resolve(page([moment({ summary: "First file" })])));
    expect(screen.getAllByTestId("engine-moment-open").map((row) => row.dataset.momentId)).toEqual([
      "moment-b",
    ]);
  });

  it("folds an agent's run into one row and shows the three latest rows", async () => {
    const agent = {
      kind: "agent" as const,
      agentId: "nova",
      agentRunId: "run",
      onBehalfOf: "device",
    };
    const run = ["run-1", "run-2", "run-3"].map((id) =>
      moment({
        id,
        agentAuthorName: "Nova",
        authors: [agent],
        authorPresentations: [{ group: "agent:nova", hue: null, self: false }],
      }),
    );
    const edits = ["edit-1", "edit-2", "edit-3"].map((id) => moment({ id }));
    bridgeMock.listEngineMoments.mockResolvedValue(page([...run, ...edits]));
    render(<HistorySection />);
    const rows = await screen.findAllByTestId("engine-moment-open");
    expect(rows.map((row) => row.dataset.momentId)).toEqual(["run-1", "edit-1", "edit-2"]);
    const fold = screen.getByTestId("engine-moment-run-toggle");
    expect(fold.getAttribute("aria-label")).toBe("3 changes");
    expect(screen.getByTestId("about-history-count").textContent).toBe("6");
    await userEvent.setup().click(fold);
    expect(screen.getAllByTestId("engine-moment-open").map((row) => row.dataset.momentId)).toEqual([
      "run-1",
      "run-2",
      "run-3",
      "edit-1",
      "edit-2",
    ]);
  });
});

it("names the membership that reaches a file in a joined workspace", async () => {
  bridgeMock.getObjectAccess.mockResolvedValue(
    answer({
      unknownReason: null,
      coverage: { kind: "received-own-grant", complete: true, observation: "interval" },
      rows: [
        share({
          via: "received",
          sharerName: "Sam",
          subjectName: "Community",
          access: "comment",
          selector: { kind: "workspace", role: "member" },
        }),
      ],
    }),
  );
  render(<Access />);
  const row = await screen.findByTestId("about-access-row");
  expect(row.textContent).toContain("You");
  expect(within(row).getByText("Can comment")).toBeTruthy();
  expect(screen.queryByText("No share to you includes this file.")).toBeNull();
});

it("shows a member who joined inside the pacing window once the paced retry lists them", async () => {
  vi.useFakeTimers();
  try {
    let listed = answer();
    const sam = share({
      shareId: "membership",
      grantId: "sam",
      selector: { kind: "workspace" },
      access: "comment",
    });
    bridgeMock.requestAccessRefresh.mockImplementation(async (input: { wait?: true }) => {
      if (!input.wait) return { status: "paced" };
      // Main's scheduled retry, a minute after the last listing.
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      listed = answer({ rows: [sam] });
      return { status: "joined" };
    });
    bridgeMock.getObjectAccess.mockImplementation(async () => listed);
    render(<Access />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("about-access-empty").textContent).toBe("No one else");
    const pending = screen.getByTestId("about-access-freshness");
    expect(pending.getAttribute("data-state")).toBe("stale");
    expect(pending.textContent).toContain("May be out of date");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(screen.getByTestId("about-access-freshness").getAttribute("data-state")).toBe("stale");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getAllByTestId("about-access-row").map((row) => row.textContent)).toEqual([
      "Ssam@example.comCan comment",
    ]);
    expect(screen.queryByTestId("about-access-empty")).toBeNull();
    expect(screen.queryByTestId("about-access-freshness")).toBeNull();
    expect(bridgeMock.requestAccessRefresh.mock.calls).toEqual([
      [{ workspaceId: "workspace-a", reason: "access-expand" }],
      [{ workspaceId: "workspace-a", reason: "access-expand", wait: true }],
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("shows a membership's new level at once, before main lists it", async () => {
  bridgeMock.workspaceMembers.mockResolvedValue({ status: "refused" });
  bridgeMock.getObjectAccess.mockResolvedValue(
    answer({
      unknownReason: null,
      coverage: { kind: "received-own-grant", complete: true, observation: "interval" },
      rows: [
        share({
          via: "received",
          sharerName: "Sam",
          subjectName: "Community",
          access: "comment",
          selector: { kind: "workspace", role: "member" },
        }),
      ],
    }),
  );
  const { rerender } = render(<Access membershipLevel="comment" />);
  const row = await screen.findByTestId("about-access-row");
  expect(within(row).getByText("Can comment")).toBeTruthy();
  rerender(<Access membershipLevel="view" />);
  expect(within(screen.getByTestId("about-access-row")).getByText("Can view")).toBeTruthy();
});

it("lists everyone in a joined workspace by name and role, from the Members page's source", async () => {
  bridgeMock.getObjectAccess.mockResolvedValue(
    answer({
      unknownReason: null,
      coverage: { kind: "received-own-grant", complete: true, observation: "interval" },
      rows: [
        share({
          via: "received",
          sharerName: "Ana",
          subjectName: "Lisbon trip",
          access: "comment",
          selector: { kind: "workspace", role: "member" },
        }),
      ],
    }),
  );
  const person = (memberId: string, role: "owner" | "admin" | "member", name: string | null) => ({
    memberId,
    role,
    state: "active" as const,
    name,
    email: null,
    invitedAtMs: null,
    joinedAtMs: 1,
    removedAtMs: null,
  });
  bridgeMock.workspaceMembers.mockResolvedValue({
    status: "ready",
    view: {
      workspaceId: "workspace-a",
      workspaceName: "Lisbon trip",
      viewer: { memberId: "m-sam", role: "member" },
      memberLevel: "comment",
      inviteLink: null,
      people: [
        person("owner", "owner", "Ana Ruiz"),
        person("m-lee", "admin", "Lee Park"),
        person("m-sam", "member", "Sam Rivera"),
        person("m-kit", "member", null),
      ],
    },
  });
  render(<Access membershipLevel="comment" />);
  await waitFor(() => expect(screen.getAllByTestId("about-access-person")).toHaveLength(4));
  expect(bridgeMock.workspaceMembers).toHaveBeenCalledWith({
    workspaceId: "workspace-a",
    request: { action: "list" },
  });
  const rows = screen.getAllByTestId("about-access-person");
  expect(rows.map((row) => row.textContent)).toEqual([
    "AAna RuizOwner",
    "LLee ParkAdmin",
    "SSam RiveraYouMember",
    "NNo nameMember",
  ]);
  expect(screen.getByTestId("about-access-count").textContent).toBe("4");
  expect(screen.queryByTestId("about-access-row")).toBeNull();
  expect(document.body.textContent).not.toContain("@");
});

it("says on the member's own row, beside the role, that the membership ended", async () => {
  bridgeMock.getObjectAccess.mockResolvedValue(
    answer({
      unknownReason: null,
      coverage: { kind: "received-own-grant", complete: true, observation: "interval" },
      rows: [
        share({
          via: "received",
          sharerName: "Ana",
          subjectName: "Lisbon trip",
          access: "edit",
          selector: { kind: "workspace", role: "member" },
        }),
      ],
    }),
  );
  render(<Access membershipLevel="edit" membershipEnded />);
  const row = await screen.findByTestId("about-access-row");
  expect(row.dataset.status).toBe("revoked");
  // The avatar shows the initial.
  expect(row.textContent).toBe("YYouMember · Ended");
  expect(bridgeMock.workspaceMembers).not.toHaveBeenCalled();
});
