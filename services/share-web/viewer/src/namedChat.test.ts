import {expect, it} from "vitest";
import {chatBodyTooLong, normalizeChatBody, mergeChatMessages, type NamedChatChannel, type NamedChatMessage} from "./namedChat";

const item = (relaySeq: number, messageId: string): NamedChatMessage => ({relaySeq, messageId, threadId: "", authorUserId: null,
  authorDisplayName: "", authorKind: "human", authorOwnerDisplayName: null, createdAtMs: 0, body: null});

it("merges by relay sequence, so a message ID matching an omission marker keeps both messages", () => {
  const merged = mergeChatMessages([item(4, "omitted:4")], [item(7, "omitted:4"), item(4, "omitted:4")]);
  expect(merged.map(message => message.relaySeq)).toEqual([4, 7]);
});

it("checks the exact human request budget without a client-supplied name", () => {
  const post = {shareId: "share", channelWireId: "wire", id: "00000000-0000-0000-0000-000000000000", body: 'hello "名"', authorKind: "human"};
  const channel: NamedChatChannel = {...post, userId: "alice", name: "Team", access: "read-write", maxBodyBytes: 65536,
    maxPostBytes: new TextEncoder().encode(JSON.stringify(post)).length};
  expect(chatBodyTooLong(post.body, channel)).toBe(false);
  expect(normalizeChatBody(post.body + "\r\n", channel)).toBe(post.body);
  expect(chatBodyTooLong(post.body, {...channel, maxPostBytes: channel.maxPostBytes - 1})).toBe(true);
});
