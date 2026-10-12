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
import { chatTabPath, defaultWorkbenchState } from "../workbench/workbenchState";
import { ShellAboutRail } from "./ShellAboutRail";

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
        setSearchChatTarget={() => undefined}
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
    const hit = { thread: { id: "thread-pricing", title: "Pricing questions", createdAtMs: 1, updatedAtMs: 1 } };
    // The shell clears the hit only once About's file panel reads it. Here
    // it never does, so the hit stays set across every focus change.
    const { rerender } = render(<Rail focusedTabPath="b.md" activeDocumentPath="b.md" searchChatTarget={hit} />);
    expect((await screen.findByTestId("linked-chat-title")).textContent).toBe("Pricing questions");

    rerender(<Rail focusedTabPath={GENERAL} searchChatTarget={hit} />);
    expect((await screen.findByTestId("about-header")).textContent).toBe("general");
    expect(screen.queryByTestId("linked-chat-thread")).toBeNull();
    rerender(<Rail focusedTabPath={LAUNCH} searchChatTarget={hit} />);
    expect(screen.getByTestId("about-header").textContent).toBe("launch");

    // A new hit on a conversation tab shows its chat there.
    const next = { thread: { ...hit.thread, id: "thread-launch", title: "Launch date" } };
    rerender(<Rail focusedTabPath={LAUNCH} searchChatTarget={next} />);
    expect((await screen.findByTestId("linked-chat-title")).textContent).toBe("Launch date");
    rerender(<Rail focusedTabPath={GENERAL} searchChatTarget={next} />);
    expect((await screen.findByTestId("about-header")).textContent).toBe("general");
    // Back on the tab the hit arrived on, after it was read: the hit is over,
    // and the tab shows its own conversation.
    rerender(<Rail focusedTabPath={LAUNCH} searchChatTarget={next} />);
    expect((await screen.findByTestId("about-header")).textContent).toBe("launch");
    expect(screen.queryByTestId("linked-chat-thread")).toBeNull();
  });

  it("never opens a hit not yet read under the next file focused", async () => {
    bridgeMock.listFileChats.mockResolvedValue({ fileObjectId: "object-b", threads: [] });
    bridgeMock.listEngineMoments.mockResolvedValue({
      moments: [], nextBeforeMomentOrder: null, latestMomentOrder: 0, activeVersionId: "main", protectedTruncated: false,
    });
    const setSearchChatTarget = vi.fn();
    const hit = { thread: { id: "thread-pricing", title: "Pricing questions", createdAtMs: 1, updatedAtMs: 1 } };
    // The hit arrives on a.md while main has not decided capture, so About's
    // file panel is not there to read it.
    const { rerender } = render(
      <Rail focusedTabPath="a.md" activeDocumentPath="a.md" searchChatTarget={hit}
        setSearchChatTarget={setSearchChatTarget} captureAvailable={false} captureDecided={false} />,
    );
    expect(screen.getByText("Loading About...")).toBeTruthy();

    rerender(
      <Rail focusedTabPath="b.md" activeDocumentPath="b.md" searchChatTarget={hit}
        setSearchChatTarget={setSearchChatTarget} />,
    );
    expect((await screen.findByTestId("about-header")).textContent).toBe("b.md");
    await act(async () => undefined);
    expect(screen.queryByTestId("linked-chat-thread")).toBeNull();
    // The shell drops the hit, so reopening About cannot bring it back.
    expect(setSearchChatTarget).toHaveBeenCalledWith(null);
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
