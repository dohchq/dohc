import { afterEach, expect, it } from "vitest";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import {
  createLiveFrameSession,
  encodeLiveFrameSync,
  type LiveFrame,
} from "@dohc/live-session-contract/live-frame";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import {
  LIVE_CONNECTION_LIMIT_CLOSE_CODE,
  LIVE_CONNECTION_LIMIT_MESSAGES,
} from "@dohc/live-session-contract/live-connection";
import { PERSONAL_SIGN_IN_UNAVAILABLE, servePersonalMcp } from "./personalMcp";
import { createPersonalLiveClient } from "./personalLiveClient";
import { LIVE_DOCUMENT_PREPARING, remoteLiveDocument } from "./remoteLiveDocument";

// A personal agent's live document tools, against a fake relay and a real
// live socket. The relay decides readiness, reach and level; these tests check
// what the tools ask it, which token each session carries, and how each answer
// reads to the agent.

const limits = {
  provider: {
    frames: {
      receive: {
        maxFrameBytes: 1024,
        maxStateVectorBytes: 4096,
        maxUpdateBytes: 8192,
        maxSyncBytes: 16384,
      },
      maxQueuedBytes: 16384,
      maxQueuedFrames: 64,
      maxControlBytes: 4096,
      maxControlFrames: 8,
      maxAssemblyBytes: 16384,
    },
    maxPendingUpdateBytes: 16384,
    maxPendingUpdates: 8,
    maxDeliveryAttempts: 4,
  },
  maxHttpResponseBytes: 16384,
  maxSocketBufferedBytes: 16384,
  connectTimeoutMs: 2000,
  sendTimeoutMs: 500,
  drainPollMs: 10,
};
const origin = "https://share.example.test",
  resource = `${origin}/mcp/agent/w/trip`,
  exchangeKey = "test-exchange-key-at-least-thirty-two-bytes";
const TOKEN_A = "A".repeat(43),
  TOKEN_B = "B".repeat(43);
const REACH = {
  ok: true,
  agent: { agentId: "p-aaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Trip helper", handle: "Triphelper" },
  workspaces: [{ workspaceId: "trip", name: "Trip", level: "edit", dmChannelWireId: "wire-dm" }],
};
const BINDING = {
  workspaceId: "trip",
  mainVersionId: "main",
  objectId: "document",
  lineageClaimId: "lineage",
  currentPath: "doc.md",
  selectorPaths: ["doc.md"],
  restoreFenceGeneration: 0,
};
const ready = () =>
  Response.json({ ok: true, status: "ready", objectId: "document", binding: BINDING });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
});

type RelayCall = { path: string; authorization: string | null; body: unknown; signal: AbortSignal };
type Answer = (call: RelayCall) => Response | Promise<Response>;
const structured = (result: unknown) =>
  (result as { structuredContent?: Record<string, unknown> }).structuredContent;

async function fixture(
  relay: { document?: Answer; ticket?: Answer; close?: () => [number, string] | undefined } = {},
) {
  const doc = markdownToYDoc("Hello **world**.\n");
  const server = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    perMessageDeflate: false,
    handleProtocols: () => "dohc-live-v1",
  });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw Error("No test listener");
  const calls: RelayCall[] = [],
    sockets: unknown[] = [],
    contexts: unknown[] = [],
    failures: unknown[] = [],
    clients: Client[] = [];
  const frames = limits.provider.frames;
  server.on("connection", (socket, request) => {
    // A personal session names its workspace and carries the agent's own token and MCP address.
    expect([request.url, request.headers.origin, request.headers["x-dohc-agent-resource"]]).toEqual(
      ["/sync/live/personal?workspaceId=trip", origin, resource],
    );
    sockets.push(request.headers.authorization);
    // The relay accepted the socket, then refused it: a connection limit is full, or it can't check the sign-in.
    const close = relay.close?.();
    if (close) {
      socket.close(...close);
      return;
    }
    const protocol = createLiveFrameSession("server", frames);
    socket.on("close", () => protocol.close());
    let chain = Promise.resolve();
    async function send(frame: LiveFrame) {
      const lease = protocol.send(frame);
      try {
        await new Promise<void>((resolve, reject) =>
          socket.send(lease.value, { binary: true }, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      } finally {
        lease.release();
      }
    }
    socket.on("message", (bytes) => {
      chain = chain
        .then(async () => {
          const lease = protocol.receive(bytes as Buffer);
          const frame = lease.value.frame;
          const transfer = lease.value.transfer && {
            begin: lease.value.transfer.value.begin,
            bytes: lease.value.transfer.value.bytes.slice(),
          };
          lease.value.transfer?.release();
          lease.release();
          if (frame.kind === "hello") {
            await send({
              kind: "welcome",
              hostEpoch: parseHostEpoch(1),
              receivePolicy: frames.receive,
            });
            await send({
              kind: "credit",
              grantedBytes: frames.maxQueuedBytes,
              grantedFrames: frames.maxQueuedFrames,
            });
          }
          if (transfer?.begin.purpose === "client-vector") {
            const sync = encodeLiveFrameSync(
              {
                binding: BINDING,
                hostVector: Y.encodeStateVector(doc),
                missingStateUpdate: Y.encodeStateAsUpdate(doc, transfer.bytes),
              },
              frames.receive,
            );
            await send({
              kind: "begin",
              purpose: "initial-sync",
              transferId: 1,
              totalBytes: sync.length,
              digest: createHash("sha256").update(sync).digest("hex"),
              appliedThroughJournalCursor: 0,
            });
            for (let offset = 0; offset < sync.length; offset += 900)
              await send({
                kind: "chunk",
                transferId: 1,
                offset,
                bytes: sync.subarray(offset, offset + 900),
              });
          }
          if (transfer?.begin.purpose === "submit-update") {
            contexts.push(transfer.begin.authorContext);
            Y.applyUpdate(doc, transfer.bytes);
            await send({
              kind: "result",
              result: "success",
              ack: {
                deliveryId: transfer.begin.deliveryId,
                updateDigest: transfer.begin.digest,
                journalCursor: 1,
                acceptingHostEpoch: parseHostEpoch(1),
                localYDocSequence: 1,
                applicationReplayed: false,
              },
            });
          }
        })
        .catch((error) => {
          failures.push(error);
          socket.terminate();
        });
    });
  });
  cleanup.push(async () => {
    await Promise.all(clients.map((client) => client.close()));
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    doc.destroy();
    expect(failures).toEqual([]);
  });
  const live = createPersonalLiveClient({
    relayUrl: `http://127.0.0.1:${address.port}`,
    publicOrigin: origin,
    exchangeKey,
    limits: {
      maxPendingRequests: 4,
      maxRequestBytes: 2048,
      maxResponseBytes: 8192,
      timeoutMs: 10_000,
    },
    async fetchRelay(request) {
      expect([
        request.headers.get("x-dohc-agent-resource"),
        request.headers.get("x-dohc-relay-exchange-key"),
        request.headers.get("origin"),
      ]).toEqual([resource, exchangeKey, origin]);
      const sent: RelayCall = {
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
        signal: request.signal,
      };
      calls.push(sent);
      if (sent.path === "/sync/live/personal-document") return (relay.document ?? ready)(sent);
      return relay.ticket
        ? relay.ticket(sent)
        : Response.json({ expiresAtMs: Date.now() + 60_000, token: "ab".repeat(32) });
    },
  });
  // Each MCP request's live client carries the bearer that request sent, as server.ts builds it.
  let token = TOKEN_A;
  async function serve(request: Request): Promise<Response> {
    const result = await servePersonalMcp(request, {
      admitLargeBody: () => () => {},
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 35_000,
      client: {
        call: async (action) =>
          action === "workspaces"
            ? Response.json(REACH)
            : Response.json({ ok: false, error: "not found", code: "not_found" }, { status: 404 }),
      },
      live: { client: live.agent({ accessToken: token, resource }), limits },
    });
    return result
      ? new Response(result.body, { status: result.status, headers: result.headers })
      : new Response(null, { status: 401 });
  }
  const mcp = new Client({ name: "test-agent", version: "1" });
  clients.push(mcp);
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      fetch: async (input, init) => serve(new Request(input, init)),
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    structured(
      await mcp.callTool({ name, arguments: { workspace: "trip", path: "doc.md", ...args } }),
    );
  return {
    doc,
    calls,
    sockets,
    contexts,
    live,
    call,
    refresh(next: string) {
      token = next;
    },
  };
}

it("reads and edits a document once the relay holds it ready, and says one still starting is not applied", async () => {
  let starting = true;
  const f = await fixture({
    document: () =>
      starting ? Response.json({ ok: true, status: "preparing" }, { status: 202 }) : ready(),
  });
  // The open committed, so the next call usually finds it ready. Nothing else is asked.
  expect(await f.call("dohc_edit_document", { find: "world", replacement: "friend" })).toEqual({
    ok: false,
    path: "doc.md",
    outcome: "not-applied",
    code: "preparing",
    error: LIVE_DOCUMENT_PREPARING,
  });
  expect([f.calls.map((call) => call.path), f.sockets]).toEqual([
    ["/sync/live/personal-document"],
    [],
  ]);
  starting = false;
  expect(await f.call("dohc_read_document")).toEqual({
    ok: true,
    path: "doc.md",
    markdown: "Hello **world**.\n",
    source: "live",
  });
  expect(
    await f.call("dohc_edit_document", { find: "world", replacement: "friend" }),
  ).toMatchObject({ ok: true, outcome: "applied", acknowledgement: { journalCursor: 1 } });
  expect(yDocToMarkdown(f.doc)).toContain("**friend**");
  expect(f.calls.slice(1, 3).map((call) => call.body)).toEqual([
    { workspaceId: "trip", path: "doc.md" },
    { workspaceId: "trip", objectId: "document" },
  ]);
  // The relay records the agent from its own tables, so the edit declares no
  // context. A link agent's edit still declares its principal (remoteLiveDocument.test.ts).
  expect(f.contexts).toEqual([undefined]);
});

const REFUSALS = [
  {
    code: "live_paused_by_owner",
    status: 409,
    error: "The owner paused live editing of this document.",
  },
  {
    code: "live_host_full",
    status: 409,
    error: "This server is hosting as many documents for agents as it can.",
  },
  {
    code: "live_hosting_unsupported",
    status: 409,
    error: "This server does not host live documents for agents.",
  },
  {
    code: "live-document-without-lineage",
    status: 409,
    error: "The owner must open this document in dohc on a desktop first.",
  },
  // A level refusal reads as the personal MCP's other refusals do, naming the agent.
  {
    code: "personal_agent_edit_needed",
    status: 403,
    error: "This agent needs Edit to change this workspace's pages and Collections.",
    said: {
      code: "edit_needed",
      error:
        "Trip helper needs Edit to change this workspace's documents. Its owner can change that in Settings › Agents.",
    },
  },
];

it.each(REFUSALS)(
  "says $code once, with no retry, and edits once the relay answers ready",
  async ({ code, status, error, said }) => {
    let refusing = true;
    const f = await fixture({
      document: () => (refusing ? Response.json({ ok: false, code, error }, { status }) : ready()),
    });
    expect(await f.call("dohc_edit_document", { find: "world", replacement: "friend" })).toEqual({
      ok: false,
      path: "doc.md",
      outcome: "not-applied",
      ...(said ?? { code, error }),
    });
    expect([f.calls.length, f.sockets.length]).toEqual([1, 0]);
    refusing = false;
    expect(
      await f.call("dohc_edit_document", { find: "world", replacement: "friend" }),
    ).toMatchObject({ ok: true, outcome: "applied" });
  },
);

// Without the abort, the same request completes (the first test).
it.each(["/sync/live/personal-document", "/sync/live/personal-tickets"])(
  "cancels the request to %s when the caller aborts",
  async (path) => {
    let reached!: () => void;
    const holding = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const hold: Answer = (call) => {
      reached();
      return new Promise<Response>((_resolve, reject) =>
        call.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    };
    const f = await fixture(
      path === "/sync/live/personal-document" ? { document: hold } : { ticket: hold },
    );
    const caller = new AbortController();
    const result = remoteLiveDocument(
      {
        live: {
          client: f.live.agent({ accessToken: TOKEN_A, resource }),
          workspaceId: "trip",
          refused: async () => ({ code: "unexpected", error: "unexpected" }),
          tryAgainLater: () => undefined,
        },
        limits,
        signal: caller.signal,
      },
      "doc.md",
    );
    await holding;
    caller.abort();
    expect(await result).toMatchObject({ ok: false, outcome: "not-applied" });
    expect([f.calls.at(-1)?.path, f.calls.at(-1)?.signal.aborted, f.sockets]).toEqual([
      path,
      true,
      [],
    ]);
  },
);

it.each([
  ["a refreshed token", TOKEN_B],
  ["an unchanged token", TOKEN_A],
])("mints and opens a new session with %s on the next call", async (_name, next) => {
  const f = await fixture();
  expect(await f.call("dohc_read_document")).toMatchObject({ ok: true });
  f.refresh(next);
  expect(await f.call("dohc_read_document")).toMatchObject({ ok: true });
  // Each call mints with the token its request carries and opens its own socket.
  expect(
    f.calls
      .filter((call) => call.path === "/sync/live/personal-tickets")
      .map((call) => call.authorization),
  ).toEqual([`DohcAgent ${TOKEN_A}`, `DohcAgent ${next}`]);
  expect(f.sockets).toEqual([`DohcAgent ${TOKEN_A}`, `DohcAgent ${next}`]);
});

it("says a full connection limit at once when the relay closes the socket for it, and reads once there is room", async () => {
  let full = true;
  const f = await fixture({
    close: () => (full ? [LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_person_limit"] : undefined),
  });
  // Without the close handling, the call waits for its 30 s deadline and reads as a timeout.
  expect(await f.call("dohc_edit_document", { find: "world", replacement: "friend" })).toEqual({
    ok: false,
    path: "doc.md",
    outcome: "not-applied",
    code: "live_person_limit",
    error: LIVE_CONNECTION_LIMIT_MESSAGES.live_person_limit,
  });
  expect(f.sockets).toHaveLength(1);
  full = false;
  expect(await f.call("dohc_read_document")).toEqual({
    ok: true,
    path: "doc.md",
    markdown: "Hello **world**.\n",
    source: "live",
  });
});

it("says to try again when the relay closes the socket because it can't check the sign-in, and reads once it can", async () => {
  let reason: string | undefined = "personal_agent_unavailable";
  const f = await fixture({ close: () => (reason ? [1013, reason] : undefined) });
  // Without the close handling, the call answers with no code, so the agent can't tell that a retry may help.
  expect(await f.call("dohc_edit_document", { find: "world", replacement: "friend" })).toEqual({
    ok: false,
    path: "doc.md",
    outcome: "not-applied",
    code: "unavailable",
    error: PERSONAL_SIGN_IN_UNAVAILABLE,
  });
  // A try-again close with a reason the agent's MCP doesn't know carries no code.
  reason = "something_else";
  const unknown = await f.call("dohc_read_document");
  expect(unknown).toMatchObject({ ok: false, path: "doc.md", outcome: "not-applied" });
  expect(unknown).not.toHaveProperty("code");
  reason = undefined;
  expect(await f.call("dohc_read_document")).toEqual({
    ok: true,
    path: "doc.md",
    markdown: "Hello **world**.\n",
    source: "live",
  });
  expect(f.sockets).toHaveLength(3);
});
