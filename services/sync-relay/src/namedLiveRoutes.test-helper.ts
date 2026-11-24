import { createLiveTickets } from "./liveTickets";
import { createLiveHostReports } from "./namedLiveHostReports";

import { selfHostLiveProfile } from "./selfHostLiveProfile";
import { createNamedDesktopLive } from "./namedDesktopLive";

import { createLiveConnectionAdmission } from "./liveConnectionAdmission";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { expect, vi } from "vitest";
import { serveFetchHandler } from "@dohc/service-http";
import type { WorkspaceAuth } from "@dohc/workspace-auth/betterAuth";
import {
  createPhoneCapableAccountSessionResolver,
  UnauthorizedError,
  type AccountSession,
  type StoredAccountSession,
} from "@dohc/workspace-auth/session";
import type { LiveRooms } from "./liveRoom.js";
import {
  LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES,
  encodeLiveFrame,
  type LiveFrame,
} from "@dohc/live-session-contract/live-frame";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import { createSyncRelayHandler } from "./server.js";
import {
  createOwnerLiveRoutes,
  createNamedLiveRoutes,
  type NamedLiveRouteLimits,
} from "./namedLiveRoutes.js";
import { createLinkLiveResolver } from "./linkLiveBrowserAuth.js";
import { hashLinkBearer, hashLinkProfileSecret } from "./linkSecurity.js";

import { createNamedFrameChanges, type NamedFrameNativeHost } from "./namedLiveFrameHost.js";
import {
  fixture as ticketFixture,
  audience,
  binding,
  host,
  key,
  scope,
} from "./liveTickets.test-helper.js";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { SessionHostBlock } from "./linkRefusal";

import { decodeLiveFrame } from "@dohc/live-session-contract/live-frame";
import { request as httpRequest } from "node:http";
import { createLiveMembershipRegistry, type LiveMembershipPolicy } from "./liveMembership";
// The production resolver over the owner's own phone sign-in, which a test may end sooner.
export const phoneState = { expiresAt: 8e12 };
const ownerPhone = createPhoneCapableAccountSessionResolver({
  api: {
    getSession: async () => ({
      user: { id: "owner-1" },
      session: {
        id: "phone-session",
        userId: "owner-1",
        expiresAt: phoneState.expiresAt,
        clientKind: "phone",
      },
    }),
  },
} as unknown as WorkspaceAuth);
export const phoneScope = {
  kind: "owner" as const,
  workspaceId: scope.workspaceId,
  userId: "owner-1",
  sessionId: "phone-session",
  sessionExpiresAtMs: 8e12,
};
export const phoneHeaders = { authorization: "Bearer owner-phone-token" };

export const exchangeKey = "test-exchange-key-".repeat(3),
  relayHost = "relay.example.test";
export const frames = {
  receive: {
    maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES,
    maxStateVectorBytes: 1024,
    maxUpdateBytes: 4096,
    maxSyncBytes: 4096,
  },
  maxQueuedBytes: 4096,
  maxQueuedFrames: 32,
  maxControlBytes: 4096,
  maxControlFrames: 8,
  maxAssemblyBytes: 4096,
};
export const bounds = {
  maxClientVectorBytes: 1024,
  maxSyncOutputBytes: 4096,
  maxAppliedUpdateBytes: 4096,
  maxSubmissionBytes: 4096,
  maxAdmissionBytes: 16384,
};
export const policy = {
  maxStructVisits: 10000,
  maxValueNodeVisits: 10000,
  maxDecodedPayloadByteVisits: 1000000,
  maxStructClientGroupVisits: 10000,
  maxDeleteClientGroupVisits: 10000,
  maxDeleteIntervalVisits: 10000,
  maxIndexOperations: 100000,
};
export const limits: NamedLiveRouteLimits = {
  maxConnections: 8,
  maxConnectionsPerWorkspace: 96,
  reservedOwnerConnections: 0,
  maxConnectionsPerSession: 2,
  maxConnectionsPerPrincipal: 3,
  maxConnectionsPerGrant: 4,
  maxBufferedBytes: 134217728,
  maxBufferedBytesPerPrincipal: 100663296,
  maxBufferedBytesPerShare: 134217728,
  maxBufferedBytesPerWorkspace: 134217728,
  maxPendingRequests: 4,
  maxRequestBytes: 4096,
  maxResponseBytes: 4096,
  maxPendingBytes: 4096,
  maxFragments: 8,
  maxBufferedChunks: 16,
  // Open routes idle between frames while a test sets up its next peer over real
  // sockets; a loaded gate host can stretch that past 5 s.
  upgradeTimeoutMs: 1000,
  idleTimeoutMs: 10_000,
  drainTimeoutMs: 100,
};
export const cleanups: (() => Promise<void>)[] = [];

const defaultScope = scope,
  defaultBinding = binding,
  defaultFrames = frames,
  defaultBounds = bounds;
export async function fixture(
  routeLimits = limits,
  link = false,
  membershipPolicy: LiveMembershipPolicy = {
    maxSessions: 16,
    maxMembers: 8,
    maxSnapshotBytes: 153,
  },
  owner = false,
  desktop = false,
  admission?: ReturnType<typeof createLiveConnectionAdmission>,
  person = 0,
  document = 0,
  production = false,
  workspaceId = defaultScope.workspaceId,
  shareId = defaultScope.shareId,
  population?: { people: number; documents: number },
  rooms?: LiveRooms,
) {
  const liveProfile = selfHostLiveProfile();
  const frames = production ? liveProfile.frames : defaultFrames,
    bounds = production ? liveProfile.namedLive.host : defaultBounds;
  const scope = {
    ...defaultScope,
    workspaceId,
    shareId,
    userId: person ? "reader-" + person : defaultScope.userId,
    grantId:
      link && shareId !== defaultScope.shareId
        ? shareId + "-link"
        : !link && person
          ? "edit-" + person
          : defaultScope.grantId,
  };
  const binding = {
    ...defaultBinding,
    workspaceId,
    objectId: document ? "object-" + document : defaultBinding.objectId,
  };
  const state = await ticketFixture(
    population ? { liveTickets: { ...liveProfile.namedLive.tickets, now: () => 1000 } } : undefined,
    {
      userId: scope.userId,
      grantId: scope.grantId,
      objectId: binding.objectId,
      workspaceId,
      shareId,
    },
    population,
  );
  const routeKind = desktop ? "desktop" : link ? "link" : "named";
  const memberships = createLiveMembershipRegistry(
    membershipPolicy,
    state.storage.readLiveAuthority.bind(state.storage),
  );
  const bearer = Buffer.alloc(32, 1).toString("base64url"),
    profile = Buffer.alloc(32, person || 2).toString("base64url");
  const currentScope = link
    ? {
        kind: "link" as const,
        workspaceId: scope.workspaceId,
        shareId: scope.shareId,
        grantId: scope.grantId,
        sessionId: "link-session",
        capabilityHash: hashLinkBearer(bearer, key),
        profileTokenHash: hashLinkProfileSecret(profile, key),
      }
    : scope;
  const holderHeaders: Record<string, string> = link
    ? { authorization: `LinkCapability ${bearer}`, "x-dohc-link-profile-secret": profile }
    : {};
  let linkHeaders = holderHeaders;
  if (link) {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    state.raw.exec(
      "UPDATE sync_relay_share_grants SET principal_kind='link', principal_user_id=NULL",
    );
    for (let person = 1; person <= (population?.people ?? 1); person++) {
      expect(
        state.storage.mintLinkSession({
          session: {
            sessionId: population ? "link-session-" + person : "link-session",
            capabilityHash: hashLinkBearer(
              population ? Buffer.alloc(32, person).toString("base64url") : bearer,
              key,
            ),
            grantId: scope.grantId,
            generation: 4,
            mintedAtMs: 999,
            expiresAtMs: 61_000,
          },
        }),
      ).toBe(true);
    }
  }
  const changes = createNamedFrameChanges(population ? liveProfile.namedLive.maxListeners : 16),
    invalidated = new AbortController();
  const native: NamedFrameNativeHost = {
    workspace: "never-send-native-handle",
    registrationId: 73,
    binding: { ...binding, selectorPaths: [binding.currentPath] },
    coordinate: host,
    invalidated: invalidated.signal,
    changes,
    deadlineMs: 1000,
    nextRequestId: () => 1,
    drain: vi.fn(async () => undefined),
    client: {
      openLiveAppliedSync: vi.fn(async () => ({
        binding: { ...binding, selectorPaths: [binding.currentPath] },
        hostVector: Buffer.from([0]),
        missingStateUpdate: Buffer.from([0, 0]),
        observedLocalYDocHeadSequence: 100,
        position: { eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32) },
      })),
      readNextLiveApplied: vi.fn(async () => null),
      readLiveApplicationAck: vi.fn(async () => null),
    },
  };
  const captureNative = vi.fn(async (current?: LiveObjectBinding) =>
    population && current
      ? { ...native, binding: { ...current, selectorPaths: [current.currentPath] } }
      : native,
  );
  const sessionHostBlocked = vi.fn(
    (_document: { workspaceId: string; objectId: string }): SessionHostBlock | undefined =>
      undefined,
  );
  const actor = vi.fn(async (request: Request, workspaceId: string) => {
    if (owner || desktop) {
      const bearer = request.headers.get("authorization");
      if (!bearer) throw new UnauthorizedError();
      return {
        userId:
          bearer === "Bearer owner-token"
            ? "owner-1"
            : bearer === "Bearer reader-token"
              ? "reader-1"
              : "other-user",
        workspaceId,
      };
    }
    const cookie = request.headers.get("cookie");
    if (!cookie || cookie === "anonymous") throw new UnauthorizedError();
    return {
      userId:
        population && /^account=reader-\d+$/.test(cookie)
          ? cookie.slice("account=".length)
          : cookie === "account=reader"
            ? scope.userId
            : "other-user",
      workspaceId,
    };
  });
  // The owner route's sign-ins: a phone's through the production resolver, any other as a desktop's.
  const accountSession = vi.fn(async (request: Request): Promise<AccountSession> => {
    if (request.headers.get("authorization") === phoneHeaders.authorization)
      return await ownerPhone(request);
    const { userId } = await actor(request, "");
    return { userId, sessionId: `session-${userId}`, expiresAtMs: 8e12, clientKind: "desktop" };
  });
  const sessionRows = new Map<string, StoredAccountSession>([
    ["phone-session", { userId: "owner-1", expiresAtMs: 8e12, clientKind: "phone" }],
  ]);
  const readSessions = vi.fn(
    async (ids: readonly string[]) =>
      new Map(
        ids.flatMap((id): [string, StoredAccountSession][] =>
          sessionRows.has(id) ? [[id, sessionRows.get(id)!]] : [],
        ),
      ),
  );
  const application = createSyncRelayHandler({
    storage: state.storage,
    resolveActor: actor,
    shareWebOrigin: audience,
    relayExchangeKey: exchangeKey,
    nowMs: () => 1000,
    ...(link ? { linkKey: key, publicEditRelease: { version: 1 } } : {}),
    namedBrowserSessionLimits: {
      maxSessions: population ? liveProfile.browserSessions.maxSessions : 8,
      retentionMs: 30000,
      maxPendingRequests: 4,
      maxRequestBytes: 16384,
      maxResponseBytes: 16384,
      timeoutMs: 1000,
    },
  });
  const tickets = createLiveTickets({
    storage: state.storage,
    audience,
    key,
    hostReports: createLiveHostReports({ storage: state.storage, captureNative }),
  });
  const desktopAdmission = desktop
    ? createNamedDesktopLive({
        storage: state.storage,
        resolveActor: actor,
        readinessLimits: { maxPendingRequests: 8, maxPendingPerUser: 4, timeoutMs: 5000 },
        hostsMemberDocuments: () => false,
        publicOrigin: audience,
        hosts: new Set([relayHost]),
        tickets,
        changes,
        blocked: sessionHostBlocked,
        limits: {
          maxSessions: 32,
          retentionMs: 60000,
          maxPendingRequests: 8,
          maxRequestBytes: 16384,
          maxResponseBytes: 16384,
          timeoutMs: 5000,
        },
        editorLimits: {
          provider: {
            frames,
            maxPendingUpdateBytes: 8192,
            maxPendingUpdates: 4,
            maxDeliveryAttempts: 3,
          },
          maxHttpResponseBytes: 4096,
          maxSocketBufferedBytes: 4096,
          connectTimeoutMs: 1000,
          sendTimeoutMs: 1000,
          drainPollMs: 10,
        },
      })
    : undefined;
  const routes = owner
    ? createOwnerLiveRoutes({
        storage: state.storage,
        resolveAccountSession: accountSession,
        accountSessions: { read: readSessions },
        tickets,
        ...(rooms ? { rooms } : {}),
        hosts: new Set([relayHost]),
        publicOrigin: audience,
        exchangeKey,
        frames,
        bounds,
        limits: routeLimits,
        validate: ({ retainStateUpdate: _retainStateUpdate, ...input }) =>
          createLiveMarkdownJournalValidator(policy)(input),
        captureNative,
        admission,
      })
    : createNamedLiveRoutes({
        kind: link ? "link" : "named",
        desktopBearer: desktop,
        ...(rooms ? { rooms } : {}),
        membership: memberships,
        storage: state.storage,
        hosts: new Set([relayHost]),
        publicOrigin: audience,
        exchangeKey,
        frames,
        bounds,
        limits: routeLimits,
        validate: ({ retainStateUpdate: _retainStateUpdate, ...input }) =>
          createLiveMarkdownJournalValidator(policy)(input),
        sessions:
          desktopAdmission ??
          (link
            ? createLinkLiveResolver({
                publicEditRelease: { version: 1 },
                storage: state.storage,
                linkKey: key,
                linkAuthority: application.linkAuthority,
              })
            : { resolve: application.resolveNamedBrowserSession }),
        tickets,
        captureNative,
        admission,
        sessionHostBlocked,
      });
  const http = serveFetchHandler({
    handler: (request) =>
      new URL(request.url).pathname === "/sync/live/desktop-open" && desktopAdmission
        ? desktopAdmission.handle(request)
        : new URL(request.url).pathname === `/sync/live/${routeKind}-tickets`
          ? routes.handle(request)
          : application(request),
    maxBodyBytes: () => 16384,
    oversized: () => Response.json({}, { status: 404 }),
    failure: () => Response.json({}, { status: 500 }),
  });
  const upgrades: Promise<void>[] = [],
    sockets: WebSocket[] = [];
  http.on("upgrade", (request, socket, head) => {
    upgrades.push(routes.handleUpgrade(request, socket, head));
  });
  cleanups.push(async () => {
    routes.close();
    sockets.forEach((ws) => ws.terminate());
    await Promise.all(upgrades);
    await new Promise<void>((done) => http.close(() => done()));
    await state.close();
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const port = (http.address() as { port: number }).port;
  // A link request sends a cookie only when a test names one: an agent's is refused, a holder's ignored.
  const defaultCookie = link ? "" : "account=reader";
  async function post(
    path: string,
    body: unknown,
    cookie = defaultCookie,
    extra: Record<string, string> = {},
    signal?: AbortSignal,
  ) {
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest(
        `http://127.0.0.1:${port}${path}`,
        {
          method: "POST",
          signal,
          headers: {
            host: relayHost,
            "content-type": "application/json",
            ...(desktop
              ? { authorization: "Bearer reader-token" }
              : {
                  origin: audience,
                  "x-dohc-relay-exchange-key": exchangeKey,
                  ...(cookie ? { cookie } : {}),
                  ...linkHeaders,
                }),
            ...extra,
          },
        },
        (response) => {
          const bytes: Buffer[] = [];
          response.on("data", (chunk) => bytes.push(Buffer.from(chunk)));
          response.once("end", () =>
            resolve(new Response(Buffer.concat(bytes), { status: response.statusCode })),
          );
          response.once("error", reject);
        },
      );
      request.once("error", reject);
      request.end(JSON.stringify(body));
    });
  }
  const bootstrap = desktop
    ? await post("/sync/live/desktop-open", { shareId: scope.shareId, path: binding.currentPath })
    : population || link || owner
      ? Response.json({
          discriminator:
            production && document ? "abcdefghijk" + document.toString(36) : "abcdefghijkl",
        })
      : await post("/sync/live/named-sessions", { grantId: scope.grantId });
  expect(bootstrap.status).toBe(200);
  const bootstrapped = (await bootstrap.json()) as {
    discriminator: string;
    ticket?: { token: string; expiresAtMs: number };
  };
  let discriminator = bootstrapped.discriminator,
    initialDesktopTicket = bootstrapped.ticket;
  async function mint(): Promise<{
    token: string;
    expiresAtMs: number;
    publicPrincipalId?: string;
  }> {
    if (desktop) {
      if (initialDesktopTicket) {
        const ticket = initialDesktopTicket;
        initialDesktopTicket = undefined;
        return ticket;
      }
      const response = await post("/sync/live/desktop-open", {
        shareId: scope.shareId,
        path: binding.currentPath,
      });
      expect(response.status).toBe(200);
      const admitted = (await response.json()) as {
        discriminator: string;
        ticket: { token: string; expiresAtMs: number };
      };
      discriminator = admitted.discriminator;
      return admitted.ticket;
    }
    if (!link && !desktop)
      expect(
        await application.resolveNamedBrowserSession(
          new Request("https://relay.example.test", { headers: { cookie: "account=reader" } }),
          discriminator,
        ),
      ).toEqual(scope);
    expect(
      state.storage.resolveLiveObjectHostBinding(currentScope, binding.objectId),
    ).toMatchObject({ kind: "current", binding });
    const response = await post(`/sync/live/${routeKind}-tickets`, {
      discriminator,
      objectId: binding.objectId,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      token: string;
      expiresAtMs: number;
      publicPrincipalId?: string;
    };
  }
  function connect(
    token: string,
    cookie = defaultCookie,
    extra: Record<string, string> = {},
    ownerQuery = "",
    session = discriminator,
  ) {
    const target = owner
      ? `/sync/workspaces/${binding.workspaceId}/live/owner?objectId=${binding.objectId}&lineageClaimId=${binding.lineageClaimId}${ownerQuery}`
      : `/sync/live/${routeKind}?session=${session}`;
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}${target}`,
      owner && !token ? ["dohc-live-v1"] : ["dohc-live-v1", `dohc-live-ticket.${token}`],
      {
        headers: desktop
          ? { host: relayHost, authorization: "Bearer reader-token", ...extra }
          : owner
            ? { host: relayHost, authorization: "Bearer owner-token", ...extra }
            : {
                host: relayHost,
                origin: audience,
                "x-dohc-relay-exchange-key": exchangeKey,
                ...(cookie ? { cookie } : {}),
                ...linkHeaders,
                ...extra,
              },
        perMessageDeflate: false,
      },
    );
    sockets.push(ws);
    ws.on("error", () => undefined);
    const received: LiveFrame[] = [],
      watchers = new Set<() => void>();
    ws.on("message", (bytes) => {
      received.push(decodeLiveFrame(Buffer.from(bytes as Buffer), frames.receive.maxFrameBytes));
      for (const notify of watchers) notify();
    });
    const status = new Promise<number>((done) => {
      ws.once("open", () => done(101));
      ws.once("error", () => done(0));
      ws.once("unexpected-response", (_request, response) => {
        response.resume();
        done(response.statusCode!);
        ws.terminate();
      });
    });
    function until(condition: () => boolean, expected = "the expected frame") {
      if (condition()) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const clear = () => {
          watchers.delete(notify);
          ws.off("close", close);
          ws.off("error", error);
        };
        const notify = () => {
          if (condition()) {
            clear();
            resolve();
          }
        };
        const close = (code: number, reason: Buffer) => {
          clear();
          reject(new Error(`Live socket closed before ${expected}: ${code} ${reason.toString()}`));
        };
        const error = (cause: Error) => {
          clear();
          reject(new Error(`Live socket failed before ${expected}`, { cause }));
        };
        if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          reject(new Error(`Live socket closed before ${expected}`));
          return;
        }
        watchers.add(notify);
        ws.once("close", close);
        ws.once("error", error);
      });
    }
    const closed = new Promise<[number, string]>((resolve) =>
      ws.once("close", (code, reason) => resolve([code, reason.toString()])),
    );
    return { ws, status, received, until, closed };
  }
  async function peer(person: number, document: number) {
    const grantId = link ? scope.grantId : "edit-" + person,
      cookie = "account=reader-" + person;
    const profile = Buffer.alloc(32, person).toString("base64url"),
      bearer = Buffer.alloc(32, person).toString("base64url");
    const headers: Record<string, string> = link
      ? { authorization: `LinkCapability ${bearer}`, "x-dohc-link-profile-secret": profile }
      : {};
    const bootstrap = link
      ? Response.json({ discriminator })
      : await post("/sync/live/named-sessions", { grantId }, cookie);
    expect(bootstrap.status).toBe(200);
    const session = ((await bootstrap.json()) as { discriminator: string }).discriminator;
    return {
      async mint() {
        if (!link)
          expect(
            await application.resolveNamedBrowserSession(
              new Request("https://relay.example.test", { headers: { cookie } }),
              session,
            ),
          ).toEqual({ ...scope, grantId, userId: "reader-" + person });
        const context =
          currentScope.kind === "link"
            ? {
                ...currentScope,
                sessionId: "link-session-" + person,
                capabilityHash: hashLinkBearer(bearer, key),
                profileTokenHash: hashLinkProfileSecret(profile, key),
              }
            : { ...scope, grantId, userId: "reader-" + person };
        expect(
          state.storage.resolveLiveObjectHostBinding(context, "object-" + document),
        ).toMatchObject({
          kind: "current",
          binding: {
            ...binding,
            objectId: "object-" + document,
            currentPath: `docs/${document}.md`,
            selectorPaths: [`docs/${document}.md`],
          },
        });
        const response = await post(
          `/sync/live/${routeKind}-tickets`,
          { discriminator: session, objectId: "object-" + document },
          cookie,
          headers,
        );
        expect(response.status).toBe(200);
        return (await response.json()) as { token: string };
      },
      connect: (token: string) => connect(token, cookie, headers, "", session),
    };
  }
  const useCredentials = (headers = holderHeaders) => {
    linkHeaders = headers;
  };
  return {
    ...state,
    frames,
    binding,
    post,
    discriminator,
    mint,
    connect,
    peer,
    currentScope,
    bearer,
    profile,
    memberships,
    tickets,
    captureNative,
    native,
    changes,
    invalidated,
    actor,
    accountSession,
    sessionRows,
    readSessions,
    port,
    application,
    routes,
    desktopAdmission,
    sessionHostBlocked,
    useCredentials,
  };
}

export async function openProductionSync(
  f: Awaited<ReturnType<typeof fixture>>,
  socket: ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>,
  credit = true,
) {
  await vi.waitFor(
    () => {
      expect(socket.ws.readyState).toBe(WebSocket.OPEN);
      expect(socket.received.map((frame) => frame.kind)).toContain("credit");
    },
    { timeout: 5000 },
  );
  const send = (frame: LiveFrame) =>
    socket.ws.send(encodeLiveFrame(frame, f.frames.receive.maxFrameBytes));
  send({ kind: "hello", receivePolicy: f.frames.receive });
  if (credit)
    send({
      kind: "credit",
      grantedBytes: f.frames.maxQueuedBytes,
      grantedFrames: f.frames.maxQueuedFrames,
    });
  const vector = Uint8Array.of(0);
  send({
    kind: "begin",
    purpose: "client-vector",
    transferId: 1,
    totalBytes: vector.length,
    digest: createHash("sha256").update(vector).digest("hex"),
  });
  send({ kind: "chunk", transferId: 1, offset: 0, bytes: vector });
  if (credit)
    await vi.waitFor(
      () => {
        expect(socket.ws.readyState).toBe(WebSocket.OPEN);
        expect(socket.received.map((frame) => frame.kind)).toContain("chunk");
      },
      { timeout: 5000 },
    );
  if (credit) send({ kind: "sync-applied", appliedThroughJournalCursor: 0 });
}
