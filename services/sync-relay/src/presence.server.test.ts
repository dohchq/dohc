import { afterEach, describe, expect, it } from "vitest";
import { PresenceHub } from "./presence";
import type { SyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";
import {
  claimWorkspace,
  chatChannelCreate,
  logOp,
  resetOpSeq,
  closeTestStorages,
  json,
  jsonBody,
  request as req,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

function makeHandler(storage: SyncRelayStorage, presence: PresenceHub): SyncRelayHandler {
  return testHandler(storage, {
    presence,
    nowMs: () => Date.now(),
    lookupUserDisplayName: (id) => (id === "owner" ? "Owner" : "Guest"),
  });
}

function post(userId: string, path: string, body: unknown): Request {
  return req(userId, path, jsonBody(body));
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
    expect(peers[0]).toMatchObject({ displayName: "Owner", isSelf: true });
    expect(peers[0]).not.toHaveProperty("userId");
    expect(peers[0]).not.toHaveProperty("clientId");
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
    const read = await json(
      await h(req("owner", "/sync/w/presence?topic=general&since=0&hold=0", { method: "GET" })),
    );
    expect((read.peers as unknown[]).length).toBe(2);
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
          state: { userId: "victim", displayName: "Victim" },
        }),
      ),
    );
    const peers = body.peers as Array<Record<string, unknown>>;
    expect(peers[0]?.displayName).toBe("Owner");
    expect(peers[0]?.state).toEqual({});
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
    const b = await json(
      await h(req("owner", "/sync/w/presence?topic=B&since=0&hold=0", { method: "GET" })),
    );
    expect((b.peers as unknown[]).length).toBe(0);
  });

  it("rejects NUL/control characters at the parse boundary (no scope-key collision)", async () => {
    const storage = await testStorage();
    const presence = new PresenceHub();
    const h = makeHandler(storage, presence);
    await claimWorkspace(h, "owner", "a");

    const claim = await h(post("owner", "/sync/workspaces", { workspaceId: "a\u0000b" }));
    expect(claim.status).toBe(400);
    const workspaceScopeCollision = "/sync/a%00b/presence?topic=c";
    const topicScopeCollision = "/sync/a/presence?topic=b%00c";
    const wsNul = await h(post("owner", workspaceScopeCollision, { clientId: "x" }));
    expect(wsNul.status).toBe(400);
    const topicNul = await h(post("owner", topicScopeCollision, { clientId: "x" }));
    expect(topicNul.status).toBe(400);
    const clientEntryKeyWithNul = "c\u0000d";
    const clientNul = await h(
      post("owner", "/sync/a/presence?topic=b", { clientId: clientEntryKeyWithNul }),
    );
    expect(clientNul.status).toBe(400);
    const clientCtl = await h(post("owner", "/sync/a/presence?topic=b", { clientId: "c\u0001d" }));
    expect(clientCtl.status).toBe(400);
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
    const parked = h(
      req("owner", `/sync/w/presence?topic=general&since=${seed.version}&hold=10000`, {
        method: "GET",
      }),
    );
    await waitForWaiters(presence, 1);
    expect(presence.stats().waiters).toBe(1);
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

describe("presence is never journaled (ephemeral invariant)", () => {
  it("writes no durable log row and drops on leave", async () => {
    const storage = await testStorage();
    const presence = new PresenceHub();
    const h = makeHandler(storage, presence);
    await claimWorkspace(h, "owner", "w");
    await h(
      post("owner", "/sync/w/presence?topic=general", {
        clientId: "c",
        state: { state: "typing" },
      }),
    );

    // The durable log for this workspace has NO presence rows (no rows at all
    // — a claim does not append ops).
    const page = storage.fetchLogPage({ workspaceId: "w", sinceRelaySeq: 0, limit: 500 });
    expect(page.rows).toHaveLength(0);

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

    await h(
      post("owner", "/sync/w/presence?topic=notes/a.md", {
        clientId: "o",
        state: { displayName: "Owner" },
      }),
    );
    const guestView = await json(
      await h(
        post(
          "guest",
          `/sync/shares/${shareId}/presence?topic=${encodeURIComponent("notes/a.md")}`,
          {
            clientId: "g",
            state: { displayName: "Guest" },
          },
        ),
      ),
    );
    const names = (guestView.peers as Array<Record<string, unknown>>)
      .map((p) => p.displayName)
      .sort();
    expect(names).toEqual(["Guest", "Owner"]);
  });

  it("refuses a recipient a topic the grant does not expose (isolation)", async () => {
    const storage = await testStorage();
    const h = makeHandler(storage, new PresenceHub());
    const shareId = await shareFile(h);
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
      post(
        "stranger",
        `/sync/shares/${shareId}/presence?topic=${encodeURIComponent("notes/a.md")}`,
        {
          clientId: "g",
        },
      ),
    );
    expect(r.status).toBe(404);
  });

  it("re-authorizes after the park: a revoke during a parked long-poll is denied on wake", async () => {
    const storage = await testStorage();
    const presence = new PresenceHub();
    const h = makeHandler(storage, presence);
    const shareId = await shareFile(h);
    const topic = encodeURIComponent("notes/a.md");

    await h(
      post("guest", `/sync/shares/${shareId}/presence?topic=${topic}`, {
        clientId: "g",
        state: {},
      }),
    );
    const seed = await json(
      await h(
        req("guest", `/sync/shares/${shareId}/presence?topic=${topic}&since=0&hold=0`, {
          method: "GET",
        }),
      ),
    );
    const parked = h(
      req(
        "guest",
        `/sync/shares/${shareId}/presence?topic=${topic}&since=${seed.version}&hold=10000`,
        {
          method: "GET",
        },
      ),
    );
    await waitForWaiters(presence, 1);
    expect(presence.stats().waiters).toBe(1);

    // Owner revokes while the guest is parked, then touches the scope (the
    // wake that would otherwise hand the revoked guest a final snapshot).
    await h(req("owner", `/sync/shares/${shareId}/revoke`, { method: "POST" }));
    await h(post("owner", "/sync/w/presence?topic=notes/a.md", { clientId: "o2", state: {} }));

    const response = await parked;
    expect(response.status).toBe(404);
    presence.dispose();
  });

  it("404s presence after the share is revoked", async () => {
    const storage = await testStorage();
    const h = makeHandler(storage, new PresenceHub());
    const shareId = await shareFile(h);
    await h(req("owner", `/sync/shares/${shareId}/revoke`, { method: "POST" }));
    const r = await h(
      post("guest", `/sync/shares/${shareId}/presence?topic=${encodeURIComponent("notes/a.md")}`, {
        clientId: "g",
      }),
    );
    expect(r.status).toBe(404);
  });
});

describe("reserved agent presence", () => {
  it.each(["group", "version"] as const)(
    "refuses a %s recipient's reserved ID without changing owner or peer hints",
    async (kind) => {
      const storage = await testStorage();
      const presence = new PresenceHub();
      const h = makeHandler(storage, presence);
      try {
        resetOpSeq();
        await claimWorkspace(h, "owner", "w");
        const op = chatChannelCreate("chat:agent", {
          type: "both",
          purpose: "",
          folderPath: "team",
        });
        expect(
          (
            await h(
              post("owner", "/sync/w/log", {
                originId: "owner-origin",
                ops: [logOp(op.opKind, op.payload)],
              }),
            )
          ).status,
        ).toBe(200);
        const topic = kind === "group" ? "chat:agent" : "team/a.md";
        const shares: string[] = [];
        for (const recipientUserId of ["recipient", "observer"]) {
          const created = await h(
            post("owner", "/sync/w/shares", {
              recipientUserId,
              ...(kind === "group"
                ? { channelWireId: "chat:agent", paths: ["team"] }
                : { paths: [], versionId: "main" }),
              access: kind === "group" ? "read-write" : "edit",
            }),
          );
          expect(created.status).toBe(200);
          shares.push((await json(created)).shareId as string);
        }
        const ownerPublish = await h(
          post("owner", "/sync/w/presence?topic=" + topic, {
            clientId: "agent:w",
            state: { agent: true, activity: "working" },
          }),
        );
        expect(ownerPublish.status).toBe(200);
        const before = await json(ownerPublish);
        expect(before.peers).toEqual([
          expect.objectContaining({
            isSelf: true,
            state: { agent: true, activity: "working" },
          }),
        ]);
        // The topic itself admits the recipient. Its ordinary client still works.
        expect(
          (
            await h(
              post("recipient", "/sync/shares/" + shares[0] + "/presence?topic=" + topic, {
                clientId: "recipient-device",
                state: {},
              }),
            )
          ).status,
        ).toBe(200);
        for (const body of [
          { clientId: "agent:w", state: { agent: true, activity: "idle", userId: "owner" } },
          { clientId: "agent:w", leave: true },
        ]) {
          const spoof = await h(
            post("recipient", "/sync/shares/" + shares[0] + "/presence?topic=" + topic, body),
          );
          expect(spoof.status).toBe(404);
        }
        for (const [user, path] of [
          ["owner", "/sync/w/presence?topic=" + topic + "&since=0&hold=0"],
          [
            "observer",
            "/sync/shares/" + shares[1] + "/presence?topic=" + topic + "&since=0&hold=0",
          ],
        ]) {
          const snapshot = await json(await h(req(user!, path!, { method: "GET" })));
          const hints = (snapshot.peers as Array<Record<string, unknown>>).filter(
            (p) => (p.state as { agent?: unknown } | null)?.agent === true,
          );
          expect(hints).toEqual([
            expect.objectContaining({
              state: { agent: true, activity: "working" },
              isSelf: user === "owner",
              sessionToken: expect.any(String),
            }),
          ]);
          expect(hints[0]).not.toHaveProperty("clientId");
          if (user === "owner")
            expect(hints[0]!.sessionToken).toBe(
              (before.peers as Array<Record<string, unknown>>)[0]!.sessionToken,
            );
        }
        expect(
          (
            await h(
              post("owner", "/sync/w/presence?topic=" + topic, {
                clientId: "agent:foreign-workspace",
                state: { agent: true, activity: "idle" },
              }),
            )
          ).status,
        ).toBe(404);
        expect(
          (
            await h(
              post("owner", "/sync/w/presence?topic=" + topic, {
                clientId: "agent:w",
                leave: true,
              }),
            )
          ).status,
        ).toBe(200);
        expect(presence.stats().entries).toBe(1);
      } finally {
        presence.dispose();
      }
    },
  );
});
