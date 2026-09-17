import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openLiveDaemonWorkspace } from "../../apps/desktop/e2e/helpers/daemonSeed.ts";
import { spawnSyncRelay } from "../../apps/desktop/e2e/helpers/syncRelay.ts";
import { createWorkspaceEngineCapture } from "../../apps/desktop/src/workspaces/workspaceEngineCapture.ts";
import { createCaptureLiveStores } from "../../apps/desktop/src/workspaces/workspaceEngineCaptureLiveStore.ts";
import { probeRelayWorkspace } from "../../apps/desktop/src/workspaces/relayWorkspaceProbe.ts";
import { bootstrapJoinedWorkspace } from "../../apps/desktop/src/workspaces/workspaceJoinEnrollment.ts";
import { installWorkspaceDataKey } from "../../apps/desktop/src/workspaces/workspaceDataKey.ts";
import { createTestScratch, removeTestScratch, cleanupSuiteTestScratch } from "../../apps/desktop/src/workspaces/testTemp.ts";
import { openNetworkProxy } from "./network-proxy.mjs";
import { preparedStatus, receiptPath } from "../../scripts/verification/build.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const output = resolve(value("--output") ?? join(repo, "test-results/network-bench"));
const tiny = args.includes("--tiny");
const files = tiny ? 6 : 1000;
const bytesPerFile = tiny ? 1024 : 8192;
const engine = process.env.DOHC_TEST_ENGINE_BINARY;
assert(engine, "Set DOHC_TEST_ENGINE_BINARY to a debug engine built from this checkout.");
assert(preparedStatus("engine"), "Run node scripts/verification/build.mjs --engine-only for this checkout.");
const build = JSON.parse(await readFile(receiptPath, "utf8")).engine;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256(await readFile(engine)), build.artifact, "The selected engine must match this checkout's prepared engine.");
await mkdir(output, { recursive: true });
const report: any = {
  status: "running", startedAt: new Date().toISOString(),
  commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain").length > 0,
  engine: { path: resolve(engine), sha256: sha256(await readFile(engine)), mode: "debug", build },
  platform: process.platform, node: process.version, files, bytesPerFile, tiny,
  transport: "real HTTP relay with SYNC_RELAY_TEST_AUTH; production TLS and authentication untested",
  shaping: "extra response latency and shared downstream bandwidth; not packet-level RTT or loss",
  cases: [],
};
const save = () => writeFile(join(output, "network-bench.json"), JSON.stringify(report, null, 2) + "\n");
await save();

async function open(rootPath: string, workspaceId: string, connection: { baseUrl: string; token: string }, bootstrap: boolean) {
  const workspace = await openLiveDaemonWorkspace({ rootPath, workspaceId }, { maxRestarts: 0 });
  const relay = workspace.relay.bind({ ...workspace.workspace, relay: connection });
  const capture = createWorkspaceEngineCapture({ ...workspace.workspace, rustEngineSessions: workspace.sessions, daemonOwnsCapture: true });
  try {
    if (bootstrap) {
      const probe = await probeRelayWorkspace({ workspaceId, relay: connection });
      await bootstrapJoinedWorkspace({ workspaceId, identity: probe.identity, transport: relay,
        installDataKey: (key) => installWorkspaceDataKey(rootPath, key) });
    }
    return {
      workspace, relay, capture,
      store: createCaptureLiveStores(workspace.workspace, workspace.sessions).store,
      pull: () => capture.runRelaySync((materialize) => relay.pull(materialize)),
      async close() { try { await capture.stop(); } finally { await workspace.close(); } },
    };
  } catch (error) { await capture.stop(); await workspace.close(); throw error; }
}

async function runCase(settings: { name: string; latencyMs: number; bytesPerSecond: number; interrupt: boolean }) {
  const roots: string[] = [];
  let relay, proxy, writer, reader;
  const expected = new Map<string, string>();
  const workspaceId = `network-${settings.name}`;
  const row: any = { ...settings, status: "running" };
  report.cases.push(row);
  await save();
  try {
    for (const prefix of ["network-writer-", "network-reader-", "network-relay-"]) roots.push(await createTestScratch(prefix));
    relay = await spawnSyncRelay({ dbPath: join(roots[2], "relay.sqlite") });
    proxy = await openNetworkProxy(relay.baseUrl);
    const connection = { baseUrl: proxy.baseUrl, token: `test:${workspaceId}` };
    writer = await open(roots[0], workspaceId, connection, false);
    await writer.relay.claim();
    await writer.workspace.chats.ensureGeneralChannel({ workspaceId });
    await writer.relay.push();
    const seedStart = performance.now();
    for (let index = 0; index < files; index++) {
      const path = `notes/file-${String(index).padStart(5, "0")}.txt`;
      const text = `${index}|` + "abcdefghij\n".repeat(Math.ceil(bytesPerFile / 11)).slice(0, bytesPerFile);
      expected.set(path, text);
      await writer.store.writeTextFile({ workspaceId, versionId: "main", path, text, metadata: { origin: "api" } });
    }
    row.seedMs = performance.now() - seedStart;
    row.push = await pushAll(writer.relay);
    assert.equal(row.push.pushed, files);
    reader = await open(roots[1], workspaceId, connection, true);
    proxy.configure({ latencyMs: settings.latencyMs, bytesPerSecond: settings.bytesPerSecond,
      failBlobAt: settings.interrupt ? Math.max(2, Math.floor(files / 2)) : 0 });
    if (settings.interrupt) {
      const interruptedStart = performance.now();
      let failure: unknown;
      try { await pullAll(reader); } catch (error) { failure = error; }
      assert(failure, "The injected 503 must fail the initial pull");
      row.interrupted = { ms: performance.now() - interruptedStart, requests: proxy.snapshot(), error: String(failure) };
      assert.equal(row.interrupted.requests.failures, 1);
      await reader.close(); reader = undefined;
      proxy.configure({ latencyMs: settings.latencyMs, bytesPerSecond: settings.bytesPerSecond });
      reader = await open(roots[1], workspaceId, connection, false);
    }
    const started = performance.now();
    row.pull = await pullAll(reader);
    row.catchUpMs = performance.now() - started;
    row.requests = proxy.snapshot();
    for (const [path, text] of expected) assert.equal(await readFile(join(roots[1], path), "utf8"), text, path);
    const idleStarted = performance.now();
    row.idlePull = await reader.pull();
    row.idlePullMs = performance.now() - idleStarted;
    assert.equal(row.idlePull.fetched, 0);
    await reader.close(); reader = undefined;
    reader = await open(roots[1], workspaceId, connection, false);
    row.restartPull = await pullAll(reader);
    assert.equal(row.restartPull.fetched, 0);
    for (const [path, text] of expected) {
      assert.equal(await readFile(join(roots[1], path), "utf8"), text, path);
      const stored = await reader.store.readTextFile({ workspaceId, versionId: "main", path });
      assert.equal(stored.text, text, `reopened store ${path}`);
    }
    // A write after restart proves the resumed cursor still delivers new work.
    const [path, initial] = expected.entries().next().value!;
    const edited = initial + "after reconnect\n";
    await writer.store.writeTextFile({ workspaceId, versionId: "main", path, text: edited, metadata: { origin: "api" } });
    await pushAll(writer.relay);
    const resumedAt = performance.now();
    row.resumedPull = await pullAll(reader);
    row.resumedEditMs = performance.now() - resumedAt;
    assert.equal(await readFile(join(roots[1], path), "utf8"), edited);
    row.fixtureSha256 = sha256([...expected].map(([path, text]) => path + "\0" + sha256(text)).join("\n"));
    row.verifiedFiles = expected.size;
    row.status = "pass";
    console.log(JSON.stringify({ name: settings.name, catchUpMs: row.catchUpMs, requests: row.requests, verifiedFiles: row.verifiedFiles }));
  } catch (error) { row.status = "fail"; row.error = String(error); throw error; }
  finally {
    const cleanup = await Promise.allSettled([reader?.close(), writer?.close()]);
    await proxy?.close();
    await relay?.stop();
    for (const root of roots) await removeTestScratch(root);
    row.cleanup = cleanup.map((result) => result.status);
    await save();
    for (const result of cleanup) if (result.status === "rejected") throw result.reason;
  }
}

async function pushAll(relay: { push(): Promise<any> }) {
  let total = 0;
  let last: any = null;
  do {
    last = await relay.push();
    total += last.pushed;
  } while (last.pushed > 0);
  return { ...last, pushed: total };
}

async function pullAll(reader: { pull(): Promise<any> }) {
  let total = 0;
  let last: any = null;
  let applied = 0;
  do {
    last = await reader.pull();
    total += last.fetched;
    applied += last.applied;
  } while (last.fetched > 0);
  return { ...last, fetched: total, applied };
}

try {
  for (const settings of [
    { name: "local", latencyMs: 0, bytesPerSecond: 0, interrupt: false },
    { name: "constrained", latencyMs: 40, bytesPerSecond: 1_250_000, interrupt: false },
    { name: "reconnect", latencyMs: 40, bytesPerSecond: 1_250_000, interrupt: true },
  ]) await runCase(settings);
  report.status = "pass";
} catch (error) { report.status = "fail"; report.error = String(error); process.exitCode = 1; }
finally { await cleanupSuiteTestScratch(); report.finishedAt = new Date().toISOString(); await save(); }
