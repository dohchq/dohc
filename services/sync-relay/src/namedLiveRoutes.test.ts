import { LIVE_CONNECTION_LIMIT_CLOSE_CODE } from "@dohc/live-session-contract/live-connection";
import { selfHostLiveProfile } from "./selfHostLiveProfile";
import { createNamedDesktopLive } from "./namedDesktopLive";
import { createLiveConnectionAdmission } from "./liveConnectionAdmission";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serveFetchHandler } from "@dohc/service-http";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import {
  LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES,
  createLiveFrameSession,
  decodeLiveFrame,
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
import { createNamedLiveProvider } from "@dohc/ydoc-projection/named-live-provider";
import { createLiveMembershipRegistry, type LiveMembershipPolicy } from "./liveMembership.js";
import { liveBrowserActor } from "./liveBrowserContext.js";
import { captureNamedLiveFrameHost } from "./namedLiveFrameHost.js";
import { createLiveTickets } from "./liveTickets.js";
import { createLiveHostReports } from "./namedLiveHostReports.js";
import { createNamedFrameChanges, type NamedFrameNativeHost } from "./namedLiveFrameHost.js";
import {
  fixture as ticketFixture,
  audience,
  binding,
  host,
  key,
  scope,
  seedLinkAgent,
} from "./liveTickets.test-helper.js";
import type { LiveUpdateJournalCut } from "./storage/types.js";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { linkRefusalBody } from "@dohc/security-contract/link-refusal";

const exchangeKey = "test-exchange-key-".repeat(3),
  relayHost = "relay.example.test";
const frames = {
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
const bounds = {
  maxClientVectorBytes: 1024,
  maxSyncOutputBytes: 4096,
  maxAppliedUpdateBytes: 4096,
  maxSubmissionBytes: 4096,
  maxAdmissionBytes: 16384,
};
const policy = {
  maxStructVisits: 10000,
  maxValueNodeVisits: 10000,
  maxDecodedPayloadByteVisits: 1000000,
  maxStructClientGroupVisits: 10000,
  maxDeleteClientGroupVisits: 10000,
  maxDeleteIntervalVisits: 10000,
  maxIndexOperations: 100000,
};
const limits: NamedLiveRouteLimits = {
  maxConnections: 8,
  maxConnectionsPerWorkspace: 96,
  reservedOwnerConnections: 0,
  maxConnectionsPerSession: 2,
  maxConnectionsPerPrincipal: 3,
  maxConnectionsPerGrant: 4,
  maxBufferedBytes: 134217728,
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
const cleanups: (() => Promise<void>)[] = [];

it("refuses desktop cross-account, scope, Origin, cookie, and host changes", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const body = { shareId: scope.shareId, path: binding.currentPath };
  for (const headers of [
    { authorization: "Bearer other-token" },
    { origin: "https://evil.test" },
    { cookie: "account=reader" },
    { host: "evil.test" },
  ] as Record<string, string>[]) {
    expect((await f.post("/sync/live/desktop-open", body, "", headers)).status).toBe(404);
  }
  for (const path of ["other/a.md", "docs/missing.md", "docs/a.excalidraw", "../docs/a.md"]) {
    expect((await f.post("/sync/live/desktop-open", { ...body, path })).status).toBe(404);
  }
  const ticket = await f.mint();
  expect(
    await f.connect(ticket.token, "", { authorization: "Bearer other-token" }).status,
  ).not.toBe(101);
  expect(await f.connect(ticket.token, "", { origin: "https://evil.test" }).status).not.toBe(101);
  expect(await f.connect(ticket.token, "", { cookie: "account=reader" }).status).not.toBe(101);
  expect(await f.connect(ticket.token).status).toBe(101);
});

it("finishes a desktop open started during reconnect after one host readiness wake", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  f.captureNative.mockRejectedValue(new Error("Host reconnecting."));
  const mint = vi.spyOn(f.tickets, "mint");
  const waiting = f.post("/sync/live/desktop-open", {
    shareId: scope.shareId,
    path: binding.currentPath,
  });
  await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
  f.captureNative.mockResolvedValue(f.native);
  f.changes.notifyHost([binding.workspaceId]);
  const response = await waiting;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    objectId: binding.objectId,
    path: binding.currentPath,
    ticket: { token: expect.any(String) },
  });
  expect(mint).toHaveBeenCalledTimes(2);
  expect(f.changes.listenerCount()).toBe(0);
});

function readinessRequest(user = "reader", path = binding.currentPath) {
  return new Request(`https://${relayHost}/sync/live/desktop-ready`, {
    method: "POST",
    headers: {
      host: relayHost,
      authorization: `Bearer ${user}-token`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ shareId: scope.shareId, path }),
  });
}

it("caps readiness per authenticated user and frees that user's slot on cancel", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const mint = vi.spyOn(f.tickets, "mint").mockResolvedValue(null);
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    for (let index = 0; index < 4; index++) {
      const reader = (await f.desktopAdmission!.handle(readinessRequest())).body!.getReader();
      readers.push(reader);
      await reader.read();
    }
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(4));
    expect(await (await f.desktopAdmission!.handle(readinessRequest())).text()).toBe(
      "waiting\nunavailable\n",
    );
    expect(mint).toHaveBeenCalledTimes(4);
    await readers.shift()!.cancel();
    const replacement = (await f.desktopAdmission!.handle(readinessRequest())).body!.getReader();
    readers.push(replacement);
    await replacement.read();
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(5));
  } finally {
    await Promise.all(readers.map((reader) => reader.cancel()));
  }
});

it("rechecks access and releases a waiting readiness subscription on cancellation", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const mint = vi.spyOn(f.tickets, "mint").mockResolvedValue(null);
  const request = () =>
    new Request(`https://${relayHost}/sync/live/desktop-ready`, {
      method: "POST",
      headers: {
        host: relayHost,
        authorization: "Bearer reader-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ shareId: scope.shareId, path: binding.currentPath }),
    });
  const cancelled = (await f.desktopAdmission!.handle(request())).body!.getReader();
  await cancelled.read();
  await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
  await cancelled.cancel();
  const reader = (await f.desktopAdmission!.handle(request())).body!.getReader();
  await reader.read();
  await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(2));
  f.raw.prepare("UPDATE sync_relay_share_grants SET access='view'").run();
  f.changes.notify(binding);
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("unavailable\n");
  expect((await reader.read()).done).toBe(true);
  expect(mint).toHaveBeenCalledTimes(2);
});

afterEach(async () => {
  const owned = cleanups.splice(0).reverse();
  vi.restoreAllMocks();
  for (const cleanup of owned) await cleanup();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const defaultScope = scope,
  defaultBinding = binding,
  defaultFrames = frames,
  defaultBounds = bounds;
async function fixture(
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
  const sessionHostBlocked = vi.fn((_document: { workspaceId: string; objectId: string }) => false);
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
        publicOrigin: audience,
        hosts: new Set([relayHost]),
        tickets,
        changes,
        limits: {
          maxSessions: 10,
          retentionMs: 60000,
          maxPendingRequests: 4,
          maxRequestBytes: 16384,
          maxResponseBytes: 16384,
          timeoutMs: 1000,
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
        resolveActor: actor,
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
  ) {
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest(
        `http://127.0.0.1:${port}${path}`,
        {
          method: "POST",
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
      owner ? ["dohc-live-v1"] : ["dohc-live-v1", `dohc-live-ticket.${token}`],
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
    application,
    routes,
    desktopAdmission,
    sessionHostBlocked,
    useCredentials,
  };
}

it.each([false, true])(
  "refuses a ticket for a document the session host blocked until the block lifts; link=%s",
  async (link) => {
    const f = await fixture(limits, link);
    const mint = vi.spyOn(f.tickets, "mint");
    f.sessionHostBlocked.mockReturnValue(true);
    const refused = await f.post(`/sync/live/${link ? "link" : "named"}-tickets`, {
      discriminator: f.discriminator,
      objectId: binding.objectId,
    });
    expect([refused.status, await refused.json()]).toEqual(
      link
        ? [503, linkRefusalBody("link_live_unavailable")]
        : [404, { ok: false, error: "not found" }],
    );
    expect(f.sessionHostBlocked).toHaveBeenCalledWith({
      workspaceId: binding.workspaceId,
      objectId: binding.objectId,
    });
    expect(mint).not.toHaveBeenCalled();
    if (link) {
      const hidden = await f.post("/sync/live/link-tickets", {
        discriminator: f.discriminator,
        objectId: "hidden-object",
      });
      expect([hidden.status, await hidden.text()]).toEqual([
        404,
        '{"ok":false,"error":"not found"}',
      ]);
    }
    f.sessionHostBlocked.mockReturnValue(false);
    expect(await f.connect((await f.mint()).token).status).toBe(101);
  },
);

// Tabs that keep reconnecting fill a caller's share of tickets until those tickets expire.
it.each([false, true])(
  "asks a link holder to try again while its share of tickets is full; link=%s",
  async (link) => {
    const f = await fixture(limits, link);
    const ask = async () => {
      const response = await f.post(`/sync/live/${link ? "link" : "named"}-tickets`, {
        discriminator: f.discriminator,
        objectId: binding.objectId,
      });
      return [response.status, await response.json()];
    };
    expect((await ask())[0]).toBe(200);
    expect((await ask())[0]).toBe(200);
    expect(await ask()).toEqual(
      link
        ? [503, linkRefusalBody("link_live_unavailable")]
        : [404, { ok: false, error: "not found" }],
    );
  },
);

it.each([false, true])(
  "mints through actual HTTP auth and redeems once before exposing only live frames; link=%s",
  async (link) => {
    const f = await fixture(limits, link),
      minted = await f.mint();
    expect(Object.keys(minted).sort()).toEqual(
      link ? ["expiresAtMs", "publicPrincipalId", "token"] : ["expiresAtMs", "token"],
    );
    if (link) {
      const publicId = minted.publicPrincipalId;
      expect(publicId).toMatch(/^public_/);
      expect(
        f.raw.prepare("SELECT public_principal_id FROM sync_relay_app_public_principals").get(),
      ).toEqual({ public_principal_id: publicId });
      expect((await f.mint()) as Record<string, unknown>).toMatchObject({
        publicPrincipalId: publicId,
      });
    }
    const browser = f.connect(minted.token);
    expect(await browser.status).toBe(101);
    await browser.until(() => browser.received.some((frame) => frame.kind === "welcome"));
    expect(browser.ws.protocol).toBe("dohc-live-v1");
    expect(browser.received[0]).toMatchObject({ kind: "welcome", hostEpoch: host.hostEpoch });
    expect(JSON.stringify(browser.received)).not.toContain("never-send-native-handle");
    expect(JSON.stringify(browser.received)).not.toContain("registrationId");
    expect(
      f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get(),
    ).toEqual({ redeemed_at_ms: 1000 });
    expect(await f.connect(minted.token).status).toBe(404);
  },
);

it.each(["anonymous", "account=other"])(
  "refuses %s on HTTP and WebSocket without consuming the valid ticket",
  async (cookie) => {
    const f = await fixture(),
      minted = await f.mint();
    expect(
      (
        await f.post(
          "/sync/live/named-tickets",
          { discriminator: f.discriminator, objectId: binding.objectId },
          cookie,
        )
      ).status,
    ).toBe(404);
    expect(await f.connect(minted.token, cookie).status).toBe(404);
    expect(
      f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get(),
    ).toEqual({ redeemed_at_ms: null });
    expect(await f.connect(minted.token).status).toBe(101);
  },
);

it.each(["grant", "fence", "host"])(
  "refuses a %s change between mint and upgrade",
  async (changed) => {
    const f = await fixture(),
      minted = await f.mint();
    if (changed === "grant")
      f.raw.exec("UPDATE sync_relay_share_grants SET generation=generation+1");
    if (changed === "fence")
      f.raw.exec(
        "UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1",
      );
    if (changed === "host") f.invalidated.abort();
    expect(await f.connect(minted.token).status).toBe(404);
  },
);

it.each<Record<string, string>>([
  { origin: "https://foreign.example" },
  { "x-dohc-relay-exchange-key": "wrong" },
  { host: "foreign.example" },
])("rejects untrusted forwarded route headers %j", async (headers) => {
  const f = await fixture(),
    minted = await f.mint();
  expect(
    (
      await f.post(
        "/sync/live/named-tickets",
        { discriminator: f.discriminator, objectId: binding.objectId },
        "account=reader",
        headers,
      )
    ).status,
  ).toBe(404);
  expect(await f.connect(minted.token, "account=reader", headers).status).toBe(404);
  expect(f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get()).toEqual(
    { redeemed_at_ms: null },
  );
});

it("checks standing again when native capture finishes after a grant change", async () => {
  const f = await fixture(),
    minted = await f.mint(),
    entered = deferred<void>(),
    resume = deferred<void>();
  let calls = 0;
  f.captureNative.mockImplementation(async () => {
    if (++calls === 2) {
      entered.resolve();
      await resume.promise;
    }
    return f.native;
  });
  const browser = f.connect(minted.token);
  await entered.promise;
  f.raw.exec("UPDATE sync_relay_share_grants SET generation=generation+1");
  resume.resolve();
  expect(await browser.status).toBe(404);
  expect(f.native.client.openLiveAppliedSync).not.toHaveBeenCalled();
});

it("never accepts browser identity fields or mismatched trusted share scope", async () => {
  const f = await fixture();
  expect(
    (
      await f.post("/sync/live/named-tickets", {
        discriminator: f.discriminator,
        objectId: binding.objectId,
        userId: scope.userId,
      })
    ).status,
  ).toBe(404);
  expect(
    f.storage.resolveLiveObjectHostBinding({ ...scope, shareId: "other-share" }, binding.objectId),
  ).toMatchObject({ kind: "refused", reason: "not-authorized" });
  expect(f.storage.resolveLiveObjectHostBinding(scope, "missing-object")).toMatchObject({
    kind: "refused",
    reason: "stale-document",
  });
  expect(f.captureNative).not.toHaveBeenCalled();
});

it("keeps a link socket through bearer refresh and closes it on revocation", async () => {
  const f = await fixture(limits, true),
    minted = await f.mint(),
    browser = f.connect(minted.token);
  expect(await browser.status).toBe(101);
  await browser.until(() => browser.received.some((frame) => frame.kind === "welcome"));
  const principal = f.raw
    .prepare("SELECT principal_id,display_name FROM sync_relay_link_principals")
    .get()!;
  expect(principal.display_name).toBeNull();
  const serialized = JSON.stringify({
    frames: browser.received,
    ticket: f.raw.prepare("SELECT * FROM sync_relay_live_session_tickets").get(),
  });
  for (const secret of [
    f.bearer,
    f.profile,
    hashLinkBearer(f.bearer, key),
    hashLinkProfileSecret(f.profile, key),
  ])
    expect(serialized).not.toContain(secret);
  const old = f.storage.findLinkSessionByCapabilityHash(hashLinkBearer(f.bearer, key))!;
  expect(
    f.storage.replaceLinkSession({
      currentSession: old,
      session: {
        sessionId: old.sessionId,
        capabilityHash: hashLinkBearer("fresh", key),
        grantId: old.grantId,
        generation: old.generation,
        mintedAtMs: 1000,
        expiresAtMs: 70_000,
      },
      guard() {},
    }),
  ).toBe(true);
  f.changes.notify();
  expect(f.storage.findLinkSessionByCapabilityHash(old.capabilityHash)).toBeNull();
  expect(
    (
      await f.post("/sync/live/link-tickets", {
        discriminator: f.discriminator,
        objectId: binding.objectId,
      })
    ).status,
  ).toBe(404);
  const pong = once(browser.ws, "pong");
  browser.ws.ping("still-connected");
  await pong;
  const { provider, until } = await startProvider(browser);
  await until(() => provider.state().status === "live");
  expect(provider.state().binding?.workspaceId).toBe(`link:${scope.grantId}`);
  const closed = once(browser.ws, "close");
  f.storage.revokeShareGrant({ shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 1001 });
  f.changes.notify();
  await closed;
  expect(f.invalidated.signal.aborted).toBe(false);
  expect(
    f.raw.prepare("SELECT link_session_id FROM sync_relay_live_session_tickets").get(),
  ).toEqual({ link_session_id: old.sessionId });
});

/** Sends one ping and reports whether its pong or the socket's close came first. */
async function pingOutcome(socket: ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>) {
  const pong = once(socket.ws, "pong").then(
    () => "pong",
    () => "error",
  );
  socket.ws.ping("keepalive");
  return Promise.race([pong, socket.closed.then(() => "closed")]);
}

it.each([false, true])(
  "keeps a share page editor open while its gateway pings and closes it once pings stop; link=%s",
  async (link) => {
    const routeLimits = { ...limits, idleTimeoutMs: 1000 };
    const f = await fixture(routeLimits, link),
      browser = f.connect((await f.mint()).token);
    expect(await browser.status).toBe(101);
    await browser.until(() => browser.received.some((frame) => frame.kind === "welcome"));
    // The gateway pings every half idle period; these come faster, for three idle periods.
    const opened = performance.now();
    while (performance.now() - opened < 3 * routeLimits.idleTimeoutMs) {
      expect(await pingOutcome(browser)).toBe("pong");
      await new Promise((resolve) => setTimeout(resolve, routeLimits.idleTimeoutMs / 5));
    }
    await browser.closed;
  },
);

it("closes a link editor on the gateway's first ping after its link session expires", async () => {
  const f = await fixture(limits, true),
    browser = f.connect((await f.mint()).token);
  expect(await browser.status).toBe(101);
  await browser.until(() => browser.received.some((frame) => frame.kind === "welcome"));
  expect(await pingOutcome(browser)).toBe("pong");
  // The fixture's link session expires at 61 s.
  vi.mocked(Date.now).mockReturnValue(61_000);
  expect(await pingOutcome(browser)).toBe("closed");
});

it.each<Record<string, string>>([
  { authorization: "" },
  { "x-dohc-link-profile-secret": "" },
  { "x-dohc-link-profile-secret": Buffer.alloc(32, 9).toString("base64url") },
  { origin: "https://other.example" },
  { host: "other.example" },
  { "x-dohc-relay-exchange-key": "forged" },
])(
  "refuses invalid private link credentials and origin without consuming a ticket: %j",
  async (headers) => {
    const f = await fixture(limits, true),
      minted = await f.mint();
    expect(
      (
        await f.post(
          "/sync/live/link-tickets",
          { discriminator: f.discriminator, objectId: binding.objectId },
          "anonymous",
          headers,
        )
      ).status,
    ).toBe(404);
    expect(await f.connect(minted.token, "anonymous", headers).status).toBe(404);
    expect(
      f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get(),
    ).toEqual({ redeemed_at_ms: null });
    expect(await f.connect(minted.token, "anonymous").status).toBe(101);
  },
);

// A connected agent opens the link's live documents through the same ticket
// and socket routes, with its access token and the MCP address it signed in at.
type LinkFixture = Awaited<ReturnType<typeof fixture>>;
// The agent signed in nearly an hour ago: its token expires before a link holder's session (61 s).
const agentExpiresAtMs = 2000;
function linkAgent(f: LinkFixture, connectionId = "agent-connection") {
  const { workspaceId, shareId, grantId } = f.currentScope;
  return seedLinkAgent(f.raw, {
    connectionId,
    workspaceId,
    shareId,
    grantId,
    generation: 4,
    expiresAtMs: agentExpiresAtMs,
  });
}
const liveDocument = {
  workspaceId: binding.workspaceId,
  mainVersionId: "main",
  objectId: binding.objectId,
  lineageClaimId: binding.lineageClaimId,
};

it("refuses an agent's ticket for another MCP address, and a token for another link, without consuming its ticket", async () => {
  const f = await fixture(limits, true),
    agent = linkAgent(f);
  f.raw
    .exec(`INSERT INTO sync_relay_shares (share_id, workspace_id, granter_user_id, selector_json, created_at_ms)
      VALUES ('other-share', '${binding.workspaceId}', 'owner-1', '{"paths":["other"],"versionId":null}', 0);
    INSERT INTO sync_relay_share_grants (grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES ('other-grant', 'other-share', 'link', NULL, NULL, 'edit', 1, 'active', 0, NULL, NULL)`);
  const other = seedLinkAgent(f.raw, {
    connectionId: "other-connection",
    workspaceId: binding.workspaceId,
    shareId: "other-share",
    grantId: "other-grant",
    generation: 1,
    expiresAtMs: agentExpiresAtMs,
  });
  const elsewhere = { ...agent.headers, "x-dohc-agent-resource": `${audience}/mcp/s/elsewhere` };
  const ticket = { discriminator: f.discriminator, objectId: binding.objectId };
  for (const headers of [elsewhere, other.headers]) {
    f.useCredentials(headers);
    expect((await f.post("/sync/live/link-tickets", ticket)).status).toBe(404);
  }
  f.useCredentials(agent.headers);
  const minted = await f.mint();
  for (const headers of [elsewhere, other.headers]) {
    f.useCredentials(headers);
    expect(await f.connect(minted.token).status).toBe(404);
  }
  expect(f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get()).toEqual(
    { redeemed_at_ms: null },
  );
  f.useCredentials(agent.headers);
  expect(await f.connect(minted.token).status).toBe(101);
});

it("refuses an agent request that also sends a cookie, on the ticket and socket routes, without consuming its ticket", async () => {
  const f = await fixture(limits, true),
    agent = linkAgent(f);
  f.useCredentials(agent.headers);
  expect(
    (
      await f.post(
        "/sync/live/link-tickets",
        { discriminator: f.discriminator, objectId: binding.objectId },
        "account=reader",
      )
    ).status,
  ).toBe(404);
  const minted = await f.mint();
  expect(await f.connect(minted.token, "account=reader").status).toBe(404);
  expect(f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get()).toEqual(
    { redeemed_at_ms: null },
  );
  expect(await f.connect(minted.token).status).toBe(101);
});

it("closes only the disconnected agent's live session and keeps the holder's and another agent's open", async () => {
  const f = await fixture(limits, true),
    agent = linkAgent(f),
    staying = linkAgent(f, "staying-connection");
  const holder = f.connect((await f.mint()).token);
  expect(await holder.status).toBe(101);
  f.useCredentials(staying.headers);
  const kept = f.connect((await f.mint()).token);
  expect(await kept.status).toBe(101);
  f.useCredentials(agent.headers);
  const ended = f.connect((await f.mint()).token);
  expect(await ended.status).toBe(101);
  const closed = once(ended.ws, "close");
  expect(
    f.storage.disconnectAgentConnection({
      workspaceId: agent.workspaceId,
      shareId: agent.shareId,
      grantId: agent.grantId,
      connectionId: agent.connectionId,
      nowMs: 1001,
      guard: () => undefined,
    }),
  ).not.toBeNull();
  f.changes.notify();
  await closed;
  for (const socket of [holder, kept]) {
    const pong = once(socket.ws, "pong");
    socket.ws.ping("still-open");
    await pong;
  }
  expect(
    f.storage.resolveCurrentLiveDocumentBinding({ document: liveDocument, actor: staying.actor }),
  ).toMatchObject({ kind: "current" });
});

async function startProvider(browser: ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>) {
  const provider = createNamedLiveProvider({
    frames,
    maxPendingUpdateBytes: 4096,
    maxPendingUpdates: 4,
    maxDeliveryAttempts: 2,
  });
  const route = provider.connect({
    send: (bytes) =>
      new Promise<void>((resolve, reject) =>
        browser.ws.send(bytes, (error) => (error ? reject(error) : resolve())),
      ),
    close: () => browser.ws.terminate(),
  });
  const { encodeLiveFrame } = await import("@dohc/live-session-contract/live-frame");
  for (const frame of browser.received)
    void route.receive(encodeLiveFrame(frame, frames.receive.maxFrameBytes));
  browser.ws.on("message", (bytes) => {
    void route.receive(Buffer.from(bytes as Buffer));
  });
  const until = (check: () => boolean) =>
    check()
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const remove = provider.subscribe(() => {
            if (check()) {
              remove();
              resolve();
            }
          });
        });
  cleanups.push(async () => {
    provider.close();
    await route.settled();
    provider.doc.destroy();
  });
  await until(() => provider.state().membership !== null);
  return { provider, until };
}

async function namedMember(f: Awaited<ReturnType<typeof fixture>>) {
  f.storage.createShare({
    share: {
      shareId: "named-other-share",
      workspaceId: scope.workspaceId,
      granterUserId: "owner-1",
      selectorJson: JSON.stringify({ paths: [binding.currentPath], versionId: null }),
      createdAtMs: 1,
    },
    grant: {
      grantId: "named-other-grant",
      shareId: "named-other-share",
      principalKind: "user",
      principalUserId: scope.userId,
      principalEmail: null,
      access: "edit",
      generation: 1,
      status: "active",
      revokedAtMs: null,
      createdAtMs: 1,
      parentGrantId: null,
    },
  });
  const boot = await f.post(
    "/sync/live/named-sessions",
    { grantId: "named-other-grant" },
    "account=reader",
  );
  const { discriminator } = (await boot.json()) as { discriminator: string };
  const context = await f.application.resolveNamedBrowserSession(
    new Request("https://relay.example.test", { headers: { cookie: "account=reader" } }),
    discriminator,
  );
  if (!context) throw new Error("Named member authentication missing");
  const minted = await f.tickets.mint({ objectId: binding.objectId }, context),
    ticket = await f.tickets.redeem(minted!.token, context);
  if (!ticket) throw new Error("Named member ticket missing");
  const host = captureNamedLiveFrameHost({
    ticket,
    actor: liveBrowserActor(context),
    storage: f.storage,
    native: f.native,
    bounds,
    validate: ({ retainStateUpdate: _retainStateUpdate, ...input }) =>
      createLiveMarkdownJournalValidator(policy)(input),
  });
  const member = f.memberships.join({
    ticket,
    invalidated: host.invalidated,
    assertCurrent: host.assertCurrent,
  });
  cleanups.push(async () => {
    member.close();
    host.close();
  });
  return member;
}

it("shares authenticated named and link membership on the same path across grants and selectors", async () => {
  const f = await fixture(limits, true),
    minted = await f.mint(),
    browser = f.connect(minted.token);
  expect(await browser.status).toBe(101);
  const live = await startProvider(browser),
    named = await namedMember(f);
  await live.until(() => live.provider.state().membership?.members.length === 2);
  const first = live.provider.state().membership!;
  expect(named.snapshot(1024)).toEqual(first);
  expect(first.overflow).toBe(false);
  for (const secret of [scope.userId, scope.grantId, f.bearer, f.profile, "link-session"])
    expect(JSON.stringify(first)).not.toContain(secret);
  named.close();
  await live.until(() => live.provider.state().membership?.members.length === 1);
});

it("opens the owner bearer route without a recipient, browser cookie, ticket, or exchange key", async () => {
  const f = await fixture(limits, false, undefined, true);
  f.raw.exec("DELETE FROM sync_relay_share_grants");
  const client = f.connect("", "", { cookie: "account=reader" });
  expect(await client.status).toBe(101);
  await client.until(() => client.received.some((frame) => frame.kind === "welcome"));
  expect(client.received[0]).toMatchObject({ kind: "welcome", hostEpoch: host.hostEpoch });
  expect(f.actor.mock.calls[0]![0].headers.get("cookie")).toBeNull();
  expect(
    f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_session_tickets").get(),
  ).toEqual({ count: 0 });
});

it.each<Record<string, string>>([
  { authorization: "" },
  { authorization: "Bearer reader-token" },
  { origin: "https://foreign.example" },
  { host: "foreign.example" },
])("refuses unauthenticated, non-owner and foreign owner upgrades %j", async (headers) => {
  const f = await fixture(limits, false, undefined, true);
  expect(await f.connect("", "", headers).status).toBe(404);
  expect(f.captureNative).not.toHaveBeenCalled();
});

it.each(["owner", "fence"])(
  "rechecks owner %s standing after native capture awaits",
  async (changed) => {
    const f = await fixture(limits, false, undefined, true);
    f.captureNative.mockImplementationOnce(async () => {
      f.raw.exec(
        changed === "owner"
          ? "UPDATE sync_relay_workspaces SET owner_user_id='other'"
          : "UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1",
      );
      return f.native;
    });
    expect(await f.connect("").status).toBe(404);
  },
);

it("refuses a native capture for a different owner document", async () => {
  const f = await fixture(limits, false, undefined, true);
  f.captureNative.mockImplementationOnce(async () => ({
    ...f.native,
    binding: { ...f.native.binding, objectId: "other-object" },
  }));
  expect(await f.connect("").status).toBe(404);
  expect(f.native.client.openLiveAppliedSync).not.toHaveBeenCalled();
});

it.each([
  ["named", false, "docs/a.md", ["docs/a.md"]],
  ["link", true, "a.md", ["a.md"]],
] as const)(
  "closes a %s connection when its folder share narrows to the file, and reopening shows the new view",
  async (_kind, link, currentPath, selectorPaths) => {
    const f = await fixture(limits, link);
    f.raw
      .prepare("UPDATE sync_relay_shares SET selector_json=?")
      .run(JSON.stringify({ paths: ["docs"], versionId: null }));
    const first = f.connect((await f.mint()).token);
    expect(await first.status).toBe(101);
    const opened = await startProvider(first);
    await opened.until(() => opened.provider.state().status === "live");
    expect(opened.provider.state().binding).toMatchObject({
      currentPath: "docs/a.md",
      selectorPaths: ["docs"],
    });
    const closed = once(first.ws, "close");
    f.raw
      .prepare("UPDATE sync_relay_shares SET selector_json=?")
      .run(JSON.stringify({ paths: [binding.currentPath], versionId: null }));
    f.changes.notify();
    await closed;
    expect(f.native.invalidated.aborted).toBe(false);
    const second = f.connect((await f.mint()).token);
    expect(await second.status).toBe(101);
    const reopened = await startProvider(second);
    await reopened.until(() => reopened.provider.state().status === "live");
    expect(reopened.provider.state().binding).toMatchObject({
      currentPath,
      selectorPaths,
      objectId: binding.objectId,
    });
  },
);
it.each(["named", "link", "owner", "desktop"])(
  "deletion closes a running %s live connection",
  async (kind) => {
    const f = await fixture(
      limits,
      kind === "link",
      undefined,
      kind === "owner",
      kind === "desktop",
    );
    const minted = kind === "owner" ? { token: "" } : await f.mint();
    const connection = f.connect(minted.token);
    expect(await connection.status).toBe(101);
    const closed = once(connection.ws, "close");
    f.routes.deleteAccount("owner-1", [binding.workspaceId]);
    await closed;
    expect(connection.ws.readyState).toBe(WebSocket.CLOSED);
  },
);

it.each([
  ["maxConnections", "live_total_limit"],
  ["maxConnectionsPerWorkspace", "live_workspace_limit"],
  ["maxConnectionsPerGrant", "live_grant_limit"],
  ["maxConnectionsPerPrincipal", "live_person_limit"],
  ["maxConnectionsPerSession", "live_session_limit"],
] as const)(
  "names %s only after authenticating and redeeming an in-scope ticket",
  async (limit, code) => {
    const f = await fixture({ ...limits, [limit]: 1 });
    const first = f.connect((await f.mint()).token);
    expect(await first.status).toBe(101);
    const ticket = await f.mint();
    expect(await f.connect(ticket.token, "account=other").status).toBe(404);
    const refused = f.connect(ticket.token);
    expect(await refused.status).toBe(101);
    expect(await refused.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, code]);
    expect(f.captureNative).toHaveBeenCalledTimes(5);
  },
);

it("refuses aggregate frame pressure and releases it on close", async () => {
  const admission = createLiveConnectionAdmission();
  const f = await fixture(
    { ...limits, maxBufferedBytes: 10_000 },
    false,
    undefined,
    false,
    false,
    admission,
  );
  const socket = f.connect((await f.mint()).token);
  expect(await socket.status).toBe(101);
  await socket.until(() => socket.received.some((frame) => frame.kind === "credit"));
  const buffers = admission.buffers(10_000),
    release = buffers.reserve(9_990);
  const protocol = createLiveFrameSession("client", frames);
  for (const frame of socket.received)
    protocol
      .receive(
        (await import("@dohc/live-session-contract/live-frame")).encodeLiveFrame(
          frame,
          frames.receive.maxFrameBytes,
        ),
      )
      .release();
  const hello = protocol.send({ kind: "hello", receivePolicy: frames.receive });
  socket.ws.send(hello.value);
  hello.release();
  expect(await socket.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_buffer_limit"]);
  release();
  await vi.waitFor(() => expect(buffers.usage()).toBe(0));
  protocol.close();
});

it("charges WebSocket sends until their callback settles", async () => {
  const admission = createLiveConnectionAdmission(),
    f = await fixture(limits, false, undefined, false, false, admission);
  const ticket = await f.mint(),
    sent = deferred<void>();
  let callback: (() => void) | undefined,
    heldBytes = 0;
  const original = WebSocket.prototype.send;
  vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
    this: WebSocket,
    ...args: Parameters<WebSocket["send"]>
  ) {
    if (this.url === undefined) {
      const bytes = args[0];
      if (bytes instanceof Uint8Array) heldBytes = bytes.byteLength;
      const completed = args.at(-1);
      callback = () => {
        if (typeof completed === "function") completed();
      };
      sent.resolve();
      return;
    }
    original.apply(this, args);
  });
  const socket = f.connect(ticket.token);
  expect(await socket.status).toBe(101);
  await sent.promise;
  const buffers = admission.buffers(limits.maxBufferedBytes);
  try {
    expect(buffers.usage()).toBe(2 * heldBytes);
    socket.ws.terminate();
    await socket.closed;
    expect(buffers.usage()).toBe(2 * heldBytes);
  } finally {
    f.routes.close();
    callback?.();
  }
  await vi.waitFor(() => expect(buffers.usage()).toBe(0));
});

type ProductionPeer = {
  f: Awaited<ReturnType<typeof fixture>>;
  socket: ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>;
};

async function openProductionSync(
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

it.each([false, true])(
  "delivers one production-size 2 MiB edit to 22 readers of one document; link=%s",
  async (link) => {
    const profile = selfHostLiveProfile(),
      admission = createLiveConnectionAdmission();
    const readers: ProductionPeer[] = [];
    const sharedChanges = createNamedFrameChanges(128);
    let shared: NamedFrameNativeHost | undefined;
    for (let person = 1; person <= 22; person++) {
      const f = await fixture(
        profile.namedLive.transport,
        link,
        undefined,
        false,
        false,
        admission,
        person,
        1,
        true,
      );
      if (!shared) shared = { ...f.native, changes: sharedChanges };
      const native = shared;
      f.captureNative.mockImplementation(async () => native);
      const socket = f.connect((await f.mint()).token);
      expect(await socket.status).toBe(101);
      await openProductionSync(f, socket);
      readers.push({ f, socket });
    }
    const updateBytes = Buffer.alloc(profile.namedLive.host.maxAppliedUpdateBytes, 42);
    vi.mocked(shared!.client.readNextLiveApplied).mockImplementation(async (_request, after) =>
      after.eventCount
        ? null
        : {
            position: { eventCount: 1, journalCursor: 1, evidenceDigest: "cd".repeat(32) },
            updateBytes,
            ack: {
              deliveryId: "edit",
              updateDigest: createHash("sha256").update(updateBytes).digest("hex"),
              journalCursor: 1,
              acceptingHostEpoch: host.hostEpoch,
              localYDocSequence: 1,
              applicationReplayed: false,
            },
          },
    );
    await vi.waitFor(() => expect(sharedChanges.listenerCount()).toBe(44));
    sharedChanges.notify(readers[0]!.f.binding);
    await vi.waitFor(
      () => {
        expect(readers.map(({ socket }) => socket.ws.readyState)).toEqual(
          Array(22).fill(WebSocket.OPEN),
        );
        expect(
          readers.map(({ socket }) =>
            socket.received
              .filter((frame) => frame.kind === "chunk" && frame.transferId === 2)
              .reduce((sum, frame) => sum + (frame.kind === "chunk" ? frame.bytes.length : 0), 0),
          ),
        ).toEqual(Array(22).fill(updateBytes.length));
      },
      { timeout: 10_000 },
    );
    for (const { socket } of readers) {
      const chunks = socket.received.filter(
        (frame): frame is Extract<LiveFrame, { kind: "chunk" }> =>
          frame.kind === "chunk" && frame.transferId === 2,
      );
      expect(
        Buffer.concat(chunks.map((frame) => Buffer.from(frame.bytes))).equals(updateBytes),
      ).toBe(true);
    }
    expect(readers.every(({ socket }) => socket.ws.readyState === WebSocket.OPEN)).toBe(true);
    await vi.waitFor(() =>
      expect(admission.buffers(profile.namedLive.transport.maxBufferedBytes).usage()).toBe(0),
    );
  },
  60_000,
);

function submitUpdate(
  f: Awaited<ReturnType<typeof fixture>>,
  socket: ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>,
  deliveryId: string,
  transferId: number,
) {
  const updateBytes = Uint8Array.of(0, 0);
  socket.ws.send(
    encodeLiveFrame(
      {
        kind: "begin",
        purpose: "submit-update",
        deliveryId,
        transferId,
        totalBytes: updateBytes.length,
        digest: createHash("sha256").update(updateBytes).digest("hex"),
      },
      f.frames.receive.maxFrameBytes,
    ),
  );
  socket.ws.send(
    encodeLiveFrame(
      { kind: "chunk", transferId, offset: 0, bytes: updateBytes },
      f.frames.receive.maxFrameBytes,
    ),
  );
}

it("keeps another workspace's 4 MiB sync open while a nearly full workspace checks a large edit", async () => {
  const profile = selfHostLiveProfile(),
    limits = profile.namedLive.transport,
    admission = createLiveConnectionAdmission(),
    MiB = 1024 * 1024;
  const frameBudget = admission.buffers(limits.maxBufferedBytes),
    validationBudget = admission.validationBuffers(limits.maxBufferedBytes);
  const editor = await fixture(limits, true, undefined, false, false, admission, 1, 1, true);
  const editing = editor.connect((await editor.mint()).token);
  expect(await editing.status).toBe(101);
  await openProductionSync(editor, editing);
  const releaseFrames = frameBudget.reserve(76 * MiB, [
    [JSON.stringify(["workspace", scope.workspaceId]), 80 * MiB],
  ]);
  const checking = deferred<void>(),
    drained = deferred<void>(),
    updateBytes = Uint8Array.of(0, 0);
  vi.spyOn(editor.storage, "readLiveUpdateJournalCut").mockImplementation((_input, reserve) => {
    reserve!(50 * MiB);
    return {
      kind: "cut",
      cut: {
        checkpoint: { bytes: Uint8Array.of(0, 0) },
        suffix: [],
      } as unknown as LiveUpdateJournalCut,
    };
  });
  vi.spyOn(editor.storage, "commitLiveUpdateJournal").mockReturnValue({
    result: {
      kind: "accepted",
      receipt: {
        deliveryId: "large-edit",
        updateDigest: createHash("sha256").update(updateBytes).digest("hex"),
        journalCursor: 1,
        acceptingHostEpoch: host.hostEpoch,
      },
    },
  } as never);
  vi.mocked(editor.native.drain).mockImplementation(async () => {
    checking.resolve();
    await drained.promise;
  });
  try {
    submitUpdate(editor, editing, "large-edit", 2);
    await checking.promise;
    expect(frameBudget.usage() + validationBudget.usage()).toBeGreaterThanOrEqual(126 * MiB);
    const other = await fixture(
      limits,
      true,
      undefined,
      false,
      false,
      admission,
      2,
      1,
      true,
      "other-workspace",
    );
    vi.mocked(other.native.client.openLiveAppliedSync).mockResolvedValue({
      binding: { ...other.binding, selectorPaths: [other.binding.currentPath] },
      hostVector: Buffer.from([0]),
      missingStateUpdate: Buffer.alloc(4 * MiB - 1024),
      observedLocalYDocHeadSequence: 1,
      position: { eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32) },
    });
    const reader = other.connect((await other.mint()).token);
    expect(await reader.status).toBe(101);
    const before = frameBudget.usage();
    await openProductionSync(other, reader, false);
    await vi.waitFor(() =>
      expect(
        reader.ws.readyState === WebSocket.CLOSED || frameBudget.usage() > before + 4 * MiB - 2048,
      ).toBe(true),
    );
    expect(reader.ws.readyState).toBe(WebSocket.OPEN);
    const pong = once(reader.ws, "pong");
    reader.ws.ping("still-live");
    await pong;
    expect(reader.ws.readyState).toBe(WebSocket.OPEN);
    expect(editing.ws.readyState).toBe(WebSocket.OPEN);
    expect(validationBudget.usage()).toBeGreaterThanOrEqual(50 * MiB);
  } finally {
    drained.resolve();
    releaseFrames();
  }
  await vi.waitFor(() =>
    expect(editing.received).toContainEqual(
      expect.objectContaining({
        kind: "result",
        deliveryId: "large-edit",
        result: "retry",
        reason: "application-pending",
      }),
    ),
  );
  await vi.waitFor(() => expect(validationBudget.usage()).toBe(0));
}, 60_000);

it.each(["named", "owner", "link"])(
  "finally refuses a %s edit whose check can never fit the validation pool",
  async (kind) => {
    const profile = selfHostLiveProfile(),
      admission = createLiveConnectionAdmission(),
      limits = profile.namedLive.transport;
    const f = await fixture(
      limits,
      kind === "link",
      undefined,
      kind === "owner",
      false,
      admission,
      1,
      1,
      true,
    );
    const socket = f.connect(kind === "owner" ? "" : (await f.mint()).token);
    expect(await socket.status).toBe(101);
    await openProductionSync(f, socket);
    const read = vi
      .spyOn(f.storage, "readLiveUpdateJournalCut")
      .mockImplementation((_input, reserve) => {
        reserve!(limits.maxBufferedBytes - 6 + 1);
        throw new Error("The cut is read only after its check is reserved.");
      });
    submitUpdate(f, socket, "oversized", 2);
    await vi.waitFor(() =>
      expect(socket.received).toContainEqual(
        expect.objectContaining({
          kind: "result",
          deliveryId: "oversized",
          result: "refused",
          reason: "capacity-refused",
        }),
      ),
    );
    expect(read).toHaveBeenCalledOnce();
    expect(admission.validationBuffers(limits.maxBufferedBytes).usage()).toBe(0);
  },
);

it("returns only the named grant binding in live frames", async () => {
  const f = await fixture();
  const minted = await f.mint(),
    socket = f.connect(minted.token);
  expect(await socket.status).toBe(101);
  const { provider, until } = await startProvider(socket);
  await until(() => provider.state().status === "live");
  expect(provider.state().binding).toMatchObject({
    ...binding,
    workspaceId: `named:${scope.grantId}`,
    selectorPaths: ["docs"],
  });
  expect(JSON.stringify(provider.state().binding)).not.toContain(scope.workspaceId);
  expect(f.native.binding.workspaceId).toBe(scope.workspaceId);
});
it.each(["view", "comment"] as const)(
  "keeps %s recipients out of desktop admission and named live frames",
  async (access) => {
    const f = await fixture(limits, false, undefined, false, true),
      minted = await f.mint();
    f.raw.prepare("UPDATE sync_relay_share_grants SET access=?").run(access);
    const response = await f.post("/sync/live/desktop-open", {
      shareId: scope.shareId,
      path: binding.currentPath,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false });
    expect(await f.connect(minted.token).status).not.toBe(101);
    expect(f.native.client.openLiveAppliedSync).not.toHaveBeenCalled();
  },
);

// A link page stops editing on a 404 and tries again on a 503. Each of these answered 404 before.
describe("a link ticket while the relay is busy", () => {
  const tryAgain = [503, linkRefusalBody("link_live_unavailable")];
  const opaque = [404, { ok: false, error: "not found" }];
  const ask = async (f: LinkFixture) => {
    const response = await f.post("/sync/live/link-tickets", {
      discriminator: f.discriminator,
      objectId: binding.objectId,
    });
    return [response.status, await response.json()];
  };
  const unknownAgent = (agent: ReturnType<typeof linkAgent>) => ({
    ...agent.headers,
    authorization: `DohcAgent ${"Z".repeat(43)}`,
  });

  it("asks a holder to try again while the relay stops, and tells an agent nothing", async () => {
    const f = await fixture(limits, true),
      agent = linkAgent(f);
    f.routes.close();
    expect(await ask(f)).toEqual(tryAgain);
    f.useCredentials(agent.headers);
    expect(await ask(f)).toEqual(opaque);
  });

  it("asks a holder to try again while requests are full, and tells an agent nothing", async () => {
    const f = await fixture({ ...limits, upgradeTimeoutMs: 10_000 }, true),
      agent = linkAgent(f);
    let release!: () => void;
    const held = new Promise<null>((done) => {
      release = () => done(null);
    });
    const mint = vi.spyOn(f.tickets, "mint").mockImplementation(() => held);
    const waiting = Array.from({ length: limits.maxPendingRequests }, () => ask(f));
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(limits.maxPendingRequests));
    expect(await ask(f)).toEqual(tryAgain);
    f.useCredentials(agent.headers);
    expect(await ask(f)).toEqual(opaque);
    release();
    expect(await Promise.all(waiting)).toEqual(waiting.map(() => opaque));
  });

  it("asks a holder to try again when the live host reconnects during a ticket", async () => {
    const f = await fixture(limits, true);
    f.invalidated.abort();
    expect(await ask(f)).toEqual(tryAgain);
  });

  it("asks a holder to try again when the live host goes away during a ticket", async () => {
    const f = await fixture(limits, true);
    f.captureNative.mockImplementationOnce(async () => {
      f.raw.exec(
        "BEGIN IMMEDIATE; UPDATE sync_relay_session_host_control SET admission_state='closed', registered_connection_id=NULL; COMMIT",
      );
      return f.native;
    });
    expect(await ask(f)).toEqual(tryAgain);
  });

  it.each(["linkDiscussionPrincipalLimit", "workspaceQuotaBytes"] as const)(
    "stops a new holder that %s turns away",
    async (limit) => {
      const f = await fixture(limits, true);
      // The storage context holds its limits here; the public storage type does not show them.
      (f.storage as unknown as { options: Record<typeof limit, number> }).options[limit] = 0;
      expect(await ask(f)).toEqual(opaque);
    },
  );

  // An agent enrolls elsewhere, so only the record of its public principal is new here.
  it("stops a link agent whose public principal a full workspace can't hold", async () => {
    for (const quota of [undefined, 0]) {
      const f = await fixture(limits, true);
      f.useCredentials(linkAgent(f).headers);
      if (quota !== undefined)
        (
          f.storage as unknown as { options: { workspaceQuotaBytes: number } }
        ).options.workspaceQuotaBytes = quota;
      const [status] = await ask(f);
      expect(status).toBe(quota === undefined ? 200 : 404);
    }
  });

  it("tells a caller with neither a capability nor an agent token nothing", async () => {
    const f = await fixture(limits, true);
    f.routes.close();
    f.useCredentials({});
    expect(await ask(f)).toEqual(opaque);
    f.useCredentials({ authorization: "Bearer something" });
    expect(await ask(f)).toEqual(opaque);
  });

  it("asks a holder to try again when a ticket takes too long", async () => {
    const f = await fixture(limits, true);
    vi.spyOn(f.tickets, "mint").mockImplementation(() => new Promise(() => {}));
    expect(await ask(f)).toEqual(tryAgain);
  });

  it("asks a known caller to try again when minting fails, and tells an unknown agent nothing", async () => {
    const f = await fixture(limits, true),
      agent = linkAgent(f);
    vi.spyOn(f.tickets, "mint").mockRejectedValue(new Error("Live-ticket operation failed."));
    expect(await ask(f)).toEqual(tryAgain);
    f.useCredentials(agent.headers);
    expect(await ask(f)).toEqual(tryAgain);
    f.useCredentials(unknownAgent(agent));
    expect(await ask(f)).toEqual(opaque);
  });
});
