// 0P-C perf evidence: bootstrap of a 1,000-file workspace through the relay
// (the join flow's engine path — push from the seeded machine, then a fresh
// machine pulls everything from since=0). Run from services/sync-relay:
//
//   node --import tsx/esm scripts/bench-bootstrap.mjs [fileCount]
//
// Honest numbers, no assertions — the join E2E proves behavior; this records
// scale.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { cpus } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimRelayWorkspace,
  createVersionedTextStore,
  pullWorkspaceFromRelay,
  pushWorkspaceToRelay,
} from "@dohc/workspace-engine";

const FILE_COUNT = Number(process.argv[2] ?? 1000);
const WORKSPACE_ID = "bench-bootstrap";
const TOKEN = "test:bench-user";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

async function spawnRelay(dbPath) {
  const child = spawn(process.execPath, ["--import", "tsx/esm", "src/main.ts"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0",
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseUrl = await new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error("relay did not listen")), 20_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = /SYNC_RELAY_LISTENING host=([^\s]+) port=(\d+)/u.exec(stdout);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://${match[1]}:${match[2]}`);
      }
    });
    child.on("exit", (code) => reject(new Error(`relay exited: ${code}`)));
  });
  return { baseUrl, stop: () => child.kill("SIGTERM") };
}

const roots = [];
async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), `dohc-bench-${label}-`));
  roots.push(root);
  return root;
}

const seedRoot = await tempRoot("seed");
const freshRoot = await tempRoot("fresh");
const relayDb = join(await tempRoot("relay"), "relay.sqlite");

const seedStart = performance.now();
const store = createVersionedTextStore(seedRoot);
try {
  await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
  for (let index = 0; index < FILE_COUNT; index += 1) {
    await store.writeTextFile({
      workspaceId: WORKSPACE_ID,
      versionId: "main",
      path: `notes/topic-${Math.floor(index / 50)}/file-${index}.md`,
      text: `# File ${index}\n\n${"Body line for bootstrap benchmarking. ".repeat(12)}\n`,
      metadata: { origin: "local-file" },
    });
  }
} finally {
  await store.close();
}
const seedMs = performance.now() - seedStart;

const relay = await spawnRelay(relayDb);
const connection = { baseUrl: relay.baseUrl, token: TOKEN };
try {
  await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: connection });

  const pushStart = performance.now();
  const pushed = await pushWorkspaceToRelay({
    rootDir: seedRoot,
    workspaceId: WORKSPACE_ID,
    relay: connection,
  });
  const pushMs = performance.now() - pushStart;

  const pullStart = performance.now();
  const pulled = await pullWorkspaceFromRelay({
    rootDir: freshRoot,
    workspaceId: WORKSPACE_ID,
    relay: connection,
  });
  await pulled.commitFetchCursor();
  const pullMs = performance.now() - pullStart;

  const noopStart = performance.now();
  const noop = await pullWorkspaceFromRelay({
    rootDir: freshRoot,
    workspaceId: WORKSPACE_ID,
    relay: connection,
  });
  await noop.commitFetchCursor();
  const noopMs = performance.now() - noopStart;

  console.log(
    JSON.stringify(
      {
        machine: cpus()[0]?.model ?? "unknown",
        node: process.version,
        fileCount: FILE_COUNT,
        seedMs: Math.round(seedMs),
        push: { ops: pushed.pushed, ms: Math.round(pushMs) },
        bootstrapPull: {
          fetched: pulled.fetched,
          applied: pulled.applied,
          files: pulled.fastForwardedPaths.length,
          ms: Math.round(pullMs),
        },
        quiescentPullMs: Math.round(noopMs),
      },
      null,
      2,
    ),
  );
} finally {
  relay.stop();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
