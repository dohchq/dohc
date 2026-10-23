import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { WorkspaceDaemonRequester } from "@dohc/workspace-engine-client";
import { spawnSyncRelay, type SyncRelayHandle } from "../../e2e/helpers/syncRelay";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions } from "../testing/realDaemonWorkspaceSessions";
import { EngineRelayClient, RelayConfiguredDaemonClientSource, RelayTransportRouteGuard } from "./engineRelayClient";
import { createRelaySyncEngine, type CloudSyncEngine } from "./relaySyncEngine";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";

const engine = requireEngineBinaryOrSkip();
const counts = process.env.DOHC_BULK_SYNC_COUNT
  ? process.env.DOHC_BULK_SYNC_COUNT.split(",").map(Number) : [0];
const label = process.env.DOHC_BULK_SYNC_LABEL ?? "candidate";
const output = resolve(process.env.DOHC_BULK_SYNC_OUTPUT ?? "../../.agent-artifacts/bulk-sync");
const phaseDeadlineMs = 180_000;
const schema = "name: Bulk tasks\nfields:\n  Title:\n    type: text\n  status:\n    type: text\n";

function recordId(index: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let value = index;
  let suffix = "";
  do { suffix = alphabet[value % 32]! + suffix; value = Math.floor(value / 32); } while (value > 0);
  return `rec_${suffix.padStart(26, "a")}`;
}

function recordText(index: number, phase: "create" | "write"): string {
  return phase === "create" ? `---\nid: ${recordId(index)}\n---\n`
    : `---\nid: ${recordId(index)}\nTitle: Task ${index}\nstatus: done\n---\n\nBulk sync write ${index}\n`;
}

interface OwnedProcess { ProcessId: number; Name: string }
function directChildren(): OwnedProcess[] {
  if (process.platform !== "win32") return [];
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${process.pid}' | Where-Object { $_.Name -in @('node.exe','dohc-workspace-engine.exe','baseline-engine.exe','candidate-engine.exe') } | Select-Object ProcessId,Name | ConvertTo-Json -Compress`],
  { encoding: "utf8", windowsHide: true });
  if (!raw.trim()) return [];
  const rows = JSON.parse(raw) as OwnedProcess | OwnedProcess[];
  return Array.isArray(rows) ? rows : [rows];
}

function liveRecordedChildren(children: OwnedProcess[]): OwnedProcess[] {
  return children.filter(({ ProcessId: pid }) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
}

interface Progress {
  captured: number;
  relayed: number;
  indexedRecords: number;
  pendingOps: number;
  pullCursor: number;
  relayCursor: number;
  pushPositions: Array<{ originId: string; localSeq: number; pushedSeq: number }>;
}

function inspect(engineDb: DatabaseSync, relayDb: DatabaseSync, workspaceId: string,
  expected: ReadonlyMap<string, string>): Progress {
  const heads = engineDb.prepare("SELECT path, blob_sha256 AS sha FROM snapshots WHERE workspace_id=? AND version_id='main'")
    .all(workspaceId);
  const files = relayDb.prepare("SELECT f.path,b.content FROM sync_relay_current_files f JOIN sync_relay_blobs b ON b.workspace_id=f.workspace_id AND b.sha256=f.blob_sha256 WHERE f.workspace_id=? AND f.version_id='main'")
    .all(workspaceId);
  const captured = heads.filter(row => typeof row.path === "string" && expected.has(row.path)
    && row.sha === createHash("sha256").update(expected.get(row.path)!).digest("hex")).length;
  const relayed = files.filter(row => typeof row.path === "string" && expected.has(row.path)
    && row.content instanceof Uint8Array
    && Buffer.from(row.content).equals(Buffer.from(expected.get(row.path)!))).length;
  const pushPositions = engineDb.prepare("SELECT l.origin_id AS originId,MAX(l.origin_seq) AS localSeq,COALESCE(p.pushed_seq,-1) AS pushedSeq FROM replication_log l LEFT JOIN sync_relay_push_state p ON p.workspace_id=l.workspace_id AND p.origin_id=l.origin_id WHERE l.workspace_id=? GROUP BY l.origin_id")
    .all(workspaceId) as unknown as Progress["pushPositions"];
  const pendingOps = Number(engineDb.prepare("SELECT COUNT(*) AS n FROM replication_log l LEFT JOIN sync_relay_push_state p ON p.workspace_id=l.workspace_id AND p.origin_id=l.origin_id WHERE l.workspace_id=? AND l.origin_seq>COALESCE(p.pushed_seq,-1)").get(workspaceId)!.n);
  const indexedRecords = engineDb.prepare("SELECT record_id,file_path FROM collection_records WHERE workspace_id=? AND collection_path='tasks' AND index_initialized=1").all(workspaceId)
    .filter(row => typeof row.file_path === "string" && /^tasks\/task-\d+\.md$/.test(row.file_path)
      && row.record_id === recordId(Number(row.file_path.slice(11, -3)))).length;
  const pullCursor = Number(engineDb.prepare("SELECT cursor FROM sync_relay_cursors WHERE workspace_id=?").get(workspaceId)?.cursor ?? 0);
  const relayCursor = Number(relayDb.prepare("SELECT COALESCE(MAX(relay_seq),0) AS n FROM sync_relay_log WHERE workspace_id=?").get(workspaceId)!.n);
  return { captured, relayed, indexedRecords, pendingOps, pullCursor, relayCursor, pushPositions };
}

it.for(counts)("automatically syncs %i valid-id Collection files through create and rewrite", { timeout: 420_000 }, async (count, context) => {
  if (count === 0 || engine.missing) context.skip();
  if (!Number.isSafeInteger(count) || count < 1 || count > 2_000) throw new Error("Invalid bulk fixture count.");
  await mkdir(output, { recursive: true });
  const scratch = await mkdtemp(join(output, `${label}-${count}-fixture-`));
  const rootPath = join(scratch, "workspace");
  const workspaceId = `bulk-${label}-${count}-${process.pid}`;
  const workspace = { workspaceId, rootPath, attachmentId: Symbol("bulk-sync") };
  const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
  const routes = new RelayTransportRouteGuard();
  const sessions = createRealDaemonWorkspaceSessions(new RelayConfiguredDaemonClientSource(lifecycle, routes));
  // The daemon owns real filesystem capture. Like engineRelayClient.e2e, this
  // gate exercises the sync coordinator without desktop editor admission.
  const capture = { runRelaySync: task => task(async paths => { expect(paths).toEqual([]); }) } as WorkspaceEngineCapture;
  const flushCapture = () => sessions.run(workspace, async ({ client, workspace: handle }) =>
    new WorkspaceDaemonRequester(client).request("capture.flush", {}, { workspace: handle }));
  let relay: SyncRelayHandle | undefined;
  let sync: CloudSyncEngine | undefined;
  let engineDb: DatabaseSync | undefined;
  let relayDb: DatabaseSync | undefined;
  let unsubscribe: (() => void) | undefined;
  let children: OwnedProcess[] = [];
  const failures: Array<{ elapsedMs: number; detail: string; attempts: number }> = [];
  let lastFailure = "";
  const pushCalls: Array<{ elapsedMs: number; durationMs: number; pushed?: number; hasMore?: boolean; error?: string }> = [];
  const began = performance.now();
  const evidence: Record<string, unknown> = { label, count, ownerPid: process.pid, binary: engine.require(),
    binarySha256: createHash("sha256").update(await readFile(engine.require())).digest("hex"),
    startedAt: new Date().toISOString(), phaseDeadlineMs, manualRetries: 0, phases: [], pushCalls, failures,
    scope: "Real daemon filesystem watcher, real relay, desktop sync coordinator; no Electron UI or desktop Y.Doc editor admission." };
  let completed = false;
  try {
    await mkdir(join(rootPath, "tasks"), { recursive: true });
    await writeFile(join(rootPath, "tasks", "collection.yaml"), schema);
    relay = await spawnSyncRelay({ dbPath: join(scratch, "relay.sqlite") });
    await lifecycle.start();
    children = directChildren();
    evidence.children = children;
    const client = new EngineRelayClient({ sessions, routes, allowInsecureLoopbackForTests: true })
      .bind({ ...workspace, relay: { baseUrl: relay.baseUrl, token: "test:bulk-sync" } });
    sync = createRelaySyncEngine({ rootDir: rootPath, relay: { baseUrl: relay.baseUrl, token: "test:bulk-sync" }, capture,
      operations: { claim: () => client.claim(), pull: page => client.pull(page), recoverOrigin: () => client.recoverOrigin(),
        push: async () => {
          const start = performance.now();
          try {
            const result = await client.push();
            pushCalls.push({ elapsedMs: start - began, durationMs: performance.now() - start, pushed: result.pushed, hasMore: result.hasMore });
            return result;
          } catch (error) {
            pushCalls.push({ elapsedMs: start - began, durationMs: performance.now() - start, error: String(error) });
            throw error;
          }
        } },
      onChange: () => {
        const failure = sync?.snapshot().syncFailure;
        const key = failure ? `${failure.sinceMs}:${failure.attempts}:${failure.detail}` : "";
        if (failure && key !== lastFailure)
          failures.push({ elapsedMs: performance.now() - began, detail: failure.detail, attempts: failure.attempts });
        lastFailure = key;
      } });
    unsubscribe = lifecycle.onEvent(event => {
      if (event.name !== "capture.momentRecorded") return;
      const payload = event.payload;
      if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.workspaceId === workspaceId) sync?.queueSync();
    });
    const startupDeadline = performance.now() + 30_000;
    for (;;) {
      const flushed = await flushCapture();
      if (flushed && typeof flushed === "object" && !Array.isArray(flushed) && flushed.settled === true) break;
      if (performance.now() > startupDeadline) throw new Error("Initial engine capture did not settle.");
      await new Promise<void>(resolvePoll => setTimeout(resolvePoll, 100));
    }
    await sync.start();
    engineDb = new DatabaseSync(join(rootPath, ".dohc", "engine", "engine.db"), { readOnly: true });
    relayDb = new DatabaseSync(relay.dbPath, { readOnly: true });
    const expected = new Map<string, string>([["tasks/collection.yaml", schema]]);
    const phases: Array<Record<string, unknown>> = [];
    evidence.phases = phases;
    const beforeBulk = inspect(engineDb, relayDb, workspaceId, expected);
    expect(beforeBulk.pendingOps).toBe(0);
    expect(beforeBulk.pullCursor).toBe(beforeBulk.relayCursor);
    evidence.beforeBulk = { ...beforeBulk, snapshot: sync.snapshot() };
    const bulkStart = performance.now();
    for (const phase of ["create", "write"] as const) {
      const phaseStart = performance.now();
      for (let from = 0; from < count; from += 32) {
        await Promise.all(Array.from({ length: Math.min(32, count - from) }, async (_, offset) => {
          const index = from + offset;
          const path = `tasks/task-${index.toString().padStart(4, "0")}.md`;
          const text = recordText(index, phase);
          expected.set(path, text);
          await writeFile(join(rootPath, path), text);
        }));
      }
      const writeMs = performance.now() - phaseStart;
      phases.push({ phase, writeMs, elapsedMs: performance.now() - bulkStart,
        progress: inspect(engineDb, relayDb, workspaceId, expected) });
    }
    let captureMs: number | null = null;
    let relayMs: number | null = null;
    let progress = inspect(engineDb, relayDb, workspaceId, expected);
    while (performance.now() - bulkStart < phaseDeadlineMs) {
      progress = inspect(engineDb, relayDb, workspaceId, expected);
      const elapsed = performance.now() - bulkStart;
      if (captureMs === null && progress.captured === expected.size && progress.indexedRecords === count) captureMs = elapsed;
      if (relayMs === null && progress.relayed === expected.size) relayMs = elapsed;
      const snapshot = sync.snapshot();
      completed = captureMs !== null && relayMs !== null && progress.pendingOps === 0
        && progress.pullCursor === progress.relayCursor && !snapshot.syncing
        && snapshot.pendingChangeCount === 0 && snapshot.syncFailure === null;
      if (completed) break;
      await new Promise<void>(resolvePoll => setTimeout(resolvePoll, 100));
    }
    evidence.captureFlush = await flushCapture();
    evidence.result = { captureMs, relayMs, completeMs: completed ? performance.now() - bulkStart : null,
      progress, snapshot: sync.snapshot() };
    evidence.completed = completed;
    console.log(`BULK_SYNC ${label} ${count} ${JSON.stringify(evidence.result)}`);
  } catch (error) {
    evidence.error = String(error);
    throw error;
  } finally {
    unsubscribe?.();
    engineDb?.close();
    relayDb?.close();
    await sync?.stop();
    await sessions.closeAll();
    await lifecycle.stop();
    await relay?.stop();
    const remaining = liveRecordedChildren(children);
    evidence.remainingChildren = remaining;
    evidence.finishedAt = new Date().toISOString();
    evidence.relayDiagnostics = relay?.diagnostics();
    await writeFile(join(output, `${label}-${count}.json`), JSON.stringify(evidence, null, 2));
    if (dirname(scratch) !== output || !scratch.startsWith(join(output, `${label}-${count}-fixture-`))) throw new Error("Unexpected fixture cleanup path.");
    await rm(scratch, { recursive: true, force: true });
    expect(remaining).toEqual([]);
  }
  expect(completed).toBe(true);
  expect(evidence.captureFlush).toMatchObject({ deferredWrites: [], settled: true, running: true, degraded: false });
  if (label === "candidate") expect(failures).toEqual([]);
});
