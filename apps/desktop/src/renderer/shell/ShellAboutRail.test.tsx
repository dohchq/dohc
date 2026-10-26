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
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CHATS_TAB_PATH, chatTabPath } from "../workbench/workbenchState";
import type { DohcDesktopBridge } from "../../ipc/bridgeContract";
import {
  WORKSPACE,
  STORED_STATE,
  SHARE_VIEW,
  SYNC_STATUS,
  makeBridge,
  makeShareBridge,
  renderShell,
  storedStateWithTabs,
} from "../DesktopWorkspaceShell.testHarness";

describe("About rail (right side)", () => {
  it("toggles from the titlebar and Ctrl+Alt+B, and hides entirely when collapsed", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    // Hidden by default (VS Code secondary-sidebar grammar).
    await screen.findByText("a.md");
    expect(screen.queryByTestId("about-rail")).toBeNull();

    const toggle = await screen.findByTestId("titlebar-about-sidebar");
    expect(toggle.getAttribute("aria-label")).toBe("Toggle About");
    await user.click(toggle);
    const rail = await screen.findByTestId("about-rail");
    expect(rail.getAttribute("aria-label")).toBe("About");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    await user.click(toggle);
    expect(screen.queryByTestId("about-rail")).toBeNull();

    // Ctrl+Alt+B is VS Code's secondary-sidebar chord.
    await act(async () => {});
    fireEvent.keyDown(window, { key: "b", ctrlKey: true, altKey: true });
    expect(await screen.findByTestId("about-rail")).toBeTruthy();
    fireEvent.keyDown(window, { key: "b", ctrlKey: true, altKey: true });
    await waitFor(() => expect(screen.queryByTestId("about-rail")).toBeNull());
  });

  it("shows About only: no chat list and no tabs", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    const rail = await screen.findByTestId("about-rail");
    expect(await within(rail).findByTestId("about-header")).toBeTruthy();
    expect(within(rail).queryByTestId("chats-view")).toBeNull();
    expect(rail.querySelector('[data-testid^="chats-panel"]')).toBeNull();
    expect(within(rail).queryByRole("button", { name: "About" })).toBeNull();
    expect(screen.queryByTestId("chats-open-tab")).toBeNull();
  });

  it("restores the stored width and can be resized from its left edge", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    const rail = await screen.findByTestId("about-rail");
    expect(rail.style.width).toBe("360px");
    Object.defineProperty(rail, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 640,
        y: 0,
        left: 640,
        top: 0,
        right: 1000,
        bottom: 800,
        width: 360,
        height: 800,
        toJSON: () => {},
      }),
    });

    const handle = screen.getByTestId("about-rail-resize");
    fireEvent.pointerDown(handle, { button: 0, buttons: 1, pointerId: 1 });
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 100, pointerId: 1 });

    await waitFor(() => {
      expect(rail.style.width).toBe("900px");
    });
  });

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

  it("says what it shows once a file is open", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("titlebar-about-sidebar"));
    await screen.findByTestId("about-rail");

    // No file open yet: About says so honestly.
    expect(
      (await screen.findByTestId("linked-chats-empty")).textContent,
    ).toBe("Open a file or a conversation to see who has access.");
  });

  it("points at a file or a conversation when Chats Home has focus", async () => {
    const bridge = makeBridge(Promise.resolve({
      ...STORED_STATE,
      activeView: "chats",
      editorGroups: [{ id: "primary", tabs: ["b.md", CHATS_TAB_PATH], activeTab: CHATS_TAB_PATH, size: 1 }],
    }));
    renderShell(bridge);

    const rail = await screen.findByTestId("about-rail");
    expect((await within(rail).findByTestId("linked-chats-empty")).textContent).toBe(
      "Switch to a file or a conversation to see who has access.",
    );
    // A conversation open behind Home is somewhere to switch to as well.
    cleanup();
    renderShell(makeBridge(Promise.resolve({
      ...STORED_STATE,
      editorGroups: [{
        id: "primary",
        tabs: [chatTabPath({ kind: "channel", id: "general" }), CHATS_TAB_PATH],
        activeTab: CHATS_TAB_PATH,
        size: 1,
      }],
    })));
    expect((await within(await screen.findByTestId("about-rail")).findByTestId("linked-chats-empty")).textContent).toBe(
      "Switch to a file or a conversation to see who has access.",
    );
    // No file or conversation tab open: nothing to switch to.
    cleanup();
    renderShell(makeBridge(Promise.resolve({
      ...STORED_STATE,
      editorGroups: [{ id: "primary", tabs: [CHATS_TAB_PATH], activeTab: CHATS_TAB_PATH, size: 1 }],
    })));
    expect((await within(await screen.findByTestId("about-rail")).findByTestId("linked-chats-empty")).textContent).toBe(
      "Open a file or a conversation to see who has access.",
    );
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

  it("opens a file that links here at the linking line", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    bridge.listFileChats.mockResolvedValue({ fileObjectId: "object-b", threads: [] });
    bridge.linksIn.mockResolvedValue({
      versionId: "main", subject: { path: "b.md", objectId: "object-b" }, unchecked: [], complete: true,
      indexBuilding: false, mountsCovered: true, nextCursor: null,
      entries: [{ source: "a.md", title: "Alpha", ordinal: 0, span: [4, 11], line: 3, snippet: "See [[b]] here.", highlightStart: 4, highlightEnd: 9 }],
    });
    const user = userEvent.setup();
    renderShell(bridge);
    const links = await screen.findByTestId("about-links");
    const row = await within(links).findByTestId("about-link");
    expect(row.dataset.line).toBe("3");
    const toggle = within(links).getByTestId("about-links-toggle");
    row.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true"));
    expect(bridge.linksIn).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId, subject: { path: "b.md" } });
    // About turns to a.md, and focus stays on the same Links head, as Search
    // keeps focus in its own panel.
    await waitFor(() => expect(within(screen.getByTestId("about-rail")).getByTestId("about-header").textContent).toBe("a.md"));
    expect(screen.getByTestId("about-links-toggle")).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
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

  it("drops a hit not yet read when focus moves while About is closed", async () => {
    const bridge = makeBridge(Promise.resolve({ ...storedStateWithTabs(["a.md", "b.md"], "a.md"), aboutVisible: false }));
    bridge.listFileChats.mockResolvedValue({ fileObjectId: "object-a", threads: [] });
    // Admit the workspace so its saved tabs can restore. Capture is
    // unavailable, so About still cannot consume the search hit.
    const unavailable = { ...SYNC_STATUS, historyRecordingUnavailable: true };
    bridge.openWorkspace.mockResolvedValue(unavailable);
    bridge.getSyncStatus.mockResolvedValue(unavailable);
    const user = userEvent.setup();
    renderShell(bridge);
    await screen.findByTestId("tab-a.md");

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
    expect(await within(await screen.findByTestId("about-rail")).findByTestId("about-rail-off")).toBeTruthy();

    // Close About, move to b.md, open About again, and restore capture.
    await user.click(screen.getByTestId("titlebar-about-sidebar"));
    await user.click(screen.getByTestId("tab-b.md"));
    await user.click(screen.getByTestId("titlebar-about-sidebar"));
    bridge.getSyncStatus.mockResolvedValue(SYNC_STATUS);
    act(() => bridge.emitWorkspaceActivity());
    const rail = await screen.findByTestId("about-rail");
    expect((await within(rail).findByTestId("about-header")).textContent).toBe("b.md");
    expect(within(rail).queryByTestId("linked-chat-thread")).toBeNull();
    // Nor does it wait on a.md: the hit ended when focus left it.
    await user.click(screen.getByTestId("tab-a.md"));
    await waitFor(() => expect(within(rail).getByTestId("about-header").textContent).toBe("a.md"));
    expect(within(rail).queryByTestId("linked-chat-thread")).toBeNull();
  });

  it("gives a conversation its About back once a read hit stops showing", async () => {
    const general = chatTabPath({ kind: "channel", id: "general" });
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs([general], general)));
    bridge.listChatChannels.mockResolvedValue({
      channels: [{
        id: "general", name: "general", slug: "general", kind: "channel",
        createdAtMs: 1, updatedAtMs: 1, threadCount: 0, unreadCount: 0, wireId: "general",
      }],
      fileThreads: [],
    });
    const user = userEvent.setup();
    renderShell(bridge);
    expect((await within(await screen.findByTestId("about-rail")).findByTestId("about-header")).textContent).toBe("general");

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
    expect((await within(screen.getByTestId("about-rail")).findByTestId("linked-chat-title")).textContent)
      .toBe("Pricing questions");

    // Close About and open it again on the same tab: the hit was read and is
    // no longer showing, so the conversation's own About returns.
    await user.click(screen.getByTestId("titlebar-about-sidebar"));
    await user.click(screen.getByTestId("titlebar-about-sidebar"));
    const reopened = await screen.findByTestId("about-rail");
    expect((await within(reopened).findByTestId("about-header")).textContent).toBe("general");
    expect(within(reopened).queryByTestId("linked-chat-thread")).toBeNull();
    expect(within(reopened).queryByTestId("linked-chats-empty")).toBeNull();
  });

  it("points a shared view at its files only, whatever chat tabs it kept", async () => {
    const bridge = makeShareBridge(Promise.resolve({
      ...storedStateWithTabs([chatTabPath({ kind: "channel", id: "general" }), CHATS_TAB_PATH], CHATS_TAB_PATH),
      aboutVisible: true,
    }));
    renderShell(bridge, SHARE_VIEW);
    expect((await within(await screen.findByTestId("about-rail")).findByTestId("linked-chats-empty")).textContent).toBe(
      "Open a file to see its chats and access.",
    );
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

  it("shows the open file's chats and History, and reads access only when opened", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    bridge.listFileChats.mockResolvedValue({ fileObjectId: "object-a", threads: [] });
    const getObjectAccess = vi.fn(async () => ({
      ref: { kind: "path" as const, path: "b.md", versionId: null },
      rows: [],
      visibility: "visible" as const,
      unknownReason: null, coverage: { kind: "granted" as const, complete: true, observation: "interval" as const },
      checkedAtMs: 1_700_000_000_000,
      freshness: "fresh" as const,
      nextCursor: null,
    }));
    const requestAccessRefresh = vi.fn(async () => undefined);
    Object.assign(bridge, { getObjectAccess, requestAccessRefresh });
    const user = userEvent.setup();
    renderShell(bridge);

    const rail = await screen.findByTestId("about-rail");
    expect((await within(rail).findByTestId("about-header")).textContent).toBe("b.md");
    await within(rail).findByTestId("about-history");
    await waitFor(() =>
      expect(bridge.listEngineMoments).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        objectId: "object-a",
        limit: 5,
      }),
    );
    expect(getObjectAccess).not.toHaveBeenCalled();
    expect(requestAccessRefresh).not.toHaveBeenCalled();

    await user.click(within(rail).getByTestId("about-access-toggle"));
    expect((await within(rail).findByTestId("about-access-empty")).textContent).toBe(
      "No share from this workspace includes this file.",
    );
    expect(requestAccessRefresh).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId, reason: "access-expand" });
  });
});
