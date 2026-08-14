import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PresenceHub } from "./presence";
import { createSyncRelayHandler, type SyncRelayHandler } from "./server";
import { openSyncRelayStorage, type SyncRelayStorage } from "./storage";

// Server-level tests for the ephemeral awareness transport: authenticated,
// scoped, server-derived identity, and — the load-bearing invariant — NEVER
// journaled to the durable log.

let roots: string[] = [];
let storages: SyncRelayStorage[] = [];

beforeEach(() => {
  roots = [];
  storages = [];
});

afterEach(async () => {
  for (const storage of storages) storage.close();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function testStorage(): Promise<SyncRelayStorage> {
  const root = await mkdtemp(join(tmpdir(), "dohc-presence-"));
  roots.push(root);
  const storage = openSyncRelayStorage(join(root, "relay.sqlite"));
  storages.push(storage);
  return storage;
}

function makeHandler(
  storage: SyncRelayStorage,
  presence: PresenceHub,
): SyncRelayHandler {
  const resolveActor: ResolveActor = (request, workspaceId) => {
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer user:")) throw new UnauthorizedError();
    return { userId: auth.slice("Bearer user:".length), workspaceId };
  };
  return createSyncRelayHandler({
    storage,
    resolveActor,
    presence,
    // Email <-> id seam so share-by-email E2E works without a user DB.
    resolveUserIdByEmail: (email) =>
      email.endsWith("@t") ? email.slice(0, -"@t".length) : null,
    lookupUserEmail: (userId) => `${userId}@t`,
    nowMs: () => Date.now(),
  });
}

function req(userId: string | null, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (userId) headers.set("authorization", `Bearer user:${userId}`);
  return new Request(`http://relay.test${path}`, { ...init, headers });
}

function post(userId: string, path: string, body: unknown): Request {
  return req(userId, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function claimWorkspace(h: SyncRelayHandler, userId: string, workspaceId: string) {
  const r = await h(post(userId, "/sync/workspaces", { workspaceId }));
  expect(r.status).toBe(200);
}

// Deterministically wait for a long-poll to park (the request promise offers
// no "parked" signal, so poll the hub's stats with a hard deadline instead of
// sleeping a heuristic amount — flake-proof under CI load).
async function waitForWaiters(presence: PresenceHub, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (presence.stats().waiters < count) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${count} parked waiter(s)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("presence transport (workspace-owned)", () => {
  it("rejects an unauthenticated presence request", async () => {
    const storage = await testStorage();
    const h = makeHandler(storage, new PresenceHub());
    const r = await h(req(null, "/sync/w/presence?topic=general", { method: "GET" }));
    expect(r.status).toBe(401);
  });

  it("404s presence for a workspace the caller does not own (isolation)", async () => {
    const storage = await testStorage();
    const h = makeHandler(storage, new PresenceHub());
    await claimWorkspace(h, "owner", "w");
    // A different user cannot see or publish presence in someone else's ws.
    const r = await h(post("intruder", "/sync/w/presence?topic=general", { clientId: "c" }));
    expect(r.status).toBe(404);
  });

  it("publishes and reads back presence for the owner", async () => {
    const storage = await testStorage();
    const h = makeHandler(storage, new PresenceHub());
    await claimWorkspace(h, "owner", "w");
    const pub = await h(
      post("owner", "/sync/w/presence?topic=general", {
        clientId: "laptop",
        state: { displayName: "Owner", state: "viewing" },
      }),
    );
    const body = await json(pub);
    expect(body.ok).toBe(true);
    const peers = body.peers as Array<Record<string, unknown>>;
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ userId: "owner", clientId: "laptop" });
  });

  it("two devices of one user see each other; leave clears one", async () => {
    const storage = await testStorage();
    const h = makeHandler(storage, new PresenceHub());
    await claimWorkspace(h, "owner", "w");
    await h(post("owner", "/sync/w/presence?topic=general", { clientId: "laptop", state: {} }));
    const second = await json(
      await h(post("owner", "/sync/w/presence?topic=general", { clientId: "phone", state: {} })),
    );
    expect((second.peers as unknown[]).length).toBe(2);
    // Immediate long-poll read reflects both.
    const read = await json(await h(req("owner", "/sync/w/presence?topic=general&since=0&hold=0", { method: "GET" })));
    expect((read.peers as unknown[]).length).toBe(2);
    // Phone leaves.
    const afterLeave = await json(
      await h(post("owner", "/sync/w/presence?topic=general", { clientId: "phone", leave: true })),
    );
    expect((afterLeave.peers as unknown[]).length).toBe(1);
  });

  it("keeps the server-derived userId — a client cannot spoof another user", async () => {
    const storage = await testStorage();
    const h = makeHandler(storage, new PresenceHub());
    await claimWorkspace(h, "owner", "w");
    const body = await json(
      await h(
        post("owner", "/sync/w/presence?topic=general", {
          clientId: "c",
          // Attempt to impersonate: put a fake userId in the payload.
          state: { userId: "victim", displayName: "Victim" },
        }),
      ),
    );
    const peers = body.peers as Array<Record<string, unknown>>;
    // Attribution is the authenticated actor, never the payload.
    expect(peers[0]?.userId).toBe("owner");
  });

  it("requires a topic", async () => {
    const storage = await testStorage();
    const h = makeHandler(storage, new PresenceHub());
    await claimWorkspace(h, "owner", "w");
    const r = await h(post("owner", "/sync/w/presence", { clientId: "c" }));
    expect(r.status).toBe(400);
  });

  it("isolates topics: viewers of topic A never see topic B's peers", async () => {
    const storage = await testStorage();
    const h = makeHandler(storage, new PresenceHub());
    await claimWorkspace(h, "owner", "w");
    await h(post("owner", "/sync/w/presence?topic=A", { clientId: "c", state: {} }));
    const b = await json(await h(req("owner", "/sync/w/presence?topic=B&since=0&hold=0", { method: "GET" })));
    expect((b.peers as unknown[]).length).toBe(0);
  });

  it("rejects NUL/control characters at the parse boundary (no scope-key collision)", async () => {
    const storage = await testStorage();
    const presence = new PresenceHub();
    const h = makeHandler(storage, presence);
    await claimWorkspace(h, "owner", "a");

    // A workspace id with an embedded NUL can never be claimed…
    const claim = await h(post("owner", "/sync/workspaces", { workspaceId: "a\u0000b" }));
    expect(claim.status).toBe(400);
    // …or addressed: workspace `a\0b` + topic `c` must NOT collide with
    // workspace `a` + topic `b\0c` in the NUL-joined scope key.
    const wsNul = await h(post("owner", "/sync/a%00b/presence?topic=c", { clientId: "x" }));
    expect(wsNul.status).toBe(400);
    // A topic with a NUL is refused too (the request above proves the safe
    // encoding path; this proves the raw body/query path)…
    const topicNul = await h(post("owner", "/sync/a/presence?topic=b%00c", { clientId: "x" }));
    expect(topicNul.status).toBe(400);
    // …and so is a clientId with a control character (entry keys are also
    // NUL-joined).
    const clientNul = await h(post("owner", "/sync/a/presence?topic=b", { clientId: "c\u0000d" }));
    expect(clientNul.status).toBe(400);
    const clientCtl = await h(post("owner", "/sync/a/presence?topic=b", { clientId: "c\u0001d" }));
    expect(clientCtl.status).toBe(400);
    // Nothing above leaked into the hub.
    expect(presence.stats().entries).toBe(0);
    presence.dispose();
  });

  it("429s a long-poll beyond the parked-waiter caps", async () => {
    const storage = await testStorage();
    const presence = new PresenceHub({ maxWaitersPerActor: 1 });
    const h = makeHandler(storage, presence);
    await claimWorkspace(h, "owner", "w");
    await h(post("owner", "/sync/w/presence?topic=general", { clientId: "c", state: {} }));
    const seed = await json(
      await h(req("owner", "/sync/w/presence?topic=general&since=0&hold=0", { method: "GET" })),
    );
    // First poll parks…
    const parked = h(
      req("owner", `/sync/w/presence?topic=general&since=${seed.version}&hold=10000`, {
        method: "GET",
      }),
    );
    await waitForWaiters(presence, 1);
    expect(presence.stats().waiters).toBe(1);
    // …the second (same actor) is refused with 429, not parked.
    const second = await h(
      req("owner", `/sync/w/presence?topic=general&since=${seed.version}&hold=10000`, {
        method: "GET",
      }),
    );
    expect(second.status).toBe(429);
    // Wake the parked poll so nothing dangles.
    await h(post("owner", "/sync/w/presence?topic=general", { clientId: "c2", state: {} }));
    expect((await parked).status).toBe(200);
    expect(presence.stats().waiters).toBe(0);
    presence.dispose();
  });
});

describe("presence is NEVER journaled (ephemeral invariant)", () => {
  it("writes no durable log row and drops on leave", async () => {
    const storage = await testStorage();
    const presence = new PresenceHub();
    const h = makeHandler(storage, presence);
    await claimWorkspace(h, "owner", "w");
    await h(post("owner", "/sync/w/presence?topic=general", { clientId: "c", state: { state: "typing" } }));

    // The durable log for this workspace has NO presence rows (no rows at all
    // — a claim does not append ops).
    const page = storage.fetchLogPage({ workspaceId: "w", sinceRelaySeq: 0, limit: 500 });
    expect(page.rows).toHaveLength(0);

    // The entire presence state lives in-memory in the hub only.
    expect(presence.stats().entries).toBe(1);
    await h(post("owner", "/sync/w/presence?topic=general", { clientId: "c", leave: true }));
    expect(presence.stats().entries).toBe(0);
    expect(presence.stats().scopes).toBe(0);
  });
});

describe("presence over a share (cross-user, gated)", () => {
  async function shareFile(h: SyncRelayHandler): Promise<string> {
    await claimWorkspace(h, "owner", "w");
    const created = await json(
      await h(
        post("owner", "/sync/w/shares", {
          paths: ["notes/a.md"],
          versionId: null,
          access: "view",
          recipientUserId: "guest",
        }),
      ),
    );
    return created.shareId as string;
  }

  it("lets a recipient join presence for a granted topic and see the owner", async () => {
    const storage = await testStorage();
    const presence = new PresenceHub();
    const h = makeHandler(storage, presence);
    const shareId = await shareFile(h);

    // Owner publishes presence on the shared doc via the workspace route.
    await h(post("owner", "/sync/w/presence?topic=notes/a.md", { clientId: "o", state: { displayName: "Owner" } }));
    // Guest publishes via the SHARE route — same underlying scope.
    const guestView = await json(
      await h(
        post("guest", `/sync/shares/${shareId}/presence?topic=${encodeURIComponent("notes/a.md")}`, {
          clientId: "g",
          state: { displayName: "Guest" },
        }),
      ),
    );
    const ids = (guestView.peers as Array<Record<string, unknown>>).map((p) => p.userId).sort();
    expect(ids).toEqual(["guest", "owner"]);
  });

  it("refuses a recipient a topic the grant does not expose (isolation)", async () => {
    const storage = await testStorage();
    const h = makeHandler(storage, new PresenceHub());
    const shareId = await shareFile(h);
    // The grant is for notes/a.md; presence for notes/b.md is fail-closed.
    const r = await h(
      post("guest", `/sync/shares/${shareId}/presence?topic=${encodeURIComponent("notes/b.md")}`, {
        clientId: "g",
      }),
    );
    expect(r.status).toBe(404);
  });

  it("404s presence for a non-recipient of the share", async () => {
    const storage = await testStorage();
    const h = makeHandler(storage, new PresenceHub());
    const shareId = await shareFile(h);
    const r = await h(
      post("stranger", `/sync/shares/${shareId}/presence?topic=${encodeURIComponent("notes/a.md")}`, {
        clientId: "g",
      }),
    );
    expect(r.status).toBe(404);
  });

  it("re-authorizes after the park: a revoke DURING a parked long-poll is denied on wake", async () => {
    const storage = await testStorage();
    const presence = new PresenceHub();
    const h = makeHandler(storage, presence);
    const shareId = await shareFile(h);
    const topic = encodeURIComponent("notes/a.md");

    // Guest joins and reads the current version.
    await h(post("guest", `/sync/shares/${shareId}/presence?topic=${topic}`, { clientId: "g", state: {} }));
    const seed = await json(
      await h(req("guest", `/sync/shares/${shareId}/presence?topic=${topic}&since=0&hold=0`, { method: "GET" })),
    );
    // Guest parks a long-poll at the current version (authorized at park time).
    const parked = h(
      req("guest", `/sync/shares/${shareId}/presence?topic=${topic}&since=${seed.version}&hold=10000`, {
        method: "GET",
      }),
    );
    await waitForWaiters(presence, 1);
    expect(presence.stats().waiters).toBe(1);

    // Owner revokes WHILE the guest is parked, then touches the scope (the
    // wake that would otherwise hand the revoked guest a final snapshot).
    await h(post("owner", `/sync/shares/${shareId}/revoke`, {}));
    await h(post("owner", "/sync/w/presence?topic=notes/a.md", { clientId: "o2", state: {} }));

    // The woken poll re-runs authorization and fails closed.
    const response = await parked;
    expect(response.status).toBe(404);
    presence.dispose();
  });

  it("404s presence after the share is revoked", async () => {
    const storage = await testStorage();
    const h = makeHandler(storage, new PresenceHub());
    const shareId = await shareFile(h);
    await h(post("owner", `/sync/shares/${shareId}/revoke`, {}));
    const r = await h(
      post("guest", `/sync/shares/${shareId}/presence?topic=${encodeURIComponent("notes/a.md")}`, {
        clientId: "g",
      }),
    );
    expect(r.status).toBe(404);
  });
});
