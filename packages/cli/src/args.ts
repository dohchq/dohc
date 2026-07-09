import type { CliActor } from "./protocol";
import { DohcCliError } from "./errors";

export interface ParsedCliBase {
  actor: CliActor;
  json: boolean;
}

export type ParsedCliCommand = ParsedCliBase &
  (
    | { verb: "channels" }
    | { verb: "threads"; channel: string }
    | { verb: "inbox" }
    | { verb: "show"; target: string; peek: boolean }
    | {
        verb: "post";
        channel: string;
        title?: string;
        attachments: string[];
        needsDecision: boolean;
        body: string;
      }
    | {
        verb: "reply";
        thread: string;
        to?: string;
        attachments: string[];
        needsDecision: boolean;
        resolve?: string;
        body: string;
      }
    | { verb: "react"; message: string; emoji: string }
    | {
        verb: "grep";
        pattern: string;
        channel?: string;
        thread?: string;
        from?: string;
        since?: string;
        ignoreCase: boolean;
        filesWithMatches: boolean;
        context: number;
        limit: number;
        regex: boolean;
      }
    | {
        verb: "export";
        scope:
          | { kind: "all" }
          | { kind: "channel"; channel: string }
          | { kind: "thread"; thread: string };
        outDir: string;
      }
  );

function fail(message: string): never {
  throw new DohcCliError(message);
}

function takeValue(tokens: readonly string[], index: number, flag: string): string {
  const value = tokens[index + 1];
  if (value === undefined || value === "--") fail(`${flag} requires a value`);
  return value;
}

function integerFlag(value: string, flag: string, options: { allowZero: boolean }): number {
  if (!/^\d+$/.test(value)) fail(`${flag} requires a whole number`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!options.allowZero && parsed === 0)) {
    fail(`${flag} requires a ${options.allowZero ? "non-negative" : "positive"} whole number`);
  }
  return parsed;
}

function stripGlobalFlags(argv: readonly string[]): {
  actorFlag: boolean;
  json: boolean;
  tokens: string[];
} {
  const optionsWithValues = new Set([
    "--attach",
    "--channel",
    "--from",
    "--limit",
    "--out",
    "--resolve",
    "--since",
    "--thread",
    "--title",
    "--to",
    "-C",
  ]);
  let actorFlag = false;
  let json = false;
  let optionsEnded = false;
  let expectsOptionValue = false;
  const tokens: string[] = [];
  for (const token of argv) {
    if (expectsOptionValue) {
      tokens.push(token);
      expectsOptionValue = false;
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      tokens.push(token);
      continue;
    }
    if (!optionsEnded && token === "--as-agent") {
      actorFlag = true;
      continue;
    }
    if (!optionsEnded && token === "--json") {
      json = true;
      continue;
    }
    tokens.push(token);
    if (!optionsEnded && optionsWithValues.has(token)) {
      expectsOptionValue = true;
    }
  }
  return { actorFlag, json, tokens };
}

function noExtraArgs(tokens: readonly string[], verb: string): void {
  if (tokens.length > 0) fail(`${verb} does not accept '${tokens[0]}'`);
}

function parseShow(tokens: readonly string[]): { target: string; peek: boolean } {
  let target: string | undefined;
  let peek = false;
  for (const token of tokens) {
    if (token === "--peek") {
      peek = true;
    } else if (!target && token !== "--") {
      target = token;
    } else {
      fail(`show does not accept '${token}'`);
    }
  }
  if (!target) fail("show requires a thread or message id");
  return { target, peek };
}

function parsePost(tokens: readonly string[]): Omit<Extract<ParsedCliCommand, { verb: "post" }>, keyof ParsedCliBase | "verb"> {
  const channel = tokens[0];
  if (!channel || channel.startsWith("--")) fail("post requires a channel");
  let title: string | undefined;
  const attachments: string[] = [];
  let needsDecision = false;
  const bodyParts: string[] = [];
  let optionsEnded = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && token === "--title") {
      title = takeValue(tokens, index, token);
      index += 1;
    } else if (!optionsEnded && token === "--attach") {
      attachments.push(takeValue(tokens, index, token));
      index += 1;
    } else if (!optionsEnded && token === "--needs-decision") {
      needsDecision = true;
    } else if (!optionsEnded && token.startsWith("--")) {
      fail(`unknown post option '${token}'`);
    } else {
      bodyParts.push(token);
    }
  }
  const body = bodyParts.join(" ");
  if (!body) fail("post requires a body or '-' for stdin");
  return {
    channel,
    ...(title ? { title } : {}),
    attachments,
    needsDecision,
    body,
  };
}

function parseReply(tokens: readonly string[]): Omit<Extract<ParsedCliCommand, { verb: "reply" }>, keyof ParsedCliBase | "verb"> {
  const thread = tokens[0];
  if (!thread || thread.startsWith("--")) fail("reply requires a thread id");
  let to: string | undefined;
  const attachments: string[] = [];
  let needsDecision = false;
  let resolve: string | undefined;
  const bodyParts: string[] = [];
  let optionsEnded = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && token === "--to") {
      to = takeValue(tokens, index, token);
      index += 1;
    } else if (!optionsEnded && token === "--attach") {
      attachments.push(takeValue(tokens, index, token));
      index += 1;
    } else if (!optionsEnded && token === "--needs-decision") {
      needsDecision = true;
    } else if (!optionsEnded && token === "--resolve") {
      resolve = takeValue(tokens, index, token);
      index += 1;
    } else if (!optionsEnded && token.startsWith("--")) {
      fail(`unknown reply option '${token}'`);
    } else {
      bodyParts.push(token);
    }
  }
  const body = bodyParts.join(" ");
  if (!body) fail("reply requires a body or '-' for stdin");
  return {
    thread,
    ...(to ? { to } : {}),
    attachments,
    needsDecision,
    ...(resolve ? { resolve } : {}),
    body,
  };
}

function parseGrep(tokens: readonly string[]): Omit<Extract<ParsedCliCommand, { verb: "grep" }>, keyof ParsedCliBase | "verb"> {
  const literalPattern = tokens[0] === "--";
  const pattern = tokens[literalPattern ? 1 : 0];
  if (!pattern || (!literalPattern && pattern.startsWith("--"))) {
    fail("grep requires a pattern");
  }
  if (literalPattern && tokens.length > 2) {
    fail(`grep does not accept '${tokens[2]}' after the pattern`);
  }
  let channel: string | undefined;
  let thread: string | undefined;
  let from: string | undefined;
  let since: string | undefined;
  let ignoreCase = false;
  let filesWithMatches = false;
  let context = 0;
  let limit = 100;
  let regex = false;
  for (let index = 1; !literalPattern && index < tokens.length; index += 1) {
    const token = tokens[index]!;
    switch (token) {
      case "--channel":
        channel = takeValue(tokens, index, token);
        index += 1;
        break;
      case "--thread":
        thread = takeValue(tokens, index, token);
        index += 1;
        break;
      case "--from":
        from = takeValue(tokens, index, token);
        index += 1;
        break;
      case "--since":
        since = takeValue(tokens, index, token);
        index += 1;
        break;
      case "-i":
        ignoreCase = true;
        break;
      case "-l":
        filesWithMatches = true;
        break;
      case "-C":
        context = integerFlag(takeValue(tokens, index, token), token, { allowZero: true });
        index += 1;
        break;
      case "--limit":
        limit = integerFlag(takeValue(tokens, index, token), token, { allowZero: false });
        index += 1;
        break;
      case "--regex":
        regex = true;
        break;
      default:
        fail(`unknown grep option '${token}'`);
    }
  }
  return {
    pattern,
    ...(channel ? { channel } : {}),
    ...(thread ? { thread } : {}),
    ...(from ? { from } : {}),
    ...(since ? { since } : {}),
    ignoreCase,
    filesWithMatches,
    context,
    limit,
    regex,
  };
}

function parseExport(tokens: readonly string[]): Omit<Extract<ParsedCliCommand, { verb: "export" }>, keyof ParsedCliBase | "verb"> {
  let scope: Extract<ParsedCliCommand, { verb: "export" }>["scope"] | undefined;
  let outDir: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    let candidate: Extract<ParsedCliCommand, { verb: "export" }>["scope"] | undefined;
    if (token === "--all") {
      candidate = { kind: "all" };
    } else if (token === "--channel") {
      candidate = { kind: "channel", channel: takeValue(tokens, index, token) };
      index += 1;
    } else if (token === "--thread") {
      candidate = { kind: "thread", thread: takeValue(tokens, index, token) };
      index += 1;
    } else if (token === "--out") {
      outDir = takeValue(tokens, index, token);
      index += 1;
    } else {
      fail(`unknown export option '${token}'`);
    }
    if (candidate) {
      if (scope) fail("export accepts only one of --all, --channel, or --thread");
      scope = candidate;
    }
  }
  if (!outDir) fail("export requires --out <dir>");
  return { scope: scope ?? { kind: "all" }, outDir };
}

export function parseCliArguments(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): ParsedCliCommand {
  const global = stripGlobalFlags(argv);
  const [family, verb, ...tokens] = global.tokens;
  if (family !== "chat") fail("usage: dohc chat <verb>");
  const actor: CliActor = global.actorFlag || env.DOHC_CHAT_ACTOR === "agent" ? "agent" : "human";
  const base = { actor, json: global.json };
  switch (verb) {
    case "channels":
      noExtraArgs(tokens, verb);
      return { ...base, verb };
    case "threads": {
      const channel = tokens[0];
      if (!channel) fail("threads requires a channel");
      noExtraArgs(tokens.slice(1), verb);
      return { ...base, verb, channel };
    }
    case "inbox":
      noExtraArgs(tokens, verb);
      return { ...base, verb };
    case "show":
      return { ...base, verb, ...parseShow(tokens) };
    case "post":
      return { ...base, verb, ...parsePost(tokens) };
    case "reply":
      return { ...base, verb, ...parseReply(tokens) };
    case "react": {
      const [message, emoji, ...extra] = tokens;
      if (!message || !emoji) fail("react requires a message id and emoji");
      noExtraArgs(extra, verb);
      return { ...base, verb, message, emoji };
    }
    case "grep":
      return { ...base, verb, ...parseGrep(tokens) };
    case "export":
      return { ...base, verb, ...parseExport(tokens) };
    default:
      fail(verb ? `unknown chat verb '${verb}'` : "usage: dohc chat <verb>");
  }
}
