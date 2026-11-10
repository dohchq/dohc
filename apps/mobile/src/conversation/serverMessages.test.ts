import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../server/workspaceReads";
import { conversationItems, serverMessage } from "./serverMessages";

const at = new Date(2026, 10, 5, 12, 0).getTime();
const entry = (id: string, authorKind: ChatMessage["authorKind"], authorName: string, minutes: number): ChatMessage =>
  ({ id, threadId: "thread-1", authorKind, authorName, body: id, createdAtMs: at + minutes * 60_000 });
const continued = (...entries: ChatMessage[]) => conversationItems(entries.map(item => serverMessage(item, null, ["#000000"])), at)
  .flatMap(item => item.type === "message" ? [item.continued] : []);

describe("a conversation's runs", () => {
  it("join a follow-up from the same author within 5 minutes", () => {
    expect(continued(entry("m1", "human", "Maya", 0), entry("m2", "human", "Maya", 4), entry("m3", "human", "Maya", 10))).toEqual([false, true, false]);
  });

  it("keep a person and an agent with the same name apart", () => {
    expect(continued(entry("m1", "human", "Nova", 0), entry("m2", "agent", "Nova", 1), entry("m3", "agent", "Nova", 2))).toEqual([false, false, true]);
    expect(continued(entry("m1", "automation", "Nova", 0), entry("m2", "human", "Nova", 1))).toEqual([false, false]);
  });
});
