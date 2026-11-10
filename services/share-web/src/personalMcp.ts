import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { readBoundedJson } from "@dohc/service-http";
import { asRecord } from "@dohc/workspace-core/records";
import {
  ANSWER_RESERVE_MS, answerMcp, boundedBytes, chatPostFields, MAX_WAIT_TIMEOUT_MS, POST_UNKNOWN, readRequestJson,
  ResponseTooLargeError, sentPost, toolError, toolResult,
} from "./remoteMcp";
import type { PersonalAgentAction, PersonalAgentClient } from "./personalAgentClient";

// The MCP server a personal agent signs in to at /mcp/agent/w/<workspace>.
// Its token reaches the workspaces its owner chose, each at View or Comment,
// so every tool but the list and the wait names one. The relay checks the
// token, the reach and the level on every call; this server only words the
// answers.

type McpAnswer = { body: BodyInit | null; status: number; headers: Headers };

export interface PersonalMcpOptions {
  client: PersonalAgentClient;
  signal: AbortSignal;
  /** When `signal` aborts on its own, so a wait answers before it does. */
  deadlineAtMs: number;
}

export const PERSONAL_SIGN_IN_UNAVAILABLE = "dohc can't check this agent's sign-in right now. Try again shortly.";
const UNAVAILABLE = {ok: false as const, code: "unavailable", error: PERSONAL_SIGN_IN_UNAVAILABLE};
const RATE_LIMITED = {ok: false as const, code: "rate_limited", error: "This agent has reached its request limit. Try again in a minute."};

type Refused = {status: number; code: string; error: string};

// The relay's refusals an agent acts on, by the relay's code and status, as
// this server's code and words. The relay's own words never pass. A refusal
// out of reach or at View names the agent, from the reach that starts each
// request.
const outOfReach = (agentName: string): Refused => ({status: 403, code: "out_of_reach",
  error: `${agentName} can't reach this workspace. Its owner can change that in Settings › Agents.`});
const viewOnly = (agentName: string): Refused => ({status: 403, code: "view_only",
  error: `${agentName} can read this workspace but not post in it. Its owner can change that in Settings › Agents.`});
const REFUSALS: Readonly<Record<string, Refused>> = {
  personal_agent_unavailable: {status: 503, code: UNAVAILABLE.code, error: UNAVAILABLE.error},
  link_read_rate_limited: {status: 429, code: RATE_LIMITED.code, error: RATE_LIMITED.error},
  conflict: {status: 409, code: "conflict", error: "This message's key was already used for a different message. Send it as a new message."},
  quota_exceeded: {status: 413, code: "quota_exceeded", error: "This workspace is full. Ask its owner to free space, then send this message again."},
  server_busy: {status: 503, code: "busy", error: "dohc is busy reading this workspace. Try again shortly."},
  server_copies_off: {status: 404, code: "no_server_copies",
    error: "This server doesn't keep workspace copies, so it can't list Groups. The DM still works."},
};

// What a tool says when the relay finds nothing, refuses its input, or fails
// in a way this server does not word.
type Words = {not_found: string; bad_request: string; failed?: object};
const NO_WORKSPACE = "dohc could not find this workspace. Use a workspace id from dohc_list_workspaces.";
const POST_UNCONFIRMED = {ok: false as const, code: UNAVAILABLE.code, error: POST_UNKNOWN};

/** A relay refusal, already worded as the tool's answer. */
class Refusal extends Error {
  constructor(readonly result: CallToolResult) {super("refused");}
}

const reachSchema = z.object({
  ok: z.literal(true),
  agent: z.object({name: z.string(), handle: z.string()}),
  workspaces: z.array(z.object({
    workspaceId: z.string(), name: z.string().nullable(), level: z.enum(["view", "comment"]), dmChannelWireId: z.string(),
  })),
});
type Reach = z.infer<typeof reachSchema>;
const groupsSchema = z.object({
  ok: z.literal(true),
  groups: z.array(z.object({channelWireId: z.string(), name: z.string(), purpose: z.string().nullable()})),
});
const filesSchema = z.object({
  ok: z.literal(true),
  files: z.array(z.object({path: z.string(), blobSha256: z.string(), contentKind: z.enum(["text", "binary"])})),
  truncated: z.boolean(),
});
const messageSchema = z.object({
  relaySeq: z.number().int().positive(), messageId: z.string(), threadId: z.string(),
  authorDisplayName: z.string(), authorKind: z.enum(["human", "agent", "automation", "link"]), linkAgent: z.boolean(),
  authorOwnerDisplayName: z.string().nullable(), createdAtMs: z.number().int(), body: z.string().nullable(), bodyTooLarge: z.boolean(),
});
const pageSchema = z.object({ok: z.literal(true), messages: z.array(messageSchema), olderCursor: z.number().int().nonnegative().nullable()});
// One Comment thread, with the path its file has or, once deleted, last had.
const threadPageSchema = pageSchema.extend({threadId: z.string(), filePath: z.string()});
const postedSchema = z.object({
  ok: z.literal(true),
  // Exactly one of channelWireId and filePath names where the post landed.
  message: messageSchema.extend({workspaceId: z.string(), channelWireId: z.string().nullable(), filePath: z.string().nullable()}),
});
const relayCursorSchema = z.object({
  v: z.literal(1), agentId: z.string(), seqs: z.record(z.string(), z.number().int().nonnegative()), turn: z.string().nullable(),
}).strict();
const waitAnswerSchema = z.object({
  ok: z.literal(true),
  messages: z.array(messageSchema.extend({workspaceId: z.string(), channelWireId: z.string().nullable(), filePath: z.string().nullable()})),
  cursor: relayCursorSchema,
  more: z.boolean(),
});

// A cursor is opaque to the agent: the relay's place in each workspace, as it gave it.
const MAX_WAIT_CURSOR_CHARS = 64 * 1024;
const WAIT_CURSOR_REFUSED = "This cursor did not come from this agent's last dohc_wait_for_messages. Call again without a cursor.";
const encodeWaitCursor = (cursor: z.infer<typeof relayCursorSchema>) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
function decodeWaitCursor(cursor: string): z.infer<typeof relayCursorSchema> | null {
  try {return relayCursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));}
  catch {return null;}
}

const workspaceArg = () => z.string().min(1).max(256).describe("A workspace id from dohc_list_workspaces.");
const pageArgs = () => ({before: z.number().int().nonnegative().optional(), limit: z.number().int().positive().max(100).optional()});
const UNVERIFIED_LINK = "authorKind link marks a link holder's post: its name was chosen by that link holder and nobody verified it.";

/**
 * Answers one MCP request from a personal agent, or null when its token is
 * not one the relay accepts at this address, for the caller's challenge.
 */
export async function servePersonalMcp(request: Request, options: PersonalMcpOptions): Promise<McpAnswer | null> {
  // The reach answers first, so a token that ended gets the challenge before
  // any tool runs, and the list of workspaces comes from the same check.
  const probe = await options.client.call("workspaces", {}, options.signal).catch(() => null);
  if (probe?.status === 404) {await probe.body?.cancel().catch(() => undefined); return null;}
  if (probe?.status === 429) {await probe.body?.cancel().catch(() => undefined); return refusal(429, RATE_LIMITED);}
  let reach: Reach;
  try {
    if (!probe?.ok) throw new Error("unavailable");
    reach = reachSchema.parse(await readBoundedJson(probe, 1024 * 1024, options.signal));
  } catch {
    await probe?.body?.cancel().catch(() => undefined);
    return refusal(503, UNAVAILABLE);
  }
  const body = request.method === "POST" ? await readRequestJson(request, options.signal, null) : {value: undefined, release: () => {}};
  if (!body) return {body: null, status: 429, headers: new Headers()};
  try {return await answerMcp(request, body.value, () => buildServer(options, reach), options.signal);}
  finally {body.release();}
}

function refusal(status: number, value: object): McpAnswer {
  const result = Response.json(value, {status});
  return {body: result.body, status: result.status, headers: result.headers};
}

function buildServer(options: PersonalMcpOptions, reach: Reach): McpServer {
  const {client, signal} = options;
  const call = (action: PersonalAgentAction, body: Record<string, unknown>) => client.call(action, body, signal);
  const server = new McpServer({name: "dohc-personal", version: "0.1.0"}, {capabilities: {tools: {}}});
  const refusals: Readonly<Record<string, Refused>> = {
    ...REFUSALS, personal_agent_out_of_reach: outOfReach(reach.agent.name), personal_agent_view_only: viewOnly(reach.agent.name),
  };

  // A relay refusal as a tool's answer: a known code in this server's words,
  // or the tool's own words for nothing found and refused input.
  const refused = async (response: Response, words: Words): Promise<CallToolResult> => {
    const value = await readBoundedJson(response, 4096, signal).catch(() => null);
    await response.body?.cancel().catch(() => undefined);
    const code = asRecord(value)?.code;
    const known = typeof code === "string" && Object.hasOwn(refusals, code) ? refusals[code] : undefined;
    if (known?.status === response.status) return toolResult({ok: false, code: known.code, error: known.error});
    if (response.status === 404) return toolResult({ok: false, code: "not_found", error: words.not_found});
    if (response.status === 400) return toolResult({ok: false, code: "bad_request", error: words.bad_request});
    if (response.status === 429) return toolResult(RATE_LIMITED);
    return toolResult(words.failed ?? UNAVAILABLE);
  };
  // The relay's answer, read in full; a refusal throws as the tool's answer.
  const answered = async <S extends z.ZodType>(response: Response, schema: S, words: Words): Promise<z.output<S>> => {
    if (!response.ok) throw new Refusal(await refused(response, words));
    return schema.parse(await readBoundedJson(response, 1024 * 1024, signal));
  };
  const failed = (e: unknown, otherwise: object = UNAVAILABLE): CallToolResult =>
    e instanceof Refusal ? e.result : e instanceof ResponseTooLargeError ? toolError(e.message) : toolResult(otherwise);

  server.registerTool("dohc_list_workspaces", {
    description: "List the workspaces your owner lets you reach, with your level in each: view reads, and comment also posts in its chat and on its files. " +
      "dmChannel is your direct messages with your owner in that workspace, for dohc_read_channel and dohc_post_channel. " +
      "agent is your name as your posts show it, and the handle people mention you by, written after an @. " +
      "Pass a workspace's id as workspace to the other tools. Your owner changes this list in Settings › Agents.",
    inputSchema: z.object({}),
  }, async () => toolResult({
    ok: true,
    agent: {name: reach.agent.name, handle: reach.agent.handle},
    workspaces: reach.workspaces.map(entry => ({workspace: entry.workspaceId, name: entry.name, level: entry.level, dmChannel: entry.dmChannelWireId})),
  }));

  server.registerTool("dohc_list_groups", {
    description: "List the Groups in a workspace you can reach, each with its channel for dohc_read_channel and, where you have Comment, dohc_post_channel. " +
      "Direct messages are not listed: dohc_list_workspaces names yours.",
    inputSchema: z.object({workspace: workspaceArg()}),
  }, async ({workspace}) => {
    try {
      const listed = await answered(await call("groups", {workspaceId: workspace}), groupsSchema,
        {not_found: "dohc could not find this workspace's Groups. Use a workspace id from dohc_list_workspaces.", bad_request: NO_WORKSPACE});
      return toolResult({ok: true, workspace, groups: listed.groups.map(group => ({channel: group.channelWireId, name: group.name, purpose: group.purpose}))});
    } catch (e) {return failed(e);}
  });

  server.registerTool("dohc_list_files", {
    description: "List the current files in a workspace you can reach. Paths are relative to the workspace. truncated means it has more files than one answer lists.",
    inputSchema: z.object({workspace: workspaceArg()}),
  }, async ({workspace}) => {
    try {
      const page = await answered(await call("files", {workspaceId: workspace}), filesSchema, {not_found: NO_WORKSPACE, bad_request: NO_WORKSPACE});
      return toolResult({ok: true, workspace, files: page.files, truncated: page.truncated});
    } catch (e) {return failed(e);}
  });

  server.registerTool("dohc_read_file", {
    description: "Read up to 256 KiB of a current file in a workspace you can reach, using its blobSha256 from dohc_list_files. " +
      "Markdown may lag the live document. Binary files are base64 encoded.",
    inputSchema: z.object({workspace: workspaceArg(), blobSha256: z.string().regex(/^[0-9a-f]{64}$/)}),
  }, async ({workspace, blobSha256}) => {
    const words = {not_found: "dohc could not find a current file with this blobSha256 in this workspace. List its files again with dohc_list_files.", bad_request: NO_WORKSPACE};
    try {
      const response = await call("blob", {workspaceId: workspace, sha256: blobSha256});
      if (!response.ok) return await refused(response, words);
      const bytes = await boundedBytes(response, 256 * 1024, signal);
      const inventory = await answered(await call("files", {workspaceId: workspace}), filesSchema, words);
      if (inventory.files.some(file => file.blobSha256 === blobSha256 && file.contentKind === "binary")) {
        return toolResult({ok: true, source: "settled", encoding: "base64", content: bytes.toString("base64")});
      }
      try {return toolResult({ok: true, source: "settled", encoding: "utf8", content: new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes)});}
      catch {return toolResult({ok: true, source: "settled", encoding: "base64", content: bytes.toString("base64")});}
    } catch (e) {return failed(e);}
  });

  server.registerTool("dohc_read_channel", {
    description: "Read a channel in a workspace you can reach: your direct messages with your owner, or a Group's channel. " +
      "Each message from dohc_wait_for_messages names its channel. Messages come newest first: pass before=olderCursor for earlier ones. " +
      UNVERIFIED_LINK,
    inputSchema: z.object({
      workspace: workspaceArg(),
      channel: z.string().min(1).max(256)
        .describe("A channel id: your dmChannel from dohc_list_workspaces, a Group's channel from dohc_list_groups, or a message's channel."),
      ...pageArgs(),
    }),
  }, async ({workspace, channel, before, limit}) => {
    try {
      const page = await answered(await call("chat", {workspaceId: workspace, channelWireId: channel,
        ...(before === undefined ? {} : {before}), ...(limit === undefined ? {} : {limit})}), pageSchema,
      {not_found: "dohc could not find this channel in this workspace.", bad_request: "dohc could not read this channel. Check its workspace and channel id."});
      return toolResult({ok: true, workspace, channel, messages: page.messages, olderCursor: page.olderCursor});
    } catch (e) {return failed(e);}
  });

  // A post names one place: a channel or a file to start a thread, or a thread to reply in.
  const post = async (workspace: string, target: Record<string, string>, body: string, idempotencyKey: string, words: Words): Promise<CallToolResult> => {
    const response = await sentPost(() => call("post", {workspaceId: workspace, body, idempotencyKey, ...target}));
    if (!response) return toolResult(POST_UNCONFIRMED);
    // An answer lost after the post may hide one that landed; its key makes a retry safe.
    try {
      const {workspaceId, channelWireId, filePath, ...message} = (await answered(response, postedSchema, {...words, failed: POST_UNCONFIRMED})).message;
      return toolResult({ok: true, message: {...message, workspace: workspaceId, channel: channelWireId, path: filePath}});
    } catch (e) {return failed(e, POST_UNCONFIRMED);}
  };

  server.registerTool("dohc_post_channel", {
    description: "Post in a channel of a workspace where you have Comment: name channel to start a thread, or threadId to reply in one. " +
      "The post shows as from you, your owner's agent.",
    inputSchema: z.object({
      workspace: workspaceArg(),
      channel: z.string().min(1).max(256).optional()
        .describe("A channel id from dohc_list_workspaces or dohc_list_groups, to start a thread in that channel."),
      threadId: z.string().min(1).max(256).optional().describe("A threadId from dohc_read_channel or dohc_wait_for_messages, to reply in that thread."),
      ...chatPostFields,
    }).refine(value => (value.channel === undefined) !== (value.threadId === undefined), "Send channel or threadId, not both."),
  }, async ({workspace, channel, threadId, body, idempotencyKey}) => post(workspace,
    threadId === undefined ? {channelWireId: channel!} : {threadId}, body, idempotencyKey,
    {not_found: "dohc could not find this channel or thread in this workspace.",
      bad_request: "dohc could not post this message. Check its channel or thread and its text, then try again."}));

  server.registerTool("dohc_read_discussion", {
    description: "Read the discussion on a file in a workspace you can reach, newest first: pass before=olderCursor for earlier messages. " +
      "Name path for every thread on a current file, or threadId for one thread, also on a file since deleted. " +
      "A thread's answer names the path its file has or last had. " + UNVERIFIED_LINK,
    inputSchema: z.object({
      workspace: workspaceArg(),
      path: z.string().min(1).max(1024).optional().describe("The file's path exactly as dohc_list_files lists paths, to read every thread on it."),
      threadId: z.string().min(1).max(256).optional().describe("A message's threadId, to read that thread on a file."),
      ...pageArgs(),
    }).refine(value => (value.path === undefined) !== (value.threadId === undefined), "Send path or threadId, not both."),
  }, async ({workspace, path, threadId, before, limit}) => {
    const paging = {...(before === undefined ? {} : {before}), ...(limit === undefined ? {} : {limit})};
    try {
      if (threadId !== undefined) {
        const page = await answered(await call("discussion", {workspaceId: workspace, threadId, ...paging}), threadPageSchema,
          {not_found: "dohc could not find this thread on a file in this workspace. Use a threadId from a message.",
            bad_request: "dohc could not read this thread. Check its workspace and threadId."});
        return toolResult({ok: true, workspace, threadId, path: page.filePath, messages: page.messages, olderCursor: page.olderCursor});
      }
      const page = await answered(await call("discussion", {workspaceId: workspace, filePath: path!, ...paging}), pageSchema,
        {not_found: "dohc could not find this file in this workspace. Use a path from dohc_list_files.",
          bad_request: "dohc could not read this discussion. Check its workspace and path."});
      return toolResult({ok: true, workspace, path, messages: page.messages, olderCursor: page.olderCursor});
    } catch (e) {return failed(e);}
  });

  server.registerTool("dohc_post_discussion", {
    description: "Comment on a file in a workspace where you have Comment: name path to start a thread on the file, " +
      "or threadId to reply in one, also on a file since deleted. The comment shows as from you, your owner's agent.",
    inputSchema: z.object({
      workspace: workspaceArg(),
      path: z.string().min(1).max(1024).optional().describe("The file's path exactly as dohc_list_files lists paths, to start a thread on it."),
      threadId: z.string().min(1).max(256).optional().describe("A threadId from dohc_read_discussion or dohc_wait_for_messages, to reply in that thread."),
      ...chatPostFields,
    }).refine(value => (value.path === undefined) !== (value.threadId === undefined), "Send path or threadId, not both."),
  }, async ({workspace, path, threadId, body, idempotencyKey}) => post(workspace,
    threadId === undefined ? {filePath: path!} : {threadId}, body, idempotencyKey,
    {not_found: "dohc could not find this file or thread in this workspace. Use a path from dohc_list_files.",
      bad_request: "dohc could not post this comment. Check its path or thread and its text, then try again."}));

  // Holds until a message arrives or the wait ends, and answers before this request's own deadline.
  server.registerTool("dohc_wait_for_messages", {
    description: "Wait for messages for you in every workspace you can reach. They come only from your owner: " +
      "a post in your direct messages, a mention of you, or a reply in a thread you posted in. " +
      "Each names its workspace, and its channel or, for a thread on a file, its path. " +
      "Call in a loop with the returned cursor; without a cursor, it starts from when you signed in. " +
      "It answers as soon as a message arrives, or with no messages once timeoutMs passes. more means messages remain: call again at once. " +
      "Your own posts are not returned. Nothing is marked read.",
    inputSchema: z.object({
      cursor: z.string().min(1).max(MAX_WAIT_CURSOR_CHARS).optional()
        .describe("The cursor the last call returned. Omit it to start from when you signed in."),
      timeoutMs: z.number().int().min(0).max(MAX_WAIT_TIMEOUT_MS).optional()
        .describe(`How long to wait, in milliseconds, at most ${String(MAX_WAIT_TIMEOUT_MS)}. The default is ${String(MAX_WAIT_TIMEOUT_MS)}.`),
    }),
  }, async ({cursor, timeoutMs}) => {
    const place = cursor === undefined ? undefined : decodeWaitCursor(cursor);
    if (place === null) return toolError(WAIT_CURSOR_REFUSED);
    const hold = Math.max(0, Math.min(timeoutMs ?? MAX_WAIT_TIMEOUT_MS, options.deadlineAtMs - Date.now() - ANSWER_RESERVE_MS));
    try {
      const answer = await answered(await call("wait", {...(place === undefined ? {} : {cursor: place}), timeoutMs: hold}), waitAnswerSchema,
        {not_found: "This agent's sign-in changed while it waited. Call again.", bad_request: WAIT_CURSOR_REFUSED});
      return toolResult({
        messages: answer.messages.map(message => ({
          workspace: message.workspaceId, channel: message.channelWireId, path: message.filePath,
          threadId: message.threadId, messageId: message.messageId,
          author: {kind: message.authorKind, displayName: message.authorDisplayName},
          createdAtMs: message.createdAtMs, text: message.body,
        })),
        cursor: encodeWaitCursor(answer.cursor), more: answer.more,
      });
    } catch (e) {return failed(e);}
  });
  return server;
}
