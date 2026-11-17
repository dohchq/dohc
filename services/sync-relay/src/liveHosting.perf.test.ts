import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { createPostgresCredentialFence } from "@dohc/workspace-auth/credentialFence";
import { WebSocket } from "ws";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import {
  cleanupLiveDeliveryFixtures,
  registered,
} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import { agentAccessCheck, createLinkAuthorityResolver } from "./linkAuthority";
import {
  HELD_OPEN_MAX_PER_AGENT,
  HELD_OPEN_MAX_WAITERS,
  SERVICE_HOST_MAX_WORKSPACES,
} from "./liveHostingLimits";
import { binding, host, fixture as ticketFixture, key, scope } from "./liveTickets.test-helper";
import { singleFlightFenceReads } from "./personalAgents";
import { createLiveConnectionAdmission } from "./liveConnectionAdmission";
import type { NamedFrameNativeHost } from "./namedLiveFrameHost";
import {
  cleanups as namedLiveCleanups,
  fixture as namedLiveFixture,
  openProductionSync,
} from "./namedLiveRoutes.test-helper";
import { personalRouteFixture } from "./personalLiveDocumentRoutes.test-helper";
import { observeRelayWrites } from "./relayWriteChanges";
import { selectHostedDocuments } from "./selfHostedLiveHost";
import { selfHostLiveProfile } from "./selfHostLiveProfile";
import { discoverServiceHostDocuments } from "./serviceHostEnrollmentRoutes";
import { SERVICE_HOST_ENROLLMENTS } from "./storage/serviceHostEnrollment";
import { SHARE_WEB_ORIGIN } from "./testing";
import { chatChannelCreate, chatMessageAppend, chatThreadCreate, sequenced } from "./testing";

// Run with DOHC_LIVE_HOST_MEASURE=1. Each measurement prints one line. The
// fresh-read case also needs Postgres at POSTGRES_URL, or the dev default.

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const close of namedLiveCleanups.splice(0).reverse()) await close();
});
const fixture = (limits?: { maxMs?: number }) =>
  personalRouteFixture(
    (close) => {
      cleanup.push(close);
    },
    limits ? { limits } : {},
  );
const SAMPLES = 21;

function summary(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  return `median=${sorted[10]!.toFixed(3)} p95=${sorted[19]!.toFixed(3)} samples=${SAMPLES}`;
}

it.skipIf(process.env.DOHC_LIVE_HOST_MEASURE !== "1")(
  "measures a host reconciliation's relay reads with 16 attached workspaces while the owner opens and edits live",
  async () => {
    const f = registered();
    cleanup.push(() => {
      f.close();
      cleanupLiveDeliveryFixtures();
    });
    const workspaceId = "workspace",
      ownerUserId = "owner",
      path = f.input.evidence.currentPath;
    f.storage.claimWorkspaceIdentity({
      workspaceId,
      replicationEpoch: "epoch",
      streamIdentity: "stream",
    });
    f.storage.ensureOwnedLiveDocument({
      intent: "share",
      workspaceId,
      ownerUserId,
      shareId: "share",
      path,
      nowMs: 10,
      guard() {},
    });
    const others = SERVICE_HOST_MAX_WORKSPACES - 1;
    f.write((db) => {
      for (let workspace = 0; workspace < others; workspace++) {
        const other = `measure-workspace-${workspace}`;
        db.prepare(`INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity,epoch_log_floor)
        VALUES (?,?,0,'epoch','stream',0)`).run(other, ownerUserId);
        for (let document = 0; document < 4; document++) {
          const objectId = `measure-object-${document}`,
            documentPath = `docs/${document}.md`;
          db.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,'text',1)").run(
            other,
            documentPath,
            "b".repeat(64),
          );
          db.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
          VALUES (?,?,1,?,'main',?,?,'text',1,1)`).run(
            other,
            objectId,
            `moment-${objectId}`,
            documentPath,
            "b".repeat(64),
          );
          db.prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,
          created_at_ms,updated_at_ms,owner_demand,demand_at_ms,accounted_bytes) VALUES (?,?,?,?,NULL,'epoch','stream',1,1,1,1,1,64)`).run(
            other,
            objectId,
            documentPath,
            ownerUserId,
          );
        }
      }
    });
    const select = () => selectHostedDocuments(f.storage, undefined, new Set());
    const documents = others * 4 + 1;
    expect(select().targets).toHaveLength(documents);
    expect(new Set(select().targets.map((row) => row.workspaceId)).size).toBe(
      SERVICE_HOST_MAX_WORKSPACES,
    );
    const idle: number[] = [],
      written: number[] = [],
      opens: number[] = [],
      commits: number[] = [];
    for (let sample = 0; sample < SAMPLES; sample++) {
      let start = performance.now();
      expect(select().targets).toHaveLength(documents);
      idle.push(performance.now() - start);
      start = performance.now();
      f.storage.ensureOwnedLiveDocument({
        intent: "owner-open",
        workspaceId,
        ownerUserId,
        path,
        nowMs: 3_000 + sample,
        guard() {},
      });
      opens.push(performance.now() - start);
      const edit = f.capture(f.update("counter", String(sample)), `measure-${sample}`);
      start = performance.now();
      expect(f.storage.commitLiveUpdateJournal(edit).result.kind).toBe("accepted");
      commits.push(performance.now() - start);
      start = performance.now();
      expect(discoverServiceHostDocuments(f.storage)).toBeNull();
      expect(select().targets).toHaveLength(documents);
      written.push(performance.now() - start);
    }
    const workspaces = SERVICE_HOST_MAX_WORKSPACES;
    console.log(
      `RECONCILE_RELAY_MS workspaces=${workspaces} documents=${documents} since-scan=no-writes reads=selection ${summary(idle)}`,
    );
    console.log(
      `RECONCILE_RELAY_MS workspaces=${workspaces} documents=${documents} since-scan=owner-open-and-live-edit reads=discovery+selection ${summary(written)}`,
    );
    console.log(`OWNER_OPEN_MS workspaces=${workspaces} documents=${documents} ${summary(opens)}`);
    console.log(
      `OWNER_LIVE_COMMIT_MS workspaces=${workspaces} documents=${documents} ${summary(commits)}`,
    );
  },
  600_000,
);

for (const count of [1, 48])
  it.skipIf(process.env.DOHC_LIVE_HOST_MEASURE !== "1")(
    `measures one evaluation of the relay's held opens, waiting on ${count} documents`,
    async () => {
      // Long enough that no hold times out while it is measured.
      const f = await fixture({ maxMs: 600_000 });
      const paths = [binding.currentPath];
      for (let document = 1; document < count; document++) {
        const path = `docs/measure-${document}.md`;
        f.seed(path, `measure-object-${document}`);
        paths.push(path);
      }
      const agents = HELD_OPEN_MAX_WAITERS / HELD_OPEN_MAX_PER_AGENT;
      for (let index = 0; index < agents; index++) {
        const agent = f.agent(`measure-${index}`);
        for (let open = 0; open < HELD_OPEN_MAX_PER_AGENT; open++) {
          void agent.open({
            workspaceId: scope.workspaceId,
            path: paths[(index * HELD_OPEN_MAX_PER_AGENT + open) % count]!,
          });
        }
      }
      await vi.waitFor(
        () => expect(f.route.held()).toEqual({ waiters: HELD_OPEN_MAX_WAITERS, documents: count }),
        { timeout: 60_000 },
      );
      const samples: number[] = [];
      for (let sample = 0; sample < SAMPLES; sample++) {
        const start = performance.now();
        f.route.evaluateWaiting();
        samples.push(performance.now() - start);
      }
      expect(f.route.held()).toEqual({ waiters: HELD_OPEN_MAX_WAITERS, documents: count });
      console.log(
        `HELD_EVALUATE_MS waiters=${HELD_OPEN_MAX_WAITERS} documents=${count} ${summary(samples)}`,
      );
    },
    600_000,
  );

// Each update the host applies reaches every personal session on the
// document, and each session reads its account's fence from Postgres again
// before sending the update to its agent. This measures one owner keystroke
// reaching that many sessions of the owner's agents: the fence reads, by
// primary key in a throwaway schema over a pg pool of main.ts's default size,
// then each connection's check in the relay's SQLite. Left out: the engine
// read before them and the frames after them.
it.skipIf(process.env.DOHC_LIVE_HOST_MEASURE !== "1")(
  "measures the Postgres fresh reads of personal sessions while their owner types, with and without single-flight sharing",
  async ({ skip }) => {
    const url = process.env.POSTGRES_URL ?? "postgres://dohc:dohc@localhost:54329/dohc";
    const probe = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    try {
      await probe.connect();
      await probe.end();
    } catch {
      return skip(`No Postgres at ${url}; start it with pnpm dev:postgres.`);
    }
    const schema = `fresh_read_measure_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    cleanup.push(async () => {
      await pool.query(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
      await pool.end().catch(() => undefined);
    });
    await pool.query(`create schema "${schema}"`);
    const migrations = new URL(
      "../../../packages/workspace-postgres/src/db/migrations/",
      import.meta.url,
    );
    for (const migration of [
      "0001_better_auth.sql",
      "0005_credential_fences.sql",
      "0006_session_created_on_database_clock.sql",
    ]) {
      await pool.query(await readFile(new URL(migration, migrations), "utf8"));
    }
    const owner = "owner-1";
    await pool.query(
      `insert into "user" (id, name, email, "emailVerified") values ($1, $1, $1 || '@example.test', true)`,
      [owner],
    );
    // The owner changed their password once, so each read finds the account's row.
    await pool.query(
      "insert into dohc_credential_fences (user_id, epoch, changed_at) values ($1, 1, now())",
      [owner],
    );
    const fence = createPostgresCredentialFence(pool);
    let queries = 0;
    const readEpoch = (userId: string) => {
      queries++;
      return fence.readEpoch(userId);
    };

    const state = await ticketFixture();
    cleanup.push(() => state.close());
    const resource = `${SHARE_WEB_ORIGIN}/mcp/agent/w/${scope.workspaceId}`;
    const MAX_SESSIONS = 16;
    const requests = Array.from({ length: MAX_SESSIONS }, (_, index) => {
      const name = `measure-${index}`,
        connectionId = `connection-${name}`;
      const agentId = `p-${[...createHash("sha256").update(name).digest()]
        .slice(0, 26)
        .map((byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32])
        .join("")}`;
      const token = createHash("sha256").update(`token-${name}`).digest("base64url");
      const check = agentAccessCheck(token, resource, key)!;
      state.raw
        .prepare(
          "INSERT INTO sync_relay_personal_agents(agent_id,owner_user_id,name,hue,status,epoch,created_at_ms) VALUES (?,?,?,'olive','active',1,0)",
        )
        .run(agentId, owner, name);
      state.raw
        .prepare(`INSERT INTO sync_relay_personal_agent_connections(connection_id,agent_id,owner_user_id,client_id,resource_hash,agent_epoch,fence_epoch,connected_at_ms)
      VALUES (?,?,?,'client',?,1,1,0)`)
        .run(connectionId, agentId, owner, check.resourceHash);
      state.raw
        .prepare(
          "INSERT INTO sync_relay_personal_agent_tokens(token_hash,connection_id,kind,issued_at_ms,expires_at_ms) VALUES (?,?,'access',0,?)",
        )
        .run(check.accessTokenHash, connectionId, 4_000_000_000_000);
      state.raw
        .prepare(
          "INSERT INTO sync_relay_personal_agent_reach(agent_id,workspace_id,level,start_seq) VALUES (?,?,'edit',0)",
        )
        .run(agentId, scope.workspaceId);
      return new Request(`https://relay.test/sync/live/personal?workspaceId=${scope.workspaceId}`, {
        headers: { authorization: `DohcAgent ${token}`, "x-dohc-agent-resource": resource },
      });
    });
    const personalOnly = () => {
      throw new Error("A personal agent never presents a link capability.");
    };
    const resolver = (readFence: (userId: string) => Promise<number>) =>
      createLinkAuthorityResolver({
        storage: state.storage,
        resolveActor: async () => {
          throw new Error("Only personal agents here.");
        },
        publicOrigin: SHARE_WEB_ORIGIN,
        personalAgents: { readFence },
        linkKey: key,
        publicEditRelease: { version: 1 },
        relayExchangeKeyConfigured: true,
        hasValidRelayExchangeKey: () => true,
        nowMs: () => Date.now(),
        requireLinkCapability: personalOnly,
        requireFreshLinkRead: personalOnly,
      });
    const modes = [
      ["direct", resolver(readEpoch)],
      [
        "single-flight",
        resolver(singleFlightFenceReads(readEpoch, () => new Error("The fence read timed out."))),
      ],
    ] as const;
    const authorities = await Promise.all(requests.map((request) => modes[0][1].personal(request)));
    // Open the pool's connections, as a running relay has.
    for (const [, reads] of modes)
      await Promise.all(authorities.map((authority) => reads.freshPersonal(authority)));

    for (const sessions of [1, 4, MAX_SESSIONS]) {
      for (const [mode, reads] of modes) {
        const samples: number[] = [];
        queries = 0;
        for (let sample = 0; sample < SAMPLES; sample++) {
          // Keystrokes arrive apart, so no read for the last one is still running.
          await new Promise((resolve) => setImmediate(resolve));
          const start = performance.now();
          await Promise.all(
            authorities.slice(0, sessions).map((authority) => reads.freshPersonal(authority)),
          );
          samples.push(performance.now() - start);
        }
        const perUpdate = queries / SAMPLES;
        // Sharing answers everyone who asked during the running read with the next one.
        expect(perUpdate).toBe(mode === "direct" ? sessions : Math.min(sessions, 2));
        console.log(
          `PERSONAL_FRESH_READ_MS sessions=${sessions} reads=${mode} queries/update=${perUpdate} ${summary(samples)}`,
        );
      }
    }
  },
  600_000,
);
// 120 members at Edit, 12 on each of 10 documents, each over its own named
// live connection under the shipped profile. One round publishes an applied
// update on all 10 documents at once, and fan-out is the time from the host's
// wake until each connection has the update's first chunk. The native daemon
// is a stand-in that answers each read at once, so its own read and memory
// are left out. Memory is this process's after the connections synced, less
// before, and counts the 120 client sockets as well as the relay's side.
//
// Runs, 2026-11-13, Windows 11, Node 24, 32 cores, after a change woke only
// its own document's connections:
// - Memory: RSS 179 to 186 MiB more, heap 8 to 9 MiB more.
// - All 10 documents change: p50 839 to 1503 ms, p95 1117 to 1664 ms,
//   908 to 1296 ms of CPU a round.
// - Only document 1 changes: p50 87 to 132 ms, p95 126 to 199 ms, 107 to
//   138 ms of CPU a round, and no standing check on another document. Before, the
//   other 108 connections made 2268 checks over the 21 rounds, at p95 225 ms
//   and 180 ms of CPU a round.
// - A Group gets 2 posts a second for 10 s: no post rechecks a connection,
//   and a post settles in p50 5 ms, p95 7 to 33 ms, with 1.6 to 2.4 ms of CPU.
//   Before, each post rechecked all 120, at p50 103 ms, p95 357 ms and
//   110 ms of CPU a post.
// Each delivered update costs its connection 13 standing checks, one for
// each frame sent and received and each feed read. A check reads the
// connection's authority from SQLite, and preparing its statements is about
// half of the CPU. That cost, not the frames, sets the fan-out time.
it.skipIf(process.env.DOHC_LIVE_HOST_MEASURE !== "1")(
  "measures memory and fan-out for 120 named connections over 10 documents",
  async () => {
    const PEOPLE = 120,
      DOCUMENTS = 10,
      ROUNDS = SAMPLES;
    const profile = selfHostLiveProfile(),
      admission = createLiveConnectionAdmission();
    const f = await namedLiveFixture(
      profile.namedLive.transport,
      false,
      { maxSessions: 128, maxMembers: 128, maxSnapshotBytes: 4096 },
      false,
      false,
      admission,
      0,
      0,
      true,
      scope.workspaceId,
      scope.shareId,
      { people: PEOPLE, documents: DOCUMENTS },
    );
    const published = new Map<string, number>();
    const updateBytes = Buffer.alloc(1024, 42),
      updateDigest = createHash("sha256").update(updateBytes).digest("hex");
    f.captureNative.mockImplementation(async (current?: LiveObjectBinding) => {
      const native = { ...current!, selectorPaths: [current!.currentPath] };
      return {
        ...f.native,
        binding: native,
        client: {
          openLiveAppliedSync: async () => ({
            binding: native,
            hostVector: Buffer.from([0]),
            missingStateUpdate: Buffer.from([0, 0]),
            observedLocalYDocHeadSequence: 100,
            position: { eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32) },
          }),
          readNextLiveApplied: async (_request: unknown, after: { eventCount: number }) => {
            const next = after.eventCount + 1;
            if (next > (published.get(native.objectId) ?? 0)) return null;
            return {
              position: { eventCount: next, journalCursor: next, evidenceDigest: "cd".repeat(32) },
              updateBytes,
              ack: {
                deliveryId: `edit-${next}`,
                updateDigest,
                journalCursor: next,
                acceptingHostEpoch: host.hostEpoch,
                localYDocSequence: next,
                applicationReplayed: false,
              },
            };
          },
          readLiveApplicationAck: async () => null,
        },
      } as NamedFrameNativeHost;
    });
    const before = process.memoryUsage();
    const sockets: Array<{ document: number; socket: ReturnType<typeof f.connect> }> = [];
    for (let person = 1; person <= PEOPLE; person++) {
      const document = ((person - 1) % DOCUMENTS) + 1;
      const peer = await f.peer(person, document),
        socket = peer.connect((await peer.mint()).token);
      expect(await socket.status).toBe(101);
      await openProductionSync(f, socket);
      sockets.push({ document, socket });
    }
    const after = process.memoryUsage();
    const arrived = (socket: ReturnType<typeof f.connect>, round: number) => {
      const begin = socket.received.find(
        (frame) =>
          frame.kind === "begin" &&
          frame.purpose === "applied-update" &&
          frame.journalCursor === round,
      );
      return (
        begin !== undefined &&
        begin.kind === "begin" &&
        socket.received.some(
          (frame) => frame.kind === "chunk" && frame.transferId === begin.transferId,
        )
      );
    };
    // Counts each connection's standing check, by the document it is on.
    const reads = new Map<string, number>(),
      resolve = f.storage.resolveCurrentLiveDocumentBinding.bind(f.storage);
    vi.spyOn(f.storage, "resolveCurrentLiveDocumentBinding").mockImplementation(
      (input, activation) => {
        reads.set(input.document.objectId, (reads.get(input.document.objectId) ?? 0) + 1);
        return resolve(input, activation);
      },
    );
    const total = () => [...reads.values()].reduce((sum, count) => sum + count, 0);
    const fanOut: number[] = [],
      rounds: number[] = [];
    let cpu = process.cpuUsage();
    for (let round = 1; round <= ROUNDS; round++) {
      const start = performance.now();
      for (let document = 1; document <= DOCUMENTS; document++)
        published.set(`object-${document}`, round);
      for (let document = 1; document <= DOCUMENTS; document++)
        f.changes.notify({ ...f.binding, objectId: `object-${document}` });
      await Promise.all(
        sockets.map(({ socket }) =>
          socket
            .until(() => arrived(socket, round), `applied update ${round}`)
            .then(() => {
              fanOut.push(performance.now() - start);
            }),
        ),
      );
      rounds.push(performance.now() - start);
    }
    const allCpu = process.cpuUsage(cpu),
      allReads = total();
    // Then only document 1 changes, so 12 connections have the update. The
    // other 108 must not wake.
    const single: number[] = [],
      firsts = sockets.filter(({ document }) => document === 1);
    reads.clear();
    cpu = process.cpuUsage();
    for (let round = ROUNDS + 1; round <= 2 * ROUNDS; round++) {
      const start = performance.now();
      published.set("object-1", round);
      f.changes.notify({ ...f.binding, objectId: "object-1" });
      await Promise.all(
        firsts.map(({ socket }) =>
          socket
            .until(() => arrived(socket, round), `applied update ${round}`)
            .then(() => {
              single.push(performance.now() - start);
            }),
        ),
      );
    }
    const oneCpu = process.cpuUsage(cpu),
      changedReads = reads.get("object-1") ?? 0,
      otherReads = total() - changedReads;
    // Then a busy Group: 2 posts a second for 10 s while all 120 connections
    // stay open. Relay writes reach the connections as the hosts deliver them.
    cleanup.push(observeRelayWrites(f.storage, (documents) => f.changes.notifyWrite(documents)));
    const workspaceId = f.binding.workspaceId,
      originId = "member-desktop",
      threadId = "t".repeat(26);
    const append = (ops: Parameters<typeof sequenced>[0]) =>
      f.storage.appendLogBatch({
        workspaceId,
        originId,
        ops: sequenced(ops, f.storage.maxOriginSeq(workspaceId, originId) + 1).map(
          ({ payload, ...op }) => ({ ...op, payloadJson: JSON.stringify(payload) }),
        ),
      });
    append([
      chatChannelCreate("c".repeat(26), {
        kind: "channel",
        name: "Events",
        type: "both",
        folderPath: "events",
      }),
      chatThreadCreate(threadId, "c".repeat(26)),
    ]);
    const POSTS = 20,
      posts: number[] = [];
    await new Promise((resolve) => setImmediate(resolve));
    reads.clear();
    cpu = process.cpuUsage();
    for (let post = 0; post < POSTS; post++) {
      const start = performance.now();
      append([
        chatMessageAppend(`post-${post}`, threadId, "See you at 6", {
          authorUserId: "reader-1",
          authorDisplayName: "Sam",
        }),
      ]);
      // Every check a post wakes runs before the next macrotask.
      await new Promise((resolve) => setImmediate(resolve));
      const elapsed = performance.now() - start;
      posts.push(elapsed);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 500 - elapsed)));
    }
    const chatCpu = process.cpuUsage(cpu),
      chatReads = total();
    expect(sockets.every(({ socket }) => socket.ws.readyState === WebSocket.OPEN)).toBe(true);
    const sorted = [...fanOut].sort((a, b) => a - b),
      p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
    const MiB = 1024 * 1024;
    console.log(
      `NAMED_LIVE_MEMORY connections=${PEOPLE} documents=${DOCUMENTS} rss-delta-mib=${((after.rss - before.rss) / MiB).toFixed(1)} ` +
        `heap-delta-mib=${((after.heapUsed - before.heapUsed) / MiB).toFixed(1)} external-delta-mib=${((after.external - before.external) / MiB).toFixed(1)} ` +
        `rss-mib=${(after.rss / MiB).toFixed(1)} buffered-bytes=${admission.buffers(profile.namedLive.transport.maxBufferedBytes).usage()}`,
    );
    console.log(
      `NAMED_LIVE_FAN_OUT_MS connections=${PEOPLE} documents=${DOCUMENTS} update-bytes=${updateBytes.length} rounds=${ROUNDS} ` +
        `p50=${p(0.5).toFixed(3)} p95=${p(0.95).toFixed(3)} max=${sorted[sorted.length - 1]!.toFixed(3)} samples=${sorted.length} ` +
        `round-${summary(rounds)} cpu-ms-per-round=${((allCpu.user + allCpu.system) / 1000 / ROUNDS).toFixed(1)} standing-checks-per-delivery=${(allReads / (PEOPLE * ROUNDS)).toFixed(1)}`,
    );
    const one = [...single].sort((a, b) => a - b),
      q = (x: number) => one[Math.min(one.length - 1, Math.floor(one.length * x))]!;
    console.log(
      `NAMED_LIVE_FAN_OUT_ONE_DOCUMENT_MS connections=${PEOPLE} changed-document-connections=${firsts.length} rounds=${ROUNDS} ` +
        `p50=${q(0.5).toFixed(3)} p95=${q(0.95).toFixed(3)} max=${one[one.length - 1]!.toFixed(3)} samples=${one.length} ` +
        `cpu-ms-per-round=${((oneCpu.user + oneCpu.system) / 1000 / ROUNDS).toFixed(1)} standing-checks-changed=${changedReads} standing-checks-other=${otherReads}`,
    );
    const chat = [...posts].sort((a, b) => a - b),
      c = (x: number) => chat[Math.min(chat.length - 1, Math.floor(chat.length * x))]!;
    console.log(
      `NAMED_LIVE_CHAT_POSTS connections=${PEOPLE} posts=${POSTS} posts-per-second=2 rechecks-per-post=${(chatReads / POSTS).toFixed(1)} ` +
        `post-to-settled-ms p50=${c(0.5).toFixed(3)} p95=${c(0.95).toFixed(3)} max=${chat[chat.length - 1]!.toFixed(3)} ` +
        `cpu-ms-per-post=${((chatCpu.user + chatCpu.system) / 1000 / POSTS).toFixed(1)}`,
    );
    expect(sockets.every(({ socket }) => socket.ws.readyState === WebSocket.OPEN)).toBe(true);
    expect(otherReads).toBe(0);
    expect(chatReads).toBe(0);
    expect(allReads / (PEOPLE * ROUNDS)).toBeLessThan(14);
    // About twice the slowest run above.
    expect(p(0.95)).toBeLessThan(3000);
    expect(q(0.95)).toBeLessThan(400);
  },
  600_000,
);
