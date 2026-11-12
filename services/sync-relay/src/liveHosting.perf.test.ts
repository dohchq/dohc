import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { createPostgresCredentialFence } from "@dohc/workspace-auth/credentialFence";
import { cleanupLiveDeliveryFixtures, registered } from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import { agentAccessCheck, createLinkAuthorityResolver } from "./linkAuthority";
import { HELD_OPEN_MAX_PER_AGENT, HELD_OPEN_MAX_WAITERS, SERVICE_HOST_MAX_WORKSPACES } from "./liveHostingLimits";
import { binding, fixture as ticketFixture, key, scope } from "./liveTickets.test-helper";
import { singleFlightFenceReads } from "./personalAgents";
import { personalRouteFixture } from "./personalLiveDocumentRoutes.test-helper";
import { selectHostedDocuments } from "./selfHostedLiveHost";
import { discoverServiceHostDocuments } from "./serviceHostEnrollmentRoutes";
import { SERVICE_HOST_ENROLLMENTS } from "./storage/serviceHostEnrollment";
import { SHARE_WEB_ORIGIN } from "./testing";

// Run with DOHC_LIVE_HOST_MEASURE=1. Each measurement prints one line. The
// fresh-read case also needs Postgres at POSTGRES_URL, or the dev default.

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const fixture = (limits?: { maxMs?: number }) => personalRouteFixture(close => { cleanup.push(close); }, limits ? { limits } : {});
const SAMPLES = 21;

function summary(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  return `median=${sorted[10]!.toFixed(3)} p95=${sorted[19]!.toFixed(3)} samples=${SAMPLES}`;
}

// A host reconciliation reads the relay through two production calls: one
// page of discovery when the relay was written since its last scan, then the
// selection. Left out: the 100 ms the host waits to gather changes, the
// membership update to the native daemon with the store folders it makes, and
// the running daemon's answers for each document (blocked, retained, drained).
it.skipIf(process.env.DOHC_LIVE_HOST_MEASURE !== "1")("measures a host reconciliation's relay reads with 16 attached workspaces while the owner opens and edits live", async () => {
  const f = registered();
  cleanup.push(() => { f.close(); cleanupLiveDeliveryFixtures(); });
  const workspaceId = "workspace", ownerUserId = "owner", path = f.input.evidence.currentPath;
  f.storage.claimWorkspaceIdentity({ workspaceId, replicationEpoch: "epoch", streamIdentity: "stream" });
  f.storage.ensureOwnedLiveDocument({ intent: "share", workspaceId, ownerUserId, shareId: "share", path, nowMs: 10, guard() {} });
  // Fifteen more workspaces of four documents each, hosted at their owner's demand.
  const others = SERVICE_HOST_MAX_WORKSPACES - 1;
  f.write(db => {
    for (let workspace = 0; workspace < others; workspace++) {
      const other = `measure-workspace-${workspace}`;
      db.prepare(`INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity,epoch_log_floor)
        VALUES (?,?,0,'epoch','stream',0)`).run(other, ownerUserId);
      for (let document = 0; document < 4; document++) {
        const objectId = `measure-object-${document}`, documentPath = `docs/${document}.md`;
        db.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,'text',1)").run(other, documentPath, "b".repeat(64));
        db.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
          VALUES (?,?,1,?,'main',?,?,'text',1,1)`).run(other, objectId, `moment-${objectId}`, documentPath, "b".repeat(64));
        db.prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,
          created_at_ms,updated_at_ms,owner_demand,demand_at_ms,accounted_bytes) VALUES (?,?,?,?,NULL,'epoch','stream',1,1,1,1,1,64)`).run(other, objectId, documentPath, ownerUserId);
      }
    }
  });
  const select = () => selectHostedDocuments(f.storage, undefined, new Set());
  const documents = others * 4 + 1;
  expect(select().targets).toHaveLength(documents);
  expect(new Set(select().targets.map(row => row.workspaceId)).size).toBe(SERVICE_HOST_MAX_WORKSPACES);
  const idle: number[] = [], written: number[] = [], opens: number[] = [], commits: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    let start = performance.now();
    expect(select().targets).toHaveLength(documents);
    idle.push(performance.now() - start);
    // The owner opens the document again, and the relay admits a live edit of theirs through the journal.
    start = performance.now();
    f.storage.ensureOwnedLiveDocument({ intent: "owner-open", workspaceId, ownerUserId, path, nowMs: 3_000 + sample, guard() {} });
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
  console.log(`RECONCILE_RELAY_MS workspaces=${workspaces} documents=${documents} since-scan=no-writes reads=selection ${summary(idle)}`);
  console.log(`RECONCILE_RELAY_MS workspaces=${workspaces} documents=${documents} since-scan=owner-open-and-live-edit reads=discovery+selection ${summary(written)}`);
  console.log(`OWNER_OPEN_MS workspaces=${workspaces} documents=${documents} ${summary(opens)}`);
  console.log(`OWNER_LIVE_COMMIT_MS workspaces=${workspaces} documents=${documents} ${summary(commits)}`);
}, 600_000);

for (const count of [1, 48]) it.skipIf(process.env.DOHC_LIVE_HOST_MEASURE !== "1")(`measures one evaluation of the relay's held opens, waiting on ${count} documents`, async () => {
  // Long enough that no hold times out while it is measured.
  const f = await fixture({ maxMs: 600_000 });
  const paths = [binding.currentPath];
  for (let document = 1; document < count; document++) {
    const path = `docs/measure-${document}.md`;
    f.seed(path, `measure-object-${document}`);
    paths.push(path);
  }
  // Each agent holds its limit, until the relay holds its limit.
  const agents = HELD_OPEN_MAX_WAITERS / HELD_OPEN_MAX_PER_AGENT;
  for (let index = 0; index < agents; index++) {
    const agent = f.agent(`measure-${index}`);
    for (let open = 0; open < HELD_OPEN_MAX_PER_AGENT; open++) {
      void agent.open({ workspaceId: scope.workspaceId, path: paths[(index * HELD_OPEN_MAX_PER_AGENT + open) % count]! });
    }
  }
  await vi.waitFor(() => expect(f.route.held()).toEqual({ waiters: HELD_OPEN_MAX_WAITERS, documents: count }), { timeout: 60_000 });
  const samples: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const start = performance.now();
    f.route.evaluateWaiting();
    samples.push(performance.now() - start);
  }
  // No evaluation answered any of them.
  expect(f.route.held()).toEqual({ waiters: HELD_OPEN_MAX_WAITERS, documents: count });
  console.log(`HELD_EVALUATE_MS waiters=${HELD_OPEN_MAX_WAITERS} documents=${count} ${summary(samples)}`);
}, 600_000);

// Each update the host applies reaches every personal session on the
// document, and each session reads its account's fence from Postgres again
// before sending the update to its agent. This measures one owner keystroke
// reaching that many sessions of the owner's agents: the fence reads, by
// primary key in a throwaway schema over a pg pool of main.ts's default size,
// then each connection's check in the relay's SQLite. Left out: the engine
// read before them and the frames after them.
it.skipIf(process.env.DOHC_LIVE_HOST_MEASURE !== "1")("measures the Postgres fresh reads of personal sessions while their owner types, with and without single-flight sharing", async ({ skip }) => {
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
  const migrations = new URL("../../../packages/workspace-postgres/src/db/migrations/", import.meta.url);
  for (const migration of ["0001_better_auth.sql", "0005_credential_fences.sql", "0006_session_created_on_database_clock.sql"]) {
    await pool.query(await readFile(new URL(migration, migrations), "utf8"));
  }
  const owner = "owner-1";
  await pool.query(`insert into "user" (id, name, email, "emailVerified") values ($1, $1, $1 || '@example.test', true)`, [owner]);
  // The owner changed their password once, so each read finds the account's row.
  await pool.query("insert into dohc_credential_fences (user_id, epoch, changed_at) values ($1, 1, now())", [owner]);
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
  // The owner's agents, each signed in at fence 1 and editing the document in its own session.
  const requests = Array.from({ length: MAX_SESSIONS }, (_, index) => {
    const name = `measure-${index}`, connectionId = `connection-${name}`;
    const agentId = `p-${[...createHash("sha256").update(name).digest()].slice(0, 26).map(byte => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32]).join("")}`;
    const token = createHash("sha256").update(`token-${name}`).digest("base64url");
    const check = agentAccessCheck(token, resource, key)!;
    state.raw.prepare("INSERT INTO sync_relay_personal_agents(agent_id,owner_user_id,name,hue,status,epoch,created_at_ms) VALUES (?,?,?,'olive','active',1,0)")
      .run(agentId, owner, name);
    state.raw.prepare(`INSERT INTO sync_relay_personal_agent_connections(connection_id,agent_id,owner_user_id,client_id,resource_hash,agent_epoch,fence_epoch,connected_at_ms)
      VALUES (?,?,?,'client',?,1,1,0)`).run(connectionId, agentId, owner, check.resourceHash);
    state.raw.prepare("INSERT INTO sync_relay_personal_agent_tokens(token_hash,connection_id,kind,issued_at_ms,expires_at_ms) VALUES (?,?,'access',0,?)")
      .run(check.accessTokenHash, connectionId, 4_000_000_000_000);
    state.raw.prepare("INSERT INTO sync_relay_personal_agent_reach(agent_id,workspace_id,level,start_seq) VALUES (?,?,'edit',0)").run(agentId, scope.workspaceId);
    return new Request(`https://relay.test/sync/live/personal?workspaceId=${scope.workspaceId}`, {
      headers: { authorization: `DohcAgent ${token}`, "x-dohc-agent-resource": resource },
    });
  });
  const personalOnly = () => { throw new Error("A personal agent never presents a link capability."); };
  const resolver = (readFence: (userId: string) => Promise<number>) => createLinkAuthorityResolver({
    storage: state.storage, personalAgents: { readFence }, linkKey: key, publicEditRelease: { version: 1 },
    relayExchangeKeyConfigured: true, hasValidRelayExchangeKey: () => true, nowMs: () => Date.now(),
    requireLinkCapability: personalOnly, requireFreshLinkRead: personalOnly,
  });
  const modes = [["direct", resolver(readEpoch)], ["single-flight", resolver(singleFlightFenceReads(readEpoch, () => new Error("The fence read timed out.")))]] as const;
  const authorities = await Promise.all(requests.map(request => modes[0][1].personal(request)));
  // Open the pool's connections, as a running relay has.
  for (const [, reads] of modes) await Promise.all(authorities.map(authority => reads.freshPersonal(authority)));

  for (const sessions of [1, 4, MAX_SESSIONS]) {
    for (const [mode, reads] of modes) {
      const samples: number[] = [];
      queries = 0;
      for (let sample = 0; sample < SAMPLES; sample++) {
        // Keystrokes arrive apart, so no read for the last one is still running.
        await new Promise(resolve => setImmediate(resolve));
        const start = performance.now();
        await Promise.all(authorities.slice(0, sessions).map(authority => reads.freshPersonal(authority)));
        samples.push(performance.now() - start);
      }
      const perUpdate = queries / SAMPLES;
      // Sharing answers everyone who asked during the running read with the next one.
      expect(perUpdate).toBe(mode === "direct" ? sessions : Math.min(sessions, 2));
      console.log(`PERSONAL_FRESH_READ_MS sessions=${sessions} reads=${mode} queries/update=${perUpdate} ${summary(samples)}`);
    }
  }
}, 600_000);
