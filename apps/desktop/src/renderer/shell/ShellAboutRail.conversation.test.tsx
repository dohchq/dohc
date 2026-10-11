// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessAnswer } from "@dohc/workspace-contracts/access";
import { deferred } from "../../testing/deferred";
import type { PresencePeer } from "../collab/presenceChannel";
import { publishAboutConversation, type AboutConversation } from "../workbench/aboutConversation";
import { ReactionStoreProvider } from "../workbench/reactionStore";
import { chatTabPath, defaultWorkbenchState } from "../workbench/workbenchState";
import { ShellAboutRail } from "./ShellAboutRail";

const bridgeMock = {
  getObjectAccess: vi.fn<(input: { workspaceId: string; ref: unknown }) => Promise<AccessAnswer>>(),
  requestAccessRefresh: vi.fn(async () => undefined),
  listFileChats: vi.fn(),
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
        fileTabOpen={false}
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
    publish("workspace-a", tabPath, entry);
    render(<Rail focusedTabPath={tabPath} />);
    const panel = await screen.findByTestId("about-panel");
    expect(panel.dataset.conversationKind).toBe(kind);
    const header = screen.getByTestId("about-header");
    expect(within(header).getByText(entry.name)).toBeTruthy();
    if (here) expect(within(header).getByRole("status").getAttribute("aria-label")).toBe(here);
    // Nobody else here: no faces at all.
    else expect(within(header).queryByRole("status")).toBeNull();
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
    publish("workspace-b", GENERAL, conversation({ name: "b-general" }));
    render(<Rail />);
    await act(async () => undefined);
    expect(screen.queryByTestId("about-header")).toBeNull();
    expect(screen.getByText("Loading About...")).toBeTruthy();
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

  it("follows the conversation's presence as its page republishes", async () => {
    const entry = conversation({});
    const withdraw = publish("workspace-a", GENERAL, entry);
    render(<Rail />);
    const header = await screen.findByTestId("about-header");
    expect(within(header).queryByRole("status")).toBeNull();
    publish("workspace-a", GENERAL, { ...entry, present: [peer("sam", "Sam Rivera")] });
    expect(within(header).getByRole("status").getAttribute("aria-label")).toBe("Sam Rivera is here");
    // An older withdrawal leaves the newer entry in place.
    act(() => withdraw());
    expect(screen.getByTestId("about-header").textContent).toContain("general");
  });

  it("falls back to the files empty state when the tab shows no conversation", async () => {
    publish("workspace-a", GENERAL, "none");
    render(<Rail />);
    expect((await screen.findByTestId("linked-chats-empty")).textContent).toBe(
      "Open a file to see its chats, history, and access.",
    );
  });

  it("keeps a shared view's About on files", async () => {
    publish("workspace-a", GENERAL, conversation({}));
    render(<Rail shareView={{} as NonNullable<ComponentProps<typeof ShellAboutRail>["shareView"]>} />);
    expect(await screen.findByTestId("linked-chats-empty")).toBeTruthy();
    expect(screen.queryByTestId("about-header")).toBeNull();
  });
});
