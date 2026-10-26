import { ProtocolShapeError } from "../wireSchema";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../protocol";
import {
  CHATS_METHOD,
  decodeChatAttachment,
  decodeChatDecision,
  decodeChatMessage,
  decodeChatReaction,
  decodeChatThread,
  decodeChatsResult,
} from "./chatsWireContract";

describe("chats result decoder rejection", () => {
  it("preserves prototype-named message ids in a null-prototype run map", () => {
    const run: JsonValue = {
      workspaceId: "chat-loopback",
      runId: "run-prototype-key",
      threadId: "thread",
      triggerMessageId: "trigger",
      command: "agent",
      startedAtMs: 1,
      failureHandled: false,
    };
    const wireRuns: { [key: string]: JsonValue | undefined } = {};
    for (const messageId of ["__proto__", "constructor"]) {
      Object.defineProperty(wireRuns, messageId, {
        value: run,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }

    const decoded = decodeChatsResult(CHATS_METHOD.dispatchRunRecordsForThread, {
      runs: wireRuns,
      nextCursor: null,
    });

    expect(Object.getPrototypeOf(decoded.runs), "replacing Object.create(null) with {} drops __proto__ into the prototype setter instead of preserving the caller-supplied message id.").toBeNull();
    expect(Object.keys(decoded.runs)).toEqual(["__proto__", "constructor"]);
    expect(Object.prototype.hasOwnProperty.call(decoded.runs, "__proto__")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(decoded.runs, "constructor")).toBe(true);
    expect(decoded.runs["__proto__"]?.runId).toBe("run-prototype-key");
    expect(decoded.runs["constructor"]?.runId).toBe("run-prototype-key");
  });

  it("accepts daemon-emitted negative imported timestamps", () => {
    expect(
      decodeChatReaction({
        reactionId: "reaction",
        threadId: "thread",
        messageId: "message",
        emoji: "👍",
        author: { authorId: "ada", kind: "human", displayName: "" },
        state: "added",
        atMs: -10,
      }).atMs,
      "restore any decoder's default nonnegative guard -> its decode throws.",
    ).toBe(-10);
    expect(
      decodeChatDecision({
        threadId: "thread",
        messageId: "message",
        state: "open",
        atMs: -9,
      }).atMs,
    ).toBe(-9);
    expect(
      decodeChatThread({
        id: "thread",
        workspaceId: "workspace",
        title: "Imported",
        createdAtMs: -30,
        updatedAtMs: -30,
        linkedFile: { objectId: "object", linkedAtMs: -31 },
      }).linkedFile?.linkedAtMs,
    ).toBe(-31);
    expect(
      decodeChatAttachment({
        attachmentId: "attachment",
        threadId: "thread",
        messageId: "message",
        targetKind: "file",
        createdAtMs: -28,
      }).createdAtMs,
    ).toBe(-28);

    const negativeMessage: JsonValue = {
      id: "negative-message",
      workspaceId: "workspace",
      threadId: "thread",
      author: { kind: "human", displayName: "" },
      body: "Imported",
      createdAtMs: -40,
      attachments: [],
    };
    // This is the shared message-row decoder used by messages.list-shaped rows.
    expect(decodeChatMessage(negativeMessage).createdAtMs).toBe(-40);

    const feed = decodeChatsResult(CHATS_METHOD.feedListPersonal, {
      items: [{
        message: negativeMessage,
        thread: {
          id: "thread",
          workspaceId: "workspace",
          title: "Imported",
          createdAtMs: -41,
          updatedAtMs: -40,
          channelId: "channel",
        },
        reactions: [],
        matchedBy: ["person"],
        channel: {
          id: "channel",
          workspaceId: "workspace",
          name: "Imported",
          slug: "imported",
          kind: "channel",
          type: "posts",
          purpose: "",
          createdAtMs: -42,
          updatedAtMs: -41,
        },
      }],
      nextCursor: null,
      headCursor: null,
      readState: {
        workspaceId: "workspace",
        ownerUserId: "viewer",
        lastSeenCreatedAtMs: -40,
        lastSeenMessageId: "negative-message",
        updatedAtMs: -39,
      },
    });
    expect(feed.items[0]?.message.createdAtMs).toBe(-40);
    expect(feed.items[0]?.channel?.createdAtMs).toBe(-42);
    expect(feed.readState?.lastSeenCreatedAtMs).toBe(-40);
    expect(feed.readState?.updatedAtMs).toBe(-39);
    const agentRead = decodeChatsResult(CHATS_METHOD.agentReadMarkThreadRead, {
      workspaceId: "workspace",
      threadId: "thread",
      lastReadCreatedAtMs: -40,
      lastReadMessageId: "negative-message",
      revision: 1,
      updatedAtMs: 10,
    });
    expect(agentRead.lastReadCreatedAtMs).toBe(-40);

    const summaries = decodeChatsResult(CHATS_METHOD.threadsListForChannel, {
      threads: [{
        thread: {
          id: "thread",
          workspaceId: "workspace",
          title: "Imported",
          createdAtMs: -41,
          updatedAtMs: -40,
          channelId: "channel",
        },
        messageCount: 1,
        lastReadSequence: 0,
        unreadCount: 1,
        openDecisionCount: 0,
        openingMessage: {
          id: "negative-message",
          author: { kind: "human", displayName: "" },
          createdAtMs: -40,
          bodySnippet: "Imported",
          reactions: [],
        },
      }],
      nextCursor: null,
    });
    expect(summaries.threads[0]?.openingMessage?.createdAtMs).toBe(-40);

    const mentions = decodeChatsResult(CHATS_METHOD.mentionsListForHandle, {
      mentions: [{
        threadId: "thread",
        messageId: "negative-message",
        handle: "agent",
        authorKind: "human",
        createdAtMs: -40,
      }],
      nextCursor: null,
    });
    expect(mentions.mentions[0]?.createdAtMs).toBe(-40);

    const fileMentions = decodeChatsResult(CHATS_METHOD.attachmentsListFileMentions, {
      versionId: "main", subject: null, unchecked: [], complete: true, indexBuilding: false,
      mountsCovered: true, sharedChannelRowsUncovered: 0, nextCursor: null,
      entries: [{
        attachment: { attachmentId: "attachment", threadId: "thread", messageId: "negative-message",
          targetKind: "file", objectId: "object", pathHint: "a.md", createdAtMs: -39 },
        message: { id: "negative-message", authorDisplayName: "Ada", preview: "Preview", createdAtMs: -40 },
        thread: { id: "thread", title: "Imported", createdAtMs: -41, updatedAtMs: -40 },
      }],
    });
    expect(fileMentions?.entries[0]?.message.createdAtMs).toBe(-40);
  });

  it("reports a wrong-typed nested field path", () => {
    expect(() =>
      decodeChatMessage({
        id: "m",
        workspaceId: "w",
        threadId: "t",
        author: { kind: "human", displayName: "Ada" },
        body: "body",
        createdAtMs: "wrong",
        attachments: [],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProtocolShapeError>>({
        name: "ProtocolShapeError",
        message: expect.stringContaining("chat message.createdAtMs"),
      }),
    );
  });

  it("rejects unknown result fields and invalid discriminants", () => {
    expect(() =>
      decodeChatsResult(CHATS_METHOD.threadGetProjection, {
        path: ".dohc/chats/a.md",
        readOnly: true,
        threadId: "t",
        text: "x",
        surprise: true,
      }),
    ).toThrow(ProtocolShapeError);
    expect(() =>
      decodeChatsResult(CHATS_METHOD.reactionSet, {
        reactionId: "r",
        threadId: "t",
        messageId: "m",
        emoji: "👍",
        author: { authorId: "a", kind: "robot", displayName: "A" },
        state: "added",
        atMs: 1,
      }),
    ).toThrow(ProtocolShapeError);
  });

  it("rejects unknown fields in nested result objects", () => {
    expect(() =>
      decodeChatMessage({
        id: "m",
        workspaceId: "w",
        threadId: "t",
        author: { kind: "human", displayName: "Ada", surprise: true },
        body: "body",
        createdAtMs: 1,
        attachments: [],
      }),
    ).toThrow(ProtocolShapeError);
  });
});

describe("link messages", () => {
  const linkAuthor = { kind: "link", displayName: "Guest", grantId: "grant-1", principalId: "principal-1" };
  const linkMessage = {
    id: "m",
    workspaceId: "w",
    threadId: "t",
    author: linkAuthor,
    body: "Hello from the link",
    createdAtMs: 1,
    attachments: [],
  };

  it("decodes a link holder's message with its link and name", () => {
    expect(decodeChatMessage(linkMessage).author).toEqual(linkAuthor);
    const opening = decodeChatsResult(CHATS_METHOD.threadsListForChannel, {
      threads: [{
        thread: { id: "t", workspaceId: "w", title: "Hello", createdAtMs: 1, updatedAtMs: 1, channelId: "c" },
        messageCount: 1, lastReadSequence: 0, unreadCount: 1, openDecisionCount: 0,
        openingMessage: { id: "m", author: linkAuthor, createdAtMs: 1, bodySnippet: "Hello", reactions: [] },
      }],
      nextCursor: null,
    });
    expect(opening.threads[0]?.openingMessage?.author).toEqual(linkAuthor);
    expect(decodeChatsResult(CHATS_METHOD.mentionsListForHandle, {
      mentions: [{ threadId: "t", messageId: "m", handle: "ada", authorKind: "link", createdAtMs: 1 }],
      nextCursor: null,
    }).mentions[0]?.authorKind).toBe("link");
  });

  it("rejects a link message that names an account or lacks its link", () => {
    for (const extra of [
      { authorUserId: "user-ada" },
      { authorOwnerDisplayName: "Ada" },
      { authorActorKey: "{\"kind\":\"unknown\"}" },
      { origin: "cli" },
      { automation: { automationId: "collection:tasks#stamp" } },
    ]) {
      expect(() => decodeChatMessage({ ...linkMessage, ...extra }), JSON.stringify(extra)).toThrow(ProtocolShapeError);
    }
    for (const author of [
      { kind: "link", displayName: "Guest", grantId: "grant-1" },
      { kind: "link", displayName: "Guest", principalId: "principal-1" },
      { ...linkAuthor, grantId: "" },
      { ...linkAuthor, kind: "human" },
    ]) {
      expect(() => decodeChatMessage({ ...linkMessage, author }), JSON.stringify(author)).toThrow(ProtocolShapeError);
    }
    expect(() => decodeChatsResult(CHATS_METHOD.threadsListForChannel, {
      threads: [{
        thread: { id: "t", workspaceId: "w", title: "Hello", createdAtMs: 1, updatedAtMs: 1, channelId: "c" },
        messageCount: 1, lastReadSequence: 0, unreadCount: 1, openDecisionCount: 0,
        openingMessage: { id: "m", author: linkAuthor, authorUserId: "user-ada", createdAtMs: 1, bodySnippet: "Hello", reactions: [] },
      }],
      nextCursor: null,
    })).toThrow(ProtocolShapeError);
  });
});
