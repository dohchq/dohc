import { afterEach, expect, it, vi } from "vitest";
import { cleanupLiveDeliveryFixtures, registered } from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import { HELD_OPEN_MAX_PER_AGENT, HELD_OPEN_MAX_WAITERS, SERVICE_HOST_MAX_WORKSPACES } from "./liveHostingLimits";
import { binding, scope } from "./liveTickets.test-helper";
import { personalRouteFixture } from "./personalLiveDocumentRoutes.test-helper";
import { selectHostedDocuments } from "./selfHostedLiveHost";
import { discoverServiceHostDocuments } from "./serviceHostEnrollmentRoutes";
import { SERVICE_HOST_ENROLLMENTS } from "./storage/serviceHostEnrollment";

// Run with DOHC_LIVE_HOST_MEASURE=1. Each measurement prints one line.

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
