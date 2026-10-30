// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelThreadRecord } from "../../ipc/bridgeContract";
import { formatShortTime } from "../time";
import { PostCard, type PostData } from "./PostCard";

afterEach(cleanup);

const thread: ChannelThreadRecord = {
  id: "thread-1", title: "Finished Book hotel", createdAtMs: 1, updatedAtMs: 2, channelId: "channel-1",
  messageCount: 1, lastReadSequence: 0, unreadCount: 1,
};

function card(data: PostData, onOpenPath?: (path: string) => void, onOpen = vi.fn()) {
  render(<PostCard
    thread={thread}
    data={data}
    reactionControls={{ reactions: [], viewerAuthorId: "ice", onToggle: vi.fn() }}
    onOpen={onOpen}
    {...(onOpenPath ? { onOpenPath } : {})}
  />);
  return onOpen;
}

const opening = { presentation: { group: "fixture", hue: null, self: false },
  id: "message-1", authorKind: "automation" as const, authorDisplayName: "Stamp the finish date",
  authorOwnerDisplayName: "Ice", createdAtMs: 1, bodySnippet: "Finished Book hotel",
};

describe("PostCard for an automation's post", () => {
  it("draws the automation's mark and opens the automation that ran here without opening the post", () => {
    const onOpenPath = vi.fn();
    const onOpen = card({
      openingMessage: { ...opening, automation: { automationId: "collection:Trip/Tasks#stamp", collectionPath: "Trip/Tasks" } },
      reactions: [], viewerAuthorId: "ice",
    }, onOpenPath);
    expect(screen.getByTitle("Stamp the finish date").querySelector("svg.lucide-zap")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open automation" }));
    expect(onOpenPath).toHaveBeenCalledWith("Trip/Tasks/automations.yaml");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("names an automation from another computer without offering to open it", () => {
    card({ openingMessage: { ...opening, authorUserId: "ana", authorOwnerDisplayName: "Ana" }, reactions: [], viewerAuthorId: "ice" }, vi.fn());
    expect(screen.queryByRole("button", { name: "Open automation" })).toBeNull();
    fireEvent.focus(screen.getByTestId("chats-post-automation-badge"));
    expect(screen.getByRole("tooltip").textContent).toContain("Ran on Ana's computer");
  });
});

describe("PostCard as a feed row", () => {
  const at = new Date(2026, 6, 8, 14, 43).getTime();
  const sam = { id: "message-sam", authorKind: "human" as const, authorDisplayName: "Sam", createdAtMs: at };
  function row(overrides: Partial<ChannelThreadRecord>, bodySnippet: string, reactions: PostData["reactions"] = []) {
    render(<PostCard
      thread={{ ...thread, unreadCount: 0, ...overrides }}
      data={{ openingMessage: { ...sam, bodySnippet }, reactions, viewerAuthorId: "ice" }}
      reactionControls={{ reactions, viewerAuthorId: "ice", onToggle: vi.fn() }}
      onOpen={vi.fn()}
      onToggleBookmark={vi.fn()}
    />);
  }

  it("draws an untitled post's text in ink, with a short time in tabular numbers and no meta line", () => {
    row({ title: "Can we ship on Friday?" }, "Can we ship on Friday?");
    const text = screen.getByTestId("chats-post-title");
    expect(text.className).toContain("text-[14px] leading-[21px]");
    expect(text.className).not.toContain("font-semibold");
    const time = screen.getByTestId("chats-post-time");
    expect(time.textContent).toBe(formatShortTime(at));
    expect(time.getAttribute("dateTime")).toBe(new Date(at).toISOString());
    expect(time.className).toContain("tabular-nums");
    expect(time.className).not.toContain("font-mono");
    expect(screen.queryByTestId("chats-post-footer")).toBeNull();
  });

  it("draws a titled post's title over a muted excerpt", () => {
    row({ title: "Pricing page copy" }, "Draft is ready.");
    expect(screen.getByTestId("chats-post-title").className).toContain("font-semibold");
    expect(screen.getByTestId("chats-post-excerpt").className).toContain("text-muted");
  });

  it("shows an open poll and the comment count as glyphs a screen reader names", () => {
    row({ messageCount: 5, openDecisionCount: 1 }, "Launch checklist");
    const meta = screen.getByTestId("chats-post-footer");
    expect(meta.querySelector('[role="img"][aria-label="Poll open"]')).not.toBeNull();
    expect(screen.queryByText("Poll open")).toBeNull();
    const comments = screen.getByRole("img", { name: "4 comments" });
    expect(comments.textContent).toBe("4");
  });

  it("shows reactions on the meta line and names one comment in the singular", () => {
    row({ messageCount: 2 }, "Launch checklist", [{
      reactionId: "reaction-1", messageId: "message-sam", threadId: "thread-1", emoji: "👍",
      authorId: "ana", authorKind: "human", authorDisplayName: "Ana",
    }]);
    expect(screen.getByTestId("chats-post-footer").contains(screen.getByTestId("chats-post-reaction-pill"))).toBe(true);
    expect(screen.getByRole("img", { name: "1 comment" })).toBeTruthy();
  });

  it("keeps its toolbar in the Tab order, ending with Save as file", async () => {
    const user = userEvent.setup();
    row({}, "Launch checklist");
    const toolbar = screen.getByTestId("chats-post-message-toolbar");
    const classes = toolbar.className.split(/\s+/);
    // Hidden, the toolbar takes no pointer; the conditions that show it
    // also let it take one.
    expect(classes).toEqual(expect.arrayContaining(["opacity-0", "pointer-events-none"]));
    for (const shown of ["group-hover", "group-focus-within", "has-[[popover]]"]) {
      expect(classes).toEqual(expect.arrayContaining([`${shown}:opacity-100`, `${shown}:pointer-events-auto`]));
    }
    // Inside the row's own box: the list paints each row in its own box.
    expect(classes).toEqual(expect.arrayContaining(["top-1", "right-9"]));
    // The row's keyboard focus is drawn inside it, for the same reason.
    expect(screen.getByTestId("chats-post-card").className.split(" ")).toContain("dohc-focus-row");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId("chats-post-card"));
    for (const id of ["chats-post-like", "chats-post-comment", "chats-post-bookmark"]) {
      await user.tab();
      expect(document.activeElement).toBe(screen.getByTestId(id));
      expect(toolbar.contains(document.activeElement)).toBe(true);
    }
    await user.tab();
    expect(document.activeElement).toBe(document.body);
  });
});
