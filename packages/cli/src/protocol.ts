import { ChatLinksInput, ChatLinksPage } from "@dohc/workspace-contracts/chat-links";
import { ChatFileMentionsInput, ChatFileMentionsPage } from "@dohc/workspace-contracts/chat-file-mentions";
import { LinksEdgesInput, LinksEdgesResult, LinksInInput, LinksResolveInput, LinksInResult, LinksResolveResult } from "@dohc/workspace-contracts/links";
import type { CapabilityId } from "@dohc/workspace-contracts/capabilities";
import {
  COLLECTION_SCHEMA_REASON_CODES,
  FIELD_VALUE_REASON_CODES,
} from "@dohc/workspace-contracts/collection";
import { z } from "zod";
import {FirstOpenOwnerStatus} from "@dohc/workspace-contracts/first-open-wire";
import { ShareCopyInput, ShareCopyResult } from "@dohc/workspace-contracts/share-copy";
import { AccessAnswer, AccessRefreshResult, ObjectAccessInput, SharingAccessInput } from "@dohc/workspace-contracts/access";
import { WORKSPACE_POLICY_PATHS } from "@dohc/security-contract/effective-policy";
import type { AutomationDefinitionList, AutomationSwitchResult } from "@dohc/workspace-contracts/automation-controls";
import { CreationPartial } from "./creation";
import { DATASET_CAPABILITIES, DatasetRequest, DatasetResult } from "./dataset";
import { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "./appPublication";
import {OwnerAppResponsesRequest,OwnerAppResponsesResult} from "./appResponses";
import { ServerAccountDeletionPreview, ServerAccountDeleteRequest, ServerAccountDeleteResult } from "./account";

import { OperationRecovery, HistoryOperationId, HistoryOperationReadResult, HistoryOperationUndoResult } from "@dohc/workspace-contracts/history-operation";
import { WorkspaceSyncPauseStatus } from "@dohc/workspace-contracts/workspace-sync";

export const CLI_PROTOCOL_VERSION = 5;
export const CLI_JSON_SCHEMA_VERSION = 3;

// Who runs a CLI command. The CLI never writes as an automation.
const cliActorSchema = z.enum(["human", "agent"]);
export type CliActor = z.infer<typeof cliActorSchema>;
// Who wrote a message the CLI reads back. Only the relay writes a link author.
const cliAuthorKindSchema = z.enum(["human", "agent", "automation", "link"]);

const requestBase = {
  token: z.string().regex(/^[a-f0-9]{64}$/),
  protocolVersion: z.literal(CLI_PROTOCOL_VERSION),
  // Caller-reported, unverified attribution; grants no authority.
  door: z.enum(["cli", "mcp"]).optional(),
};

const argsBase = {
  cwd: z.string().min(1),
  actor: cliActorSchema,
};

const historyOperationArgsSchema = z.object({ ...argsBase, operationId: HistoryOperationId, cursor: z.string().optional() }).strict();
const historyUndoArgsSchema = z.object({ ...argsBase, operationId: HistoryOperationId, agent: z.string().min(1).max(200).optional() }).strict();

const groupsArgsSchema = z.object(argsBase).strict();
const threadsArgsSchema = z
  .object({ ...argsBase, group: z.string().min(1) })
  .strict();
const inboxArgsSchema = z.object(argsBase).strict();
// Where a group's stream page ends: an item's time, lane and id.
const streamPositionSchema = z
  .object({
    createdAtMs: z.number().int().nonnegative(),
    lane: z.enum(["posts", "chat"]),
    id: z.string().min(1).max(200),
  })
  .strict();
export type CliStreamPosition = z.infer<typeof streamPositionSchema>;
const streamPageArgs = {
  before: streamPositionSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
// A thread or message shows that thread; a group shows its stream.
const showArgsSchema = z
  .object({ ...argsBase, target: z.string().min(1), peek: z.boolean(), ...streamPageArgs })
  .strict();
const postArgsSchema = z
  .object({
    ...argsBase,
    runId: z.string().min(1).optional(),
    group: z.string().min(1),
    title: z.string().min(1).optional(),
    attachments: z.array(z.string().min(1)),
    needsDecision: z.boolean(),
    options: z.array(z.string().min(1)).max(12).optional(),
    body: z.string().min(1),
  })
  .strict();
const replyArgsSchema = z
  .object({
    ...argsBase,
    runId: z.string().min(1).optional(),
    thread: z.string().min(1),
    to: z.string().min(1).optional(),
    attachments: z.array(z.string().min(1)),
    needsDecision: z.boolean(),
    options: z.array(z.string().min(1)).max(12).optional(),
    resolve: z.string().min(1).optional(),
    choose: z.string().min(1).optional(),
    body: z.string().min(1),
  })
  .strict();
const reactArgsSchema = z
  .object({
    ...argsBase,
    runId: z.string().min(1).optional(),
    message: z.string().min(1),
    emoji: z.string().min(1),
  })
  .strict();
const grepArgsSchema = z
  .object({
    ...argsBase,
    pattern: z.string().min(1),
    group: z.string().min(1).optional(),
    thread: z.string().min(1).optional(),
    from: z.string().min(1).optional(),
    since: z.string().min(1).optional(),
    ignoreCase: z.boolean(),
    filesWithMatches: z.boolean(),
    context: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    regex: z.boolean(),
  })
  .strict();
const exportScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("group"), group: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("thread"), thread: z.string().min(1) }).strict(),
]);
const exportArgsSchema = z
  .object({
    ...argsBase,
    scope: exportScopeSchema,
    outDir: z.string().min(1),
  })
  .strict();
const momentsArgsSchema = z
  .object({
    ...argsBase,
    sinceMs: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(500).optional(),
    includeFiles: z.boolean().optional(),
    path: z.string().min(1).max(4096).optional(),
  })
  .strict();
const momentArgsSchema = z
  .object({ ...argsBase, id: z.string().min(1).max(500) })
  .strict();
const fileChatsArgsSchema = z
  .object({ ...argsBase, path: z.string().min(1).max(4096) })
  .strict();
const chatArgsSchema = z.union([
  z.object({ ...argsBase, threadId: z.string().min(1).max(200) }).strict(),
  z.object({ ...argsBase, group: z.string().min(1).max(500), ...streamPageArgs }).strict(),
]);
const groupsFullArgsSchema = z.object(argsBase).strict();
export const chatLinksGroupInputSchema = ChatLinksInput.omit({ channelWireId: true }).extend({
  group: z.string().min(1).max(500),
}).strict();

const documentPathArg = z.string().min(1).max(4096);
// Each side of an edit is at most 256 KiB as UTF-8. The socket still refuses a
// request line over 14 MiB, which JSON escaping of both sides can reach.
const MAX_DOCUMENT_EDIT_BYTES = 256 * 1024;
function fitsUtf8Bytes(value: string, limit: number): boolean {
  if (value.length > limit) return false;
  return value.length * 3 <= limit || new TextEncoder().encode(value).length <= limit;
}
export const documentEditTextSchema = z
  .string()
  .refine((value) => fitsUtf8Bytes(value, MAX_DOCUMENT_EDIT_BYTES), {
    message: "Document edit text is at most 256 KiB as UTF-8.",
  });
// A name the calling agent gives itself, recorded as the author of its edits.
// A slash is refused so no name can pass for an automation's id.
export const documentAgentNameSchema = z
  .string()
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u);
const documentReadArgsSchema = z
  .object({ ...argsBase, path: documentPathArg })
  .strict();
// A key the caller chooses for one request. Sent again with the same key,
// after a timeout for example, the request returns its first result while
// dohc runs instead of doing its work twice.
export const requestIdSchema = z.string().min(1).max(64).regex(/^[\x20-\x7e]+$/u);

export const MAX_FILE_WRITE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_WRITE_FILES = 256;
export const MAX_CLI_REQUEST_BYTES = 14 * 1024 * 1024;
const fileWriteFileSchema = z.object({
  path: documentPathArg,
  contentBase64: z.string(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  createOnly: z.boolean().optional(),
}).strict();
export type CliFileWrite = z.infer<typeof fileWriteFileSchema>;
const fileWriteArgsSchema = z.object({
  ...argsBase,
  files: z.array(fileWriteFileSchema).min(1).max(MAX_FILE_WRITE_FILES),
  agent: documentAgentNameSchema.optional(),
  requestId: requestIdSchema,
}).strict();
const fileMoveArgsSchema = z.object({
  ...argsBase,
  fromPath: documentPathArg,
  toPath: documentPathArg,
  overwrite: z.boolean().optional(),
  agent: documentAgentNameSchema.optional(),
  requestId: requestIdSchema,
}).strict();
const fileDuplicateArgsSchema = z.object({...argsBase, path: documentPathArg, agent: documentAgentNameSchema.optional(), requestId: requestIdSchema}).strict();
const fileDeleteArgsSchema = z.object({
  ...argsBase,
  path: documentPathArg,
  agent: documentAgentNameSchema.optional(),
  requestId: requestIdSchema,
}).strict();

const versionListArgsSchema = z.object(argsBase).strict();
// `version` is a version's name or id, as version list prints them.
const versionCompareArgsSchema = z.object({
  ...argsBase,
  version: z.string().min(1).max(200),
  afterPath: z.string().min(1).max(4096).optional(),
}).strict();
const versionConflictsArgsSchema = z.object({ ...argsBase, afterConflictId: z.string().min(1).max(200).optional() }).strict();
// The versions menu's name field takes at most 80 characters.
export const MAX_VERSION_NAME_LENGTH = 80;
const versionCreateArgsSchema = z.object({ ...argsBase, name: z.string().min(1).max(MAX_VERSION_NAME_LENGTH) }).strict();
const versionSwitchArgsSchema = z.object({ ...argsBase, version: z.string().min(1).max(200) }).strict();
const versionMergeArgsSchema = versionSwitchArgsSchema;
// Keep one side of a conflict, or replace both with combined text. Combined
// text replaces the file, so it has the file write limit.
export const versionResolutionSchema = z.discriminatedUnion("keep", [
  z.object({ keep: z.enum(["current", "incoming"]) }).strict(),
  z.object({
    keep: z.literal("combined"),
    text: z.string().refine((value) => fitsUtf8Bytes(value, MAX_FILE_WRITE_BYTES), {
      message: "Combined text is at most 10 MiB as UTF-8.",
    }),
  }).strict(),
]);
export type VersionResolution = z.infer<typeof versionResolutionSchema>;
const versionResolveArgsSchema = z.object({
  ...argsBase,
  conflictId: z.string().min(1).max(200),
  resolution: versionResolutionSchema,
}).strict();

const keptCopiesArgsSchema = z.object(argsBase).strict();
const saveKeptCopyArgsSchema = z
  .object({ ...argsBase, id: z.number().int() })
  .strict();
// Old file copies kept on a drive that cannot tell dohc whether a program
// still has one open. A delete takes at most 100 listed copies and must
// accept that a program still using one may lose what it writes next.
const MAX_RETAINED_COPIES_PER_DELETE = 100;
const retainedCopySchema = z.object({ id: z.number().int(), revision: z.number().int() }).strict();
const retainedCopiesArgsSchema = z.object(argsBase).strict();
const deleteRetainedCopiesArgsSchema = z
  .object({
    ...argsBase,
    copies: z.array(retainedCopySchema).max(MAX_RETAINED_COPIES_PER_DELETE),
    acceptLateWriteRisk: z.literal(true),
  })
  .strict();

// Edits the server refused for good that this computer keeps for a live
// document, found by the document's path. Try again and Stop again name the
// refusal they answer, so a newer one is read before either runs. Save
// recovery copy may name one, to save exactly those edits.
const liveKeptEditsArgsSchema = z.object(argsBase).strict();
const keptEditsIncidentSchema = z.string().min(1).max(1024);
const saveRecoveryCopyArgsSchema = z.object({ ...argsBase, path: documentPathArg, incident: keptEditsIncidentSchema.optional() }).strict();
const retryKeptEditsArgsSchema = z
  .object({ ...argsBase, path: documentPathArg, incident: keptEditsIncidentSchema })
  .strict();
const stopAgainArgsSchema = retryKeptEditsArgsSchema;

const documentEditArgsSchema = z
  .object({
    ...argsBase,
    agent: documentAgentNameSchema.optional(),
    requestId: requestIdSchema.optional(),
    path: documentPathArg,
    find: documentEditTextSchema.min(1).optional(),
    replacement: documentEditTextSchema,
  })
  .strict();
const documentCreateArgsSchema = z
  .object({
    ...argsBase,
    agent: documentAgentNameSchema.optional(),
    path: documentPathArg,
    markdown: documentEditTextSchema,
  })
  .strict();
// A comment on a file: a chat linked to it, started with its first message.
const fileChatStartArgsSchema = z
  .object({
    ...argsBase,
    agent: documentAgentNameSchema.optional(),
    requestId: requestIdSchema.optional(),
    runId: z.string().min(1).optional(),
    path: documentPathArg,
    title: z.string().min(1).max(200),
    body: z.string().min(1),
  })
  .strict();

// Collection field values cross the CLI socket in the engine wire's JSON
// encoding: an integer outside the safe double range rides a `$dohcInt64` /
// `$dohcFloat64` marker object. The desktop translates with the
// workspace-engine-client codec; this schema only bounds the JSON shape.
type CliCollectionWireValue =
  | null
  | boolean
  | number
  | string
  | CliCollectionWireValue[]
  | { [key in string]?: CliCollectionWireValue };

const collectionWireValueSchema: z.ZodType<CliCollectionWireValue> =
  z.lazy(() =>
    z.union([
      z.null(),
      z.boolean(),
      z.number(),
      z.string(),
      z.array(collectionWireValueSchema),
      z.record(z.string(), collectionWireValueSchema),
    ]),
  );

const collectionPathArg = z.string().min(1).max(4096);
const collectionFieldNameArg = z.string().min(1).max(200);
// The engine owns record ids; the CLI only bounds the claim.
const collectionRecordIdArg = z.string().min(1).max(200);
const MAX_COLLECTION_QUERY_SORTS = 8;
const MAX_COLLECTION_FIELD_WRITES = 64;

export const collectionQueryFilterSchema = z
  .object({
    field: collectionFieldNameArg,
    operator: z.enum(["equals", "contains"]),
    value: collectionWireValueSchema,
  })
  .strict();
const collectionQuerySortSchema = z
  .object({
    field: collectionFieldNameArg,
    direction: z.enum(["asc", "desc"]),
  })
  .strict();
const collectionMaybeValueSchema = z
  .object({ present: z.boolean(), value: collectionWireValueSchema })
  .strict();
export const collectionQueryCursorSchema = z
  .object({
    sortValues: z.array(collectionMaybeValueSchema).max(MAX_COLLECTION_QUERY_SORTS),
    recordPath: collectionPathArg,
    recordId: collectionRecordIdArg,
  })
  .strict();
export type CliCollectionQueryCursor = z.infer<typeof collectionQueryCursorSchema>;
const collectionQueryArgsSchema = z
  .object({
    ...argsBase,
    collectionPath: collectionPathArg,
    filter: collectionQueryFilterSchema.optional(),
    sort: z.array(collectionQuerySortSchema).max(MAX_COLLECTION_QUERY_SORTS).optional(),
    groupBy: collectionFieldNameArg.optional(),
    resolveRelations: z.boolean().optional(),
    limit: z.number().int().positive().max(500).optional(),
    cursor: collectionQueryCursorSchema.optional(),
  })
  .strict();
const collectionRecordArgsSchema = z
  .object({
    ...argsBase,
    collectionPath: collectionPathArg,
    recordId: collectionRecordIdArg,
    historyLimit: z.number().int().positive().max(500),
    beforeHistoryId: z.number().int().nonnegative().optional(),
  })
  .strict();
// Field writes carry PLAIN JSON values, not the marker encoding: they land in
// the record's frontmatter Y.Doc map, which holds JSON. The engine-owned "id"
// key is refused before the request leaves the client.
function boundedCollectionFields(minimumFields: number) {
  return z
    .record(collectionFieldNameArg, collectionWireValueSchema)
    .refine(
      (fields) => {
        const count = Object.keys(fields).length;
        return count >= minimumFields && count <= MAX_COLLECTION_FIELD_WRITES;
      },
      {
        message: `a field write names ${
          minimumFields > 0 ? "1" : "0"
        } to ${MAX_COLLECTION_FIELD_WRITES} fields`,
      },
    )
    .refine((fields) => !("id" in fields), {
      message: 'the "id" field is engine-owned',
    });
}
export const collectionSetFieldsFieldsSchema = boundedCollectionFields(1);
export const collectionCreateFieldsSchema = boundedCollectionFields(0);
const collectionSetFieldsArgsSchema = z
  .object({
    ...argsBase,
    agent: documentAgentNameSchema.optional(),
    recordPath: collectionPathArg,
    fields: collectionSetFieldsFieldsSchema,
  })
  .strict();
const collectionCreateRecordArgsSchema = z
  .object({
    ...argsBase,
    agent: documentAgentNameSchema.optional(),
    collectionPath: collectionPathArg,
    // One file name inside the collection folder, without the .md extension.
    name: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (value) =>
          !value.includes("/") && !value.includes("\\") && value.trim() === value,
        { message: "a record name is one file name, not a path" },
      ),
    fields: collectionCreateFieldsSchema,
    recordId: z.string().regex(/^rec_[a-z2-7]{26}$/).optional(),
  })
  .strict();

// An automation, named by its Collection's folder and its id in that
// Collection's automations.yaml, and one of its runs by the run's id.
const automationArgs = {
  ...argsBase,
  collectionPath: collectionPathArg,
  automation: z.string().min(1).max(200),
};
const automationRunIdArg = z.string().min(1).max(256);
const automationListArgsSchema = z.object({ ...argsBase, collectionPath: collectionPathArg }).strict();
const automationSwitchArgsSchema = z.object({ ...automationArgs, enabled: z.boolean(),
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/u), reformat: z.boolean(), submitId: requestIdSchema,
}).strict();
// `page` is the `next` of an earlier listing: the runs older than it.
// `server` reads the runs of the workspace's self-hosted server instead of
// this computer's.
const automationRunsArgsSchema = z.object({ ...automationArgs, page: z.string().min(1).max(512).optional(), server: z.boolean().optional() }).strict();
const automationRunArgsSchema = z
  .object({ ...automationArgs, run: automationRunIdArg, server: z.boolean().optional() })
  .strict();
// `startOver` confirms running an automation that changed since the run
// failed, or a run whose progress is gone, from its first step.
const automationRetryArgsSchema = z
  .object({ ...automationArgs, run: automationRunIdArg, startOver: z.boolean() })
  .strict();
// A press of a Button field on one record. `record` is a document record's
// id, or a dataset record's primary key as JSON. `confirm` names the actions
// dohc cannot undo that the caller chose to run. A `requestId` sent again
// answers the same press instead of pressing twice.
const automationPressArgsSchema = z
  .object({
    ...argsBase,
    collectionPath: collectionPathArg,
    field: z.string().min(1).max(256),
    record: z.string().min(1).max(1024),
    table: z.string().min(1).max(256).optional(),
    confirm: z.array(z.string().min(1).max(256)).max(64),
    requestId: requestIdSchema.optional(),
  })
  .strict();

// The account verbs act on the server account the app is connected to, from
// any folder. The password travels only in this request, never in argv.
const accountDeletePreviewArgsSchema = z.object(argsBase).strict();
const accountDeleteArgsSchema = ServerAccountDeleteRequest.extend(argsBase).strict();

export const cliRequestSchema = z.discriminatedUnion("verb", [
  z.object({ ...requestBase, verb: z.literal("chatLinks"), args: z.union([
    ChatLinksInput.extend(argsBase).strict(), chatLinksGroupInputSchema.extend(argsBase).strict(),
  ]) }).strict(),
  z.object({ ...requestBase, verb: z.literal("chatFileMentions"), args: ChatFileMentionsInput.extend(argsBase).strict() }).strict(),
  z.object({ ...requestBase, verb: z.literal("linksEdges"), args: LinksEdgesInput.extend(argsBase).strict() }).strict(),
  z.object({ ...requestBase, verb: z.literal("linksIn"), args: LinksInInput.extend(argsBase).strict() }).strict(),
  z.object({ ...requestBase, verb: z.literal("linksResolve"), args: LinksResolveInput.extend(argsBase).strict() }).strict(),
  z.object({ ...requestBase, verb: z.literal("stopSync"), args: z.object({ ...argsBase, agent: documentAgentNameSchema.optional() }).strict() }).strict(),
  z.object({ ...requestBase, verb: z.literal("shareCopy"), args: ShareCopyInput.extend(argsBase).strict() }).strict(),
  z.object({ ...requestBase, verb: z.literal("accountDeletePreview"), args: accountDeletePreviewArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("accountDelete"), args: accountDeleteArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("accessRefresh"), args: z.object(argsBase).strict() }).strict(),
  z.object({ ...requestBase, verb: z.literal("accessObject"), args: ObjectAccessInput.extend(argsBase).strict() }).strict(),
  z.object({ ...requestBase, verb: z.literal("accessSharing"), args: SharingAccessInput.extend(argsBase).strict() }).strict(),
  z.object({ ...requestBase, verb: z.literal("automationButtons"), args: z.object({ ...argsBase, collectionPath: collectionPathArg, table: z.string().min(1).max(256).optional() }).strict() }).strict(),
  z.object({ ...requestBase, verb: z.literal("dataset"), args: z.object({ ...argsBase, request: DatasetRequest }).strict() }).strict(),
  z.object({ ...requestBase, verb: z.literal("appPublication"), args: z.object({ ...argsBase, request: OwnerAppPublicationRequest }).strict() }).strict(),
  z.object({ ...requestBase, verb: z.literal("ownerAppResponses"), args: z.object({ ...argsBase, request: OwnerAppResponsesRequest }).strict() }).strict(),
  z.object({ ...requestBase, verb: z.literal("groups"), args: groupsArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("threads"), args: threadsArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("inbox"), args: inboxArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("show"), args: showArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("post"), args: postArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("reply"), args: replyArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("react"), args: reactArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("grep"), args: grepArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("export"), args: exportArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("moments"), args: momentsArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("moment"), args: momentArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("fileChats"), args: fileChatsArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("chat"), args: chatArgsSchema }).strict(),
  z.object({
    ...requestBase,
    verb: z.literal("groupsFull"),
    args: groupsFullArgsSchema,
  }).strict(),
  z.object({
    ...requestBase,
    verb: z.literal("collectionQuery"),
    args: collectionQueryArgsSchema,
  }).strict(),
  z.object({
    ...requestBase,
    verb: z.literal("collectionRecord"),
    args: collectionRecordArgsSchema,
  }).strict(),
  z.object({
    ...requestBase,
    verb: z.literal("collectionSetFields"),
    args: collectionSetFieldsArgsSchema,
  }).strict(),
  z.object({
    ...requestBase,
    verb: z.literal("collectionCreateRecord"),
    args: collectionCreateRecordArgsSchema,
  }).strict(),
  z.object({ ...requestBase, verb: z.literal("fileWrite"), args: fileWriteArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("historyOperation"), args: historyOperationArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("historyUndo"), args: historyUndoArgsSchema }).strict(),
  z.object({...requestBase, verb: z.literal("fileDuplicate"), args: fileDuplicateArgsSchema}).strict(),
  z.object({ ...requestBase, verb: z.literal("fileMove"), args: fileMoveArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("fileDelete"), args: fileDeleteArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("documentRead"), args: documentReadArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("versionList"), args: versionListArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("versionCompare"), args: versionCompareArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("versionConflicts"), args: versionConflictsArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("versionCreate"), args: versionCreateArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("versionSwitch"), args: versionSwitchArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("versionMerge"), args: versionMergeArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("versionResolve"), args: versionResolveArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("keptCopies"), args: keptCopiesArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("collectionsWaiting"), args: z.object(argsBase).strict() }).strict(),
  z.object({ ...requestBase, verb: z.literal("saveKeptCopy"), args: saveKeptCopyArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("retainedCopies"), args: retainedCopiesArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("deleteRetainedCopies"), args: deleteRetainedCopiesArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("liveDocuments"), args: liveKeptEditsArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("retryLiveDocument"), args: z.object({...argsBase, path: documentPathArg}).strict() }).strict(),
  z.object({ ...requestBase, verb: z.literal("liveKeptEdits"), args: liveKeptEditsArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("saveRecoveryCopy"), args: saveRecoveryCopyArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("retryKeptEdits"), args: retryKeptEditsArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("stopAgain"), args: stopAgainArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("documentEdit"), args: documentEditArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("documentCreate"), args: documentCreateArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("fileChatStart"), args: fileChatStartArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("automationRuns"), args: automationRunsArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("automationList"), args: automationListArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("automationSwitch"), args: automationSwitchArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("automationRun"), args: automationRunArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("automationRetry"), args: automationRetryArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("automationPress"), args: automationPressArgsSchema }).strict(),
]);

export type CliRequest = z.infer<typeof cliRequestSchema>;
export type CliVerb = CliRequest["verb"];

export const APP_PUBLICATION_CAPABILITIES = {
  createLink: "app.link.create",
  listLocal: "app.local.list",
  prepareLocal: "app.local.prepare",
  launchLocal: "app.local.launch",
  list: "app.publication.list",
  prepare: "app.publication.prepare",
  approve: "app.publication.approve",
  cancel: "app.publication.cancel",
  withdraw: "app.publication.withdraw",
  revokeCollection: "app.collection.revoke",
  reviewReactivation: "app.publication.reactivation.review",
} as const satisfies Record<OwnerAppPublicationRequest["action"], CapabilityId>;

export const APP_RESPONSE_CAPABILITIES = {
  list: "app.responses.list",
  undo: "app.responses.undo",
} as const satisfies Record<OwnerAppResponsesRequest["action"], CapabilityId>;

export const CLI_CAPABILITIES = {
  stopSync: ["workspace.sync.stop"],
  chatLinks: ["chat.read"],
  chatFileMentions: ["chat.read"],
  linksEdges: ["links.edges"],
  linksIn: ["links.in"],
  linksResolve: ["links.resolve"],
  shareCopy: ["share.copy.read"],
  accountDeletePreview: ["account.delete.preview"],
  accountDelete: ["account.delete"],
  accessRefresh: ["access.refresh"],
  accessObject: ["access.object.read"],
  accessSharing: ["access.sharing.read"],
  groups: ["group.list"],
  threads: ["chat.threads.list"],
  inbox: ["chat.inbox.read"],
  show: ["chat.show"],
  post: ["chat.post"],
  reply: ["chat.reply"],
  react: ["chat.react"],
  grep: ["chat.search"],
  export: ["chat.export"],
  moments: ["history.list"],
  historyOperation: ["history.operation.read"],
  historyUndo: ["history.operation.undo"],
  moment: ["history.read"],
  fileChats: ["file.chats.list"],
  chat: ["chat.read"],
  groupsFull: ["group.list"],
  collectionQuery: ["collection.query"],
  collectionRecord: ["collection.record.read"],
  collectionSetFields: ["collection.record.edit"],
  collectionCreateRecord: ["collection.record.create"],
  fileWrite: ["file.write"],
  fileDuplicate: ["file.duplicate"],
  fileMove: ["file.move"],
  fileDelete: ["file.delete"],
  documentRead: ["document.read"],
  versionList: ["version.list"],
  versionCompare: ["version.compare"],
  versionConflicts: ["version.conflicts.list"],
  versionCreate: ["version.create"],
  versionSwitch: ["version.switch"],
  versionMerge: ["version.merge"],
  versionResolve: ["version.conflict.resolve"],
  keptCopies: ["file.kept.list"],
  collectionsWaiting: ["workspace.status"],
  saveKeptCopy: ["file.kept.save"],
  retainedCopies: ["file.retained.list"],
  deleteRetainedCopies: ["file.retained.delete"],
  liveDocuments: ["share.live.documents.list"],
  retryLiveDocument: ["share.live.document.resume"],
  liveKeptEdits: ["workspace.status"],
  saveRecoveryCopy: ["share.live.document.recovery.save"],
  retryKeptEdits: ["share.live.document.retry"],
  stopAgain: ["share.live.document.stop"],
  documentEdit: ["document.edit"],
  documentCreate: ["document.create"],
  fileChatStart: ["file.chat.start"],
  automationRuns: ["automation.runs.list"],
  automationList: ["automation.list"],
  automationSwitch: ["automation.switch"],
  automationRun: ["automation.run.read"],
  automationRetry: ["automation.run.retry"],
  automationPress: ["automation.button.press"],
  automationButtons: ["automation.buttons.inspect"],
  dataset: Object.values(DATASET_CAPABILITIES),
  appPublication: Object.values(APP_PUBLICATION_CAPABILITIES),
  ownerAppResponses: Object.values(APP_RESPONSE_CAPABILITIES),
} as const satisfies Record<CliVerb, readonly CapabilityId[]>;

export type CliRequestWithoutToken = CliRequest extends infer Request
  ? Request extends CliRequest
    ? Omit<Request, "token">
    : never
  : never;

const cliGroupSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    kind: z.enum(["group", "dm", "agent"]),
    purpose: z.string().min(1).optional(),
  })
  .strict();
export type CliGroup = z.infer<typeof cliGroupSchema>;

const cliAuthorSchema = z
  .object({
    kind: cliAuthorKindSchema,
    displayName: z.string().min(1),
  })
  .strict();
export type CliAuthor = z.infer<typeof cliAuthorSchema>;

const cliThreadSummarySchema = z
  .object({
    lane: z.enum(["posts", "chat"]).optional(),
    id: z.string().min(1),
    title: z.string(),
    commentCount: z.number().int().nonnegative(),
    openDecisionCount: z.number().int().nonnegative(),
    unread: z.boolean(),
    updatedAtMs: z.number().int().nonnegative(),
  })
  .strict();

const cliInboxThreadSchema = cliThreadSummarySchema
  .extend({ group: cliGroupSchema })
  .strict();

const cliInboxMentionSchema = z
  .object({
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    group: cliGroupSchema,
    author: cliAuthorSchema,
    createdAtMs: z.number().int().nonnegative(),
    text: z.string(),
  })
  .strict();

const cliAttachmentSchema = z
  .object({
    objectId: z.string().min(1).optional(),
    pathHint: z.string().min(1).optional(),
  })
  .strict();

// Where one agent's request to answer a message stands. Finished requests
// are left out.
const agentRequestSchema = z
  .object({
    agentId: z.string().min(1),
    state: z.enum(["waiting", "running", "failed"]),
    runId: z.string().min(1).optional(),
    startedAtMs: z.number().int().nonnegative().optional(),
    failureReason: z.string().min(1).optional(),
    exitCode: z.number().int().optional(),
    logPath: z.string().min(1).optional(),
  })
  .strict();

const cliShowMessageSchema = z
  .object({
    id: z.string().min(1),
    author: cliAuthorSchema,
    body: z.string(),
    createdAtMs: z.number().int().nonnegative(),
    parentMessageId: z.string().min(1).optional(),
    decisionState: z.enum(["open", "resolved"]).optional(),
    decisionOptions: z.array(z.string()).optional(),
    decisionChosenOption: z.string().optional(),
    attachments: z.array(cliAttachmentSchema),
    runId: z.string().min(1).optional(),
    agentRequests: z.array(agentRequestSchema).optional(),
  })
  .strict();
export type CliShowMessage = z.infer<typeof cliShowMessageSchema>;

const cliShowThreadSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    group: cliGroupSchema,
    commentCount: z.number().int().nonnegative(),
    openDecisionCount: z.number().int().nonnegative(),
  })
  .strict();

const cliGrepContextMessageSchema = z
  .object({
    messageId: z.string().min(1),
    author: cliAuthorSchema,
    createdAtMs: z.number().int().nonnegative(),
    text: z.string(),
  })
  .strict();
export type CliGrepContextMessage = z.infer<typeof cliGrepContextMessageSchema>;

const cliGrepMatchSchema = z
  .object({
    group: cliGroupSchema,
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    author: cliAuthorSchema,
    createdAtMs: z.number().int().nonnegative(),
    text: z.string(),
    contextBefore: z.array(cliGrepContextMessageSchema),
    contextAfter: z.array(cliGrepContextMessageSchema),
  })
  .strict();
export type CliGrepMatch = z.infer<typeof cliGrepMatchSchema>;

const groupsResultSchema = z
  .object({ groups: z.array(cliGroupSchema.extend({ channelWireId: z.string().min(1).max(500).nullable().optional() }).strict()) })
  .strict();
const threadsResultSchema = z
  .object({
    group: cliGroupSchema,
    threads: z.array(cliThreadSummarySchema),
  })
  .strict();
const inboxResultSchema = z
  .object({
    threads: z.array(cliInboxThreadSchema),
    mentions: z.array(cliInboxMentionSchema),
  })
  .strict();
const threadDispatchSchema = z.object({
  paused: z.literal("budget").nullable(),
  lastRun: z.object({
    state: z.enum(["running", "completed", "failed"]),
    failureReason: z.string().nullable(),
    exitCode: z.number().int().nullable(),
  }).strict().nullable(),
}).strict();

const showThreadResultSchema = z
  .object({
    thread: cliShowThreadSchema,
    dispatch: threadDispatchSchema,
    messages: z.array(cliShowMessageSchema),
  })
  .strict();
export type CliShowThreadResult = z.infer<typeof showThreadResultSchema>;

// A group's posts and conversation messages in one order, oldest first. A
// post carries what its thread holds beyond its first message.
function streamSchema<Group extends z.ZodType, Message extends z.ZodType>(group: Group, message: Message) {
  return z
    .object({
      group,
      items: z.array(z.object({
        position: streamPositionSchema,
        threadId: z.string().min(1),
        message,
        post: z.object({
          replyCount: z.number().int().nonnegative(),
          repliers: z.array(z.object({ author: cliAuthorSchema, lastReplyAtMs: z.number().int().nonnegative() }).strict()),
          lastReplyAtMs: z.number().int().nonnegative().optional(),
          latestAgentReply: z.object({
            id: z.string().min(1),
            author: cliAuthorSchema,
            createdAtMs: z.number().int().nonnegative(),
            bodyExcerpt: z.string(),
          }).strict().optional(),
          openDecisionCount: z.number().int().nonnegative(),
        }).strict().optional(),
      }).strict()),
      // Pass as `before` to read the older page. Null at the oldest item.
      nextBefore: streamPositionSchema.nullable(),
      // The newest item the person has read.
      readPosition: streamPositionSchema.nullable(),
    })
    .strict();
}

const showResultSchema = z.union([
  showThreadResultSchema,
  z.object({ stream: streamSchema(cliGroupSchema, cliShowMessageSchema) }).strict(),
]);
const postResultSchema = z
  .object({
    group: cliGroupSchema,
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    title: z.string(),
    warning: z.string().min(1).optional(),
  })
  .strict();
const replyResultSchema = z
  .object({
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    parentMessageId: z.string().min(1).optional(),
    resolvedMessageId: z.string().min(1).optional(),
    warning: z.string().min(1).optional(),
  })
  .strict();
const reactResultSchema = z
  .object({
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    emoji: z.string().min(1),
    state: z.enum(["added", "removed"]),
  })
  .strict();
const grepResultSchema = z.union([
  z.object({ matches: z.array(cliGrepMatchSchema) }).strict(),
  z.object({ threadIds: z.array(z.string().min(1)) }).strict(),
]);
const exportResultSchema = z
  .object({
    files: z.array(
      z
        .object({
          threadId: z.string().min(1),
          path: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

const rawMomentAuthorSchema = z.union([
  z.object({ kind: z.literal("unattributed") }).strict(),
  z.object({
    kind: z.literal("agent"),
    agentId: z.string().min(1),
    agentName: z.string().min(1).optional(),
    onBehalfOf: z.string().min(1).optional(),
    agentRunId: z.string().min(1).optional(),
    // Named only past 0, by a run an automation started.
    depth: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    kind: z.literal("human"),
    humanId: z.string().min(1),
    humanName: z.string().min(1).max(500).optional(),
    relayConfirmed: z.literal(true).optional(),
    onBehalfOf: z.string().min(1).optional(),
  }).strict(),
  // A live author snapshot's account holder or link holder, as the relay admitted them.
  z.object({
    kind: z.literal("human"),
    humanId: z.string().min(1),
    humanName: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("link"),
    publicPrincipalId: z.string().min(1),
    label: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("public"),
    principalId: z.string().min(1),
    grantId: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("named"),
    userId: z.string().min(1),
    grantId: z.string().min(1),
    grantGeneration: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal("link"),
    grantId: z.string().min(1),
    grantGeneration: z.number().int().positive(),
    principalId: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("automation"),
    automationId: z.string().min(1),
    onBehalfOf: z.string().min(1).optional(),
    depth: z.number().int().nonnegative(),
  }).strict(),
]);
const rawMomentOperationSchema = z.enum(["write", "rename", "delete"]);
const rawMomentFileSchema = z
  .object({
    path: z.string().min(1),
    operation: rawMomentOperationSchema,
  })
  .strict();
const rawMomentSummarySchema = z
  .object({
    operationId: HistoryOperationId.optional(),
    id: z.string().min(1),
    recordedAtMs: z.number(),
    source: z.literal("workspace-engine"),
    operation: rawMomentOperationSchema,
    path: z.string().min(1),
    versionId: z.string().min(1),
    authors: z.array(rawMomentAuthorSchema).min(1).optional(),
    fileCount: z.literal(1),
    files: z.array(rawMomentFileSchema).optional(),
  })
  .strict();
const rawMomentPayloadSnapshotSchema = z
  .object({
    path: z.string().min(1),
    contentKind: z.enum(["text", "binary"]).optional(),
    sha256: z.string().min(1).optional(),
    byteLength: z.number().int().nonnegative().optional(),
    text: z.string(),
  })
  .strict();

// dohc can't read the workspace's History rules, so History hides every
// change. `unreadable` names what to fix; no change's id, path or contents
// are sent.
const historyPolicyUnreadableSchema = z.object({
  ok: z.literal(false),
  status: z.literal("policy-unreadable"),
  unreadable: z.array(z.enum(WORKSPACE_POLICY_PATHS)).min(1),
  reason: z.string().min(1),
}).strict();

const momentsResultSchema = z.union([
  z
    .object({
      changes: z.array(rawMomentSummarySchema),
      count: z.number().int().nonnegative(),
      totalAvailable: z.number().int().nonnegative(),
      hasMore: z.boolean(),
      cursorMs: z.number(),
    })
    .strict(),
  historyPolicyUnreadableSchema,
]);
const momentResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      change: rawMomentSummarySchema.extend({
        files: z.array(rawMomentFileSchema),
        before: rawMomentPayloadSnapshotSchema.nullable(),
        after: rawMomentPayloadSnapshotSchema,
      }).strict(),
    })
    .strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict(),
  // History has the change, but its rules no longer track a file it touched.
  // No path or contents are sent.
  z.object({ ok: z.literal(false), status: z.literal("untracked"), reason: z.string().min(1) }).strict(),
  historyPolicyUnreadableSchema,
]);

const rawChannelIdSchema = z.string().regex(/^channel-/u);
const rawThreadIdSchema = z.string().regex(/^thread-/u);
const rawMessageIdSchema = z.string().regex(/^message-/u);
const rawChatThreadSchema = z
  .object({
    id: rawThreadIdSchema,
    title: z.string(),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    linkedPathHint: z.string().min(1).optional(),
  })
  .strict();
const rawChatMessageSchema = z
  .object({
    id: rawMessageIdSchema,
    threadId: rawThreadIdSchema,
    authorKind: cliAuthorKindSchema,
    authorDisplayName: z.string().min(1),
    authorOwnerDisplayName: z.string().min(1).optional(),
    body: z.string(),
    createdAtMs: z.number().int().nonnegative(),
    parentMessageId: rawMessageIdSchema.optional(),
    attachments: z.array(z.object({
      objectId: z.string().min(1).optional(),
      pathHint: z.string().min(1).optional(),
    }).strict()),
    needsDecision: z.boolean(),
    decisionState: z.enum(["open", "resolved"]).optional(),
    options: z.array(z.string()).optional(),
    chosenOption: z.string().optional(),
    resolvedByMessageId: rawMessageIdSchema.optional(),
    agentRequests: z.array(agentRequestSchema).optional(),
  })
  .strict();
const rawFailureSchema = z
  .object({ ok: z.literal(false), reason: z.string().min(1) })
  .strict();

const fileChatsResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      path: z.string().min(1),
      fileObjectId: z.string().min(1).nullable(),
      threads: z.array(rawChatThreadSchema),
    })
    .strict(),
  rawFailureSchema,
]);
const chatResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      thread: rawChatThreadSchema,
      dispatch: threadDispatchSchema,
      messages: z.array(rawChatMessageSchema),
      projection: z
        .object({
          path: z.string().min(1),
          readOnly: z.literal(true),
          text: z.string(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      stream: streamSchema(
        z.object({ id: rawChannelIdSchema, name: z.string().min(1), kind: z.enum(["group", "dm", "agent"]) }).strict(),
        rawChatMessageSchema,
      ),
    })
    .strict(),
  rawFailureSchema,
]);
const groupsFullResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      groups: z.array(
        z
          .object({
            id: rawChannelIdSchema,
            channelWireId: z.string().min(1).max(500).nullable().optional(),
            name: z.string().min(1),
            slug: z.string().min(1),
            kind: z.enum(["group", "dm", "agent"]),
            purpose: z.string().min(1).optional(),
            threadCount: z.number().int().nonnegative(),
            threads: z.array(
              z
                .object({
                  id: rawThreadIdSchema,
                  title: z.string(),
                  lane: z.enum(["posts", "chat"]).optional(),
                  messageCount: z.number().int().nonnegative(),
                  updatedAtMs: z.number().int().nonnegative(),
                })
                .strict(),
            ),
          })
          .strict(),
      ),
    })
    .strict(),
  rawFailureSchema,
]);
const collectionSchemaReasonSchema = z
  .object({ code: z.enum(COLLECTION_SCHEMA_REASON_CODES), path: z.string() })
  .strict();
const rawCollectionSummarySchema = z
  .object({
    path: z.string().min(1),
    status: z.enum(["valid", "degraded"]),
    reasons: z.array(collectionSchemaReasonSchema),
  })
  .strict();
const collectionValueValidationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("valid") }).strict(),
  z
    .object({
      status: z.literal("flagged"),
      reason: z
        .object({ code: z.enum(FIELD_VALUE_REASON_CODES), path: z.string() })
        .strict(),
    })
    .strict(),
  z.object({ status: z.literal("untyped") }).strict(),
]);
const rawCollectionRecordSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    conflicted: z.boolean(),
    values: z.array(
      z
        .object({
          field: z.string().min(1),
          value: collectionWireValueSchema,
          validation: collectionValueValidationSchema,
          resolvedRelations: z.array(
            z
              .object({ recordId: z.string().min(1), label: z.string() })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

const collectionQueryResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      collection: rawCollectionSummarySchema,
      records: z.array(rawCollectionRecordSchema),
      groups: z
        .array(
          z
            .object({
              value: collectionWireValueSchema,
              records: z.array(rawCollectionRecordSchema),
            })
            .strict(),
        )
        .nullable(),
      nextCursor: collectionQueryCursorSchema.nullable(),
    })
    .strict(),
  rawFailureSchema,
]);
const collectionRecordResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      collection: rawCollectionSummarySchema,
      record: rawCollectionRecordSchema,
      history: z.array(
        z
          .object({
            historyId: z.number().int().nonnegative(),
            field: z.string().min(1),
            previous: collectionMaybeValueSchema,
            next: collectionMaybeValueSchema,
            authorOriginId: z.string().min(1).nullable(),
            actorKind: z.enum(["human", "agent", "automation"]).nullable(),
            onBehalfOf: z.string().min(1).nullable(),
            depth: z.number().int().nonnegative().nullable(),
            recordedAtMs: z.number().int().nonnegative(),
            linkAuthor: z.object({
              kind: z.literal("link"),
              grantId: z.string().min(1),
              grantGeneration: z.number().int().positive(),
              publicPrincipalId: z.string().min(1),
            }).strict().nullable(),
            // The automation run that made the change: its claim, and the automation's name when it ran.
            automationRun: z
              .object({ claimId: z.string().min(1), automationName: z.string().min(1) })
              .strict()
              .nullable(),
          })
          .strict(),
      ),
    })
    .strict(),
  rawFailureSchema,
]);
const collectionSetFieldsResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), recordPath: z.string().min(1) }).strict(),
  rawFailureSchema,
]);
const collectionCreateRecordResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      recordId: z.string().min(1),
      recordPath: z.string().min(1),
      kept: z.record(z.string(), z.json()).optional(),
    })
    .strict(),
  rawFailureSchema.extend({ partial: CreationPartial.optional() }),
]);

const documentReadResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), path: z.string().min(1), markdown: z.string() }).strict(),
  rawFailureSchema,
]);
const documentEditResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), path: z.string().min(1), changed: z.boolean(), warning: z.string().optional() }).strict(),
  rawFailureSchema,
]);
const documentCreateResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), path: z.string().min(1) }).strict(),
  rawFailureSchema,
]);
const fileChatStartResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      path: z.string().min(1),
      threadId: rawThreadIdSchema,
      messageId: rawMessageIdSchema,
      warning: z.string().min(1).optional(),
    })
    .strict(),
  rawFailureSchema,
]);

// A workspace's versions and the active one, whose files the folder shows.
// canMergeIntoMain is false for a version made from another version.
const versionListResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    versions: z.array(z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      kind: z.enum(["main", "named"]),
      createdAtMs: z.number(),
      canMergeIntoMain: z.boolean(),
    }).strict()),
    activeVersionId: z.string().min(1),
  }).strict(),
  rawFailureSchema,
]);

// Version rows leave out secret-backed files and paths the workspace's rules
// don't track, as History does.
const versionCompareResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    version: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
    // One page of the files that differ from Main. Pass nextAfterPath back as
    // afterPath for the next page.
    files: z.array(z.object({
      path: z.string().min(1),
      status: z.enum(["added", "modified", "deleted"]),
      // Main's side; absent when the file exists only in the version.
      currentText: z.string().optional(),
      // The version's side; absent when the file exists only in Main.
      incomingText: z.string().optional(),
      // A binary file differs by its bytes, so neither side has text.
      binary: z.boolean().optional(),
    }).strict()),
    nextAfterPath: z.string().min(1).nullable(),
  }).strict(),
  rawFailureSchema,
  historyPolicyUnreadableSchema,
]);

const conflictBinarySchema = z.object({ byteLength: z.number().int().nonnegative(), sha256: z.string().min(1) }).strict().nullable();
// One page of open conflicts: from a merge, or from two computers editing
// the same file while apart (origin "sync"). A side's text is null when that
// side has no file or holds binary.
const versionConflictsPage = {
  conflicts: z.array(z.object({
    conflictId: z.string().min(1),
    path: z.string().min(1),
    sourceVersionId: z.string().min(1),
    targetVersionId: z.string().min(1),
    origin: z.enum(["merge", "sync"]),
    contentKind: z.enum(["text", "binary"]),
    currentText: z.string().nullable(),
    incomingText: z.string().nullable(),
    baseText: z.string().nullable(),
    currentBinary: conflictBinarySchema.optional(),
    incomingBinary: conflictBinarySchema.optional(),
    baseBinary: conflictBinarySchema.optional(),
  }).strict()),
  nextAfterConflictId: z.string().min(1).nullable(),
};
const versionConflictsResultSchema = z.union([
  z.object({ ok: z.literal(true), ...versionConflictsPage }).strict(),
  rawFailureSchema,
  historyPolicyUnreadableSchema,
]);

const versionNameSchema = z.object({ id: z.string().min(1), name: z.string().min(1) }).strict();
// The new version, now the active one.
const versionCreateResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), version: versionNameSchema }).strict(),
  rawFailureSchema,
]);
const versionSwitchResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), version: versionNameSchema, changedFileCount: z.number().int().nonnegative() }).strict(),
  rawFailureSchema,
]);
// conflictCount counts every conflict the merge left. The page lists the
// open conflicts, from this merge and earlier ones, as version conflicts does.
const versionMergeResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    version: versionNameSchema,
    mergedFileCount: z.number().int().nonnegative(),
    unchangedFileCount: z.number().int().nonnegative(),
    conflictCount: z.number().int().nonnegative(),
    ...versionConflictsPage,
  }).strict(),
  rawFailureSchema,
  historyPolicyUnreadableSchema,
]);
// The open conflicts that remain, as version conflicts lists them.
const versionResolveResultSchema = versionConflictsResultSchema;

// Files dohc moved aside while it saved, because another program changed
// them meanwhile. Each waits out of sight until saveKeptCopy moves it to a
// visible copy beside its file.
const keptCopiesResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    outsideWriteCopies: z.array(z.tuple([z.string(), z.string(), z.string()])).optional(),
    keptCopies: z.array(z.object({
      id: z.number().int(),
      path: z.string().min(1),
      keptAtMs: z.number().int().nonnegative(),
    }).strict()),
    more: z.boolean(),
  }).strict(),
  rawFailureSchema,
]);
// `saved` with the copy's path; `gone` when nothing is kept under that id any
// more; `no-valid-name` when no name beside the file fits dohc's path limits,
// so the copy stays kept.
const saveKeptCopyResultSchema = z.union([
  z.object({ ok: z.literal(true), status: z.literal("saved"), path: z.string().min(1) }).strict(),
  z.object({ ok: z.literal(true), status: z.literal("gone") }).strict(),
  z.object({ ok: z.literal(true), status: z.literal("no-valid-name") }).strict(),
  rawFailureSchema,
]);

// Old file copies kept on a drive that cannot tell dohc whether a program
// still has one open: how many, and their logical size in bytes. Deleting
// them may free less disk space than `bytes`.
const retainedCopiesSummarySchema = z.object({
  count: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
}).strict();
// `copies` names those a delete may remove now, oldest first, each with the
// revision the delete must match; `more` says there are others past these.
// `total` counts every one, including copies that changed in the last 30
// seconds or whose file waits for review.
const retainedCopiesResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    copies: z.array(retainedCopySchema),
    more: z.boolean(),
    total: retainedCopiesSummarySchema,
  }).strict(),
  rawFailureSchema,
]);
// A copy that changed since it was listed, whose file waits for review, or
// that recovery may still need is skipped and stays.
const deleteRetainedCopiesResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    deleted: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    remaining: retainedCopiesSummarySchema,
  }).strict(),
  rawFailureSchema,
]);

// Live documents whose edits the server refused for good, as dohc keeps them
// on this computer or, for a document the server hosts, on the server
// (`storedOn`). `recovery` is paused while they wait for the owner, retrying
// while Try again waits for the server, stopping while a Stop waits for it,
// stopped-kept or not-written after a Stop kept them, cannot-write once only
// a recovery copy can return them, copied once a recovery copy of edits the
// server keeps is saved, maybe by another of the owner's computers, and
// unreadable while this computer's engine refuses to read them, for `reason`.
// `earlier` marks edits the server keeps in an earlier copy of the workspace,
// copied or not, which only a recovery copy can reach.
const keptEditsStoredOnSchema = z.enum(["this-computer", "server"]);
const liveDocumentsResultSchema = z.discriminatedUnion("ok", [
  z.object({ok: z.literal(true), documents: z.array(z.object({
    path: documentPathArg, objectId: z.string().min(1).max(512), status: z.enum(["ready", "preparing", "paused", "unavailable", "retired"]),
    reason: z.string().min(1).max(128).optional(), firstOpen: FirstOpenOwnerStatus.optional(),
  }).strict())}).strict(),
  rawFailureSchema,
]);
const retryLiveDocumentResultSchema = z.discriminatedUnion("ok", [
  z.object({ok: z.literal(true), path: documentPathArg}).strict(), rawFailureSchema,
]);
const liveKeptEditsResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    keptEdits: z.array(z.object({
      path: z.string().min(1),
      reason: z.string().min(1),
      storedOn: keptEditsStoredOnSchema,
      incident: keptEditsIncidentSchema,
      recovery: z.enum(["paused", "retrying", "stopping", "stopped-kept", "not-written", "cannot-write", "copied", "unreadable"]),
      earlier: z.literal(true).optional(),
      saveOnly: z.literal(true).optional(),
    }).strict()),
  }).strict(),
  rawFailureSchema,
]);
// The package always holds every kept edit. `copyPath` is null when dohc
// could not read the edits as a document. Both sit in `folder`. The edits
// came from where `storedOn` says. `keptEdits` is kept while they stay there,
// copied once the server may release them, and ended once dohc no longer
// keeps a Stop's edits it could not write.
const saveRecoveryCopyResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    copyPath: z.string().min(1).nullable(),
    packagePath: z.string().min(1),
    folder: z.string().min(1),
    storedOn: keptEditsStoredOnSchema,
    keptEdits: z.enum(["kept", "copied", "ended"]),
  }).strict(),
  rawFailureSchema,
]);
const retryKeptEditsResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), path: z.string().min(1) }).strict(),
  rawFailureSchema,
]);
// What the Stop did with the kept edits: wrote them into the file, still
// keeps them, or kept none.
const stopAgainResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), path: z.string().min(1), keptEdits: z.enum(["none", "recovered", "kept"]) }).strict(),
  rawFailureSchema,
]);

// What an automation run did, as this computer's run history keeps it:
// a field it wrote, a record it added, a field someone else had changed
// since the run planned it (kept as they left it), a record it could no
// longer find, the same four for dataset records, and a message or notice
// it sent. Values are plain JSON.
const automationDatasetRulesSchema = z
  .object({ datasetId: z.string(), revision: z.number().int().positive(), revisionSha256: z.string() })
  .strict();
const automationDatasetRecordIdSchema = z.union([z.string(), z.number()]);
const automationRunChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("field"), recordId: z.string(), path: z.string(), field: z.string(), before: z.json(), after: z.json() }).strict(),
  z.object({ kind: z.literal("created"), recordId: z.string(), path: z.string() }).strict(),
  z.object({ kind: z.literal("kept"), recordId: z.string(), path: z.string(), field: z.string(), planned: z.json(), current: z.json() }).strict(),
  z.object({ kind: z.literal("skipped"), recordId: z.string(), path: z.string(), reason: z.string() }).strict(),
  // An edit that landed, with the record version it was sent at and the one it left.
  z.object({
    kind: z.literal("dataset-edit"),
    rules: automationDatasetRulesSchema,
    operationId: z.string(),
    tableId: z.string(),
    recordId: automationDatasetRecordIdSchema,
    expectedVersion: z.number().int().positive(),
    version: z.number().int().positive(),
    fields: z.array(z.object({ fieldId: z.string(), field: z.string(), before: z.json(), after: z.json() }).strict()),
  }).strict(),
  // A record the run added. `deletes` are the approved deletes Undo may use on it, as the run recorded them.
  z.object({
    kind: z.literal("dataset-created"),
    rules: automationDatasetRulesSchema,
    operationId: z.string(),
    tableId: z.string(),
    recordId: automationDatasetRecordIdSchema,
    version: z.number().int().positive(),
    deletes: z.array(z.string()),
  }).strict(),
  // An action that ran, by its label then, and the dataset revision its commit made. When the
  // rules named a reverse action, `reverseOperationId` is it and `undo` is its input; Undo runs that or nothing.
  z.object({
    kind: z.literal("dataset-action"),
    rules: automationDatasetRulesSchema,
    operationId: z.string(),
    tableId: z.string(),
    name: z.string(),
    revision: z.number().int().nonnegative(),
    undo: z.json().optional(),
    reverseOperationId: z.string().optional(),
  }).strict(),
  z.object({
    kind: z.literal("dataset-kept"),
    recordId: automationDatasetRecordIdSchema,
    fieldId: z.string(),
    field: z.string(),
    planned: z.json(),
    current: z.json(),
  }).strict(),
  z.object({ kind: z.literal("dataset-skipped"), recordId: automationDatasetRecordIdSchema, reason: z.string() }).strict(),
  z.object({ kind: z.literal("message"), messageId: z.string(), name: z.string() }).strict(),
  z.object({ kind: z.literal("notice"), noticeId: z.string(), name: z.string() }).strict(),
]);
// The change a run is for. `kind` is null for a dataset run that failed
// before it could carry its change; `by` is null when the change did not say.
// A person the owner shared with, or an Edit share link, the relay accepted
// the change from. A link is its grant, never a person's account.
const automationSharedAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named"), userId: z.string().min(1), grantId: z.string().min(1), grantGeneration: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("link"), grantId: z.string().min(1), grantGeneration: z.number().int().positive(), principalId: z.string().min(1) }).strict(),
]);
const automationTriggerSchema = z
  .object({
    kind: z.enum(["added", "changed", "removed", "message", "button", "schedule"]).nullable(),
    recordId: z.string().nullable(),
    by: z.enum(["human", "agent", "automation"]).nullable(),
    sharedAuthor: automationSharedAuthorSchema.nullable(),
    depth: z.number().int().nonnegative(),
  })
  .strict();
const automationRunFields = {
  run: automationRunIdArg,
  state: z.enum(["pending", "running", "done", "failed"]),
  error: z.string().nullable(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  trigger: automationTriggerSchema,
  // The run began under another version of the automation.
  definitionChanged: z.boolean(),
  // It failed before it started, as a chain stop or a change too large to
  // start automations for, so it cannot run again.
  neverStarted: z.boolean(),
  // The chain depth cap stopped it before it ran.
  chainStopped: z.boolean(),
  undone: z.boolean(),
  // The server lost the copy it ran in, and may not have sent its changes
  // from updatedAtMs on. Nothing can run or undo it again.
  unsentChangesLost: z.literal(true).optional(),
};
const automationRunsResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      runs: z.array(z.object({ ...automationRunFields, changes: z.number().int().nonnegative() }).strict()),
      // The `page` that lists the older runs, or null after the oldest.
      next: z.string().min(1).nullable(),
    })
    .strict(),
  rawFailureSchema,
]);
const automationRunResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      run: z.union([z
        .object({
          ...automationRunFields,
          findMs: z.number().nonnegative().optional(),
          planMs: z.number().nonnegative().optional(),
          writeMs: z.number().nonnegative().optional(),
          writeCount: z.number().int().nonnegative().optional(),
          // Steps count from 1 in the order the file lists them, including
          // the steps inside If and Otherwise. A step that changed nothing
          // is not listed.
          steps: z.array(
            z.object({ step: z.number().int().positive(), changes: z.array(automationRunChangeSchema) }).strict(),
          ),
          // The step whose change did not land when the run failed. Null
          // when it did not fail, or failed before any step, such as on a
          // formula.
          failedStep: z.number().int().positive().nullable(),
          // Try again runs it from the first step and needs startOver,
          // because the automation changed or the run's progress is gone.
          // Otherwise Try again resumes at failedStep.
          startsOver: z.boolean(),
        })
        .strict(),
      // A run the server ran, with what it changed there, oldest first.
      z.object({ ...automationRunFields, server: z.literal(true), changes: z.array(automationRunChangeSchema) }).strict()]),
    })
    .strict(),
  rawFailureSchema,
]);
const automationRetryResultSchema = z.union([
  z.object({ ok: z.literal(true), status: z.literal("queued") }).strict(),
  z.object({
    ok: z.literal(false), status: z.literal("switched-off"), reason: z.string().min(1),
    target: z.object({ recovery: z.literal("automation-controls"), automation: z.string().min(1), path: z.string().min(1) }).strict(),
  }).strict(),
  // Running it again starts from the first step and can repeat changes the
  // run already made, so it needs startOver. `repeatsMessages` says posts,
  // direct messages, and notices it sent may be sent again.
  z
    .object({
      ok: z.literal(false),
      status: z.literal("definition-changed"),
      repeatsMessages: z.boolean(),
      reason: z.string().min(1),
    })
    .strict(),
  // A run on another computer carries its failure notice, which names that computer.
  z
    .object({
      ok: z.literal(false),
      reason: z.string().min(1),
      notice: z.object({ title: z.string(), body: z.string() }).strict().optional(),
    })
    .strict(),
]);

const fileWriteResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), written: z.array(z.string()) }).strict(),
  z.object({
    ok: z.literal(false), reason: z.string(), written: z.array(z.string()).optional(),
    path: z.string().optional(), currentSha256: z.string().nullable().optional(),
  }).strict(),
]);

// A move is whole or put back. `withoutHistory` names the files the move
// left with no History row: oversized files or text with invalid UTF-8. After
// a failed move, `deleted` names the files History records as deleted:
// replaced destination files that could not be restored, and moved files
// that could not go to either path. Each stays in the workspace trash.
const replacedPathSchema = z.object({
  path: z.string(), trashed: z.boolean(), trashPath: z.string().optional(),
  withoutHistory: z.array(z.string()),
}).strict();

const fileMoveResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true), ...OperationRecovery.shape, fromPath: z.string(), toPath: z.string(), withoutHistory: z.array(z.string()).optional(),
    replaced: replacedPathSchema.optional(),
  }).strict(),
  z.object({
    ok: z.literal(false), reason: z.string(), path: z.string().optional(), deleted: z.array(z.string()).optional(),
    withoutHistory: z.array(z.string()).optional(), replaced: replacedPathSchema.optional(),
  }).strict(),
]);

// `trashed` is true when the system trash took the entry; when false,
// `trashPath` names its entry in the workspace trash. `withoutHistory` names
// the files deleted with no History row: oversized files or text with invalid
// UTF-8. A folder delete that stops at `path` names the files it already
// deleted.
const fileDeleteResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true), ...OperationRecovery.shape, path: z.string(), trashed: z.boolean(), trashPath: z.string().optional(),
    withoutHistory: z.array(z.string()).optional(),
  }).strict(),
  z.object({
    ok: z.literal(false), reason: z.string(), deleted: z.array(z.string()).optional(), path: z.string().optional(),
    withoutHistory: z.array(z.string()).optional(),
  }).strict(),
]);

const automationPressResultSchema = z.union([
  // The run the press started. `outcome` is set when a press sent again
  // finds its run already ended; `waiting` says why the run waits, if it does.
  z
    .object({
      ok: z.literal(true),
      run: automationRunIdArg,
      outcome: z.enum(["done", "skipped", "failed", "ended"]).nullable(),
      error: z.string().nullable(),
      waiting: z.string().nullable(),
    })
    .strict(),
  // A shared view's press went to the owner's computer, which runs it. Its
  // changes arrive as synced edits, and a failure as a notice.
  z.object({ ok: z.literal(true), relayed: z.literal(true) }).strict(),
  // The press would run actions dohc cannot undo. Name each in confirm to run them.
  z
    .object({
      ok: z.literal(false),
      reason: z.string().min(1),
      confirm: z.array(z.object({ name: z.string().min(1), label: z.string().min(1) }).strict()).min(1),
    })
    .strict(),
  rawFailureSchema,
]);

export const cliResultSchemas = {
  stopSync: z.union([
    z.object({ ok: z.literal(true), workspaceId: z.string().min(1), workspaceSynced: z.literal(false),
      syncPause: WorkspaceSyncPauseStatus.optional() }).strict(),
    rawFailureSchema,
  ]),
  chatLinks: ChatLinksPage,
  chatFileMentions: ChatFileMentionsPage,
  linksEdges: LinksEdgesResult,
  linksIn: LinksInResult,
  linksResolve: LinksResolveResult,
  shareCopy: ShareCopyResult,
  accountDeletePreview: ServerAccountDeletionPreview,
  accountDelete: ServerAccountDeleteResult,
  accessRefresh: AccessRefreshResult,
  accessObject: AccessAnswer,
  accessSharing: AccessAnswer,
  automationList: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), definitions: z.custom<AutomationDefinitionList>(value => value !== null && typeof value === "object" && "file" in value && "canSwitch" in value && "contentHash" in value) }).strict(),
    z.object({ ok: z.literal(false), reason: z.string() }).strict(),
  ]),
  automationSwitch: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), result: z.custom<AutomationSwitchResult>(value => value !== null && typeof value === "object" && "status" in value) }).strict(),
    z.object({ ok: z.literal(false), reason: z.string() }).strict(),
  ]),
  fileWrite: fileWriteResultSchema,
  historyOperation: HistoryOperationReadResult,
  historyUndo: HistoryOperationUndoResult,
  fileDuplicate: z.discriminatedUnion("ok", [z.object({ok: z.literal(true), ...OperationRecovery.shape, path: z.string(), materialized: z.boolean()}).strict(), z.object({ok: z.literal(false), reason: z.string()}).strict()]),
  fileMove: fileMoveResultSchema,
  fileDelete: fileDeleteResultSchema,
  dataset: DatasetResult,
  appPublication: OwnerAppPublicationResult,
  ownerAppResponses: OwnerAppResponsesResult,
  groups: groupsResultSchema,
  threads: threadsResultSchema,
  inbox: inboxResultSchema,
  show: showResultSchema,
  post: postResultSchema,
  reply: replyResultSchema,
  react: reactResultSchema,
  grep: grepResultSchema,
  export: exportResultSchema,
  moments: momentsResultSchema,
  moment: momentResultSchema,
  fileChats: fileChatsResultSchema,
  chat: chatResultSchema,
  groupsFull: groupsFullResultSchema,
  collectionQuery: collectionQueryResultSchema,
  collectionRecord: collectionRecordResultSchema,
  collectionSetFields: collectionSetFieldsResultSchema,
  collectionCreateRecord: collectionCreateRecordResultSchema,
  documentRead: documentReadResultSchema,
  versionList: versionListResultSchema,
  versionCompare: versionCompareResultSchema,
  versionConflicts: versionConflictsResultSchema,
  versionCreate: versionCreateResultSchema,
  versionSwitch: versionSwitchResultSchema,
  versionMerge: versionMergeResultSchema,
  versionResolve: versionResolveResultSchema,
  keptCopies: keptCopiesResultSchema,
  // The engine's answer: Collection updates wait for an unfinished pull.
  collectionsWaiting: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), waiting: z.boolean() }).strict(),
    rawFailureSchema,
  ]),
  saveKeptCopy: saveKeptCopyResultSchema,
  retainedCopies: retainedCopiesResultSchema,
  deleteRetainedCopies: deleteRetainedCopiesResultSchema,
  liveDocuments: liveDocumentsResultSchema,
  retryLiveDocument: retryLiveDocumentResultSchema,
  liveKeptEdits: liveKeptEditsResultSchema,
  saveRecoveryCopy: saveRecoveryCopyResultSchema,
  retryKeptEdits: retryKeptEditsResultSchema,
  stopAgain: stopAgainResultSchema,
  documentEdit: documentEditResultSchema,
  documentCreate: documentCreateResultSchema,
  fileChatStart: fileChatStartResultSchema,
  automationRuns: automationRunsResultSchema,
  automationRun: automationRunResultSchema,
  automationRetry: automationRetryResultSchema,
  automationButtons: z.union([
    z.object({ ok: z.literal(true), buttons: z.array(z.object({ field: z.string(), table: z.string().optional(), state: z.union([
      z.object({ kind: z.literal("ready"), automationId: z.string(), irreversible: z.array(z.object({ name: z.string(), label: z.string() })).optional() }),
      z.object({ kind: z.enum(["disabled", "unchecked", "no-automation"]), reason: z.string() }),
    ]) })) }),
    rawFailureSchema,
  ]),
  automationPress: automationPressResultSchema,
} as const;

export type CliResultByVerb = {
  [Verb in keyof typeof cliResultSchemas]: z.infer<(typeof cliResultSchemas)[Verb]>;
};

export const cliTransportResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      protocolVersion: z.number().int().nonnegative(),
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.number().int().nonnegative(),
      ok: z.literal(false),
      error: z.string().min(1),
    })
    .strict(),
]);
export type CliTransportResponse = z.infer<typeof cliTransportResponseSchema>;

export function parseCliResult<Verb extends CliVerb>(
  verb: Verb,
  value: unknown,
): CliResultByVerb[Verb] {
  return cliResultSchemas[verb].parse(value) as CliResultByVerb[Verb];
}
