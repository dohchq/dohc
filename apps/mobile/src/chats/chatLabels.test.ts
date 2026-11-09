import { describe, expect, it } from "vitest";
import { chatSubtitle, chatTitle, countText } from "./chatLabels";

describe("a chat's labels", () => {
  it("marks a group with # and nothing else", () => {
    expect(chatTitle("group", "planning")).toBe("#planning");
    expect(chatTitle("comment", "packing-list.md")).toBe("packing-list.md");
    expect(chatTitle("person", "Maya Chen")).toBe("Maya Chen");
    expect(chatTitle("agent", "Scout")).toBe("Scout");
  });

  it("titles an agent that gave no name Agent", () => {
    expect(chatTitle("agent", "")).toBe("Agent");
  });

  // Only dohc's own fact about a connected agent goes in the header, never a reported claim.
  it("says Connected agent under a connected agent's chat, and counts members only where there are several", () => {
    expect(chatSubtitle({ kind: "agent", connected: true }, 6)).toBe("Connected agent");
    expect(chatSubtitle({ kind: "agent" }, 6)).toBeUndefined();
    expect(chatSubtitle({ kind: "person" }, 6)).toBeUndefined();
    expect(chatSubtitle({ kind: "group" }, 6)).toBe("6 members");
    expect(chatSubtitle({ kind: "comment" }, 3)).toBe("3 members");
  });

  it("caps an unread count at 99+", () => {
    expect(countText(1)).toBe("1");
    expect(countText(99)).toBe("99");
    expect(countText(100)).toBe("99+");
  });
});
