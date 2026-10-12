// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessAnswer } from "@dohc/workspace-contracts/access";
import { deferred } from "../../testing/deferred";
import type { PresencePeer } from "../collab/presenceChannel";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { publishAboutConversation, type AboutConversation } from "../workbench/aboutConversation";
import { setChosenColors } from "../workbench/chosenColors";
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
    coverage: { kind: "granted", complete: true, observation: "interval" },
    checkedAtMs: Date.UTC(2026, 9, 9), freshness: "fresh", nextCursor: null,
  };
}

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
        openPathWithHeading={() => undefined}
        onChatsThreadRead={() => undefined}
        reportFailureMessage={() => undefined}
        historyRevision={0}
        openMoment={() => undefined}
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
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  act(() => {
    for (const withdraw of withdrawals.splice(0)) withdraw();
    setChosenColors(DEFAULT_USER_SETTINGS.appearance);
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
    setChosenColors({ ...DEFAULT_USER_SETTINGS.appearance, yourAgentColor: "teal" });
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
      expect(avatar?.textContent).toBe("SR");
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
  });
});
