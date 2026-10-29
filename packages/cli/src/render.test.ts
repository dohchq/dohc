import { describe, expect, it } from "vitest";
import {
  renderCliResult,
  renderGroups,
  renderGrep,
  renderInbox,
  renderShowMarkdown,
  renderThreads,
} from "./render";
import type { CliShowThreadResult as ShowResult } from "./protocol";
import {
  formatMessageHandle,
  renderThreadMarkdown,
} from "./threadMarkdown";

it("prints operation link progress and the committed History receipt", () => {
  const operation = {ok: true as const, operationId: "dohc-operation:11111111-1111-4111-8111-111111111111", members: [], nextCursor: null};
  expect(renderCliResult("historyOperation", {...operation, links: {state: "updating"}})).toBe("Updating links…");
  expect(renderCliResult("historyOperation", {...operation, links: {state: "done", documents: 3, unchecked: ["source.md"], uncheckedCount: 2}}))
    .toBe("Link updates committed in History: 3 documents. Disk writes follow.\n2 linking documents not checked.\nNot checked: source.md");
});

const engineering = {
  id: "ch_123",
  name: "Engineering",
  slug: "engineering",
  kind: "group" as const,
};

const showResult: ShowResult = {
  dispatch: { paused: null, lastRun: null },
  thread: {
    id: "th_8f2k1c",
    title: "Conflict handling should feel like a doc editor",
    group: engineering,
    commentCount: 1,
    openDecisionCount: 1,
  },
  messages: [
    {
      id: "msg_root",
      author: { kind: "human", displayName: "Sam Rivera" },
      body: "Right now versioning pops a merge dialog...",
      createdAtMs: Date.parse("2026-07-03T04:05:06.000Z"),
      decisionState: "open",
      attachments: [{ objectId: "obj_q3", pathHint: "q3-plan.md" }],
    },
    {
      id: "msg_reply",
      author: { kind: "agent", displayName: "Sam" },
      body: "Risk: block forks need a stable blockId.",
      createdAtMs: Date.parse("2026-07-03T05:06:07.000Z"),
      parentMessageId: "msg_root",
      attachments: [],
      runId: "rn_77xy",
    },
  ],
};

describe("markdown renderers", () => {
  it("renders thread content without live dispatch metadata", () => {
    const { thread, messages } = showResult;
    const markdown = renderThreadMarkdown({ thread, messages });
    expect(markdown).not.toContain("dispatch:");
    expect(markdown).toContain(messages[0]!.body);
    expect(markdown).toContain("needs-decision(open)");
    expect(markdown).toContain("[attach: q3-plan.md]");
  });

  it("renders a no-reply failure in show", () => {
    const dispatch: ShowResult["dispatch"] = {
      paused: null, lastRun: { state: "failed", failureReason: "no-reply", exitCode: 0 },
    };
    expect(renderShowMarkdown({ ...showResult, dispatch })).toContain(
      'dispatch: {"paused":null,"lastRun":{"state":"failed","failureReason":"no-reply","exitCode":0}}',
    );
  });

  it("renders the canonical thread form with every message id", () => {
    expect(renderShowMarkdown(showResult)).toMatchInlineSnapshot(`
      "# Conflict handling should feel like a doc editor
      thread: th_8f2k1c · #engineering · 1 comments · open decisions: 1
      dispatch: {"paused":null,"lastRun":null}

      **Sam Rivera** · 2026-07-03T04:05:06.000Z · msg_root · needs-decision(open)
      Right now versioning pops a merge dialog...
      [attach: q3-plan.md]

      **Sam** · 2026-07-03T05:06:07.000Z · msg_reply · replying to msg_root · run rn_77xy
      Risk: block forks need a stable blockId.
      "
    `);
  });

  it("keeps engine-backed runner context byte-identical to CLI show output", () => {
    const runnerInput: ShowResult = {
      ...showResult,
      thread: { ...showResult.thread, id: "thread-8f2k1c" },
      messages: showResult.messages.map((message) => ({
        ...message,
        id: message.id.replace(/^msg_/u, "message-"),
        ...(message.parentMessageId
          ? { parentMessageId: message.parentMessageId.replace(/^msg_/u, "message-") }
          : {}),
      })),
    };

    expect(renderThreadMarkdown(runnerInput)).toBe(renderShowMarkdown(showResult));
    expect(formatMessageHandle("message-123")).toBe("msg_123");
    expect(formatMessageHandle("msg_123")).toBe("msg_123");
  });

  it("says a message came from an automation", () => {
    const fromAutomation: ShowResult = {
      ...showResult,
      messages: [{
        ...showResult.messages[0]!,
        author: { kind: "automation", displayName: "Stamp the finish date" },
      }],
    };
    expect(renderThreadMarkdown(fromAutomation)).toContain(
      "**Stamp the finish date** · automation · 2026-07-03T04:05:06.000Z · msg_root",
    );
  });

  it("renders a redacted attachment with an opaque label", () => {
    const redacted: ShowResult = {
      ...showResult,
      messages: [{
        ...showResult.messages[0]!,
        attachments: [{}],
      }],
    };

    expect(renderThreadMarkdown(redacted)).toContain("[attach: attachment]");
  });

  it("preserves the canonical no-open-decisions label", () => {
    expect(
      renderShowMarkdown({
        ...showResult,
        thread: { ...showResult.thread, openDecisionCount: 0 },
      }),
    ).toContain("open decisions: none");
  });

  it("uses my-agent for the agent group and keeps every group id", () => {
    expect(
      renderGroups({
        groups: [
          { ...engineering, channelWireId: "wire" },
          { id: "ch_agent", name: "my-agent", slug: "my-agent", kind: "agent", channelWireId: null },
        ],
      }),
    ).toMatchInlineSnapshot(`
      "Engineering · #engineering · group · ch_123
      my-agent · #my-agent · agent · ch_agent"
    `);
  });

  it("marks unread threads", () => {
    expect(
      renderThreads({
        group: engineering,
        threads: [
          {
            id: "th_unread",
            title: "Review this",
            commentCount: 2,
            openDecisionCount: 0,
            unread: true,
            updatedAtMs: 1,
          },
        ],
      }),
    ).toContain("[unread] · th_unread");
  });

  it("labels agent authors in inbox mentions without relabeling humans", () => {
    const common = {
      group: engineering,
      threadId: "th_8f2k1c",
      createdAtMs: Date.parse("2026-07-03T05:06:07.000Z"),
    };
    expect(
      renderInbox({
        threads: [],
        mentions: [
          {
            ...common,
            messageId: "msg_agent",
            author: { kind: "agent", displayName: "Sam" },
            text: "Agent update",
          },
          {
            ...common,
            messageId: "msg_human",
            author: { kind: "human", displayName: "Sam Rivera" },
            text: "Human update",
          },
        ],
      }),
    ).toBe(
      "@mention · #engineering · th_8f2k1c · msg_agent · Sam · 2026-07-03  Agent update\n" +
        "@mention · #engineering · th_8f2k1c · msg_human · Sam Rivera · 2026-07-03  Human update",
    );
  });

  it("renders ripgrep-shaped matches, context messages, and thread-only output", () => {
    const result = {
      matches: [
        {
          group: engineering,
          threadId: "th_8f2k1c",
          messageId: "msg_reply",
          author: { kind: "agent" as const, displayName: "Sam" },
          createdAtMs: Date.parse("2026-07-03T05:06:07.000Z"),
          text: "  stable\n blockId  ",
          contextBefore: [
            {
              messageId: "msg_root",
              author: { kind: "human" as const, displayName: "Sam Rivera" },
              createdAtMs: Date.parse("2026-07-03T04:05:06.000Z"),
              text: "Earlier context",
            },
          ],
          contextAfter: [],
        },
      ],
    };
    expect(renderGrep(result, { filesWithMatches: false, context: 1 })).toMatchInlineSnapshot(`
      "#engineering th_8f2k1c msg_root Sam Rivera 2026-07-03  - Earlier context
      #engineering th_8f2k1c msg_reply Sam 2026-07-03  stable blockId"
    `);
    expect(renderGrep(result, { filesWithMatches: true, context: 1 })).toBe("th_8f2k1c");
    expect(
      renderGrep({ threadIds: ["th_8f2k1c", "th_other"] }, {
        filesWithMatches: true,
        context: 0,
      }),
    ).toBe("th_8f2k1c\nth_other");
  });

  it("renders a group's stream with each post's replies, the read mark, and the older page", () => {
    const sam = { kind: "human" as const, displayName: "Sam" };
    const scout = { kind: "agent" as const, displayName: "Scout" };
    const markdown = renderShowMarkdown({
      stream: {
        group: engineering,
        items: [
          {
            position: { createdAtMs: 1_000, lane: "posts", id: "th_1" },
            threadId: "th_1",
            message: { id: "msg_1", author: sam, body: "Plan the trip", createdAtMs: 1_000, attachments: [] },
            post: {
              replyCount: 2,
              repliers: [{ author: scout, lastReplyAtMs: 3_000 }],
              lastReplyAtMs: 3_000,
              latestAgentReply: { id: "msg_3", author: scout, createdAtMs: 3_000, bodyExcerpt: "Booked the train." },
              openDecisionCount: 1,
            },
          },
          {
            position: { createdAtMs: 4_000, lane: "chat", id: "msg_4" },
            threadId: "th_chat",
            message: {
              id: "msg_4", author: sam, body: "Who is driving?", createdAtMs: 4_000, attachments: [],
              agentRequests: [{ agentId: "default", state: "failed", failureReason: "no-reply" }],
            },
          },
        ],
        nextBefore: { createdAtMs: 1_000, lane: "posts", id: "th_1" },
        readPosition: { createdAtMs: 1_000, lane: "posts", id: "th_1" },
      },
    });
    expect(markdown).toBe([
      "# #engineering",
      "older: --before 1000:posts:th_1",
      "",
      "**Sam** · 1970-01-01T00:00:01.000Z · th_1 · 2 replies · from Scout · last reply 1970-01-01T00:00:03.000Z · open decisions: 1",
      "Plan the trip",
      "> **Scout** · 1970-01-01T00:00:03.000Z · msg_3: Booked the train.",
      "",
      "--- read up to here ---",
      "",
      "**Sam** · 1970-01-01T00:00:04.000Z · msg_4 · agent default failed (no-reply)",
      "Who is driving?",
      "",
    ].join("\n"));
  });
});
