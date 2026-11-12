import { afterEach, expect, it, vi } from "vitest";
import { HELD_OPEN_MAX_PER_AGENT, HELD_OPEN_MAX_WAITERS, SERVICE_HOST_MAX_WORKSPACES } from "./liveHostingLimits";
import { binding, scope } from "./liveTickets.test-helper";
import { personalRouteFixture } from "./personalLiveDocumentRoutes.test-helper";
import type { SyncRelayStorage } from "./storage";
import { SERVICE_HOST_ENROLLMENTS } from "./storage/serviceHostEnrollment";

// Run with DOHC_LIVE_HOST_MEASURE=1. Each case prints one line.

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

// The relay reads a host reconciliation makes to select what it hosts: the
// enrollments, then each one's cover, retirement, owner, identity and path.
function selectionReads(storage: SyncRelayStorage): number {
  let targets = 0;
  for (const row of storage.listUndrainedServiceHostEnrollments().documents) {
    const departs = row.retired || !storage.serviceHostEnrollmentCovered(row) || row.ownerStop !== null || storage.serviceActivationRetirement(row) !== null;
    const matching = storage.workspaceIsOwnedBy(row.workspaceId, row.ownerUserId) && storage.verifyWorkspaceIdentity(row) === "matched";
    if (!departs && matching && storage.objectIdAtPathInVersion({ workspaceId: row.workspaceId, versionId: "main", path: row.path }) === row.objectId) targets++;
  }
  return targets;
}

it.skipIf(process.env.DOHC_LIVE_HOST_MEASURE !== "1")("measures a host reconciliation's selection with 16 workspaces while one agent opens and edits", async () => {
  const f = await fixture();
  // Fifteen more workspaces of four documents each, hosted at their owner's demand.
  const others = SERVICE_HOST_MAX_WORKSPACES - 1;
  for (let workspace = 0; workspace < others; workspace++) {
    const workspaceId = `measure-workspace-${workspace}`;
    f.raw.prepare(`INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity,epoch_log_floor)
      VALUES (?,'owner-1',0,'epoch','stream',0)`).run(workspaceId);
    for (let document = 0; document < 4; document++) {
      const objectId = `measure-object-${document}`, path = `docs/${document}.md`;
      f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,'text',1)").run(workspaceId, path, "b".repeat(64));
      f.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
        VALUES (?,?,1,?,'main',?,?,'text',1,1)`).run(workspaceId, objectId, `moment-${objectId}`, path, "b".repeat(64));
      f.raw.prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,
        created_at_ms,updated_at_ms,owner_demand,demand_at_ms,accounted_bytes) VALUES (?,?,?,'owner-1',NULL,'epoch','stream',1,1,1,1,1,64)`).run(workspaceId, objectId, path);
    }
  }
  f.ready();
  const agent = f.agent("measure");
  expect((await agent.open()).status).toBe(200);
  const documents = f.storage.listUndrainedServiceHostEnrollments().documents.length;
  const idle: number[] = [], busy: number[] = [], opens: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    let start = performance.now();
    selectionReads(f.storage);
    idle.push(performance.now() - start);
    // The agent opens docs/a.md again and edits it, which renews its demand.
    start = performance.now();
    const response = await agent.open();
    f.storage.renewPersonalSessionDemand({ workspaceId: scope.workspaceId, objectId: binding.objectId, nowMs: 3_000 + sample });
    opens.push(performance.now() - start);
    expect(response.status).toBe(200);
    start = performance.now();
    selectionReads(f.storage);
    busy.push(performance.now() - start);
  }
  const workspaces = others + 1;
  console.log(`RECONCILE_SELECT_MS workspaces=${workspaces} documents=${documents} agent=idle ${summary(idle)}`);
  console.log(`RECONCILE_SELECT_MS workspaces=${workspaces} documents=${documents} agent=after-open-and-edit ${summary(busy)}`);
  console.log(`PERSONAL_OPEN_MS workspaces=${workspaces} documents=${documents} answer=ready ${summary(opens)}`);
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
