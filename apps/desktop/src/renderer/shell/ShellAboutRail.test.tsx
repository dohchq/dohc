// @vitest-environment jsdom
import "../../testing/legendListMock";
// Collection dependencies read these observers during module evaluation.
// Preload them before tests so an unfinished import cannot clean up a later test's globals.
vi.hoisted(() => {
  class ObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): never[] { return []; }
  }
  Object.assign(globalThis, { ResizeObserver: ObserverStub, IntersectionObserver: ObserverStub });
});
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../../ipc/bridgeContract";
import { WORKSPACE, STORED_STATE, makeBridge, renderShell } from "../DesktopWorkspaceShell.testHarness";

describe("About rail (right side)", () => {
  it("exposes the About resize separator to keyboard users", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    const rail = await screen.findByTestId("about-rail");
    const handle = screen.getByTestId("about-rail-resize");
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-label")).toBe("Resize About");
    expect(handle.getAttribute("aria-valuemin")).toBe("240");
    expect(handle.getAttribute("aria-valuemax")).toBe("2400");
    expect(handle.getAttribute("aria-valuenow")).toBe("360");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    await waitFor(() => expect(rail.style.width).toBe("376px"));
    expect(handle.getAttribute("aria-valuenow")).toBe("376");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    await waitFor(() => expect(rail.style.width).toBe("360px"));

    fireEvent.keyDown(handle, { key: "PageUp" });
    await waitFor(() => expect(rail.style.width).toBe("488px"));
    fireEvent.keyDown(handle, { key: "PageDown" });
    await waitFor(() => expect(rail.style.width).toBe("360px"));
    fireEvent.keyDown(handle, { key: "Home" });
    await waitFor(() => expect(rail.style.width).toBe("240px"));
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    fireEvent.keyDown(handle, { key: "End" });
    await waitFor(() => expect(rail.style.width).toBe("2400px"));
    expect(handle.getAttribute("aria-valuenow")).toBe("2400");
  });

  it("opens a chat that links to the file at its message, in the thread About had open", async () => {
    const bridge = Object.assign(makeBridge(Promise.resolve(STORED_STATE)), {
      listChatMessages: vi.fn<DohcDesktopBridge["listChatMessages"]>(),
      listChatReactions: vi.fn<DohcDesktopBridge["listChatReactions"]>(async () => ({ reactions: [], viewerAuthorId: "Reader" })),
      markChatThreadRead: vi.fn<DohcDesktopBridge["markChatThreadRead"]>(async () => ({ lastReadSequence: 300, revision: 1 })),
      chatFileMentionsPage: vi.fn<DohcDesktopBridge["chatFileMentionsPage"]>(),
    });
    const thread = { id: "file-thread", title: "Long file conversation", createdAtMs: 1, updatedAtMs: 1 };
    const messages = Array.from({ length: 300 }, (_, index) => ({
      id: `file-message-${index}`, threadId: thread.id,
      presentation: { group: "fixture", hue: null, self: false },
      authorKind: "human" as const, authorDisplayName: "Reader",
      body: `File message ${index}`, createdAtMs: index + 1,
    }));
    bridge.listFileChats.mockResolvedValue({ fileObjectId: "object-b", threads: [thread] });
    vi.mocked(bridge.listChatMessages).mockResolvedValue({ messages });
    bridge.chatFileMentionsPage.mockResolvedValue({ versionId: "main", subject: null, unchecked: [], complete: true, indexBuilding: false, mountsCovered: true, sharedChannelRowsUncovered: 0, nextCursor: null, entries: [{
      thread, message: { id: messages[0]!.id, preview: messages[0]!.body, authorDisplayName: "Reader", createdAtMs: 1 },
      attachment: { attachmentId: "file-attachment", threadId: thread.id,
        messageId: messages[0]!.id, targetKind: "file", objectId: "object-b",
        pathHint: "b.md", createdAtMs: 1 },
    }] });
    const scrolled: Array<string | null> = [];
    vi.mocked(Element.prototype.scrollIntoView).mockImplementation(function (this: Element) {
      scrolled.push(this.getAttribute("data-message-id"));
    });
    const user = userEvent.setup();
    renderShell(bridge);
    await user.click(await screen.findByTestId("linked-chat-open"));
    await within(await screen.findByTestId("linked-chat-thread")).findByText("File message 299");
    await waitFor(() => expect(scrolled).toContain("file-message-299"));
    scrolled.length = 0;
    // The chat's link to b.md is a row in About's Links, under the thread.
    await user.click(screen.getByTestId("linked-chat-back"));
    const links = await screen.findByTestId("about-links");
    await user.click(await within(links).findByTestId("chat-file-mention"));
    await waitFor(() => expect(scrolled).toContain("file-message-0"));
    expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");
    expect(bridge.chatFileMentionsPage).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId, subject: { path: "b.md" } });
  });

  it("opens a chat search hit on another file in About once", async () => {
    const bridge = makeBridge(Promise.resolve({ ...STORED_STATE, aboutVisible: false }));
    bridge.listFileChats.mockResolvedValue({ fileObjectId: "object-b", threads: [] });
    const user = userEvent.setup();
    renderShell(bridge);
    await screen.findByTestId("tab-b.md");
    expect(screen.queryByTestId("about-rail")).toBeNull();

    await user.click(screen.getByTestId("activity-search"));
    await user.type(screen.getByTestId("search-input"), "pricing");
    await waitFor(() => expect(bridge.searchWorkspace).toHaveBeenCalled());
    const { searchId } = bridge.searchWorkspace.mock.calls.at(-1)![0];
    act(() => {
      bridge.emitSearchResults({
        searchId,
        entries: [{
          path: "other.md", line: 1, column: 1, preview: "pricing questions", matchStart: 0, matchEnd: 7,
          surface: "chat", threadId: "thread-pricing", title: "Pricing questions",
        }],
        done: true,
        limitHit: false,
      });
    });
    await user.click(await screen.findByTestId("search-result-row"));

    const rail = await screen.findByTestId("about-rail");
    expect((await within(rail).findByTestId("linked-chat-title")).textContent).toBe("Pricing questions");
    // The editor stays on b.md: the hit opens in About, not as a tab.
    expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");

    // Consumed once: closing and reopening About shows b.md, not the thread.
    await user.click(screen.getByTestId("titlebar-about-sidebar"));
    await user.click(screen.getByTestId("titlebar-about-sidebar"));
    const reopened = await screen.findByTestId("about-rail");
    expect((await within(reopened).findByTestId("about-header")).textContent).toBe("b.md");
    expect(within(reopened).queryByTestId("linked-chat-thread")).toBeNull();
  });

  it("restores a layout saved with the old right-panel fields with About closed", async () => {
    const { aboutVisible: _visible, aboutWidth: _width, ...rest } = STORED_STATE;
    const bridge = makeBridge(Promise.resolve({ ...rest, chatsVisible: true, chatsWidth: 444 } as unknown as typeof STORED_STATE));
    renderShell(bridge);

    expect((await screen.findByTestId("tab-b.md")).dataset.active).toBe("true");
    expect((await screen.findByTestId("side-panel")).style.width).toBe("320px");
    expect(screen.queryByTestId("about-rail")).toBeNull();
    expect(screen.getByTestId("titlebar-about-sidebar").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });
});
