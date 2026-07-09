import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArguments, type ParsedCliCommand } from "./args";
import { sendCliRequest, type CliClientOptions } from "./client";
import { cliErrorLine, DohcCliError } from "./errors";
import {
  CLI_JSON_SCHEMA_VERSION,
  CLI_PROTOCOL_VERSION,
  parseCliResult,
  type CliRequestWithoutToken,
  type CliResultByVerb,
} from "./protocol";
import { renderCliResult } from "./render";

export interface CliExecutionResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

export interface CliExecutionOptions {
  argv: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  readStdin?: () => Promise<string>;
  request?: (request: CliRequestWithoutToken) => Promise<unknown>;
  client?: CliClientOptions;
}

async function processStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function bodyForCommand(
  command: ParsedCliCommand,
  readStdin: () => Promise<string>,
): Promise<string | undefined> {
  if (command.verb !== "post" && command.verb !== "reply") return undefined;
  if (command.body !== "-") return command.body;
  const body = await readStdin();
  if (!body.trim()) throw new DohcCliError("stdin body is empty");
  return body;
}

export function buildCliRequest(
  command: ParsedCliCommand,
  cwdInput: string,
  stdinBody?: string,
): CliRequestWithoutToken {
  const common = {
    protocolVersion: CLI_PROTOCOL_VERSION,
    cwd: resolve(cwdInput),
    actor: command.actor,
  } as const;
  switch (command.verb) {
    case "channels":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: { cwd: common.cwd, actor: common.actor },
      };
    case "threads":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: { cwd: common.cwd, actor: common.actor, channel: command.channel },
      };
    case "inbox":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: { cwd: common.cwd, actor: common.actor },
      };
    case "show":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: { cwd: common.cwd, actor: common.actor, target: command.target, peek: command.peek },
      };
    case "post":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: {
          cwd: common.cwd,
          actor: common.actor,
          channel: command.channel,
          ...(command.title ? { title: command.title } : {}),
          attachments: command.attachments,
          needsDecision: command.needsDecision,
          body: stdinBody ?? command.body,
        },
      };
    case "reply":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: {
          cwd: common.cwd,
          actor: common.actor,
          thread: command.thread,
          ...(command.to ? { to: command.to } : {}),
          attachments: command.attachments,
          needsDecision: command.needsDecision,
          ...(command.resolve ? { resolve: command.resolve } : {}),
          body: stdinBody ?? command.body,
        },
      };
    case "react":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: {
          cwd: common.cwd,
          actor: common.actor,
          message: command.message,
          emoji: command.emoji,
        },
      };
    case "grep":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: {
          cwd: common.cwd,
          actor: common.actor,
          pattern: command.pattern,
          ...(command.channel ? { channel: command.channel } : {}),
          ...(command.thread ? { thread: command.thread } : {}),
          ...(command.from ? { from: command.from } : {}),
          ...(command.since ? { since: command.since } : {}),
          ignoreCase: command.ignoreCase,
          filesWithMatches: command.filesWithMatches,
          context: command.context,
          limit: command.limit,
          regex: command.regex,
        },
      };
    case "export":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: {
          cwd: common.cwd,
          actor: common.actor,
          scope: command.scope,
          outDir: command.outDir,
        },
      };
  }
}

function jsonOutput(result: CliResultByVerb[keyof CliResultByVerb]): string {
  return JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, ...result }, null, 2);
}

export async function executeCli(options: CliExecutionOptions): Promise<CliExecutionResult> {
  try {
    const env = options.env ?? process.env;
    const command = parseCliArguments(options.argv, env);
    const stdinBody = await bodyForCommand(command, options.readStdin ?? processStdin);
    const request = buildCliRequest(command, options.cwd ?? process.cwd(), stdinBody);
    const send =
      options.request ??
      ((value: CliRequestWithoutToken) => sendCliRequest(value, { ...options.client, env }));
    const rawResult = await send(request);
    let result: CliResultByVerb[keyof CliResultByVerb];
    try {
      result = parseCliResult(command.verb, rawResult);
    } catch {
      throw new DohcCliError("desktop app returned an invalid response");
    }
    const output = command.json
      ? jsonOutput(result)
      : renderCliResult(command.verb, result, {
          grepFilesWithMatches: command.verb === "grep" ? command.filesWithMatches : false,
          grepContext: command.verb === "grep" ? command.context : 0,
        });
    return {
      exitCode: 0,
      stdout: output ? `${output.replace(/\n$/, "")}\n` : "",
      stderr: "",
    };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: cliErrorLine(error) };
  }
}

export async function runCliProcess(argv = process.argv.slice(2)): Promise<void> {
  const result = await executeCli({ argv });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await runCliProcess();
}

export { parseCliArguments } from "./args";
export { locateCliEndpoint, sendCliRequest } from "./client";
export { cliErrorLine, DohcCliError } from "./errors";
