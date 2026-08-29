#!/usr/bin/env node

import { createHash, X509Certificate } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import { cpus, hostname, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const repoRoot = resolve(scriptDir, "../../..");
const relayRoot = join(repoRoot, "services", "sync-relay");
const workerMarker = "DOHC_ENGINE_BENCH_TSX_WORKER";

async function launchWithTypeScriptLoader() {
  const requireFromRelay = createRequire(join(relayRoot, "package.json"));
  const tsxLoader = requireFromRelay.resolve("tsx");
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(tsxLoader).href,
      scriptPath,
      ...process.argv.slice(2),
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, [workerMarker]: "1" },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  const [code, signal] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(
      `engine benchmark worker exited ${code ?? `after signal ${signal ?? "unknown"}`}`,
    );
  }
}

if (process.env[workerMarker] !== "1") {
  try {
    await launchWithTypeScriptLoader();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else {
  await runWorker();
}

async function runWorker() {
  const options = parseArgs(process.argv.slice(2));
  const modules = await loadHarnessModules();
  const Y = await import(
    pathToFileURL(
      join(
        repoRoot,
        "packages",
        "workspace-engine-client",
        "node_modules",
        "yjs",
        "dist",
        "yjs.mjs",
      ),
    ).href
  );

  await assertFile(options.debugEngine, "debug engine");
  await assertFile(options.releaseEngine, "release engine");
  await assertFile(options.relayTlsCert, "relay TLS certificate");
  await assertFile(options.relayTlsKey, "relay TLS private key");
  await mkdir(options.output, { recursive: true });

  const run = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    gitCommit: await gitOutput(["rev-parse", "HEAD"]),
    scale: options.tiny ? "tiny" : "full",
    execution: {
      serial: true,
      outputDirectory: options.output,
      selectedBenches: options.benches,
      reusedBenchResults: ["b1", "b2", "b3"].filter(
        (bench) => !options.benches.includes(bench),
      ),
    },
    machine: machineMetadata(),
    engines: {
      debug: await binaryMetadata(options.debugEngine),
      release: await binaryMetadata(options.releaseEngine),
    },
    relayTls: await certificateMetadata(
      options.relayTlsCert,
      options.relayTlsHost,
    ),
  };

  let appendResult = options.benches.includes("b1")
    ? null
    : await readExistingBenchResult(options.output, "append-cost.json", "B1", run);
  let admissionResult = options.benches.includes("b2")
    ? null
    : await readExistingBenchResult(
        options.output,
        "deferred-admission.json",
        "B2",
        run,
      );
  let catchUpResult = options.benches.includes("b3")
    ? null
    : await readExistingBenchResult(
        options.output,
        "relay-catch-up.json",
        "B3",
        run,
      );
  try {
    if (options.benches.includes("b1")) {
      console.log("[engine-bench] B1 append cost curve: debug, then release");
      appendResult = await runAppendCostCurve({ options, modules, Y, run });
      await writeJson(join(options.output, "append-cost.json"), appendResult);
    }

    if (options.benches.includes("b2")) {
      console.log("[engine-bench] B2 deferred admission K-curve: release");
      admissionResult = await runDeferredAdmissionCurve({
        options,
        modules,
        Y,
        run,
      });
      await writeJson(
        join(options.output, "deferred-admission.json"),
        admissionResult,
      );
    }

    if (options.benches.includes("b3")) {
      console.log("[engine-bench] B3 relay catch-up curve: release");
      catchUpResult = await runRelayCatchUpCurve({ options, modules, Y, run });
      await writeJson(
        join(options.output, "relay-catch-up.json"),
        catchUpResult,
      );
    }
  } finally {
    await modules.cleanupSuiteTestScratch().catch((error) => {
      console.error(`[engine-bench] scratch cleanup failed: ${String(error)}`);
    });
  }

  const summary = {
    ...run,
    status: "pass",
    curves: {
      appendCost: Object.fromEntries(
        appendResult.engines.map((engine) => [
          engine.engine,
          engine.bands.map((band) => ({
            targetStateBytes: band.targetStateBytes,
            stateBytesBeforeSamples: band.stateBytesBeforeSamples,
            sampleCount: band.latencyMs.count,
            p50Ms: band.latencyMs.p50,
            p95Ms: band.latencyMs.p95,
          })),
        ]),
      ),
      deferredAdmission: admissionResult.cases.map((entry) => ({
        queuedPredecessors: entry.queuedPredecessors,
        admissionLatencyMs: entry.probeAdmissionLatencyMs,
        drainTimeMs: entry.totalDrainTimeMs,
      })),
      relayCatchUp: catchUpResult.cases.map((entry) => ({
        blobCount: entry.blobCount,
        catchUpTimeMs: entry.catchUpTimeMs,
        blobGetRequests: entry.relayRequests.blobGets,
        requestsPerBlob: entry.relayRequests.requestsPerBlob,
      })),
    },
  };
  await writeJson(join(options.output, "engine-bench-summary.json"), summary);
  console.log(
    `[engine-bench] wrote ${join(options.output, "engine-bench-summary.json")}`,
  );
}

function usage() {
  return [
    "Usage: node tools/perf-profiling/engine-bench/run-engine-bench.mjs --debug-engine <path> --release-engine <path> --relay-tls-cert <path> --relay-tls-key <path> --relay-tls-host <hostname> [--relay-latency-ms <milliseconds>] [--output <directory>] [--benches b1,b2,b3] [--tiny]",
    "",
    "The full run executes B1, B2, and B3 serially. --tiny checks plumbing with reduced curves.",
    "Use --benches to resume selected phases; omitted phases must already have compatible JSON in the output directory.",
    "--relay-latency-ms delays each proxied relay response. It defaults to 0 (off).",
  ].join("\n");
}

function parseArgs(argv) {
  let debugEngine = process.env.DOHC_BENCH_DEBUG_ENGINE?.trim() || null;
  let releaseEngine = process.env.DOHC_BENCH_RELEASE_ENGINE?.trim() || null;
  let relayTlsCert = process.env.DOHC_BENCH_RELAY_TLS_CERT?.trim() || null;
  let relayTlsKey = process.env.DOHC_BENCH_RELAY_TLS_KEY?.trim() || null;
  let relayTlsHost = process.env.DOHC_BENCH_RELAY_TLS_HOST?.trim() || null;
  let relayLatencyMs = 0;
  let output = join(repoRoot, "test-results", "engine-bench");
  let benches = ["b1", "b2", "b3"];
  let tiny = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--debug-engine") {
      debugEngine = argv[++index] ?? null;
    } else if (arg === "--release-engine") {
      releaseEngine = argv[++index] ?? null;
    } else if (arg === "--output") {
      output = argv[++index] ?? "";
    } else if (arg === "--relay-tls-cert") {
      relayTlsCert = argv[++index] ?? null;
    } else if (arg === "--relay-tls-key") {
      relayTlsKey = argv[++index] ?? null;
    } else if (arg === "--relay-tls-host") {
      relayTlsHost = argv[++index] ?? null;
    } else if (arg === "--relay-latency-ms") {
      relayLatencyMs = Number(argv[++index]);
    } else if (arg === "--benches") {
      benches = (argv[++index] ?? "")
        .split(",")
        .map((bench) => bench.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg === "--tiny") {
      tiny = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  if (
    !debugEngine ||
    !releaseEngine ||
    !relayTlsCert ||
    !relayTlsKey ||
    !relayTlsHost ||
    !output
  ) {
    throw new Error(
      `Both engine paths, all relay TLS inputs, and a non-empty output path are required.\n\n${usage()}`,
    );
  }
  const invalidBenches = benches.filter(
    (bench, index) =>
      !["b1", "b2", "b3"].includes(bench) || benches.indexOf(bench) !== index,
  );
  if (benches.length === 0 || invalidBenches.length > 0) {
    throw new Error(
      `--benches must be a non-empty, duplicate-free subset of b1,b2,b3.\n\n${usage()}`,
    );
  }
  if (!Number.isFinite(relayLatencyMs) || relayLatencyMs < 0) {
    throw new Error(
      `--relay-latency-ms must be a non-negative number.\n\n${usage()}`,
    );
  }
  return {
    debugEngine: resolve(debugEngine),
    releaseEngine: resolve(releaseEngine),
    relayTlsCert: resolve(relayTlsCert),
    relayTlsKey: resolve(relayTlsKey),
    relayTlsHost,
    relayLatencyMs,
    output: resolve(output),
    benches,
    tiny,
  };
}

async function loadHarnessModules() {
  const client = await import(
    pathToFileURL(
      join(repoRoot, "packages", "workspace-engine-client", "src", "index.ts"),
    ).href
  );
  const daemon = await import(
    pathToFileURL(
      join(
        repoRoot,
        "packages",
        "workspace-engine-client",
        "src",
        "daemon",
        "index.ts",
      ),
    ).href
  );
  const relayClient = await import(
    pathToFileURL(
      join(repoRoot, "apps", "desktop", "src", "workspaces", "engineRelayClient.ts"),
    ).href
  );
  const sessions = await import(
    pathToFileURL(
      join(
        repoRoot,
        "apps",
        "desktop",
        "src",
        "testing",
        "realDaemonWorkspaceSessions.ts",
      ),
    ).href
  );
  const capture = await import(
    pathToFileURL(
      join(
        repoRoot,
        "apps",
        "desktop",
        "src",
        "workspaces",
        "workspaceEngineCapture.ts",
      ),
    ).href
  );
  const relay = await import(
    pathToFileURL(
      join(repoRoot, "apps", "desktop", "e2e", "helpers", "syncRelay.ts"),
    ).href
  );
  const probe = await import(
    pathToFileURL(
      join(repoRoot, "apps", "desktop", "src", "workspaces", "relayWorkspaceProbe.ts"),
    ).href
  );
  const joinEnrollment = await import(
    pathToFileURL(
      join(
        repoRoot,
        "apps",
        "desktop",
        "src",
        "workspaces",
        "workspaceJoinEnrollment.ts",
      ),
    ).href
  );
  const dataKey = await import(
    pathToFileURL(
      join(repoRoot, "apps", "desktop", "src", "workspaces", "workspaceDataKey.ts"),
    ).href
  );
  const scratch = await import(
    pathToFileURL(
      join(repoRoot, "apps", "desktop", "src", "workspaces", "testTemp.ts"),
    ).href
  );
  return {
    YdocLiveAdapter: client.YdocLiveAdapter,
    EngineDaemonLifecycle: daemon.EngineDaemonLifecycle,
    EngineRelayClient: relayClient.EngineRelayClient,
    RelayConfiguredDaemonClientSource:
      relayClient.RelayConfiguredDaemonClientSource,
    RelayTransportRouteGuard: relayClient.RelayTransportRouteGuard,
    createRealDaemonWorkspaceSessions:
      sessions.createRealDaemonWorkspaceSessions,
    createWorkspaceEngineCapture: capture.createWorkspaceEngineCapture,
    spawnSyncRelay: relay.spawnSyncRelay,
    probeRelayWorkspace: probe.probeRelayWorkspace,
    bootstrapJoinedWorkspace: joinEnrollment.bootstrapJoinedWorkspace,
    installWorkspaceDataKey: dataKey.installWorkspaceDataKey,
    createTestScratch: scratch.createTestScratch,
    removeTestScratch: scratch.removeTestScratch,
    cleanupSuiteTestScratch: scratch.cleanupSuiteTestScratch,
  };
}

async function runAppendCostCurve({ options, modules, Y, run }) {
  const targets = options.tiny
    ? [32 * 1024, 128 * 1024]
    : [100 * 1024, 1024 * 1024, 5 * 1024 * 1024, 15 * 1024 * 1024];
  const sampleCount = options.tiny ? 5 : 64;
  const engines = [];
  for (const [engine, binary] of [
    ["debug", options.debugEngine],
    ["release", options.releaseEngine],
  ]) {
    const rootPath = await modules.createTestScratch(`engine-bench-b1-${engine}-`);
    let daemon = null;
    let adapter = null;
    let session = null;
    const startedAt = performance.now();
    try {
      daemon = await openDaemonWorkspace({
        binary,
        workspaceId: `engine-bench-b1-${engine}`,
        rootPath,
        modules,
      });
      ({ adapter, session } = await openPlaintextSession({
        daemon,
        modules,
        recordUpdateDeadlineMs: 10 * 60 * 1000,
      }));
      await seedPlaintextSession(session, Y, "s");

      const bands = [];
      for (const targetStateBytes of targets) {
        const stateBytesBeforeSamples = await growYdocToStateBytes({
          session,
          targetStateBytes,
          Y,
        });
        const rawLatencyMs = [];
        for (let index = 0; index < sampleCount; index += 1) {
          const character = String.fromCharCode(97 + (index % 26));
          const sampleStartedAt = performance.now();
          await session.applyLocalEdit((doc) => {
            const text = doc.getText("plainText");
            text.insert(text.length, character);
          });
          rawLatencyMs.push(performance.now() - sampleStartedAt);
        }
        const stateBytesAfterSamples = Y.encodeStateAsUpdate(session.doc).byteLength;
        const band = {
          targetStateBytes,
          stateBytesBeforeSamples,
          stateBytesAfterSamples,
          documentUtf8Bytes: Buffer.byteLength(
            session.doc.getText("plainText").toString(),
            "utf8",
          ),
          latencyMs: summarizeSeries(rawLatencyMs),
          rawLatencyMs: rawLatencyMs.map(roundMs),
        };
        bands.push(band);
        console.log(
          `[engine-bench] B1 ${engine} ${formatBytes(targetStateBytes)}: p50=${band.latencyMs.p50.toFixed(3)}ms p95=${band.latencyMs.p95.toFixed(3)}ms`,
        );
      }
      engines.push({
        engine,
        binary: run.engines[engine],
        elapsedMs: roundMs(performance.now() - startedAt),
        bands,
      });
    } finally {
      await session?.close({ settle: true, summary: "engine benchmark" }).catch(
        () => undefined,
      );
      adapter?.dispose();
      await daemon?.close().catch(() => undefined);
      await modules.removeTestScratch(rootPath);
    }
  }
  return {
    ...commonBenchEnvelope(run, "B1", "C1"),
    config: {
      targetStateBytes: targets,
      samplesPerBand: sampleCount,
      measuredUpdate: "one ASCII character in one Y.Doc transaction",
      bulkGrowthChunkBytes: 4 * 1024 * 1024,
      recordUpdateDeadlineMs: 10 * 60 * 1000,
    },
    engines,
  };
}

async function growYdocToStateBytes({ session, targetStateBytes, Y }) {
  let stateBytes = Y.encodeStateAsUpdate(session.doc).byteLength;
  while (stateBytes < targetStateBytes) {
    const remaining = targetStateBytes - stateBytes;
    const chunkBytes = Math.max(1, Math.min(4 * 1024 * 1024, remaining));
    const chunk = "g".repeat(chunkBytes);
    await session.applyLocalEdit((doc) => {
      const text = doc.getText("plainText");
      text.insert(text.length, chunk);
    });
    stateBytes = Y.encodeStateAsUpdate(session.doc).byteLength;
  }
  return stateBytes;
}

async function runDeferredAdmissionCurve({ options, modules, Y, run }) {
  const predecessorCounts = options.tiny ? [1, 4] : [1, 8, 32, 128];
  const cases = [];
  for (const queuedPredecessors of predecessorCounts) {
    const fixture = await openRelayFixture({
      label: `b2-k${queuedPredecessors}`,
      binary: options.releaseEngine,
      modules,
      relayTls: options,
    });
    let writerAdapter = null;
    let writerSession = null;
    let holderAdapter = null;
    let holderSession = null;
    try {
      ({ adapter: writerAdapter, session: writerSession } =
        await openPlaintextSession({ daemon: fixture.writer, modules }));
      await seedPlaintextSession(writerSession, Y, "base|");
      await writerSession.evict();
      writerSession = null;
      writerAdapter.dispose();
      writerAdapter = null;
      const basePush = await fixture.writer.relay.push();
      assertEqual(basePush.pushed, 1, "B2 base push operation count");

      await fixture.openReader();
      const basePull = await pullIntoCapture(fixture.reader);
      assertEqual(basePull.fetched, 1, "B2 base pull operation count");
      ({ adapter: holderAdapter, session: holderSession } =
        await openPlaintextSession({ daemon: fixture.reader, modules }));
      ({ adapter: writerAdapter, session: writerSession } =
        await openPlaintextSession({ daemon: fixture.writer, modules }));

      const predecessorAdmissions = [];
      for (let index = 0; index < queuedPredecessors; index += 1) {
        await appendMarker(writerSession, `p${index}|`);
        const push = await fixture.writer.relay.push();
        assertEqual(push.pushed, 1, "B2 predecessor push operation count");
        const startedAt = performance.now();
        const pull = await pullIntoCapture(fixture.reader);
        predecessorAdmissions.push({
          predecessorCountBeforeAdmission: index,
          latencyMs: roundMs(performance.now() - startedAt),
          fetched: pull.fetched,
          applied: pull.applied,
        });
        assertEqual(
          deferredRowCount(fixture.reader.rootPath),
          index + 1,
          "B2 deferred predecessor row count",
        );
      }

      const queueBeforeProbe = deferredRowCount(fixture.reader.rootPath);
      await appendMarker(writerSession, "probe|");
      const probePush = await fixture.writer.relay.push();
      assertEqual(probePush.pushed, 1, "B2 probe push operation count");
      const probeStartedAt = performance.now();
      const probePull = await pullIntoCapture(fixture.reader);
      const probeAdmissionLatencyMs = performance.now() - probeStartedAt;
      const queueAfterProbe = deferredRowCount(fixture.reader.rootPath);
      assertEqual(
        queueBeforeProbe,
        queuedPredecessors,
        "B2 queue depth before probe",
      );
      assertEqual(
        queueAfterProbe,
        queuedPredecessors + 1,
        "B2 queue depth after probe",
      );

      const drainStartedAt = performance.now();
      await holderSession.close({ settle: false });
      const totalDrainTimeMs = performance.now() - drainStartedAt;
      holderSession = null;
      const queueAfterDrain = deferredRowCount(fixture.reader.rootPath);
      assertEqual(queueAfterDrain, 0, "B2 queue depth after drain");
      const materialized = await readFile(
        join(fixture.reader.rootPath, "notes", "bench.txt"),
        "utf8",
      );
      assertIncludes(materialized, "probe|", "B2 drained projection");

      const entry = {
        queuedPredecessors,
        queueBeforeProbe,
        queueAfterProbe,
        probeAdmissionLatencyMs: roundMs(probeAdmissionLatencyMs),
        probePull: {
          fetched: probePull.fetched,
          applied: probePull.applied,
          skipped: probePull.skipped,
        },
        totalDrainTimeMs: roundMs(totalDrainTimeMs),
        drainedRows: queueAfterProbe,
        queueAfterDrain,
        predecessorAdmissions,
      };
      cases.push(entry);
      console.log(
        `[engine-bench] B2 K=${queuedPredecessors}: admission=${entry.probeAdmissionLatencyMs.toFixed(3)}ms drain=${entry.totalDrainTimeMs.toFixed(3)}ms`,
      );
    } finally {
      await holderSession?.close({ settle: false }).catch(() => undefined);
      holderAdapter?.dispose();
      await writerSession?.close({ settle: true }).catch(() => undefined);
      writerAdapter?.dispose();
      await fixture.close();
    }
  }
  return {
    ...commonBenchEnvelope(run, "B2", "C2"),
    binary: run.engines.release,
    relayTls: run.relayTls,
    config: {
      queuedPredecessors: predecessorCounts,
      probe: "one remote Y.Doc delta admitted after K deferred predecessors",
      drain: "close the live reader session without a local settle",
      engine: "release",
    },
    cases,
  };
}

async function runRelayCatchUpCurve({ options, modules, Y, run }) {
  const blobCounts = options.tiny ? [3, 6] : [10, 50, 200];
  const cases = [];
  for (const blobCount of blobCounts) {
    const fixture = await openRelayFixture({
      label: `b3-b${blobCount}`,
      binary: options.releaseEngine,
      modules,
      relayTls: options,
    });
    let writerAdapter = null;
    let writerSession = null;
    try {
      ({ adapter: writerAdapter, session: writerSession } =
        await openPlaintextSession({ daemon: fixture.writer, modules }));
      await seedPlaintextSession(writerSession, Y, "u0|");
      await writerSession.evict();
      writerSession = null;
      writerAdapter.dispose();
      writerAdapter = null;
      const basePush = await fixture.writer.relay.push();
      assertEqual(basePush.pushed, 1, "B3 base push operation count");

      ({ adapter: writerAdapter, session: writerSession } =
        await openPlaintextSession({ daemon: fixture.writer, modules }));
      for (let index = 1; index < blobCount; index += 1) {
        await appendMarker(writerSession, `u${index}|`);
      }
      const deltaPush = await fixture.writer.relay.push();
      assertEqual(
        deltaPush.pushed,
        blobCount - 1,
        "B3 delta push operation count",
      );

      await fixture.openReader();
      fixture.requestCounter.reset();
      const startedAt = performance.now();
      const pull = await pullIntoCapture(fixture.reader);
      const catchUpTimeMs = performance.now() - startedAt;
      const requests = fixture.requestCounter.snapshot();
      const distinctBlobPaths = new Set(
        requests.entries
          .filter(
            (entry) =>
              entry.method === "GET" && /\/blobs\/[0-9a-f]{64}$/u.test(entry.pathname),
          )
          .map((entry) => entry.pathname),
      );
      const blobGets = requests.entries.filter(
        (entry) =>
          entry.method === "GET" && /\/blobs\/[0-9a-f]{64}$/u.test(entry.pathname),
      ).length;
      assertEqual(pull.fetched, blobCount, "B3 cold pull operation count");
      assertEqual(distinctBlobPaths.size, blobCount, "B3 distinct relay blob count");
      const materialized = await readFile(
        join(fixture.reader.rootPath, "notes", "bench.txt"),
        "utf8",
      );
      assertIncludes(
        materialized,
        `u${blobCount - 1}|`,
        "B3 caught-up projection",
      );

      const entry = {
        blobCount,
        pushed: basePush.pushed + deltaPush.pushed,
        catchUpTimeMs: roundMs(catchUpTimeMs),
        pull: {
          fetched: pull.fetched,
          applied: pull.applied,
          skipped: pull.skipped,
          nextCursor: pull.nextCursor,
        },
        relayRequests: {
          total: requests.entries.length,
          blobGets,
          distinctBlobPaths: distinctBlobPaths.size,
          requestsPerBlob: roundRatio(blobGets / blobCount),
          byMethodAndPathClass: classifyRelayRequests(requests.entries),
        },
      };
      cases.push(entry);
      console.log(
        `[engine-bench] B3 B=${blobCount}: catch-up=${entry.catchUpTimeMs.toFixed(3)}ms blob GETs=${blobGets}`,
      );
    } finally {
      await writerSession?.close({ settle: true }).catch(() => undefined);
      writerAdapter?.dispose();
      await fixture.close();
    }
  }
  return {
    ...commonBenchEnvelope(run, "B3", "C3"),
    binary: run.engines.release,
    relayTls: run.relayTls,
    config: {
      blobCounts,
      ...(options.relayLatencyMs > 0
        ? { relayLatencyMs: options.relayLatencyMs }
        : {}),
      pageShape: "one cold relay page containing B distinct Y.Doc update blobs",
      catchUpTimer: "reader sync.pull through materialization and cursor commit",
      engine: "release",
    },
    cases,
  };
}

async function openRelayFixture({ label, binary, modules, relayTls }) {
  const workspaceId = `engine-bench-${label}`;
  const token = `test:${workspaceId}`;
  const writerRoot = await modules.createTestScratch(`${label}-writer-`);
  const readerRoot = await modules.createTestScratch(`${label}-reader-`);
  const relayRootPath = await modules.createTestScratch(`${label}-relay-`);
  let relay = null;
  let proxy = null;
  let relayConnection = null;
  let writer = null;
  let reader = null;
  try {
    relay = await modules.spawnSyncRelay({
      dbPath: join(relayRootPath, "relay.sqlite"),
    });
    proxy = await spawnTlsRelayProxy(relay.baseUrl, {
      certPath: relayTls.relayTlsCert,
      keyPath: relayTls.relayTlsKey,
      hostname: relayTls.relayTlsHost,
      latencyMs: relayTls.relayLatencyMs,
    });
    relayConnection = {
      baseUrl: proxy.baseUrl,
      token,
    };
    writer = await openDaemonWorkspace({
      binary,
      workspaceId,
      rootPath: writerRoot,
      relayConnection,
      modules,
    });
    await writer.relay.claim();
  } catch (error) {
    await reader?.close().catch(() => undefined);
    await writer?.close().catch(() => undefined);
    await proxy?.stop().catch(() => undefined);
    await relay?.stop().catch(() => undefined);
    for (const path of [writerRoot, readerRoot, relayRootPath]) {
      await modules.removeTestScratch(path);
    }
    throw error;
  }
  return {
    writer,
    get reader() {
      if (reader === null) throw new Error("The reader daemon is not open.");
      return reader;
    },
    requestCounter: proxy.counter,
    async openReader() {
      if (reader !== null) return reader;
      reader = await openDaemonWorkspace({
        binary,
        workspaceId,
        rootPath: readerRoot,
        relayConnection,
        modules,
      });
      const identity = await modules.probeRelayWorkspace({
        workspaceId,
        relay: relayConnection,
      });
      await modules.bootstrapJoinedWorkspace({
        workspaceId,
        identity: identity.identity,
        transport: reader.relay,
        installDataKey: async (key) =>
          await modules.installWorkspaceDataKey(readerRoot, key),
      });
      return reader;
    },
    async close() {
      await reader?.close().catch(() => undefined);
      await writer?.close().catch(() => undefined);
      await proxy?.stop().catch(() => undefined);
      await relay?.stop().catch(() => undefined);
      for (const path of [writerRoot, readerRoot, relayRootPath]) {
        await modules.removeTestScratch(path);
      }
    },
  };
}

async function openDaemonWorkspace({
  binary,
  workspaceId,
  rootPath,
  relayConnection,
  modules,
}) {
  const lifecycle = new modules.EngineDaemonLifecycle({
    command: binary,
    maxRestarts: 0,
  });
  await lifecycle.start();
  try {
    const routes = relayConnection
      ? new modules.RelayTransportRouteGuard()
      : null;
    const source = routes
      ? new modules.RelayConfiguredDaemonClientSource(lifecycle, routes)
      : lifecycle;
    const sessions = modules.createRealDaemonWorkspaceSessions(source);
    const workspace = {
      workspaceId,
      rootPath,
      attachmentId: Symbol(`engine-bench:${workspaceId}`),
    };
    const relayClient = routes
      ? new modules.EngineRelayClient({
          sessions,
          routes,
          allowInsecureLoopbackForTests:
            new URL(relayConnection.baseUrl).protocol === "http:",
          requestDeadlineMs: 10 * 60 * 1000,
        })
      : null;
    const relay = relayClient?.bind({
      ...workspace,
      relay: relayConnection,
    });
    const capture = modules.createWorkspaceEngineCapture({
      ...workspace,
      rustEngineSessions: sessions,
      daemonOwnsCapture: true,
    });
    let closed = false;
    return {
      rootPath,
      workspace,
      sessions,
      capture,
      relay,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await capture.stop();
          await relayClient?.closeAll();
          await sessions.closeAll();
        } finally {
          await lifecycle.stop();
        }
      },
    };
  } catch (error) {
    await lifecycle.stop().catch(() => undefined);
    throw error;
  }
}

async function openPlaintextSession({
  daemon,
  modules,
  recordUpdateDeadlineMs,
}) {
  return await daemon.sessions.run(daemon.workspace, async (binding) => {
    const transport =
      recordUpdateDeadlineMs === undefined
        ? binding.client
        : withMethodDeadline(
            binding.client,
            "ydoc.recordUpdate",
            recordUpdateDeadlineMs,
          );
    const adapter = new modules.YdocLiveAdapter(transport);
    try {
      const session = await adapter.openSession({
        workspace: binding.workspace,
        versionId: "main",
        path: "notes/bench.txt",
        contentKind: "plaintext",
        seedAbsentLineage: false,
      });
      return { adapter, session };
    } catch (error) {
      adapter.dispose();
      throw error;
    }
  });
}

function withMethodDeadline(inner, method, deadlineMs) {
  return {
    get helloAck() {
      return inner.helloAck;
    },
    sendRequest(request) {
      return inner.sendRequest(
        request.method === method ? { ...request, deadlineMs } : request,
      );
    },
    onEvent(handler) {
      return inner.onEvent(handler);
    },
    onBlob(handler) {
      if (inner.onBlob === undefined) {
        throw new Error("The benchmark transport does not expose blob delivery.");
      }
      return inner.onBlob(handler);
    },
  };
}

async function seedPlaintextSession(session, Y, text) {
  if (session.lineage !== "absent") {
    throw new Error(`Expected an absent Y.Doc lineage, received ${session.lineage}.`);
  }
  const seed = new Y.Doc();
  seed.getText("plainText").insert(0, text);
  await session.applySeedUpdate(Y.encodeStateAsUpdate(seed));
  if (session.lineage !== "existing") {
    throw new Error("The Y.Doc seed did not establish a lineage.");
  }
}

async function appendMarker(session, marker) {
  await session.applyLocalEdit((doc) => {
    const text = doc.getText("plainText");
    text.insert(text.length, marker);
  });
}

async function pullIntoCapture(daemon) {
  return await daemon.capture.runRelaySync((materializePage) =>
    daemon.relay.pull(materializePage),
  );
}

function deferredRowCount(rootPath) {
  const requireFromHere = createRequire(import.meta.url);
  const { DatabaseSync } = requireFromHere("node:sqlite");
  const database = new DatabaseSync(
    join(rootPath, ".dohc", "engine", "engine.db"),
    { readOnly: true },
  );
  try {
    const row = database
      .prepare(
        "SELECT COUNT(*) AS count FROM ydoc_deferred_updates",
      )
      .get();
    return Number(row.count);
  } finally {
    database.close();
  }
}

async function spawnTlsRelayProxy(
  targetBaseUrl,
  { certPath, keyPath, hostname, latencyMs = 0 },
) {
  const target = new URL(targetBaseUrl);
  const counter = createRequestCounter();
  const cert = await readFile(certPath);
  const key = await readFile(keyPath);
  const server = createHttpsServer({ cert, key }, (incoming, outgoing) => {
    const pathname = new URL(
      incoming.url ?? "/",
      `http://${incoming.headers.host ?? "127.0.0.1"}`,
    ).pathname;
    counter.note(incoming.method ?? "GET", pathname);
    const upstream = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, host: target.host },
      },
      (response) => {
        const forwardResponse = () => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        };
        if (latencyMs === 0) {
          forwardResponse();
        } else {
          setTimeout(forwardResponse, latencyMs);
        }
      },
    );
    upstream.on("error", (error) => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end(String(error));
    });
    incoming.pipe(upstream);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The relay counting proxy did not bind a TCP port.");
  }
  return {
    baseUrl: `https://${hostname}:${address.port}`,
    counter,
    stop: () =>
      new Promise((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

function createRequestCounter() {
  let entries = [];
  return {
    note(method, pathname) {
      entries.push({ method, pathname });
    },
    reset() {
      entries = [];
    },
    snapshot() {
      return { entries: entries.map((entry) => ({ ...entry })) };
    },
  };
}

function classifyRelayRequests(entries) {
  const counts = {};
  for (const entry of entries) {
    const pathClass = /\/blobs\/[0-9a-f]{64}$/u.test(entry.pathname)
      ? "blob"
      : entry.pathname.endsWith("/log")
        ? "log"
        : "other";
    const key = `${entry.method} ${pathClass}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function commonBenchEnvelope(run, bench, hypothesis) {
  return {
    schemaVersion: run.schemaVersion,
    capturedAt: new Date().toISOString(),
    gitCommit: run.gitCommit,
    scale: run.scale,
    machine: run.machine,
    bench,
    discoveryHypothesis: hypothesis,
    status: "pass",
  };
}

async function readExistingBenchResult(output, filename, expectedBench, run) {
  const path = join(output, filename);
  let result;
  try {
    result = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot reuse ${path}; run ${expectedBench.toLowerCase()} first: ${String(error)}`,
    );
  }
  if (
    result.schemaVersion !== run.schemaVersion ||
    result.status !== "pass" ||
    result.bench !== expectedBench ||
    result.gitCommit !== run.gitCommit ||
    result.scale !== run.scale
  ) {
    throw new Error(
      `Cannot reuse ${path}; schema, status, bench, commit, or scale does not match this run.`,
    );
  }
  if (expectedBench === "B1") {
    for (const engineName of ["debug", "release"]) {
      const engine = result.engines?.find(
        (candidate) => candidate.engine === engineName,
      );
      if (engine?.binary?.sha256 !== run.engines[engineName].sha256) {
        throw new Error(
          `Cannot reuse ${path}; ${engineName} engine binary does not match.`,
        );
      }
    }
  } else if (result.binary?.sha256 !== run.engines.release.sha256) {
    throw new Error(`Cannot reuse ${path}; release engine binary does not match.`);
  }
  console.log(`[engine-bench] reusing ${path}`);
  return result;
}

function summarizeSeries(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    min: roundMs(sorted[0]),
    p50: roundMs(percentile(sorted, 0.5)),
    p95: roundMs(percentile(sorted, 0.95)),
    max: roundMs(sorted[sorted.length - 1]),
    mean: roundMs(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

function percentile(sortedValues, fraction) {
  return sortedValues[Math.max(0, Math.ceil(sortedValues.length * fraction) - 1)];
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function roundRatio(value) {
  return Math.round(value * 1000) / 1000;
}

function formatBytes(value) {
  if (value >= 1024 * 1024) return `${value / (1024 * 1024)}MiB`;
  return `${value / 1024}KiB`;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}.`);
  }
}

function assertIncludes(actual, expected, label) {
  if (!actual.includes(expected)) {
    throw new Error(`${label}: expected materialized text to include ${expected}.`);
  }
}

async function assertFile(path, label) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${label} is not a file: ${path}`);
}

async function binaryMetadata(path) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  await once(stream, "end");
  const metadata = await stat(path);
  return {
    path,
    sizeBytes: metadata.size,
    modifiedAt: metadata.mtime.toISOString(),
    sha256: hash.digest("hex"),
  };
}

async function certificateMetadata(path, hostname) {
  const pem = await readFile(path);
  const certificate = new X509Certificate(pem);
  return {
    hostname,
    certificateSha256: createHash("sha256").update(pem).digest("hex"),
    subject: certificate.subject,
    issuer: certificate.issuer,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
  };
}

function machineMetadata() {
  return {
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
  };
}

async function gitOutput(args) {
  const child = spawn("git", args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}.`);
  return output.trim();
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
