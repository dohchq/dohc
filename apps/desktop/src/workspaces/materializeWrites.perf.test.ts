import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { cpus, freemem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { buildRelay } from "../../../../services/sync-relay/scripts/build.mjs";
import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createWorkspaceEngineCapture, type EngineDiskWriter, type WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { probeRelayWorkspace } from "./relayWorkspaceProbe";
import { createTestScratch } from "./testTemp";
import { installWorkspaceDataKey } from "./workspaceDataKey";
import { bootstrapJoinedWorkspace } from "./workspaceJoinEnrollment";
import type { EngineRelayWorkspaceClient } from "./engineRelayClient";

const engine = requireEngineBinaryOrSkip();
const rounds = Number(process.env.DOHC_MATERIALIZE_ROUNDS ?? 5);
const resultsPath = resolve(process.env.DOHC_MATERIALIZE_RESULTS ?? ".agent-artifacts/materialize-writes.jsonl");

function truncateWriter(): EngineDiskWriter {
  const write = async (path: string, data: string | Uint8Array) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  };
  return { writeTextFile: write, writeBinaryFile: write, deletePath: path => rm(path, { force: true }) };
}

async function openCapture(workspaceId: string, rootPath: string, relayConnection: { baseUrl: string; token: string }, baseline: boolean, joined = false) {
  const input = { workspaceId, rootPath, relay: relayConnection };
  const workspace = await openLiveDaemonWorkspace(input, { maxRestarts: 0, allowInsecureLoopbackForTests: true });
  try {
    const relay = workspace.relay.bind({ ...workspace.workspace, relay: relayConnection });
    if (joined) {
      const probe = await probeRelayWorkspace({ workspaceId, relay: relayConnection });
      await bootstrapJoinedWorkspace({ workspaceId, identity: probe.identity, transport: relay,
        installDataKey: key => installWorkspaceDataKey(rootPath, key) });
    }
    const capture = createWorkspaceEngineCapture({ ...workspace.workspace, rustEngineSessions: workspace.sessions,
      ...(baseline ? { diskWriter: truncateWriter() } : {}) });
    return { capture, relay,
      capturedText: (path: string) => workspace.sessions.run(workspace.workspace, async ({ client, workspace: handle }) =>
        (await new VersionedLiveAdapter(client, handle, { workspaceId }).readTextFile({ workspaceId, versionId: "main", path }))?.text),
      close: async () => { try { await capture.stop(); } finally { await workspace.close(); } },
    };
  } catch (error) { await workspace.close(); throw error; }
}

async function pushUntilDrained(relay: EngineRelayWorkspaceClient) {
  let result;
  do { result = await relay.push(); } while (result.hasMore);
}

async function capturedPathCount(capture: WorkspaceEngineCapture) {
  const paths = new Set<string>();
  let cursor: NonNullable<Parameters<WorkspaceEngineCapture["listMoments"]>[0]>["cursor"];
  do {
    const page = await capture.listMoments({ limit: 50, ...(cursor ? { cursor } : {}) });
    for (const moment of page.moments) paths.add(moment.path);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && paths.size < 1_000);
  return paths.size;
}

async function writeAndCapture(daemon: Awaited<ReturnType<typeof openCapture>>, root: string, text: string) {
  await writeFile(join(root, "file-0.txt"), text);
  daemon.capture.observeFileEvents([{ path: "file-0.txt", operation: "update" }]);
  await expect.poll(() => daemon.capturedText("file-0.txt"), { timeout: 60_000 }).toBe(text);
}

function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return { median: values.length % 2 ? values[middle] : (values[middle - 1]! + values[middle]!) / 2,
    min: values[0], max: values.at(-1) };
}

it.skipIf(process.env.DOHC_MATERIALIZE_MEASURE !== "1" || engine.missing)("measures relay materialization and one conflict choice with alternating writers", async () => {
  expect(Number.isSafeInteger(rounds) && rounds > 0).toBe(true);
  const output = fileURLToPath(new URL("../../../../services/sync-relay/.output/", import.meta.url));
  await mkdir(output, { recursive: true });
  const buildDirectory = await mkdtemp(join(output, "materialize-perf-"));
  const measurements: { writer: string; pullMs: number; conflictMs: number }[] = [];
  try {
    await buildRelay(buildDirectory);
    await mkdir(dirname(resultsPath), { recursive: true });
    for (let round = 0; round < rounds * 2; round += 1) {
      const baseline = round % 2 === 0;
      const writer = baseline ? "truncate" : "atomic";
      const workspaceId = `materialize-perf-${randomUUID()}`;
      const rootA = await createTestScratch("materialize-perf-a-");
      const rootB = await createTestScratch("materialize-perf-b-");
      const relayRoot = await createTestScratch("materialize-perf-relay-");
      const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite"), compiledMain: join(buildDirectory, "main.js") });
      let a: Awaited<ReturnType<typeof openCapture>> | undefined;
      let b: typeof a;
      try {
        const connection = { baseUrl: relay.baseUrl, token: `test:${workspaceId}` };
        a = await openCapture(workspaceId, rootA, connection, baseline);
        await a.relay.claim();
        await a.capture.flush();
        let next = 0;
        await Promise.all(Array.from({ length: 8 }, async () => {
          while (next < 1_000) {
            const index = next++;
            await writeFile(join(rootA, `file-${index}.txt`), `small synthetic file ${index}\n`);
          }
        }));
        await a.capture.resyncFileObservation();
        const source = a;
        await expect.poll(() => capturedPathCount(source.capture), { timeout: 60_000 }).toBe(1_000);
        await pushUntilDrained(a.relay);
        b = await openCapture(workspaceId, rootB, connection, baseline, true);
        const freeMemoryBytes = freemem();
        const pullStart = performance.now();
        await b.capture.runRelaySync(page => b!.relay.pull(page));
        const pullMs = performance.now() - pullStart;
        expect((await readdir(rootB)).filter(name => name.endsWith(".txt"))).toHaveLength(1_000);
        for (let index = 0; index < 1_000; index++) {
          expect(await readFile(join(rootB, `file-${index}.txt`), "utf8")).toBe(`small synthetic file ${index}\n`);
        }
        await writeAndCapture(a, rootA, "local\n");
        await writeAndCapture(b, rootB, "incoming\n");
        await pushUntilDrained(a.relay);
        await pushUntilDrained(b.relay);
        await a.capture.runRelaySync(page => a!.relay.pull(page));
        const conflict = (await a.capture.listOpenConflictsPage()).conflicts.find(row => row.path === "file-0.txt");
        expect(conflict).toBeDefined();
        const conflictFreeMemoryBytes = freemem();
        const conflictStart = performance.now();
        await a.capture.resolveConflict(conflict!.id, { kind: "apply-incoming" });
        const conflictMs = performance.now() - conflictStart;
        expect(await readFile(join(rootA, "file-0.txt"), "utf8")).toBe("incoming\n");
        const row = { round: round + 1, pair: Math.floor(round / 2) + 1, writer, platform: process.platform,
          cpuModel: cpus()[0]?.model, freeMemoryBytes, conflictFreeMemoryBytes, pullMs, conflictMs };
        measurements.push(row);
        await appendFile(resultsPath, `${JSON.stringify(row)}\n`);
        console.log(JSON.stringify(row));
      } finally { await Promise.allSettled([a?.close(), b?.close()]); await relay.stop(); }
    }
    for (const writer of ["truncate", "atomic"]) {
      const rows = measurements.filter(row => row.writer === writer);
      console.log(JSON.stringify({ writer, pullMs: distribution(rows.map(row => row.pullMs)),
        conflictMs: distribution(rows.map(row => row.conflictMs)), resultsPath }));
    }
  } finally { await rm(buildDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
}, Math.max(1_800_000, rounds * 120_000));
