import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArguments, type ParsedCliCommand } from "./args";
import { sendCliRequest, type CliClientOptions } from "./client";
import { cliErrorLine, DohcCliError } from "./errors";
import { renderCliHelp } from "./help";
import {
  CLI_JSON_SCHEMA_VERSION,
  CLI_PROTOCOL_VERSION,
  documentEditTextSchema,
  parseCliResult,
  type CliRequestWithoutToken,
  type CliResultByVerb,
} from "./protocol";
import { renderCliResult } from "./render";
import { readPassword, readStdinText } from "./stdin";
import {
  CHAT_MESSAGE_TOO_LONG,
  MAX_CHAT_MESSAGE_BODY_BYTES,
  normalizeChatMessageBody,
} from "@dohc/workspace-contracts/chat-message-body";

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
  readPassword?: () => Promise<string>;
  request?: (request: CliRequestWithoutToken) => Promise<unknown>;
  client?: CliClientOptions;
}

async function bodyForCommand(
  command: ParsedCliCommand,
  readStdin: () => Promise<string>,
): Promise<string | undefined> {
  if (command.verb === "documentEdit" || command.verb === "documentCreate") {
    const text = command.stdin ? await readStdin() : command.text;
    if (!documentEditTextSchema.safeParse(text).success) throw new DohcCliError("document text is at most 256 KiB as UTF-8");
    return text;
  }
  if (command.verb === "fileChatStart") {
    const body = command.stdin ? await readStdin() : command.body;
    // The desktop applies the same check; refusing here saves the request.
    try {
      normalizeChatMessageBody(body);
    } catch (error) {
      throw new DohcCliError(error instanceof Error ? error.message : String(error));
    }
    return body;
  }
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
  password?: string,
): CliRequestWithoutToken {
  const common = {
    protocolVersion: CLI_PROTOCOL_VERSION,
    cwd: resolve(cwdInput),
    actor: command.actor,
  } as const;
  switch (command.verb) {
    case "linksEdges":
      return { protocolVersion: common.protocolVersion, verb: command.verb, args: { cwd: common.cwd, actor: common.actor, cursor: command.cursor } };
    case "chatLinks":
      return {protocolVersion:common.protocolVersion,verb:command.verb,args:{cwd:common.cwd,actor:common.actor,group:command.group,cursor:command.cursor}};
    case "chatFileMentions":
      return { protocolVersion: common.protocolVersion, verb: command.verb, args: { cwd: common.cwd, actor: common.actor, subject: command.subject, cursor: command.cursor } };
    case "linksIn":
      return { protocolVersion: common.protocolVersion, verb: command.verb, args: { cwd: common.cwd, actor: common.actor, subject: command.subject, cursor: command.cursor } };
    case "linksResolve":
      return { protocolVersion: common.protocolVersion, verb: command.verb, args: { cwd: common.cwd, actor: common.actor, source: command.source, literals: command.literals } };
    case "historyOperation":
      return { protocolVersion: common.protocolVersion, verb: command.verb, args: { cwd: common.cwd, actor: common.actor, operationId: command.operationId, ...(command.cursor ? { cursor: command.cursor } : {}) } };
    case "fileDuplicate":
      return {protocolVersion: common.protocolVersion, verb: command.verb, args: {cwd: common.cwd, actor: common.actor, path: command.path, requestId: command.requestId ?? randomUUID(), agent: command.agent}};
    case "historyUndo":
      return { protocolVersion: common.protocolVersion, verb: command.verb, args: { cwd: common.cwd, actor: common.actor, operationId: command.operationId } };
    case "stopSync":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor, ...(command.agent ? { agent: command.agent } : {}) } };
    case "shareCopy":
      return { protocolVersion: common.protocolVersion, verb: command.verb, args: { cwd: common.cwd, actor: common.actor, shareId: command.shareId, grantId: command.grantId } };
    case "accountDeletePreview":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor } };
    case "accountDelete":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: {
        cwd: common.cwd, actor: common.actor, server: command.server, previewToken: command.previewToken, password: password ?? "",
      } };
    case "accessRefresh":
      return { protocolVersion: common.protocolVersion, verb: command.verb, args: { cwd: common.cwd, actor: common.actor } };
    case "accessObject":
      return { protocolVersion: common.protocolVersion, verb: command.verb, args: { cwd: common.cwd, actor: common.actor, ref: command.ref, cursor: command.cursor } };
    case "accessSharing":
      return { protocolVersion: common.protocolVersion, verb: command.verb, args: { cwd: common.cwd, actor: common.actor, lane: command.lane, cursor: command.cursor } };
    case "fileChats":
    case "documentRead":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor, path: command.path } };
    case "saveRecoveryCopy":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor, path: command.path,
        ...(command.incident === undefined ? {} : { incident: command.incident }) } };
    case "liveKeptEdits":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor } };
    case "retryKeptEdits":
    case "stopAgain":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor, path: command.path, incident: command.incident } };
    case "documentEdit":
    case "documentCreate": {
      const args = {
        cwd: common.cwd, actor: common.actor, path: command.path,
        ...(command.agent === undefined ? {} : { agent: command.agent }),
      };
      return command.verb === "documentCreate"
        ? { verb: command.verb, protocolVersion: common.protocolVersion, args: { ...args, markdown: stdinBody ?? command.text } }
        : { verb: command.verb, protocolVersion: common.protocolVersion, args: {
            ...args, replacement: stdinBody ?? command.text,
            ...(command.find === undefined ? {} : { find: command.find }),
            ...(command.requestId === undefined ? {} : { requestId: command.requestId }),
          } };
    }
    case "fileChatStart":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: {
        cwd: common.cwd, actor: common.actor, path: command.path, title: command.title,
        body: stdinBody ?? command.body,
        ...(command.agent === undefined ? {} : { agent: command.agent }),
        ...(command.requestId === undefined ? {} : { requestId: command.requestId }),
        ...((command.runId ?? runId) ? { runId: command.runId ?? runId } : {}),
      } };
    case "dataset":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor, request: command.request } };
    case "appPublication":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor, request: command.request } };
    case "ownerAppResponses":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor, request: command.request } };
    case "groups":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: { cwd: common.cwd, actor: common.actor },
      };
    case "threads":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: { cwd: common.cwd, actor: common.actor, group: command.group },
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
        args: {
          cwd: common.cwd,
          actor: common.actor,
          target: command.target,
          peek: command.peek,
          ...(command.before ? { before: command.before } : {}),
          ...(command.limit ? { limit: command.limit } : {}),
        },
      };
    case "post":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: {
          cwd: common.cwd,
          actor: common.actor,
          ...(runId ? { runId } : {}),
          group: command.group,
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
          ...(command.group ? { group: command.group } : {}),
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
    case "moments":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: {
          cwd: common.cwd,
          actor: common.actor,
          limit: command.limit,
          ...(command.path ? { path: command.path } : {}),
        },
      };
    case "moment":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: { cwd: common.cwd, actor: common.actor, id: command.id },
      };
    case "automationRuns":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: {
          cwd: common.cwd, actor: common.actor, collectionPath: command.collectionPath, automation: command.automation,
          ...(command.page === undefined ? {} : { page: command.page }),
          ...(command.server ? { server: true } : {}),
        },
      };
    case "automationList":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor, collectionPath: command.collectionPath } };
    case "automationSwitch":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: { cwd: common.cwd, actor: common.actor,
        collectionPath: command.collectionPath, automation: command.automation, enabled: command.enabled,
        expectedContentHash: command.expectedContentHash, reformat: command.reformat, submitId: command.submitId } };
    case "automationRun":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: {
          cwd: common.cwd,
          actor: common.actor,
          collectionPath: command.collectionPath,
          automation: command.automation,
          run: command.run,
          ...(command.server ? { server: true } : {}),
        },
      };
    case "automationRetry":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: {
          cwd: common.cwd,
          actor: common.actor,
          collectionPath: command.collectionPath,
          automation: command.automation,
          run: command.run,
          startOver: command.startOver,
        },
      };
    case "automationButtons":
      return { verb: command.verb, protocolVersion: common.protocolVersion, args: {
        cwd: common.cwd, actor: common.actor, collectionPath: command.collectionPath, ...(command.table ? { table: command.table } : {}),
      } };
    case "automationPress":
      return {
        verb: command.verb,
        protocolVersion: common.protocolVersion,
        args: {
          cwd: common.cwd,
          actor: common.actor,
          collectionPath: command.collectionPath,
          field: command.field,
          record: command.record,
          ...(command.table ? { table: command.table } : {}),
          confirm: command.confirm,
          ...(command.requestId ? { requestId: command.requestId } : {}),
        },
      };
  }
}

// A verb that could not do what was asked exits with its reason. A refused
// Try again for another computer's run adds the notice that names it.
function refusal(result: CliResultByVerb[keyof CliResultByVerb]): string | null {
  if (result === null || !("ok" in result) || result.ok !== false) return null;
  return "notice" in result && result.notice
    ? `${result.reason} ${result.notice.title}: ${result.notice.body}`
    : result.reason;
}

const REFUSING_VERBS = new Set(["fileDuplicate", "historyOperation", "historyUndo", "accountDelete", "moments", "moment", "documentRead", "documentEdit", "documentCreate", "fileChats", "fileChatStart", "liveKeptEdits", "saveRecoveryCopy", "retryKeptEdits", "stopAgain", "automationRuns", "automationRun", "automationRetry", "automationButtons", "automationPress"]);

function jsonOutput(result: CliResultByVerb[keyof CliResultByVerb]): string {
  return JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, ...result }, null, 2);
}

export async function executeCli(options: CliExecutionOptions): Promise<CliExecutionResult> {
  try {
    const env = options.env ?? process.env;
    const command = parseCliArguments(options.argv, env);
    if ("help" in command) return { exitCode: 0, stdout: renderCliHelp(command), stderr: "" };
    const stdinBody = await bodyForCommand(command, options.readStdin ?? (() => readStdinText(process.stdin, command.verb === "fileChatStart" ? { bytes: MAX_CHAT_MESSAGE_BODY_BYTES, message: CHAT_MESSAGE_TOO_LONG } : undefined)));
    const password = command.verb === "accountDelete"
      ? await (options.readPassword ?? (() => readPassword(process.stdin, process.stderr)))()
      : undefined;
    if (password === "") throw new DohcCliError("account delete requires the server account password");
    const request = buildCliRequest(
      command,
      options.cwd ?? process.cwd(),
      stdinBody,
      env.DOHC_RUN_ID,
      password,
    );
    let result: CliResultByVerb[keyof CliResultByVerb];
    if (options.request) {
      const rawResult = await options.request(request);
      try {
        result = parseCliResult(command.verb, rawResult);
      } catch {
        throw new DohcCliError("desktop app returned an invalid response");
      }
    } else {
      result = await sendCliRequest<typeof command.verb>(request, {
        ...options.client,
        timeoutMs: options.client?.timeoutMs ?? (command.verb === "accountDelete" ? 120_000
          // The server may take 5 minutes to prepare an earlier store, and dohc waits up to 6.
          : command.verb === "saveRecoveryCopy" ? 420_000
          : command.verb === "historyUndo" || command.verb === "dataset" || command.verb === "appPublication" || command.verb === "ownerAppResponses" ? 90_000 : DEFAULT_RESPONSE_TIMEOUT_MS),
        env,
      });
    }
    const refused = REFUSING_VERBS.has(command.verb) ? refusal(result) : null;
    if (refused !== null) throw new DohcCliError(refused);
    const output = command.json
      ? result === null ? "null" : jsonOutput(result)
      : renderCliResult(command.verb, result, {
          grepFilesWithMatches: command.verb === "grep" ? command.filesWithMatches : false,
          grepContext: command.verb === "grep" ? command.context : 0,
          momentSide: command.verb === "moment" ? command.side : "after",
        });
    return {
      exitCode: result !== null && (("remaining" in result && result.remaining.length > 0) || ("kind" in result && result.kind === "partial") || ("disconnectError" in result && result.disconnectError !== null)) ? 1 : 0,
      // Markdown prints byte for byte so redirection preserves it.
      stdout: (command.verb === "moment" || command.verb === "documentRead") && !command.json
        ? output
        : output ? `${output.replace(/\n$/, "")}\n` : "",
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
