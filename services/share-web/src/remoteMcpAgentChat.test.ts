import {afterEach, expect, it} from "vitest";
import {Client, StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import type {AgentChatClient} from "./agentChatClient";
import {MAX_WAIT_TIMEOUT_MS, serveRemoteMcp} from "./remoteMcp";

const origin = "https://share.example.test";
const clients: Client[] = [];
afterEach(async () => {await Promise.all(clients.splice(0).map(client => client.close()));});

const metadata = {ok: true, subjectName: "Team", access: "view", effectiveSelector: {versionId: null, paths: [], access: "view"},
  lastSettledKnown: true, lastSettledAtMs: 1, channel: {channelWireId: "wire-team", access: "read-write"}};
const message = (relaySeq: number, fields: Record<string, unknown> = {}) => ({relaySeq, messageId: `message-${String(relaySeq)}`,
  threadId: "thread-team", authorDisplayName: "Ada", authorKind: "human", linkAgent: false, authorOwnerDisplayName: null,
  createdAtMs: 1_000, body: "hello", bodyTooLarge: false, ...fields});

type WaitCall = {input: Parameters<AgentChatClient["wait"]>[0]; signal: AbortSignal};
type PostCall = {input: Parameters<AgentChatClient["post"]>[0]; signal: AbortSignal};

function fixture(options: {agentChat?: boolean; deadlineMs?: number; wait?: (call: WaitCall) => Response | Promise<Response>} = {}) {
  const waits: WaitCall[] = [], posts: PostCall[] = [], viewCalls: string[] = [], controllers: AbortController[] = [];
  const agentChat: AgentChatClient = {
    post: async (input, signal) => {
      posts.push({input, signal});
      return Response.json({ok: true, message: message(9, {authorKind: "link", authorDisplayName: "Helper", linkAgent: true})});
    },
    wait: async (input, signal) => {
      const call = {input, signal};
      waits.push(call);
      return options.wait ? options.wait(call) : Response.json({ok: true, group: {channelWireId: "wire-team", name: "Team"}, messages: [], cursor: 40});
    },
  };
  async function serve(request: Request): Promise<Response> {
    const controller = new AbortController();
    controllers.push(controller);
    const result = await serveRemoteMcp(request, {
      discriminator: "agent", cookie: "", signal: controller.signal, deadlineAtMs: Date.now() + (options.deadlineMs ?? 35_000),
      admitLargeBody: () => null,
      request: async (path) => {
        viewCalls.push(path);
        if (path === "/api/view/meta") return Response.json(metadata);
        return new Response(null, {status: 404});
      },
      ...(options.agentChat === false ? {} : {agentChat}),
    });
    return new Response(result.body, {status: result.status, headers: result.headers});
  }
  async function connect() {
    const client = new Client({name: "test-agent", version: "1"});
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      fetch: async (input, init) => serve(new Request(input, init)),
    }));
    return client;
  }
  return {waits, posts, viewCalls, controllers, connect};
}

const structured = (result: unknown) => (result as {structuredContent?: Record<string, unknown>}).structuredContent;
const textOf = (result: unknown) => (result as {content: Array<{text: string}>}).content[0]!.text;

it("offers the wait tool only to an agent that signed in, and posts as that agent", async () => {
  const exchanged = await fixture({agentChat: false}).connect();
  expect((await exchanged.listTools()).tools.map(tool => tool.name)).not.toContain("dohc_wait_for_messages");

  const f = fixture();
  const client = await f.connect();
  const tools = (await client.listTools()).tools;
  expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["dohc_wait_for_messages", "dohc_post_channel"]));
  const postTool = tools.find(tool => tool.name === "dohc_post_channel")!;
  expect(Object.keys(postTool.inputSchema.properties ?? {}).sort()).toEqual(["body", "idempotencyKey", "threadId"]);

  const posted = await client.callTool({name: "dohc_post_channel", arguments: {body: "done", idempotencyKey: "post-1"}});
  expect(structured(posted)).toMatchObject({ok: true, message: {authorKind: "link", linkAgent: true}});
  expect(f.posts.map(call => call.input)).toEqual([{body: "done", idempotencyKey: "post-1"}]);
  expect(f.viewCalls).not.toContain("/api/view/chat/messages");
});

it("returns messages with an opaque cursor that resumes from where the relay stopped", async () => {
  const f = fixture({wait: ({input}) => Response.json({ok: true, group: {channelWireId: "wire-team", name: "Team"},
    messages: input.cursor === undefined ? [message(41, {linkAgent: true, authorKind: "link", authorDisplayName: "Helper"})] : [],
    cursor: input.cursor === undefined ? 41 : 57})});
  const client = await f.connect();
  const first = structured(await client.callTool({name: "dohc_wait_for_messages", arguments: {thread: "thread-team"}}))!;
  expect(first.messages).toEqual([{threadId: "thread-team", messageId: "message-41", group: {id: "wire-team", name: "Team", kind: "group"},
    author: {kind: "link", displayName: "Helper", linkAgent: true}, createdAtMs: 1_000, text: "hello"}]);
  expect(typeof first.cursor).toBe("string");

  const second = structured(await client.callTool({name: "dohc_wait_for_messages", arguments: {thread: "thread-team", cursor: first.cursor}}))!;
  expect(second.messages).toEqual([]);
  expect(f.waits.map(call => call.input)).toEqual([
    {threadId: "thread-team", timeoutMs: MAX_WAIT_TIMEOUT_MS},
    {threadId: "thread-team", cursor: 41, timeoutMs: MAX_WAIT_TIMEOUT_MS},
  ]);
  expect(second.cursor).not.toBe(first.cursor);

  // A cursor from other filters, or one that is not a cursor, never reaches the relay.
  for (const args of [{cursor: first.cursor}, {cursor: first.cursor, thread: "thread-other"}, {cursor: "not-a-cursor"}]) {
    const refused = await client.callTool({name: "dohc_wait_for_messages", arguments: args});
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("cursor");
  }
  expect(f.waits).toHaveLength(2);
});

it("holds within this request's deadline and never past the relay's bound", async () => {
  const near = fixture({deadlineMs: 9_000});
  await (await near.connect()).callTool({name: "dohc_wait_for_messages", arguments: {}});
  expect(near.waits[0]!.input.timeoutMs).toBeGreaterThan(0);
  expect(near.waits[0]!.input.timeoutMs).toBeLessThanOrEqual(4_000);

  const spent = fixture({deadlineMs: 3_000});
  await (await spent.connect()).callTool({name: "dohc_wait_for_messages", arguments: {timeoutMs: 1_000}});
  expect(spent.waits[0]!.input.timeoutMs).toBe(0);

  const f = fixture();
  const client = await f.connect();
  await client.callTool({name: "dohc_wait_for_messages", arguments: {timeoutMs: 100}});
  expect(f.waits[0]!.input.timeoutMs).toBe(100);
  const over = await client.callTool({name: "dohc_wait_for_messages", arguments: {timeoutMs: MAX_WAIT_TIMEOUT_MS + 1}})
    .catch((error: unknown) => ({isError: true, error}));
  expect(over.isError).toBe(true);
  expect(f.waits).toHaveLength(1);
});

it("ends the relay wait with this request, and answers a refusal like any other call", async () => {
  let entered!: () => void;
  const called = new Promise<void>((resolve) => { entered = resolve; });
  const f = fixture({wait: ({signal}) => {
    entered();
    return new Promise<Response>((resolve) => {
      signal.addEventListener("abort", () => resolve(new Response(null, {status: 404})), {once: true});
    });
  }});
  const pending = (await f.connect()).callTool({name: "dohc_wait_for_messages", arguments: {}});
  await called;
  // The relay call holds this request's own signal, so ending the request ends the wait.
  const controller = f.controllers.find(candidate => candidate.signal === f.waits[0]!.signal);
  expect(controller).toBeDefined();
  controller!.abort();
  const ended = await pending.catch(() => ({isError: true}));
  expect(ended.isError).toBe(true);

  const refused = fixture({wait: () => Response.json({ok: false, error: "not found"}, {status: 404})});
  const client = await refused.connect();
  const refusal = await client.callTool({name: "dohc_wait_for_messages", arguments: {}});
  const read = await client.callTool({name: "dohc_read_channel", arguments: {}});
  expect(refusal.isError).toBe(true);
  expect(textOf(refusal)).toBe(textOf(read));
});
