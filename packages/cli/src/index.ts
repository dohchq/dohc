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

const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;

interface CliExecutionResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

interface CliExecutionOptions {
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

function buildCliRequest(
  command: ParsedCliCommand,
  cwdInput: string,
  stdinBody?: string,
  runId?: string,
): CliRequestWithoutToken {
  const common = {
    protocolVersion: CLI_PROTOCOL_VERSION,
    cwd: resolve(cwdInput),
    actor: command.actor,
  } as const;
  switch (command.verb) {
    case "dataset":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor, request: command.request } };
    case "appForm":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor, request: command.request } };
    case "appBackend":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor, request: command.request } };
    case "appPublication":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor, request: command.request } };
    case "ownerAppResponses":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor, request: command.request } };
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
          ...(runId ? { runId } : {}),
          channel: command.channel,
          ...(command.title ? { title: command.title } : {}),
          attachments: command.attachments,
          needsDecision: command.needsDecision,
          ...(command.options ? { options: command.options } : {}),
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
          ...(runId ? { runId } : {}),
          thread: command.thread,
          ...(command.to ? { to: command.to } : {}),
          attachments: command.attachments,
          needsDecision: command.needsDecision,
          ...(command.options ? { options: command.options } : {}),
          ...(command.resolve ? { resolve: command.resolve } : {}),
          ...(command.choose ? { choose: command.choose } : {}),
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
          ...(runId ? { runId } : {}),
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
    if (options.argv.length === 2 && options.argv[0] === "dataset" && ["--help", "-h"].includes(options.argv[1]!)) return {
      exitCode: 0, stderr: "", stdout: [
        "Usage: dohc [--as-agent] dataset <action> '<JSON>' [--json]",
        "Actions: list, describe, create, prepare, approve, discard, invoke",
        "Every request names workspaceId. Run this command from its owning workspace.",
        "list: optional after and limit. describe: datasetId.",
        "create: definition. Writes generated source and prepares it for approval.",
        "prepare: descriptorPath. Captures existing source for review.",
        "approve: preparationId and revisionSha256 from the reviewed preparation.",
        "discard: preparationId. Leaves the source files in place.",
        "invoke: datasetId, revision, revisionSha256, operationId, input, idempotencyKey.",
        "Use describe to find approved operation IDs. Retry uncertain writes with the same input and idempotencyKey.",
        "Commands use the same Collection rules as dohc. They do not accept SQL or caller identity.",
        "",
      ].join("\n"),
    };
    const env = options.env ?? process.env;
    const command = parseCliArguments(options.argv, env);
    const stdinBody = await bodyForCommand(command, options.readStdin ?? processStdin);
    const request = buildCliRequest(
      command,
      options.cwd ?? process.cwd(),
      stdinBody,
      env.DOHC_RUN_ID,
    );
    const send =
      options.request ??
      ((value: CliRequestWithoutToken) =>
        sendCliRequest(value, {
          ...options.client,
          timeoutMs: options.client?.timeoutMs ?? (command.verb === "dataset" || command.verb === "appBackend" || command.verb === "appPublication" || command.verb === "ownerAppResponses" ? 90_000 : DEFAULT_RESPONSE_TIMEOUT_MS),
          env,
        }));
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

async function runCliProcess(argv = process.argv.slice(2)): Promise<void> {
  const result = await executeCli({ argv });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await runCliProcess();
}
