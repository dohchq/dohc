import { ChatFileMentionsInput } from "@dohc/workspace-contracts/chat-file-mentions";
import { LinksEdgesInput, type LinksEdgesInput as EdgesInput, LinksInInput, LinksResolveInput, type LinksInInput as InInput, type LinksResolveInput as ResolveInput } from "@dohc/workspace-contracts/links";
import type { CapabilityId } from "@dohc/workspace-contracts/capabilities";
import type { z } from "zod";
import { APP_PUBLICATION_CAPABILITIES, APP_RESPONSE_CAPABILITIES, documentAgentNameSchema, documentEditTextSchema, requestIdSchema, chatLinksGroupInputSchema, type CliActor } from "./protocol";
import { DohcCliError } from "./errors";
import { OwnerAppPublicationRequest } from "./appPublication";
import { OwnerAppResponsesRequest } from "./appResponses";
import { DATASET_CAPABILITIES, DatasetRequest, DatasetSchemaChange } from "./dataset";
import { HistoryOperationId } from "@dohc/workspace-contracts/history-operation";
import { AccessObjectRef } from "@dohc/workspace-contracts/access";

interface ParsedCliBase {
  actor: CliActor;
  json: boolean;
}

type ExportScope =
  | { kind: "all" }
  | { kind: "group"; group: string }
  | { kind: "thread"; thread: string };

type CliCommandBody =
  | ({ verb: "chatLinks" } & z.infer<typeof chatLinksGroupInputSchema>)
  | ({ verb: "chatFileMentions" } & ChatFileMentionsInput)
  | ({ verb: "linksEdges" } & EdgesInput)
  | ({ verb: "linksIn" } & InInput)
  | ({ verb: "linksResolve" } & ResolveInput)
  | { verb: "stopSync"; agent?: string }
  | { verb: "shareCopy"; shareId: string; grantId: string }
  | { verb: "accountDeletePreview" }
  | { verb: "accountDelete"; server: string; previewToken: string }
  | { verb: "accessObject"; ref: AccessObjectRef; cursor?: string }
  | { verb: "accessRefresh" }
  | { verb: "accessSharing"; lane: "granted" | "received"; cursor?: string }
  | { verb: "documentRead" | "fileChats"; path: string }
  | { verb: "saveRecoveryCopy"; path: string; incident?: string }
  | { verb: "liveKeptEdits" }
  | { verb: "retryKeptEdits" | "stopAgain"; path: string; incident: string }
  | { verb: "fileChatStart"; path: string; title: string; body: string; stdin: boolean; agent?: string; requestId?: string; runId?: string }
  | { verb: "documentEdit" | "documentCreate"; path: string; text: string; stdin: boolean; find?: string; agent?: string; requestId?: string }
  | { verb: "dataset"; request: DatasetRequest }
  | { verb: "appPublication"; request: OwnerAppPublicationRequest }
  | { verb: "ownerAppResponses"; request: OwnerAppResponsesRequest }
  | { verb: "groups" }
  | { verb: "threads"; group: string }
  | { verb: "inbox" }
  | { verb: "show"; target: string; peek: boolean }
  | {
      verb: "post";
      group: string;
      title?: string;
      attachments: string[];
      needsDecision: boolean;
      options?: string[];
      body: string;
    }
  | {
      verb: "reply";
      thread: string;
      to?: string;
      attachments: string[];
      needsDecision: boolean;
      options?: string[];
      resolve?: string;
      choose?: string;
      body: string;
    }
  | { verb: "react"; message: string; emoji: string }
  | {
      verb: "grep";
      pattern: string;
      group?: string;
      thread?: string;
      from?: string;
      since?: string;
      ignoreCase: boolean;
      filesWithMatches: boolean;
      context: number;
      limit: number;
      regex: boolean;
    }
  | { verb: "export"; scope: ExportScope; outDir: string }
  | { verb: "moments"; path?: string; limit: number }
  | { verb: "historyOperation"; operationId: string; cursor?: string }
  | { verb: "historyUndo"; operationId: string }
  | { verb: "fileDuplicate"; path: string; agent?: string; requestId?: string }
  | { verb: "moment"; id: string; side: "before" | "after" }
  | { verb: "automationRuns"; collectionPath: string; automation: string; page?: string; server?: true }
  | { verb: "automationList"; collectionPath: string }
  | { verb: "automationSwitch"; collectionPath: string; automation: string; enabled: boolean; expectedContentHash: string; reformat: boolean; submitId: string }
  | { verb: "automationRun"; collectionPath: string; automation: string; run: string; server?: true }
  | { verb: "automationRetry"; collectionPath: string; automation: string; run: string; startOver: boolean }
  | { verb: "automationButtons"; collectionPath: string; table?: string }
  | {
      verb: "automationPress";
      collectionPath: string;
      field: string;
      record: string;
      table?: string;
      confirm: string[];
      requestId?: string;
    };

export type ParsedCliCommand = ParsedCliBase & CliCommandBody;

/** Names the command and verb whose help was asked for, both already known to exist. */
export interface CliHelpRequest {
  help: readonly [] | readonly [command: string] | readonly [command: string, verb: string];
}

export interface CliFlag {
  name: string;
  /** Placeholder for the flag's value. A flag without one is a switch. */
  value?: string;
  text: string;
}

interface VerbInput {
  operands: readonly string[];
  flags: ReadonlyMap<string, readonly string[]>;
}

export interface CliVerbSpec {
  capabilityId: CapabilityId;
  summary: string;
  operands: string;
  flags?: readonly CliFlag[];
  notes?: readonly string[];
  /** The JSON request's fields, for verbs that take one JSON object. */
  fields?: Readonly<Record<string, z.ZodType>>;
  /** Fields the CLI requires even though the request schema leaves them optional. */
  required?: readonly string[];
  /** The verb takes text that can start with a dash, so help and errors explain --. */
  freeText?: boolean;
  /** Request fields copied from an earlier verb's result. */
  take?: readonly CliFieldSource[];
  /** A stray argument can be a secret, so refusing one never repeats it. */
  strayRefusal?: string;
  parse(input: VerbInput): CliCommandBody;
}

/** Names the result field of an earlier verb that a request field copies. */
interface CliFieldSource {
  field: string;
  from: string;
  path: string;
}

export interface CliCommandSpec {
  summary: string;
  notes: readonly string[];
  verbs: Readonly<Record<string, CliVerbSpec>>;
}

function fail(message: string): never {
  throw new DohcCliError(message);
}

function lookup<T>(table: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
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

function noExtraArgs(tokens: readonly string[], verb: string): void {
  if (tokens.length > 0) fail(`${verb} does not accept '${tokens[0]}'`);
}

function lastValue(input: VerbInput, flag: string): string | undefined {
  return input.flags.get(flag)?.at(-1);
}

function allValues(input: VerbInput, flag: string): string[] {
  return [...(input.flags.get(flag) ?? [])];
}

/** Splits a verb's tokens into operands and the flags the verb declares. */
function readVerbInput(name: string, verb: CliVerbSpec, tokens: readonly string[]): VerbInput {
  const flags = verb.flags ?? [];
  const operands: string[] = [];
  const values = new Map<string, string[]>();
  let optionsEnded = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const flag = optionsEnded ? undefined : flags.find((candidate) => candidate.name === token);
    if (flag) {
      const value = flag.value ? takeValue(tokens, index, token) : "";
      if (flag.value) index += 1;
      values.set(token, [...(values.get(token) ?? []), value]);
    } else if (!optionsEnded && token === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && token.startsWith("--")) {
      fail(verb.strayRefusal ?? `unknown ${name} option '${token}'${verb.freeText ? `; put ${DASH_RULE}` : ""}`);
    } else {
      operands.push(token);
    }
  }
  return { operands, flags: values };
}

const attachFlag: CliFlag = {
  name: "--attach",
  value: "path",
  text: "Attach a workspace file. Repeat for more files.",
};
const decisionFlags: readonly CliFlag[] = [
  { name: "--needs-decision", text: "Ask readers for a decision." },
  {
    name: "--option",
    value: "choice",
    text: "Offer a choice. Repeat for more choices. Implies --needs-decision.",
  },
];
export const DASH_RULE = "options first, then --, then text that starts with a dash";
const stdinNote = "Use - as the body to read it from stdin.";

const documentTextFlags: readonly CliFlag[] = [
  { name: "--text", value: "markdown", text: "Use this Markdown as the body. An empty string is allowed." },
  { name: "--agent", value: "name", text: "Record this agent name with the change." },
];

function parsePath({ operands }: VerbInput, name: string): string {
  const [path, ...extra] = operands;
  if (!path) fail(`${name} requires a path`);
  noExtraArgs(extra, name);
  return path;
}

function documentWrite(input: VerbInput, verb: "documentEdit" | "documentCreate"): CliCommandBody {
  const [path, body, ...extra] = input.operands;
  if (!path) fail("document requires a path");
  noExtraArgs(extra, "document");
  const text = lastValue(input, "--text");
  if (body !== undefined && (body !== "-" || text !== undefined)) fail("use either - for stdin or --text <markdown>");
  if (verb === "documentEdit" && body === undefined && text === undefined) fail("document edit requires - for stdin or --text <markdown>");
  const find = lastValue(input, "--find");
  const agent = lastValue(input, "--agent");
  const requestId = lastValue(input, "--request-id");
  if (find !== undefined && !documentEditTextSchema.min(1).safeParse(find).success) fail("--find requires non-empty Markdown of at most 256 KiB");
  if (agent !== undefined && !documentAgentNameSchema.safeParse(agent).success) fail("invalid --agent name; use 1 to 64 letters, numbers, spaces, dots, underscores, or hyphens, starting with a letter or number");
  if (requestId !== undefined && !requestIdSchema.safeParse(requestId).success) fail("--request-id requires 1 to 64 printable ASCII characters");
  return { verb, path, text: text ?? "", stdin: body === "-",
    ...(find === undefined ? {} : { find }), ...(agent === undefined ? {} : { agent }),
    ...(requestId === undefined ? {} : { requestId }) };
}

const DOCUMENT_VERBS = {
  read: {
    capabilityId: "document.read",
    summary: "Read the current Markdown, including edits in an open editor.",
    operands: "<path>",
    notes: ["Read before editing. Without --json, prints the Markdown byte for byte."],
    parse: input => ({ verb: "documentRead", path: parsePath(input, "document read") }),
  },
  edit: {
    capabilityId: "document.edit",
    summary: "Replace matching text or append Markdown through the live document.",
    operands: "<path> [-]",
    flags: [...documentTextFlags,
      { name: "--find", value: "markdown", text: "Replace this exact, unique match. Omit to append." },
      { name: "--request-id", value: "key", text: "Reuse this key when retrying the same edit, as with dohc_edit_document." },
    ],
    notes: [stdinNote, "Use --text instead to supply the body as an argument. Each side allows at most 256 KiB of UTF-8.",
      "Edits change the body, not frontmatter. Concurrent editing can prevent removing blocks or changing their kind.",
      "Read again after a warning or an unexplained failure. Retry keys have the same limits as dohc_edit_document."],
    parse: (input) => documentWrite(input, "documentEdit"),
  },
  create: {
    capabilityId: "document.create",
    summary: "Create a Markdown document without overwriting an existing file.",
    operands: "<path> [-]",
    flags: documentTextFlags,
    notes: [stdinNote, "Use --text instead to supply Markdown. With neither, create an empty document.",
      "The path must end in .md or .markdown. Frontmatter is refused."],
    parse: (input) => documentWrite(input, "documentCreate"),
  },
  chats: {
    capabilityId: "file.chats.list",
    summary: "List chats linked to a workspace file.",
    operands: "<path>",
    notes: ["Chats follow the file across renames.", "Use chat show --peek with a thread ID to read it without marking it read."],
    parse: input => ({ verb: "fileChats", path: parsePath(input, "document chats") }),
  },
  comment: {
    capabilityId: "file.chat.start",
    summary: "Start a chat linked to a file with its first message.",
    operands: "<path> [-]",
    flags: [
      { name: "--title", value: "title", text: "Set the chat title. Use 1 to 200 characters that are not all whitespace." },
      { name: "--text", value: "markdown", text: "Set the first message as Markdown. The message must contain text that is not all whitespace." },
      { name: "--agent", value: "name", text: "Record this agent name with the change." },
      { name: "--request-id", value: "key", text: "Set a key for safe retries. Use 1 to 64 printable ASCII characters. A retry with the same key and the same payload returns the existing result. A retry with the same key and a changed payload is refused." },
      { name: "--run-id", value: "id", text: "Set the run ID. The value must not be empty. This flag overrides DOHC_RUN_ID." },
    ],
    notes: [stdinNote, "The first message allows at most 64 KiB of UTF-8."],
    parse: (input) => {
      const [path, body, ...extra] = input.operands;
      if (!path) fail("document requires a path");
      noExtraArgs(extra, "document comment");
      const title = lastValue(input, "--title");
      if (title === undefined) fail("comment requires --title");
      if (!title.trim() || title.length > 200) fail("invalid --title; use 1 to 200 characters that are not all whitespace");
      const text = lastValue(input, "--text");
      if (body !== undefined && (body !== "-" || text !== undefined)) fail("use either - for stdin or --text <markdown>");
      if (body === undefined && text === undefined) fail("use either - for stdin or --text <markdown>");
      const agent = lastValue(input, "--agent");
      const requestId = lastValue(input, "--request-id");
      const runId = lastValue(input, "--run-id");
      if (agent !== undefined && !documentAgentNameSchema.safeParse(agent).success) fail("invalid --agent name; use 1 to 64 letters, numbers, spaces, dots, underscores, or hyphens, starting with a letter or number");
      if (requestId !== undefined && !requestIdSchema.safeParse(requestId).success) fail("--request-id requires 1 to 64 printable ASCII characters");
      if (runId !== undefined && !runId) fail("--run-id requires a value that is not empty");
      return { verb: "fileChatStart", path, title, body: text ?? "", stdin: body === "-",
        ...(agent === undefined ? {} : { agent }), ...(requestId === undefined ? {} : { requestId }),
        ...(runId === undefined ? {} : { runId }) };
    },
  },
  "kept-edits": {
    capabilityId: "workspace.status",
    summary: "List live documents whose edits the server refused, and where dohc keeps those edits.",
    operands: "",
    notes: ["storedOn is this-computer, or server for a document the server hosts.",
      "A recovery of paused means the edits wait for you. Save a recovery copy, or try again. A new refusal changes the incident.",
      "When saveOnly is true, save a recovery copy instead. If recovery is unreadable, retry reads the edits again.",
      "A recovery of not-written or stopping means a Stop kept the edits. Run stop-again to finish it.",
      "A recovery of cannot-write means only a recovery copy can return the edits. Copied means a recovery copy of edits the server keeps is saved.",
      "If the server accepts a later edit to the document, copied returns to paused. Save another recovery copy to include that edit.",
      "A recovery of unreadable means dohc could not read the edits it keeps on this computer, and reason says why. Run retry-kept-edits to read them again.",
      "earlier is true when the server keeps the edits in an earlier copy of the workspace. Save a recovery copy to get them back; try again cannot reach them."],
    parse: input => {
      noExtraArgs(input.operands, "document kept-edits");
      return { verb: "liveKeptEdits" };
    },
  },
  "save-recovery-copy": {
    capabilityId: "share.live.document.recovery.save",
    summary: "Save a document's kept edits next to it.",
    operands: "<path> [<incident>]",
    notes: ["Accepts every recovery but unreadable.",
      "With an incident from kept-edits, dohc saves exactly those kept edits. Without one, it saves edits a Stop could not write first.",
      "dohc writes a recovery package with every kept edit, and a readable copy when it can read the edits as a document.",
      "For edits the server keeps, dohc then tells the server the copy is saved, and the recovery becomes copied.",
      "keptEdits is kept when the edits stay where storedOn says, and copied when the server may now release them.",
      "It is ended for edits a Stop could not write: dohc no longer keeps them, and the copy holds them.",
      "dohc writes these files itself, not as the agent that asked."],
    parse: input => {
      const [path, incident, ...extra] = input.operands;
      if (!path) fail("document save-recovery-copy requires a path");
      noExtraArgs(extra, "document save-recovery-copy");
      return { verb: "saveRecoveryCopy", path, ...(incident ? { incident } : {}) };
    },
  },
  "retry-kept-edits": {
    capabilityId: "share.live.document.retry",
    summary: "Send a document's kept edits to the server once more.",
    operands: "<path> <incident>",
    notes: ["Take the incident from kept-edits. Accepts a recovery of paused, or copied for edits the server keeps.",
      "For unreadable, dohc reads the kept edits again. It fails with the reason while it still cannot read them.",
      "A not-written or stopping document needs stop-again instead.",
      "Run kept-edits again to follow it: retrying until the server answers, paused with a new incident if it refuses again."],
    parse: input => {
      const [path, incident, ...extra] = input.operands;
      if (!path || !incident) fail("retry-kept-edits requires a path and an incident");
      noExtraArgs(extra, "document retry-kept-edits");
      return { verb: "retryKeptEdits", path, incident };
    },
  },
  "stop-again": {
    capabilityId: "share.live.document.stop",
    summary: "Stop live editing again for a document whose Stop kept its edits.",
    operands: "<path> <incident>",
    notes: ["Take the incident from kept-edits. Accepts a recovery of not-written or stopping.",
      "For not-written, dohc writes the kept edits into the file. For stopping, it asks the server again to stop live editing.",
      "keptEdits is recovered once the file holds the edits, kept while dohc still keeps them, and none when it kept none.",
      "dohc refuses while the document is open in an editor. Run kept-edits again to follow it."],
    parse: input => {
      const [path, incident, ...extra] = input.operands;
      if (!path || !incident) fail("stop-again requires a path and an incident");
      noExtraArgs(extra, "document stop-again");
      return { verb: "stopAgain", path, incident };
    },
  },
} satisfies Record<string, CliVerbSpec>;

function decisionFields(input: VerbInput): { needsDecision: boolean; options?: string[] } {
  const options = allValues(input, "--option");
  return {
    needsDecision: input.flags.has("--needs-decision") || options.length > 0,
    ...(options.length > 0 ? { options } : {}),
  };
}

const CHAT_VERBS = {
  groups: {
    capabilityId: "group.list",
    summary: "List the Groups in this workspace.",
    operands: "",
    parse: ({ operands }) => {
      noExtraArgs(operands, "groups");
      return { verb: "groups" };
    },
  },
  threads: {
    capabilityId: "chat.threads.list",
    summary: "List the threads in a Group.",
    operands: "<group>",
    parse: ({ operands }) => {
      const [group, ...extra] = operands;
      if (!group) fail("threads requires a group");
      noExtraArgs(extra, "threads");
      return { verb: "threads", group };
    },
  },
  inbox: {
    capabilityId: "chat.inbox.read",
    summary: "List unread threads. For an agent, also list its unread mentions.",
    operands: "",
    parse: ({ operands }) => {
      noExtraArgs(operands, "inbox");
      return { verb: "inbox" };
    },
  },
  show: {
    capabilityId: "chat.show",
    summary: "Show a thread or message and mark the thread read.",
    operands: "<thread-or-message>",
    flags: [
      { name: "--peek", text: "Show it without changing what is marked read. A read-only shared view requires it." },
    ],
    parse: (input) => {
      const [target, ...extra] = input.operands;
      if (!target) fail("show requires a thread or message id");
      noExtraArgs(extra, "show");
      return { verb: "show", target, peek: input.flags.has("--peek") };
    },
  },
  post: {
    capabilityId: "chat.post",
    summary: "Start a thread in a Group.",
    operands: "<group> <body>",
    flags: [{ name: "--title", value: "title", text: "Set the thread's title." }, attachFlag, ...decisionFlags],
    freeText: true,
    notes: [stdinNote, "In a direct message, use reply instead."],
    parse: (input) => {
      const [group, ...bodyParts] = input.operands;
      if (!group) fail("post requires a group");
      const body = bodyParts.join(" ");
      if (!body) fail("post requires a body or '-' for stdin");
      const title = lastValue(input, "--title");
      return {
        verb: "post",
        group,
        ...(title ? { title } : {}),
        attachments: allValues(input, "--attach"),
        ...decisionFields(input),
        body,
      };
    },
  },
  reply: {
    capabilityId: "chat.reply",
    summary: "Reply in a thread.",
    operands: "<thread> <body>",
    flags: [
      { name: "--to", value: "message", text: "Reply to this message in the thread." },
      attachFlag,
      ...decisionFlags,
      { name: "--resolve", value: "message", text: "Resolve this open decision with the reply." },
      { name: "--choose", value: "choice", text: "Pick this choice of the decision. Needs --resolve." },
    ],
    freeText: true,
    notes: [stdinNote],
    parse: (input) => {
      const [thread, ...bodyParts] = input.operands;
      if (!thread) fail("reply requires a thread id");
      const body = bodyParts.join(" ");
      if (!body) fail("reply requires a body or '-' for stdin");
      const to = lastValue(input, "--to");
      const resolve = lastValue(input, "--resolve");
      const choose = lastValue(input, "--choose");
      if (choose && !resolve) fail("--choose needs --resolve <message>");
      return {
        verb: "reply",
        thread,
        ...(to ? { to } : {}),
        attachments: allValues(input, "--attach"),
        ...decisionFields(input),
        ...(resolve ? { resolve } : {}),
        ...(choose ? { choose } : {}),
        body,
      };
    },
  },
  react: {
    capabilityId: "chat.react",
    summary: "Add your reaction to a message, or remove it if it is already there.",
    operands: "<message> <emoji>",
    parse: ({ operands }) => {
      const [message, emoji, ...extra] = operands;
      if (!message || !emoji) fail("react requires a message id and emoji");
      noExtraArgs(extra, "react");
      return { verb: "react", message, emoji };
    },
  },
  grep: {
    capabilityId: "chat.search",
    summary: "Search message text and thread titles.",
    operands: "<pattern>",
    flags: [
      { name: "--group", value: "group", text: "Search only this Group." },
      { name: "--thread", value: "thread", text: "Search only this thread." },
      { name: "--from", value: "author", text: "Match authors: human, agent, or part of a name." },
      { name: "--since", value: "when", text: "Match messages newer than a date or an age such as 7d." },
      { name: "-i", text: "Ignore case. Without it, a regex or a pattern with capitals matches case." },
      { name: "-l", text: "Print only the IDs of threads that match." },
      { name: "-C", value: "count", text: "Show this many messages before and after each match." },
      { name: "--limit", value: "count", text: "Print at most this many results. The default is 100." },
      { name: "--regex", text: "Read the pattern as a regular expression." },
    ],
    freeText: true,
    parse: (input) => {
      const [pattern, ...extra] = input.operands;
      if (!pattern) fail("grep requires a pattern");
      if (extra.length > 0) fail(`grep does not accept '${extra[0]}' after the pattern`);
      const group = lastValue(input, "--group");
      const thread = lastValue(input, "--thread");
      const from = lastValue(input, "--from");
      const since = lastValue(input, "--since");
      const context = lastValue(input, "-C");
      const limit = lastValue(input, "--limit");
      return {
        verb: "grep",
        pattern,
        ...(group ? { group } : {}),
        ...(thread ? { thread } : {}),
        ...(from ? { from } : {}),
        ...(since ? { since } : {}),
        ignoreCase: input.flags.has("-i"),
        filesWithMatches: input.flags.has("-l"),
        context: context === undefined ? 0 : integerFlag(context, "-C", { allowZero: true }),
        limit: limit === undefined ? 100 : integerFlag(limit, "--limit", { allowZero: false }),
        regex: input.flags.has("--regex"),
      };
    },
  },
  export: {
    capabilityId: "chat.export",
    summary: "Save threads as Markdown files, one file per thread.",
    operands: "",
    flags: [
      { name: "--out", value: "folder", text: "Write the files to this folder. Required." },
      { name: "--all", text: "Export every thread. This is the default." },
      { name: "--group", value: "group", text: "Export the threads in one Group." },
      { name: "--thread", value: "thread", text: "Export one thread." },
    ],
    notes: ["Use at most one of --all, --group, or --thread."],
    parse: (input) => {
      noExtraArgs(input.operands, "export");
      const scopes: ExportScope[] = [
        ...allValues(input, "--all").map((): ExportScope => ({ kind: "all" })),
        ...allValues(input, "--group").map((group): ExportScope => ({ kind: "group", group })),
        ...allValues(input, "--thread").map((thread): ExportScope => ({ kind: "thread", thread })),
      ];
      if (scopes.length > 1) fail("export accepts only one of --all, --group, or --thread");
      const outDir = lastValue(input, "--out");
      if (!outDir) fail("export requires --out <dir>");
      return { verb: "export", scope: scopes[0] ?? { kind: "all" }, outDir };
    },
  },
} satisfies Record<string, CliVerbSpec>;

const operationId = (value: string | undefined) => {
  if (!HistoryOperationId.safeParse(value).success) fail("Use an operation id from history list: dohc-operation: followed by a UUID.");
  return value!;
};
const HISTORY_VERBS = {
  operation: {
    capabilityId: "history.operation.read", summary: "List the paths changed by one operation.", operands: "<operation>",
    flags: [{ name: "--cursor", value: "cursor", text: "Continue from the cursor on the previous operation page." }],
    parse: input => {
      const [id, ...extra] = input.operands; noExtraArgs(extra, "history operation");
      return { verb: "historyOperation", operationId: operationId(id), cursor: lastValue(input, "--cursor") };
    },
  },
  undo: {
    capabilityId: "history.operation.undo", summary: "Undo a delete, move, or rename recorded in History.", operands: "<operation>",
    parse: input => {
      const [id, ...extra] = input.operands; noExtraArgs(extra, "history undo");
      return { verb: "historyUndo", operationId: operationId(id) };
    },
  },
  list: {
    capabilityId: "history.list",
    summary: "List changes to files, newest first.",
    operands: "[<path>]",
    flags: [
      { name: "--limit", value: "count", text: "List at most this many changes. The default is 50, the most 500." },
    ],
    notes: ["With a path, list that file's own changes, across its renames. Each line starts with the change's ID."],
    parse: (input) => {
      const [path, ...extra] = input.operands;
      noExtraArgs(extra, "history list");
      const limit = lastValue(input, "--limit");
      const count = limit === undefined ? 50 : integerFlag(limit, "--limit", { allowZero: false });
      if (count > 500) fail("--limit accepts at most 500");
      return { verb: "moments", ...(path ? { path } : {}), limit: count };
    },
  },
  show: {
    capabilityId: "history.read",
    summary: "Print a file's text as one change left it.",
    operands: "<change>",
    flags: [{ name: "--before", text: "Print the text from before the change instead." }],
    notes: ["Find the change's ID with history list. With --json, print both sides and the change's details."],
    parse: (input) => {
      const [id, ...extra] = input.operands;
      if (!id) fail("history show requires a change id");
      noExtraArgs(extra, "history show");
      return { verb: "moment", id, side: input.flags.has("--before") ? "before" : "after" };
    },
  },
} satisfies Record<string, CliVerbSpec>;

/** The Collection and automation every automation verb starts with, and one run when the verb takes one. */
function automationOperands(input: VerbInput, verb: string, takesRun: boolean): { collectionPath: string; automation: string; run: string } {
  const [collectionPath, automation, run = "", ...extra] = input.operands;
  if (!collectionPath || !automation) fail(`automation ${verb} requires a Collection and an automation id`);
  if (takesRun && !run) fail(`automation ${verb} requires a run id`);
  noExtraArgs(takesRun ? extra : input.operands.slice(2), `automation ${verb}`);
  return { collectionPath, automation, run };
}

const AUTOMATION_VERBS = {
  list: {
    capabilityId: "automation.list",
    summary: "Read a Collection's automation definitions and on/off file state.", operands: "<collection>",
    parse: input => {
      const [collectionPath, ...extra] = input.operands;
      if (!collectionPath) fail("automation list requires a Collection");
      noExtraArgs(extra, "automation list");
      return { verb: "automationList", collectionPath };
    },
  },
  switch: {
    capabilityId: "automation.switch",
    summary: "Switch one automation on or off in its file.", operands: "<collection> <automation> <on|off>",
    flags: [
      { name: "--base", value: "hash", text: "Use the contentHash returned by automation list." },
      { name: "--submit-id", value: "id", text: "Identify this switch. After an unknown save, read definitions and sync state before retrying." },
      { name: "--reformat", text: "Confirm losing comments and hand formatting in automations.yaml." },
    ],
    parse: input => {
      const [collectionPath, automation, state, ...extra] = input.operands;
      if (!collectionPath || !automation || (state !== "on" && state !== "off")) fail("automation switch requires a Collection, automation id, and on or off");
      noExtraArgs(extra, "automation switch");
      const expectedContentHash = lastValue(input, "--base"), submitId = lastValue(input, "--submit-id");
      if (!expectedContentHash || !/^[a-f0-9]{64}$/u.test(expectedContentHash)) fail("--base requires the contentHash from automation list");
      if (!submitId || !requestIdSchema.safeParse(submitId).success) fail("--submit-id requires a printable id of at most 64 characters");
      return { verb: "automationSwitch", collectionPath, automation, enabled: state === "on", expectedContentHash, submitId, reformat: input.flags.has("--reformat") };
    },
  },
  buttons: {
    capabilityId: "automation.buttons.inspect",
    summary: "Inspect Button fields and the actions they require you to confirm.",
    operands: "<collection>",
    flags: [{ name: "--table", value: "table", text: "Inspect the buttons in this dataset table." }],
    parse: input => {
      const [collectionPath, ...extra] = input.operands;
      if (!collectionPath) fail("automation buttons requires a Collection");
      noExtraArgs(extra, "automation buttons");
      const table = lastValue(input, "--table");
      return { verb: "automationButtons", collectionPath, ...(table ? { table } : {}) };
    },
  },
  runs: {
    capabilityId: "automation.runs.list",
    summary: "List an automation's runs on this computer, newest first.",
    operands: "<collection> <automation>",
    flags: [
      { name: "--page", value: "page", text: "List the older runs the last line of an earlier listing names." },
      { name: "--server", text: "List the runs of the workspace's self-hosted server instead." },
    ],
    notes: [
      "Lists 20 runs at a time, newest first, as the Automations panel does. Each line starts with the run's ID.",
      "When older runs remain, the last line gives the --page value that lists them.",
    ],
    parse: (input) => {
      const { collectionPath, automation } = automationOperands(input, "runs", false);
      const page = lastValue(input, "--page");
      return { verb: "automationRuns", collectionPath, automation, ...(page === undefined ? {} : { page }), ...(input.flags.has("--server") ? { server: true as const } : {}) };
    },
  },
  run: {
    capabilityId: "automation.run.read",
    summary: "Show one run: what started it, what each step changed, and why it failed.",
    operands: "<collection> <automation> <run>",
    flags: [{ name: "--server", text: "Show a run of the workspace's self-hosted server. It lists what the run changed, without steps." }],
    notes: [
      "Steps count from 1 in the order automations.yaml lists them, including the steps inside if and otherwise. A step that changed nothing is not listed.",
    ],
    parse: (input) => {
      const { collectionPath, automation, run } = automationOperands(input, "run", true);
      return { verb: "automationRun", collectionPath, automation, run, ...(input.flags.has("--server") ? { server: true as const } : {}) };
    },
  },
  retry: {
    capabilityId: "automation.run.retry",
    summary: "Try a failed run again. It resumes after the last step that finished.",
    operands: "<collection> <automation> <run>",
    flags: [
      {
        name: "--start-over",
        text: "Run it from the first step when the automation changed since the run failed. This can repeat changes the run already made.",
      },
    ],
    notes: ["Only the computer that ran it can try a run again. Anywhere else, the command names that computer."],
    parse: (input) => {
      const { collectionPath, automation, run } = automationOperands(input, "retry", true);
      return { verb: "automationRetry", collectionPath, automation, run, startOver: input.flags.has("--start-over") };
    },
  },
  press: {
    capabilityId: "automation.button.press",
    summary: "Press a Button field on one record, as a person clicks it in dohc.",
    operands: "<collection> <button> <record>",
    flags: [
      { name: "--table", value: "table", text: "Name the table when the button is in more than one table of a dataset Collection." },
      {
        name: "--confirm",
        value: "action",
        text: "Run this action, which dohc cannot undo. The press names each action it would run. Repeat for more actions.",
      },
      { name: "--request-id", value: "id", text: "Send the same id again, after a timeout for example, to get the same press instead of a second one." },
    ],
    notes: [
      "Name the record by its id, or a dataset record by its primary key as JSON.",
      "The press prints the id of the run it started. Follow it with automation run.",
      "With --as-agent, the press is recorded as the agent's, for you. A press from an agent run that an automation started is the agent's too, and counts in that chain of automations, which stops after 4 steps.",
      "In a shared view, a press goes to the owner's computer, which runs it, as in dohc.",
    ],
    parse: (input) => {
      const [collectionPath, field, record, ...extra] = input.operands;
      if (!collectionPath || !field || !record) fail("automation press requires a Collection, a button, and a record");
      noExtraArgs(extra, "automation press");
      const table = lastValue(input, "--table");
      const requestId = lastValue(input, "--request-id");
      return {
        verb: "automationPress",
        collectionPath,
        field,
        record,
        ...(table ? { table } : {}),
        confirm: allValues(input, "--confirm"),
        ...(requestId ? { requestId } : {}),
      };
    },
  },
} satisfies Record<string, CliVerbSpec>;

const ACCOUNT_DELETE_STRAY =
  "account delete takes only --server and --preview-token; dohc reads the password from stdin or asks for it";

const ACCOUNT_VERBS = {
  deletePreview: {
    capabilityId: "account.delete.preview",
    summary: "List what deleting the connected server account removes.",
    operands: "",
    notes: ["The result holds the server and previewToken that delete needs. The token expires after five minutes."],
    parse: ({ operands }) => {
      noExtraArgs(operands, "account deletePreview");
      return { verb: "accountDeletePreview" };
    },
  },
  delete: {
    capabilityId: "account.delete",
    summary: "Delete the connected server account and the workspaces it owns on the server.",
    operands: "",
    flags: [
      { name: "--server", value: "address", text: "Use server from deletePreview. Required." },
      { name: "--preview-token", value: "token", text: "Use previewToken from deletePreview. Required." },
    ],
    notes: [
      "dohc reads the account password from stdin, or asks for it when stdin is a terminal. Never pass it as an argument.",
      "This cannot be undone. Copies on this computer stay. People you shared with lose access and keep their copies.",
      "If you create an account again later, the server will not accept your old copies of the deleted workspaces. Its backups keep the data until they expire.",
      "When the server cannot finish at once, the account stays blocked and the server finishes later. Either way, the dohc app disconnects from the server. If it cannot, delete exits 1 and says how to finish.",
      "If the preview expired or changed, run deletePreview again.",
    ],
    strayRefusal: ACCOUNT_DELETE_STRAY,
    parse: (input) => {
      if (input.operands.length > 0) fail(ACCOUNT_DELETE_STRAY);
      const server = lastValue(input, "--server");
      const previewToken = lastValue(input, "--preview-token");
      if (!server) fail("account delete requires --server <address> from deletePreview");
      if (!previewToken) fail("account delete requires --preview-token <token> from deletePreview");
      return { verb: "accountDelete", server, previewToken };
    },
  },
} satisfies Record<string, CliVerbSpec>;

interface JsonVerbHelp {
  summary: string;
  notes?: readonly string[];
  required?: readonly string[];
  take?: readonly CliFieldSource[];
}

function jsonVerb(
  capabilityId: CapabilityId,
  command: string,
  name: string,
  action: string,
  fields: Readonly<Record<string, z.ZodType>>,
  help: JsonVerbHelp,
  build: (value: object) => CliCommandBody,
): CliVerbSpec {
  const label = `${command} ${name}`;
  const invalid = `invalid ${label} arguments; run dohc ${label} --help`;
  return {
    capabilityId,
    ...help,
    operands: "'<JSON>'",
    fields,
    parse: ({ operands }) => {
      const [json, ...extra] = operands;
      if (!json) fail(`${label} requires one JSON object; run dohc ${label} --help`);
      noExtraArgs(extra, label);
      let value: unknown;
      try {
        value = JSON.parse(json);
      } catch {
        fail(invalid);
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} requires one JSON object`);
      if ("action" in value && value.action !== action && value.action !== name) {
        fail(`${label} arguments must not name another action`);
      }
      const missing = help.required?.find((field) => !(field in value));
      if (missing) fail(`${label} requires ${missing}`);
      try {
        return build({ ...value, action });
      } catch {
        fail(invalid);
      }
    },
  };
}

const workspaceNote =
  "Each verb takes one JSON object that names workspaceId. Find workspaceId in .dohc/manifest.json at the workspace root.";
const migrationApproval = "Review the result, then approve it with approveMigration.";
const agentLabelNote = "agentLabel is an optional label supplied by the agent. With --as-agent, and always through MCP, agentLabel is recorded as agent-declared. Without it, no agent identity is recorded. Automation runs cannot approve or publish.";

const DATASET_HELP: Record<DatasetRequest["action"], JsonVerbHelp> = {
  list: {
    summary: "List Collections.",
    notes: ["On a computer that doesn't keep the workspace's Collections, list returns the Collections on this computer's server. elsewhere names that server and the computer that keeps the others."],
  },
  describe: {
    summary: "Show a Collection's tables, fields, and operations.",
    notes: ["Use describe to find approved operation IDs."],
  },
  history: { summary: "List saved operations, with values to undo edits." },
  historyRevision: { summary: "Show the saved source of one past revision." },
  prepareHistoryRestore: {
    summary: "Prepare a change that reverses one saved change.",
    take: [
      { field: "targetRevisionSha256", from: "history", path: "entries[].schema.previousRevisionHash" },
      { field: "changedRevisionSha256", from: "history", path: "entries[].schema.revisionHash" },
    ],
    notes: [migrationApproval],
  },
  permissions: { summary: "List app bindings and explicit data grants." },
  setGrant: {
    summary: "Add or change an explicit data grant.",
    notes: ["grant names revision, revisionSha256, operationIds, and discover."],
  },
  removeGrant: {
    summary: "Remove an explicit data grant.",
    take: [{ field: "principalKey", from: "permissions", path: "permissions[].principal" }],
  },
  lifecycle: { summary: "Show a Collection's archive state and its apps." },
  archive: { summary: "Stop a Collection's operations and keep its records." },
  restore: { summary: "Restore an archived Collection under its rules." },
  deletePreview: {
    summary: "Review what deleting a Collection affects.",
    notes: ["The result lists affected apps and holds what delete needs."],
  },
  delete: {
    summary: "Permanently delete a Collection and all its data.",
    take: [
      { field: "expected", from: "deletePreview", path: "cursor" },
      { field: "reviewToken", from: "deletePreview", path: "reviewToken" },
    ],
    notes: [
      "This removes the Collection's private data and history.",
      "Set acknowledge to true.",
      "Export before deleting if you need a recovery copy. Deleted Collections cannot be restored in place.",
    ],
  },
  pendingAttempts: { summary: "List pending responses that still hold a retry." },
  reconcileAttempt: {
    summary: "Clear the retry of a saved pending response.",
    take: [{ field: "reference", from: "pendingAttempts", path: "entries[].reference" }],
    notes: ["Set acknowledge to true. This cannot be undone."],
  },
  cancelAttempt: {
    summary: "Cancel an unconfirmed pending response.",
    take: [{ field: "reference", from: "pendingAttempts", path: "entries[].reference" }],
    notes: ["Set acknowledge to true."],
  },
  export: {
    summary: "Save a private recovery archive of a Collection.",
    required: ["savePath"],
    notes: [
      "savePath is an absolute path outside the workspace ending in .dohc-recovery. Set overwrite to true to replace a file.",
      "Recovery archives contain private records, uploaded files, history, and retry credentials. Store them privately.",
    ],
  },
  prepareRecovery: {
    summary: "Check a recovery archive before restoring it.",
    required: ["sourcePath"],
    notes: ["sourcePath ends in .dohc-recovery. A relative sourcePath is read only and resolves from the caller folder. Review the result before claimRecovery."],
  },
  claimRecovery: {
    summary: "Restore a Collection from a prepared archive.",
    take: [
      { field: "workspaceId", from: "prepareRecovery", path: "recovery.sourceCursor.workspaceId" },
      { field: "transferId", from: "prepareRecovery", path: "recovery.transferId" },
      { field: "manifestSha256", from: "prepareRecovery", path: "recovery.manifestSha256" },
      { field: "sourceCursor", from: "prepareRecovery", path: "recovery.sourceCursor" },
    ],
    notes: ["Stop the old host first, then set oldHostStopped to true. Copy only these fields."],
  },
  discardRecovery: {
    summary: "Cancel a prepared recovery before it installs.",
    take: [{ field: "transferId", from: "prepareRecovery", path: "recovery.transferId" }],
  },
  upload: {
    summary: "Upload a file for a file field.",
    notes: ["bytesBase64 holds the file as base64. Retry an uncertain upload with the same idempotencyKey."],
  },
  file: { summary: "Read an uploaded file." },
  createForm: { summary: "Create a form app that adds records to a Collection." },
  prepareRelationChoices: {
    summary: "Prepare public choices for a relation field.",
    notes: [migrationApproval],
  },
  create: { summary: "Write source for a new Collection, ready to approve." },
  prepare: { summary: "Capture existing Collection source for review." },
  approve: {
    summary: "Approve prepared source.",
    notes: ["Take preparationId and revisionSha256 from the reviewed preparation.", agentLabelNote],
  },
  discard: { summary: "Discard prepared source. The files stay in place." },
  prepareMigration: {
    summary: "Prepare new source and migration SQL for review.",
    notes: ["Read more changed records with migrationPreviewPage.", migrationApproval],
  },
  migrationPreviewPage: { summary: "Read more records a prepared migration changes." },
  prepareSchemaChange: {
    summary: "Prepare one field, table, or name change.",
    notes: [
      `change.kind is one of ${DatasetSchemaChange.options.map((option) => option.shape.kind.value).join(", ")}.`,
      migrationApproval,
    ],
  },
  approveMigration: {
    summary: "Apply a reviewed migration.",
    notes: ["Take revisionSha256 and approvalDigest from the preparation. Approval applies the reviewed result without rerunning the SQL.", agentLabelNote],
  },
  discardMigration: { summary: "Discard a prepared migration." },
  invoke: {
    summary: "Run an approved operation.",
    notes: [
      "Use describe to find approved operation IDs.",
      "Retry an uncertain write with the same input and idempotencyKey.",
    ],
  },
};

const publicationFromList: readonly CliFieldSource[] = [
  { field: "publicationId", from: "list", path: "publications[].publicationId" },
  { field: "expectedAuthorityRevision", from: "list", path: "publications[].authorityRevision" },
];

const APP_HELP: Record<OwnerAppPublicationRequest["action"], JsonVerbHelp> = {
  createLink: {
    summary: "Create a scoped app link at View access by default.",
    notes: [
      "appRoot and paths resolve from your current folder (the workspace root through MCP). paths default to the app root. access defaults to view.",
      "Generate operationId as a UUID for this creation. Reuse operationId for retries.",
      "A link URL is a bearer credential at its stated access level, usable by anyone holding it. Append the published appQuery before the fragment of any link URL, including one returned by createLink.",
      agentLabelNote,
    ],
  },
  listLocal: { summary: "List an app's publications on this computer." },
  prepareLocal: {
    summary: "Prepare an app to open on this computer.",
    notes: ["Review the source and the Collection access it asks for, then approve."],
  },
  launchLocal: {
    summary: "Get a local URL for an approved app.",
    notes: ["The URL works on this computer while dohc is open. It is not a share link."],
  },
  list: { summary: "List an app's shared publications." },
  prepare: {
    summary: "Prepare an app for a share link.",
    take: [
      { field: "shareId", from: "createLink", path: "shareId" },
      { field: "grantId", from: "createLink", path: "grantId" },
    ],
    notes: ["shareId and grantId name the share and its link grant. Review the result, then approve."],
  },
  approve: {
    summary: "Publish a prepared app.",
    take: [
      { field: "approvalId", from: "prepare", path: "approvalId" },
      { field: "candidateDigest", from: "prepare", path: "candidateDigest" },
    ],
    notes: [
      "Take approvalId and candidateDigest from prepare, prepareLocal, or reviewReactivation. Append the returned appQuery before the fragment of any link URL, including one returned by createLink.",
      "For linkReads, select operationId from the prepared dataset capability's operations and fieldIds from each operation's fields[].fieldId. These selections expose reads to link holders.",
      agentLabelNote,
    ],
  },
  cancel: {
    summary: "Discard a prepared app before approval.",
    take: [{ field: "approvalId", from: "prepare", path: "approvalId" }],
    notes: ["Use approvalId from prepareLocal or reviewReactivation to cancel those preparations."],
  },
  withdraw: {
    summary: "Stop a shared publication.",
    take: publicationFromList,
    notes: [
      "For an app approved on this computer, take publicationId and authorityRevision from listLocal.",
      "withdrawalUnconfirmed means access ended, but responses the app sent earlier are not yet confirmed saved or refused. Withdraw again with the returned authorityRevision to confirm.",
    ],
  },
  revokeCollection: {
    summary: "Remove a shared publication's Collection access.",
    take: publicationFromList,
    notes: ["For an app approved on this computer, this ends its approval, as withdraw does."],
  },
  reviewReactivation: {
    summary: "Prepare a stopped publication to publish again.",
    notes: ["Review the result, then approve."],
  },
};

const APP_RESPONSE_VERBS: Record<OwnerAppResponsesRequest["action"], { name: string } & JsonVerbHelp> = {
  list: { name: "responses", summary: "List responses link holders sent through a share link." },
  undo: {
    name: "undo-responses",
    summary: "Remove responses link holders sent through a share link.",
    notes: ["operationId names this removal. Retry failed items with the same operationId."],
  },
};

const datasetHelpOrder = Object.keys(DATASET_HELP);
const DATASET_VERBS: Record<string, CliVerbSpec> = Object.fromEntries(
  DatasetRequest.options
    .map((option) => {
      const action = option.shape.action.value;
      return [
        action,
        jsonVerb(DATASET_CAPABILITIES[action], "dataset", action, action, option.shape, DATASET_HELP[action], (value) => ({
          verb: "dataset",
          request: DatasetRequest.parse(value),
        })),
      ] as const;
    })
    .sort(([left], [right]) => datasetHelpOrder.indexOf(left) - datasetHelpOrder.indexOf(right)),
);

const APP_VERBS: Record<string, CliVerbSpec> = Object.fromEntries([
  ...OwnerAppPublicationRequest.options.map((option) => {
    const action = option.shape.action.value;
    return [
      action,
      jsonVerb(APP_PUBLICATION_CAPABILITIES[action], "app", action, action, option.shape, APP_HELP[action], (value) => ({
        verb: "appPublication",
        request: OwnerAppPublicationRequest.parse(value),
      })),
    ] as const;
  }),
  ...OwnerAppResponsesRequest.options.map((option) => {
    const action = option.shape.action.value;
    const { name, ...help } = APP_RESPONSE_VERBS[action];
    return [
      name,
      jsonVerb(APP_RESPONSE_CAPABILITIES[action], "app", name, action, option.shape, help, (value) => ({
        verb: "ownerAppResponses",
        request: OwnerAppResponsesRequest.parse(value),
      })),
    ] as const;
  }),
]);

/** Every command and verb the CLI dispatches. Help reads this table too. */
export const CLI_COMMANDS: Readonly<Record<string, CliCommandSpec>> = {
  links: { summary: "Read and resolve document links.", notes: [], verbs: {
    edges: { capabilityId: "links.edges", summary: "Read a bounded page of file links.", operands: "", flags: [{ name: "--cursor", value: "cursor", text: "Continue the previous page." }], parse: input => {
      noExtraArgs(input.operands, "links edges");
      return { verb: "linksEdges", ...LinksEdgesInput.parse({ cursor: lastValue(input, "--cursor") }) };
    } },
    in: { capabilityId: "links.in", summary: "Read documents that link to a file.", operands: "<subject-json>", flags: [{ name: "--cursor", value: "cursor", text: "Continue the previous page." }], parse: input => {
      const [subject, ...extra] = input.operands; noExtraArgs(extra, "links in");
      try { return { verb: "linksIn", ...LinksInInput.parse({ subject: JSON.parse(subject ?? "null"), cursor: lastValue(input, "--cursor") }) }; } catch { return fail('Use a subject JSON object with path or objectId.'); }
    } },
    resolve: { capabilityId: "links.resolve", summary: "Resolve links from one document.", operands: "<source> <literals-json>", parse: input => {
      const [source, literals, ...extra] = input.operands; noExtraArgs(extra, "links resolve");
      try { return { verb: "linksResolve", ...LinksResolveInput.parse({ source, literals: JSON.parse(literals ?? "null") }) }; } catch { return fail('Use a source path and a JSON array of kind and literal objects.'); }
    } },
  } },
  sync: {
    summary: "Stop syncing this workspace on this computer.",
    notes: ["Local files, documents, records, and history stay here. Shares and protected-file keys are retained.",
      "Groups you joined and received-share mounts keep syncing.",
      "Turn sync on in Settings to resume the same workspace."],
    verbs: {
      stop: {
        capabilityId: "workspace.sync.stop", summary: "Stop this computer's sync after saving live document edits.", operands: "",
        flags: [{ name: "--agent", value: "name", text: "Record this agent name when --as-agent is set." }],
        parse: (input) => {
          noExtraArgs(input.operands, "sync stop");
          const agent = lastValue(input, "--agent");
          if (agent !== undefined && !documentAgentNameSchema.safeParse(agent).success) fail("invalid --agent name");
          return { verb: "stopSync", ...(agent === undefined ? {} : { agent }) };
        },
      },
    },
  },
  access: {
    summary: "Read observed grants and request fresh Sharing inventories.",
    notes: ["Answers describe observed grants, not authorization. An empty page means no matching grants within its coverage.",
      "Paths resolve from your current folder. Received selectors use their source workspace's coordinates."],
    verbs: {
      refresh: {
        capabilityId: "access.refresh", operands: "", summary: "Request fresh Sharing observations with the same pacing as opening Sharing.",
        notes: ["Reports requested, joined, paced, or unavailable. Requested and joined wait for started or existing attempts to settle, without promising success. Paced follows the existing refresh schedule. Read access sharing afterward to inspect observations."],
        parse: input => { noExtraArgs(input.operands, "access refresh"); return { verb: "accessRefresh" }; },
      },
      object: {
        capabilityId: "access.object.read", summary: "Read the grants covering an object.", operands: "<reference-json>",
        flags: [{ name: "--cursor", value: "cursor", text: "Continue the previous answer." }],
        parse: input => {
          const [value, ...extra] = input.operands; noExtraArgs(extra, "access object");
          let ref: AccessObjectRef;
          try { ref = AccessObjectRef.parse(JSON.parse(value ?? "")); } catch { return fail("Use a path, file, chat, or Collection reference as JSON."); }
          const cursor = lastValue(input, "--cursor");
          return { verb: "accessObject", ref, ...(cursor ? { cursor } : {}) };
        },
      },
      sharing: {
        capabilityId: "access.sharing.read", summary: "Page this workspace's granted shares or this account's received shares.", operands: "<granted|received>",
        flags: [{ name: "--cursor", value: "cursor", text: "Continue the previous answer." }],
        parse: input => {
          const [lane, ...extra] = input.operands; noExtraArgs(extra, "access sharing");
          if (lane !== "granted" && lane !== "received") return fail("Choose granted or received.");
          const cursor = lastValue(input, "--cursor");
          return { verb: "accessSharing", lane, ...(cursor ? { cursor } : {}) };
        },
      },
    },
  },
  share: {
    summary: "Read copy details for an owned share grant.",
    notes: ["Requires the original workspace and its signed-in owner account."],
    verbs: {
      copy: {
        capabilityId: "share.copy.read", summary: "Read a grant's share code and named-account invite link.", operands: "<shareId> <grantId>",
        parse: input => {
          const [shareId, grantId, ...extra] = input.operands; noExtraArgs(extra, "share copy");
          if (!shareId || !grantId) return fail("Provide a share id and grant id.");
          return { verb: "shareCopy", shareId, grantId };
        },
      },
    },
  },
  document: {
    summary: "Read, edit, and create live Markdown documents. List and start chats on tracked files. Recover edits the server refused.",
    notes: ["Paths resolve from your current folder. Changes are recorded as an agent's, as with MCP.",
      "A refusal exits with status 1 and prints its reason to stderr, including with --json."],
    verbs: DOCUMENT_VERBS,
  },
  chat: {
    summary: "Read and post in Groups and threads.",
    notes: [
      "Name a Group by its name or ID, and a thread or message by its ID. A unique ID prefix also works.",
      "DOHC_CHAT_ACTOR=agent in the environment does the same as --as-agent.",
    ],
    verbs: { ...CHAT_VERBS, links: {
      capabilityId: "chat.read", summary: "Read one page of files mentioned in a chat.", operands: "<group>",
      flags: [{ name: "--cursor", value: "cursor", text: "Continue the previous page." }],
      parse: input => {
        const [group, ...extra] = input.operands;
        if (!group) fail("links requires a group");
        noExtraArgs(extra, "chat links");
        return { verb: "chatLinks", ...chatLinksGroupInputSchema.parse({ group, cursor: lastValue(input, "--cursor") }) };
      },
    }, "file-mentions": {
      capabilityId: "chat.read", summary: "Read one bounded page of file mentions.",
      operands: "", flags: [
        { name: "--subject", value: "subject", text: "A file path or objectId as JSON." },
        { name: "--cursor", value: "cursor", text: "Continue the previous page." },
      ], parse: input => {
        noExtraArgs(input.operands, "chat file-mentions");
        const subject = lastValue(input, "--subject");
        return { verb: "chatFileMentions", ...ChatFileMentionsInput.parse({
          ...(subject ? { subject: JSON.parse(subject) } : {}), cursor: lastValue(input, "--cursor"),
        }) };
      },
    } },
  },
  dataset: {
    summary: "Create, change, and use transactional Collections.",
    notes: [workspaceNote, "datasetPath is the caller-relative dataset.json path. List and describe return it alongside the internal datasetId.", "After moving the file, update commands and app manifests. An old path reports a broken reference.", "These verbs use the same Collection rules as dohc. They do not accept SQL or caller identity."],
    verbs: DATASET_VERBS,
  },
  app: {
    summary: "Approve, open, and share apps.",
    notes: [workspaceNote],
    verbs: APP_VERBS,
  },
  file: {
    summary: "Change workspace files.", notes: ["Undo removes the copy while it is unchanged."],
    verbs: {duplicate: {capabilityId: "file.duplicate", summary: "Duplicate one file beside its source.", operands: "<path>",
      parse: input => {const [path, ...extra] = input.operands; if (!path) fail("file duplicate requires a path"); noExtraArgs(extra, "file duplicate"); return {verb: "fileDuplicate", path};}}},
  },
  history: {
    summary: "Read History changes and undo deletes, moves, and renames.",
    notes: ["Changes come from the active version of the workspace."],
    verbs: HISTORY_VERBS,
  },
  automation: {
    summary: "Press Button fields, read an automation's runs, and try a failed run again.",
    notes: [
      "Name a Collection by its folder in the workspace, and an automation by its id in the Collection's automations.yaml.",
      "Each computer keeps the runs of the automations it ran. Try again follows the same rules as in dohc.",
    ],
    verbs: AUTOMATION_VERBS,
  },
  account: {
    summary: "Review and delete the server account the dohc app is connected to.",
    notes: ["Unlike other commands, account verbs also work outside a workspace folder."],
    verbs: ACCOUNT_VERBS,
  },
};

export const GLOBAL_FLAGS: readonly CliFlag[] = [
  { name: "--as-agent", text: "Post and read chat as an agent." },
  { name: "--json", text: "Print the result as JSON." },
  { name: "--help", text: "Show help. -h does the same." },
];

const VALUE_FLAGS = new Set(
  Object.values(CLI_COMMANDS).flatMap((command) => Object.values(command.verbs)).flatMap((verb) =>
    (verb.flags ?? []).filter((flag) => flag.value).map((flag) => flag.name),
  ),
);

function stripGlobalFlags(argv: readonly string[]): {
  actorFlag: boolean;
  json: boolean;
  tokens: string[];
} {
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
    if (!optionsEnded && VALUE_FLAGS.has(token)) {
      expectsOptionValue = true;
    }
  }
  return { actorFlag, json, tokens };
}

export function parseCliArguments(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): ParsedCliCommand | CliHelpRequest {
  const global = stripGlobalFlags(argv);
  // --help asks for help only beside a command and verb. Once operands start, it is verb input.
  const names = global.tokens.filter((token) => token !== "--help" && token !== "-h");
  const help = names.length < global.tokens.length && names.length <= 2 && !names.includes("--");
  const [commandName, verbName, ...tokens] = help ? names : global.tokens;
  if (!commandName) return { help: [] };
  const command = lookup(CLI_COMMANDS, commandName);
  if (!command) fail(`unknown command '${commandName}'; run dohc --help`);
  if (!verbName) return { help: [commandName] };
  const verb = lookup(command.verbs, verbName);
  if (!verb) fail(`unknown ${commandName} verb '${verbName}'; run dohc ${commandName} --help`);
  if (help) return { help: [commandName, verbName] };
  const agent = (commandName === "history" && verbName === "undo") || commandName === "document" || commandName === "file" || global.actorFlag || (commandName === "chat" && env.DOHC_CHAT_ACTOR === "agent");
  const body = verb.parse(readVerbInput(`${commandName} ${verbName}`, verb, tokens));
  return { actor: agent ? "agent" : "human", json: global.json, ...body };
}
