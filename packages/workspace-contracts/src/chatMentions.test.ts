import { describe, expect, it } from "vitest";
import {
  activeMentionQuery,
  applyMentionCompletion,
  codeRanges,
  findMentions,
  matchMentionCandidates,
  scanMentionTokens,
  toMentionSegments,
  type MentionCandidate,
} from "./chatMentions";

const you: MentionCandidate = {
  id: "user:you",
  kind: "user",
  handle: "you",
  label: "You",
};
const agent: MentionCandidate = {
  id: "agent:default",
  kind: "agent",
  handle: "agent.ops_v2",
  label: "Your agent",
};
const candidates = [you, agent];

describe("shared mention scanning", () => {
  it("uses the renderer boundary and handle charset", () => {
    const body = "@YOU (@agent.ops_v2) [@you] ice@you.dev @unknown @K @ſ";
    expect(scanMentionTokens(body).map((mention) => mention.handle)).toEqual([
      "YOU",
      "agent.ops_v2",
      "you",
      "unknown",
      "K",
      "ſ",
    ]);
    expect(findMentions(body, candidates).map((mention) => mention.candidate.id)).toEqual([
      "user:you",
      "agent:default",
      "user:you",
    ]);
  });

  it("makes inline code and both fence styles inert", () => {
    const body = [
      "@you outside",
      "`@you inline`",
      "```ts",
      "@you backtick fence",
      "```",
      "~~~~",
      "@agent.ops_v2 tilde fence",
      "~~~~",
    ].join("\n");
    expect(scanMentionTokens(body, { ignoreCode: true }).map((mention) => mention.handle))
      .toEqual(["you"]);
    expect(findMentions(body, candidates, { ignoreCode: true }).map((mention) => mention.handle))
      .toEqual(["you"]);
    expect(codeRanges(body)).toHaveLength(3);
  });

  it("preserves exact offsets and surrounding text when segmenting", () => {
    const body = "ask @agent.ops_v2, then @you";
    const mentions = findMentions(body, candidates, { ignoreCode: true });
    expect(mentions.map((mention) => body.slice(mention.start, mention.end))).toEqual([
      "@agent.ops_v2",
      "@you",
    ]);
    expect(toMentionSegments(body, candidates, { ignoreCode: true })).toEqual([
      { type: "text", text: "ask " },
      { type: "mention", text: "@agent.ops_v2", candidate: agent },
      { type: "text", text: ", then " },
      { type: "mention", text: "@you", candidate: you },
    ]);
  });

  it("trims sentence punctuation from handles while preserving interior dots", () => {
    const punctuationCandidates: MentionCandidate[] = [
      { id: "agent", kind: "agent", handle: "agent", label: "Agent" },
      { id: "dotted", kind: "agent", handle: "a.b", label: "Dotted" },
    ];
    const body = "@agent. @agent, @agent... @a.b";

    const tokens = scanMentionTokens(body);
    expect(tokens.map((mention) => mention.handle)).toEqual([
      "agent",
      "agent",
      "agent",
      "a.b",
    ]);
    expect(tokens.map((mention) => body.slice(mention.start, mention.end))).toEqual([
      "@agent",
      "@agent",
      "@agent",
      "@a.b",
    ]);
    expect(
      findMentions(body, punctuationCandidates).map((mention) => mention.candidate.handle),
    ).toEqual(["agent", "agent", "agent", "a.b"]);
    expect(toMentionSegments("@agent.", punctuationCandidates)).toEqual([
      { type: "mention", text: "@agent", candidate: punctuationCandidates[0] },
      { type: "text", text: "." },
    ]);
  });

  it("drops tokens whose handle trims to nothing", () => {
    for (const body of ["@...", "@___", "wait @... what"]) {
      expect(scanMentionTokens(body)).toEqual([]);
      expect(findMentions(body, candidates)).toEqual([]);
      expect(toMentionSegments(body, candidates)).toEqual([
        { type: "text", text: body },
      ]);
    }
  });
});

describe("shared mention composer helpers", () => {
  it("finds, ranks, and applies an active completion", () => {
    const value = "ask @agent.o next";
    const active = activeMentionQuery(value, 12);
    expect(active).toEqual({ start: 4, query: "agent.o" });
    expect(matchMentionCandidates("agent.o", candidates)).toEqual([agent]);
    expect(applyMentionCompletion(value, active!, agent)).toEqual({
      value: "ask @agent.ops_v2  next",
      caret: 18,
    });
  });

  it("does not open autocomplete in an email or after a Unicode token", () => {
    expect(activeMentionQuery("ice@you", 7)).toBeNull();
    expect(activeMentionQuery("é@you", 5)).toBeNull();
    expect(activeMentionQuery("@K", 2)).toEqual({ start: 0, query: "K" });
  });
});
