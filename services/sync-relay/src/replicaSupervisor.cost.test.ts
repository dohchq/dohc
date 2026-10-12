import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import { closeTestStorages, tempRoot, testHandler, testStorage } from "./testing";
import { createReplicaSupervisor } from "./replicaSupervisor";
import { createReplicaEngineStarter } from "./replicaEngine";
import { REPLICA_READ_PREFIX } from "./replicaReadPrincipal";

const executable = process.env.REPLICA_SUPERVISOR_ENGINE;
afterEach(closeTestStorages);
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samplesMs: values, medianMs: (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]! };
};

it.skipIf(!executable || !process.env.REPLICA_SUPERVISOR_COST)("measures idle work, eviction, and paired owner push latency", async () => {
  const evidence = process.env.REPLICA_SUPERVISOR_EVIDENCE ?? resolve("../../.agent-artifacts/replica-supervisor");
  mkdirSync(evidence, { recursive: true });
  const storage = await testStorage(), root = await tempRoot("latency"), workspaceId = "latency", ownerUserId = "cost-owner@dohc.test";
  storage.claimWorkspace({ workspaceId, ownerUserId, createdAtMs: 1 });
  storage.claimWorkspaceIdentity({ workspaceId, replicationEpoch: "epoch", streamIdentity: "stream" });
  storage.createShare({ share: { shareId: workspaceId, workspaceId, granterUserId: ownerUserId, selectorJson: "{}", createdAtMs: 1 },
    grant: { grantId: workspaceId, shareId: workspaceId, principalKind: "user", principalUserId: "reader", principalEmail: null,
      access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null } });
  const doc = new Y.Doc(); doc.getText("plainText").insert(0, "a".repeat(50_000));
  const base = Y.encodeStateAsUpdate(doc), lineageClaimId = createHash("sha256").update(base).digest("hex");
  storage.putBlob({ workspaceId, sha256: lineageClaimId, content: base, createdAtMs: 1 });
  const payload = (updateBlobSha256: string, isBaseState: boolean) => ({ versionId: "main", objectId: "document", path: "document.txt",
    contentKind: "plaintext", updateBlobSha256, lineageClaimId, isBaseState });
  storage.appendLogBatch({ workspaceId, originId: "owner", ops: [
    { originSeq: 0, opKind: "workspace.init", payloadJson: "{}", recordedAtMs: 1 },
    { originSeq: 1, opKind: "ydoc.update", payloadJson: JSON.stringify(payload(lineageClaimId, true)), recordedAtMs: 1 },
  ] });
  const ownerHandler = testHandler(storage);
  let supervisor: ReturnType<typeof createReplicaSupervisor> | undefined;
  let replicaRequests = 0;
  const ownerRequestMs: number[] = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const replica = incoming.headers.authorization?.includes(REPLICA_READ_PREFIX) ?? false;
      if (replica) replicaRequests++;
      const request = new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method,
        headers: incoming.headers as Record<string, string>, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      const began = performance.now();
      const response = await (replica ? supervisor!.handle(request) : ownerHandler(request));
      if (!replica && incoming.method === "POST" && incoming.url?.split("?")[0]?.endsWith("/log")) ownerRequestMs.push(performance.now() - began);
      const bytes = Buffer.from(await response.arrayBuffer()); outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), "content-length": bytes.length }); outgoing.end(bytes);
    } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing port.");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const start = createReplicaEngineStarter({ engineExecutable: executable!, baseUrl,
    allowUnisolatedDevelopment: true, allowInsecureLoopbackForTests: true });
  let pid = 0, storeDir = "", pulls = 0;
  const processes: Array<{ pid: number; storeDir: string }> = [];
  const activate = async () => {
    supervisor = createReplicaSupervisor({ storage, storeRoot: root, idleMs: 180_000, startChild: async input => {
      const child = await start(input); pid = child.pid!; storeDir = input.storeDir;
      processes.push({ pid, storeDir }); writeFileSync(join(evidence, "cost-processes.json"), JSON.stringify({ executable, processes }, null, 2));
      return { ...child, async pull() { pulls++; await child.pull(); } };
    } });
    await supervisor.activate(workspaceId);
  };
  const processSample = () => process.platform === "win32" ? JSON.parse(execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
    `$replicaProcess=Get-Process -Id ${pid}; $replicaThreads=Get-CimInstance Win32_PerfRawData_PerfProc_Thread -Filter 'IDProcess=${pid}'; [pscustomobject]@{workingSetBytes=$replicaProcess.WorkingSet64;cpuSeconds=$replicaProcess.TotalProcessorTime.TotalSeconds;threads=@($replicaThreads|Select-Object IDThread,ContextSwitchesPersec)}|ConvertTo-Json -Depth 3 -Compress`],
    { encoding: "utf8", windowsHide: true })) : undefined;
  let sequence = 2;
  const push = async () => {
    let delta!: Uint8Array; doc.once("update", update => { delta = update; }); doc.getText("plainText").insert(0, "x");
    const sha256 = createHash("sha256").update(delta).digest("hex"); storage.putBlob({ workspaceId, sha256, content: delta, createdAtMs: 1 });
    const body = JSON.stringify({ originId: "owner", replicationEpoch: "epoch", streamIdentity: "stream",
      ops: [{ originSeq: sequence++, opKind: "ydoc.update", payload: payload(sha256, false), recordedAtMs: 1 }] });
    const began = performance.now();
    const response = await fetch(`${baseUrl}/sync/${workspaceId}/log`, { method: "POST", headers: { authorization: `Bearer user:${ownerUserId}`, "content-type": "application/json" }, body });
    expect(response.status).toBe(200); await response.arrayBuffer();
    return { loopbackMs: performance.now() - began, handlerMs: ownerRequestMs.at(-1)! };
  };
  const report: Record<string, any> = { startedAt: new Date().toISOString(), bodyBytes: 50_000,
    ownerPushIntervalMs: 200, missedPushIntervals: 0, pairs: [] };
  try {
    const activation = performance.now(); await activate(); report.smallActivationMs = performance.now() - activation;
    const privateDb = new DatabaseSync(join(storeDir, ".dohc/engine/engine.db"), { readOnly: true });
    try { expect(privateDb.prepare("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.path='document.txt'").get()?.text).toBe("a".repeat(50_000)); }
    finally { privateDb.close(); }
    const before = processSample(), beforePulls = pulls, beforeRequests = replicaRequests, began = performance.now();
    // This is a timed idle observation, not a delay needed to make a correctness assertion pass.
    await new Promise<void>(done => setTimeout(done, 60_000));
    const after = processSample(), elapsedMs = performance.now() - began;
    const beforeThreads = new Map<number, number>((before?.threads ?? []).map((thread: { IDThread: number; ContextSwitchesPersec: number }) => [thread.IDThread, thread.ContextSwitchesPersec]));
    let dispatches = 0, matchedThreads = 0;
    for (const thread of after?.threads ?? []) {
      const previous = beforeThreads.get(thread.IDThread);
      if (previous !== undefined) { dispatches += Math.max(0, thread.ContextSwitchesPersec - previous); matchedThreads++; }
    }
    report.idle = { elapsedMs, before, after, pullWakeupsPerMinute: (pulls - beforePulls) * 60_000 / elapsedMs,
      relayRequestsPerMinute: (replicaRequests - beforeRequests) * 60_000 / elapsedMs,
      threadDispatchesPerMinute: before && after ? dispatches * 60_000 / elapsedMs : null, matchedThreads,
      endedThreads: beforeThreads.size - matchedThreads, newThreads: (after?.threads.length ?? 0) - matchedThreads,
      note: "Windows dispatch deltas cover matched threads. They are a context-switch proxy, not kernel timer wakeups." };
    expect(pulls).toBe(beforePulls); expect(replicaRequests).toBe(beforeRequests);
    const eviction = performance.now(); await supervisor!.close(); supervisor = undefined;
    report.evictionMs = performance.now() - eviction; expect(existsSync(storeDir)).toBe(false);
    const off: number[] = [], on: number[] = [], handlerOff: number[] = [], handlerOn: number[] = [];
    for (let pair = 0; pair < 5; pair++) {
      const sample: Record<string, unknown> = { pair, order: pair % 2 ? ["on", "off"] : ["off", "on"] };
      for (const mode of sample.order as string[]) {
        if (mode === "on") await activate();
        const active = supervisor as ReturnType<typeof createReplicaSupervisor> | undefined;
        const values: number[] = [], handlerValues: number[] = [];
        for (let n = 0; n < 21; n++) {
          const nextPushAt = performance.now() + report.ownerPushIntervalMs;
          const value = await push(); if (n > 0) { values.push(value.loopbackMs); handlerValues.push(value.handlerMs); }
          await active?.settled(workspaceId);
          // Match request spacing on both sides; catch-up is outside response latency.
          const remaining = nextPushAt - performance.now();
          if (remaining > 0) await new Promise<void>(done => setTimeout(done, remaining));
          else report.missedPushIntervals++;
        }
        sample[mode] = { ...stats(values), handler: stats(handlerValues) };
        (mode === "on" ? on : off).push(...values); (mode === "on" ? handlerOn : handlerOff).push(...handlerValues);
        if (active) {
          const db = new DatabaseSync(join(storeDir, ".dohc/engine/engine.db"), { readOnly: true });
          try { expect(db.prepare("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.path='document.txt'").get()?.text).toBe(doc.getText("plainText").toString()); }
          finally { db.close(); }
          await active.close(); supervisor = undefined;
        }
      }
      report.pairs.push(sample);
    }
    report.withoutReplica = stats(off); report.withReplica = stats(on);
    report.ownerHandlerWithoutReplica = stats(handlerOff); report.ownerHandlerWithReplica = stats(handlerOn);
    report.ownerHandlerMedianChangePercent = (report.ownerHandlerWithReplica.medianMs / report.ownerHandlerWithoutReplica.medianMs - 1) * 100;
    report.medianChangePercent = (report.withReplica.medianMs / report.withoutReplica.medianMs - 1) * 100;
    report.replicaPulls = pulls; report.replicaReads = replicaRequests;
    report.verdict = "PASS";
  } catch (error) { report.verdict = "FAIL"; report.error = String(error); throw error; }
  finally { await supervisor?.close(); doc.destroy(); server.close(); await once(server, "close"); await closeTestStorages();
    report.finishedAt = new Date().toISOString(); writeFileSync(join(evidence, "idle-push-cost.json"), JSON.stringify(report, null, 2)); }
}, 600_000);
