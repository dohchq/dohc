import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENGINE_SEARCH_INDEX_DDL, type EngineSqliteDb } from "./engineDbSchema";
import { queryChatMessagesGranular } from "./searchIndex";

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => EngineSqliteDb;
};

let db: EngineSqliteDb;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(ENGINE_SEARCH_INDEX_DDL);
});

afterEach(() => {
  db.close();
});

function insertChatSearchRow(input: {
  workspaceId: string;
  threadId: string;
  messageId: string;
  text: string;
}): void {
  db.prepare(
    `INSERT INTO engine_search_chat_messages_fts (workspace_id, thread_id, message_id, text)
     VALUES (?, ?, ?, ?)`,
  ).run(input.workspaceId, input.threadId, input.messageId, input.text);
}

describe("queryChatMessagesGranular", () => {
  it("returns each matching message row with its message id", () => {
    insertChatSearchRow({
      workspaceId: "workspace-a",
      threadId: "thread-1",
      messageId: "message-1",
      text: "The stable needle appears first.",
    });
    insertChatSearchRow({
      workspaceId: "workspace-a",
      threadId: "thread-1",
      messageId: "message-2",
      text: "The stable needle appears again.",
    });
    insertChatSearchRow({
      workspaceId: "workspace-b",
      threadId: "thread-other",
      messageId: "message-other",
      text: "The stable needle belongs elsewhere.",
    });

    expect(
      queryChatMessagesGranular(db, {
        workspaceId: "workspace-a",
        query: "stable needle",
        limit: 10,
      }),
    ).toEqual([
      {
        threadId: "thread-1",
        messageId: "message-1",
        text: "The stable needle appears first.",
      },
      {
        threadId: "thread-1",
        messageId: "message-2",
        text: "The stable needle appears again.",
      },
    ]);
  });

  it("maps a matching thread-title row to a null message id", () => {
    insertChatSearchRow({
      workspaceId: "workspace-a",
      threadId: "thread-1",
      messageId: "__thread__",
      text: "Quarterly planning decisions",
    });

    expect(
      queryChatMessagesGranular(db, {
        workspaceId: "workspace-a",
        query: "planning",
        limit: 10,
      }),
    ).toEqual([
      {
        threadId: "thread-1",
        messageId: null,
        text: "Quarterly planning decisions",
      },
    ]);
    expect(
      queryChatMessagesGranular(db, {
        workspaceId: "workspace-a",
        query: "pl",
        limit: 10,
      }),
    ).toEqual([]);
    expect(
      queryChatMessagesGranular(db, {
        workspaceId: "workspace-a",
        query: "planning",
        limit: -1,
      }),
    ).toEqual([]);
  });
});
