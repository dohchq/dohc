import { afterEach, expect, it, vi } from "vitest";
import { decodeLiveFrameSync } from "@dohc/live-session-contract/live-frame";
import { createLinkLiveHttp } from "./linkLiveHttp";
import type { AwakeLiveState } from "./liveAwakeState";
import { linkRefusalBody } from "@dohc/security-contract/link-refusal";
import type { LiveNoteStanding, SessionHostBlock } from "./linkRefusal";
import { createLiveTickets } from "./liveTickets";
import { hashLinkBearer, hashLinkProfileSecret } from "./linkSecurity";
import {
  audience,
  binding,
  fixture as ticketFixture,
  holderLinkAuthority,
  key,
  report,
  scope,
  seedLinkAgent,
} from "./liveTickets.test-helper";
import { AGENT_ACCESS_TOKEN_TTL_MS } from "./storage/agentConnections";

const bearer = Buffer.alloc(32, 1).toString("base64url"),
  profile = Buffer.alloc(32, 2).toString("base64url");
const exchangeKey = "private-link-metadata-exchange-at-least-32",
  discriminator = "abcdefghijkl";
const limits = {
  maxConnections: 8,
  maxConnectionsPerWorkspace: 96,
  reservedOwnerConnections: 0,
  maxConnectionsPerSession: 2,
  maxConnectionsPerPrincipal: 3,
  maxConnectionsPerGrant: 4,
  maxBufferedBytes: 134217728,
  maxBufferedBytesPerPrincipal: 50331648,
  maxBufferedBytesPerShare: 67108864,
  maxBufferedBytesPerWorkspace: 134217728,
  maxPendingRequests: 4,
  maxRequestBytes: 4096,
  maxResponseBytes: 4096,
  maxPendingBytes: 4096,
  maxFragments: 8,
  maxBufferedChunks: 16,
  upgradeTimeoutMs: 1000,
  idleTimeoutMs: 5000,
  drainTimeoutMs: 100,
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(
  sessionHostBlocked?: (document: {
    workspaceId: string;
    objectId: string;
  }) => SessionHostBlock | undefined,
  state?: Pick<Parameters<typeof createLinkLiveHttp>[0], "readAwakeState" | "nowMs" | "liveNote">,
) {
  const f = await ticketFixture();
  cleanups.push(f.close);
  vi.spyOn(Date, "now").mockReturnValue(1000);
  // Synthetic private authority fixture. Public Edit creation/exchange remains closed.
  f.raw.exec("UPDATE sync_relay_share_grants SET principal_kind='link', principal_user_id=NULL");
  expect(
    f.storage.mintLinkSession({
      session: {
        sessionId: "link-session",
        capabilityHash: hashLinkBearer(bearer, key),
        grantId: scope.grantId,
        generation: 4,
        mintedAtMs: 999,
        expiresAtMs: 61_000,
      },
    }),
  ).toBe(true);
  const context = {
    kind: "link" as const,
    workspaceId: scope.workspaceId,
    shareId: scope.shareId,
    grantId: scope.grantId,
    sessionId: "link-session",
    capabilityHash: hashLinkBearer(bearer, key),
    profileTokenHash: hashLinkProfileSecret(profile, key),
  };
  const tickets = createLiveTickets({
    storage: f.storage,
    audience,
    key,
    hostReports: { currentBinding: async () => report },
  });
  const linkAuthority = holderLinkAuthority(f.storage, key, exchangeKey);
  const handle = createLinkLiveHttp({
    publicEditRelease: { version: 1 },
    storage: f.storage,
    linkKey: key,
    hosts: new Set(["relay.test"]),
    publicOrigin: audience,
    exchangeKey,
    limits: state ? { ...limits, maxPendingRequests: 16 } : limits,
    sessionHostBlocked,
    linkAuthority,
    ...(state ? { ...state, frames } : {}),
  });
  return { ...f, context, tickets, handle };
}
const frames = {
  maxFrameBytes: 64 * 1024,
  maxStateVectorBytes: 128 * 1024,
  maxUpdateBytes: 2 * 1024 * 1024,
  maxSyncBytes: 4 * 1024 * 1024,
};
function request(
  body: unknown = { discriminator, path: binding.currentPath },
  path = "/sync/live/link-document",
  headers: Record<string, string> = {},
) {
  return new Request(`https://relay.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      host: "relay.test",
      origin: audience,
      "content-type": "application/json",
      "x-dohc-relay-exchange-key": exchangeKey,
      authorization: `LinkCapability ${bearer}`,
      "x-dohc-link-profile-secret": profile,
      ...headers,
    },
  });
}
function agentRequest(
  agent: ReturnType<typeof seedLinkAgent>,
  body: unknown = { discriminator, path: binding.currentPath },
  path = "/sync/live/link-document",
  headers: Record<string, string> = {},
) {
  return new Request(`https://relay.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      host: "relay.test",
      origin: audience,
      "content-type": "application/json",
      "x-dohc-relay-exchange-key": exchangeKey,
      ...agent.headers,
      ...headers,
    },
  });
}
it("finds a document for a connected agent, and never opens a browser gateway session for one", async () => {
  const f = await fixture(),
    handle = f.handle;
  const agent = seedLinkAgent(f.raw, {
    connectionId: "agent-connection",
    workspaceId: scope.workspaceId,
    shareId: scope.shareId,
    grantId: scope.grantId,
    generation: 4,
    expiresAtMs: 1000 + AGENT_ACCESS_TOKEN_TTL_MS,
  });
  expect(await (await handle(agentRequest(agent))).json()).toEqual({ objectId: binding.objectId });
  expect(await (await handle(request())).json()).toEqual({ objectId: binding.objectId });
  for (const authorization of [`Bearer ${bearer}`, `DohcAgent ${bearer}`])
    expect((await handle(request(undefined, undefined, { authorization }))).status).toBe(404);
  const refused: Record<string, string>[] = [
    { "x-dohc-agent-resource": `${audience}/mcp/s/elsewhere` },
    { "x-dohc-link-profile-secret": profile },
    { cookie: "account=reader" },
  ];
  for (const headers of refused)
    expect((await handle(agentRequest(agent, undefined, undefined, headers))).status).toBe(404);
  expect(
    (await handle(agentRequest(agent, { discriminator }, "/sync/live/link-session"))).status,
  ).toBe(404);
  vi.mocked(Date.now).mockReturnValue(agent.expiresAtMs);
  expect((await handle(agentRequest(agent))).status).toBe(404);
});

it("derives gateway authority only after ticket enrollment and refuses a different profile", async () => {
  const f = await fixture();
  const resolve = () => f.handle(request({ discriminator }, "/sync/live/link-session"));
  expect((await resolve()).status).toBe(404);
  expect(await f.tickets.mint({ objectId: binding.objectId }, f.context)).not.toBeNull();
  const value = await (await resolve()).json();
  expect(value).toEqual({
    kind: "link",
    workspaceId: scope.workspaceId,
    shareId: scope.shareId,
    grantId: scope.grantId,
    sessionId: "link-session",
    principalId: f.storage.getLinkPrincipalForGrantProfile(
      scope.grantId,
      f.context.profileTokenHash,
    )!.principalId,
  });
  const other = Buffer.alloc(32, 3).toString("base64url");
  expect(
    (
      await f.handle(
        request({ discriminator }, "/sync/live/link-session", {
          "x-dohc-link-profile-secret": other,
        }),
      )
    ).status,
  ).toBe(404);
  for (const secret of [bearer, profile, f.context.capabilityHash, f.context.profileTokenHash])
    expect(JSON.stringify(value)).not.toContain(secret);
});
it.each([
  { origin: "https://foreign.test" },
  { host: "foreign.test" },
  { "x-dohc-relay-exchange-key": "wrong" },
  { authorization: "" },
  { "x-dohc-link-profile-secret": "" },
] as Record<string, string>[])(
  "refuses missing or mismatched private authority %j",
  async (headers) => {
    const f = await fixture();
    expect((await f.handle(request(undefined, undefined, headers))).status).toBe(404);
  },
);

it.each(["revoked", "expired", "pinned"])(
  "refuses current authority after %s transition",
  async (mode) => {
    const f = await fixture();
    if (mode === "revoked")
      f.storage.revokeShareGrant({
        shareId: scope.shareId,
        grantId: scope.grantId,
        revokedAtMs: 1000,
      });
    if (mode === "expired") vi.mocked(Date.now).mockReturnValue(61_000);
    if (mode === "pinned")
      f.raw
        .prepare("UPDATE sync_relay_shares SET selector_json=?")
        .run(JSON.stringify({ paths: ["docs"], versionId: "side" }));
    const response = await f.handle(request());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"ok":false,"error":"not found"}');
  },
);

it.each(["view"] as const)(
  "explains %s access only for an existing file in scope",
  async (access) => {
    const f = await fixture();
    f.raw.prepare("UPDATE sync_relay_share_grants SET access=?").run(access);
    const response = await f.handle(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      linkRefusalBody(access === "view" ? "link_view_access" : "link_comment_access"),
    );
    for (const path of ["private/a.md", "docs/missing.md", "../docs/a.md"]) {
      const refused = await f.handle(request({ discriminator, path }));
      expect([refused.status, await refused.text()]).toEqual([
        404,
        '{"ok":false,"error":"not found"}',
      ]);
    }
  },
);

it.each([
  ["stopped", "link_live_unavailable"],
  ["held", "link_live_stopped"],
] as const)(
  "explains a document the session host blocked (%s) as %s until the block lifts",
  async (block, code) => {
    let blocked: SessionHostBlock | undefined = block;
    const asked: { workspaceId: string; objectId: string }[] = [];
    const f = await fixture((document) => {
      asked.push(document);
      return blocked;
    });
    const response = await f.handle(request());
    expect([response.status, await response.json()]).toEqual([503, linkRefusalBody(code)]);
    expect(asked).toEqual([{ workspaceId: scope.workspaceId, objectId: binding.objectId }]);
    const hidden = await f.handle(request({ discriminator, path: "private/a.md" }));
    expect([hidden.status, await hidden.text()]).toEqual([404, '{"ok":false,"error":"not found"}']);
    blocked = undefined;
    expect(await (await f.handle(request())).json()).toEqual({ objectId: binding.objectId });
  },
);

// Moving a note's file ends its binding, and the room pauses the note. Only the owner can start it again.
it("tells a holder a held note whose file moved stopped, not to try again", async () => {
  let blocked: SessionHostBlock | undefined;
  const f = await fixture(() => blocked, { readAwakeState: async () => undefined });
  f.raw
    .prepare(
      `INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, blob_sha256, content_kind, byte_length, recorded_at_ms)
      VALUES (?, ?, 99, 'moved', 'main', 'docs/moved.md', ?, 'text', 1, 2)`,
    )
    .run(scope.workspaceId, binding.objectId, "b".repeat(64));
  const ask = async (route?: string) => {
    const response = await f.handle(request({ discriminator, path: "docs/moved.md" }, route));
    return [response.status, await response.json()];
  };
  // Before the pause, the holder may try again: the owner's desktop can host the note at its new path.
  expect(await ask()).toEqual([503, linkRefusalBody("link_live_unavailable")]);
  blocked = "held";
  for (const route of ["/sync/live/link-document", "/sync/live/link-document-state"])
    expect(await ask(route)).toEqual([503, linkRefusalBody("link_live_stopped")]);
});

// A starting note opens for the holder, who waits on its tickets. An off note only its owner can start again.
it("opens a starting or off note with no state, so its ticket gives the answer", async () => {
  let blocked: SessionHostBlock | undefined,
    note: LiveNoteStanding | undefined = "starting";
  const f = await fixture(() => blocked, {
    readAwakeState: async () => undefined,
    liveNote: () => note,
  });
  f.raw
    .prepare(
      `INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, blob_sha256, content_kind, byte_length, recorded_at_ms)
      VALUES (?, ?, 99, 'moved', 'main', 'docs/moved.md', ?, 'text', 1, 2)`,
    )
    .run(scope.workspaceId, binding.objectId, "b".repeat(64));
  const ask = (route?: string) =>
    f.handle(request({ discriminator, path: "docs/moved.md" }, route));
  for (const [standing, block] of [
    ["starting", undefined],
    ["starting", "held"],
    ["off", undefined],
  ] as const) {
    note = standing;
    blocked = block;
    const opened = await ask();
    expect([opened.status, await opened.json()]).toEqual([200, { objectId: binding.objectId }]);
    expect((await ask("/sync/live/link-document-state")).status).toBe(204);
  }
  note = undefined;
  blocked = "held";
  const refused = await ask();
  expect([refused.status, await refused.json()]).toEqual([
    503,
    linkRefusalBody("link_live_stopped"),
  ]);
});

// A note whose record says live before its host serves it, or that its host won't start, answers before any ticket.
it("finds a bound note still starting for its page to wait on, and tells a holder one only its owner can start that it is off", async () => {
  let note: LiveNoteStanding | undefined;
  const f = await fixture(undefined, {
    readAwakeState: async () => undefined,
    liveNote: () => note,
  });
  const ask = async (route?: string) => {
    const response = await f.handle(request(undefined, route));
    return [response.status, await response.json().catch(() => null)];
  };
  expect(await ask()).toEqual([200, { objectId: binding.objectId }]);
  note = "starting";
  expect(await ask()).toEqual([200, { objectId: binding.objectId }]);
  expect(await ask("/sync/live/link-document-state")).toEqual([204, null]);
  note = "off";
  for (const route of ["/sync/live/link-document", "/sync/live/link-document-state"])
    expect(await ask(route)).toEqual([503, linkRefusalBody("link_live_stopped")]);
});

// A link reader's page asks for a note's state before it opens a socket, so it can show the note at once.
const stateRequest = (body?: unknown, headers?: Record<string, string>) =>
  request(body, "/sync/live/link-document-state", headers);
// What a host that holds the note awake answers: the state at journal cursor 5, from the host the relay names now.
async function awakeFixture(
  sessionHostBlocked?: Parameters<typeof fixture>[0],
  read?: (answer: AwakeLiveState) => Promise<AwakeLiveState | undefined>,
) {
  let now = 0;
  const reads: unknown[] = [];
  let answer!: AwakeLiveState;
  const f = await fixture(sessionHostBlocked, {
    nowMs: () => now,
    readAwakeState: async (value) => {
      reads.push(value);
      return read ? read(answer) : answer;
    },
  });
  const current = f.storage.resolveLiveObjectHostBinding(f.context, binding.objectId);
  if (current.kind !== "current") throw new Error("Missing live binding.");
  answer = {
    binding: current.binding,
    coordinate: current.host,
    hostVector: Buffer.from([1, 2]),
    missingStateUpdate: Buffer.from([3, 4, 5]),
    appliedThroughJournalCursor: 5,
  };
  return {
    ...f,
    current,
    reads,
    advance(ms: number) {
      now += ms;
    },
  };
}

// Proves: the state answer carries what the host applied, as the reader's socket would show it, with its cursor, read
// under the note's current binding. A note its host doesn't hold awake gets no state.
it("answers a note's early state as its socket's opening sync, and no state for a note its host does not hold awake", async () => {
  let awake = true;
  const f = await awakeFixture(undefined, async (answer) => (awake ? answer : undefined));
  const response = await f.handle(stateRequest());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("x-dohc-live-object-id")).toBe(binding.objectId);
  expect(response.headers.get("x-dohc-live-applied-through")).toBe("5");
  expect(decodeLiveFrameSync(new Uint8Array(await response.arrayBuffer()), frames)).toEqual({
    binding: f.current.view,
    hostVector: new Uint8Array([1, 2]),
    missingStateUpdate: new Uint8Array([3, 4, 5]),
  });
  expect(f.reads).toEqual([f.current.binding]);
  awake = false;
  const asleep = await f.handle(stateRequest());
  expect([asleep.status, await asleep.text()]).toEqual([204, ""]);
});

// Proves: a format-2 note the relay's switch turned off gives no state, so a reader never types into it before its
// socket is refused.
it("gives no state for a note whose format the relay turned off", async () => {
  const f = await awakeFixture();
  vi.spyOn(f.storage, "liveNoteFormatOff").mockReturnValue(true);
  const response = await f.handle(stateRequest());
  expect([response.status, await response.text()]).toEqual([204, ""]);
  expect(f.reads).toEqual([]);
});

// Proves: a state read from a host that is no longer the note's current one, of a binding the note no longer has, or
// larger than the route sends, gives no state.
it("gives no state read from another host, under another binding, or larger than the route sends", async () => {
  for (const changed of [
    (answer: AwakeLiveState) => ({
      ...answer,
      coordinate: { ...answer.coordinate, connectionId: "earlier" },
    }),
    (answer: AwakeLiveState) => ({
      ...answer,
      binding: { ...answer.binding, restoreFenceGeneration: 8 },
    }),
    // The host reads under the socket's own bound, so a state past the route's limit still arrives, and is dropped.
    (answer: AwakeLiveState) => ({ ...answer, missingStateUpdate: Buffer.alloc(1024 * 1024 - 1) }),
  ]) {
    const f = await awakeFixture(undefined, async (answer) => changed(answer));
    expect((await f.handle(stateRequest())).status).toBe(204);
  }
});

// Proves: the state route refuses what a ticket would. A full link refuses a new reader, and a note its session host
// stopped is unavailable, and neither reaches the host.
it("refuses a full link and a stopped note before it reads a state", async () => {
  const full = await awakeFixture();
  // The storage context holds its limits here; the public storage type does not show them.
  (
    full.storage as unknown as { options: { linkDiscussionPrincipalLimit: number } }
  ).options.linkDiscussionPrincipalLimit = 0;
  const refusal = await full.handle(stateRequest());
  expect([refusal.status, await refusal.json()]).toEqual([403, linkRefusalBody("link_full")]);
  // The note's own route, which opens nothing, still finds it.
  expect(await (await full.handle(request())).json()).toEqual({ objectId: binding.objectId });
  expect(full.reads).toEqual([]);
  const stopped = await awakeFixture(() => "stopped");
  const unavailable = await stopped.handle(stateRequest());
  expect([unavailable.status, await unavailable.json()]).toEqual([
    503,
    linkRefusalBody("link_live_unavailable"),
  ]);
  expect(stopped.reads).toEqual([]);
});

// Proves: a caller that keeps asking and never opens a socket reaches the host only as often as the limits allow, and
// each refused read answers no state at once. Reads the host has not answered count toward the reads at once.
it("holds its read limits for a caller that never opens a socket", async () => {
  const answers: ((value: AwakeLiveState) => void)[] = [];
  let held = false,
    answer!: AwakeLiveState;
  const f = await awakeFixture(undefined, (value) => {
    answer = value;
    return held ? new Promise((resolve) => answers.push(resolve)) : Promise.resolve(value);
  });
  for (let read = 0; read < 20; read++) expect((await f.handle(stateRequest())).status).toBe(200);
  expect((await f.handle(stateRequest())).status).toBe(204);
  expect(f.reads.length).toBe(20);
  f.advance(10_000);
  held = true;
  const waiting = Array.from({ length: 4 }, () => f.handle(stateRequest()));
  await vi.waitFor(() => expect(answers.length).toBe(4));
  expect((await f.handle(stateRequest())).status).toBe(204);
  expect(f.reads.length).toBe(24);
  held = false;
  for (const resolve of answers) resolve(answer);
  expect((await Promise.all(waiting)).map((response) => response.status)).toEqual([
    200, 200, 200, 200,
  ]);
  expect((await f.handle(stateRequest())).status).toBe(200);
});
