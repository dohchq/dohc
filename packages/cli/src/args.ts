import type { z } from "zod";
import { documentAgentNameSchema, documentEditTextSchema, requestIdSchema, type CliActor } from "./protocol";
import { DohcCliError } from "./errors";
import { OwnerAppPublicationRequest } from "./appPublication";
import { OwnerAppResponsesRequest } from "./appResponses";
import { DatasetRequest, DatasetSchemaChange } from "./dataset";

interface ParsedCliBase {
  actor: CliActor;
  json: boolean;
}

type ExportScope =
  | { kind: "all" }
  | { kind: "group"; group: string }
  | { kind: "thread"; thread: string };

type CliCommandBody =
  | { verb: "documentRead"; path: string }
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
  | { verb: "moment"; id: string; side: "before" | "after" };

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
      fail(`unknown ${name} option '${token}'${verb.freeText ? `; put ${DASH_RULE}` : ""}`);
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
    summary: "Read the current Markdown, including edits in an open editor.",
    operands: "<path>",
    notes: ["Read before editing. Without --json, prints the Markdown byte for byte."],
    parse: ({ operands }) => {
      const [path, ...extra] = operands;
      if (!path) fail("document read requires a path");
      noExtraArgs(extra, "document read");
      return { verb: "documentRead", path };
    },
  },
  edit: {
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
    summary: "Create a Markdown document without overwriting an existing file.",
    operands: "<path> [-]",
    flags: documentTextFlags,
    notes: [stdinNote, "Use --text instead to supply Markdown. With neither, create an empty document.",
      "The path must end in .md or .markdown. Frontmatter is refused."],
    parse: (input) => documentWrite(input, "documentCreate"),
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
    summary: "List the Groups in this workspace.",
    operands: "",
    parse: ({ operands }) => {
      noExtraArgs(operands, "groups");
      return { verb: "groups" };
    },
  },
  threads: {
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
    summary: "List unread threads. For an agent, also list its unread mentions.",
    operands: "",
    parse: ({ operands }) => {
      noExtraArgs(operands, "inbox");
      return { verb: "inbox" };
    },
  },
  show: {
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

const HISTORY_VERBS = {
  list: {
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

interface JsonVerbHelp {
  summary: string;
  notes?: readonly string[];
  required?: readonly string[];
  take?: readonly CliFieldSource[];
}

function jsonVerb(
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

const DATASET_HELP: Record<DatasetRequest["action"], JsonVerbHelp> = {
  list: { summary: "List Collections." },
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
      "savePath is an absolute path ending in .dohc-recovery. Set overwrite to true to replace a file.",
      "Recovery archives contain private records, uploaded files, history, and retry credentials. Store them privately.",
    ],
  },
  prepareRecovery: {
    summary: "Check a recovery archive before restoring it.",
    required: ["sourcePath"],
    notes: ["sourcePath is an absolute path ending in .dohc-recovery. Review the result before claimRecovery."],
  },
  claimRecovery: {
    summary: "Restore a Collection from a prepared archive.",
    take: [
      { field: "workspaceId", from: "prepareRecovery", path: "recovery.sourceCursor.workspaceId" },
      { field: "datasetId", from: "prepareRecovery", path: "recovery.sourceCursor.datasetId" },
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
    notes: ["Take preparationId and revisionSha256 from the reviewed preparation."],
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
    notes: ["Take revisionSha256 and approvalDigest from the preparation. Approval applies the reviewed result without rerunning the SQL."],
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
  listLocal: { summary: "List an app's publications on this computer." },
  prepareLocal: {
    summary: "Prepare an app to open on this computer.",
    notes: ["Review the source and the dataset operations it asks for, then approve."],
  },
  launchLocal: {
    summary: "Get a local URL for an approved app.",
    notes: ["The URL works on this computer while dohc is open. It is not a share link."],
  },
  list: { summary: "List an app's shared publications." },
  prepare: {
    summary: "Prepare an app for a share link.",
    notes: ["shareId and grantId name the share and its link grant. Review the result, then approve."],
  },
  approve: {
    summary: "Publish a prepared app.",
    notes: ["Take approvalId and candidateDigest from prepare, prepareLocal, or reviewReactivation."],
  },
  cancel: { summary: "Discard a prepared app before approval." },
  withdraw: {
    summary: "Stop a shared publication.",
    take: publicationFromList,
  },
  revokeCollection: {
    summary: "Remove a shared publication's Collection access.",
    take: publicationFromList,
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
        jsonVerb("dataset", action, action, option.shape, DATASET_HELP[action], (value) => ({
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
      jsonVerb("app", action, action, option.shape, APP_HELP[action], (value) => ({
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
      jsonVerb("app", name, action, option.shape, help, (value) => ({
        verb: "ownerAppResponses",
        request: OwnerAppResponsesRequest.parse(value),
      })),
    ] as const;
  }),
]);

/** Every command and verb the CLI dispatches. Help reads this table too. */
export const CLI_COMMANDS: Readonly<Record<string, CliCommandSpec>> = {
  document: {
    summary: "Read, edit, and create live Markdown documents.",
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
    verbs: CHAT_VERBS,
  },
  dataset: {
    summary: "Create, change, and use transactional Collections.",
    notes: [workspaceNote, "These verbs use the same Collection rules as dohc. They do not accept SQL or caller identity."],
    verbs: DATASET_VERBS,
  },
  app: {
    summary: "Approve, open, and share apps.",
    notes: [workspaceNote],
    verbs: APP_VERBS,
  },
  history: {
    summary: "Read the changes History records for files.",
    notes: ["Changes come from the active version of the workspace."],
    verbs: HISTORY_VERBS,
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
  const agent = commandName === "document" || global.actorFlag || (commandName === "chat" && env.DOHC_CHAT_ACTOR === "agent");
  const body = verb.parse(readVerbInput(`${commandName} ${verbName}`, verb, tokens));
  return { actor: agent ? "agent" : "human", json: global.json, ...body };
}
