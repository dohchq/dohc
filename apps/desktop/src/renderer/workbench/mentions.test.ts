import { describe, expect, it } from "vitest";
import {
  activeMentionQuery,
  applyMentionCompletion,
  findMentions,
  matchMentionCandidates,
  mentionsAnyCandidate,
  resolveMentionCandidate,
  toMentionSegments,
  type MentionCandidate,
} from "./mentions";

const you: MentionCandidate = {
  id: "user:you",
  kind: "user",
  handle: "you",
  label: "You",
  description: "you",
};
const agent: MentionCandidate = {
  id: "agent:default",
  kind: "agent",
  handle: "agent",
  label: "Your agent",
  description: "your agent",
};
const candidates = [you, agent];

describe("findMentions", () => {
  it("resolves known handles and reports their offsets", () => {
    const body = "Hey @agent can you loop in @you here?";
    const found = findMentions(body, candidates);
    expect(found.map((m) => m.candidate.id)).toEqual(["agent:default", "user:you"]);
    const first = found[0]!;
    expect(body.slice(first.start, first.end)).toBe("@agent");
  });

  it("matches a mention at the very start of the body", () => {
    const found = findMentions("@you please review", candidates);
    expect(found).toHaveLength(1);
    expect(found[0]!.start).toBe(0);
  });

  it("ignores unknown handles so stray @tokens stay plain text", () => {
    expect(findMentions("filed under @todo and @backlog", candidates)).toEqual([]);
  });

  it("does not treat an email address as a mention", () => {
    expect(findMentions("ping ice@you.dev when done", candidates)).toEqual([]);
  });

  it("is case-insensitive on the handle", () => {
    const found = findMentions("thanks @Agent", candidates);
    expect(found).toHaveLength(1);
    expect(found[0]!.candidate.id).toBe("agent:default");
  });
});

describe("resolveMentionCandidate", () => {
  it("returns null for an unknown handle", () => {
    expect(resolveMentionCandidate("nobody", candidates)).toBeNull();
  });
});

describe("toMentionSegments", () => {
  it("preserves surrounding text verbatim and splits out mentions", () => {
    const segments = toMentionSegments("ok @agent go", candidates);
    expect(segments).toEqual([
      { type: "text", text: "ok " },
      { type: "mention", text: "@agent", candidate: agent },
      { type: "text", text: " go" },
    ]);
  });

  it("returns a single text segment when there are no mentions", () => {
    expect(toMentionSegments("no mentions here", candidates)).toEqual([
      { type: "text", text: "no mentions here" },
    ]);
  });
});

describe("mentionsAnyCandidate", () => {
  it("is true only when a listed candidate is mentioned", () => {
    expect(mentionsAnyCandidate("@you around?", [you])).toBe(true);
    expect(mentionsAnyCandidate("@agent around?", [you])).toBe(false);
  });
});

describe("activeMentionQuery", () => {
  it("detects the token the caret is editing", () => {
    const value = "hi @age";
    expect(activeMentionQuery(value, value.length)).toEqual({ start: 3, query: "age" });
  });

  it("returns an empty query right after typing @", () => {
    const value = "hi @";
    expect(activeMentionQuery(value, value.length)).toEqual({ start: 3, query: "" });
  });

  it("returns null when the caret is not in a mention", () => {
    expect(activeMentionQuery("plain text", 5)).toBeNull();
  });

  it("returns null after a space closes the token", () => {
    const value = "hi @agent ";
    expect(activeMentionQuery(value, value.length)).toBeNull();
  });

  it("does not fire for an email-like @", () => {
    const value = "mail ice@you";
    expect(activeMentionQuery(value, value.length)).toBeNull();
  });
});

describe("matchMentionCandidates", () => {
  it("lists all candidates for an empty query, agent first", () => {
    expect(matchMentionCandidates("", candidates).map((c) => c.id)).toEqual([
      "agent:default",
      "user:you",
    ]);
  });

  it("ranks prefix matches on handle and label", () => {
    expect(matchMentionCandidates("you", candidates)[0]!.id).toBe("user:you");
    expect(matchMentionCandidates("your", candidates)[0]!.id).toBe("agent:default");
  });

  it("returns nothing when no candidate matches", () => {
    expect(matchMentionCandidates("zzz", candidates)).toEqual([]);
  });
});

describe("applyMentionCompletion", () => {
  it("replaces the active token with the handle and a trailing space", () => {
    const value = "hi @ag";
    const active = activeMentionQuery(value, value.length)!;
    const result = applyMentionCompletion(value, active, agent);
    expect(result.value).toBe("hi @agent ");
    expect(result.caret).toBe(result.value.length);
  });

  it("completes a token in the middle of a message", () => {
    const value = "tell @yo now";
    const active = activeMentionQuery(value, 8)!;
    const result = applyMentionCompletion(value, active, you);
    expect(result.value).toBe("tell @you  now");
    expect(value.slice(active.start)).toBe("@yo now");
  });
});
