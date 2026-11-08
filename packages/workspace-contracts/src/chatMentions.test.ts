import { describe, expect, it } from "vitest";
import {
  activeMentionQuery,
  applyMentionCompletion,
  codeCover,
  codeRanges,
  findMentions,
  matchMentionCandidates,
  scanMentionTokens,
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

  it("reports exact offsets for resolved mentions", () => {
    const body = "ask @agent.ops_v2, then @you";
    const mentions = findMentions(body, candidates, { ignoreCode: true });
    expect(mentions.map((mention) => body.slice(mention.start, mention.end))).toEqual([
      "@agent.ops_v2",
      "@you",
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
  });

  it("drops tokens whose handle trims to nothing", () => {
    for (const body of ["@...", "@___", "wait @... what"]) {
      expect(scanMentionTokens(body)).toEqual([]);
      expect(findMentions(body, candidates)).toEqual([]);
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

describe("code cover", () => {
  // Bodies of backtick runs, fences, mentions and line breaks, from a fixed seed.
  const bodies = () => {
    const pieces = ["`", "``", "```\n", "~~~\n", "\n", " ", "a", "@you ", "  ```\n"];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    return Array.from({ length: 3000 }, () => {
      let body = "";
      const size = Math.floor(random() * 30);
      for (let at = 0; at < size; at++) body += pieces[Math.floor(random() * pieces.length)];
      return body;
    });
  };
  const inRanges = (body: string) => {
    const ranges = codeRanges(body);
    return (position: number) => ranges.some(([start, end]) => position >= start && position < end);
  };

  it("agrees with the ranges at every position", () => {
    for (const body of bodies()) {
      const cover = codeCover(body);
      const naive = inRanges(body);
      const positions = Array.from({ length: body.length + 1 }, (_, at) => at);
      expect({ body, inside: positions.map(cover) }).toEqual({ body, inside: positions.map(naive) });
    }
  });

  it("drops the same mentions as the ranges do", () => {
    for (const body of bodies()) {
      const naive = inRanges(body);
      const expected = scanMentionTokens(body).filter((mention) => !naive(mention.start));
      expect({ body, found: scanMentionTokens(body, { ignoreCode: true }) }).toEqual({ body, found: expected });
    }
  });

  it("scans a long body of backtick runs in linear time", () => {
    for (const body of ["`@you ".repeat(8000), "```\na\n```\n".repeat(5000) + "`x`".repeat(5000)]) {
      const started = performance.now();
      scanMentionTokens(body, { ignoreCode: true });
      expect(performance.now() - started).toBeLessThan(100);
    }
  });
});
