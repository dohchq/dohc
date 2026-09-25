import { describe, expect, it } from "vitest";
import { parseCliArguments } from "./args";

describe("parseCliArguments", () => {
  it("parses the read verbs and global actor options", () => {
    expect(parseCliArguments(["chat", "groups"], {})).toEqual({
      actor: "human",
      json: false,
      verb: "groups",
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
      group: "engineering",
    });
    expect(parseCliArguments(["chat", "inbox"], {})).toEqual({
      actor: "human",
      json: false,
      verb: "inbox",
    });
  });

  it("parses a poll's choices and the answer that picks one", () => {
    expect(
      parseCliArguments(
        ["chat", "post", "trip", "--option", "7am direct", "--option", "2pm with a stop", "Which fare?"],
        {},
      ),
    ).toEqual({
      actor: "human",
      json: false,
      verb: "post",
      group: "trip",
      attachments: [],
      needsDecision: true,
      options: ["7am direct", "2pm with a stop"],
      body: "Which fare?",
    });
    expect(
      parseCliArguments(
        ["chat", "reply", "thread-1", "--resolve", "message-1", "--choose", "7am direct", "The early one."],
        {},
      ),
    ).toEqual({
      actor: "human",
      json: false,
      verb: "reply",
      thread: "thread-1",
      attachments: [],
      needsDecision: false,
      resolve: "message-1",
      choose: "7am direct",
      body: "The early one.",
    });
    expect(() =>
      parseCliArguments(["chat", "reply", "thread-1", "--choose", "7am direct", "x"], {}),
    ).toThrow(/--choose needs --resolve/);
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
      group: "engineering",
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
          "--group",
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
      group: "engineering",
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
      parseCliArguments(["chat", "export", "--group", "eng", "--out", "exports"], {}),
    ).toMatchObject({
      verb: "export",
      scope: { kind: "group", group: "eng" },
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
      group: "general",
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

  it("asks for help without parsing the verb's arguments", () => {
    expect(parseCliArguments([], {})).toEqual({ help: [] });
    expect(parseCliArguments(["-h"], {})).toEqual({ help: [] });
    expect(parseCliArguments(["chat"], {})).toEqual({ help: ["chat"] });
    expect(parseCliArguments(["--help", "dataset"], {})).toEqual({ help: ["dataset"] });
    expect(parseCliArguments(["chat", "reply", "--help"], {})).toEqual({ help: ["chat", "reply"] });
    expect(parseCliArguments(["chat", "--help", "post"], {})).toEqual({ help: ["chat", "post"] });
  });

  it("reads --help as verb input once operands start", () => {
    expect(parseCliArguments(["chat", "post", "general", "Use", "-h", "for", "help"], {})).toMatchObject({
      verb: "post",
      body: "Use -h for help",
    });
    expect(() => parseCliArguments(["chat", "post", "general", "--help", "me"], {})).toThrow(
      "unknown post option '--help'; put -- before text that starts with a dash",
    );
    expect(() => parseCliArguments(["chat", "reply", "th_a", "---", "Report"], {})).toThrow(
      "unknown reply option '---'; put -- before text that starts with a dash",
    );
    expect(() => parseCliArguments(["app", "prepare", "-h", "{}"], {})).toThrow("app prepare does not accept '{}'");
  });

  it("reads --help as text after the terminator or as a flag value", () => {
    expect(parseCliArguments(["chat", "post", "general", "--", "--help"], {})).toMatchObject({
      verb: "post",
      body: "--help",
    });
    expect(parseCliArguments(["chat", "post", "general", "--title", "--help", "Body"], {})).toMatchObject({
      verb: "post",
      title: "--help",
      body: "Body",
    });
  });

  it("requires the fields the CLI cannot ask for later", () => {
    expect(() =>
      parseCliArguments(["dataset", "prepareRecovery", JSON.stringify({ workspaceId: "w" })], {}),
    ).toThrow("dataset prepareRecovery requires sourcePath");
    expect(() =>
      parseCliArguments(["dataset", "list", JSON.stringify({ workspaceId: "w", action: "delete" })], {}),
    ).toThrow("dataset list arguments must not name another action");
  });

  it("accepts a renamed app verb's own name or its request action", () => {
    const selection = { workspaceId: "w", grantId: "g" };
    for (const action of ["responses", "list"]) {
      expect(parseCliArguments(["app", "responses", JSON.stringify({ ...selection, action })], {})).toMatchObject({
        verb: "ownerAppResponses",
        request: { action: "list" },
      });
    }
    expect(() =>
      parseCliArguments(["app", "responses", JSON.stringify({ ...selection, action: "undo" })], {}),
    ).toThrow("app responses arguments must not name another action");
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
