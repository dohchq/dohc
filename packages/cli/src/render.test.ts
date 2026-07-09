import { describe, expect, it } from "vitest";
import {
  renderChannels,
  renderGrep,
  renderShowMarkdown,
  renderThreads,
  type ShowResult,
} from "./render";

const engineering = {
  id: "ch_123",
  name: "Engineering",
  slug: "engineering",
  kind: "channel" as const,
};

const showResult: ShowResult = {
  thread: {
    id: "th_8f2k1c",
    title: "Conflict handling should feel like a doc editor",
    channel: engineering,
    commentCount: 1,
    openDecisionCount: 1,
  },
  messages: [
    {
      id: "msg_root",
      author: { kind: "human", displayName: "Ice de Vera" },
      body: "Right now versioning pops a merge dialog...",
      createdAtMs: Date.parse("2026-07-03T04:05:06.000Z"),
      decisionState: "open",
      attachments: [{ objectId: "obj_q3", pathHint: "q3-plan.md" }],
    },
    {
      id: "msg_reply",
      author: { kind: "agent", displayName: "Ice's agent" },
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

      **Ice de Vera** · 2026-07-03T04:05:06.000Z · msg_root · needs-decision(open)
      Right now versioning pops a merge dialog...
      [attach: q3-plan.md]

      **Ice's agent** · 2026-07-03T05:06:07.000Z · msg_reply · replying to msg_root · run rn_77xy
      Risk: block forks need a stable blockId.
      "
    `);
  });

  it("uses my-agent for the agent channel and keeps every channel id", () => {
    expect(
      renderChannels({
        channels: [
          engineering,
          { id: "ch_agent", name: "Ice's agent", slug: "my-agent", kind: "agent" },
        ],
      }),
    ).toMatchInlineSnapshot(`
      "Engineering · #engineering · channel · ch_123
      my-agent · #my-agent · agent · ch_agent"
    `);
  });

  it("marks unread threads", () => {
    expect(
      renderThreads({
        channel: engineering,
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

  it("renders ripgrep-shaped matches, context messages, and thread-only output", () => {
    const result = {
      matches: [
        {
          channel: engineering,
          threadId: "th_8f2k1c",
          messageId: "msg_reply",
          author: { kind: "agent" as const, displayName: "Ice's agent" },
          createdAtMs: Date.parse("2026-07-03T05:06:07.000Z"),
          text: "  stable\n blockId  ",
          contextBefore: [
            {
              messageId: "msg_root",
              author: { kind: "human" as const, displayName: "Ice de Vera" },
              createdAtMs: Date.parse("2026-07-03T04:05:06.000Z"),
              text: "Earlier context",
            },
          ],
          contextAfter: [],
        },
      ],
    };
    expect(renderGrep(result, { filesWithMatches: false, context: 1 })).toMatchInlineSnapshot(`
      "#engineering th_8f2k1c msg_root Ice de Vera 2026-07-03  - Earlier context
      #engineering th_8f2k1c msg_reply Ice's agent 2026-07-03  stable blockId"
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
