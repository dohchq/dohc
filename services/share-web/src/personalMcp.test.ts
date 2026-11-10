import {afterEach, expect, it} from "vitest";
import {Client, StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import type {PersonalAgentAction, PersonalAgentClient} from "./personalAgentClient";
import {PERSONAL_SIGN_IN_UNAVAILABLE, servePersonalMcp} from "./personalMcp";
import {MAX_WAIT_TIMEOUT_MS, POST_UNKNOWN} from "./remoteMcp";

// The tools a personal agent calls at /mcp/agent/w/<workspace>, against a
// fake relay. The relay decides reach and level; these tests check what each
// tool asks it and how each answer and refusal reads to the agent.

const origin = "https://share.example.test";
const clients: Client[] = [];
afterEach(async () => {await Promise.all(clients.splice(0).map(client => client.close()));});

const TEXT_SHA = "a".repeat(64), BINARY_SHA = "b".repeat(64), MISSING_SHA = "c".repeat(64);
const REACH = {ok: true, agent: {agentId: "p-aaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Trip helper", handle: "Triphelper"}, workspaces: [
  {workspaceId: "trip", name: "Trip", level: "comment", dmChannelWireId: "wire-dm"},
  {workspaceId: "fundraiser", name: null, level: "view", dmChannelWireId: "wire-dm"},
]};
const GROUPS = [{channelWireId: "wire-planning", name: "Planning", purpose: "Where we go"}, {channelWireId: "wire-food", name: "Food", purpose: null}];
const FILES = [{path: "docs/plan.md", blobSha256: TEXT_SHA, contentKind: "text"}, {path: "photo.png", blobSha256: BINARY_SHA, contentKind: "binary"}];
const RELAY_CURSOR = {v: 1, agentId: "p-aaaaaaaaaaaaaaaaaaaaaaaaaa", seqs: {trip: 9, fundraiser: 4}, turn: null};
const message = (relaySeq: number, fields: Record<string, unknown> = {}) => ({relaySeq, messageId: `message-${String(relaySeq)}`,
  threadId: "thread-plan", authorDisplayName: "Ada", authorKind: "human", linkAgent: false, authorOwnerDisplayName: null,
  createdAtMs: 1_000, body: "hello", bodyTooLarge: false, ...fields});
const posted = (relaySeq: number) => message(relaySeq, {authorDisplayName: "Trip helper", authorKind: "agent", authorOwnerDisplayName: "Ada", body: "done"});

type Call = {action: PersonalAgentAction; body: Record<string, unknown>};
// The Comment threads, by the path each file has or last had. docs/gone.md was deleted.
const THREAD_FILES: Readonly<Record<string, string>> = {"thread-plan": "docs/plan.md", "thread-gone": "docs/gone.md"};

// The relay as it answers a personal agent in reach at Comment.
function relay({action, body}: Call): Response {
  if (action === "files") return Response.json({ok: true, files: FILES, truncated: false});
  if (action === "groups") return Response.json({ok: true, workspaceId: body.workspaceId, groups: GROUPS});
  if (action === "blob") {
    if (body.sha256 === TEXT_SHA) return new Response("# Plan");
    if (body.sha256 === BINARY_SHA) return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    return Response.json({ok: false, code: "not_found", error: "not found"}, {status: 404});
  }
  if (action === "chat") return Response.json({ok: true, messages: [message(3)], olderCursor: 2});
  // A thread answers with the path its file has or last had.
  if (action === "discussion") {
    return Response.json(typeof body.threadId === "string"
      ? {ok: true, workspaceId: body.workspaceId, threadId: body.threadId, filePath: THREAD_FILES[body.threadId],
        messages: [message(5, {threadId: body.threadId})], olderCursor: 4}
      : {ok: true, messages: [message(5)], olderCursor: null});
  }
  if (action === "post") {
    // Exactly one of channelWireId and filePath names where the post landed.
    const filePath = typeof body.filePath === "string" ? body.filePath
      : typeof body.threadId === "string" ? THREAD_FILES[body.threadId] ?? null : null;
    const channelWireId = filePath !== null ? null : typeof body.channelWireId === "string" ? body.channelWireId : "wire-dm";
    return Response.json({ok: true, message: {...posted(9), workspaceId: body.workspaceId, channelWireId, filePath}});
  }
  return Response.json({ok: true, messages: [
    {...message(9, {threadId: "thread-dm"}), workspaceId: "trip", channelWireId: "wire-dm", filePath: null},
    {...message(4), workspaceId: "fundraiser", channelWireId: null, filePath: "docs/plan.md"},
  ], cursor: RELAY_CURSOR, more: false});
}

function fixture(options: {answer?: (call: Call) => Response | Promise<Response>; deadlineMs?: number} = {}) {
  const calls: Call[] = [];
  const client: PersonalAgentClient = {
    call: async (action, body) => {
      if (action === "workspaces") return Response.json(REACH);
      calls.push({action, body});
      return (options.answer ?? relay)({action, body});
    },
  };
  async function serve(request: Request): Promise<Response> {
    const result = await servePersonalMcp(request, {client, signal: new AbortController().signal,
      deadlineAtMs: Date.now() + (options.deadlineMs ?? 35_000)});
    return result ? new Response(result.body, {status: result.status, headers: result.headers}) : new Response(null, {status: 401});
  }
  async function connect() {
    const mcp = new Client({name: "test-agent", version: "1"});
    clients.push(mcp);
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp/agent/w/trip`), {
      fetch: async (input, init) => serve(new Request(input, init)),
    }));
    return mcp;
  }
  return {calls, connect};
}

const structured = (result: unknown) => (result as {structuredContent?: Record<string, unknown>}).structuredContent;
const textOf = (result: unknown) => (result as {content: Array<{text: string}>}).content[0]!.text;
/** A tool's refusal: an error result, or the client's throw on input the schema refuses. */
const refusedInput = (pending: Promise<unknown>) => pending.then(result => (result as {isError?: unknown}).isError === true, () => true);

const listRequest = () => new Request(`${origin}/mcp/agent/w/trip`, {method: "POST",
  headers: {"content-type": "application/json", accept: "application/json, text/event-stream"},
  body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/list"})});
const probed = (answer: () => Promise<Response>) => servePersonalMcp(listRequest(), {
  client: {call: async (action) => action === "workspaces" ? answer() : Response.json({ok: true})},
  signal: new AbortController().signal, deadlineAtMs: Date.now() + 35_000,
});

it("lists the workspaces from the reach check that starts each request", async () => {
  const f = fixture();
  const client = await f.connect();
  expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
    "dohc_list_files", "dohc_list_groups", "dohc_list_workspaces", "dohc_post_channel", "dohc_post_discussion",
    "dohc_read_channel", "dohc_read_discussion", "dohc_read_file", "dohc_wait_for_messages",
  ]);
  const listed = await client.callTool({name: "dohc_list_workspaces", arguments: {}});
  expect(listed.isError).toBeFalsy();
  expect(structured(listed)).toEqual({ok: true, agent: {name: "Trip helper", handle: "Triphelper"}, workspaces: [
    {workspace: "trip", name: "Trip", level: "comment", dmChannel: "wire-dm"},
    {workspace: "fundraiser", name: null, level: "view", dmChannel: "wire-dm"},
  ]});
  // The request's own reach check answers the list.
  expect(f.calls).toEqual([]);
});

it("lists a workspace's Groups, each by the channel the other tools take, and says when the server is busy or keeps no copies", async () => {
  const f = fixture();
  const client = await f.connect();
  const listed = await client.callTool({name: "dohc_list_groups", arguments: {workspace: "fundraiser"}});
  expect(listed.isError).toBeFalsy();
  expect(structured(listed)).toEqual({ok: true, workspace: "fundraiser", groups: [
    {channel: "wire-planning", name: "Planning", purpose: "Where we go"}, {channel: "wire-food", name: "Food", purpose: null},
  ]});
  expect(f.calls).toEqual([{action: "groups", body: {workspaceId: "fundraiser"}}]);

  const busy = await (await fixture({answer: refusedBy("server_busy", 503)}).connect())
    .callTool({name: "dohc_list_groups", arguments: {workspace: "trip"}});
  expect(busy.isError).toBe(true);
  expect(structured(busy)).toEqual({ok: false, code: "busy", error: "dohc is busy reading this workspace. Try again shortly."});
  expect(textOf(busy)).not.toContain("relay words");

  const noCopies = await (await fixture({answer: refusedBy("server_copies_off", 404)}).connect())
    .callTool({name: "dohc_list_groups", arguments: {workspace: "trip"}});
  expect(noCopies.isError).toBe(true);
  expect(structured(noCopies)).toEqual({ok: false, code: "no_server_copies",
    error: "This server doesn't keep workspace copies, so it can't list Groups. The DM still works."});
});

it("lists a workspace's files and reads one as text or base64", async () => {
  const f = fixture();
  const client = await f.connect();
  expect(structured(await client.callTool({name: "dohc_list_files", arguments: {workspace: "trip"}})))
    .toEqual({ok: true, workspace: "trip", files: FILES, truncated: false});
  expect(structured(await client.callTool({name: "dohc_read_file", arguments: {workspace: "trip", blobSha256: TEXT_SHA}})))
    .toEqual({ok: true, source: "settled", encoding: "utf8", content: "# Plan"});
  expect(structured(await client.callTool({name: "dohc_read_file", arguments: {workspace: "trip", blobSha256: BINARY_SHA}})))
    .toEqual({ok: true, source: "settled", encoding: "base64", content: "iVBORw=="});
  expect(f.calls).toEqual([
    {action: "files", body: {workspaceId: "trip"}},
    {action: "blob", body: {workspaceId: "trip", sha256: TEXT_SHA}}, {action: "files", body: {workspaceId: "trip"}},
    {action: "blob", body: {workspaceId: "trip", sha256: BINARY_SHA}}, {action: "files", body: {workspaceId: "trip"}},
  ]);

  const missing = await client.callTool({name: "dohc_read_file", arguments: {workspace: "trip", blobSha256: MISSING_SHA}});
  expect(missing.isError).toBe(true);
  expect(structured(missing)).toEqual({ok: false, code: "not_found",
    error: "dohc could not find a current file with this blobSha256 in this workspace. List its files again with dohc_list_files."});
});

it("reads a channel and a file's discussion a page at a time", async () => {
  const f = fixture();
  const client = await f.connect();
  expect(structured(await client.callTool({name: "dohc_read_channel", arguments: {workspace: "trip", channel: "wire-dm", before: 4, limit: 2}})))
    .toEqual({ok: true, workspace: "trip", channel: "wire-dm", messages: [message(3)], olderCursor: 2});
  expect(structured(await client.callTool({name: "dohc_read_discussion", arguments: {workspace: "fundraiser", path: "docs/plan.md"}})))
    .toEqual({ok: true, workspace: "fundraiser", path: "docs/plan.md", messages: [message(5)], olderCursor: null});
  expect(f.calls).toEqual([
    {action: "chat", body: {workspaceId: "trip", channelWireId: "wire-dm", before: 4, limit: 2}},
    {action: "discussion", body: {workspaceId: "fundraiser", filePath: "docs/plan.md"}},
  ]);
});

it("reads one Comment thread by its id and replies there, also on a file since deleted", async () => {
  const f = fixture();
  const client = await f.connect();
  expect(structured(await client.callTool({name: "dohc_read_discussion", arguments: {workspace: "trip", threadId: "thread-gone", before: 9, limit: 1}})))
    .toEqual({ok: true, workspace: "trip", threadId: "thread-gone", path: "docs/gone.md", messages: [message(5, {threadId: "thread-gone"})], olderCursor: 4});
  const reply = await client.callTool({name: "dohc_post_discussion", arguments: {workspace: "trip", threadId: "thread-gone", body: "done", idempotencyKey: "post-1"}});
  expect(structured(reply)).toEqual({ok: true, message: {...posted(9), workspace: "trip", channel: null, path: "docs/gone.md"}});
  expect(f.calls).toEqual([
    {action: "discussion", body: {workspaceId: "trip", threadId: "thread-gone", before: 9, limit: 1}},
    {action: "post", body: {workspaceId: "trip", body: "done", idempotencyKey: "post-1", threadId: "thread-gone"}},
  ]);

  // A read names a file or a thread; anything else never reaches the relay.
  for (const place of [{path: "docs/plan.md", threadId: "thread-plan"}, {}]) {
    expect(await refusedInput(client.callTool({name: "dohc_read_discussion", arguments: {workspace: "trip", ...place}}))).toBe(true);
  }
  expect(f.calls).toHaveLength(2);

  // The relay finds no thread on a file it can serve, such as one whose file moved to a secret path.
  const missing = await (await fixture({answer: refusedBy("not_found", 404)}).connect())
    .callTool({name: "dohc_read_discussion", arguments: {workspace: "trip", threadId: "thread-hidden"}});
  expect(missing.isError).toBe(true);
  expect(structured(missing)).toEqual({ok: false, code: "not_found",
    error: "dohc could not find this thread on a file in this workspace. Use a threadId from a message."});
});

it("posts in a channel, in a thread and on a file, each naming one place", async () => {
  const f = fixture();
  const client = await f.connect();
  const inChannel = await client.callTool({name: "dohc_post_channel", arguments: {workspace: "trip", channel: "wire-dm", body: "done", idempotencyKey: "post-1"}});
  expect(structured(inChannel)).toEqual({ok: true, message: {...posted(9), workspace: "trip", channel: "wire-dm", path: null}});
  const inThread = await client.callTool({name: "dohc_post_channel", arguments: {workspace: "trip", threadId: "thread-dm", body: "done", idempotencyKey: "post-2"}});
  expect(structured(inThread)).toEqual({ok: true, message: {...posted(9), workspace: "trip", channel: "wire-dm", path: null}});
  const onFile = await client.callTool({name: "dohc_post_discussion", arguments: {workspace: "trip", path: "docs/plan.md", body: "done", idempotencyKey: "post-3"}});
  expect(structured(onFile)).toEqual({ok: true, message: {...posted(9), workspace: "trip", channel: null, path: "docs/plan.md"}});
  const reply = await client.callTool({name: "dohc_post_discussion", arguments: {workspace: "trip", threadId: "thread-plan", body: "done", idempotencyKey: "post-4"}});
  expect(structured(reply)).toEqual({ok: true, message: {...posted(9), workspace: "trip", channel: null, path: "docs/plan.md"}});
  expect(f.calls).toEqual([
    {action: "post", body: {workspaceId: "trip", body: "done", idempotencyKey: "post-1", channelWireId: "wire-dm"}},
    {action: "post", body: {workspaceId: "trip", body: "done", idempotencyKey: "post-2", threadId: "thread-dm"}},
    {action: "post", body: {workspaceId: "trip", body: "done", idempotencyKey: "post-3", filePath: "docs/plan.md"}},
    {action: "post", body: {workspaceId: "trip", body: "done", idempotencyKey: "post-4", threadId: "thread-plan"}},
  ]);

  // A post names exactly one place; anything else never reaches the relay.
  for (const [name, place] of [
    ["dohc_post_channel", {channel: "wire-dm", threadId: "thread-dm"}], ["dohc_post_channel", {}],
    ["dohc_post_discussion", {path: "docs/plan.md", threadId: "thread-plan"}], ["dohc_post_discussion", {}],
  ] as const) {
    expect(await refusedInput(client.callTool({name, arguments: {workspace: "trip", ...place, body: "done", idempotencyKey: "post-5"}})), name).toBe(true);
  }
  expect(f.calls).toHaveLength(4);
});

it("waits across every workspace with an opaque cursor that resumes where the relay stopped", async () => {
  const f = fixture();
  const client = await f.connect();
  const first = structured(await client.callTool({name: "dohc_wait_for_messages", arguments: {}}))!;
  expect(first.messages).toEqual([
    {workspace: "trip", channel: "wire-dm", path: null, threadId: "thread-dm", messageId: "message-9",
      author: {kind: "human", displayName: "Ada"}, createdAtMs: 1_000, text: "hello"},
    {workspace: "fundraiser", channel: null, path: "docs/plan.md", threadId: "thread-plan", messageId: "message-4",
      author: {kind: "human", displayName: "Ada"}, createdAtMs: 1_000, text: "hello"},
  ]);
  expect(first.more).toBe(false);
  expect(typeof first.cursor).toBe("string");
  await client.callTool({name: "dohc_wait_for_messages", arguments: {cursor: first.cursor, timeoutMs: 100}});
  expect(f.calls).toEqual([
    {action: "wait", body: {timeoutMs: MAX_WAIT_TIMEOUT_MS}},
    {action: "wait", body: {cursor: RELAY_CURSOR, timeoutMs: 100}},
  ]);

  // A cursor that did not come from the relay never reaches it.
  const forged = Buffer.from(JSON.stringify({...RELAY_CURSOR, extra: true})).toString("base64url");
  for (const cursor of ["not-a-cursor", forged]) {
    const refused = await client.callTool({name: "dohc_wait_for_messages", arguments: {cursor}});
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe("This cursor did not come from this agent's last dohc_wait_for_messages. Call again without a cursor.");
  }
  expect(await refusedInput(client.callTool({name: "dohc_wait_for_messages", arguments: {timeoutMs: MAX_WAIT_TIMEOUT_MS + 1}}))).toBe(true);
  expect(f.calls).toHaveLength(2);
});

it("holds a wait within this request's deadline", async () => {
  const near = fixture({deadlineMs: 9_000});
  await (await near.connect()).callTool({name: "dohc_wait_for_messages", arguments: {}});
  const held = near.calls[0]!.body.timeoutMs as number;
  expect(held).toBeGreaterThan(0);
  expect(held).toBeLessThanOrEqual(4_000);

  const spent = fixture({deadlineMs: 3_000});
  await (await spent.connect()).callTool({name: "dohc_wait_for_messages", arguments: {timeoutMs: 1_000}});
  expect(spent.calls[0]!.body.timeoutMs).toBe(0);
});

// The agent's name comes from the reach check that starts the request.
const OUT_OF_REACH = {ok: false, code: "out_of_reach",
  error: "Trip helper can't reach this workspace. Its owner can change that in Settings › Agents."};
const VIEW_ONLY = {ok: false, code: "view_only",
  error: "Trip helper can read this workspace but not post in it. Its owner can change that in Settings › Agents."};
const refusedBy = (code: string, status: number) => () => Response.json({ok: false, code, error: "relay words"}, {status});

// Every tool that names a workspace, as an agent calls it.
const WORKSPACE_TOOLS = [
  ["dohc_list_files", {}],
  ["dohc_list_groups", {}],
  ["dohc_read_file", {blobSha256: TEXT_SHA}],
  ["dohc_read_channel", {channel: "wire-dm"}],
  ["dohc_post_channel", {channel: "wire-dm", body: "done", idempotencyKey: "post-1"}],
  ["dohc_read_discussion", {path: "docs/plan.md"}],
  ["dohc_read_discussion", {threadId: "thread-plan"}],
  ["dohc_post_discussion", {path: "docs/plan.md", body: "done", idempotencyKey: "post-1"}],
] as const;

it("says a workspace is out of reach from every tool that names one, in this server's words", async () => {
  const f = fixture({answer: refusedBy("personal_agent_out_of_reach", 403)});
  const client = await f.connect();
  for (const [name, args] of WORKSPACE_TOOLS) {
    const result = await client.callTool({name, arguments: {workspace: "garden", ...args}});
    expect(result.isError, name).toBe(true);
    expect(structured(result), name).toEqual(OUT_OF_REACH);
    expect(textOf(result), name).not.toContain("relay words");
  }
  // Each tool asks the relay once, for the workspace it names.
  expect(f.calls.map(call => call.body.workspaceId)).toEqual(WORKSPACE_TOOLS.map(() => "garden"));
});

it("says a View agent can read but not post, in a channel, in a thread or on a file", async () => {
  const f = fixture({answer: call => call.action === "post" ? refusedBy("personal_agent_view_only", 403)() : relay(call)});
  const client = await f.connect();
  for (const [name, place] of [
    ["dohc_post_channel", {channel: "wire-dm"}], ["dohc_post_channel", {threadId: "thread-dm"}],
    ["dohc_post_discussion", {path: "docs/plan.md"}], ["dohc_post_discussion", {threadId: "thread-plan"}],
  ] as const) {
    const result = await client.callTool({name, arguments: {workspace: "fundraiser", ...place, body: "done", idempotencyKey: "post-1"}});
    expect(result.isError, name).toBe(true);
    expect(structured(result), name).toEqual(VIEW_ONLY);
    expect(textOf(result), name).not.toContain("relay words");
  }
  // The same agent still reads there.
  expect(structured(await client.callTool({name: "dohc_read_channel", arguments: {workspace: "fundraiser", channel: "wire-dm"}})))
    .toMatchObject({ok: true, messages: [message(3)]});
  expect(structured(await client.callTool({name: "dohc_read_discussion", arguments: {workspace: "fundraiser", path: "docs/plan.md"}})))
    .toMatchObject({ok: true, messages: [message(5)]});
  expect(structured(await client.callTool({name: "dohc_read_discussion", arguments: {workspace: "fundraiser", threadId: "thread-gone"}})))
    .toMatchObject({ok: true, path: "docs/gone.md", messages: [message(5, {threadId: "thread-gone"})]});
});

it("says a Comment's file is missing, and words every other refusal without the relay's own words", async () => {
  const missingFile = fixture({answer: refusedBy("not_found", 404)});
  const client = await missingFile.connect();
  const comment = await client.callTool({name: "dohc_post_discussion",
    arguments: {workspace: "trip", path: "docs/missing.md", body: "done", idempotencyKey: "post-1"}});
  expect(structured(comment)).toEqual({ok: false, code: "not_found",
    error: "dohc could not find this file or thread in this workspace. Use a path from dohc_list_files."});
  expect(structured(await client.callTool({name: "dohc_read_discussion", arguments: {workspace: "trip", path: "docs/missing.md"}})))
    .toEqual({ok: false, code: "not_found", error: "dohc could not find this file in this workspace. Use a path from dohc_list_files."});
  expect(missingFile.calls).toEqual([
    {action: "post", body: {workspaceId: "trip", body: "done", idempotencyKey: "post-1", filePath: "docs/missing.md"}},
    {action: "discussion", body: {workspaceId: "trip", filePath: "docs/missing.md"}},
  ]);

  const expected: Array<[() => Response, Record<string, unknown>]> = [
    [refusedBy("conflict", 409), {ok: false, code: "conflict",
      error: "This message's key was already used for a different message. Send it as a new message."}],
    [refusedBy("quota_exceeded", 413), {ok: false, code: "quota_exceeded",
      error: "This workspace is full. Ask its owner to free space, then send this message again."}],
    [refusedBy("link_read_rate_limited", 429), {ok: false, code: "rate_limited",
      error: "This agent has reached its request limit. Try again in a minute."}],
    [refusedBy("bad_request", 400), {ok: false, code: "bad_request",
      error: "dohc could not post this comment. Check its path or thread and its text, then try again."}],
    // A post this server can't word may have landed; its key makes sending it again safe.
    [refusedBy("unexpected", 403), {ok: false, code: "unavailable", error: POST_UNKNOWN}],
    [refusedBy("personal_agent_out_of_reach", 500), {ok: false, code: "unavailable", error: POST_UNKNOWN}],
  ];
  for (const [answer, result] of expected) {
    const f = fixture({answer});
    const refused = await (await f.connect()).callTool({name: "dohc_post_discussion",
      arguments: {workspace: "trip", path: "docs/plan.md", body: "done", idempotencyKey: "post-1"}});
    expect(refused.isError).toBe(true);
    expect(structured(refused)).toEqual(result);
    expect(textOf(refused)).not.toContain("relay words");
  }
  // A read this server can't word reads as unavailable.
  for (const answer of [refusedBy("unexpected", 403), refusedBy("personal_agent_out_of_reach", 500)]) {
    const read = await (await fixture({answer}).connect()).callTool({name: "dohc_read_discussion", arguments: {workspace: "trip", path: "docs/plan.md"}});
    expect(structured(read)).toEqual({ok: false, code: "unavailable", error: PERSONAL_SIGN_IN_UNAVAILABLE});
  }
});

it("says a post may have landed when its answer is lost", async () => {
  const unconfirmed = {ok: false, code: "unavailable", error: POST_UNKNOWN};
  for (const answer of [
    () => Response.json({ok: false, code: "personal_agent_unavailable"}, {status: 503}),
    () => Promise.reject(new Error("connection reset")),
    () => Response.json({ok: true, message: {messageId: "message-9"}}),
    // An answer must name where the post landed, a channel or a file.
    () => Response.json({ok: true, message: {...posted(9), workspaceId: "trip", channelWireId: "wire-dm"}}),
  ]) {
    const f = fixture({answer});
    const result = await (await f.connect()).callTool({name: "dohc_post_channel",
      arguments: {workspace: "trip", channel: "wire-dm", body: "done", idempotencyKey: "post-1"}});
    expect(result.isError).toBe(true);
    expect(structured(result)).toEqual(unconfirmed);
  }
});

it("answers null for a token the relay doesn't accept, and words a reach check that fails", async () => {
  expect(await probed(async () => Response.json({ok: false, code: "not_found"}, {status: 404}))).toBeNull();

  const limited = await probed(async () => Response.json({ok: false, code: "link_read_rate_limited"}, {status: 429}));
  expect(limited?.status).toBe(429);
  expect(await new Response(limited!.body).json()).toEqual({ok: false, code: "rate_limited",
    error: "This agent has reached its request limit. Try again in a minute."});

  for (const answer of [
    async () => Response.json({ok: false, code: "personal_agent_unavailable"}, {status: 503}),
    async () => Response.json({ok: true, workspaces: "trip"}),
    async () => {throw new Error("connection reset");},
  ]) {
    const unavailable = await probed(answer);
    expect(unavailable?.status).toBe(503);
    expect(await new Response(unavailable!.body).json()).toEqual({ok: false, code: "unavailable", error: PERSONAL_SIGN_IN_UNAVAILABLE});
  }
});
