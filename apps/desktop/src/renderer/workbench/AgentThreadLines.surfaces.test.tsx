// @vitest-environment jsdom
import "../../testing/legendListMock";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import type { AgentThreadLine } from "../../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../../settings/userSettings";
import { AgentThreadLinesProvider } from "./AgentThreadLines";
import { ChatLane } from "./ChatLane";
import {
  bridgeMock,
  channel,
  ChatsView,
  emitAgentThreadLines,
  message,
  NOW,
  thread,
} from "./ChatsView.testHarness";
import { ReactionStoreProvider } from "./reactionStore";

// Nova's thread is in T3 Code, and dohc forwards this workspace's messages to it.
const settings: DesktopUserSettings = {
  ...DEFAULT_USER_SETTINGS,
  agents: {
    nova: {
      name: "Nova",
      hue: "olive",
      thread: { tool: "t3-code", id: "t3-nova" },
      workspaces: ["workspace-a"],
      changesFiles: true,
      enabled: true,
      timeoutMinutes: 30,
    },
  },
};

const inShell = (chat: ReactNode) => (
  <AgentThreadLinesProvider
    workspaceId="workspace-a"
    ready
    settings={settings}
    report={vi.fn()}
    clear={vi.fn()}
  >
    {chat}
  </AgentThreadLinesProvider>
);

const line = (chatThreadId: string, state: AgentThreadLine["state"]): AgentThreadLine => ({
  agentId: "nova",
  chatThreadId,
  state,
  sinceMs: NOW,
});
const push = (lines: AgentThreadLine[]) => act(() => emitAgentThreadLines(lines));

const before = (first: Element, second: Element) =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

function lane(kind: "channel" | "agent") {
  return inShell(
    <ReactionStoreProvider workspaceId="workspace-a">
      <ChatLane
        workspaceId="workspace-a"
        channel={channel({ type: "chat", kind, ...(kind === "agent" ? { agentId: "nova" } : {}) })}
        locked={false}
        mentionCandidates={[]}
        onError={vi.fn()}
        revision={0}
        {...(kind === "agent" ? { agentName: "Nova" } : {})}
      />
    </ReactionStoreProvider>,
  );
}

it("shows the line over the composer of an agent's own chat, for its conversation and its earlier posts", async () => {
  bridgeMock.listChannelThreads.mockImplementation(async ({ lane: asked }: { lane: string }) => ({
    threads: asked === "posts" ? [thread({ id: "post-1" })] : [thread()],
  }));
  bridgeMock.listChatMessages.mockImplementation(async ({ threadId }: { threadId: string }) => ({
    messages: [message({ id: `first-${threadId}`, threadId, body: `In ${threadId}` })],
  }));
  render(lane("agent"));
  await screen.findByText("In post-1");
  expect(bridgeMock.readAgentThreadLines).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "workspace-a",
  });

  push([line("thread-elsewhere", "working")]);
  expect(screen.queryByTestId("agent-thread-line")).toBeNull();

  push([line("post-1", "working")]);
  const shown = screen.getByTestId("agent-thread-line");
  expect(before(screen.getByText("In thread-1"), shown)).toBe(true);
  expect(before(shown, screen.getByTestId("chats-lane-composer"))).toBe(true);
  // dohc started no run, so the row of an agent it starts stays away.
  expect(screen.queryByTestId("chats-lane-working")).toBeNull();

  push([line("thread-1", "waiting-in-tool")]);
  expect(screen.getByTestId("agent-thread-line").dataset.state).toBe("waiting-in-tool");
});

it("shows the line over the composer of a Group's conversation", async () => {
  bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
  bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ body: "Old message" })] });
  render(lane("channel"));
  await screen.findByText("Old message");
  push([line("thread-1", "in-line")]);
  const shown = screen.getByTestId("agent-thread-line");
  expect(shown.dataset.state).toBe("in-line");
  expect(before(shown, screen.getByTestId("chats-lane-composer"))).toBe(true);
});

it("shows the line over the composer of a Group's post", async () => {
  const user = userEvent.setup();
  bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
  bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
  render(
    inShell(<ChatsView workspaceId="workspace-a" onOpenFileChat={vi.fn()} onError={vi.fn()} />),
  );
  await user.click(await screen.findByTestId("chats-channel"));
  await user.click(await screen.findByTestId("chats-thread"));
  await screen.findByTestId("chats-thread-view");

  push([line("thread-2", "working")]);
  expect(screen.queryByTestId("agent-thread-line")).toBeNull();

  push([line("thread-1", "silent")]);
  const shown = screen.getByTestId("agent-thread-line");
  expect(screen.getByTestId("chats-thread-view").contains(shown)).toBe(true);
  expect(before(screen.getByTestId("chats-thread-column"), shown)).toBe(true);
  expect(before(shown, screen.getByTestId("chats-composer"))).toBe(true);
  // The strip of an agent dohc starts has nothing to say.
  expect(screen.queryByTestId("chats-dispatch-status")).toBeNull();
  await waitFor(() =>
    expect(screen.getByTestId("chats-dispatch-announcement").textContent).toBe(""),
  );
});
