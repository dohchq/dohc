// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessAnswer } from "@dohc/workspace-contracts/access";
import type { ChatLinksPage } from "@dohc/workspace-contracts/chat-links";
import { deferred } from "../../testing/deferred";
import type { PresencePeer } from "../collab/presenceChannel";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { publishAboutConversation, type AboutConversation } from "../workbench/aboutConversation";
import { setChosenColors } from "../workbench/chosenColors";
import { settingsWithAgent } from "../../testing/agentSettings";
import { ReactionStoreProvider } from "../workbench/reactionStore";
import { CHATS_TAB_PATH, GRAPH_TAB_PATH, chatTabPath, defaultWorkbenchState } from "../workbench/workbenchState";
import { ShellAboutRail, type AboutSearchHit } from "./ShellAboutRail";

const bridgeMock = {
  getObjectAccess: vi.fn<(input: { workspaceId: string; ref: unknown }) => Promise<AccessAnswer>>(),
  requestAccessRefresh: vi.fn(async () => undefined),
  listFileChats: vi.fn(),
  listChatMessages: vi.fn(),
  listChatReactions: vi.fn(),
  markChatThreadRead: vi.fn(),
  listEngineMoments: vi.fn(),
  linksIn: vi.fn(async () => null),
  chatFileMentionsPage: vi.fn(async () => null),
  chatLinks: vi.fn<(input: { workspaceId: string; channelWireId: string; cursor?: string }) => Promise<ChatLinksPage>>(),
};
const notices = { report: vi.fn(), clear: vi.fn() };
const accessContext = {
  facts: { cloud: { connected: true, workspaceSynced: true, workspaceSyncConnected: true }, shareView: false },
  openSyncSettings: () => undefined,
  connect: () => undefined,
} as const;

const GENERAL = chatTabPath({ kind: "channel", id: "general" });
const LAUNCH = chatTabPath({ kind: "channel", id: "launch" });
const SAM_DM = chatTabPath({ kind: "dm", id: "dm-sam" });
const AGENT = chatTabPath({ kind: "channel", id: "agent" });

const peer = (faceToken: string, displayName: string): PresencePeer => ({
  faceToken, sessionToken: `${faceToken}-session`, isSelf: false, displayName, paletteSlot: 1, state: null, updatedAtMs: 0,
});
const conversation = (overrides: Partial<AboutConversation>): AboutConversation => ({
  kind: "group", name: "general", channelWireId: "wire-general", received: false, present: [], ...overrides,
});

function answer(rows: AccessAnswer["rows"] = []): AccessAnswer {
  return {
    ref: { kind: "chat", channelWireId: "wire-general" }, rows, visibility: "visible",
    unknownReason: null, coverage: { kind: "granted", complete: true, observation: "interval" },
    checkedAtMs: Date.UTC(2026, 9, 9), freshness: "fresh", nextCursor: null,
  };
}

type Page = NonNullable<ChatLinksPage>;
type Mention = Page["entries"][number];
const NOVA = { kind: "agent", displayName: "Nova", presentation: { group: "nova", hue: null, self: false } } as const;
const SAM = { kind: "human", displayName: "Sam Rivera", presentation: { group: "sam", hue: "rust", self: false } } as const;
// One mention of a file, newest first by `at`.
function mention(path: string, author: Mention["author"], at: number): Mention {
  return {
    threadId: "thread-1", messageId: `message-${at}`, mentionedAtMs: at, author,
    file: { objectId: `object:${path}`, path, folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" },
  };
}
function linksPage(entries: Mention[], overrides: Partial<Page> = {}): Page {
  return {
    versionId: "main", subject: { channelWireId: "wire-general" }, entries, unchecked: [], complete: true,
    indexBuilding: false, mountsCovered: true, sharedChannelRowsUncovered: 0, nextCursor: null, ...overrides,
  };
}
// Each row: its file, then who mentioned it.
const linkRows = () => screen.queryAllByTestId("about-conversation-link").map((row) =>
  [row.dataset.path, within(row).getByTestId("about-conversation-link-authors").textContent]);

// A hit as the shell mints it, for the tab it belongs to.
const searchHit = (tab: string, id: string, title: string): AboutSearchHit => ({
  thread: { id, title, createdAtMs: 1, updatedAtMs: 1 }, tab, read: false,
});

const withdrawals: Array<() => void> = [];
function publish(workspaceId: string, tabPath: string, entry: AboutConversation | "none") {
  let withdraw = () => {};
  act(() => {
    withdraw = publishAboutConversation(workspaceId, tabPath, entry);
  });
  withdrawals.push(withdraw);
  return withdraw;
}

// The workspace shell provides the reaction store in production.
function Rail(props: Partial<ComponentProps<typeof ShellAboutRail>>) {
  return (
    <ReactionStoreProvider workspaceId={props.workspaceId ?? "workspace-a"}>
      <ShellAboutRail
        wb={defaultWorkbenchState()}
        mutateWb={() => undefined}
        captureAvailable
        captureDecided
        focusedTabPath={GENERAL}
        syncStatus={null}
        workspaceId="workspace-a"
        activeDocumentPath={null}
        aboutTabOpen={false}
        shareView={null}
        searchChatTarget={null}
        onSearchHitRead={() => undefined}
        onSearchHitClosed={() => undefined}
        openPathWithHeading={() => undefined}
        onChatsThreadRead={() => undefined}
        reportFailureMessage={() => undefined}
        historyRevision={0}
        openMoment={() => undefined}
        linksRevision={0}
        openPathAtLine={() => undefined}
        openChatMention={() => undefined}
        aboutNotices={notices}
        accessContext={accessContext}
        {...props}
      />
    </ReactionStoreProvider>
  );
}

beforeEach(() => {
  for (const mock of [...Object.values(bridgeMock), notices.report, notices.clear]) mock.mockReset();
  bridgeMock.requestAccessRefresh.mockResolvedValue(undefined);
  bridgeMock.chatLinks.mockResolvedValue(linksPage([]));
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  act(() => {
    for (const withdraw of withdrawals.splice(0)) withdraw();
    setChosenColors(DEFAULT_USER_SETTINGS);
  });
  cleanup();
  vi.unstubAllGlobals();
});

describe("About for an open conversation", () => {
  it("loads until the conversation's page says what it shows", async () => {
    render(<Rail />);
    expect(screen.getByText("Loading About...")).toBeTruthy();
    expect(screen.queryByTestId("about-header")).toBeNull();
    publish("workspace-a", GENERAL, conversation({}));
    expect((await screen.findByTestId("about-header")).textContent).toBe("general");
  });

  it.each([
    ["group", GENERAL, conversation({ present: [peer("sam", "Sam Rivera"), peer("nova", "Nova")] }), "2 people here"],
    ["person", SAM_DM, conversation({ kind: "person", name: "Sam Rivera", channelWireId: "wire-dm", present: [peer("sam", "Sam Rivera")] }), "Sam Rivera is here"],
    ["agent", AGENT, conversation({ kind: "agent", name: "Nova", channelWireId: "wire-agent" }), null],
  ] as const)("shows a %s's name, its mark, and who is here", async (kind, tabPath, entry, here) => {
    // Your agent in the color you chose, so its avatar shows it is yours.
    setChosenColors(settingsWithAgent({ hue: "teal" }));
    publish("workspace-a", tabPath, entry);
    render(<Rail focusedTabPath={tabPath} />);
    const panel = await screen.findByTestId("about-panel");
    expect(panel.dataset.conversationKind).toBe(kind);
    const header = screen.getByTestId("about-header");
    const name = within(header).getByText(entry.name);
    // A long name truncates, so its whole text is in the tooltip.
    expect(name.getAttribute("title")).toBe(entry.name);
    const avatar = header.querySelector(`span[aria-hidden][title="${entry.name}"]`);
    if (kind === "group") {
      expect(header.querySelector(".lucide-hash")).toBeTruthy();
      expect(avatar).toBeNull();
    } else if (kind === "person") {
      expect(header.querySelector(".lucide-hash")).toBeNull();
      expect(avatar?.textContent).toBe("S");
    } else {
      expect(avatar?.querySelector(".lucide-sparkles")).toBeTruthy();
      expect(avatar?.className).toContain("text-hue-teal");
    }
    // The faces keep their name, and the page's own header is the one live
    // region that announces them.
    if (here) expect(within(header).getByRole("img", { name: here })).toBeTruthy();
    // Nobody else here: no faces at all.
    else expect(within(header).queryByRole("img")).toBeNull();
    expect(within(header).queryByRole("status")).toBeNull();
    // Access reads only when opened, like a file's.
    expect(screen.getByTestId("about-access-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(bridgeMock.getObjectAccess).not.toHaveBeenCalled();
    // A conversation has no file sections.
    expect(screen.queryByTestId("about-chats")).toBeNull();
    expect(screen.queryByTestId("about-history")).toBeNull();
  });

  it("reads the conversation's access when opened, and its empty answer names the chat", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(answer());
    publish("workspace-a", GENERAL, conversation({}));
    render(<Rail />);
    await userEvent.setup().click(await screen.findByTestId("about-access-toggle"));
    expect((await screen.findByTestId("about-access-empty")).textContent).toBe(
      "No share from this workspace includes this chat.",
    );
    expect(bridgeMock.getObjectAccess).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      ref: { kind: "chat", channelWireId: "wire-general" },
    });
  });

  it("never shows another workspace's conversation under the same tab", async () => {
    const forA = publish("workspace-a", GENERAL, conversation({ name: "a-general" }));
    publish("workspace-b", GENERAL, conversation({ name: "b-general" }));
    const { rerender } = render(<Rail />);
    // The panel has loaded, so what follows cannot pass on its fallback.
    expect((await screen.findByTestId("about-header")).textContent).toBe("a-general");
    rerender(<Rail workspaceId="workspace-b" />);
    expect(screen.getByTestId("about-header").textContent).toBe("b-general");

    // Workspace A's page leaves: About waits for it and shows nothing of B.
    act(() => forA());
    rerender(<Rail workspaceId="workspace-a" />);
    expect(screen.getByText("Loading About...")).toBeTruthy();
    expect(screen.queryByTestId("about-header")).toBeNull();
    expect(screen.queryByText("b-general")).toBeNull();
  });

  it("keeps a search hit's chat on the tab it arrived on, and not on the next tab focused before it is read", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
    bridgeMock.listChatReactions.mockResolvedValue({ reactions: [], viewerAuthorId: "you" });
    bridgeMock.markChatThreadRead.mockResolvedValue({ lastReadSequence: 0, revision: 1 });
    bridgeMock.listFileChats.mockResolvedValue({ fileObjectId: "object-b", threads: [] });
    publish("workspace-a", GENERAL, conversation({}));
    publish("workspace-a", LAUNCH, conversation({ name: "launch", channelWireId: "wire-launch" }));
    const hit = searchHit("b.md", "thread-pricing", "Pricing questions");
    const onSearchHitRead = vi.fn();
    const { rerender } = render(
      <Rail focusedTabPath="b.md" activeDocumentPath="b.md" searchChatTarget={hit} onSearchHitRead={onSearchHitRead} />,
    );
    expect((await screen.findByTestId("linked-chat-title")).textContent).toBe("Pricing questions");
    expect(onSearchHitRead).toHaveBeenCalledTimes(1);
    const read = { ...hit, read: true };

    // A hit still set for another tab shows nowhere else.
    rerender(<Rail focusedTabPath={GENERAL} searchChatTarget={read} />);
    expect((await screen.findByTestId("about-header")).textContent).toBe("general");
    expect(screen.queryByTestId("linked-chat-thread")).toBeNull();
    rerender(<Rail focusedTabPath={LAUNCH} searchChatTarget={read} />);
    expect(screen.getByTestId("about-header").textContent).toBe("launch");

    // A new hit on a conversation tab shows its chat there.
    const next = searchHit(LAUNCH, "thread-launch", "Launch date");
    rerender(<Rail focusedTabPath={LAUNCH} searchChatTarget={next} />);
    expect((await screen.findByTestId("linked-chat-title")).textContent).toBe("Launch date");
    // Read, it stays while its tab has focus.
    rerender(<Rail focusedTabPath={LAUNCH} searchChatTarget={{ ...next, read: true }} />);
    expect(screen.getByTestId("linked-chat-title").textContent).toBe("Launch date");
    // The shell drops it when focus leaves; back on its tab, the tab shows
    // its own conversation.
    rerender(<Rail focusedTabPath={GENERAL} searchChatTarget={null} />);
    expect((await screen.findByTestId("about-header")).textContent).toBe("general");
    rerender(<Rail focusedTabPath={LAUNCH} searchChatTarget={null} />);
    expect((await screen.findByTestId("about-header")).textContent).toBe("launch");
    expect(screen.queryByTestId("linked-chat-thread")).toBeNull();
  });

  it("never opens a hit under any tab but its own, even on a rail that mounts after it", async () => {
    bridgeMock.listFileChats.mockResolvedValue({ fileObjectId: "object-b", threads: [] });
    bridgeMock.listEngineMoments.mockResolvedValue({
      moments: [], nextBeforeMomentOrder: null, latestMomentOrder: 0, activeVersionId: "main", protectedTruncated: false,
    });
    const onSearchHitRead = vi.fn();
    // A hit for a.md, not yet read, reaches a rail opened on b.md: About was
    // collapsed while focus moved.
    render(
      <Rail focusedTabPath="b.md" activeDocumentPath="b.md"
        searchChatTarget={searchHit("a.md", "thread-pricing", "Pricing questions")} onSearchHitRead={onSearchHitRead} />,
    );
    expect((await screen.findByTestId("about-header")).textContent).toBe("b.md");
    await act(async () => undefined);
    expect(screen.queryByTestId("linked-chat-thread")).toBeNull();
    expect(onSearchHitRead).not.toHaveBeenCalled();
  });

  it("drops a read hit's chat when focus moves between two tabs that are not files", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
    bridgeMock.listChatReactions.mockResolvedValue({ reactions: [], viewerAuthorId: "you" });
    bridgeMock.markChatThreadRead.mockResolvedValue({ lastReadSequence: 0, revision: 1 });
    publish("workspace-a", GENERAL, conversation({}));
    const hit = searchHit(GENERAL, "thread-pricing", "Pricing questions");
    const { rerender } = render(<Rail focusedTabPath={GENERAL} searchChatTarget={hit} />);
    expect((await screen.findByTestId("linked-chat-title")).textContent).toBe("Pricing questions");

    // Chats Home, then Graph: About's file panel stays mounted with no file
    // for both, and still shows nothing of the hit.
    rerender(<Rail focusedTabPath={CHATS_TAB_PATH} searchChatTarget={null} />);
    expect((await screen.findByTestId("linked-chats-empty")).textContent).toBe(
      "Open a file or a conversation to see who has access.",
    );
    expect(screen.queryByTestId("linked-chat-thread")).toBeNull();
    rerender(<Rail focusedTabPath={GRAPH_TAB_PATH} searchChatTarget={null} />);
    expect(screen.getByTestId("linked-chats-empty")).toBeTruthy();
  });

  it("never shows the last conversation's name or access after a fast tab switch", async () => {
    const forGeneral = deferred<AccessAnswer>();
    bridgeMock.getObjectAccess.mockImplementation(({ ref }) =>
      (ref as { channelWireId: string }).channelWireId === "wire-general"
        ? forGeneral.promise
        : Promise.resolve(answer([{
          kind: "share", shareId: "share-launch", grantId: "grant-kim", via: "named", granterUserId: "me",
          granterEmail: "me@example.com", recipientUserId: "kim", recipientEmail: "kim@example.com", subjectName: null,
          sharerName: null, selector: { kind: "chat", channelWireId: "wire-launch" }, access: "read-write",
          status: "active", generation: 1,
        }])));
    publish("workspace-a", GENERAL, conversation({}));
    publish("workspace-a", LAUNCH, conversation({ name: "launch", channelWireId: "wire-launch" }));
    const { rerender } = render(<Rail />);
    await userEvent.setup().click(await screen.findByTestId("about-access-toggle"));
    await waitFor(() => expect(bridgeMock.getObjectAccess).toHaveBeenCalledTimes(1));

    rerender(<Rail focusedTabPath={LAUNCH} />);
    expect(screen.getByTestId("about-header").textContent).toBe("launch");
    expect((await screen.findByTestId("about-access-row")).textContent).toContain("kim@example.com");

    await act(async () => forGeneral.resolve(answer([])));
    expect(screen.getByTestId("about-header").textContent).toBe("launch");
    expect(screen.queryByTestId("about-access-empty")).toBeNull();
    expect(screen.getAllByTestId("about-access-row")).toHaveLength(1);
  });

  it("keeps Access open across conversations, though the next one loads first", async () => {
    bridgeMock.getObjectAccess.mockResolvedValue(answer());
    publish("workspace-a", GENERAL, conversation({}));
    const { rerender } = render(<Rail />);
    await userEvent.setup().click(await screen.findByTestId("about-access-toggle"));
    await screen.findByTestId("about-access-empty");

    rerender(<Rail focusedTabPath={LAUNCH} />);
    expect(screen.getByText("Loading About...")).toBeTruthy();
    publish("workspace-a", LAUNCH, conversation({ name: "launch", channelWireId: "wire-launch" }));
    expect((await screen.findByTestId("about-header")).textContent).toBe("launch");
    expect(screen.getByTestId("about-access-toggle").getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(bridgeMock.getObjectAccess).toHaveBeenLastCalledWith({
      workspaceId: "workspace-a",
      ref: { kind: "chat", channelWireId: "wire-launch" },
    }));
  });

  it("follows the conversation's presence as its page republishes", async () => {
    const entry = conversation({});
    const withdraw = publish("workspace-a", GENERAL, entry);
    render(<Rail />);
    const header = await screen.findByTestId("about-header");
    expect(within(header).queryByRole("img")).toBeNull();
    publish("workspace-a", GENERAL, { ...entry, present: [peer("sam", "Sam Rivera")] });
    expect(within(header).getByRole("img", { name: "Sam Rivera is here" })).toBeTruthy();
    // An older withdrawal leaves the newer entry in place.
    act(() => withdraw());
    expect(screen.getByTestId("about-header").textContent).toContain("general");
  });

  it("falls back to the files empty state when the tab shows no conversation", async () => {
    publish("workspace-a", GENERAL, "none");
    render(<Rail />);
    expect((await screen.findByTestId("linked-chats-empty")).textContent).toBe(
      "Open a file or a conversation to see who has access.",
    );
  });

  it("keeps a shared view's About on files", async () => {
    publish("workspace-a", GENERAL, conversation({}));
    render(<Rail shareView={{} as NonNullable<ComponentProps<typeof ShellAboutRail>["shareView"]>} />);
    expect(await screen.findByTestId("linked-chats-empty")).toBeTruthy();
    expect(screen.queryByTestId("about-header")).toBeNull();
    expect(bridgeMock.chatLinks).not.toHaveBeenCalled();
  });
});

describe("Links for an open conversation", () => {
  const count = () => screen.queryByTestId("about-links-count")?.textContent;

  it.each([
    ["group", GENERAL, conversation({})],
    ["person", SAM_DM, conversation({ kind: "person", name: "Sam Rivera", channelWireId: "wire-dm" })],
    ["agent", AGENT, conversation({ kind: "agent", name: "Nova", channelWireId: "wire-agent" })],
  ] as const)("lists each file a %s mentions once, last mentioned first, with who mentioned it", async (_kind, tabPath, entry) => {
    bridgeMock.chatLinks.mockResolvedValue(linksPage([
      mention("data/funnel.csv", NOVA, 3), mention("notes/plan.md", SAM, 2), mention("data/funnel.csv", SAM, 1),
    ]));
    const openPath = vi.fn();
    publish("workspace-a", tabPath, entry);
    render(<Rail focusedTabPath={tabPath} openPathWithHeading={openPath} />);
    await waitFor(() => expect(linkRows()).toEqual([
      ["data/funnel.csv", "Mentioned by agent Nova, Sam Rivera"],
      ["notes/plan.md", "Mentioned by Sam Rivera"],
    ]));
    expect(bridgeMock.chatLinks).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace-a", channelWireId: entry.channelWireId });
    expect(count()).toBe("2");
    const [funnel, plan] = screen.getAllByTestId("about-conversation-link");
    // The file's folder beside its name, then an agent's square and a
    // person's circle.
    expect(funnel!.textContent).toContain("funnel.csvdata");
    const faces = [...funnel!.querySelectorAll<HTMLElement>("span[aria-hidden][title]")];
    expect(faces.map((face) => [face.title, face.className.includes("rounded-full")])).toEqual([["Nova", false], ["Sam Rivera", true]]);
    await userEvent.setup().click(plan!);
    expect(openPath).toHaveBeenCalledWith("notes/plan.md");
  });

  it("keeps a file split across pages on one row, adds who mentioned it there, and hands focus to the first row added", async () => {
    bridgeMock.chatLinks
      .mockResolvedValueOnce(linksPage([mention("data/funnel.csv", NOVA, 3)], { nextCursor: "next" }))
      .mockResolvedValueOnce(linksPage([mention("data/funnel.csv", SAM, 2), mention("notes/plan.md", SAM, 1)]));
    publish("workspace-a", GENERAL, conversation({}));
    render(<Rail />);
    await waitFor(() => expect(linkRows()).toEqual([["data/funnel.csv", "Mentioned by agent Nova"]]));
    expect(count()).toBe("1+");
    // Pressed from the keyboard, Show more leaves with the last page, so
    // focus goes on to the row that page added.
    screen.getByTestId("about-conversation-links-more").focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() => expect(linkRows()).toEqual([
      ["data/funnel.csv", "Mentioned by agent Nova, Sam Rivera"],
      ["notes/plan.md", "Mentioned by Sam Rivera"],
    ]));
    expect(bridgeMock.chatLinks).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", channelWireId: "wire-general", cursor: "next" });
    expect(count()).toBe("2");
    expect(screen.queryByTestId("about-conversation-links-more")).toBeNull();
    await waitFor(() => expect(document.activeElement?.getAttribute("data-path")).toBe("notes/plan.md"));
  });

  it("offers only Show more for a page with no files it may show, and says the list is empty once the pages end", async () => {
    bridgeMock.chatLinks
      .mockResolvedValueOnce(linksPage([], { nextCursor: "next" }))
      .mockResolvedValueOnce(linksPage([]));
    publish("workspace-a", GENERAL, conversation({}));
    render(<Rail />);
    const more = await screen.findByTestId("about-conversation-links-more");
    expect(count()).toBe("0+");
    expect(screen.queryByTestId("about-conversation-links-empty")).toBeNull();
    await userEvent.setup().click(more);
    expect((await screen.findByTestId("about-conversation-links-empty")).textContent).toBe(
      "No files mentioned here yet. Type / in a message to add one.",
    );
    expect(count()).toBe("0");
    expect(screen.queryByTestId("about-conversation-links-more")).toBeNull();
  });

  it("names an agent or an automation as one to a screen reader, as the avatar shows it", async () => {
    const automation = { kind: "automation", displayName: "Stamp the date", presentation: { group: "stamp", hue: null, self: false } } as const;
    bridgeMock.chatLinks.mockResolvedValue(linksPage([
      mention("data/funnel.csv", NOVA, 3), mention("notes/plan.md", automation, 2), mention("notes/brief.md", SAM, 1),
    ]));
    publish("workspace-a", GENERAL, conversation({}));
    render(<Rail />);
    const rows = await screen.findAllByRole("button", { name: /Mentioned by/ });
    expect(rows.map((row) => row.textContent?.slice(row.textContent.indexOf("Mentioned by")))).toEqual([
      "Mentioned by agent Nova", "Mentioned by automation Stamp the date", "Mentioned by Sam Rivera",
    ]);
    // The words are for screen readers; the avatar's shape shows the kind.
    const words = screen.getAllByText(/^(agent|automation)$/);
    expect(words.map((word) => [word.textContent, word.className])).toEqual([["agent ", "sr-only"], ["automation ", "sr-only"]]);
  });

  it("says how to mention a file when the conversation mentions none, and never names a file it did not list", async () => {
    bridgeMock.chatLinks.mockResolvedValue(linksPage([], { unchecked: ["private/salaries.md"] }));
    publish("workspace-a", GENERAL, conversation({}));
    render(<Rail />);
    expect((await screen.findByTestId("about-conversation-links-empty")).textContent).toBe(
      "No files mentioned here yet. Type / in a message to add one.",
    );
    expect(count()).toBe("0");
    expect(screen.queryByText(/salaries/)).toBeNull();
  });

  it("says it is gathering while the index builds, and reads again until it finishes", async () => {
    bridgeMock.chatLinks
      .mockResolvedValueOnce(linksPage([mention("data/funnel.csv", NOVA, 2)], { indexBuilding: true, complete: false }))
      .mockResolvedValueOnce(linksPage([mention("data/funnel.csv", NOVA, 2), mention("notes/plan.md", SAM, 1)]));
    publish("workspace-a", GENERAL, conversation({}));
    render(<Rail />);
    expect((await screen.findByTestId("about-conversation-links-gathering")).textContent).toBe("Gathering links");
    expect(count()).toBe("1+");
    expect(screen.queryByTestId("about-conversation-links-partial")).toBeNull();
    // The first read again waits a quarter second; this allows twenty times that.
    await waitFor(() => expect(linkRows()).toHaveLength(2), { timeout: 5_000 });
    expect(screen.queryByTestId("about-conversation-links-gathering")).toBeNull();
    expect(count()).toBe("2");
    expect(bridgeMock.chatLinks).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the index does not cover every message", { complete: false }],
    ["mounted shares are not covered", { mountsCovered: false }],
  ] as const)("says the list may be missing files when %s, and claims no empty list", async (_why, facts) => {
    bridgeMock.chatLinks.mockResolvedValue(linksPage([], facts));
    publish("workspace-a", GENERAL, conversation({}));
    render(<Rail />);
    expect((await screen.findByTestId("about-conversation-links-partial")).textContent).toBe(
      "This list may not include every file mentioned here.",
    );
    expect(screen.queryByTestId("about-conversation-links-empty")).toBeNull();
  });

  it("files a failed read in Notices with Try again, and a read that lands clears it", async () => {
    const error = new Error("disk is busy");
    bridgeMock.chatLinks.mockRejectedValueOnce(error).mockResolvedValueOnce(linksPage([mention("data/funnel.csv", NOVA, 1)]));
    publish("workspace-a", GENERAL, conversation({}));
    render(<Rail />);
    const failed = await screen.findByTestId("about-conversation-links-failed");
    expect(failed.textContent).toBe("Try again");
    expect(notices.report).toHaveBeenCalledExactlyOnceWith({
      identity: "about-conversation-links:wire-general",
      message: expect.stringContaining("disk is busy"),
      cause: error,
      retry: expect.any(Function),
    });
    expect(count()).toBeUndefined();
    notices.clear.mockClear();
    await userEvent.setup().click(within(failed).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(linkRows()).toHaveLength(1));
    expect(notices.clear).toHaveBeenCalledWith("about-conversation-links:wire-general");
  });

  it("reads again when the window comes back, and keeps its rows when that read fails", async () => {
    bridgeMock.chatLinks.mockResolvedValueOnce(linksPage([mention("data/funnel.csv", NOVA, 1)])).mockRejectedValueOnce(new Error("offline"));
    publish("workspace-a", GENERAL, conversation({}));
    render(<Rail />);
    await waitFor(() => expect(linkRows()).toHaveLength(1));
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(notices.report).toHaveBeenCalledTimes(1));
    expect(bridgeMock.chatLinks).toHaveBeenCalledTimes(2);
    expect(linkRows()).toEqual([["data/funnel.csv", "Mentioned by agent Nova"]]);
    expect(screen.queryByTestId("about-conversation-links-failed")).toBeNull();
    // Notices' Try again reads the conversation again.
    bridgeMock.chatLinks.mockResolvedValueOnce(linksPage([]));
    act(() => (notices.report.mock.calls[0]![0] as { retry: () => void }).retry());
    await screen.findByTestId("about-conversation-links-empty");
  });

  it("says dohc does not list a conversation main has no Links for, and files no row", async () => {
    bridgeMock.chatLinks.mockResolvedValue(null);
    publish("workspace-a", GENERAL, conversation({}));
    render(<Rail />);
    expect((await screen.findByTestId("about-conversation-links-unlisted")).textContent).toBe(
      "dohc does not list links in this conversation yet.",
    );
    expect(notices.report).not.toHaveBeenCalled();
    expect(count()).toBeUndefined();
  });

  it("never shows another workspace's Links under the same tab", async () => {
    const forA = deferred<ChatLinksPage>();
    bridgeMock.chatLinks.mockImplementation(({ workspaceId }) =>
      workspaceId === "workspace-a" ? forA.promise : Promise.resolve(linksPage([mention("b/only.md", SAM, 1)])));
    publish("workspace-a", GENERAL, conversation({}));
    publish("workspace-b", GENERAL, conversation({}));
    const { rerender } = render(<Rail />);
    await waitFor(() => expect(bridgeMock.chatLinks).toHaveBeenCalledTimes(1));
    rerender(<Rail workspaceId="workspace-b" />);
    await waitFor(() => expect(linkRows()).toEqual([["b/only.md", "Mentioned by Sam Rivera"]]));
    await act(async () => forA.resolve(linksPage([mention("a/secret.md", NOVA, 1)])));
    expect(linkRows()).toEqual([["b/only.md", "Mentioned by Sam Rivera"]]);
  });

  it.each(["answers", "fails"] as const)(
    "never shows the last conversation's Links after a fast tab switch, when its read %s late",
    async (outcome) => {
      const forGeneral = deferred<ChatLinksPage>();
      bridgeMock.chatLinks.mockImplementation(({ channelWireId }) =>
        channelWireId === "wire-general" ? forGeneral.promise : Promise.resolve(linksPage([mention("launch/plan.md", SAM, 1)])));
      publish("workspace-a", GENERAL, conversation({}));
      publish("workspace-a", LAUNCH, conversation({ name: "launch", channelWireId: "wire-launch" }));
      const { rerender } = render(<Rail />);
      await waitFor(() => expect(bridgeMock.chatLinks).toHaveBeenCalledTimes(1));
      rerender(<Rail focusedTabPath={LAUNCH} />);
      await waitFor(() => expect(linkRows()).toEqual([["launch/plan.md", "Mentioned by Sam Rivera"]]));
      await act(async () => {
        if (outcome === "answers") forGeneral.resolve(linksPage([mention("general/old.md", NOVA, 1)]));
        else forGeneral.reject(new Error("late"));
      });
      expect(screen.getByTestId("about-header").textContent).toBe("launch");
      expect(linkRows()).toEqual([["launch/plan.md", "Mentioned by Sam Rivera"]]);
      expect(notices.report).not.toHaveBeenCalled();
    },
  );

  it("reads nothing before the page says what it shows, or while Links is closed, which it stays", async () => {
    const { rerender } = render(<Rail />);
    expect(screen.getByText("Loading About...")).toBeTruthy();
    expect(bridgeMock.chatLinks).not.toHaveBeenCalled();
    publish("workspace-a", GENERAL, conversation({}));
    publish("workspace-a", LAUNCH, conversation({ name: "launch", channelWireId: "wire-launch" }));
    await waitFor(() => expect(bridgeMock.chatLinks).toHaveBeenCalledTimes(1));
    await userEvent.setup().click(await screen.findByTestId("about-links-toggle"));
    rerender(<Rail focusedTabPath={LAUNCH} />);
    expect((await screen.findByTestId("about-header")).textContent).toBe("launch");
    expect(screen.getByTestId("about-links-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(bridgeMock.chatLinks).toHaveBeenCalledTimes(1);
  });
});
