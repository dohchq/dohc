import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ShareUnavailableError,
  claimRelayWorkspace,
  createLinkedChatStore,
  fetchSharedChannelInfo,
  pullSharedChannel,
  pullWorkspaceFromRelay,
  pushSharedChannel,
  pushWorkspaceToRelay,
} from "@dohc/workspace-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// WS-MU-C3 end-to-end over a REAL relay child process: Alice (owner) and Bob
// (participant) exchange DM messages and a reaction and converge, while Carol —
// a fully authenticated non-participant — is denied byte-identically to a share
// that never existed on every surface. A DM rides MU-C4's shared-channel lane
// UNCHANGED: the owner pushes through her normal workspace bucket, the
// participant joins via fetchSharedChannelInfo + pullSharedChannel and replies
// via ordinary sendMessage + pushSharedChannel. This is the lane's BLOCKING
// isolation gate against the real HTTP relay, not an in-process handler.

const WS = "workspace-dm-it";
const ALICE = "alice";
const BOB = "bob";
const CAROL = "carol";
// Bob's workspace bucket is his own; the DM's canonical log lives in Alice's.
const WS_BOB = "workspace-dm-it-bob";

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
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
          child.once("close", () => {
            clearTimeout(forceKill);
            resolve();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

class ListenPermissionError extends Error {
  constructor(stderr: string) {
    super(`loopback listen denied by test environment\n${stderr}`);
  }
}

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dohc-dm-it-${label}-`));
  roots.push(root);
  return root;
}

function packageRoot(): string {
  return fileURLToPath(new URL("../", import.meta.url));
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
    const timeout = setTimeout(() => {
      reject(new Error(`sync relay did not report a port\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15_000);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      const match = /SYNC_RELAY_LISTENING host=([^\s]+) port=(\d+)/u.exec(stdout);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://${match[1]}:${match[2]}`);
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (/listen EPERM/u.test(stderr)) {
        reject(new ListenPermissionError(stderr));
        return;
      }
      reject(new Error(`sync relay exited early (${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

function relayFor(baseUrl: string, userId: string) {
  return { baseUrl, token: `test:${userId}` };
}

async function relayJson(
  baseUrl: string,
  userId: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string }> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer test:${userId}`);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  return { status: response.status, body: await response.text() };
}

describe("DM over a live relay (MU-C3 integration)", () => {
  it("converges a two-participant DM and denies a non-participant byte-identically", async (context) => {
    const relayRoot = await tempRoot("relay");
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }
    const human = (displayName: string) => ({ kind: "human" as const, displayName });

    // ---- Alice (owner): a DM channel + running thread + first message ----
    const aliceRoot = await tempRoot("alice");
    const aliceStore = createLinkedChatStore(aliceRoot);
    await claimRelayWorkspace({ workspaceId: WS, relay: relayFor(baseUrl, ALICE) });
    const dmChannel = await aliceStore.createChannel({
      workspaceId: WS,
      name: `${BOB}@dohc.test`,
      kind: "dm",
    });
    const started = await aliceStore.startChannelThread({
      workspaceId: WS,
      channelId: dmChannel.id,
      author: human("Alice"),
      authorUserId: ALICE,
      body: "hello bob",
    });
    const wireId = await aliceStore.getChannelWireId({
      workspaceId: WS,
      channelId: dmChannel.id,
    });
    expect(wireId).toBeTruthy();
    await pushWorkspaceToRelay({ rootDir: aliceRoot, workspaceId: WS, relay: relayFor(baseUrl, ALICE) });

    // The DM grant: a chat-channel share addressed to Bob by email, FLAT body
    // (matches shareChatChannel — the relay branches on the top-level
    // channelWireId).
    const grant = await relayJson(baseUrl, ALICE, `/sync/${WS}/shares`, {
      method: "POST",
      body: JSON.stringify({
        recipientEmail: `${BOB}@dohc.test`,
        channelWireId: wireId,
        access: "read-write",
      }),
    });
    expect(grant.status).toBe(200);
    const shareId = (JSON.parse(grant.body) as { shareId: string }).shareId;

    // ---- Bob (participant): discover, join (pull), converge ----
    const bobRoot = await tempRoot("bob");
    const info = await fetchSharedChannelInfo({ relay: relayFor(baseUrl, BOB), shareId });
    expect(info).toMatchObject({
      shareId,
      channelWireId: wireId,
      access: "read-write",
      granterEmail: `${ALICE}@dohc.test`,
    });
    const bobPull = await pullSharedChannel({
      rootDir: bobRoot,
      workspaceId: WS_BOB,
      relay: relayFor(baseUrl, BOB),
      shareId,
      channelWireId: wireId!,
    });
    expect(bobPull.applied).toBeGreaterThanOrEqual(3);

    const bobStore = createLinkedChatStore(bobRoot);
    try {
      // The DM channel materialized as a DM (kind preserved across the share).
      const bobChannel = (await bobStore.listChannels({ workspaceId: WS_BOB })).find(
        (channel) => channel.kind === "dm",
      );
      expect(bobChannel?.kind).toBe("dm");
      const bobMessages = await bobStore.listMessages({
        workspaceId: WS_BOB,
        threadId: started.thread.id,
      });
      expect(bobMessages.map((m) => [m.body, m.authorUserId])).toEqual([["hello bob", ALICE]]);

      // ---- Bob replies through ordinary sendMessage + setReaction, then the
      // member push (pushSharedChannel scans his local journal). ----
      await bobStore.sendMessage({
        workspaceId: WS_BOB,
        threadId: started.thread.id,
        author: human("Bob"),
        authorUserId: BOB,
        body: "hi alice",
      });
      await bobStore.setReaction({
        workspaceId: WS_BOB,
        threadId: started.thread.id,
        messageId: started.message.id,
        emoji: "👍",
        author: { authorId: BOB, kind: "human", displayName: "Bob" },
        state: "added",
      });
    } finally {
      await bobStore.close();
    }
    const pushed = await pushSharedChannel({
      rootDir: bobRoot,
      workspaceId: WS_BOB,
      relay: relayFor(baseUrl, BOB),
      shareId,
      channelWireId: wireId!,
    });
    expect(pushed.pushed).toBe(2); // message + reaction

    // ---- Alice pulls her own bucket and sees Bob's authored ops ----
    const alicePull = await pullWorkspaceFromRelay({
      rootDir: aliceRoot,
      workspaceId: WS,
      relay: relayFor(baseUrl, ALICE),
    });
    await alicePull.commitFetchCursor();
    const aliceMessages = await aliceStore.listMessages({
      workspaceId: WS,
      threadId: started.thread.id,
    });
    expect(aliceMessages.map((m) => [m.body, m.authorUserId])).toEqual([
      ["hello bob", ALICE],
      ["hi alice", BOB],
    ]);
    const aliceReactions = await aliceStore.listReactions({
      workspaceId: WS,
      threadId: started.thread.id,
    });
    expect(aliceReactions).toHaveLength(1);
    expect(aliceReactions[0]).toMatchObject({ emoji: "👍", author: { authorId: BOB } });

    // Alice's next PUSH must not wedge on Bob's authored ops (the relay verifies
    // author === pusher; relay-learned foreign origins are watermarked).
    await expect(
      pushWorkspaceToRelay({ rootDir: aliceRoot, workspaceId: WS, relay: relayFor(baseUrl, ALICE) }),
    ).resolves.toBeTruthy();

    // ---- Bob pulls again: his own ops echo back idempotently ----
    const bobIdle = await pullSharedChannel({
      rootDir: bobRoot,
      workspaceId: WS_BOB,
      relay: relayFor(baseUrl, BOB),
      shareId,
      channelWireId: wireId!,
    });
    // Bob's own echoes skip; nothing new to apply.
    expect(bobIdle.applied).toBe(0);
    const bobStore2 = createLinkedChatStore(bobRoot);
    try {
      const bobConverged = await bobStore2.listMessages({
        workspaceId: WS_BOB,
        threadId: started.thread.id,
      });
      expect(bobConverged.map((m) => m.body)).toEqual(["hello bob", "hi alice"]);
      expect(
        await bobStore2.listReactions({ workspaceId: WS_BOB, threadId: started.thread.id }),
      ).toHaveLength(1);
    } finally {
      await bobStore2.close();
    }

    // ---- Carol (non-participant, fully authenticated): BLOCKING isolation ----
    // Carol's append probe carries NO originId — she 404s at shareForRecipient
    // before any body/originId parse, byte-identical to an absent share.
    const absentMeta = await relayJson(baseUrl, CAROL, "/sync/shares/never-existed");
    const absentLog = await relayJson(baseUrl, CAROL, "/sync/shares/never-existed/log?since=0");
    const absentAppend = await relayJson(baseUrl, CAROL, "/sync/shares/never-existed/log", {
      method: "POST",
      body: JSON.stringify({ ops: [] }),
    });
    expect(absentMeta.status).toBe(404);
    const probeMeta = await relayJson(baseUrl, CAROL, `/sync/shares/${shareId}`);
    const probeLog = await relayJson(baseUrl, CAROL, `/sync/shares/${shareId}/log?since=0`);
    const probeAppend = await relayJson(baseUrl, CAROL, `/sync/shares/${shareId}/log`, {
      method: "POST",
      body: JSON.stringify({
        ops: [
          {
            opKind: "chat.message.append",
            payload: {
              messageId: "carol-1",
              threadId: started.thread.id,
              authorKind: "human",
              authorDisplayName: "Carol",
              authorUserId: CAROL,
              body: "let me in",
              createdAtMs: 1,
            },
            recordedAtMs: 1,
          },
        ],
      }),
    });
    expect([probeMeta.status, probeMeta.body]).toEqual([absentMeta.status, absentMeta.body]);
    expect([probeLog.status, probeLog.body]).toEqual([absentLog.status, absentLog.body]);
    expect([probeAppend.status, probeAppend.body]).toEqual([absentAppend.status, absentAppend.body]);
    // The DM is invisible in Carol's listings, and Alice's bucket itself is the
    // same generic 404 as any workspace Carol does not own.
    const carolShares = await relayJson(baseUrl, CAROL, "/sync/shares");
    expect(JSON.parse(carolShares.body)).toMatchObject({ granted: [], received: [] });
    const carolBucket = await relayJson(baseUrl, CAROL, `/sync/${WS}/log?since=0`);
    expect(carolBucket.status).toBe(404);
    // Carol's probe changed NOTHING: the DM still has exactly two messages.
    expect(
      (await aliceStore.listMessages({ workspaceId: WS, threadId: started.thread.id })).length,
    ).toBe(2);

    // ---- Revocation: Bob's access closes cleanly on the next fetch ----
    const revoke = await relayJson(baseUrl, ALICE, `/sync/shares/${shareId}/revoke`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(revoke.status).toBe(200);
    await expect(
      pullSharedChannel({
        rootDir: bobRoot,
        workspaceId: WS_BOB,
        relay: relayFor(baseUrl, BOB),
        shareId,
        channelWireId: wireId!,
      }),
    ).rejects.toBeInstanceOf(ShareUnavailableError);
    // A push with pending local ops fails closed too (seed one so the push
    // actually reaches the network).
    const bobStore3 = createLinkedChatStore(bobRoot);
    try {
      await bobStore3.sendMessage({
        workspaceId: WS_BOB,
        threadId: started.thread.id,
        author: human("Bob"),
        authorUserId: BOB,
        body: "after revoke",
      });
    } finally {
      await bobStore3.close();
    }
    await expect(
      pushSharedChannel({
        rootDir: bobRoot,
        workspaceId: WS_BOB,
        relay: relayFor(baseUrl, BOB),
        shareId,
        channelWireId: wireId!,
      }),
    ).rejects.toBeInstanceOf(ShareUnavailableError);
    // The revoked DM vanishes from Bob's received listing; what he already
    // replayed stays local (he legitimately saw it).
    const bobReceived = await relayJson(baseUrl, BOB, "/sync/shares");
    expect(JSON.parse(bobReceived.body).received).toEqual([]);

    await aliceStore.close();
  }, 120_000);
});
