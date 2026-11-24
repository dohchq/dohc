import "../../testing/legendListMock";
// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { extractChatFileReferenceTokens } from "@dohc/workspace-contracts/chat-mentions";
import {
  ChatsView,
  thread,
  message,
  bridgeMock,
  workspaceActivityCallbacks,
  emitWorkspaceActivity,
  renderView,
} from "./ChatsView.testHarness";

// Real implementations, spied: every message-body render runs the file-token
// scan, so its call count is the render-cost probe for the memo boundaries.
vi.mock("@dohc/workspace-contracts/chat-mentions", { spy: true });

describe("chat render cost", () => {
  it("thread composer keystrokes do not re-render the transcript", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ messageCount: 2 })],
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        message(),
        message({
          id: "message-2",
          parentMessageId: "message-1",
          body: "Reply citing @[docs/plan.md#scope]",
        }),
      ],
    });
    renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-post-card"));
    await screen.findByTestId("chats-thread-view");
    await screen.findAllByTestId("chats-message");

    const scans = vi.mocked(extractChatFileReferenceTokens).mock.calls.length;
    await user.type(screen.getByTestId("chats-composer"), "abc");
    expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).value).toBe("abc");
    expect(vi.mocked(extractChatFileReferenceTokens).mock.calls.length).toBe(scans);
  });
});

// The shell suspends the panel navigator's polling while a Chats tab is
// live, because the page instance runs the same polls against the same store.
// The Group list is the exception: no page reloads it.
describe("suspended polling", () => {
  it("keeps only the Group list current while suspended, then resumes and catches up on unsuspend", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const view = render(
        <ChatsView
          workspaceId="workspace-a"
          onOpenFileChat={vi.fn()}
          onError={vi.fn()}
          suspendPolling
        />,
      );
      await screen.findByTestId("chats-channel-name");

      // Suspended: an event reloads the Group list once, since an agent can
      // add a Group while a page is open, and nothing else.
      expect(workspaceActivityCallbacks.size).toBe(1);
      const before = bridgeMock.listChatChannels.mock.calls.length;
      act(() => emitWorkspaceActivity());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });
      expect(bridgeMock.listChatChannels.mock.calls.length).toBe(before + 1);
      act(() => emitWorkspaceActivity("workspace-b"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(bridgeMock.listChatChannels.mock.calls.length).toBe(before + 1);
      const listings = before + 1;

      // Unsuspended: one catch-up pass runs immediately — the activity that
      // fired meanwhile reached only the page instance — and the polls and
      // the subscription re-arm.
      view.rerender(
        <ChatsView
          workspaceId="workspace-a"
          onOpenFileChat={vi.fn()}
          onError={vi.fn()}
          suspendPolling={false}
        />,
      );
      await waitFor(() => {
        expect(bridgeMock.listChatChannels.mock.calls.length).toBeGreaterThanOrEqual(listings + 1);
      });
      expect(workspaceActivityCallbacks.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
