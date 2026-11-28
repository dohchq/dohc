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
  const ahead: string[] = [];
  return {
    read,
    ahead,
    prefetch: (view: View<unknown>) => void read.push(view.id),
    prefetchAhead: (list: readonly View<unknown>[]) => void ahead.push(...list.map((v) => v.id)),
  };
}

describe("the chats warmed before they open", () => {
  it("queues up to three chats, unread first, then Home's files once per store on the polite lane", () => {
    const warm = unreadPrefetch(false);
    const empty = store();
    warm(empty, []);
    expect(empty.ahead).toEqual(["files"]);
    warm(empty, [section(["a", false])]);
    expect(empty.ahead).toEqual(["files", "stream:a"]);

    const data = store();
    warm(data, [
      section(["a", true], ["b", false], ["c", true]),
      section(["d", true], ["e", true]),
    ]);
    expect(data.read).toEqual([]);
    expect(data.ahead).toEqual(["stream:a", "stream:c", "stream:d", "files"]);
    warm(data, [section(["e", true])]);
    expect(data.ahead).toHaveLength(4);

    const readOnly = store();
    warm(readOnly, [section(["x", false], ["y", false], ["z", false], ["w", false])]);
    expect(readOnly.ahead).toEqual(["stream:x", "stream:y", "stream:z", "files"]);

    const mixed = store();
    warm(mixed, [section(["x", false], ["y", true], ["z", false])]);
    expect(mixed.ahead).toEqual(["stream:y", "stream:x", "stream:z", "files"]);
  });

  it("queues each chat's lanes too where phone writes are on", () => {
    const data = store();
    unreadPrefetch(true)(data, [section(["a", true])]);
    expect(data.ahead).toEqual(["stream:a", "lanes:a", "files"]);
  });

  it("leaves archived chats folded away", () => {
    const data = store();
    unreadPrefetch(false)(data, [
      { ...section(["old", true]), key: "archived", title: "Archived" },
      section(["a", true]),
    ]);
    expect(data.ahead).toEqual(["stream:a", "files"]);
  });
});
