import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { serveFetchHandler } from "@dohc/service-http";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, decodeLiveFrame, encodeLiveFrame, type LiveFrame } from "@dohc/live-session-contract/live-frame";
import type { LiveAuthorContext } from "@dohc/live-session-contract/live-authorship";
import type { CredentialFence, CredentialFenceListener } from "@dohc/workspace-auth/credentialFence";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import { agentAccessCheck } from "./linkAuthority.js";
import { hashLinkBearer, hashLinkProfileSecret } from "./linkSecurity.js";
import { createLiveTickets } from "./liveTickets.js";
import { createLiveHostReports } from "./namedLiveHostReports.js";
import { captureOwnerLiveFrameHost, createNamedFrameChanges, type NamedFrameNativeHost } from "./namedLiveFrameHost.js";
import { createPersonalLiveRoutes, type NamedLiveRouteLimits } from "./namedLiveRoutes.js";
import { audience, binding, fixture as ticketFixture, host, key, scope } from "./liveTickets.test-helper.js";
import type { CapacityLiveAdmissionValidator } from "./ownerOutboxDelivery.js";
import type { PersonalRunningEntry } from "./personalAgents.js";
import type { StorageContext } from "./storage/context.js";
import { SERVICE_HOST_ENROLLMENTS } from "./storage/serviceHostEnrollment.js";
import type { LiveUpdateJournalCut } from "./storage/types.js";
import { LINK_KEY, RELAY_EXCHANGE_KEY, request, SHARE_WEB_ORIGIN, testHandler } from "./testing";

// The personal agent routes over real HTTP and WebSocket, against the relay's
// own handler for sign-in state and running work. The journal's side of a
// personal edit is in `storage/liveAuthorSnapshots.test.ts`.

const relayHost = "relay.example.test", OWNER = "owner-1";
const frames = { receive: { maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096 },
  maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096 };
const bounds = { maxClientVectorBytes: 1024, maxSyncOutputBytes: 4096, maxAppliedUpdateBytes: 4096, maxSubmissionBytes: 4096, maxAdmissionBytes: 16384 };
const policy = { maxStructVisits: 10000, maxValueNodeVisits: 10000, maxDecodedPayloadByteVisits: 1000000, maxStructClientGroupVisits: 10000,
  maxDeleteClientGroupVisits: 10000, maxDeleteIntervalVisits: 10000, maxIndexOperations: 100000 };
const limits: NamedLiveRouteLimits = { maxConnections: 8, maxConnectionsPerWorkspace: 96, reservedOwnerConnections: 0, maxConnectionsPerSession: 2,
  maxConnectionsPerPrincipal: 3, maxConnectionsPerGrant: 4, maxBufferedBytes: 134217728, maxPendingRequests: 4, maxRequestBytes: 4096,
  maxResponseBytes: 4096, maxPendingBytes: 4096, maxFragments: 8, maxBufferedChunks: 16, upgradeTimeoutMs: 1000, idleTimeoutMs: 10_000, drainTimeoutMs: 100 };
/** The MCP address a personal agent signs in at for the workspace. */
const RESOURCE = `${SHARE_WEB_ORIGIN}/mcp/agent/w/${scope.workspaceId}`;
/** The self-hosted live host, which the fixture's device host hands over to. */
const service = { mode: "service", hostId: "service-1", hostEpoch: parseHostEpoch(2), instanceId: "service-instance", connectionId: "service-connection" } as const;
const TOKEN_EXPIRES_AT_MS = 4_000_000_000_000;
const TRY_AGAIN_LATER = 1013;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  const owned = cleanups.splice(0).reverse();
  vi.restoreAllMocks();
  for (const cleanup of owned) await cleanup();
});

/** The Postgres fence: the owner's epoch, which a test moves without its notification, and the listener. */
class Fence implements CredentialFence {
  epoch = 0;
  down = false;
  /** While set, a read waits for it, as a read Postgres hasn't answered. */
  held: Promise<void> | undefined;
  listener: CredentialFenceListener | undefined;
  async readEpoch(): Promise<number> {
    await this.held;
    if (this.down) throw new Error("The database is unreachable.");
    return this.epoch;
  }
  async readConsentCredentials() { return null; }
  async changedSince() {
    if (this.down) throw new Error("The database is unreachable.");
    return [];
  }
  listen(listener: CredentialFenceListener) {
    this.listener = listener;
    return { close: async () => { this.listener = undefined; } };
  }
}

function probe(): PersonalRunningEntry {
  return { agentId: "probe", ownerUserId: "probe", connectionId: "probe", fenceEpoch: 0, workspaceIds: [], kind: "wait", terminate() {} };
}

type Agent = { agentId: string; connectionId: string; headers: Record<string, string> };
type Socket = ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>;

/**
 * The owner's workspace on a self-hosted live host that enrolled its
 * document, with the relay handler's personal agents behind the live routes.
 */
async function fixture() {
  const state = await ticketFixture({ liveTickets: { retainedTicketsPerPrincipalGrant: 8, expiredTicketCleanupBatchSize: 1, now: () => 1000 } });
  cleanups.push(() => state.close());
  const { storage } = state, context = storage as StorageContext;
  const begun = storage.beginLiveHostTransition({ from: host, toMode: "service", toHostId: service.hostId, transitionId: "transition-1", startedAtMs: 5, guard: () => undefined });
  if (!begun.ok || !begun.snapshot.transition) throw new Error("fixture transition failed");
  const transitionGeneration = begun.snapshot.transition.transitionGeneration;
  expect(storage.commitLiveHostTransitionEpoch({ transitionId: "transition-1", transitionGeneration, updatedAtMs: 6 }).ok).toBe(true);
  expect(storage.activateLiveHostTransition({ ...service, transitionId: "transition-1", transitionGeneration, transitionFromEpoch: host.hostEpoch,
    updatedAtMs: 7, guard: () => undefined }).ok).toBe(true);
  storage.claimWorkspaceIdentity({ workspaceId: scope.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream" });
  context.tx(() => {
    context.db.prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,
      created_at_ms,updated_at_ms,demand_at_ms,accounted_bytes) VALUES (?,?,?,?,NULL,'epoch','stream',1,1,1,1,64)`)
      .run(scope.workspaceId, binding.objectId, binding.currentPath, OWNER);
  });

  const changes = createNamedFrameChanges(16), invalidated = new AbortController();
  const nativeBinding = { ...binding, selectorPaths: [binding.currentPath] };
  const native: NamedFrameNativeHost = {
    workspace: "never-send-native-handle", registrationId: 73, binding: nativeBinding, coordinate: service,
    invalidated: invalidated.signal, changes, deadlineMs: 1000, nextRequestId: () => 1, drain: vi.fn(async () => undefined),
    client: {
      openLiveAppliedSync: vi.fn(async () => ({ binding: nativeBinding, hostVector: Buffer.from([0]), missingStateUpdate: Buffer.from([0, 0]),
        observedLocalYDocHeadSequence: 100, position: { eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32) } })),
      readNextLiveApplied: vi.fn(async () => null), readLiveApplicationAck: vi.fn(async () => null),
    },
  };
  const captureNative = vi.fn(async () => native);
  const tickets = createLiveTickets({ storage, audience, key, hostReports: createLiveHostReports({ storage, captureNative }) });

  // The handler's clock is the one a fresh read checks a token's expiry with.
  let clock = 2000, supported = true;
  const fence = new Fence();
  const h = testHandler(storage, { credentialFence: fence, relayExchangeKey: RELAY_EXCHANGE_KEY, nowMs: () => clock });
  cleanups.push(() => h.dispose());
  /** The fence listener comes up and catches up, so running work can register. */
  async function up() {
    fence.listener!.onUp();
    await vi.waitFor(() => h.personalAgents.register(probe())());
  }
  await up();

  // A test can hold validation to change the agent's access while it runs.
  let validations = 0, validating: Promise<void> | undefined;
  const validate: CapacityLiveAdmissionValidator = async ({ retainStateUpdate: _retainStateUpdate, ...input }) => {
    validations++;
    await validating;
    return createLiveMarkdownJournalValidator(policy)(input);
  };
  const routes = createPersonalLiveRoutes({ storage, hosts: new Set([relayHost]), publicOrigin: audience, exchangeKey: RELAY_EXCHANGE_KEY,
    frames, bounds, limits, validate, captureNative, tickets, linkAuthority: h.linkAuthority, personalAgents: h.personalAgents,
    limiter: h.personalLimiter, supported: () => supported });
  const http = serveFetchHandler({ handler: incoming => routes.handle(incoming), maxBodyBytes: () => 16384,
    oversized: () => Response.json({}, { status: 404 }), failure: () => Response.json({}, { status: 500 }) });
  const upgrades: Promise<void>[] = [], sockets: WebSocket[] = [];
  http.on("upgrade", (incoming, socket, head) => { upgrades.push(routes.handleUpgrade(incoming, socket, head)); });
  cleanups.push(async () => {
    routes.close(); sockets.forEach(ws => ws.terminate()); await Promise.all(upgrades);
    await new Promise<void>(done => http.close(() => done()));
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const port = (http.address() as { port: number }).port;

  /** One of the owner's personal agents, signed in at the workspace's address and reaching it at `level`, as its sign-in commits it. */
  function agent(name: string, level: "view" | "comment" | "edit" = "edit") {
    const agentId = `p-${[...createHash("sha256").update(name).digest()].slice(0, 26).map(byte => BASE32[byte % 32]).join("")}`;
    context.tx(() => {
      context.db.prepare("INSERT INTO sync_relay_personal_agents(agent_id,owner_user_id,name,hue,status,epoch,created_at_ms) VALUES (?,?,?,'olive','active',1,0)")
        .run(agentId, OWNER, name);
      context.db.prepare("INSERT INTO sync_relay_personal_agent_reach(agent_id,workspace_id,level,start_seq) VALUES (?,?,?,0)").run(agentId, scope.workspaceId, level);
    });
    const connection = (suffix: string): Agent => {
      const connectionId = `connection-${name}${suffix}`;
      const token = createHash("sha256").update(`token-${name}${suffix}`).digest("base64url");
      const check = agentAccessCheck(token, RESOURCE, LINK_KEY)!;
      context.tx(() => {
        context.db.prepare(`INSERT INTO sync_relay_personal_agent_connections(connection_id,agent_id,owner_user_id,client_id,resource_hash,agent_epoch,
          fence_epoch,connected_at_ms) VALUES (?,?,?,'client',?,1,0,0)`).run(connectionId, agentId, OWNER, check.resourceHash);
        context.db.prepare("INSERT INTO sync_relay_personal_agent_tokens(token_hash,connection_id,kind,issued_at_ms,expires_at_ms) VALUES (?,?,'access',0,?)")
          .run(check.accessTokenHash, connectionId, TOKEN_EXPIRES_AT_MS);
      });
      return { agentId, connectionId, headers: { authorization: `DohcAgent ${token}`, "x-dohc-agent-resource": RESOURCE } };
    };
    /** The same agent's other connection, as a second client signed in. */
    return { ...connection(""), another: () => connection("-2") };
  }

  /** What share-web sends for the agent's ticket request. */
  function ticketRequest(who: Agent, body: unknown = { workspaceId: scope.workspaceId, objectId: binding.objectId }) {
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest(`http://127.0.0.1:${port}/sync/live/personal-tickets`, { method: "POST", headers: { host: relayHost, origin: audience,
        "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY, "content-type": "application/json", ...who.headers } }, response => {
        const bytes: Buffer[] = []; response.on("data", chunk => bytes.push(Buffer.from(chunk)));
        response.once("end", () => resolve(new Response(Buffer.concat(bytes), { status: response.statusCode })));
        response.once("error", reject);
      });
      outgoing.once("error", reject); outgoing.end(JSON.stringify(body));
    });
  }
  async function mint(who: Agent) {
    const response = await ticketRequest(who);
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json() as { token: string; expiresAtMs: number };
  }
  function connect(token: string, who: Agent) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/live/personal?workspaceId=${scope.workspaceId}`, ["dohc-live-v1", `dohc-live-ticket.${token}`], {
      headers: { host: relayHost, origin: audience, "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY, ...who.headers }, perMessageDeflate: false });
    sockets.push(ws); ws.on("error", () => undefined);
    const received: LiveFrame[] = [];
    ws.on("message", bytes => { received.push(decodeLiveFrame(Buffer.from(bytes as Buffer), frames.receive.maxFrameBytes)); });
    const status = new Promise<number>(done => {
      ws.once("open", () => done(101)); ws.once("error", () => done(0));
      ws.once("unexpected-response", (_request, response) => { response.resume(); done(response.statusCode!); ws.terminate(); });
    });
    const closed = new Promise<[number, string]>(resolve => ws.once("close", (code, reason) => resolve([code, reason.toString()])));
    return { ws, status, received, closed };
  }
  /** An owner's edit the host applied, read by the next pull, which waits for `held` before it answers. */
  function applied(updateBytes = Buffer.from([1, 2, 3]), held?: Promise<void>) {
    vi.mocked(native.client.readNextLiveApplied).mockImplementation(async (_request, after) => {
      if (after.eventCount) return null;
      await held;
      return { position: { eventCount: 1, journalCursor: 1, evidenceDigest: "cd".repeat(32) }, updateBytes,
        ack: { deliveryId: "owner-edit", updateDigest: sha(updateBytes), journalCursor: 1, acceptingHostEpoch: service.hostEpoch,
          localYDocSequence: 1, applicationReplayed: false } };
    });
    changes.notify(binding);
    return updateBytes;
  }
  /** The journal accepts each admission, so a test sees what the route committed. */
  function admitting() {
    vi.spyOn(storage, "readLiveUpdateJournalCut").mockReturnValue({ kind: "cut", cut: { checkpoint: { bytes: Uint8Array.of(0, 0) }, suffix: [] } as unknown as LiveUpdateJournalCut });
    return vi.spyOn(storage, "commitLiveUpdateJournal").mockReturnValue({ result: { kind: "accepted", receipt: { deliveryId: "edit",
      updateDigest: sha(Uint8Array.of(0, 0)), journalCursor: 1, acceptingHostEpoch: service.hostEpoch } } } as never);
  }
  /** The owner changes the agent's reach from the roster. */
  async function reach(agentId: string, choices: { workspaceId: string; level: string }[]) {
    const response = await h(request(OWNER, `/sync/personal-agents/${agentId}/reach`, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reach: choices }) }));
    expect(response.status, await response.clone().text()).toBe(200);
  }
  const unredeemed = () => Number(state.raw.prepare("SELECT count(*) AS count FROM sync_relay_live_session_tickets WHERE redeemed_at_ms IS NULL").get()!.count);
  const demandAtMs = () => Number(state.raw.prepare(`SELECT demand_at_ms FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`)
    .get(scope.workspaceId, binding.objectId)!.demand_at_ms);
  return { ...state, h, fence, native, tickets, validate, up, validations: () => validations,
    holdValidation: (held: Promise<void> | undefined) => { validating = held; }, agent, ticketRequest, mint, connect, applied, admitting, reach, unredeemed, demandAtMs,
    setClock: (value: number) => { clock = value; }, setSupported: (value: boolean) => { supported = value; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function openSync(socket: Socket, waitForSync = true) {
  await vi.waitFor(() => {
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
    expect(socket.received.map(frame => frame.kind)).toContain("credit");
  }, { timeout: 5000 });
  const send = (frame: LiveFrame) => socket.ws.send(encodeLiveFrame(frame, frames.receive.maxFrameBytes));
  send({ kind: "hello", receivePolicy: frames.receive });
  send({ kind: "credit", grantedBytes: frames.maxQueuedBytes, grantedFrames: frames.maxQueuedFrames });
  const vector = Uint8Array.of(0);
  send({ kind: "begin", purpose: "client-vector", transferId: 1, totalBytes: vector.length, digest: sha(vector) });
  send({ kind: "chunk", transferId: 1, offset: 0, bytes: vector });
  if (!waitForSync) return;
  await vi.waitFor(() => {
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
    expect(socket.received.map(frame => frame.kind)).toContain("chunk");
  }, { timeout: 5000 });
  send({ kind: "sync-applied", appliedThroughJournalCursor: 0 });
}

function submit(socket: Socket, deliveryId: string, transferId: number, authorContext?: LiveAuthorContext) {
  const bytes = Uint8Array.of(0, 0);
  socket.ws.send(encodeLiveFrame({ kind: "begin", purpose: "submit-update", deliveryId, transferId, totalBytes: bytes.length, digest: sha(bytes),
    ...(authorContext ? { authorContext } : {}) } as LiveFrame, frames.receive.maxFrameBytes));
  socket.ws.send(encodeLiveFrame({ kind: "chunk", transferId, offset: 0, bytes }, frames.receive.maxFrameBytes));
}

const resultFor = (socket: Socket, deliveryId: string) => socket.received.find(frame =>
  frame.kind === "result" && (frame.result === "success" ? frame.ack.deliveryId : frame.deliveryId) === deliveryId);

/** The bytes of the applied update the agent was sent, on the first transfer after its initial sync. */
const delivered = (socket: Socket) => Buffer.concat(socket.received.flatMap(frame =>
  frame.kind === "chunk" && frame.transferId === 2 ? [Buffer.from(frame.bytes)] : []));

/** A session after its initial sync, with the host waiting for the next applied update. */
async function editing(f: Fixture, who: Agent) {
  const socket = f.connect((await f.mint(who)).token, who);
  expect(await socket.status).toBe(101);
  await openSync(socket);
  await vi.waitFor(() => expect(f.native.client.readNextLiveApplied).toHaveBeenCalled());
  return socket;
}

it("mints a ticket only for an agent at Edit, and only while the self-hosted live host is the configured host", async () => {
  const f = await fixture(), commenter = f.agent("commenter", "comment"), helper = f.agent("helper");
  expect((await f.ticketRequest(commenter)).status).toBe(404);
  f.setSupported(false);
  expect((await f.ticketRequest(helper)).status).toBe(404);
  f.setSupported(true);
  expect(Object.keys(await f.mint(helper)).sort()).toEqual(["expiresAtMs", "token"]);
  // A named recipient's body is not a personal agent's.
  expect((await f.ticketRequest(helper, { discriminator: "abcdefghijkl", objectId: binding.objectId })).status).toBe(404);
});

it("opens a ticket only for the connection it was minted for", async () => {
  const f = await fixture(), helper = f.agent("helper"), other = f.agent("other");
  const { token } = await f.mint(helper);
  const bearer = Buffer.alloc(32, 1).toString("base64url"), profile = Buffer.alloc(32, 2).toString("base64url");
  const link = { kind: "link" as const, workspaceId: scope.workspaceId, shareId: scope.shareId, grantId: scope.grantId, sessionId: "link-session",
    capabilityHash: hashLinkBearer(bearer, key), profileTokenHash: hashLinkProfileSecret(profile, key) };
  expect(await f.tickets.redeem(token, link)).toBeNull();
  expect(await f.tickets.redeem(token, scope)).toBeNull();
  for (const who of [helper.another(), other]) expect(await f.connect(token, who).status).toBe(404);
  expect(f.unredeemed()).toBe(1);
  const socket = f.connect(token, helper);
  expect(await socket.status).toBe(101);
  await vi.waitFor(() => expect(socket.received.map(frame => frame.kind)).toContain("welcome"));
  expect(f.unredeemed()).toBe(0);
});

// Each fresh read begins after the engine read the update or the route
// validated the edit, so a change Postgres committed while either ran is seen.
const accessChanges: [string, (f: Fixture) => void, boolean][] = [
  ["nothing changed", () => undefined, true],
  ["the fence moved on without its notification", f => { f.fence.epoch = 1; }, false],
  ["the agent's token expired", f => { f.setClock(TOKEN_EXPIRES_AT_MS); }, false],
];

it.each(accessChanges)("reads the agent's access again before sending it the next update: %s", async (_change, change, continues) => {
  const f = await fixture(), helper = f.agent("helper");
  const socket = await editing(f, helper);
  const reads = vi.mocked(f.native.client.readNextLiveApplied).mock.calls.length;
  let answer!: () => void;
  const update = f.applied(undefined, new Promise<void>(resolve => { answer = resolve; }));
  await vi.waitFor(() => expect(f.native.client.readNextLiveApplied).toHaveBeenCalledTimes(reads + 1));
  change(f);
  answer();
  if (continues) {
    await vi.waitFor(() => expect(delivered(socket)).toEqual(update));
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
  } else {
    await socket.closed;
    expect(delivered(socket).length).toBe(0);
  }
});

it.each(accessChanges)("reads the agent's access again before admitting its next edit: %s", async (_change, change, continues) => {
  const f = await fixture(), helper = f.agent("helper");
  const socket = await editing(f, helper);
  const commit = f.admitting();
  let answer!: () => void;
  f.holdValidation(new Promise<void>(resolve => { answer = resolve; }));
  submit(socket, "edit", 2);
  await vi.waitFor(() => expect(f.validations()).toBe(1));
  change(f);
  answer();
  if (continues) {
    await vi.waitFor(() => expect(resultFor(socket, "edit")).toBeDefined());
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]![0]).toMatchObject({
      actor: { kind: "personal", workspaceId: scope.workspaceId, agentId: helper.agentId, connectionId: helper.connectionId, fenceEpoch: 0 },
      expectedAuthority: { principalKind: "personal", principalId: helper.agentId, grantId: null, grantGeneration: null } });
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
  } else {
    await socket.closed;
    expect(commit).not.toHaveBeenCalled();
  }
});

it("refuses a mint, an open, an initial sync and an admission while Postgres can't answer, and serves each once it can", async () => {
  const f = await fixture(), helper = f.agent("helper");
  f.fence.down = true;
  const refused = await f.ticketRequest(helper);
  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({ code: "personal_agent_unavailable" });
  f.fence.down = false;
  const { token } = await f.mint(helper);

  f.fence.down = true;
  const atOpen = f.connect(token, helper);
  expect(await atOpen.status).toBe(101);
  expect(await atOpen.closed).toEqual([TRY_AGAIN_LATER, "personal_agent_unavailable"]);
  expect(f.unredeemed()).toBe(1);
  f.fence.down = false;

  const atSync = f.connect(token, helper);
  expect(await atSync.status).toBe(101);
  f.fence.down = true;
  await openSync(atSync, false);
  expect(await atSync.closed).toEqual([TRY_AGAIN_LATER, "personal_agent_unavailable"]);
  expect(atSync.received.some(frame => frame.kind === "chunk")).toBe(false);
  expect(f.native.client.openLiveAppliedSync).toHaveBeenCalledOnce();
  f.fence.down = false;

  const socket = await editing(f, helper);
  const commit = f.admitting();
  f.fence.down = true;
  submit(socket, "while-down", 2);
  await vi.waitFor(() => expect(resultFor(socket, "while-down")).toMatchObject({ result: "retry", reason: "admission-unavailable" }));
  expect(f.storage.readLiveUpdateJournalCut).toHaveBeenCalledOnce();
  expect(commit).not.toHaveBeenCalled();
  expect(socket.ws.readyState).toBe(WebSocket.OPEN);
  f.fence.down = false;
  submit(socket, "once-up", 3);
  await vi.waitFor(() => expect(resultFor(socket, "once-up")).toBeDefined());
  expect(commit).toHaveBeenCalledOnce();
});

it.each(["sending it an update", "admitting its edit"])("lets go of a closed session while a fresh read before %s is still waiting", async step => {
  const f = await fixture(), helper = f.agent("helper");
  const socket = await editing(f, helper);
  const renew = vi.spyOn(f.storage, "renewPersonalSessionDemand");
  const reads = vi.spyOn(f.fence, "readEpoch");
  let answer!: () => void;
  f.fence.held = new Promise<void>(resolve => { answer = resolve; });
  const commit = step === "admitting its edit" ? f.admitting() : undefined;
  if (commit) submit(socket, "held", 2); else f.applied();
  await vi.waitFor(() => expect(reads).toHaveBeenCalled());
  socket.ws.close();
  // The session's connection and editor count are released while Postgres still hasn't answered.
  await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
  if (commit) expect(commit).not.toHaveBeenCalled();
  answer();
});

it("ends every personal session when the fence listener goes down, and opens a session once it has caught up", async () => {
  const f = await fixture(), helper = f.agent("helper");
  const sessions = [await editing(f, helper), await editing(f, helper)];
  f.fence.listener!.onDown();
  await Promise.all(sessions.map(socket => socket.closed));
  const { token } = await f.mint(helper);
  const refused = f.connect(token, helper);
  expect(await refused.status).toBe(101);
  expect(await refused.closed).toEqual([TRY_AGAIN_LATER, "personal_agent_unavailable"]);
  expect(f.unredeemed()).toBe(1);
  await f.up();
  const reopened = f.connect(token, helper);
  expect(await reopened.status).toBe(101);
  await openSync(reopened);
  expect(f.unredeemed()).toBe(0);
});

const endings: [string, (f: Fixture, agentId: string) => Promise<void>][] = [
  ["the owner takes the workspace out of its reach", (f, agentId) => f.reach(agentId, [])],
  ["the owner signs it out", async (f, agentId) => {
    expect((await f.h(request(OWNER, `/sync/personal-agents/${agentId}/sign-out`, { method: "POST" }))).status).toBe(200);
  }],
  ["the owner's password changes", async f => {
    f.fence.epoch = 1;
    f.fence.listener!.onChange({ userId: OWNER, epoch: 1, changedAtMs: 10 });
  }],
];

it.each(endings)("ends the agent's session, and not its owner's, when %s", async (_ending, end) => {
  const f = await fixture(), helper = f.agent("helper");
  const owner = captureOwnerLiveFrameHost({ authenticatedUserId: OWNER, storage: f.storage, native: f.native, bounds, validate: f.validate });
  const socket = await editing(f, helper);
  await end(f, helper.agentId);
  await socket.closed;
  expect(owner.invalidated.aborted).toBe(false);
  expect(() => owner.assertCurrent()).not.toThrow();
  owner.close();
});

it.each([["comment", false], ["edit", true]] as const)("keeps the agent's session at %s only while it reaches Edit", async (level, continues) => {
  const f = await fixture(), helper = f.agent("helper");
  const socket = await editing(f, helper);
  await f.reach(helper.agentId, [{ workspaceId: scope.workspaceId, level }]);
  if (!continues) { await socket.closed; return; }
  const update = f.applied();
  await vi.waitFor(() => expect(delivered(socket)).toEqual(update));
  expect(socket.ws.readyState).toBe(WebSocket.OPEN);
});

it("applies the agent's edits until the document is renamed, then ends its session", async () => {
  const f = await fixture(), helper = f.agent("helper");
  const socket = await editing(f, helper);
  const commit = f.admitting();
  submit(socket, "before-rename", 2);
  await vi.waitFor(() => expect(resultFor(socket, "before-rename")).toBeDefined());
  expect(commit).toHaveBeenCalledOnce();
  f.raw.prepare("UPDATE sync_relay_object_moments SET path='docs/moved.md' WHERE workspace_id=? AND object_id=?").run(scope.workspaceId, binding.objectId);
  submit(socket, "after-rename", 3);
  await socket.closed;
  expect(commit).toHaveBeenCalledOnce();
});

it("admits the agent's edit as the agent, whoever its update declares", async () => {
  const f = await fixture(), helper = f.agent("helper");
  const socket = await editing(f, helper);
  const commit = f.admitting();
  const contexts: (LiveAuthorContext | undefined)[] = [
    undefined,
    { kind: "account", accountId: "reader-1" },
    { kind: "signed-out", agent: { agentId: "other-agent", agentName: "Other", onBehalfOf: "reader-1", depth: 1 } },
    { kind: "account", accountId: OWNER, agent: { agentId: `p-${"o".repeat(26)}`, depth: 0 } },
  ];
  for (const [index, context] of contexts.entries()) {
    submit(socket, `declared-${index}`, index + 2, context);
    await vi.waitFor(() => expect(resultFor(socket, `declared-${index}`)).toBeDefined());
  }
  const admitted = commit.mock.calls.map(([input]) => ({ actor: input.actor, expectedAuthority: input.expectedAuthority,
    metadata: { ...input.metadata, deliveryId: undefined } }));
  expect(admitted).toHaveLength(contexts.length);
  for (const input of admitted) {
    expect(input.metadata).not.toHaveProperty("authorContext");
    expect(input).toEqual(admitted[0]);
  }
});

it.each([false, true])("renews the document's demand when the agent's session closes, unless its owner paused it; paused=%s", async paused => {
  const f = await fixture(), helper = f.agent("helper");
  const socket = await editing(f, helper);
  const renew = vi.spyOn(f.storage, "renewPersonalSessionDemand");
  if (paused) f.raw.exec(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET owner_stop='pause'`);
  socket.ws.close();
  await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
  expect(renew.mock.results[0]).toEqual({ type: "return", value: !paused });
  if (paused) expect(f.demandAtMs()).toBe(1);
  else expect(f.demandAtMs()).toBeGreaterThan(1);
});
