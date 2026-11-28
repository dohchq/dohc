import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../server/workspaceReads";
import {
  conversationItems,
  localMessage,
  mentionSegments,
  localAuthor,
  serverMessage,
  withMentions,
} from "./serverMessages";

const at = new Date(2026, 10, 5, 12, 0).getTime();
const entry = (
  id: string,
  authorKind: ChatMessage["authorKind"],
  authorName: string,
  minutes: number,
): ChatMessage => ({
  id,
  threadId: "thread-1",
  authorKind,
  authorName,
  body: id,
  createdAtMs: at + minutes * 60_000,
  parentMessageId: null,
  attachments: [],
  needsDecision: false,
  decisionState: null,
  options: [],
  optionDetails: [],
  chosenOption: null,
  resolvedByMessageId: null,
  reactions: [],
});
const continued = (...entries: ChatMessage[]) =>
  conversationItems(
    entries.map((item) => serverMessage(item, null, ["#000000"])),
    at,
  ).flatMap((item) => (item.type === "message" ? [item.continued] : []));

describe("a conversation's outbox messages", () => {
  it("follow the server's, each with its own byline, keyed by the ID the server will give it", () => {
    const you = { id: "local:you", name: "You", kind: "person" as const };
    const mine = localMessage(
      {
        messageId: "message-1",
        lane: "chat",
        mark: { operationId: "op-1", state: { kind: "waiting" }, attempted: false, body: "Hi" },
        replyable: true,
        threadId: null,
      },
      you,
    );
    // A reply to it waits for the outbox's record, and names the message it will make.
    expect(mine.replyable).toEqual({ operationId: "op-1", messageId: "message-1", threadId: null });
    const items = conversationItems(
      [serverMessage(entry("m1", "human", "You", 0), null, ["#000000"])],
      at,
      [mine],
    ).flatMap((item) => (item.type === "message" ? [[item.key, item.continued]] : []));
    expect(items).toEqual([
      ["m1", false],
      ["message-1", false],
    ]);
  });
});

describe("a conversation's runs", () => {
  it("join a follow-up from the same author within 5 minutes", () => {
    expect(
      continued(
        entry("m1", "human", "Maya", 0),
        entry("m2", "human", "Maya", 4),
        entry("m3", "human", "Maya", 10),
      ),
    ).toEqual([false, true, false]);
  });

  it("keep a person and an agent with the same name apart", () => {
    expect(
      continued(
        entry("m1", "human", "Nova", 0),
        entry("m2", "agent", "Nova", 1),
        entry("m3", "agent", "Nova", 2),
      ),
    ).toEqual([false, false, true]);
    expect(
      continued(entry("m1", "automation", "Nova", 0), entry("m2", "human", "Nova", 1)),
    ).toEqual([false, false]);
  });

  it("starts a new run and day divider across local midnight even within 5 minutes", () => {
    const beforeMidnight = new Date(2026, 10, 4, 23, 59).getTime();
    const afterMidnight = new Date(2026, 10, 5, 0, 1).getTime();
    const items = conversationItems(
      [
        serverMessage({ ...entry("m1", "human", "Maya", 0), createdAtMs: beforeMidnight }, null, [
          "#000000",
        ]),
        serverMessage({ ...entry("m2", "human", "Maya", 0), createdAtMs: afterMidnight }, null, [
          "#000000",
        ]),
      ],
      afterMidnight,
    );
    expect(items.filter((item) => item.type === "day")).toHaveLength(2);
    expect(items.filter((item) => item.type === "message").map((item) => item.continued)).toEqual([
      false,
      false,
    ]);
  });
});

describe("mentionSegments", () => {
  const candidates = [
    { id: "ice", kind: "user" as const, handle: "Ice", label: "Ice", connected: false },
    { id: "claude", kind: "agent" as const, handle: "Claude", label: "Claude", connected: false },
  ];

  it("draws each @handle that names a candidate as a mention, as written", () => {
    expect(mentionSegments("Can @ice and @Claude join? @Nobody", candidates)).toEqual([
      { text: "Can " },
      { mention: "ice" },
      { text: " and " },
      { mention: "Claude", agent: true },
      { text: " join? @Nobody" },
    ]);
  });

  it("leaves a handle in code as text", () => {
    expect(mentionSegments("`@Ice`", candidates)).toEqual([{ text: "`@Ice`" }]);
  });

  it("keeps a message that names nobody as it was", () => {
    const message = serverMessage(entry("hello", "human", "Ice", 0), null, ["#000000"]);
    expect(withMentions(message, candidates)).toBe(message);
    const named = serverMessage({ ...entry("m", "human", "Ice", 0), body: "@Ice" }, null, [
      "#000000",
    ]);
    expect(withMentions(named, candidates).body).toEqual([{ mention: "Ice" }]);
  });
});

describe("localAuthor", () => {
  it("draws this phone's own message as the server will draw it once saved", () => {
    const fills = ["#111111", "#222222", "#333333"];
    const local = localAuthor(" Ice ", fills);
    const saved = serverMessage(entry("m", "human", "Ice", 0), null, fills).author;
    expect({ ...local, id: saved.id }).toEqual(saved);
  });

  it("names it as the server normalizes the account's name, and You until the name is read", () => {
    const fills = ["#111111"];
    expect(localAuthor("  Ice   de  Vera ", fills).name).toBe("Ice de Vera");
    expect(localAuthor(null, fills).name).toBe("Unnamed");
    expect(localAuthor(undefined, fills).name).toBe("You");
  });
});
