import { ProtocolShapeError } from "./wireSchema";
import { describe, expect, it } from "vitest";
import {
  CHATS_METHOD,
  WORKSPACE_METHOD,
  decodeWorkspaceResult,
  decodeChatsResult,
} from "./index";

describe("CLI daemon read decoders", () => {
  it("decodes granular chat candidates including the null thread-header id", () => {
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.searchQueryChatMessagesGranular, {
        results: [
          {
            threadId: "thread-1",
            messageId: null,
            text: "Thread title",
          },
          {
            threadId: "thread-1",
            messageId: "message-1",
            text: "Message body",
          },
        ],
        saturated: false,
      }),
    ).toEqual({
      results: [
        { threadId: "thread-1", messageId: null, text: "Thread title" },
        {
          threadId: "thread-1",
          messageId: "message-1",
          text: "Message body",
        },
      ],
      saturated: false,
    });
  });

  it("fails granular candidates closed on unknown or malformed fields", () => {
    expect(() =>
      decodeWorkspaceResult(WORKSPACE_METHOD.searchQueryChatMessagesGranular, {
        results: [
          {
            threadId: "thread-1",
            messageId: 1,
            text: "bad",
          },
        ],
        saturated: false,
      }),
    ).toThrow(ProtocolShapeError);
    expect(() =>
      decodeWorkspaceResult(WORKSPACE_METHOD.searchQueryChatMessagesGranular, {
        results: [
          {
            threadId: "",
            messageId: null,
            text: "bad",
          },
        ],
        saturated: false,
      }),
    ).toThrow(ProtocolShapeError);
    expect(() =>
      decodeWorkspaceResult(WORKSPACE_METHOD.searchQueryChatMessagesGranular, {
        results: [
          {
            threadId: "thread-1",
            messageId: null,
            text: "bad",
            extra: true,
          },
        ],
        saturated: false,
      }),
    ).toThrow(ProtocolShapeError);
    expect(() =>
      decodeWorkspaceResult(WORKSPACE_METHOD.searchQueryChatMessagesGranular, {
        results: [],
        saturated: "yes",
      }),
    ).toThrow(ProtocolShapeError);
  });

  it("decodes unread file-thread aggregates", () => {
    expect(
      decodeChatsResult(CHATS_METHOD.readStateListUnreadFileThreads, [
        {
          threadId: "thread-1",
          messageCount: 2,
          lastReadSequence: 1,
        },
      ]),
    ).toEqual([
      {
        threadId: "thread-1",
        messageCount: 2,
        lastReadSequence: 1,
      },
    ]);
  });

  it("fails unread aggregates closed on unsafe, negative, or extra data", () => {
    for (const row of [
      {
        threadId: "",
        messageCount: 1,
        lastReadSequence: 0,
      },
      {
        threadId: "thread-1",
        messageCount: Number.MAX_SAFE_INTEGER + 1,
        lastReadSequence: 0,
      },
      {
        threadId: "thread-1",
        messageCount: 1,
        lastReadSequence: -1,
      },
      {
        threadId: "thread-1",
        messageCount: 1,
        lastReadSequence: 0,
        extra: true,
      },
    ]) {
      expect(() =>
        decodeChatsResult(CHATS_METHOD.readStateListUnreadFileThreads, [row]),
      ).toThrow(ProtocolShapeError);
    }
  });
});
