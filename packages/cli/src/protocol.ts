import { z } from "zod";

export const CLI_PROTOCOL_VERSION = 1;
export const CLI_JSON_SCHEMA_VERSION = 1;

export const cliActorSchema = z.enum(["human", "agent"]);
export type CliActor = z.infer<typeof cliActorSchema>;

const requestBase = {
  token: z.string().regex(/^[a-f0-9]{64}$/),
  protocolVersion: z.literal(CLI_PROTOCOL_VERSION),
};

const argsBase = {
  cwd: z.string().min(1),
  actor: cliActorSchema,
};

export const channelsArgsSchema = z.object(argsBase).strict();
export const threadsArgsSchema = z
  .object({ ...argsBase, channel: z.string().min(1) })
  .strict();
export const inboxArgsSchema = z.object(argsBase).strict();
export const showArgsSchema = z
  .object({ ...argsBase, target: z.string().min(1), peek: z.boolean() })
  .strict();
export const postArgsSchema = z
  .object({
    ...argsBase,
    runId: z.string().min(1).optional(),
    channel: z.string().min(1),
    title: z.string().min(1).optional(),
    attachments: z.array(z.string().min(1)),
    needsDecision: z.boolean(),
    body: z.string().min(1),
  })
  .strict();
export const replyArgsSchema = z
  .object({
    ...argsBase,
    runId: z.string().min(1).optional(),
    thread: z.string().min(1),
    to: z.string().min(1).optional(),
    attachments: z.array(z.string().min(1)),
    needsDecision: z.boolean(),
    resolve: z.string().min(1).optional(),
    body: z.string().min(1),
  })
  .strict();
export const reactArgsSchema = z
  .object({
    ...argsBase,
    runId: z.string().min(1).optional(),
    message: z.string().min(1),
    emoji: z.string().min(1),
  })
  .strict();
export const grepArgsSchema = z
  .object({
    ...argsBase,
    pattern: z.string().min(1),
    channel: z.string().min(1).optional(),
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
export const exportScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("channel"), channel: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("thread"), thread: z.string().min(1) }).strict(),
]);
export const exportArgsSchema = z
  .object({
    ...argsBase,
    scope: exportScopeSchema,
    outDir: z.string().min(1),
  })
  .strict();

export const cliRequestSchema = z.discriminatedUnion("verb", [
  z.object({ ...requestBase, verb: z.literal("channels"), args: channelsArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("threads"), args: threadsArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("inbox"), args: inboxArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("show"), args: showArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("post"), args: postArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("reply"), args: replyArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("react"), args: reactArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("grep"), args: grepArgsSchema }).strict(),
  z.object({ ...requestBase, verb: z.literal("export"), args: exportArgsSchema }).strict(),
]);

export type CliRequest = z.infer<typeof cliRequestSchema>;
export type CliVerb = CliRequest["verb"];
export type CliRequestWithoutToken = CliRequest extends infer Request
  ? Request extends CliRequest
    ? Omit<Request, "token">
    : never
  : never;

export const cliChannelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    kind: z.enum(["channel", "dm", "agent"]),
  })
  .strict();
export type CliChannel = z.infer<typeof cliChannelSchema>;

export const cliAuthorSchema = z
  .object({
    kind: cliActorSchema,
    displayName: z.string().min(1),
  })
  .strict();
export type CliAuthor = z.infer<typeof cliAuthorSchema>;

export const cliThreadSummarySchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    commentCount: z.number().int().nonnegative(),
    openDecisionCount: z.number().int().nonnegative(),
    unread: z.boolean(),
    updatedAtMs: z.number().int().nonnegative(),
  })
  .strict();
export type CliThreadSummary = z.infer<typeof cliThreadSummarySchema>;

export const cliInboxThreadSchema = cliThreadSummarySchema
  .extend({ channel: cliChannelSchema })
  .strict();

export const cliInboxMentionSchema = z
  .object({
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    channel: cliChannelSchema,
    author: cliAuthorSchema,
    createdAtMs: z.number().int().nonnegative(),
    text: z.string(),
  })
  .strict();

export const cliAttachmentSchema = z
  .object({
    objectId: z.string().min(1).optional(),
    pathHint: z.string().min(1).optional(),
  })
  .strict();

export const cliShowMessageSchema = z
  .object({
    id: z.string().min(1),
    author: cliAuthorSchema,
    body: z.string(),
    createdAtMs: z.number().int().nonnegative(),
    parentMessageId: z.string().min(1).optional(),
    decisionState: z.enum(["open", "resolved"]).optional(),
    attachments: z.array(cliAttachmentSchema),
    runId: z.string().min(1).optional(),
  })
  .strict();
export type CliShowMessage = z.infer<typeof cliShowMessageSchema>;

export const cliShowThreadSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    channel: cliChannelSchema,
    commentCount: z.number().int().nonnegative(),
    openDecisionCount: z.number().int().nonnegative(),
  })
  .strict();

export const cliGrepContextMessageSchema = z
  .object({
    messageId: z.string().min(1),
    author: cliAuthorSchema,
    createdAtMs: z.number().int().nonnegative(),
    text: z.string(),
  })
  .strict();
export type CliGrepContextMessage = z.infer<typeof cliGrepContextMessageSchema>;

export const cliGrepMatchSchema = z
  .object({
    channel: cliChannelSchema,
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

export const channelsResultSchema = z
  .object({ channels: z.array(cliChannelSchema) })
  .strict();
export const threadsResultSchema = z
  .object({
    channel: cliChannelSchema,
    threads: z.array(cliThreadSummarySchema),
  })
  .strict();
export const inboxResultSchema = z
  .object({
    threads: z.array(cliInboxThreadSchema),
    mentions: z.array(cliInboxMentionSchema),
  })
  .strict();
export const showResultSchema = z
  .object({
    thread: cliShowThreadSchema,
    messages: z.array(cliShowMessageSchema),
  })
  .strict();
export const postResultSchema = z
  .object({
    channel: cliChannelSchema,
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    title: z.string(),
  })
  .strict();
export const replyResultSchema = z
  .object({
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    parentMessageId: z.string().min(1).optional(),
    resolvedMessageId: z.string().min(1).optional(),
  })
  .strict();
export const reactResultSchema = z
  .object({
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    emoji: z.string().min(1),
    state: z.enum(["added", "removed"]),
  })
  .strict();
export const grepResultSchema = z.union([
  z.object({ matches: z.array(cliGrepMatchSchema) }).strict(),
  z.object({ threadIds: z.array(z.string().min(1)) }).strict(),
]);
export const exportResultSchema = z
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

export const cliResultSchemas = {
  channels: channelsResultSchema,
  threads: threadsResultSchema,
  inbox: inboxResultSchema,
  show: showResultSchema,
  post: postResultSchema,
  reply: replyResultSchema,
  react: reactResultSchema,
  grep: grepResultSchema,
  export: exportResultSchema,
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
