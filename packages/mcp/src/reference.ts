// Renders docs/reference/cli-mcp-sdk.md. Names and arguments come from the
// live MCP server and the CLI's zod schemas, so they cannot drift from the
// page. The prose next to them is written here, one entry per tool, action,
// verb, or method, and reference.test.ts fails when an entry is missing.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "@dohc/cli/app-publication";
import { OwnerAppResponsesRequest, OwnerAppResponsesResult } from "@dohc/cli/app-responses";
import { CLI_JSON_SCHEMA_VERSION, cliResultSchemas, type CliVerb } from "@dohc/cli/protocol";
import type { DohcClient } from "@dohc/sdk";
import { createDohcMcpServer } from "./server";

export const REFERENCE_PATH = "docs/reference/cli-mcp-sdk.md";

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  additionalProperties?: JsonSchema | boolean;
  format?: string;
  pattern?: string;
}

// --- Hand-written entries ----------------------------------------------------

type DatasetAction = DatasetRequest["action"];
type DatasetKind = DatasetResult["kind"];
type AppAction = OwnerAppPublicationRequest["action"];
type AppKind = OwnerAppPublicationResult["kind"];

// Each action's purpose and the result kinds the desktop answers it with
// (apps/desktop/src/ipc/datasetIpc.ts). `required` names fields the CLI and
// MCP refuse to go without, though the desktop's own dialogs may omit them.
export const DATASET_ACTIONS: Record<DatasetAction, { does: string; returns: DatasetKind[]; required?: string[] }> = {
  list: { does: "Lists the workspace's transactional Collections.", returns: ["list"] },
  describe: { does: "Describes one Collection: its tables, fields, and approved operations with their ids.", returns: ["description"] },
  history: { does: "Lists saved record operations and rule revisions, newest first, with prior values for reversible edits.", returns: ["history"] },
  historyRevision: { does: "Reads the schema and operation source saved with one past revision.", returns: ["history-revision"] },
  lifecycle: { does: "Shows whether the Collection is archived and which apps bind to it.", returns: ["lifecycle"] },
  archive: { does: "Stops the Collection's operations and keeps its records.", returns: ["lifecycle-updated"] },
  restore: { does: "Resumes an archived Collection under its existing rules.", returns: ["lifecycle-updated"] },
  deletePreview: { does: "Starts a permanent deletion: lists affected apps and returns the cursor and review token that `delete` needs.", returns: ["delete-preview"] },
  delete: { does: "Permanently removes the Collection's private data and history. It needs `acknowledge: true`. Export first if you need a recovery copy.", returns: ["deleted"] },
  pendingAttempts: { does: "Lists saved form responses whose retry is pending. Each is committed or unconfirmed.", returns: ["pending-attempts"] },
  reconcileAttempt: { does: "Clears the saved retry of a committed response. It needs `acknowledge: true`.", returns: ["attempt-reconciled"] },
  cancelAttempt: { does: "Cancels an unconfirmed response. It needs `acknowledge: true`.", returns: ["attempt-cancelled"] },
  permissions: { does: "Lists the Collection's app bindings and explicit data grants.", returns: ["permissions"] },
  setGrant: { does: "Sets the data grant for one share grant: the approved revision and the operations it may call.", returns: ["grant-updated"] },
  removeGrant: { does: "Removes an explicit data grant. `principalKey` comes from `permissions`.", returns: ["grant-updated"] },
  create: { does: "Creates a Collection from a definition. It writes generated source and approves it.", returns: ["approved"] },
  prepare: { does: "Captures the dataset source at `descriptorPath` for review.", returns: ["prepared"] },
  approve: { does: "Approves a reviewed preparation by its `revisionSha256`.", returns: ["approved"] },
  discard: { does: "Discards a preparation. The source files stay in place.", returns: ["discarded"] },
  invoke: { does: "Calls one approved operation. Retry an uncertain write with the same `input` and `idempotencyKey`.", returns: ["invoked", "refused"] },
  upload: { does: "Uploads one file for a file field, for a later operation to attach.", returns: ["uploaded"] },
  file: { does: "Reads an uploaded file, through a read operation when `read` is given.", returns: ["file"] },
  createForm: { does: "Writes a form app into `appRoot` for one create operation and the chosen fields.", returns: ["form-created"] },
  prepareRelationChoices: { does: "Prepares a read operation that returns each target record's key and one label field, for a relation picker. Approve it with `approveMigration`.", returns: ["migration-prepared"] },
  prepareSchemaChange: { does: "Prepares a field or name change on a generated Collection. Approve it with `approveMigration`.", returns: ["migration-prepared"] },
  prepareMigration: { does: "Runs a migration SQL file against a saved copy and prepares the new descriptor. Approve it with `approveMigration`.", returns: ["migration-prepared"] },
  prepareHistoryRestore: { does: "Prepares a forward change that reverses one saved change against the current records. Approve it with `approveMigration`.", returns: ["migration-prepared"] },
  migrationPreviewPage: { does: "Reads the next page of changed rows in a prepared migration.", returns: ["migration-preview-page"] },
  approveMigration: { does: "Applies the reviewed migration checkpoint. It does not run the SQL again.", returns: ["migrated"] },
  discardMigration: { does: "Discards a prepared migration.", returns: ["migration-discarded"] },
  export: { does: "Writes a private recovery archive to `savePath`, an absolute path ending in `.dohc-recovery`. The archive holds private records, files, history, and retry credentials.", returns: ["exported"], required: ["savePath"] },
  prepareRecovery: { does: "Checks a recovery archive at `sourcePath`, an absolute path ending in `.dohc-recovery`. Review the result before `claimRecovery`.", returns: ["recovery-prepared"], required: ["sourcePath"] },
  claimRecovery: { does: "Installs a prepared recovery. Stop the old host first, then pass `oldHostStopped: true`.", returns: ["recovery-claimed"] },
  discardRecovery: { does: "Cancels a prepared recovery before it is claimed.", returns: ["recovery-discarded"] },
};

// apps/desktop/src/ipc/ownerAppPublicationIpc.ts and localOwnerAppPublication.ts.
export const APP_ACTIONS: Record<AppAction, { does: string; returns: AppKind[] }> = {
  prepareLocal: { does: "Prepares the app at `appRoot` to run on this computer. Review the result, then `approve` it.", returns: ["prepared"] },
  listLocal: { does: "Lists this computer's approved local publications of the app at `appRoot`.", returns: ["localListed"] },
  launchLocal: { does: "Opens an approved local app and returns its `127.0.0.1` URL. Keep dohc open while you use it.", returns: ["localLaunched"] },
  prepare: { does: "Prepares the app at `appRoot` for people who open a share link. Review the result, then `approve` it.", returns: ["prepared"] },
  list: { does: "Lists the shared publications of the app at `appRoot`.", returns: ["listed"] },
  approve: { does: "Publishes a prepared app. `approvalId` and `candidateDigest` come from `prepare` or `prepareLocal`.", returns: ["published"] },
  cancel: { does: "Cancels a preparation.", returns: ["cancelled"] },
  withdraw: { does: "Ends a publication. Its Collection keeps its records.", returns: ["withdrawn"] },
  revokeCollection: { does: "Removes a publication's access to its Collection.", returns: ["collectionRevoked"] },
  reviewReactivation: { does: "Prepares an ended publication to publish again. Review the result, then `approve` it.", returns: ["prepared"] },
};

// `dohc app responses` and `dohc app undo-responses` map to these actions.
export const APP_RESPONSE_VERBS: Record<OwnerAppResponsesRequest["action"], { verb: string; does: string }> = {
  list: { verb: "responses", does: "Lists the responses that link holders submitted through an app on one link grant." },
  undo: { verb: "undo-responses", does: "Deletes one page of those responses, optionally only one link holder's. `operationId` is an id you choose for this undo." },
};

// Every CLI socket verb is either a command a person types or one the MCP
// tools use. A new verb fails typecheck here until it is placed.
type ChatVerb = { usage: string; does: string; flags?: Record<string, string>; examples: string[][] };
export const CLI_VERBS: Record<CliVerb, ChatVerb | "dataset" | "app" | "mcp"> = {
  dataset: "dataset",
  appPublication: "app",
  ownerAppResponses: "app",
  groups: { usage: "dohc chat groups", does: "Lists the workspace's groups.", examples: [["chat", "groups"]] },
  threads: { usage: "dohc chat threads <group>", does: "Lists a group's threads. `<group>` is a name, `#slug`, or id.", examples: [["chat", "threads", "general"]] },
  inbox: { usage: "dohc chat inbox", does: "Lists threads with unread messages, and messages that mention you.", examples: [["chat", "inbox"]] },
  show: {
    usage: "dohc chat show <thread-or-message> [--peek]",
    does: "Prints a thread, or the thread around one message, and marks it read.",
    flags: { "--peek": "Leaves the thread unread. A read-only workspace requires it." },
    examples: [["chat", "show", "th_1", "--peek"]],
  },
  post: {
    usage: "dohc chat post <group> [--title <title>] [--attach <path>]... [--needs-decision] [--option <choice>]... <body>",
    does: "Starts a thread in a group. A `<body>` of `-` reads the body from stdin.",
    flags: {
      "--title": "Titles the thread. Without it, the thread shows its first message.",
      "--attach": "Attaches a tracked workspace file. Repeat it for more files.",
      "--needs-decision": "Asks the readers for a decision.",
      "--option": "Adds a poll choice and implies `--needs-decision`. Repeat it for each choice.",
    },
    examples: [["chat", "post", "general", "--title", "Plan", "--attach", "notes.md", "--needs-decision", "--option", "Yes", "--option", "No", "Ship", "it?"]],
  },
  reply: {
    usage: "dohc chat reply <thread> [--to <message>] [--attach <path>]... [--needs-decision] [--option <choice>]... [--resolve <message> [--choose <choice>]] <body>",
    does: "Replies in a thread. A `<body>` of `-` reads the body from stdin.",
    flags: {
      "--to": "Replies under one message.",
      "--attach": "Attaches a tracked workspace file. Repeat it for more files.",
      "--needs-decision": "Asks the readers for a decision.",
      "--option": "Adds a poll choice and implies `--needs-decision`. Repeat it for each choice.",
      "--resolve": "Closes that message's open decision with this reply.",
      "--choose": "Names the poll choice picked. It needs `--resolve`.",
    },
    examples: [
      ["chat", "reply", "th_1", "--to", "msg_1", "--attach", "notes.md", "--needs-decision", "--option", "A", "Which?"],
      ["chat", "reply", "th_1", "--resolve", "msg_2", "--choose", "Yes", "Done"],
    ],
  },
  react: { usage: "dohc chat react <message> <emoji>", does: "Adds your reaction to a message, or removes it if it is there.", examples: [["chat", "react", "msg_1", "👍"]] },
  grep: {
    usage: "dohc chat grep <pattern> [--group <group>] [--thread <thread>] [--from <author>] [--since <when>] [-i] [-l] [-C <lines>] [--limit <count>] [--regex]",
    does: "Searches thread titles and message text.",
    flags: {
      "--group": "Searches one group.",
      "--thread": "Searches one thread.",
      "--from": "Keeps messages whose author kind is `<author>`, or whose author name contains it.",
      "--since": "Keeps messages newer than a date, or than `<days>d` ago.",
      "-i": "Ignores case. Without `--regex`, a pattern with no capital letters ignores case anyway.",
      "-l": "Prints only the matching thread ids.",
      "-C": "Prints that many messages around each match.",
      "--limit": "Stops after that many matches. The default is 100.",
      "--regex": "Reads `<pattern>` as a regular expression.",
    },
    examples: [["chat", "grep", "launch", "--group", "general", "--thread", "th_1", "--from", "agent", "--since", "7d", "-i", "-l", "-C", "2", "--limit", "10", "--regex"]],
  },
  export: {
    usage: "dohc chat export [--all | --group <group> | --thread <thread>] --out <dir>",
    does: "Writes threads as Markdown files into `<dir>`. Without a scope, it writes every thread.",
    flags: { "--all": "Writes every thread.", "--group": "Writes one group's threads.", "--thread": "Writes one thread.", "--out": "The folder to write into. Required." },
    examples: [
      ["chat", "export", "--all", "--out", "exports"],
      ["chat", "export", "--group", "general", "--out", "exports"],
      ["chat", "export", "--thread", "th_1", "--out", "exports"],
    ],
  },
  moments: "mcp",
  moment: "mcp",
  fileChats: "mcp",
  chat: "mcp",
  groupsFull: "mcp",
  collectionQuery: "mcp",
  collectionRecord: "mcp",
  collectionSetFields: "mcp",
  collectionCreateRecord: "mcp",
};

// What each MCP tool returns. A CLI verb means the tool passes on that
// verb's result schema; a string is written from the tool in tools.ts.
export const MCP_RETURNS: Record<string, { cli: CliVerb } | string> = {
  dohc_dataset: "the result of the requested action, listed under [Dataset actions](#dataset-actions).",
  dohc_list_workspaces: "`{ workspaces: { workspaceId, rootPath, kind, remote? }[] }`",
  dohc_workspace_status: "`{ synced, scope, cloudConnected, credentialStatus, workspaceId?, serverUrl? }`. `scope` is `\"local\"` or `\"cloud\"`.",
  dohc_list_changes: { cli: "moments" },
  dohc_read_change: { cli: "moment" },
  dohc_list_files: "`{ ok: true, root, entries: { path, kind, bytes?, mediaType? }[] }`",
  dohc_read_file: "`{ ok: true, path, mediaType, encoding, bytes, offsetBytes, sha256, truncated, content }`",
  dohc_search_files: "`{ ok: true, query, root, mode, matches: { type, path, mediaType?, line?, column?, preview }[], matchCount, limitHit, skipped: { path, reason }[] }`",
  dohc_write_file: "`{ ok: true, path, bytes, sha256, recordedBy }`",
  dohc_create_directory: "`{ ok: true, path, recordedBy }`, or `{ ok: true, path, unchanged: true }` when the folder exists.",
  dohc_move_path: "`{ ok: true, fromPath, toPath, recordedBy }`",
  dohc_delete_path: "`{ ok: true, path, trashed: true, recordedBy }`",
  dohc_detect_apps: "`{ ok: true, apps: { root, title, kind, confidence, entry?, packageManager?, scripts, configuredPreviewMode?, buildOutputs, configPath?, diagnostics }[], count, detector }`",
  dohc_create_app: "`{ ok: true, appRoot, files, recordedBy }`",
  dohc_test_app: "`{ ok, app, checks: { name, ok, message?, path? }[] }`. `ok` is true when every check passes.",
  dohc_import_data: "`{ ok: true, path, tableName, rowCount, recordedBy }`",
  dohc_query_database: "`{ ok: true, rows }`, with at most 1,000 rows.",
  dohc_list_file_chats: { cli: "fileChats" },
  dohc_read_chat: { cli: "chat" },
  dohc_list_groups: { cli: "groupsFull" },
  dohc_start_group_chat: "`{ ok: true, group: { id, slug, kind }, threadId, messageId, title, warning? }`",
  dohc_reply_to_chat: "`{ ok: true, threadId, messageId, parentMessageId?, resolvedMessageId?, warning? }`",
  dohc_query_collection: { cli: "collectionQuery" },
  dohc_read_record: { cli: "collectionRecord" },
  dohc_set_record_fields: { cli: "collectionSetFields" },
  dohc_create_record: { cli: "collectionCreateRecord" },
};

// One request per operation an app page can send over its app channel. The
// fields are the example's keys, and reference.test.ts sends each example
// through the real broker (packages/app-browser/src/broker.ts).
export const APP_CHANNEL_REQUESTS: { example: Record<string, unknown>; does: string; returns: string }[] = [
  {
    example: { op: "backend.invoke", operation: "listOrders", input: {}, idempotencyKey: "read-1" },
    does: "Calls one operation the app's publication exposes, by name. Reads use it too, with a new `idempotencyKey` for each call. Retry an uncertain write with the same `input` and `idempotencyKey`.",
    returns: "`{ result, revision, replayed }`. A refusal from the operation arrives as status 409 with `error: { code, message }`.",
  },
  {
    example: { op: "backend.upload", name: "receipt.pdf", contentType: "application/pdf", bytesBase64: "JVBERg==", idempotencyKey: "upload-1" },
    does: "Uploads one file, at most 5 MiB, for a later operation to attach.",
    returns: "`{ file, replayed }`",
  },
  {
    example: { op: "backend.file", fileId: "file_0123456789abcdef", operation: "readReceipt", input: {} },
    does: "Reads an uploaded file through an exposed read operation.",
    returns: "`{ file, bytesBase64 }`",
  },
  {
    example: { op: "backend.attempt", operation: "register", request: { action: "get" } },
    does: "Saves, reads, or clears one unconfirmed submission for an operation, so the page can retry it after a reload. `request` is `{ action: \"get\" }`, `{ action: \"save\", idempotencyKey, input }`, or `{ action: \"clear\", token }`.",
    returns: "`{ attempt: { token, idempotencyKey, input } | null }`",
  },
  {
    example: { op: "collection.list", limit: 50 },
    does: "Lists records of the document Collection a published app binds to, at most 100 at a time. Add `afterPath` to read the next page. Only a published app opened from a share link can send it.",
    returns: "`{ records: { path, recordId, fields }[], nextPath }`",
  },
  {
    example: { op: "collection.create", fields: { title: "Tokyo" }, idempotencyKey: "vote-1" },
    does: "Adds a record to that Collection. Only a published app opened from a share link can send it.",
    returns: "`{ kind: \"accepted\", acceptanceId, acceptedAtMs, momentId, objectId, path }`",
  },
];

type SdkMethodPath<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends (...args: never[]) => unknown
    ? `${Prefix}${K}`
    : T[K] extends object
      ? SdkMethodPath<T[K], `${Prefix}${K}.`>
      : never;
}[keyof T & string];

// The `dohc` client from @dohc/sdk. A method added to the client fails
// typecheck here until it has an entry.
export const SDK_METHODS: Record<SdkMethodPath<DohcClient>, { call: string; returns: string; does: string; needs?: string }> = {
  capabilities: { call: "capabilities()", returns: "`DohcCapabilityMap`", does: "Reads what this context can do, such as `files.write`. It is a map of what is available, not a permission request." },
  request: { call: "request(method, params?, options?)", returns: "the host's result", does: "Calls a host method this SDK has no typed wrapper for." },
  invoke: { call: "invoke(method, params?, options?)", returns: "the host's result", does: "Another name for `request`." },
  subscribe: { call: "subscribe(method, params, listener, options?)", returns: "a function that stops the subscription", does: "Subscribes to host events this SDK has no typed wrapper for." },
  "files.read": { call: "files.read(path, options?)", returns: "the text", does: "Reads a text file. It throws `DOHC_RESPONSE_TRUNCATED` when the host sent only part of the file.", needs: "files.read" },
  "files.readInfo": { call: "files.readInfo(path, options?)", returns: "`{ text, truncated }`", does: "Reads a text file and says whether the host cut it short.", needs: "files.read" },
  "files.list": { call: "files.list(path?, listOptions?, options?)", returns: "`{ path, name?, kind?, size?, modifiedAt? }[]`", does: "Lists files. `listOptions` takes `recursive` and `includeHidden`.", needs: "files.list" },
  "files.write": { call: "files.write(path, text, writeOptions?, options?)", returns: "`{ path }`", does: "Writes a text file. `writeOptions.overwrite: false` refuses an existing file. Live Markdown documents are refused.", needs: "files.write" },
  "files.watch": { call: "files.watch(path, listener, options?)", returns: "a function that stops the watch", does: "Reports settled changes at or below `path`, each `{ path, operation, sha256? }`. `operation` is `update` or `delete`.", needs: "files.watch" },
  "workspace.search": { call: "workspace.search(query, searchOptions?, options?)", returns: "`{ path?, title?, excerpt?, score? }[]`", does: "Searches the workspace. `searchOptions` takes `path`, `limit`, and `types`.", needs: "workspace.search" },
  "databases.read": { call: "databases.read({ path, query?, params? }, options?)", returns: "the host's result", does: "Reads a workspace database, with an optional read-only query.", needs: "databases.read" },
  "databases.edit": { call: "databases.edit({ path, query?, params?, operations? }, options?)", returns: "the host's result", does: "Changes a workspace database with one query or exactly one operation.", needs: "databases.edit" },
  "ui.open": { call: "ui.open(target, openOptions?, options?)", returns: "`{ target, position? }`", does: "Opens a workspace path in dohc. `openOptions.position` is `active`, `beside`, or `new-tab`.", needs: "ui.open" },
  "ui.openWebApp": { call: "ui.openWebApp(webAppId, instanceKey, options?)", returns: "the host's result", does: "Opens one instance of the plugin's own web app in a tab. Only a panel can call it.", needs: "ui.open" },
  "ui.theme": { call: "ui.theme(options?)", returns: "`DohcTheme`", does: "Reads dohc's design tokens as they are on screen." },
  "ui.applyTheme": { call: "ui.applyTheme(applyOptions?)", returns: "a function that stops following the theme", does: "Writes dohc's design tokens onto the page and keeps them current." },
  "collections.list": { call: "collections.list(options?)", returns: "an array of Collection objects", does: "Lists the Collections this context can read.", needs: "collections.read" },
  "collections.get": { call: "collections.get(path, options?)", returns: "the Collection object", does: "Reads one Collection.", needs: "collections.read" },
  "collections.query": { call: "collections.query(path, queryOptions?, options?)", returns: "an object with `records`", does: "Queries records. `queryOptions` takes `filter`, `sort`, `groupBy`, `resolveRelations`, `limit`, and `cursor`, as `dohc_query_collection` does.", needs: "collections.read" },
  "collections.getRecord": { call: "collections.getRecord(path, recordId, recordOptions?, options?)", returns: "the record with its history", does: "Reads one record. `recordOptions` takes `historyLimit` and `beforeHistoryId`.", needs: "collections.read" },
  "collections.setFields": { call: "collections.setFields(recordPath, fields, options?)", returns: "`{ path }`", does: "Sets fields on a record.", needs: "collections.edit" },
  "collections.createRecord": { call: "collections.createRecord(path, { name, fields? }, options?)", returns: "the new record's id and path", does: "Creates a record in a Collection.", needs: "collections.edit" },
  "collections.watch": { call: "collections.watch(collectionPath, listener, options?)", returns: "a function that stops the watch", does: "Reports record changes at or below `collectionPath`, at most once each. Read record history to catch up on missed events.", needs: "collections.read" },
  "provenance.record": { call: "provenance.record(summary, options?)", returns: "nothing", does: "Records a summary of what the caller did. `summary` is a string or `{ summary, ... }`.", needs: "provenance.record" },
};

// --- Rendering ---------------------------------------------------------------

function jsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  return z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema;
}

function branches(schema: JsonSchema): JsonSchema[] | undefined {
  return schema.oneOf ?? schema.anyOf;
}

function typeText(schema: JsonSchema): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  const union = branches(schema);
  if (union) return union.map(typeText).join(" | ");
  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type;
  switch (type) {
    case "string":
      if (schema.format === "uuid") return "UUID";
      if (schema.pattern === "^[a-f0-9]{64}$") return "SHA-256 hex";
      return "string";
    case "array": {
      const item = schema.items ? typeText(schema.items) : "any JSON";
      return item.includes(" ") ? `(${item})[]` : `${item}[]`;
    }
    case "object":
      if (schema.properties) {
        const required = new Set(schema.required ?? []);
        const fields = Object.entries(schema.properties).map(
          ([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${typeText(value)}`,
        );
        return `{ ${fields.join(", ")} }`;
      }
      if (typeof schema.additionalProperties === "object") {
        return `{ [key: string]: ${typeText(schema.additionalProperties)} }`;
      }
      return "object";
    case undefined:
      return "any JSON";
    default:
      return type;
  }
}

function argumentList(schema: JsonSchema, omit: readonly string[] = [], alsoRequired: readonly string[] = []): string {
  const required = new Set([...(schema.required ?? []), ...alsoRequired]);
  const entries = Object.entries(schema.properties ?? {}).filter(([key]) => !omit.includes(key));
  if (entries.length === 0) return "No arguments.";
  return entries
    .map(([key, value]) => `- \`${key}\`: \`${typeText(value)}\`${required.has(key) ? ". Required." : ""}`)
    .join("\n");
}

function isObjectLike(schema: JsonSchema): boolean {
  if (schema.properties) return true;
  if (schema.type === "array" && schema.items) return isObjectLike(schema.items);
  return branches(schema)?.some(isObjectLike) ?? false;
}

// Keys only, one level of nesting deep: enough to find a field, short enough
// to read.
function shapeText(schema: JsonSchema, depth = 1): string {
  const union = branches(schema);
  if (union) return union.map((branch) => shapeText(branch, depth)).join(" | ");
  if (schema.type === "array" && schema.items) {
    const item = shapeText(schema.items, depth);
    return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
  }
  if (schema.type === "null") return "null";
  if (!schema.properties) return typeText(schema);
  const required = new Set(schema.required ?? []);
  const discriminators = ["ok", "kind", "action"];
  const entries = Object.entries(schema.properties).sort(
    ([left], [right]) => Number(discriminators.includes(right)) - Number(discriminators.includes(left)),
  );
  const fields = entries.map(([key, value]) => {
    const name = `${key}${required.has(key) ? "" : "?"}`;
    if (value.const !== undefined) return `${name}: ${JSON.stringify(value.const)}`;
    if (depth > 0 && isObjectLike(value)) return `${name}: ${shapeText(value, depth - 1)}`;
    return name;
  });
  return `{ ${fields.join(", ")} }`;
}

function kindBranch(union: JsonSchema, key: string, value: string): JsonSchema {
  const found = branches(union)?.find((branch) => branch.properties?.[key]?.const === value);
  if (!found) throw new Error(`No result branch has ${key} ${value}.`);
  return found;
}

function returnsLine(shapes: string[]): string {
  return `Returns ${shapes.map((shape) => `\`${shape}\``).join(" or ")}.`;
}

interface ListedTool {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}

async function listTools(shareAccess?: "view"): Promise<{ tools: ListedTool[]; version: string }> {
  const server = createDohcMcpServer({ root: "/workspace", home: "/home", ...(shareAccess ? { shareAccess } : {}) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "dohc-reference", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return {
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as JsonSchema })),
      version: client.getServerVersion()?.version ?? "unknown",
    };
  } finally {
    await client.close();
    await server.close();
  }
}

export async function mcpToolNames(): Promise<string[]> {
  return (await listTools()).tools.map((tool) => tool.name);
}

async function mcpSection(): Promise<{ text: string; version: string }> {
  const { tools, version } = await listTools();
  const shared = new Set((await listTools("view")).tools.map((tool) => tool.name));
  const parts = tools.map((tool) => {
    const returns = MCP_RETURNS[tool.name];
    if (returns === undefined) throw new Error(`MCP_RETURNS has no entry for ${tool.name}.`);
    const returnsText = typeof returns === "string"
      ? `Returns ${returns.replace(/\.?$/, ".")}`
      : returnsLine([shapeText(jsonSchema(cliResultSchemas[returns.cli], "output"))]);
    const args = tool.name === "dohc_dataset"
      ? "- `request`: one of the [dataset actions](#dataset-actions), with its `action`. Required."
      : argumentList(tool.inputSchema);
    return [
      `### \`${tool.name}\``,
      tool.description ?? "",
      shared.has(tool.name) ? "" : "Changes the workspace, so a shared view does not offer it.",
      args,
      returnsText,
    ].filter(Boolean).join("\n\n");
  });
  return { text: parts.join("\n\n"), version };
}

// The request schema's action branches, in the table's reading order. Vitest
// does not typecheck, so a branch the table lacks throws here as well.
function actionBranches<Action extends string>(requests: JsonSchema, table: Record<Action, unknown>): [Action, JsonSchema][] {
  const byAction = new Map((branches(requests) ?? []).map((branch) => [String(branch.properties?.action?.const), branch]));
  const order = Object.keys(table) as Action[];
  const missing = [...byAction.keys()].filter((action) => !order.includes(action as Action));
  if (missing.length > 0 || order.length !== byAction.size) throw new Error(`The reference table and schema differ: ${missing.join(", ")}`);
  return order.map((action) => [action, byAction.get(action)!]);
}

function datasetSection(): string {
  const requests = jsonSchema(DatasetRequest, "input");
  const results = jsonSchema(DatasetResult, "output");
  return actionBranches(requests, DATASET_ACTIONS).map(([action, branch]) => {
    const entry = DATASET_ACTIONS[action];
    return [
      `### \`${action}\``,
      entry.does,
      argumentList(branch, ["action"], entry.required),
      returnsLine(entry.returns.map((kind) => shapeText(kindBranch(results, "kind", kind)))),
    ].join("\n\n");
  }).join("\n\n");
}

function appSection(): string {
  const requests = jsonSchema(OwnerAppPublicationRequest, "input");
  const results = jsonSchema(OwnerAppPublicationResult, "output");
  const publications = actionBranches(requests, APP_ACTIONS).map(([action, branch]) => {
    const entry = APP_ACTIONS[action];
    return [
      `#### \`dohc app ${action}\``,
      entry.does,
      argumentList(branch, ["action"]),
      returnsLine(entry.returns.map((kind) => shapeText(kindBranch(results, "kind", kind)))),
    ].join("\n\n");
  });
  const responseRequests = jsonSchema(OwnerAppResponsesRequest, "input");
  const responseResults = jsonSchema(OwnerAppResponsesResult, "output");
  const responses = actionBranches(responseRequests, APP_RESPONSE_VERBS).map(([action, branch]) => {
    const entry = APP_RESPONSE_VERBS[action];
    return [
      `#### \`dohc app ${entry.verb}\``,
      entry.does,
      argumentList(branch, ["action"]),
      returnsLine([shapeText(kindBranch(responseResults, "action", action))]),
    ].join("\n\n");
  });
  return [...publications, ...responses].join("\n\n");
}

function chatSection(): string {
  return Object.entries(CLI_VERBS).flatMap(([verb, entry]) => {
    if (typeof entry === "string") return [];
    const result = jsonSchema(cliResultSchemas[verb as CliVerb], "output");
    const flags = entry.flags
      ? Object.entries(entry.flags).map(([flag, meaning]) => `- \`${flag}\`: ${meaning}`).join("\n")
      : "";
    const shapes = (branches(result) ?? [result]).map((branch) => shapeText(branch).replace(/^\{ /, "{ schemaVersion, "));
    return [[
      `#### \`${entry.usage.split(" ").slice(0, 3).join(" ")}\``,
      "```sh\n" + entry.usage + "\n```",
      entry.does,
      flags,
      `With \`--json\`, prints ${shapes.map((shape) => `\`${shape}\``).join(" or ")}.`,
    ].filter(Boolean).join("\n\n")];
  }).join("\n\n");
}

function appChannelSection(): string {
  return APP_CHANNEL_REQUESTS.map(({ example, does, returns }) => {
    const { op, ...fields } = example;
    const keys = Object.keys(fields).map((key) => `\`${key}\``);
    return [
      `### \`${String(op)}\``,
      does,
      `Fields: ${keys.join(", ")}.`,
      `Answers ${returns.replace(/\.?$/, ".")}`,
    ].join("\n\n");
  }).join("\n\n");
}

function sdkSection(): string {
  return Object.values(SDK_METHODS).map(({ call, returns, does, needs }) =>
    `- \`${call}\` returns ${returns}. ${does}${needs ? ` Needs the \`${needs}\` capability.` : ""}`,
  ).join("\n");
}

export async function renderReference(): Promise<string> {
  const mcp = await mcpSection();
  return `# CLI, MCP, and SDK reference

<!-- Generated by packages/mcp/src/reference.ts. Change that file or the definitions it reads, then run:
pnpm --filter @dohc/mcp exec vitest run src/reference.test.ts -u -->

Agents and developers use this page to work with dohc from outside the app. It lists every MCP tool, \`dohc\` command, app channel request, and \`@dohc/sdk\` method, with its arguments and what it returns.

## Connect

- **MCP.** In dohc, open **Settings**, then **Agents & MCP**. Choose **Enable MCP**, then copy the **MCP config** into your agent's MCP settings. The server works on one workspace.
- **CLI.** The \`dohc\` command talks to the running dohc app, so keep dohc open. Run it inside the workspace folder. Agents that dohc starts have it on their \`PATH\`.
- **Share links.** A share link has its own MCP endpoint with fewer tools. The [share-web README](../../services/share-web/README.md) says how an agent connects to it.

## Versions and changes

Agent prompts and scripts depend on these names. Before launch, a rename replaces the old name outright, with no alias.

- The MCP server reports its version as \`${mcp.version}\`. A rename or removal of a tool, argument, or result field raises it.
- \`--json\` output carries \`schemaVersion: ${CLI_JSON_SCHEMA_VERSION}\`. A change to the shape of that output raises it.
- The CLI and the app must be the same build. Otherwise the CLI stops with \`CLI/app version mismatch — restart the app\`.

A tool or command that cannot do what was asked returns \`{ ok: false, reason }\`, or exits with status 1 and prints the reason. MCP marks such a result as an error.

## MCP tools

${mcp.text}

## CLI

\`\`\`sh
dohc [--as-agent] [--json] <chat | dataset | app> <verb> [arguments]
\`\`\`

- \`--as-agent\` acts as the agent instead of the person. Setting \`DOHC_CHAT_ACTOR=agent\` does the same for \`dohc chat\`.
- \`--json\` prints the result as JSON instead of text.
- \`DOHC_RUN_ID\` links the messages that \`post\` and \`reply\` write to a local agent run.
- \`DOHC_STATE_DIR\` names the app's state folder when the CLI cannot find the running app in its default place.

### \`dohc chat\`

Reads and writes the workspace's chats.

${chatSection()}

### \`dohc dataset\`

\`\`\`sh
dohc dataset <action> '<JSON>'
\`\`\`

Takes one of the [dataset actions](#dataset-actions). The JSON holds the action's arguments. It can leave out \`action\`, because the command names it. \`dohc dataset --help\` prints a summary.

### \`dohc app\`

\`\`\`sh
dohc app <action> '<JSON>'
\`\`\`

The JSON holds the action's arguments.

${appSection()}

## Dataset actions

\`dohc dataset <action>\` and the \`dohc_dataset\` tool take the same actions and return the same results. Every action names the \`workspaceId\` that owns the Collection. Run \`describe\` to find table, field, and operation ids.

${datasetSection()}

## App channel

An app page reads and changes its Collection through the app channel. The channel works in two places: a published app opened from a share link, and a local app opened with \`dohc app launchLocal\`. An app open in a dohc tab has no channel.

When the page loads, its parent window posts \`{ kind: "dohc-app-channel", version: 1 }\` with one \`MessagePort\`. The page keeps that port and posts each request to it as \`{ id, op, ...fields }\`. \`id\` is 1 to 64 letters, digits, \`_\`, or \`-\`, and no two requests in flight share one. The port answers \`{ id, ok: true, value }\`, or \`{ id, ok: false, status }\` with status 400, 404, 409, 413, 429, or 503. At most four requests can wait at once.

The app calls only the operations its owner approved when publishing it. \`app.publish.json\` names them under \`dataset.operationIds\`. The page never sends a workspace, user, or revision, because the host supplies them.

${appChannelSection()}

## SDK

\`@dohc/sdk\` is the client that plugin panels use. The [SDK README](../../packages/sdk/README.md) shows how to load it. Each \`options\` argument takes \`signal\` and \`timeoutMs\`. A method that needs a capability throws \`DOHC_CAPABILITY_DISABLED\` when the host turns it off.

${sdkSection()}
`;
}
