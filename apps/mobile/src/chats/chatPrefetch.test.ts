import { describe, expect, it } from "vitest";
import type { View } from "../server/workspaceData";
import { unreadPrefetch } from "./chatPrefetch";
import type { ChatSection } from "./types";

const section = (...rows: [string, boolean][]): ChatSection => ({
  key: "group",
  title: "Groups",
  rows: rows.map(([id, unread]) => ({ id, kind: "group", name: id, unread })),
});

function store() {
  const read: string[] = [];
  return { read, prefetch: (view: View<unknown>) => void read.push(view.id) };
}

describe("the unread chats read before they open", () => {
  it("waits for a list with an unread chat, then reads the first three once per store", () => {
    const warm = unreadPrefetch(false);
    const data = store();
    warm(data, [section(["a", false])]);
    expect(data.read).toEqual([]);

    warm(data, [
      section(["a", true], ["b", false], ["c", true]),
      section(["d", true], ["e", true]),
    ]);
    expect(data.read).toEqual(["stream:a", "stream:c", "stream:d"]);
    warm(data, [section(["e", true])]);
    expect(data.read).toHaveLength(3);

    const next = store();
    warm(next, [section(["e", true])]);
    expect(next.read).toEqual(["stream:e"]);
  });

  it("reads each chat's lanes too where phone writes are on", () => {
    const data = store();
    unreadPrefetch(true)(data, [section(["a", true])]);
    expect(data.read).toEqual(["stream:a", "lanes:a"]);
  });

  it("leaves archived chats folded away unread", () => {
    const data = store();
    unreadPrefetch(false)(data, [
      { ...section(["old", true]), key: "archived", title: "Archived" },
      section(["a", true]),
    ]);
    expect(data.read).toEqual(["stream:a"]);
  });
});
