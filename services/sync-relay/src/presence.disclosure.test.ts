import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { PresenceHub } from "./presence";
import {
  claimWorkspace,
  closeTestStorages,
  json,
  jsonBody,
  request,
  testHandler,
  testStorage,
  inspectDatabase,
  storagePath,
} from "./testing";
afterEach(closeTestStorages);
async function fixture() {
  const storage = await testStorage();
  const presence = new PresenceHub();
  const names: Record<string, string> = {
    owner: "Owner label",
    alice: "Alice label",
    bob: "Bob label",
  };
  const h = testHandler(storage, {
    presence,
    nowMs: () => Date.now(),
    lookupUserDisplayName: (id) => names[id] ?? null,
  });
  await claimWorkspace(h, "owner", "w");
  const post = (id: string, path: string, body: unknown) => h(request(id, path, jsonBody(body)));
  const share = async (id: string, access = "edit") => {
    const r = await post("owner", "/sync/w/shares", {
      paths: ["notes"],
      versionId: null,
      access,
      recipientUserId: id,
    });
    expect(r.status).toBe(200);
    return (await json(r)).shareId as string;
  };
  const pub = async (
    id: string,
    shareId: string | null,
    topic = "notes/a.md",
    state: unknown = { typing: true },
  ) => {
    const path = shareId ? "/sync/shares/" + shareId : "/sync/w";
    const r = await post(id, path + "/presence?topic=" + encodeURIComponent(topic), {
      clientId: id,
      state,
    });
    expect(r.status).toBe(200);
    return json(r);
  };
  const poll = async (id: string, shareId: string | null, topic = "notes/a.md") => {
    const path = shareId ? "/sync/shares/" + shareId : "/sync/w";
    return json(
      await h(
        request(
          id,
          path + "/presence?topic=" + encodeURIComponent(topic) + "&clientId=" + id + "&hold=0",
        ),
      ),
    );
  };
  return { storage, presence, names, h, post, share, pub, poll };
}
it("projects document peers per viewer on publish and poll without cross-share identity", async () => {
  const f = await fixture();
  const a = await f.share("alice");
  const b = await f.share("bob");
  await f.pub("owner", null);
  await f.pub("bob", b);
  for (const body of [await f.pub("alice", a), await f.poll("alice", a)]) {
    const peers = body.peers as Array<Record<string, unknown>>;
    expect(peers).toHaveLength(3);
    expect(peers.map((p) => p.displayName)).toEqual(["Owner label", null, "Alice label"]);
    expect(peers.find((p) => p.isSelf)?.displayName).toBe("Alice label");
    for (const peer of peers) {
      for (const field of ["userId", "clientId", "email", "access", "colorHash"])
        expect(peer).not.toHaveProperty(field);
      expect(peer.paletteSlot).toBeGreaterThanOrEqual(0);
      expect(peer.paletteSlot).toBeLessThan(7);
    }
    expect(JSON.stringify(body)).not.toContain("Bob label");
    expect(JSON.stringify(body)).not.toContain('"bob"');
  }
  expect((await f.poll("owner", null)).peers).toEqual(
    expect.arrayContaining([expect.objectContaining({ displayName: "Bob label" })]),
  );
});
it("uses different anonymous tokens per viewer, topic, and session; groups overlapping devices", async () => {
  const f = await fixture();
  const a = await f.share("alice");
  const b = await f.share("bob");
  const c = await f.share("carol");
  await f.pub("bob", b);
  await f.pub("alice", a);
  await f.pub("carol", c);
  const bobA = ((await f.poll("alice", a)).peers as Array<Record<string, unknown>>)[0]!;
  const bobC = ((await f.poll("carol", c)).peers as Array<Record<string, unknown>>)[0]!;
  expect(bobA.sessionToken).not.toBe(bobC.sessionToken);
  expect(bobA.faceToken).not.toBe(bobC.faceToken);
  await f.pub("bob", b, "notes/b.md");
  const other = (
    (await f.poll("alice", a, "notes/b.md")).peers as Array<Record<string, unknown>>
  )[0]!;
  expect(other.sessionToken).not.toBe(bobA.sessionToken);
  await f.post("bob", "/sync/shares/" + b + "/presence?topic=notes/a.md", {
    clientId: "bob-device2",
    state: {},
  });
  const both = ((await f.poll("owner", null)).peers as Array<Record<string, unknown>>).filter(
    (p) => p.displayName === "Bob label",
  );
  expect(both).toHaveLength(2);
  expect(both[0]!.faceToken).toBe(both[1]!.faceToken);
  expect(both[0]!.sessionToken).not.toBe(both[1]!.sessionToken);
  await f.post("bob", "/sync/shares/" + b + "/presence?topic=notes/a.md", {
    clientId: "bob",
    leave: true,
  });
  await f.pub("bob", b);
  const again = ((await f.poll("alice", a)).peers as Array<Record<string, unknown>>).at(-1)!;
  expect(again.sessionToken).not.toBe(bobA.sessionToken);
});
it("makes a missing account label anonymous and strips client identity and nested display data", async () => {
  const f = await fixture();
  delete f.names.owner;
  const body = await f.pub("owner", null, "notes/a.md", {
    displayName: "Email@leak.test",
    userId: "fake",
    color: "#fff",
    email: "Email@leak.test",
    nested: { name: "fake" },
    typing: true,
  });
  expect(body.peers).toEqual([
    expect.objectContaining({ displayName: null, state: { typing: true }, isSelf: true }),
  ]);
  expect(JSON.stringify(body)).not.toContain("leak.test");
});
function awareness(yc: number, state: unknown): string {
  const bytes: number[] = [];
  const uint = (value: number) => {
    while (value > 127) {
      bytes.push((value % 128) | 128);
      value = Math.floor(value / 128);
    }
    bytes.push(value);
  };
  uint(1);
  uint(yc);
  uint(1);
  const text = Buffer.from(JSON.stringify(state));
  uint(text.length);
  bytes.push(...text);
  return Buffer.from(bytes).toString("base64");
}
it("rejects identity fields inside awareness, including nested ones", async () => {
  const f = await fixture();
  for (const state of [
    { user: { name: "spoof" } },
    { pointer: { x: 1, y: 1, tool: "pointer", userId: "spoof" } },
    { cursor: { anchor: { email: "spoof" } } },
  ]) {
    const r = await f.post("owner", "/sync/w/presence?topic=notes/a.md", {
      clientId: "x",
      state: { yc: 7, update: awareness(7, state) },
    });
    expect(r.status).toBe(400);
  }
  for (const identity of [
    { displayName: "spoof" },
    { userId: "spoof" },
    { extra: { email: "spoof@leak.test" } },
  ]) {
    const r = await f.post("owner", "/sync/w/presence?topic=notes/a.md", {
      clientId: "x",
      state: { yc: 7, update: awareness(7, {}), ...identity },
    });
    expect(r.status).toBe(400);
  }
  expect(f.presence.stats().entries).toBe(0);
});

async function append(
  f: Awaited<ReturnType<typeof fixture>>,
  seq: number,
  opKind: string,
  payload: unknown,
) {
  f.storage.appendLogBatch({
    workspaceId: "w",
    originId: "owner-origin",
    ops: [{ originSeq: seq, opKind, recordedAtMs: seq + 1, payloadJson: JSON.stringify(payload) }],
  });
}
async function moment(
  f: Awaited<ReturnType<typeof fixture>>,
  seq: number,
  path: string,
  versionId = "main",
  objectId = "object",
) {
  const sha256 = createHash("sha256").update("").digest("hex");
  f.storage.putBlob({ workspaceId: "w", sha256, content: new Uint8Array(), createdAtMs: 1 });
  await append(f, seq, "moment.append", {
    objectId,
    versionId,
    momentId: "m" + seq,
    recordedAtMs: seq + 1,
    operation: "write",
    path,
    payloadAfterPath: path,
    payloadAfterBlobSha256: sha256,
    payloadAfterContentKind: "text",
    payloadAfterByteLength: 0,
  });
}
it("resolves object topics from the relay log and refuses unknown objects, wrong workspaces/versions and secret paths", async () => {
  const f = await fixture();
  const a = await f.share("alice");
  await moment(f, 0, "notes/a.md");
  for (const prefix of ["scene:", "doc:"]) {
    await f.pub("alice", a, prefix + JSON.stringify(["w", "main", "object"]));
    for (const coordinates of [
      ["other", "main", "object"],
      ["w", "other", "object"],
      ["w", "main", "unknown"],
    ]) {
      const r = await f.post(
        "alice",
        "/sync/shares/" +
          a +
          "/presence?topic=" +
          encodeURIComponent(prefix + JSON.stringify(coordinates)),
        { clientId: "x" },
      );
      expect(r.status).toBe(404);
    }
  }
  await moment(f, 1, "notes/.env");
  expect(
    (
      await f.post(
        "alice",
        "/sync/shares/" +
          a +
          "/presence?topic=" +
          encodeURIComponent('scene:["w","main","object"]'),
        { clientId: "x" },
      )
    ).status,
  ).toBe(404);
});
it("ends object presence on the next parked poll after a rename out of the selector", async () => {
  const f = await fixture();
  const a = await f.share("alice");
  await moment(f, 0, "notes/a.md");
  const topic = 'scene:["w","main","object"]';
  const seed = await f.pub("alice", a, topic);
  const parked = f.h(
    request(
      "alice",
      "/sync/shares/" +
        a +
        "/presence?topic=" +
        encodeURIComponent(topic) +
        "&since=" +
        seed.version +
        "&hold=30000&clientId=alice",
    ),
  );
  await expect.poll(() => f.presence.stats().waiters).toBe(1);
  await moment(f, 1, "outside/a.md");
  await f.pub("owner", null, topic);
  expect((await parked).status).toBe(404);
  expect(f.presence.stats().waiters).toBe(0);
});
it("chat presence follows chat attribution across separate grants", async () => {
  const f = await fixture();
  await append(f, 0, "chat.channel.create", {
    channelId: "c",
    wireId: "chat-wire",
    slug: "team",
    name: "Team",
    kind: "channel",
    createdAtMs: 1,
  });
  await append(f, 1, "chat.thread.create", {
    threadId: "t",
    channelWireId: "chat-wire",
    title: "Topic",
    createdAtMs: 1,
  });
  const grant = async (id: string) => {
    const r = await f.post("owner", "/sync/w/shares", {
      channelWireId: "chat-wire",
      access: "read-write",
      recipientUserId: id,
    });
    expect(r.status).toBe(200);
    return (await json(r)).shareId as string;
  };
  const a = await grant("alice");
  const b = await grant("bob");
  for (const topic of ["chat-wire", "chat:thread:t"]) {
    await f.pub("bob", b, topic);
    const result = await f.pub("alice", a, topic);
    expect(result.peers).toEqual(
      expect.arrayContaining([expect.objectContaining({ displayName: "Bob label" })]),
    );
    expect(JSON.stringify(await f.poll("alice", a, topic))).not.toContain('"bob"');
  }
});
it("keeps View and Comment faces, restricts carets to Edit, and drops revoked peers", async () => {
  const f = await fixture();
  const a = await f.share("alice", "view");
  const b = await f.share("bob", "comment");
  const state = { yc: 7, update: awareness(7, { pointer: { x: 1, y: 2, tool: "pointer" } }) };
  await f.pub("alice", a, "notes/a.md", state);
  await f.pub("bob", b, "notes/a.md", state);
  const before = await f.poll("owner", null);
  expect(before.peers).toHaveLength(2);
  for (const peer of before.peers as Array<Record<string, unknown>>) expect(peer.state).toEqual({});
  await f.h(request("owner", "/sync/shares/" + b + "/revoke", { method: "POST" }));
  expect((await f.poll("owner", null)).peers).toHaveLength(1);
});
it("does not mistake another account with the same client id for the viewer", async () => {
  const f = await fixture();
  const a = await f.share("alice");
  const b = await f.share("bob");
  await f.post("bob", "/sync/shares/" + b + "/presence?topic=notes/a.md", {
    clientId: "alice",
    state: {},
  });
  const body = await f.pub("alice", a);
  expect((body.peers as Array<Record<string, unknown>>).map((p) => p.isSelf)).toEqual([
    false,
    true,
  ]);
});

it("applies a downgrade to an already published caret on the next snapshot", async () => {
  const f = await fixture();
  const a = await f.share("alice");
  await f.pub("alice", a, "notes/a.md", {
    yc: 7,
    update: awareness(7, { cursor: { anchor: null, head: null } }),
  });
  expect((await f.poll("owner", null)).peers).toEqual([
    expect.objectContaining({ state: expect.objectContaining({ yc: 7 }) }),
  ]);
  const grant = f.storage.listActiveShareGrantsForRecipient(a, "alice")[0]!;
  inspectDatabase(storagePath(f.storage))
    .prepare("UPDATE sync_relay_share_grants SET access = ? WHERE grant_id = ?")
    .run("view", grant.grantId);
  expect((await f.poll("owner", null)).peers).toEqual([
    expect.objectContaining({ displayName: "Alice label", state: {} }),
  ]);
});
it("refuses file selectors that collide with a chat topic", async () => {
  const f = await fixture();
  const a = await f.share("alice");
  await append(f, 0, "chat.channel.create", {
    channelId: "c",
    wireId: "notes/a.md",
    slug: "team",
    name: "Team",
    kind: "channel",
    createdAtMs: 1,
  });
  const r = await f.post("alice", "/sync/shares/" + a + "/presence?topic=notes/a.md", {
    clientId: "alice",
  });
  expect(r.status).toBe(404);
});
it("never substitutes an email for an account label", async () => {
  const f = await fixture();
  f.names.owner = "owner@leak.test";
  expect((await f.pub("owner", null)).peers).toEqual([
    expect.objectContaining({ displayName: null }),
  ]);
});

it("keeps object disclosure anonymous when a channel wire id collides with its topic", async () => {
  const f = await fixture();
  const a = await f.share("alice");
  const b = await f.share("bob");
  const topic = 'scene:["w","main","object"]';
  await moment(f, 0, "notes/a.md");
  await append(f, 1, "chat.channel.create", {
    channelId: "c",
    wireId: topic,
    slug: "team",
    name: "Team",
    kind: "channel",
    createdAtMs: 1,
  });
  await f.pub("bob", b, topic);
  expect((await f.pub("alice", a, topic)).peers).toEqual(
    expect.arrayContaining([expect.objectContaining({ displayName: null, isSelf: false })]),
  );
});

it("does not let a Group folder grant presence in another channel with a colliding wire id", async () => {
  const f = await fixture();
  await append(f, 0, "chat.channel.create", {
    channelId: "group",
    wireId: "group-wire",
    slug: "notes",
    name: "Notes",
    kind: "channel",
    type: "both",
    purpose: "",
    folderPath: "notes",
    createdAtMs: 1,
  });
  await append(f, 1, "chat.channel.create", {
    channelId: "private",
    wireId: "notes/a.md",
    slug: "private",
    name: "Private",
    kind: "channel",
    createdAtMs: 1,
  });
  const share = await f.post("owner", "/sync/w/shares", {
    channelWireId: "group-wire",
    paths: ["notes"],
    access: "read-write",
    recipientUserId: "alice",
  });
  expect(share.status).toBe(200);
  const shareId = (await json(share)).shareId as string;
  const r = await f.post("alice", "/sync/shares/" + shareId + "/presence?topic=notes/a.md", {
    clientId: "alice",
  });
  expect(r.status).toBe(404);
});
