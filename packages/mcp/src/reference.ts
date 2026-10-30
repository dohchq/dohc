// Renders docs/reference/cli-mcp-sdk.md. MCP tool names, arguments, and
// descriptions come from the running desktop MCP server. CLI verbs, flags,
// summaries, and fields come from CLI_COMMANDS, the table `dohc --help`
// prints. Result shapes come from the CLI's zod schemas. This file adds only
// what those lack: which result each verb returns, what each MCP tool
// returns and the app channel. reference.test.ts fails when any of
// them drifts.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import { CLI_COMMANDS, DASH_RULE, GLOBAL_FLAGS, type CliCommandSpec, type CliFlag, type CliVerbSpec } from "@dohc/cli/args";
import { DatasetResult, type DatasetRequest } from "@dohc/cli/dataset";
import { OwnerAppPublicationResult, type OwnerAppPublicationRequest } from "@dohc/cli/app-publication";
import { OwnerAppResponsesResult, type OwnerAppResponsesRequest } from "@dohc/cli/app-responses";
import { CLI_JSON_SCHEMA_VERSION, cliResultSchemas, type CliVerb as CliSocketVerb } from "@dohc/cli/protocol";
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

// The result kinds the desktop answers each `dohc dataset` verb with
// (apps/desktop/src/ipc/datasetIpc.ts). A new action fails typecheck here.
export const DATASET_RESULTS: Record<DatasetAction, DatasetKind[]> = {
  list: ["list"],
  describe: ["description"],
  history: ["history"],
  historyRevision: ["history-revision"],
  prepareHistoryRestore: ["migration-prepared"],
  permissions: ["permissions"],
  setGrant: ["grant-updated"],
  removeGrant: ["grant-updated"],
  lifecycle: ["lifecycle"],
  archive: ["lifecycle-updated"],
  restore: ["lifecycle-updated"],
  deletePreview: ["delete-preview"],
  delete: ["deleted"],
  pendingAttempts: ["pending-attempts"],
  reconcileAttempt: ["attempt-reconciled"],
  cancelAttempt: ["attempt-cancelled"],
  export: ["exported"],
  prepareRecovery: ["recovery-prepared"],
  claimRecovery: ["recovery-claimed"],
  discardRecovery: ["recovery-discarded"],
  upload: ["uploaded"],
  file: ["file"],
  createForm: ["form-created", "partial"],
  prepareRelationChoices: ["migration-prepared"],
  create: ["approved"],
  prepare: ["prepared"],
  approve: ["approved"],
  discard: ["discarded"],
  prepareMigration: ["migration-prepared"],
  migrationPreviewPage: ["migration-preview-page"],
  prepareSchemaChange: ["migration-prepared"],
  approveMigration: ["migrated"],
  discardMigration: ["migration-discarded"],
  invoke: ["invoked", "refused"],
};

// `dohc app` verbs that publish apps, keyed by verb, with the result kinds
// apps/desktop/src/ipc/ownerAppPublicationIpc.ts and
// localOwnerAppPublication.ts answer with.
export const APP_RESULTS: Record<AppAction, AppKind[]> = {
  createLink: ["linkCreated", "urlUnavailable"],
  listLocal: ["localListed"],
  prepareLocal: ["prepared"],
  launchLocal: ["localLaunched"],
  list: ["listed"],
  prepare: ["prepared"],
  approve: ["published"],
  cancel: ["cancelled"],
  withdraw: ["withdrawn", "withdrawalUnconfirmed"],
  revokeCollection: ["collectionRevoked", "withdrawalUnconfirmed"],
  reviewReactivation: ["prepared"],
};

// `dohc app` verbs that read link holders' responses, keyed by verb, with
// the response action each one sends.
export const APP_RESPONSE_RESULTS: Record<string, OwnerAppResponsesRequest["action"]> = {
  responses: "list",
  "undo-responses": "undo",
};

// The socket verb whose result each `dohc history` verb prints.
export const HISTORY_RESULTS: Record<string, CliSocketVerb> = {
  operation: "historyOperation", undo: "historyUndo",
  list: "moments",
  show: "moment",
};

export const VERSION_RESULTS: Record<string, CliSocketVerb> = {
  list: "versionList", compare: "versionCompare", conflicts: "versionConflicts",
  create: "versionCreate", switch: "versionSwitch", merge: "versionMerge", resolve: "versionResolve",
};

export const SYNC_RESULTS: Record<string, CliSocketVerb> = { stop: "stopSync" };
const SHARE_RESULTS: Record<string, CliSocketVerb> = { copy: "shareCopy" };

export const ACCESS_RESULTS: Record<string, CliSocketVerb> = {
  refresh: "accessRefresh",
  object: "accessObject",
  sharing: "accessSharing",
};

const ACCESS_NOTES = [
  "The object and sharing verbs return only the allowlisted AccessAnswer fields shown below, with at most 100 rows per page. They never return credentials, bearer URLs, invitation URLs, share codes, or link URLs.",
  "Share queries use the current observation. Use `dohc access refresh` to request fresh Sharing inventories through the same paced owner as opening Sharing. Its `status` is `requested`, `joined`, `paced`, or `unavailable`. Unavailable answers include `reason`: `signed-out` or `unreadable`. Requested and joined wait for started or existing attempts to settle, without promising success. Paced follows the existing refresh schedule. Read `dohc access sharing` afterward to inspect observations. `freshness` is `fresh`, `stale`, or `unknown`; `checkedAtMs` is the observation timestamp in milliseconds, or null when unknown. `coverage` names the observed scope and whether it is complete. Its `observation` is `interval`: pages do not form an atomic snapshot. `nextCursor` continues the answer, or is null at the end.",
  "`unknownReason` is null when coverage is known. When visibility is `hidden` or `missing`, it is null because visibility states why the answer is unavailable. Every other answer with `coverage.kind` set to `unavailable` requires one reason. Its closed values are `signed-out`, `not-synced`, `other-account`, `other-server`, `not-listed-yet`, `changed`, and `unreadable`. Reasons describe only this device's records and account. They contain no account identity, email, server URL, share id, or path.",
  "Queries use only the CLI's registered workspace, with no workspace enumeration. The granted lane contains that workspace owner's grants; the received lane contains the signed-in account's received shares. A received object's answer shows only the recipient's own grant.",
  "Collection answers report current access and capabilities, not share grants.",
].join("\n\n");

export const ACCOUNT_RESULTS: Record<string, CliSocketVerb> = {
  deletePreview: "accountDeletePreview",
  delete: "accountDelete",
};

const DOCUMENT_RESULTS: Record<string, CliSocketVerb> = {
  read: "documentRead", edit: "documentEdit", create: "documentCreate", chats: "fileChats", comment: "fileChatStart",
  "live-status": "liveDocuments", "retry-live": "retryLiveDocument",
  "kept-edits": "liveKeptEdits", "save-recovery-copy": "saveRecoveryCopy", "retry-kept-edits": "retryKeptEdits", "stop-again": "stopAgain",
};

// The socket verb whose result each `dohc automation` verb prints.
export const AUTOMATION_RESULTS: Record<string, CliSocketVerb> = {
  list: "automationList",
  switch: "automationSwitch",
  buttons: "automationButtons",
  runs: "automationRuns",
  run: "automationRun",
  retry: "automationRetry",
  press: "automationPress",
};

// Command lines for every `dohc chat` verb. reference.test.ts parses each one
// and requires every flag the verb declares to appear in its examples.
export const CHAT_EXAMPLES: Record<string, string[][]> = {
  links: [["chat","links","general","--cursor","sealed"]],
  "file-mentions": [["chat", "file-mentions", "--subject", '{"path":"notes/plan.md"}', "--cursor", "sealed"]],
  groups: [["chat", "groups"]],
  threads: [["chat", "threads", "general"]],
  inbox: [["chat", "inbox"]],
  show: [["chat", "show", "th_1", "--peek"], ["chat", "show", "general", "--before", "1730000000000:posts:th_1", "--limit", "20"]],
  post: [["chat", "post", "general", "--title", "Plan", "--attach", "notes.md", "--needs-decision", "--option", "Yes", "--option", "No", "Ship", "it?"]],
  reply: [
    ["chat", "reply", "th_1", "--to", "msg_1", "--attach", "notes.md", "--needs-decision", "--option", "A", "Which?"],
    ["chat", "reply", "th_1", "--resolve", "msg_2", "--choose", "Yes", "Done"],
  ],
  react: [["chat", "react", "msg_1", "👍"]],
  grep: [["chat", "grep", "--group", "general", "--thread", "th_1", "--from", "agent", "--since", "7d", "-i", "-l", "-C", "2", "--limit", "10", "--regex", "launch"]],
  export: [
    ["chat", "export", "--all", "--out", "exports"],
    ["chat", "export", "--group", "general", "--out", "exports"],
    ["chat", "export", "--thread", "th_1", "--out", "exports"],
  ],
};

// What each MCP tool returns. A CLI verb means the tool passes on that
// verb's result schema; a string is written from the tool in tools.ts.
export const MCP_RETURNS: Record<string, { cli: CliSocketVerb } | string> = {
  dohc_chat_links:{cli:"chatLinks"},
  dohc_chat_file_mentions: { cli: "chatFileMentions" },
  dohc_links_edges: { cli: "linksEdges" },
  dohc_links_in: { cli: "linksIn" },
  dohc_links_resolve: { cli: "linksResolve" },
  dohc_read_share_copy: { cli: "shareCopy" },
  dohc_dataset: "what that verb returns, listed under [`dohc dataset`](#dohc-dataset).",
  dohc_publish_app: "the requested action's result, listed under [`dohc app`](#dohc-app). Only `createLink` returns a bearer link `url` once, in `linkCreated`. `urlUnavailable` includes `grantId` so the owner can end it in dohc. Shared approval returns `published` with `appQuery` (`?app=<publicationId>`), never the link URL. Append `appQuery` before the fragment of any link URL, including one returned by `createLink`. Keep the link secret yourself.",
  dohc_list_workspaces: "`{ workspaces: { workspaceId, rootPath, kind, remote? }[] }`",
  dohc_stop_workspace_sync: { cli: "stopSync" },
  dohc_workspace_status: "`{ synced, scope, cloudConnected, credentialStatus, collectionsWaiting?, keptEdits?, workspaceId?, serverUrl?, syncPause? }`. `scope` is `\"local\"` or `\"cloud\"`. `collectionsWaiting` is `true` while Collection updates wait for a sync that has not finished. Files and documents still save. To continue offline, stop sync. `keptEdits` lists `{ path, reason, incident, recovery, saveOnly?: true }` for each live document whose edits the server refused. Pass them to dohc_save_recovery_copy, dohc_retry_kept_edits or dohc_stop_again. When saveOnly is true, save a recovery copy instead. If recovery is unreadable, retry reads the edits again. A shared view has no `keptEdits`. Both fields are absent when the dohc app cannot answer.",
  dohc_list_changes: { cli: "moments" },
  dohc_read_change: { cli: "moment" },
  dohc_read_operation: { cli: "historyOperation" },
  dohc_undo_operation: { cli: "historyUndo" },
  dohc_list_versions: { cli: "versionList" },
  dohc_compare_version: { cli: "versionCompare" },
  dohc_list_version_conflicts: { cli: "versionConflicts" },
  dohc_create_version: { cli: "versionCreate" },
  dohc_switch_version: { cli: "versionSwitch" },
  dohc_merge_version: { cli: "versionMerge" },
  dohc_resolve_version_conflict: { cli: "versionResolve" },
  dohc_list_files: "`{ ok: true, root, entries: { path, kind, bytes?, mediaType? }[] }`",
  dohc_read_file: "`{ ok: true, path, mediaType, encoding, bytes, offsetBytes, sha256, truncated, content }`",
  dohc_list_kept_copies: { cli: "keptCopies" },
  dohc_save_kept_copy: { cli: "saveKeptCopy" },
  dohc_save_recovery_copy: { cli: "saveRecoveryCopy" },
  dohc_retry_kept_edits: { cli: "retryKeptEdits" },
  dohc_stop_again: { cli: "stopAgain" },
  dohc_live_documents: {cli: "liveDocuments"},
  dohc_retry_live_document: {cli: "retryLiveDocument"},
  dohc_list_retained_copies: { cli: "retainedCopies" },
  dohc_delete_retained_copies: { cli: "deleteRetainedCopies" },
  dohc_read_document: { cli: "documentRead" },
  dohc_edit_document: { cli: "documentEdit" },
  dohc_create_document: { cli: "documentCreate" },
  dohc_search_files: "`{ ok: true, query, root, mode, matches: { type, path, mediaType?, line?, column?, preview }[], matchCount, limitHit, skipped: { path, reason }[] }`",
  dohc_write_file: "`{ ok: true, path, bytes, sha256 }`. Uses the desktop `fileWrite` verb. On failure: `{ ok: false, reason, written?, path?, currentSha256? }`. `written` lists published files in a partial batch.",
  dohc_create_directory: "`{ ok: true, path }`, or `{ ok: true, path, unchanged: true }` when the folder exists.",
  dohc_duplicate_file: { cli: "fileDuplicate" },
  dohc_move_path: "`{ ok: true, operationId, fromPath, toPath, withoutHistory?, replaced? }`. Uses the desktop `fileMove` verb. `withoutHistory` lists moved files with no History row: oversized files or non-UTF-8 text that History cannot keep as binary. `replaced` describes the old destination separately: `{ path, trashed, trashPath?, withoutHistory }`. `trashed` is true when the system trash took it; otherwise `trashPath` names its workspace trash entry. `replaced.withoutHistory` lists replaced files without History copies; other replaced files can be restored in History. On failure: `{ ok: false, reason, path?, deleted?, withoutHistory?, replaced? }`. The reason reports rollback's outcome. `withoutHistory` names moved files without History rows after rollback. `replaced` reports any old destination files retained in the workspace trash. `deleted` lists files History records as deleted after the failed move. They stay in the workspace's .dohc/local/trash.",
  dohc_delete_path: "`{ ok: true, operationId, undo, path, trashed, trashPath?, withoutHistory? }`. Uses the desktop `fileDelete` verb. `trashed` is true when the system trash took the entry; otherwise `trashPath` names its workspace trash entry. `withoutHistory` lists files deleted without History rows: oversized files or non-UTF-8 text that History cannot keep as binary. On failure: `{ ok: false, reason, deleted?, path?, withoutHistory? }`. `deleted` lists files History recorded as deleted before it refused `path`. `withoutHistory` names files already removed without History rows. The reason names their workspace trash location.",
  dohc_detect_apps: "`{ ok: true, apps: { root, title, kind, confidence, entry?, packageManager?, scripts, configuredPreviewMode?, buildOutputs, configPath?, diagnostics }[], count, detector }`",
  dohc_create_app: "`{ ok: true, appRoot, files }`, or `{ ok: false, reason, written?, path?, currentSha256? }`. `written` lists files published before the first failure.",
  dohc_test_app: "`{ ok, app, checks: { name, ok, message?, path? }[] }`. `ok` is true when every check passes.",
  dohc_import_data: "`{ ok: true, path, tableName, rowCount }`",
  dohc_query_database: "`{ ok: true, rows }`, with at most 1,000 rows.",
  dohc_list_file_chats: { cli: "fileChats" },
  dohc_read_chat: { cli: "chat" },
  dohc_list_groups: { cli: "groupsFull" },
  dohc_start_group_chat: "`{ ok: true, group: { id, slug, kind }, threadId, messageId, title, warning? }`",
  dohc_start_file_chat: { cli: "fileChatStart" },
  dohc_reply_to_chat: "`{ ok: true, threadId, messageId, parentMessageId?, resolvedMessageId?, warning? }`",
  dohc_query_collection: { cli: "collectionQuery" },
  dohc_read_record: { cli: "collectionRecord" },
  dohc_set_record_fields: { cli: "collectionSetFields" },
  dohc_create_record: { cli: "collectionCreateRecord" },
  dohc_list_automations: { cli: "automationList" },
  dohc_switch_automation: { cli: "automationSwitch" },
  dohc_list_automation_runs: { cli: "automationRuns" },
  dohc_read_automation_run: { cli: "automationRun" },
  dohc_retry_automation_run: { cli: "automationRetry" },
  dohc_press_button: { cli: "automationPress" },
  dohc_inspect_buttons: { cli: "automationButtons" },
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

async function listTools(shareAccess?: ShareAccess): Promise<{ tools: ListedTool[]; version: string }> {
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

export async function mcpToolNames(shareAccess?: ShareAccess): Promise<string[]> {
  return (await listTools(shareAccess)).tools.map((tool) => tool.name);
}

// Why a shared view does not offer a tool that reads. Every other tool it
// does not offer changes the workspace.
const NOT_SHARED_READS: Record<string, string> = {
  dohc_live_documents: "Live document status requires the owning workspace. Shared profiles do not offer this read.",
  dohc_read_operation: "Operation reads require the owning workspace. Shared profiles do not offer this read.",
  dohc_read_share_copy: "The code and invite link belong to the owner's sharing. Shared profiles do not offer this read.",
  dohc_list_automation_runs: "A shared view keeps no automation runs, so it does not offer this tool.",
  dohc_read_automation_run: "A shared view keeps no automation runs, so it does not offer this tool.",
  dohc_list_retained_copies: "A shared view keeps no old file copies, so it does not offer this tool.",
  dohc_list_versions: "A shared view keeps no versions of its own, so it does not offer this tool.",
  dohc_compare_version: "A shared view keeps no versions of its own, so it does not offer this tool.",
  dohc_list_version_conflicts: "A shared view keeps no versions of its own, so it does not offer this tool.",
};

async function mcpSection(): Promise<{ text: string; version: string }> {
  const { tools, version } = await listTools();
  const sharedTools = (await listTools("view")).tools;
  const commentTools = (await listTools("comment")).tools;
  const editableTools = (await listTools("edit")).tools;
  const owned = new Set(tools.map((tool) => tool.name));
  const shared = new Set(sharedTools.map((tool) => tool.name));
  const allTools = new Map([...tools, ...sharedTools, ...commentTools, ...editableTools].map((tool) => [tool.name, tool]));
  const parts = [...allTools.values()].map((tool) => {
    const shareLevels = ([["view", sharedTools], ["comment", commentTools], ["edit", editableTools]] as const)
      .filter(([, registered]) => registered.some((entry) => entry.name === tool.name))
      .map(([access]) => access);
    const returns = MCP_RETURNS[tool.name];
    if (returns === undefined) throw new Error(`MCP_RETURNS has no entry for ${tool.name}.`);
    const returnsText = typeof returns === "string"
      ? `Returns ${returns.replace(/\.?$/, ".")}`
      : returnsLine([shapeText(jsonSchema(cliResultSchemas[returns.cli], "output"))]);
    const args = tool.name === "dohc_dataset"
      ? "- `request`: the JSON object of one [`dohc dataset`](#dohc-dataset) verb, with the verb's name as `action`. Required."
      : argumentList(tool.inputSchema);
    return [
      `### \`${tool.name}\``,
      tool.description ?? "",
      !owned.has(tool.name) ? `Available only in a shared workspace with ${shareLevels.join(" or ")} access.`
        : shared.has(tool.name) ? "" : NOT_SHARED_READS[tool.name] ?? "Changes the workspace, so a shared view does not offer it.",
      args,
      returnsText,
    ].filter(Boolean).join("\n\n");
  });
  return { text: parts.join("\n\n"), version };
}

function resultShapes(results: JsonSchema, key: string, values: readonly string[]): string[] {
  return values.map((value) => shapeText(kindBranch(results, key, value)));
}

function checkCovered(command: string, verbs: readonly string[], documented: readonly string[]): void {
  const missing = verbs.filter((verb) => !documented.includes(verb));
  const extra = documented.filter((verb) => !verbs.includes(verb));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`dohc ${command}: no result for ${missing.join(", ") || "none"}; no verb for ${extra.join(", ") || "none"}.`);
  }
}

function flagList(flags: readonly CliFlag[]): string {
  return flags.map((flag) => `- \`${flag.value ? `${flag.name} <${flag.value}>` : flag.name}\`: ${flag.text}`).join("\n");
}

function shellBlock(line: string): string {
  return "```sh\n" + line + "\n```";
}

// What a verb returns. Chat, history, Access, automation, and account verbs print their socket verb's
// result; the JSON verbs of `dataset` and `app` return the result kinds
// listed above.
function verbReturns(command: string, name: string): string {
  const socketVerb = command === "file" && name === "duplicate" ? "fileDuplicate" : command === "links"
    ? ({ edges: "linksEdges", in: "linksIn", resolve: "linksResolve" } as const)[name as "edges" | "in" | "resolve"]
    : command === "chat"
    ? name === "links" ? "chatLinks" : name === "file-mentions" ? "chatFileMentions" : name
    : command === "history"
      ? HISTORY_RESULTS[name]
      : command === "document"
        ? DOCUMENT_RESULTS[name]
        : command === "automation" ? AUTOMATION_RESULTS[name]
          : command === "access" ? ACCESS_RESULTS[name]
            : command === "sync" ? SYNC_RESULTS[name] : command === "share" ? SHARE_RESULTS[name]
              : command === "version" ? VERSION_RESULTS[name]
              : command === "account" ? ACCOUNT_RESULTS[name] : undefined;
  if (socketVerb !== undefined) {
    if (!Object.hasOwn(cliResultSchemas, socketVerb)) throw new Error(`dohc ${command} ${name} has no result schema.`);
    const result = jsonSchema(cliResultSchemas[socketVerb as CliSocketVerb], "output");
    // Refusals exit with their reason instead of printing JSON.
    const printed = (branches(result) ?? [result])
      .filter((branch) => !["file", "history", "version", "document", "automation", "sync", "account"].includes(command) || branch.properties?.ok?.const !== false);
    const shapes = printed.map((branch) => shapeText(branch).replace(/^\{ /, "{ schemaVersion, "));
    const socketNote = command === "access" ? ` Uses socket verb \`${socketVerb}\`.` : "";
    return `With \`--json\`, prints ${shapes.map((shape) => `\`${shape}\``).join(" or ")}.${socketNote}`;
  }
  if (command === "dataset") {
    return returnsLine(resultShapes(jsonSchema(DatasetResult, "output"), "kind", DATASET_RESULTS[name as DatasetAction]));
  }
  if (command === "app") {
    const responses = APP_RESPONSE_RESULTS[name];
    if (responses) return returnsLine(resultShapes(jsonSchema(OwnerAppResponsesResult, "output"), "action", [responses]));
    return returnsLine(resultShapes(jsonSchema(OwnerAppPublicationResult, "output"), "kind", APP_RESULTS[name as AppAction]));
  }
  throw new Error(`The reference has no results for dohc ${command}.`);
}

function verbSection(command: string, name: string, verb: CliVerbSpec): string {
  const details = [
    ...(verb.take ?? []).map((source) => `Set \`${source.field}\` to \`${source.path}\` from \`${source.from}\`.`),
    ...(verb.notes ?? []),
    ...(verb.freeText ? [`Put ${DASH_RULE}.`] : []),
  ];
  return [
    `#### \`dohc ${command} ${name}\``,
    verb.fields ? "" : shellBlock(["dohc", command, name, verb.operands, "[options]"].filter(Boolean).join(" ")),
    verb.summary,
    details.join(" "),
    verb.flags ? flagList(verb.flags) : "",
    verb.fields ? argumentList(jsonSchema(z.object(verb.fields), "input"), ["action"], verb.required) : "",
    verbReturns(command, name),
  ].filter(Boolean).join("\n\n");
}

function commandSection(name: string, command: CliCommandSpec): string {
  const verbs = Object.entries(command.verbs);
  if (name === "dataset") checkCovered(name, Object.keys(command.verbs), Object.keys(DATASET_RESULTS));
  if (name === "app") checkCovered(name, Object.keys(command.verbs), [...Object.keys(APP_RESULTS), ...Object.keys(APP_RESPONSE_RESULTS)]);
  if (name === "history") checkCovered(name, Object.keys(command.verbs), Object.keys(HISTORY_RESULTS));
  if (name === "document") checkCovered(name, Object.keys(command.verbs), Object.keys(DOCUMENT_RESULTS));
  if (name === "automation") checkCovered(name, Object.keys(command.verbs), Object.keys(AUTOMATION_RESULTS));
  if (name === "version") checkCovered(name, Object.keys(command.verbs), Object.keys(VERSION_RESULTS));
  if (name === "sync") checkCovered(name, Object.keys(command.verbs), Object.keys(SYNC_RESULTS));
  if (name === "share") checkCovered(name, Object.keys(command.verbs), Object.keys(SHARE_RESULTS));
  if (name === "access") checkCovered(name, Object.keys(command.verbs), Object.keys(ACCESS_RESULTS));
  if (name === "account") checkCovered(name, Object.keys(command.verbs), Object.keys(ACCOUNT_RESULTS));
  const jsonOperands = [...new Set(verbs.filter(([, verb]) => verb.fields).map(([, verb]) => verb.operands))];
  return [
    `### \`dohc ${name}\``,
    jsonOperands.length > 0 ? shellBlock(`dohc ${name} <verb> ${jsonOperands.join(" | ")}`) : "",
    command.summary,
    command.notes.join(" "),
    name === "access" ? ACCESS_NOTES : "",
    name === "links" ? "`indexBuilding` is true while the link index is being built: seed work, pending updates, or eligible files without an index row. It carries across cursor pages; start a fresh walk to observe completion. `unchecked` names sources that could not be checked, including oversized files. These can keep `complete` false after building stops. `complete` describes the local index; `mountsCovered` separately reports mounted-share coverage. IPC, CLI, and MCP return these same fields." : "",
    name === "sync" ? "The pause result records who paused and when. A person author has kind person, personId, and self. Show you when self is true. Person pause labels do not use profile names. An agent author has kind agent, agentId, onBehalfOf, and depth. Agent names are provenance and grant no authority." : "",
    ...verbs.map(([verbName, verb]) => verbSection(name, verbName, verb)),
  ].filter(Boolean).join("\n\n");
}

function cliSection(): string {
  return Object.entries(CLI_COMMANDS).map(([name, command]) => commandSection(name, command)).join("\n\n");
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

export async function renderReference(): Promise<string> {
  const mcp = await mcpSection();
  return `# CLI, MCP, and app channel reference

<!-- Generated by packages/mcp/src/reference.ts. Change that file or the definitions it reads, then run:
pnpm --filter @dohc/mcp exec vitest run src/reference.test.ts -u -->

Agents and developers use this page to work with dohc from outside the app. It lists every tool of the desktop MCP server, every \`dohc\` command, and every app channel request, with its arguments and what it returns.

## Connect

- **MCP.** In dohc, open **Settings**, then **Agents**. Copy the **MCP config** into your agent's MCP settings. The server works on one workspace.
- **CLI.** The \`dohc\` command talks to the running dohc app, so keep dohc open. Run it inside the workspace folder. Agents that dohc starts have it on their \`PATH\`.
- **Share links.** A share link has its own MCP server, \`dohc-share\`, with other tools. This page does not list them. The [share-web README](../../services/share-web/README.md) says how an agent connects to it.

## Versions and changes

Agent prompts and scripts depend on these names. Before launch, a rename replaces the old name outright, with no alias.

- The desktop MCP server reports its version as \`${mcp.version}\`. A rename or removal of a tool, argument, or result field raises it.
- \`--json\` output carries \`schemaVersion: ${CLI_JSON_SCHEMA_VERSION}\`. A change to the shape of that output raises it.
- The CLI and the app must be the same build. Otherwise the CLI stops with \`CLI/app version mismatch — restart the app\`.

A tool or command that cannot do what was asked returns \`{ ok: false, reason }\`, or exits with status 1 and prints the reason. MCP marks such a result as an error.

Partial form creation returns \`{ kind: "partial", created, failedStage, reason, retry }\`. The CLI exits with status 1 and keeps the structured output. MCP marks the result as an error and keeps its structured content.

## Desktop MCP tools

${mcp.text}

## CLI

\`\`\`sh
dohc <command> <verb> [arguments] [options]
\`\`\`

\`dohc --help\`, \`dohc <command> --help\`, and \`dohc <command> <verb> --help\` print the same summaries, flags, and fields as this section. These options work with every verb:

${flagList(GLOBAL_FLAGS)}

Two environment variables also change what the CLI does:

- \`DOHC_RUN_ID\` links the messages that \`post\` and \`reply\` write to a local agent run.
- \`DOHC_STATE_DIR\` names the app's state folder when the CLI cannot find the running app in its default place.

On Windows, dohc starts a chat agent with \`NoDefaultCurrentDirectoryInExePath=1\`, so in cmd the agent must run a program in the workspace folder as \`.\\name\`, not by its bare name.

${cliSection()}

## App channel

An app page reads and changes its Collection through the app channel. The channel works in two places: a published app opened from a share link, and a local app opened with \`dohc app launchLocal\`. An app open in a dohc tab has no channel.

When the page loads, its parent window posts \`{ kind: "dohc-app-channel", version: 1 }\` with one \`MessagePort\`. The page keeps that port and posts each request to it as \`{ id, op, ...fields }\`. \`id\` is 1 to 64 letters, digits, \`_\`, or \`-\`, and no two requests in flight share one. The port answers \`{ id, ok: true, value }\`, or \`{ id, ok: false, status }\` with status 400, 404, 409, 413, 429, or 503. At most four requests can wait at once.

The app calls only the operations its owner approved when publishing it. \`app.publish.json\` names them under \`dataset.operationIds\`. The page never sends a workspace, user, or revision, because the host supplies them.

${appChannelSection()}
`;
}
