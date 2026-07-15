import { describe, expect, it } from "vitest";
import { formatChatBookmarkProjection } from "./chatBookmarkProjection";

describe("formatChatBookmarkProjection", () => {
  it("formats a live projection with provenance and agent attribution", () => {
    const text = formatChatBookmarkProjection({
      bookmarkId: 'bookmark-"1',
      threadId: "thread-1",
      channelId: "channel-1",
      channelName: "product",
      sourceGrantId: "share-1",
      title: "Pricing decision",
      mode: "live",
      updatedAtMs: Date.UTC(2026, 6, 16, 4, 5, 6),
      messages: [
        {
          id: "message-1",
          authorKind: "human",
          authorDisplayName: "Ice",
          body: "Keep the individual plan simple.",
          createdAtMs: Date.UTC(2026, 6, 16, 4, 0, 0),
        },
        {
          id: "message-2",
          parentMessageId: "message-1",
          authorKind: "agent",
          authorDisplayName: "Ice",
          body: "I checked the assumptions.",
          createdAtMs: Date.UTC(2026, 6, 16, 4, 1, 0),
        },
      ],
    });

    expect(text).toContain('bookmark_id: "bookmark-\\\"1"');
    expect(text).toContain('source_grant_id: "share-1"');
    expect(text).toContain("projection_mode: live");
    expect(text).toContain("projection_state: current");
    expect(text).toContain("Saved from #product");
    expect(text).toContain("## Ice's agent");
    expect(text).toContain("Reply to message message-1");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("marks snapshots and stale copies honestly", () => {
    const snapshotAtMs = Date.UTC(2026, 6, 16, 5, 0, 0);
    const staleAtMs = Date.UTC(2026, 6, 17, 5, 0, 0);
    const text = formatChatBookmarkProjection({
      bookmarkId: "bookmark-2",
      threadId: "thread-2",
      messageId: "message-2",
      title: "Saved answer",
      mode: "snapshot",
      state: "stale",
      updatedAtMs: snapshotAtMs,
      snapshotAtMs,
      staleAtMs,
      messages: [],
    });

    expect(text).toContain('source_message_id: "message-2"');
    expect(text).toContain("projection_mode: snapshot");
    expect(text).toContain("projection_state: stale");
    expect(text).toContain(`snapshot_at: "${new Date(snapshotAtMs).toISOString()}"`);
    expect(text).toContain(`stale_at: "${new Date(staleAtMs).toISOString()}"`);
    expect(text).toContain("source access is no longer available");
  });

  it("rejects incomplete snapshot and stale state", () => {
    const base = {
      bookmarkId: "bookmark-3",
      threadId: "thread-3",
      title: "Incomplete",
      updatedAtMs: 0,
      messages: [],
    } as const;
    expect(() =>
      formatChatBookmarkProjection({ ...base, mode: "snapshot" }),
    ).toThrow(/snapshotAtMs/u);
    expect(() =>
      formatChatBookmarkProjection({ ...base, mode: "live", state: "stale" }),
    ).toThrow(/staleAtMs/u);
  });
});
