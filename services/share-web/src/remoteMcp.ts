import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createSharedAutomationControls } from "./automationControls";
import { readBoundedJson } from "@dohc/service-http";
import {LINK_REFUSALS, linkRefusalBody, parseLinkRefusal} from "@dohc/security-contract/link-refusal";
import {linkChatRefusalBody, relayLinkRefusal, unavailableLinkRefusal} from "./linkRefusal";
import { asRecord } from "@dohc/workspace-core/records";
import { normalizeShareDiscussionBody } from "@dohc/security-contract/share-discussion";
import { remoteLiveDocument } from "./remoteLiveDocument";
import { shareLinkSummary } from "./shareSummary";
import type { LinkLiveAgentAccess } from "./linkLiveClient";
import type { AgentChatClient } from "./agentChatClient";
import type { NamedLiveBrowserLimits } from "@dohc/ydoc-projection/named-live-browser-transport";
import {
  collectionWriteBody, collectionWriteContentBytes, COLLECTION_WRITES_PATH, MAX_COLLECTION_WRITE_CONTENT_BYTES,
  MAX_COLLECTION_WRITE_ENVELOPE_BYTES, MAX_COLLECTION_WRITE_FILES, MAX_SUBMIT_ID_CHARS, parseCollectionWriteOutcome,
  type CollectionFileWrite,
} from "./collectionWrites";

type RemoteRequest = (path: string, init?: RequestInit) => Promise<Response>;
type RemoteOptions = {
  request: RemoteRequest;
  /** The agent's live documents, when this server edits them live. */
  live?: LinkLiveAgentAccess;
  liveLimits?: NamedLiveBrowserLimits;
  /** Admits a body larger than an ordinary request, for a Collection write: a release, or null when full. */
  admitLargeBody(): (() => void) | null;
  signal: AbortSignal;
  /** When `signal` aborts on its own, so a tool answers before it does. */
  deadlineAtMs: number;
  /**
   * The agent connection's chat. Its posts carry the connection as the
   * author, and it can wait for messages.
   */
  agentChat: AgentChatClient;
};

// An ordinary request fits this. A Collection write carries up to 4 MiB of
// text; JSON escapes a line break, tab, quote, or backslash in two bytes.
const MAX_REQUEST_BYTES = 32 * 1024;
export const COLLECTION_WRITE_TOOL = "dohc_write_collection_files";
const MAX_WRITE_REQUEST_BYTES = 2 * MAX_COLLECTION_WRITE_CONTENT_BYTES + 1024 * 1024;
// Time kept after a write or a wait gives up, to send the tool's answer.
export const ANSWER_RESERVE_MS = 5_000;

const MAX_DISCUSSION_ENVELOPE_BYTES = 16 * 1024;
const discussionPostSchema = z.object({
  body: z.string().describe("Nonempty text, at most 2,000 normalized code points and 8,000 UTF-8 input bytes; no NUL characters.").refine(value => normalizeShareDiscussionBody(value) !== null, "The body must fit 2,000 code points and 8,000 UTF-8 bytes."),
  idempotencyKey: z.string().min(1).max(64).regex(/^[\x20-\x7e]+$/u),
}).refine(value => Buffer.byteLength(JSON.stringify(value)) <= MAX_DISCUSSION_ENVELOPE_BYTES, "The discussion request exceeds 16 KiB.");
// A link on a Group share reads, and with read-write access posts in, the Group's channel.
const linkChannelSchema = z.object({channelWireId: z.string(), access: z.enum(["read-only", "read-write"])});
type LinkChannel = z.infer<typeof linkChannelSchema>;
const LINK_CHAT_BODY_BYTES = 8_000;
export const POST_UNKNOWN = "dohc could not confirm this post, so it may have posted. " +
  "Send it again with the same idempotencyKey and fields; it posts only once.";
/** A chat post's text and key, as every post tool takes them: a link agent's in its Group, and a personal agent's. */
export const chatPostFields = {
  body: z.string().describe("Nonempty text, at most 8,000 UTF-8 bytes after line endings become LF and trailing space is trimmed.")
    .refine(value => {const body = value.replace(/\r\n?/gu, "\n").trimEnd(); return body.length > 0 && Buffer.byteLength(body) <= LINK_CHAT_BODY_BYTES;},
      "The body must be nonempty and fit 8,000 UTF-8 bytes."),
  idempotencyKey: z.string().min(1).max(64).regex(/^[\x20-\x7e]+$/u)
    .describe("Names this post. Send the same key and fields to retry after an unknown outcome; use a new key for a new post."),
};
const channelPostSchema = z.object({
  ...chatPostFields,
  threadId: z.string().min(1).max(256).optional().describe("A threadId from dohc_read_group, to reply in that thread. Omit it to start a thread."),
});

// The longest hold the relay grants one wait.
export const MAX_WAIT_TIMEOUT_MS = 25_000;
const MAX_WAIT_CURSOR_CHARS = 1024 * 1024;
const WAIT_CURSOR_MISMATCH = "This cursor came from a wait with other filters. Call again with the same filters, or without a cursor.";
const waitSchema = z.object({
  cursor: z.string().min(1).max(MAX_WAIT_CURSOR_CHARS).optional()
    .describe("The cursor the last call returned. Omit it to wait for messages after now."),
  thread: z.string().min(1).max(256).optional().describe("A threadId, to wait only for replies in that thread."),
  timeoutMs: z.number().int().min(0).max(MAX_WAIT_TIMEOUT_MS).optional()
    .describe(`How long to wait, in milliseconds, at most ${String(MAX_WAIT_TIMEOUT_MS)}. The default is ${String(MAX_WAIT_TIMEOUT_MS)}.`),
});
const waitAnswerSchema = z.object({
  ok: z.literal(true),
  group: z.object({channelWireId: z.string(), name: z.string().nullable()}),
  mention: z.string(),
  messages: z.array(z.object({
    relaySeq: z.number().int().positive(), messageId: z.string(), threadId: z.string(),
    authorDisplayName: z.string(), authorKind: z.enum(["human", "agent", "automation", "link"]), linkAgent: z.boolean(),
    createdAtMs: z.number().int(), body: z.string().nullable(),
  })),
  cursor: z.number().int().nonnegative(),
});
type WaitScope = {thread: string | null};
// A cursor is opaque to the agent: the relay position and the filters it was returned for.
const encodeWaitCursor = (seq: number, scope: WaitScope) => Buffer.from(JSON.stringify({v: 1, seq, ...scope})).toString("base64url");
function decodeWaitCursor(cursor: string, scope: WaitScope): number | null {
  let value: unknown;
  try {value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));} catch {return null;}
  const record = asRecord(value);
  if (!record || record.v !== 1 || !Number.isSafeInteger(record.seq) || Number(record.seq) < 0 ||
      (record.thread !== null && typeof record.thread !== "string")) return null;
  return record.thread === scope.thread ? Number(record.seq) : null;
}

// Each file names its path and base, and its content as text or as base64: one or the other.
const writtenFile = {
  path: z.string().min(1).max(1024).describe("The file's path exactly as dohc_list_files lists paths."),
  basedOnBlobSha256: z.string().regex(/^[0-9a-f]{64}$/u).nullable()
    .describe("The blobSha256 of the file this replaces, from dohc_list_files, or null to create the file."),
};
/** A Collection write's id and files, as both write tools take them: a link agent's, and a personal agent's with its workspace. */
export const collectionWriteFields = {
  submitId: z.string().min(1).max(MAX_SUBMIT_ID_CHARS).regex(/^[\x20-\x7e]+$/u)
    .describe("Names this write. Send the same id to retry after an unknown outcome; use a new id for any other write."),
  files: z.array(z.union([
    z.object({...writtenFile, text: z.string().describe("The file's complete new text.")}).strict(),
    z.object({...writtenFile, base64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/u).refine(value => value.length % 4 === 0, "Base64 comes in groups of four characters.")
      .describe("The file's complete new UTF-8 content as base64, for text whose JSON would not fit in 9 MiB.")}).strict(),
  ])).min(1).max(MAX_COLLECTION_WRITE_FILES),
};
/** Each write tool checks its whole input against what one write carries. */
export const fitsCollectionWrite = (value: {files: readonly CollectionFileWrite[]}) =>
  collectionWriteContentBytes(value.files) <= MAX_COLLECTION_WRITE_CONTENT_BYTES;
export const COLLECTION_WRITE_TOO_LARGE = "The files' content exceeds 4 MiB in all.";
const collectionWriteSchema = z.object(collectionWriteFields).refine(fitsCollectionWrite, COLLECTION_WRITE_TOO_LARGE);
/** What a write changes and what its answers mean, as each write tool says it after naming who writes. */
export const COLLECTION_WRITE_GUIDE = "edit its collection.yaml, create or replace the automations.yaml beside it, " +
  "create one Markdown record in an existing document Collection, with a frontmatter id of rec_ followed by 26 lowercase base32 characters, " +
  "or create a new Collection in a new folder with its collection.yaml, an optional automations.yaml, and up to 500 Markdown records. " +
  "Read a file with dohc_read_file before replacing it. The files apply together or not at all. Send this tool alone, not in a batch. " +
  "stale means the file changed since you read it: read it again, merge your change, and send it with a new submitId. " +
  "refused gives the reason. unknown means the answer was lost: send the same request again. " +
  "accepted means the change is in the owner's workspace history; the owner's computer applies it when it next syncs.";
export const fileInventorySchema = z.object({
  ok: z.literal(true),
  files: z.array(z.object({path: z.string(), objectId: z.string().regex(/^share-object:v1:[0-9a-f]{64}$/u).optional(), blobSha256: z.string(), contentKind: z.enum(["text", "binary"]), automationSwitchable: z.boolean().optional()})),
});

const receivedObject = z.string().regex(/^share-object:v1:[0-9a-f]{64}$/u).optional();
const logSha = z.string().regex(/^[0-9a-f]{64}$/u);
const logPath = z.string().min(1);
const linkLogSchema = z.object({
  ok: z.literal(true),
  ops: z.array(z.discriminatedUnion("opKind", [
    z.object({opKind: z.literal("workspace.init")}),
    z.object({opKind: z.literal("moment.append"), recordedAtMs: z.number(), payload: z.object({
      objectId: receivedObject, operation: z.enum(["write", "rename", "delete"]), payloadBeforePath: logPath.optional(),
      payloadAfterPath: logPath.optional(), payloadBeforeBlobSha256: logSha.nullable().optional(),
      payloadAfterBlobSha256: logSha.optional(), payloadAfterContentKind: z.literal("binary").optional(),
    })}),
    z.object({opKind: z.literal("version.create"), recordedAtMs: z.number(), payload: z.object({
      versionId: z.string(), forkSnapshots: z.array(z.object({path: logPath, objectId: receivedObject, blobSha256: logSha.optional(), contentKind: z.literal("binary").optional()})),
    })}),
  ])),
  nextCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  epochLogFloor: z.number().int().nonnegative(),
});
type LinkLogOp = z.infer<typeof linkLogSchema>["ops"][number];

// One change per logged moment, named like the engine's history: beforeBlobSha256 and afterBlobSha256.
// A link reads an afterBlobSha256 only while its file is still in the share (docs/engineering/security-boundaries.md).
function linkChange(op: LinkLogOp): Record<string, unknown> | null {
  if (op.opKind === "workspace.init") return null;
  if (op.opKind === "version.create") return {recordedAtMs: op.recordedAtMs, operation: "version", versionId: op.payload.versionId,
    files: op.payload.forkSnapshots.map(file => ({path: file.path, ...(file.objectId ? {objectId: file.objectId} : {}), ...(file.blobSha256 ? {blobSha256: file.blobSha256} : {}), contentKind: file.contentKind ?? "text"}))};
  const {operation, payloadBeforePath: beforePath, payloadAfterPath: afterPath, payloadBeforeBlobSha256: beforeBlobSha256, payloadAfterBlobSha256: afterBlobSha256} = op.payload;
  const path = operation === "delete" ? beforePath : afterPath;
  if (!path) return null;
  return {recordedAtMs: op.recordedAtMs, operation, path, ...(op.payload.objectId ? {objectId: op.payload.objectId} : {}), ...(operation === "rename" && beforePath ? {beforePath} : {}),
    ...(operation !== "delete" && afterBlobSha256 ? {afterBlobSha256, contentKind: op.payload.payloadAfterContentKind ?? "text"} : {}),
    ...(beforeBlobSha256 ? {beforeBlobSha256} : {})};
}

const MAX_TOOL_RESULT_BYTES = 1024 * 1024;
const text = (value: unknown): CallToolResult => {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_TOOL_RESULT_BYTES) return error("The result exceeds the 1 MiB response limit.");
  return {content: [{type: "text", text: encoded}], ...(value && typeof value === "object" ? {structuredContent: value as Record<string, unknown>, ...("ok" in value && value.ok === false ? {isError: true} : {})} : {})};
};
const error = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });
export {text as toolResult, error as toolError};
// A post whose answer was lost may have landed, so it answers null; its key makes a retry safe.
export const sentPost = async (send: () => Promise<Response>): Promise<Response | null> => {
  const response = await send().catch(() => null);
  if (response?.status !== 503) return response;
  await response.body?.cancel().catch(() => {});
  return null;
};
const postUnknown = (): CallToolResult => text({ok: false, code: "link_unavailable", error: POST_UNKNOWN});
const json = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  if (!response.ok) {
    const value = await readBoundedJson(response, 4096, signal).catch(() => null);
    await response.body?.cancel().catch(() => undefined);
    const code = parseLinkRefusal(value, response.status);
    throw new Error(code ? LINK_REFUSALS[code].error : "not found");
  }
  return readBoundedJson(response, 1024 * 1024, signal);
};

function buildServer(options: RemoteOptions, metadata: Record<string, unknown>, channel: LinkChannel | null): McpServer {
  const jsonResponse = (response: Response) => json(response, options.signal);
  const server = new McpServer({ name: "dohc-share", version: "0.1.0" }, { capabilities: { tools: {} } });
  const controls = createSharedAutomationControls({ ...options, metadata });
  server.registerTool("dohc_list_automations", {
    description: "Read automation definitions and on/off file state in a shared Collection. Host runtime and run history are unavailable.",
    inputSchema: z.object({ collectionPath: z.string().min(1).max(4096) }),
  }, async ({ collectionPath }) => {
    try { return text({ ok: true, definitions: await controls.list(collectionPath) }); }
    catch (e) { return error(e instanceof Error ? e.message : String(e)); }
  });
  if (collectionWritesAllowed(metadata)) server.registerTool("dohc_switch_automation", {
    description: "Change only one automation's enabled value. Read definitions first and provide their contentHash. Reformat confirms losing comments and hand formatting. Retry an unknown result with the same submitId and input. Acceptance records workspace history; it does not acknowledge host execution.",
    inputSchema: z.object({ collectionPath: z.string().min(1).max(4096), automation: z.string().min(1).max(64),
      enabled: z.boolean(), expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/u), reformat: z.boolean().default(false),
      submitId: z.string().min(1).max(64).regex(/^[\x20-\x7e]+$/u) }),
  }, async ({ collectionPath, ...input }) => {
    try { return text({ ok: true, result: await controls.switch(collectionPath, input) }); }
    catch (e) { return error(e instanceof Error ? e.message : String(e)); }
  });
  server.registerTool("dohc_share_status", { description: "Read the current share permissions and release state.", inputSchema: z.object({}) }, async () => {
    const summary = shareLinkSummary(metadata, Boolean(options.live && options.liveLimits));
    return text({ ...metadata, summary: `${summary.subject}. ${summary.permissions} ${summary.included} ${summary.history}` });
  });
  server.registerTool("dohc_list_files", {
    description: "List files visible through this shared link. Paths are relative to the share.",
    inputSchema: z.object({}),
  }, async () => {
    try {
      return text(await jsonResponse(await options.request("/api/view/current")));
    } catch (e) { return error(e instanceof Error ? e.message : String(e)); }
  });
  if (metadata.access === "edit") server.registerTool("dohc_list_changes", {
    description: "List changes to files in this shared link, oldest first. since is a log cursor, not a timestamp: pass nextCursor from this tool or from dohc_list_files to read only later changes. If epochLogFloor is above your since, earlier changes are gone, so start again from dohc_list_files. dohc_read_file reads an afterBlobSha256 while its file is still in the share.",
    inputSchema: z.object({since: z.number().int().nonnegative().optional(), limit: z.number().int().positive().max(500).optional()}),
  }, async ({since, limit}) => {
    try {
      const page = linkLogSchema.parse(await jsonResponse(await options.request(`/api/view/log?${new URLSearchParams({since: String(since ?? 0), limit: String(limit ?? 100)})}`)));
      return text({ok: true, changes: page.ops.flatMap(op => linkChange(op) ?? []), nextCursor: page.nextCursor, hasMore: page.hasMore, epochLogFloor: page.epochLogFloor});
    } catch (e) { return error(e instanceof Error ? e.message : String(e)); }
  });
  server.registerTool("dohc_read_file", {
    description: "Read up to 256 KiB of current file content using a current hash from dohc_list_files. Markdown may lag the live document. Binary files are base64 encoded." +
      (metadata.access === "edit" ? " Edit links can also read an afterBlobSha256 from dohc_list_changes for an earlier revision still in the share. Earlier revisions use UTF-8 when their bytes decode, otherwise base64." : " History is unavailable with view or comment access."),
    inputSchema: z.object({ blobSha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  }, async ({ blobSha256 }) => {
    try {
      const response = await options.request(`/api/view/blob/${blobSha256}`);
      if (!response.ok) {await json(response, options.signal); return error("not found");}
      const bytes = await boundedBytes(response, 256 * 1024, options.signal);
      const inventory = fileInventorySchema.parse(await jsonResponse(await options.request("/api/view/current")));
      const files = inventory.files.filter(file => file.blobSha256 === blobSha256);
      if (files.some(file => file.contentKind === "binary")) return text({ok: true, source: "settled", encoding: "base64", content: bytes.toString("base64")});
      try {return text({ok: true, source: "settled", encoding: "utf8", content: new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes)});}
      catch {return text({ok: true, source: "settled", encoding: "base64", content: bytes.toString("base64")});}
    } catch (e) { return error(e instanceof Error ? e.message : String(e)); }
  });
  // A Group link's conversation is the Group's channel, as in the viewer; any other link's is the share's discussion.
  if (!channel) server.registerTool("dohc_read_discussion", {
    description: "Read the discussion attached to this shared link.", inputSchema: z.object({ cursor: z.string().optional(), limit: z.number().int().positive().max(100).optional() }),
  }, async ({ cursor, limit }) => {
    try { const query = new URLSearchParams(); if (cursor) query.set("cursor", cursor); if (limit) query.set("limit", String(limit)); return text(await jsonResponse(await options.request(`/api/view/discussion?${query}`))); }
    catch (e) { return error(e instanceof Error ? e.message : String(e)); }
  });
  if (!channel && (metadata.access === "comment" || metadata.access === "edit")) server.registerTool("dohc_post_discussion", {
    description: "Post a discussion message to this shared link when its permissions allow comments. The post shows the name your client reported when you signed in.",
    inputSchema: discussionPostSchema,
  }, async ({ body, idempotencyKey }) => {
    const response = await sentPost(() => options.request("/api/view/discussion", { method: "POST", body: JSON.stringify({ body, idempotencyKey }) }));
    if (!response) return postUnknown();
    try {
      return text(await jsonResponse(response));
    } catch (e) { return error(e instanceof Error ? e.message : String(e)); }
  });
  if (channel) {
    const coordinates = {channelWireId: channel.channelWireId};
    server.registerTool("dohc_read_group", {
      description: "Read the Group this link shares. Without since, messages come newest first: pass before=olderCursor for earlier ones. " +
        "With since=nextCursor, messages come oldest first: keep each nextCursor and read again while hasMore is true. " +
        "authorKind link marks a link holder's post: its name was chosen by that link holder and nobody verified it.",
      inputSchema: z.object({before: z.number().int().nonnegative().optional(), since: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(100).optional()}).refine(value => value.before === undefined || value.since === undefined, "Send before or since, not both."),
    }, async ({before, since, limit}) => {
      try {
        const query = new URLSearchParams({...coordinates, ...(before === undefined ? {} : {before: String(before)}),
          ...(since === undefined ? {} : {since: String(since)}), ...(limit === undefined ? {} : {limit: String(limit)})});
        return text(await jsonResponse(await options.request(`/api/view/chat/messages?${query}`)));
      } catch (e) { return error(e instanceof Error ? e.message : String(e)); }
    });
    const {agentChat} = options;
    if (channel.access === "read-write") server.registerTool("dohc_post_group", {
      description: "Post in the Group this link shares. The post shows as from you, an agent that joined with this link.",
      inputSchema: channelPostSchema,
    }, async ({body, idempotencyKey, threadId}) => {
      const response = await sentPost(() => agentChat.post({body, idempotencyKey, ...(threadId === undefined ? {} : {threadId})}, options.signal));
      if (!response) return postUnknown();
      try {
        if (!response.ok && response.status !== 404) {
          // In this server's words, as the viewer shows them; never the relay's own.
          const value = await readBoundedJson(response.clone(), 4096, options.signal).catch(() => null);
          const code = parseLinkRefusal(value, response.status);
          const refusal = linkChatRefusalBody(value, response.status) ?? (code ? linkRefusalBody(code) : null);
          if (refusal) return text(refusal);
        }
        return text(await jsonResponse(response));
      } catch (e) { return error(e instanceof Error ? e.message : String(e)); }
    });
    // Holds until a message arrives or the wait ends, and answers before this request's own deadline.
    server.registerTool("dohc_wait_for_messages", {
      description: "Wait for messages for you in the Group this link shares: a mention of you, or a reply in a thread you posted in. " +
        "People mention you as the answer's mention. Call in a loop with the returned cursor and the same filters; " +
        "without a cursor, it starts from when you signed in. " +
        "It answers as soon as a message arrives, or with no messages once timeoutMs passes or after skipping a long stretch of other messages. " +
        "Your own posts are not returned. Nothing is marked read. " +
        "author.kind link marks a link holder: their name was chosen by them and nobody verified it. linkAgent marks an agent that joined with this link.",
      inputSchema: waitSchema,
    }, async ({cursor, thread, timeoutMs}) => {
      const scope: WaitScope = {thread: thread ?? null};
      const seq = cursor === undefined ? undefined : decodeWaitCursor(cursor, scope);
      if (seq === null) return error(WAIT_CURSOR_MISMATCH);
      const hold = Math.max(0, Math.min(timeoutMs ?? MAX_WAIT_TIMEOUT_MS, options.deadlineAtMs - Date.now() - ANSWER_RESERVE_MS));
      try {
        const answer = waitAnswerSchema.parse(await jsonResponse(await agentChat.wait({
          ...(seq === undefined ? {} : {cursor: seq}), ...(thread === undefined ? {} : {threadId: thread}), timeoutMs: hold,
        }, options.signal)));
        const group = {id: answer.group.channelWireId, name: answer.group.name, kind: "group" as const};
        const messages = answer.messages.map(message => ({
          threadId: message.threadId, messageId: message.messageId, group,
          author: {kind: message.authorKind, displayName: message.authorDisplayName, ...(message.linkAgent ? {linkAgent: true} : {})},
          createdAtMs: message.createdAtMs, text: message.body,
        }));
        // The messages that fit the result, and a cursor that ends at the last one, so the next call returns the rest.
        let bytes = Buffer.byteLength(JSON.stringify({messages: [], mention: answer.mention, cursor: encodeWaitCursor(answer.cursor, scope)}));
        let kept = 0;
        for (const message of messages) {
          bytes += Buffer.byteLength(JSON.stringify(message)) + 1;
          if (bytes > MAX_TOOL_RESULT_BYTES && kept > 0) break;
          kept++;
        }
        const last = kept === messages.length ? answer.cursor : answer.messages[kept - 1]!.relaySeq;
        return text({messages: messages.slice(0, kept), mention: answer.mention, cursor: encodeWaitCursor(last, scope)});
      } catch (e) { return error(e instanceof Error ? e.message : String(e)); }
    });
  }
  if (collectionWritesAllowed(metadata)) server.registerTool(COLLECTION_WRITE_TOOL, {
    description: "Change a Collection's own files through this Edit link: " + COLLECTION_WRITE_GUIDE,
    inputSchema: collectionWriteSchema,
  }, async ({submitId, files}) => {
    // A write that runs out of time may still have committed: it is unknown,
    // answered before this request's own deadline.
    try {
      const signal = AbortSignal.timeout(Math.max(0, options.deadlineAtMs - Date.now() - ANSWER_RESERVE_MS));
      const response = await options.request(COLLECTION_WRITES_PATH, {method: "POST", signal, body: collectionWriteBody(submitId, files, Date.now())});
      return text(parseCollectionWriteOutcome(response.status, await readBoundedJson(response, 16 * 1024, signal).catch(() => null)));
    } catch { return text({ok: false, outcome: "unknown"}); }
  });
  const selector = metadata.effectiveSelector as {versionId?: string | null} | undefined;
  if (metadata.access === "edit" && selector?.versionId === null && options.live && options.liveLimits) {
  const liveOptions = {live: options.live, limits: options.liveLimits, signal: options.signal};
  server.registerTool("dohc_read_document", {
    description: "Read the current live Markdown document before editing. Requires an online document host and an Edit link.",
    inputSchema: z.object({path: z.string().max(1024).regex(/\.md$/i)}),
  }, async ({path}) => text(await remoteLiveDocument(liveOptions, path)));
  server.registerTool("dohc_edit_document", {
    description: "Replace text in an existing live Markdown document. Read it first. Supply find as document text without Markdown syntax: use world for **world**. Text must occur once within one formatting run. On outcome unknown, re-read before retrying. Applied means durable host acknowledgement, not Markdown settlement.",
    inputSchema: z.object({ path: z.string().max(1024).regex(/\.md$/i), find: z.string().min(1).max(8_000), replacement: z.string().max(8_000) }),
  }, async ({ path, find, replacement }) => {
    return text(await remoteLiveDocument(liveOptions, path, {find, replacement}));
  });
  }
  return server;
}

export async function serveRemoteMcp(request: Request, options: RemoteOptions): Promise<{ body: BodyInit | null; status: number; headers: Headers }> {
  const metadataResponse = await options.request("/api/view/meta");
  if (!metadataResponse.ok) {
    const result = await relayLinkRefusal(metadataResponse, options.signal);
    await metadataResponse.body?.cancel().catch(() => {});
    return {body: result.body, status: result.status, headers: result.headers};
  }
  // The share's answer names the tools, so one lost mid-body fails the request instead of dropping any.
  let metadata: Record<string, unknown>;
  try {metadata = await json(metadataResponse, options.signal) as Record<string, unknown>;}
  catch {const result = unavailableLinkRefusal(); return {body: result.body, status: result.status, headers: result.headers};}
  if (metadata.ok !== true) throw new Error("Share is unavailable.");
  // Only a Group share's link has a channel.
  const channel = metadata.channel === undefined ? null : linkChannelSchema.parse(metadata.channel);
  const body = request.method === "POST"
    ? await readRequestJson(request, options.signal, collectionWritesAllowed(metadata) ? options.admitLargeBody : null)
    : {value: undefined, release: () => {}};
  if (!body) return {body: null, status: 429, headers: new Headers()};
  try {
    const parsedBody = body.value;
    return refuseBatchedWrite(parsedBody, [COLLECTION_WRITE_TOOL, "dohc_switch_automation"]) ??
      await answerMcp(request, parsedBody, () => buildServer(options, metadata, channel), options.signal);
  } finally {body.release();}
}

/**
 * A write goes in a request of its own, so its answer never waits on, or
 * shares a deadline or a body slot with, another call. A batch holding one
 * of these tools is refused whole.
 */
export function refuseBatchedWrite(parsedBody: unknown, tools: readonly string[]): { body: BodyInit | null; status: number; headers: Headers } | null {
  const batchedWrite = Array.isArray(parsedBody) ? parsedBody.find(message => asRecord(message)?.method === "tools/call" &&
    tools.includes(String(asRecord(asRecord(message)?.params)?.name))) : undefined;
  if (!batchedWrite) return null;
  const name = String(asRecord(asRecord(batchedWrite)?.params)?.name);
  const result = Response.json({jsonrpc: "2.0", id: null, error: {code: -32600, message: `Send ${name} in a request of its own, not in a batch.`}});
  return {body: result.body, status: result.status, headers: result.headers};
}

/** Answers one MCP request with a server of its own: no session outlives the request, and nothing subscribes. */
export async function answerMcp(request: Request, parsedBody: unknown, build: () => McpServer, signal: AbortSignal):
  Promise<{ body: BodyInit | null; status: number; headers: Headers }> {
  if (parsedBody && typeof parsedBody === "object" && "method" in parsedBody && parsedBody.method === "subscriptions/listen") {
    const result = Response.json({jsonrpc: "2.0", id: "id" in parsedBody ? parsedBody.id : null, error: {code: -32601, message: "This endpoint does not offer subscriptions."}});
    return {body: result.body, status: result.status, headers: result.headers};
  }
  const handler = createMcpHandler(build);
  try {
    const response = await handler.fetch(request, {parsedBody});
    return { body: response.body ? await boundedBytes(response, 4 * 1024 * 1024, signal) : null, status: response.status, headers: response.headers };
  } finally {await handler.close();}
}

/**
 * Reads a request's JSON. Past an ordinary request's size it needs one of the
 * few large-body slots, which only a caller that writes Collections asks for:
 * the body with the slot's release, null when no slot is free, or a throw.
 */
export async function readRequestJson(request: Request, signal: AbortSignal, admitLarge: (() => (() => void) | null) | null):
  Promise<{value: unknown; release(): void} | null> {
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("Missing JSON body.");
  const chunks: Uint8Array[] = []; let size = 0, limit = MAX_REQUEST_BYTES, release = () => {};
  const abort = () => {void reader.cancel().catch(() => {});};
  signal.addEventListener("abort", abort, {once: true});
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
      if (next.value.byteLength > limit - size) {
        const admitted = limit === MAX_REQUEST_BYTES && admitLarge ? admitLarge() : undefined;
        if (admitted === null) return null;
        if (!admitted) throw new RangeError("The request exceeds the size limit.");
        release = admitted; limit = MAX_WRITE_REQUEST_BYTES;
        if (next.value.byteLength > limit - size) throw new RangeError("The request exceeds the size limit.");
      }
      size += next.value.byteLength; chunks.push(next.value);
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks, size)));
    return {value, release};
  } catch (error) {release(); throw error;}
  finally {signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock();}
}

/** An Edit link on the current version writes a Collection's own files. */
function collectionWritesAllowed(metadata: Record<string, unknown>): boolean {
  const selector = metadata.effectiveSelector as {versionId?: string | null} | undefined;
  return metadata.access === "edit" && selector?.versionId === null;
}

export class ResponseTooLargeError extends Error {
  constructor() { super("The response exceeds the size limit."); }
}

export async function boundedBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The response has no content.");
  const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => {void reader.cancel().catch(() => {});};
  signal.addEventListener("abort", abort, {once: true});
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
      size += next.value.length; if (size > maxBytes) throw new ResponseTooLargeError();
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally {signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock();}
}
