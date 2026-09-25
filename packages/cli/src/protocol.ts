import {
  COLLECTION_SCHEMA_REASON_CODES,
  FIELD_VALUE_REASON_CODES,
} from "@dohc/workspace-contracts/collection";
import { z } from "zod";
import { DatasetRequest, DatasetResult } from "./dataset";
import { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "./appPublication";
import {OwnerAppResponsesRequest,OwnerAppResponsesResult} from "./appResponses";

export const CLI_PROTOCOL_VERSION = 4;
export const CLI_JSON_SCHEMA_VERSION = 2;

const cliActorSchema = z.enum(["human", "agent"]);
export type CliActor = z.infer<typeof cliActorSchema>;

const requestBase = {
  token: z.string().regex(/^[a-f0-9]{64}$/),
  protocolVersion: z.literal(CLI_PROTOCOL_VERSION),
};

const argsBase = {
  cwd: z.string().min(1),
  actor: cliActorSchema,
};

const groupsArgsSchema = z.object(argsBase).strict();
const threadsArgsSchema = z
  .object({ ...argsBase, group: z.string().min(1) })
  .strict();
const inboxArgsSchema = z.object(argsBase).strict();
const showArgsSchema = z
  .object({ ...argsBase, target: z.string().min(1), peek: z.boolean() })
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
  })
  .strict();
const momentArgsSchema = z
  .object({ ...argsBase, id: z.string().min(1).max(500) })
  .strict();
const fileChatsArgsSchema = z
  .object({ ...argsBase, path: z.string().min(1).max(4096) })
  .strict();
const chatArgsSchema = z
  .object({ ...argsBase, threadId: z.string().min(1).max(200) })
  .strict();
const groupsFullArgsSchema = z.object(argsBase).strict();

const documentPathArg = z.string().min(1).max(4096);
// Each side of an edit is at most 256 KiB as UTF-8. The socket still refuses a
// request line over 1 MiB, which JSON escaping of both sides can reach.
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
    recordPath: collectionPathArg,
    fields: collectionSetFieldsFieldsSchema,
  })
  .strict();
const collectionCreateRecordArgsSchema = z
  .object({
    ...argsBase,
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
  })
  .strict();

export const cliRequestSchema = z.discriminatedUnion("verb", [
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
  z.object({ ...requestBase, verb: z.literal("documentRead"), args: documentReadArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("documentEdit"), args: documentEditArgsSchema }).strict(),
]);

export type CliRequest = z.infer<typeof cliRequestSchema>;
export type CliVerb = CliRequest["verb"];
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
    kind: cliActorSchema,
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
  .object({ groups: z.array(cliGroupSchema) })
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
const showResultSchema = z
  .object({
    thread: cliShowThreadSchema,
    messages: z.array(cliShowMessageSchema),
  })
  .strict();
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

const rawMomentAuthorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent"),
    agentId: z.string().min(1),
    onBehalfOf: z.string().min(1),
    agentRunId: z.string().min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal("public"),
    principalId: z.string().min(1),
    grantId: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("automation"),
    automationId: z.string().min(1),
    onBehalfOf: z.string().min(1),
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
    id: z.string().min(1),
    recordedAtMs: z.number(),
    source: z.literal("workspace-engine"),
    operation: rawMomentOperationSchema,
    path: z.string().min(1),
    versionId: z.string().min(1),
    summary: z.string().optional(),
    author: rawMomentAuthorSchema.optional(),
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

const momentsResultSchema = z
  .object({
    changes: z.array(rawMomentSummarySchema),
    count: z.number().int().nonnegative(),
    totalAvailable: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    cursorMs: z.number(),
  })
  .strict();
const momentResultSchema = z.discriminatedUnion("ok", [
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
    authorKind: cliActorSchema,
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
const chatResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      thread: rawChatThreadSchema,
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
    })
    .strict(),
  rawFailureSchema,
]);

const documentReadResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), path: z.string().min(1), markdown: z.string() }).strict(),
  rawFailureSchema,
]);
const documentEditResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), path: z.string().min(1), changed: z.boolean(), warning: z.string().optional() }).strict(),
  rawFailureSchema,
]);

const cliResultSchemas = {
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
  documentEdit: documentEditResultSchema,
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
