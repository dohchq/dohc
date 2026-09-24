import { describe, expect, it } from "vitest";
import {
  renderGroups,
  renderGrep,
  renderInbox,
  renderShowMarkdown,
  renderThreads,
  type ShowResult,
} from "./render";
import {
  formatMessageHandle,
  renderThreadMarkdown,
} from "./threadMarkdown";

const engineering = {
  id: "ch_123",
  name: "Engineering",
  slug: "engineering",
  kind: "group" as const,
};

const showResult: ShowResult = {
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
  it("renders the canonical thread form with every message id", () => {
    expect(renderShowMarkdown(showResult)).toMatchInlineSnapshot(`
      "# Conflict handling should feel like a doc editor
      thread: th_8f2k1c · #engineering · 1 comments · open decisions: 1

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
          engineering,
          { id: "ch_agent", name: "my-agent", slug: "my-agent", kind: "agent" },
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
});
