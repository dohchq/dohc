import { describe, expect, it } from "vitest";
import { createAccountFeedWaits, readAccountFeed, type AccountFeedAnswer } from "./accountFeed";
import { DiscussionActivityHub } from "./discussionActivity";
import type { AccountFeedLogRow } from "./storage/accountFeed";

// The feed's parts over a stand-in for the relay's log and journal, which
// counts the rows each read asks for.

type JournalRow = { journalCursor: number; objectId: string; path: string };

function backlog(log: AccountFeedLogRow[], journal: JournalRow[]) {
  const largest: number[] = [];
  const page = <Row>(rows: Row[], position: (row: Row) => number, input: { after: number; through: number; limit: number }) => {
    const part = rows.filter((row) => position(row) > input.after && position(row) <= input.through).slice(0, input.limit);
    largest.push(part.length);
    return part;
  };
  const storage = {
    accountFeedStanding: () => ({ ownerUserId: "ana", floor: 0, log: log.at(-1)?.relaySeq ?? 0, journal: journal.at(-1)?.journalCursor ?? 0 }),
    accountFeedLogRows: (input: { workspaceId: string; after: number; through: number; limit: number }) => page(log, (row) => row.relaySeq, input),
    accountFeedJournalRows: (input: { workspaceId: string; after: number; through: number; limit: number }) => page(journal, (row) => row.journalCursor, input),
    accountFeedThreadPaths: () => ({ lastKnownPath: null, named: [] }),
  };
  const waits = createAccountFeedWaits(storage, new DiscussionActivityHub());
  /** Polls from the start until the feed answers nothing new. */
  const poll = async () => {
    const answers: AccountFeedAnswer[] = [];
    let since = "0.0.0";
    for (;;) {
      const answer = await readAccountFeed(storage, waits, {
        workspaceId: "trip", userId: "ana", caller: "phone", since, holdMs: 0, signal: new AbortController().signal, authorize: async () => {},
      });
      if ("replace" in answer) throw new Error("The feed answered replace.");
      if (answer.cursor === since) return answers;
      answers.push(answer);
      since = answer.cursor;
    }
  };
  return { poll, largest };
}

const moment = (relaySeq: number, objectId: string, path: string): AccountFeedLogRow =>
  ({ relaySeq, chat: false, threadId: null, moment: { objectId, path, previousPath: null } });
const range = <Row>(from: number, to: number, row: (position: number) => Row) => Array.from({ length: to - from + 1 }, (_, index) => row(from + index));

describe("the change feed's parts", () => {
  it("reads at most 1,000 journal rows a part, and moves its journal position only past rows it read", async () => {
    const { poll, largest } = backlog([], [
      ...range(1, 1_200, (journalCursor) => ({ journalCursor, objectId: "page-a", path: "docs/a.md" })),
      ...range(1_201, 1_300, (journalCursor) => ({ journalCursor, objectId: "page-b", path: "docs/b.md" })),
    ]);
    expect(await poll()).toEqual([
      { cursor: "0.0.1000", changed: { pages: ["page-a"] } },
      { cursor: "0.0.1300", changed: { pages: ["page-a", "page-b"] } },
    ]);
    expect(Math.max(...largest)).toBe(1_000);
  });

  it("answers a part with nothing visible as unchanged, so the next poll reads the next part", async () => {
    const { poll, largest } = backlog([
      ...range(1, 1_500, (relaySeq) => moment(relaySeq, "object-env", ".env")),
      moment(1_501, "object-c", "docs/c.txt"),
    ], [
      ...range(1, 1_000, (journalCursor) => ({ journalCursor, objectId: "page-env", path: "notes/.env.md" })),
      ...range(1_001, 2_000, (journalCursor) => ({ journalCursor, objectId: "page-a", path: "docs/a.md" })),
      ...range(2_001, 2_500, (journalCursor) => ({ journalCursor, objectId: "page-b", path: "docs/b.md" })),
    ]);
    expect(await poll()).toEqual([
      { cursor: "0.1000.1000", changed: {} },
      { cursor: "0.1501.2000", changed: { files: ["object-c"], pages: ["page-a"] } },
      { cursor: "0.1501.2500", changed: { pages: ["page-b"] } },
    ]);
    expect(Math.max(...largest)).toBe(1_000);
  });
});
