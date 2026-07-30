import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Two DIFFERENT clients over a REAL relay child process (the SYNC_RELAY_TEST_AUTH
// bearer seam), proving the ephemeral awareness transport end to end: client A
// sees client B come online + type, and B leaving clears B for A — all with no
// durable log write.

let roots: string[] = [];
let children: ChildProcess[] = [];

beforeEach(() => {
  roots = [];
  children = [];
});

afterEach(async () => {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
          child.once("close", () => {
            clearTimeout(force);
            resolve();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

async function spawnRelay(dbPath: string): Promise<string> {
  const child = spawn(process.execPath, ["--import", "tsx/esm", "src/main.ts"], {
    cwd: packageRoot(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0",
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(
      () => reject(new Error(`relay did not report a port\n${stdout}\n${stderr}`)),
      15_000,
    );
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = /SYNC_RELAY_LISTENING host=([^\s]+) port=(\d+)/u.exec(stdout);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://${match[1]}:${match[2]}`);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`relay exited before listening: ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-presence-int-"));
  roots.push(root);
  return root;
}

function bearer(userId: string): Record<string, string> {
  return { authorization: `Bearer test:${userId}` };
}

async function claimWorkspace(baseUrl: string, userId: string, workspaceId: string): Promise<void> {
  const r = await fetch(`${baseUrl}/sync/workspaces`, {
    method: "POST",
    headers: { ...bearer(userId), "content-type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  expect(r.status).toBe(200);
}

interface Peer {
  userId: string;
  clientId: string;
  state: unknown;
}

async function publish(
  baseUrl: string,
  userId: string,
  workspaceId: string,
  topic: string,
  body: Record<string, unknown>,
): Promise<Peer[]> {
  const r = await fetch(
    `${baseUrl}/sync/${workspaceId}/presence?topic=${encodeURIComponent(topic)}`,
    {
      method: "POST",
      headers: { ...bearer(userId), "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  expect(r.status).toBe(200);
  return ((await r.json()) as { peers: Peer[] }).peers;
}

async function poll(
  baseUrl: string,
  userId: string,
  workspaceId: string,
  topic: string,
  since: number,
  hold: number,
): Promise<{ version: number; peers: Peer[] }> {
  const r = await fetch(
    `${baseUrl}/sync/${workspaceId}/presence?topic=${encodeURIComponent(topic)}&since=${since}&hold=${hold}`,
    { method: "GET", headers: bearer(userId) },
  );
  expect(r.status).toBe(200);
  return (await r.json()) as { version: number; peers: Peer[] };
}

// Grant a chat-channel share addressed to a recipient user id, returning the
// shareId. The selector's channelWireId is what the presence gate keys on.
async function createChatShare(
  baseUrl: string,
  granter: string,
  workspaceId: string,
  recipientUserId: string,
  channelWireId: string,
): Promise<string> {
  const r = await fetch(`${baseUrl}/sync/${workspaceId}/shares`, {
    method: "POST",
    headers: { ...bearer(granter), "content-type": "application/json" },
    body: JSON.stringify({ channelWireId, access: "read-write", recipientUserId }),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { shareId: string }).shareId;
}

// Append the authoritative channel kind the share/presence gates resolve from
// the owner's log. A wire id alone is not enough to prove a channel is human.
async function appendChannelCreate(
  baseUrl: string,
  owner: string,
  workspaceId: string,
  originSeq: number,
  channelWireId: string,
): Promise<void> {
  const r = await fetch(`${baseUrl}/sync/${workspaceId}/log`, {
    method: "POST",
    headers: { ...bearer(owner), "content-type": "application/json" },
    body: JSON.stringify({
      originId: "owner-origin",
      ops: [
        {
          originSeq,
          opKind: "chat.channel.create",
          recordedAtMs: 1,
          payload: {
            channelId: `channel-${channelWireId}`,
            name: `name-${channelWireId}`,
            slug: `slug-${channelWireId}`,
            kind: "channel",
            createdAtMs: 1,
            wireId: channelWireId,
          },
        },
      ],
    }),
  });
  expect(r.status).toBe(200);
}

// Append a real chat.thread.create to the owner's log, binding a thread to a
// channel wire id. The relay's forge-resistant resolver reads THIS op to decide
// whether a `chat:thread:<threadId>` presence topic is bound to a granted
// channel — so a thread topic is only authorized once such a binding exists.
async function appendThreadCreate(
  baseUrl: string,
  owner: string,
  workspaceId: string,
  originSeq: number,
  threadId: string,
  channelWireId: string,
): Promise<void> {
  const r = await fetch(`${baseUrl}/sync/${workspaceId}/log`, {
    method: "POST",
    headers: { ...bearer(owner), "content-type": "application/json" },
    body: JSON.stringify({
      originId: "owner-origin",
      ops: [
        {
          originSeq,
          opKind: "chat.thread.create",
          recordedAtMs: 1,
          payload: { threadId, channelSlug: "team", channelWireId, title: "", createdAtMs: 1 },
        },
      ],
    }),
  });
  expect(r.status).toBe(200);
}

// Presence via the SHARE route (a participant's path). The relay resolves the
// share to the GRANTER's workspace, so this lands in the owner's scope.
async function sharePresenceRaw(
  baseUrl: string,
  userId: string,
  shareId: string,
  topic: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const r = await fetch(
    `${baseUrl}/sync/shares/${shareId}/presence?topic=${encodeURIComponent(topic)}`,
    {
      method: "POST",
      headers: { ...bearer(userId), "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return { status: r.status, body: await r.text() };
}

async function sharePublish(
  baseUrl: string,
  userId: string,
  shareId: string,
  topic: string,
  body: Record<string, unknown>,
): Promise<Peer[]> {
  const r = await sharePresenceRaw(baseUrl, userId, shareId, topic, body);
  expect(r.status).toBe(200);
  return (JSON.parse(r.body) as { peers: Peer[] }).peers;
}

describe("two-client presence over a real relay child", () => {
  it("A sees B come online, type, and clear on leave", async () => {
    const relayRoot = await tempDir();
    const baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));

    // A and B are the SAME workspace owner across two devices/tabs (both
    // authorized by workspaceIsOwnedBy). Distinct clientIds => two entries.
    const ws = "workspace-presence";
    await claimWorkspace(baseUrl, "owner", ws);

    // A appears.
    const afterA = await publish(baseUrl, "owner", ws, "general", {
      clientId: "A",
      state: { displayName: "Ice", typing: false },
    });
    expect(afterA.map((p) => p.clientId)).toEqual(["A"]);

    // A long-polls (parked); B appears typing -> A wakes and sees B typing.
    // Seed the poll `since` correctly: read the current version first.
    const current = await poll(baseUrl, "owner", ws, "general", 0, 0);
    const wake = poll(baseUrl, "owner", ws, "general", current.version, 10_000);
    await publish(baseUrl, "owner", ws, "general", {
      clientId: "B",
      state: { displayName: "Bee", typing: true },
    });
    const woke = await wake;
    const bee = woke.peers.find((p) => p.clientId === "B");
    expect(bee?.state).toMatchObject({ displayName: "Bee", typing: true });

    // B leaves -> A's next read no longer shows B.
    await fetch(`${baseUrl}/sync/${ws}/presence?topic=general`, {
      method: "POST",
      headers: { ...bearer("owner"), "content-type": "application/json" },
      body: JSON.stringify({ clientId: "B", leave: true }),
    });
    const afterLeave = await poll(baseUrl, "owner", ws, "general", 0, 0);
    expect(afterLeave.peers.map((p) => p.clientId)).toEqual(["A"]);
  }, 90_000);

  it("converges an OWNER (workspace scope) and a PARTICIPANT (share scope) on ONE shared-channel presence scope via the wireId topic", async () => {
    const relayRoot = await tempDir();
    const baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));

    // The shared channel lives in the OWNER's workspace; its cross-machine wire
    // id IS the presence topic both sides key on (the relay's chat-share gate
    // admits exactly the granted channelWireId as the topic).
    const ownerWs = "workspace-shared";
    const wireId = "wire-general";
    await claimWorkspace(baseUrl, "owner", ownerWs);
    await appendChannelCreate(baseUrl, "owner", ownerWs, 0, wireId);
    // Owner grants the channel to a participant (chat-channel share).
    const shareId = await createChatShare(baseUrl, "owner", ownerWs, "member", wireId);

    // OWNER publishes presence via the WORKSPACE route on the wireId topic.
    const ownerView = await publish(baseUrl, "owner", ownerWs, wireId, {
      clientId: "owner-1",
      state: { displayName: "Owner", typing: false },
    });
    expect(ownerView.map((p) => p.clientId)).toEqual(["owner-1"]);

    // PARTICIPANT publishes via the SHARE route on the SAME wireId topic. The
    // relay maps the share to the granter's workspace, so this lands in the
    // owner's scope — the participant's own response ALREADY shows both peers.
    const memberView = await sharePublish(baseUrl, "member", shareId, wireId, {
      clientId: "member-1",
      state: { displayName: "Member", typing: true },
    });
    expect(memberView.map((p) => p.userId).sort()).toEqual(["member", "owner"]);

    // …and the OWNER, reading its workspace scope, now sees the PARTICIPANT —
    // proving workspace-scope and share-scope resolved to the one relay scope.
    const ownerRead = await poll(baseUrl, "owner", ownerWs, wireId, 0, 0);
    const member = ownerRead.peers.find((p) => p.clientId === "member-1");
    expect(member?.userId).toBe("member");
    expect(member?.state).toMatchObject({ displayName: "Member", typing: true });

    // STRANGER denial: a fully-authenticated non-participant is refused share
    // presence byte-identically to a share that never existed (no oracle).
    const absent = await sharePresenceRaw(baseUrl, "stranger", "never-existed", wireId, {
      clientId: "x",
    });
    const denied = await sharePresenceRaw(baseUrl, "stranger", shareId, wireId, { clientId: "x" });
    expect(absent.status).toBe(404);
    expect([denied.status, denied.body]).toEqual([absent.status, absent.body]);
    // The stranger's rejected probe left the shared scope untouched: still just
    // the owner + the member.
    const afterProbe = await poll(baseUrl, "owner", ownerWs, wireId, 0, 0);
    expect(afterProbe.peers.map((p) => p.userId).sort()).toEqual(["member", "owner"]);
  }, 90_000);

  it("converges owner + participant on a THREAD topic bound to the granted channel, and isolates other/unknown threads", async () => {
    const relayRoot = await tempDir();
    const baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));

    const ownerWs = "workspace-thread";
    const grantedWire = "wire-general";
    const otherWire = "wire-private";
    await claimWorkspace(baseUrl, "owner", ownerWs);
    await appendChannelCreate(baseUrl, "owner", ownerWs, 0, grantedWire);
    await appendChannelCreate(baseUrl, "owner", ownerWs, 1, otherWire);
    // Real thread bindings in the owner's own log: `thread-in` -> the granted
    // channel, `thread-out` -> a DIFFERENT (ungranted) channel. `thread-unknown`
    // is left unbound (no chat.thread.create at all).
    await appendThreadCreate(baseUrl, "owner", ownerWs, 2, "thread-in", grantedWire);
    await appendThreadCreate(baseUrl, "owner", ownerWs, 3, "thread-out", otherWire);
    // Owner grants ONLY the general channel to the participant.
    const shareId = await createChatShare(baseUrl, "owner", ownerWs, "member", grantedWire);

    const threadTopic = "chat:thread:thread-in";
    // OWNER publishes thread presence via the WORKSPACE route (workspace scope).
    const ownerView = await publish(baseUrl, "owner", ownerWs, threadTopic, {
      clientId: "owner-1",
      state: { displayName: "Owner", typing: false },
    });
    expect(ownerView.map((p) => p.clientId)).toEqual(["owner-1"]);

    // PARTICIPANT publishes via the SHARE route on the SAME thread topic. The
    // gate admits it because thread-in binds to the granted channel; the relay
    // maps the share to the granter's workspace, so both land in ONE scope.
    const memberView = await sharePublish(baseUrl, "member", shareId, threadTopic, {
      clientId: "member-1",
      state: { displayName: "Member", typing: true },
    });
    expect(memberView.map((p) => p.userId).sort()).toEqual(["member", "owner"]);

    // …and the OWNER, reading its workspace scope, now sees the PARTICIPANT.
    const ownerRead = await poll(baseUrl, "owner", ownerWs, threadTopic, 0, 0);
    const member = ownerRead.peers.find((p) => p.clientId === "member-1");
    expect(member?.userId).toBe("member");
    expect(member?.state).toMatchObject({ displayName: "Member", typing: true });

    // ISOLATION — a thread bound to a DIFFERENT channel is refused byte-identical
    // to a share that never existed (no oracle that the thread even exists).
    const absent = await sharePresenceRaw(baseUrl, "member", "never-existed", threadTopic, {
      clientId: "x",
    });
    const otherThread = await sharePresenceRaw(
      baseUrl,
      "member",
      shareId,
      "chat:thread:thread-out",
      { clientId: "x" },
    );
    expect(absent.status).toBe(404);
    expect([otherThread.status, otherThread.body]).toEqual([absent.status, absent.body]);

    // ISOLATION — an unbound/unknown thread topic is refused the same way.
    const unknownThread = await sharePresenceRaw(
      baseUrl,
      "member",
      shareId,
      "chat:thread:thread-unknown",
      { clientId: "x" },
    );
    expect([unknownThread.status, unknownThread.body]).toEqual([absent.status, absent.body]);

    // NO REGRESSION — the bare granted channel wire id still converges.
    const channelView = await sharePublish(baseUrl, "member", shareId, grantedWire, {
      clientId: "member-ch",
    });
    expect(channelView.map((p) => p.userId)).toEqual(["member"]);

    // The rejected thread probes left the shared thread scope untouched.
    const afterProbe = await poll(baseUrl, "owner", ownerWs, threadTopic, 0, 0);
    expect(afterProbe.peers.map((p) => p.userId).sort()).toEqual(["member", "owner"]);
  }, 90_000);

  it("a non-owner cannot read another workspace's presence (isolation)", async () => {
    const relayRoot = await tempDir();
    const baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    await claimWorkspace(baseUrl, "owner", "private-ws");
    const r = await fetch(`${baseUrl}/sync/private-ws/presence?topic=general&since=0&hold=0`, {
      method: "GET",
      headers: bearer("intruder"),
    });
    expect(r.status).toBe(404);
  }, 90_000);

  it("a client DISCONNECT releases its parked long-poll waiter promptly", async () => {
    const relayRoot = await tempDir();
    const baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    const ws = "workspace-disconnect";
    await claimWorkspace(baseUrl, "owner", ws);
    await publish(baseUrl, "owner", ws, "general", { clientId: "A", state: {} });
    const current = await poll(baseUrl, "owner", ws, "general", 0, 0);

    // Park a long-poll over a REAL socket, then tear the socket down. The
    // node adapter must propagate the disconnect into the fetch Request's
    // AbortSignal so the hub releases the parked waiter — long before the
    // 20s hold would have expired.
    const controller = new AbortController();
    const parked = fetch(
      `${baseUrl}/sync/${ws}/presence?topic=general&since=${current.version}&hold=20000`,
      { method: "GET", headers: bearer("owner"), signal: controller.signal },
    ).catch(() => undefined);
    await waitForWaiters(baseUrl, 1);
    controller.abort(); // client vanishes mid-park
    // Observe the release BEFORE awaiting `parked`, and inside a budget below the
    // 20s hold. Both matter. Awaiting `parked` first would absorb the whole hold,
    // after which zero waiters is guaranteed however the release happened — and a
    // budget at or above the hold is satisfied by the hold expiring on its own.
    // Either mistake makes this go green when abort propagation is broken.
    await waitForWaiters(baseUrl, 0, 15_000);
    await parked;
  }, 90_000);
});

// Poll the test-seam health endpoint until the hub reports `expected` parked
// waiters (bounded; fails the test with a clear message on timeout).
async function waitForWaiters(
  baseUrl: string,
  expected: number,
  budgetMs = 25_000,
): Promise<void> {
  // 10s lost the race under contention — this polls a real relay child over HTTP,
  // so it is wall-clock bound (#372). 25s by default, and the callers raise their
  // own `it` budget to contain a slow spawn plus two of these waits; a deadline
  // longer than its test budget would be killed before its diagnostic fires.
  //
  // Callers proving something happened BEFORE a server-side timeout must pass a
  // budget shorter than that timeout — see the disconnect test.
  const deadline = Date.now() + budgetMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as {
      presence?: { waiters: number };
    };
    last = health.presence;
    if (health.presence?.waiters === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`relay never reached ${expected} parked waiter(s); last=${JSON.stringify(last)}`);
}
