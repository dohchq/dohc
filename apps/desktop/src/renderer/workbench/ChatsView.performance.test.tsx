// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DmRecord } from "../../ipc/bridgeContract";
import { keepIfUnchanged } from "./ChatsView";
import { extractChatFileReferenceTokens } from "./chatFileMentions";
import {
  ChatsView,
  NOW,
  thread,
  message,
  dm,
  bridgeMock,
  workspaceActivityCallbacks,
  emitWorkspaceActivity,
  renderView,
} from "./ChatsView.testHarness";

// Real implementations, spied: every message-body render runs the file-token
// scan, so its call count is the render-cost probe for the memo boundaries.
vi.mock("./chatFileMentions", { spy: true });

// The perf contract for chat surfaces: composer drafts live in ChatsView, so
// a keystroke re-renders the view — but it must not reconcile the message
// list, whose bodies each re-run the file-token and mention scans. The spied
// extractChatFileReferenceTokens call count is the probe: it grows only when
// a message body actually renders.
describe("chat render cost", () => {
  it("DM composer keystrokes do not re-render the conversation's messages", async () => {
    const user = userEvent.setup();
    bridgeMock.syncDms.mockResolvedValue({
      available: true,
      dms: [dm()],
      pending: [],
      declined: [],
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        message({ id: "m-1", threadId: "thread-dm-1", body: "see @[docs/plan.md] before Friday" }),
        message({ id: "m-2", threadId: "thread-dm-1", body: "will do" }),
      ],
    });
    renderView();
    await user.click(await screen.findByTestId("chats-dm-item"));
    await screen.findAllByTestId("chats-dm-message");

    const scans = vi.mocked(extractChatFileReferenceTokens).mock.calls.length;
    await user.type(screen.getByTestId("chats-dm-composer"), "abc");
    expect((screen.getByTestId("chats-dm-composer") as HTMLTextAreaElement).value).toBe("abc");
    expect(vi.mocked(extractChatFileReferenceTokens).mock.calls.length).toBe(scans);
  });

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

  it("a quiet DM tick syncs and reads one revision without loading content", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      bridgeMock.syncDms.mockImplementation(async () => ({
        available: true,
        dms: [dm()],
        pending: [],
        declined: [],
      }));
      bridgeMock.listChatMessages.mockImplementation(async () => ({
        messages: [
          message({ id: "m-1", threadId: "thread-dm-1", body: "see @[docs/plan.md]" }),
        ],
      }));
      bridgeMock.listChatReactions.mockImplementation(async () => ({
        reactions: [],
        viewerAuthorId: "you@example.com",
      }));
      renderView();
      await user.click(await screen.findByTestId("chats-dm-item"));
      await screen.findAllByTestId("chats-dm-message");

      const scans = vi.mocked(extractChatFileReferenceTokens).mock.calls.length;
      bridgeMock.syncDms.mockClear();
      bridgeMock.getChatThreadRevision.mockClear();
      bridgeMock.listChatMessages.mockClear();
      bridgeMock.listChatReactions.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });

      expect(bridgeMock.syncDms).toHaveBeenCalledTimes(1);
      expect(bridgeMock.getChatThreadRevision).toHaveBeenCalledTimes(1);
      expect(bridgeMock.getChatThreadRevision).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-dm-1",
      });
      expect(bridgeMock.listChatMessages).not.toHaveBeenCalled();
      expect(bridgeMock.listChatReactions).not.toHaveBeenCalled();
      expect(vi.mocked(extractChatFileReferenceTokens).mock.calls.length).toBe(scans);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a changed DM revision triggers the full conversation load", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let revision = 1;
      bridgeMock.syncDms.mockResolvedValue({
        available: true,
        dms: [dm()],
        pending: [],
        declined: [],
      });
      bridgeMock.getChatThreadRevision.mockImplementation(async () => ({ revision }));
      bridgeMock.listChatMessages.mockImplementation(async () => ({
        messages: [
          message({
            id: "m-1",
            threadId: "thread-dm-1",
            body: revision === 1 ? "before" : "after",
          }),
        ],
      }));
      bridgeMock.listChatReactions.mockResolvedValue({
        reactions: [],
        viewerAuthorId: "you@example.com",
      });

      renderView();
      await user.click(await screen.findByTestId("chats-dm-item"));
      expect(await screen.findByText("before")).toBeTruthy();

      bridgeMock.syncDms.mockClear();
      bridgeMock.getChatThreadRevision.mockClear();
      bridgeMock.listChatMessages.mockClear();
      bridgeMock.listChatReactions.mockClear();
      revision = 2;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });

      expect(bridgeMock.syncDms).toHaveBeenCalledTimes(1);
      expect(bridgeMock.getChatThreadRevision).toHaveBeenCalledTimes(1);
      expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(1);
      expect(bridgeMock.listChatReactions).toHaveBeenCalledTimes(1);
      expect(await screen.findByText("after")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the revision gate when switching DMs", async () => {
    const user = userEvent.setup();
    const first = dm();
    const second = dm({
      channelId: "channel-dm-2",
      channelWireId: "wire-dm-2",
      peerLabel: "carol@example.com",
      threadId: "thread-dm-2",
    });
    bridgeMock.syncDms.mockResolvedValue({
      available: true,
      dms: [first, second],
      pending: [],
      declined: [],
    });
    bridgeMock.getChatThreadRevision.mockResolvedValue({ revision: 7 });
    bridgeMock.listChatMessages.mockImplementation(async ({ threadId }) => ({
      messages: [message({ id: `message-${threadId}`, threadId, body: threadId })],
    }));

    renderView();
    let items = await screen.findAllByTestId("chats-dm-item");
    await user.click(
      items.find((item) => item.getAttribute("data-channel-id") === first.channelId)!,
    );
    expect(await screen.findByText("thread-dm-1")).toBeTruthy();

    await user.click(screen.getByTestId("chats-dm-back"));
    items = await screen.findAllByTestId("chats-dm-item");
    bridgeMock.getChatThreadRevision.mockClear();
    bridgeMock.listChatMessages.mockClear();
    bridgeMock.listChatReactions.mockClear();
    await user.click(
      items.find((item) => item.getAttribute("data-channel-id") === second.channelId)!,
    );

    expect(await screen.findByText("thread-dm-2")).toBeTruthy();
    expect(bridgeMock.getChatThreadRevision).toHaveBeenCalledTimes(1);
    expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(1);
    expect(bridgeMock.listChatReactions).toHaveBeenCalledTimes(1);
  });
});

describe("keepIfUnchanged", () => {
  it("keeps current state for a deep-equal fresh IPC clone, including nested attachments", () => {
    const current = [
      message({
        attachments: [
          {
            attachmentId: "a-1",
            threadId: "thread-1",
            messageId: "message-1",
            targetKind: "file" as const,
            pathHint: "docs/plan.md",
            headingAnchor: "scope",
            createdAtMs: NOW,
          },
        ],
      }),
    ];
    expect(keepIfUnchanged(structuredClone(current))(current)).toBe(current);
  });

  it("replaces state when any field, nesting, or length changes", () => {
    const current = [dm()];
    const bumped = [dm({ unreadCount: 3 })];
    expect(keepIfUnchanged(bumped)(current)).toBe(bumped);
    const revoked = [dm({ connected: false })];
    expect(keepIfUnchanged(revoked)(current)).toBe(revoked);
    const emptied: DmRecord[] = [];
    expect(keepIfUnchanged(emptied)(current)).toBe(emptied);
    const attached = [message()];
    const withAttachment = [
      message({
        attachments: [
          {
            attachmentId: "a-1",
            threadId: "thread-1",
            messageId: "message-1",
            targetKind: "file" as const,
            createdAtMs: NOW,
          },
        ],
      }),
    ];
    expect(keepIfUnchanged(withAttachment)(attached)).toBe(withAttachment);
  });
});

// D2#6: the shell suspends the panel navigator's polling while a Chats tab is
// live, because the page instance runs the same polls against the same store.
describe("suspended polling", () => {
  it("stops the polls while suspended, then resumes and catches up on unsuspend", async () => {
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

      // Suspended: no activity subscription, so an event refreshes nothing,
      // and no DM list interval exists for the clock to fire.
      expect(workspaceActivityCallbacks.size).toBe(0);
      const dmSyncs = bridgeMock.syncDms.mock.calls.length;
      const listings = bridgeMock.listChatChannels.mock.calls.length;
      act(() => emitWorkspaceActivity());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });
      expect(bridgeMock.syncDms.mock.calls.length).toBe(dmSyncs);
      expect(bridgeMock.listChatChannels.mock.calls.length).toBe(listings);

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
        expect(bridgeMock.syncDms.mock.calls.length).toBe(dmSyncs + 1);
        expect(
          bridgeMock.listChatChannels.mock.calls.length,
        ).toBeGreaterThanOrEqual(listings + 1);
      });
      expect(workspaceActivityCallbacks.size).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      expect(bridgeMock.syncDms.mock.calls.length).toBeGreaterThanOrEqual(
        dmSyncs + 2,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
