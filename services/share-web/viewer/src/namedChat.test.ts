import {expect, it} from "vitest";
import {mergeChatMessages, type NamedChatMessage} from "./namedChat";

const item = (relaySeq: number, messageId: string): NamedChatMessage => ({relaySeq, messageId, threadId: "", authorUserId: null,
  authorDisplayName: "", authorKind: "human", authorOwnerDisplayName: null, createdAtMs: 0, body: null});

it("merges by relay sequence, so a message ID matching an omission marker keeps both messages", () => {
  const merged = mergeChatMessages([item(4, "omitted:4")], [item(7, "omitted:4"), item(4, "omitted:4")]);
  expect(merged.map(message => message.relaySeq)).toEqual([4, 7]);
});
