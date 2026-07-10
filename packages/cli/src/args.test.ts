import { describe, expect, it } from "vitest";
import { parseCliArguments } from "./args";

describe("parseCliArguments", () => {
  it("parses the read verbs and global actor options", () => {
    expect(parseCliArguments(["chat", "channels"], {})).toEqual({
      actor: "human",
      json: false,
      verb: "channels",
    });
    expect(
      parseCliArguments(["--json", "chat", "show", "msg_ab", "--peek"], {
        DOHC_CHAT_ACTOR: "agent",
      }),
    ).toEqual({
      actor: "agent",
      json: true,
      verb: "show",
      target: "msg_ab",
      peek: true,
    });
    expect(parseCliArguments(["chat", "threads", "engineering", "--as-agent"], {})).toEqual({
      actor: "agent",
      json: false,
      verb: "threads",
      channel: "engineering",
    });
    expect(parseCliArguments(["chat", "inbox"], {})).toEqual({
      actor: "human",
      json: false,
      verb: "inbox",
    });
  });

  it("parses post and reply write options", () => {
    expect(
      parseCliArguments(
        [
          "chat",
          "post",
          "engineering",
          "--title",
          "Conflict policy",
          "--attach",
          "plans/q3.md",
          "--attach",
          "notes.md",
          "--needs-decision",
          "Please review",
        ],
        {},
      ),
    ).toEqual({
      actor: "human",
      json: false,
      verb: "post",
      channel: "engineering",
      title: "Conflict policy",
      attachments: ["plans/q3.md", "notes.md"],
      needsDecision: true,
      body: "Please review",
    });

    expect(
      parseCliArguments(
        [
          "chat",
          "reply",
          "th_8f2",
          "--to",
          "msg_a1",
          "--resolve",
          "msg_old",
          "--attach",
          "report.md",
          "-",
        ],
        {},
      ),
    ).toEqual({
      actor: "human",
      json: false,
      verb: "reply",
      thread: "th_8f2",
      to: "msg_a1",
      resolve: "msg_old",
      attachments: ["report.md"],
      needsDecision: false,
      body: "-",
    });
  });

  it("parses react, grep, and export", () => {
    expect(parseCliArguments(["chat", "react", "msg_a", "👍"], {})).toMatchObject({
      verb: "react",
      message: "msg_a",
      emoji: "👍",
    });
    expect(
      parseCliArguments(
        [
          "chat",
          "grep",
          "BlockId",
          "--channel",
          "engineering",
          "--thread",
          "th_8",
          "--from",
          "agent",
          "--since",
          "7d",
          "-i",
          "-l",
          "-C",
          "2",
          "--limit",
          "25",
          "--regex",
        ],
        {},
      ),
    ).toEqual({
      actor: "human",
      json: false,
      verb: "grep",
      pattern: "BlockId",
      channel: "engineering",
      thread: "th_8",
      from: "agent",
      since: "7d",
      ignoreCase: true,
      filesWithMatches: true,
      context: 2,
      limit: 25,
      regex: true,
    });
    expect(
      parseCliArguments(["chat", "export", "--channel", "eng", "--out", "exports"], {}),
    ).toMatchObject({
      verb: "export",
      scope: { kind: "channel", channel: "eng" },
      outDir: "exports",
    });
  });

  it("accepts a literal grep pattern beginning with dashes after the terminator", () => {
    expect(parseCliArguments(["--json", "chat", "grep", "--", "--as-agent"], {})).toEqual({
      actor: "human",
      json: true,
      verb: "grep",
      pattern: "--as-agent",
      ignoreCase: false,
      filesWithMatches: false,
      context: 0,
      limit: 100,
      regex: false,
    });
    expect(() =>
      parseCliArguments(["chat", "grep", "--", "--literal", "extra"], {}),
    ).toThrow("grep does not accept 'extra' after the pattern");
  });

  it("keeps global-looking body text after the option terminator", () => {
    expect(parseCliArguments(["chat", "post", "general", "--", "--json"], {})).toMatchObject({
      verb: "post",
      json: false,
      body: "--json",
    });
  });

  it("does not consume verb option values that look like global flags", () => {
    expect(
      parseCliArguments(
        [
          "chat",
          "post",
          "general",
          "--title",
          "--json",
          "--attach",
          "--as-agent",
          "Body",
          "--json",
        ],
        {},
      ),
    ).toEqual({
      actor: "human",
      json: true,
      verb: "post",
      channel: "general",
      title: "--json",
      attachments: ["--as-agent"],
      needsDecision: false,
      body: "Body",
    });
  });

  it("continues to accept global flags after verb operands", () => {
    expect(
      parseCliArguments(
        ["chat", "reply", "th_one", "Reply body", "--as-agent", "--json"],
        {},
      ),
    ).toMatchObject({
      actor: "agent",
      json: true,
      verb: "reply",
      thread: "th_one",
      body: "Reply body",
    });
  });

  it("returns distinct input errors", () => {
    expect(() => parseCliArguments(["chat", "reply", "th_a"], {})).toThrow(
      "reply requires a body or '-' for stdin",
    );
    expect(() => parseCliArguments(["chat", "grep", "term", "--limit", "0"], {})).toThrow(
      "--limit requires a positive whole number",
    );
    expect(() =>
      parseCliArguments(
        ["chat", "export", "--all", "--thread", "th_a", "--out", "exports"],
        {},
      ),
    ).toThrow("export accepts only one");
  });
});
