#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, hostname, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const desktopRoot = join(repoRoot, "apps", "desktop");
const SCENARIOS = [
  { artifact: "switch-profile", spec: "switch-profile.spec.ts" },
  { artifact: "explorer-profile", spec: "explorer-profile.spec.ts" },
  { artifact: "quickopen-graph", spec: "quickopen-graph.spec.ts" },
  { artifact: "excalidraw-profile", spec: "excalidraw-profile.spec.ts" },
  { artifact: "bigdoc-profile", spec: "bigdoc-profile.spec.ts" },
];

function usage() {
  return [
    "Usage: node tools/perf-profiling/run-profiles.mjs --output <directory> [--seed <uint32>] [--tiny] [--headed]",
    "",
    "--tiny seeds a 200-file large-flat fixture and shortens timed interactions for one plumbing smoke run.",
  ].join("\n");
}

function parseArgs(argv) {
  let output = null;
  let seed = null;
  let tiny = false;
  let headed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      output = argv[++index] ?? null;
    } else if (arg === "--seed") {
      const raw = argv[++index];
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
        throw new Error(`--seed must be an unsigned 32-bit integer, received ${raw ?? "nothing"}.`);
      }
      seed = parsed;
    } else if (arg === "--tiny") {
      tiny = true;
    } else if (arg === "--headed") {
      headed = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  if (!output) throw new Error(`--output is required.\n\n${usage()}`);
  return { output: resolve(output), seed, tiny, headed };
}

async function run(command, args, options = {}) {
  console.log(`[perf-profiling] ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(
      `${command} exited ${code ?? `after signal ${signal ?? "unknown"}`}.`,
    );
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarizeSeries(values) {
  const finite = values.filter(Number.isFinite);
  return {
    count: finite.length,
    median: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    min: finite.length > 0 ? Math.min(...finite) : null,
    max: finite.length > 0 ? Math.max(...finite) : null,
  };
}

function topSelfTimeFunctions(profile) {
  if (!profile || !Array.isArray(profile.nodes)) return [];
  const selfTimeByNode = new Map();
  const samples = Array.isArray(profile.samples) ? profile.samples : [];
  const deltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas : [];
  for (let index = 0; index < Math.min(samples.length, deltas.length); index += 1) {
    const nodeId = samples[index];
    selfTimeByNode.set(nodeId, (selfTimeByNode.get(nodeId) ?? 0) + deltas[index]);
  }
  const byLocation = new Map();
  for (const node of profile.nodes) {
    const entry = {
      functionName: node.callFrame?.functionName || "(anonymous)",
      url: node.callFrame?.url || "",
      lineNumber: (node.callFrame?.lineNumber ?? -1) + 1,
      columnNumber: (node.callFrame?.columnNumber ?? -1) + 1,
      selfTimeUs: selfTimeByNode.get(node.id) ?? 0,
      samples: node.hitCount ?? 0,
    };
    const key = `${entry.functionName}\u0000${entry.url}\u0000${entry.lineNumber}\u0000${entry.columnNumber}`;
    const current = byLocation.get(key);
    if (current) {
      current.selfTimeUs += entry.selfTimeUs;
      current.samples += entry.samples;
    } else {
      byLocation.set(key, entry);
    }
  }
  return [...byLocation.values()]
    .filter((entry) => entry.selfTimeUs > 0 && entry.functionName !== "(idle)")
    .sort((left, right) => right.selfTimeUs - left.selfTimeUs)
    .slice(0, 10);
}

function commonSummary(measurements) {
  return {
    cpuProfileTop10SelfTimeFunctions: topSelfTimeFunctions(measurements.cpuProfile),
    longTaskCount: measurements.longTasks?.count ?? null,
    longTaskTotalDurationMs: measurements.longTasks?.totalDurationMs ?? null,
    reactCommitCount: measurements.reactCommitCount ?? null,
  };
}

function summarizeArtifacts(artifacts) {
  const switchMeasurements = artifacts["switch-profile"].measurements;
  const phases = [
    "switch-start",
    "session-admitted",
    "files-painted",
    "files-revalidated",
    "history-ready",
    "restored-active-surface-ready",
  ];
  const phaseOffsetsMs = Object.fromEntries(
    phases.map((phase) => [
      phase,
      summarizeSeries(
        switchMeasurements.timeline.flatMap((entry) =>
          Number.isFinite(entry.phases[phase]) ? [entry.phases[phase]] : [],
        ),
      ),
    ]),
  );
  const explorer = artifacts["explorer-profile"].measurements;
  const quickOpen = artifacts["quickopen-graph"].measurements;
  const excalidraw = artifacts["excalidraw-profile"].measurements;
  const bigDoc = artifacts["bigdoc-profile"].measurements;
  return {
    switch: {
      ...commonSummary(switchMeasurements),
      switches: switchMeasurements.switches,
      elapsedMs: switchMeasurements.elapsedMs,
      phaseOffsetsMs,
    },
    explorer: {
      ...commonSummary(explorer),
      mountedRows: explorer.mountedRows,
      interactionDurationMs: explorer.interactionDurationMs,
      taskDurationSeconds: explorer.performance?.delta?.TaskDuration ?? null,
      scriptDurationSeconds: explorer.performance?.delta?.ScriptDuration ?? null,
    },
    quickOpenGraph: {
      ...commonSummary(quickOpen),
      queryTimings: quickOpen.queryTimings,
      graphOpenToReadyMs: quickOpen.graphOpenToReadyMs,
      graphDocCount: quickOpen.graphDocCount,
      graphLinkCount: quickOpen.graphLinkCount,
    },
    excalidraw: {
      ...commonSummary(excalidraw),
      elementCount: artifacts["excalidraw-profile"].fixture.elementCount,
      pointerFrames: excalidraw.pointerFrames,
      actualDragDurationMs: excalidraw.actualDragDurationMs,
      taskDurationSeconds: excalidraw.performance?.delta?.TaskDuration ?? null,
      scriptDurationSeconds: excalidraw.performance?.delta?.ScriptDuration ?? null,
    },
    bigDoc: {
      ...commonSummary(bigDoc),
      bytes: artifacts["bigdoc-profile"].fixture.bytes,
      typedCharacters: bigDoc.typedCharacters,
      elapsedMs: bigDoc.elapsedMs,
      markdownOpenMs:
        bigDoc.rendererMarks?.after?.measures?.["markdown-open"] ?? null,
      taskDurationSeconds: bigDoc.performance?.delta?.TaskDuration ?? null,
      scriptDurationSeconds: bigDoc.performance?.delta?.ScriptDuration ?? null,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixtures = join(options.output, "fixtures");
  await mkdir(options.output, { recursive: true });

  if (
    !existsSync(join(desktopRoot, "dist", "main", "main.js")) ||
    !existsSync(join(desktopRoot, "dist", "renderer", "index.html"))
  ) {
    throw new Error(
      "The desktop build is missing. Run `pnpm build:desktop` before the profiling runner.",
    );
  }

  const seedArgs = [join(scriptDir, "seed-workspaces.mjs"), "--output", fixtures];
  if (options.seed !== null) seedArgs.push("--seed", String(options.seed));
  if (options.tiny) seedArgs.push("--tiny");
  await run(process.execPath, seedArgs);

  // Stages the worktree-root target/debug daemon into the path Electron uses.
  await run(process.execPath, ["scripts/require-e2e-engine.mjs"], { cwd: desktopRoot });

  const env = {
    ...process.env,
    DOHC_PROFILE_FIXTURES: fixtures,
    DOHC_PROFILE_OUTPUT: options.output,
    DOHC_PROFILE_SCALE: options.tiny ? "tiny" : "full",
    DOHC_PROFILE_SMOKE: options.tiny ? "1" : "0",
  };
  for (const scenario of SCENARIOS) {
    const args = [
      "scripts/run-playwright.mjs",
      "--config",
      "e2e/profiling/playwright.config.ts",
      `e2e/profiling/${scenario.spec}`,
      "--workers=1",
    ];
    if (options.headed) args.push("--headed");
    await run(process.execPath, args, { cwd: desktopRoot, env });
  }

  const artifacts = {};
  for (const { artifact } of SCENARIOS) {
    artifacts[artifact] = JSON.parse(
      await readFile(join(options.output, `${artifact}.json`), "utf8"),
    );
  }
  const seedManifest = JSON.parse(
    await readFile(join(fixtures, "seed-manifest.json"), "utf8"),
  );
  const summary = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    scale: options.tiny ? "tiny" : "full",
    seed: seedManifest.seed,
    machine: {
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    scenarios: summarizeArtifacts(artifacts),
  };
  await writeFile(join(options.output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`[perf-profiling] wrote ${join(options.output, "summary.json")}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
