import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { build, transform } from "esbuild";
import { createDatasetHost } from "../dist/dataset-host.mjs";
import { createDatasetJournal } from "../dist/journal.mjs";
import { createDatasetSupervisor } from "../dist/supervisor.mjs";

const OPS = Number(process.argv[2] ?? 2000);
const LEVELS = (process.argv[3] ?? "10,30").split(",").map(Number);
const WARMUP = 100;
const SEED_ITEMS = 5000;
const MILESTONES = 10;
const AREAS = ["platform", "apps", "sync", "mobile"];
const APPS = ["roadmap-pm", "eng-triage", "exec-rollup"];
const STATUSES = ["new", "triaged", "planned", "in_progress", "done"];
if (
  !Number.isInteger(OPS) ||
  OPS < 100 ||
  LEVELS.some((level) => !Number.isInteger(level) || level < 1)
)
  throw new Error("Usage: benchmark-team-roadmap.mjs [ops per run >= 100] [levels, e.g. 10,30]");

const example = (file) =>
  readFileSync(new URL(`../../../examples/team-roadmap/${file}`, import.meta.url), "utf8");
const contract = (file) =>
  fileURLToPath(new URL(`../../security-contract/src/${file}`, import.meta.url)).replaceAll(
    "\\",
    "/",
  );
const scratch = await mkdtemp(join(tmpdir(), "dohc-team-roadmap-bench-"));
const bundle = await build({
  stdin: {
    contents: `export { describeDatasetRevision } from "${contract("datasetArtifacts.ts")}";
      export { parseAppDatasetReference, parseDatasetDefinition, resolveAppDatasetReferenceBinding } from "${contract("dataset.ts")}";`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
await writeFile(join(scratch, "contract.mjs"), bundle.outputFiles[0].text);
const {
  describeDatasetRevision,
  parseAppDatasetReference,
  parseDatasetDefinition,
  resolveAppDatasetReferenceBinding,
} = await import(pathToFileURL(join(scratch, "contract.mjs")).href);

const definition = parseDatasetDefinition(JSON.parse(example("roadmap/dataset.json")), {
  descriptorPath: "team-roadmap/roadmap/dataset.json",
});
const schemaSql = example("roadmap/schema.sql");
const operationSource = example("roadmap/operations.js");
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
const operationId = (name) =>
  definition.operations.find((entry) => entry.name === name).operationId;
const PEOPLE = {
  pm: { kind: "owner", userId: "pm" },
  exec: { kind: "named", userId: "exec", grantId: "leads", access: "view", helper: false },
};
const person = (name) =>
  PEOPLE[name] ?? { kind: "named", userId: name, grantId: "eng", access: "edit", helper: false };

const usage = { hostSqlite: 0, ipc: 0, workerSqlite: 0, boot: 0, guest: 0, checkpoints: 0 };
let instrumented = false;
function timeHost(owner, name) {
  const original = owner[name];
  owner[name] = function (...args) {
    if (!instrumented) return original.apply(this, args);
    const start = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      usage.hostSqlite += performance.now() - start;
    }
  };
}
for (const name of ["exec", "prepare"]) timeHost(DatabaseSync.prototype, name);
for (const name of ["run", "get", "all"]) timeHost(StatementSync.prototype, name);
const iterate = StatementSync.prototype.iterate;
StatementSync.prototype.iterate = function (...args) {
  const iterator = iterate.apply(this, args);
  if (instrumented) timeHost(iterator, "next");
  return iterator;
};

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function open(level) {
  const directory = await mkdtemp(join(scratch, `level-${level}-`));
  const db = new DatabaseSync(join(directory, "host.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  const transaction = (run) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const journal = createDatasetJournal({ db, transaction });
  const commands = new Map();
  const snapshots = [];
  const childEntry = fileURLToPath(new URL("./benchmark-team-roadmap-child.mjs", import.meta.url));
  const launch = (options) => {
    const args = instrumented ? [childEntry, options.entryPath] : [options.entryPath];
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--max-old-space-size=96", ...args],
      {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
        windowsHide: true,
      },
    );
    child.on("message", (message) => {
      const timing = message?.teamRoadmapTiming;
      const sent = commands.get(timing?.id ?? message?.id);
      if (timing) {
        if (sent) sent.child = timing;
        return;
      }
      if (sent && typeof message.ok === "boolean") {
        commands.delete(message.id);
        const rtt = performance.now() - sent.at;
        if (sent.kind === "snapshot") snapshots.push(rtt);
        if (instrumented) {
          const child = sent.child ?? { totalMs: rtt, sqliteMs: 0, bootMs: 0 };
          usage.ipc += rtt - child.totalMs;
          if (sent.kind === "snapshot") usage.checkpoints += child.totalMs;
          else {
            usage.workerSqlite += child.sqliteMs;
            usage.boot += child.bootMs;
            usage.guest += child.totalMs - child.sqliteMs - child.bootMs;
          }
        }
      }
      options.onMessage(message);
    });
    child.on("error", options.onError);
    child.on("close", options.onExit);
    return {
      postMessage(message) {
        commands.set(message.id, { kind: message.command?.kind, at: performance.now() });
        child.send(message, (error) => {
          if (error) options.onError(error);
        });
      },
      kill() {
        child.kill("SIGKILL");
      },
    };
  };
  const supervisor = await createDatasetSupervisor({
    journal,
    directory: async () => {
      await mkdir(join(directory, "workers"), { recursive: true });
      return join(directory, "workers");
    },
    runtime: { launch },
    maintenanceStorage: { authorize() {}, account() {} },
  });
  const host = createDatasetHost({
    db,
    transaction,
    journal,
    supervisor,
    resolveAuthority(name, request) {
      if (request.access.kind === "app" && !APPS.includes(request.access.appId))
        throw new Error("Unknown app");
      return {
        principalKey: name,
        ...(request.access.kind === "app" ? { appId: request.access.appId } : {}),
        caller: person(name),
      };
    },
    compileOperations: async (source) =>
      (await transform(source, { loader: "js", target: "es2022" })).code,
    operationResources: () => ({ files: [], accountAndAttach: () => undefined }),
  });
  const scope = { workspaceId: "workspace", datasetId: definition.datasetId };
  await host.activate("pm", { workspaceId: "workspace", revision, schemaSql, operationSource });
  for (const app of APPS) {
    const reference = parseAppDatasetReference(
      JSON.parse(example(`${app}/app.publish.json`)).dataset,
    );
    host.setBinding("pm", {
      ...scope,
      appId: app,
      binding: resolveAppDatasetReferenceBinding(reference, definition.datasetId, revision),
    });
  }
  let sequence = 0;
  async function call(name, app, operation, input = {}) {
    const trace = { operation, start: performance.now() };
    try {
      const reply = await host.invoke(name, {
        ...scope,
        revision: 1,
        revisionSha256: revision.revisionSha256,
        operationId: operationId(operation),
        input,
        idempotencyKey: `bench-${++sequence}`,
        access: { kind: "app", appId: app },
      });
      trace.end = performance.now();
      return { trace, result: reply.result };
    } catch (error) {
      trace.end = performance.now();
      trace.error = error?.refusal?.code ?? error?.code ?? "error";
      return { trace };
    }
  }
  return {
    call,
    snapshots,
    grant(principalKey) {
      host.setDataGrant("pm", {
        ...scope,
        principalKey,
        grant: {
          revision: 1,
          revisionSha256: revision.revisionSha256,
          operationIds: ["listItems", "triageItem", "updateStatus"].map(operationId),
          discover: true,
        },
      });
    },
    async close() {
      await supervisor.close();
      db.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    },
    sqliteVersion: db.prepare("SELECT sqlite_version() AS v").get().v,
  };
}

function seedBatch(batch, random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const milestones = Array.from({ length: MILESTONES }, (_, index) => ({
    name: `M${index + 1}`,
    dueOn: `2027-${String(index + 1).padStart(2, "0")}-15`,
  }));
  const items = Array.from({ length: 1000 }, (_, index) => {
    const roll = random();
    const status =
      roll < 0.4
        ? "new"
        : roll < 0.6
          ? "triaged"
          : roll < 0.75
            ? "planned"
            : roll < 0.9
              ? "in_progress"
              : "done";
    return {
      title: `Roadmap item ${batch * 1000 + index + 1}`,
      detail: "Seeded by the team roadmap benchmark.",
      area: pick(AREAS),
      status,
      ...(status === "new" ? {} : { estimateDays: 1 + Math.floor(random() * 20) }),
      ...(status === "new" || status === "triaged"
        ? {}
        : { priority: Math.floor(random() * 4), milestone: pick(milestones).name }),
    };
  });
  return { milestones: batch === 0 ? milestones : [], items };
}

async function seed(f) {
  const random = seeded(7);
  const started = performance.now();
  for (let batch = 0; batch < SEED_ITEMS / 1000; batch++) {
    const { trace } = await f.call("pm", "roadmap-pm", "importItems", seedBatch(batch, random));
    if (trace.error) throw new Error(`Seed failed: ${trace.error}`);
  }
  const seedMs = performance.now() - started;
  const byStatus = {};
  for (const status of STATUSES) {
    byStatus[status] = [];
    let after;
    do {
      const { result, trace } = await f.call("pm", "roadmap-pm", "listItems", {
        status,
        ...(after ? { after } : {}),
      });
      if (trace.error) throw new Error(`Listing failed: ${trace.error}`);
      byStatus[status].push(
        ...result.items.map((item) => ({ id: item.id, version: item.version })),
      );
      after = result.next;
    } while (after);
  }
  return { seedMs, byStatus };
}

function callers(level, byStatus, milestones) {
  const roles = Array.from({ length: level }, (_, index) =>
    index % 10 < 2 ? "pm" : index % 10 < 7 ? "eng" : "exec",
  );
  const count = (role) => roles.filter((entry) => entry === role).length;
  const seen = { pm: 0, eng: 0, exec: 0 };
  const share = (items, role, index) =>
    items.filter((_, position) => position % count(role) === index);
  return roles.map((role) => {
    const index = seen[role]++;
    const working = [
      ...byStatus.in_progress.map((item) => ({ ...item, status: "in_progress" })),
      ...byStatus.done.map((item) => ({ ...item, status: "done" })),
    ];
    return {
      role,
      name: role === "eng" ? `eng-${index + 1}` : role,
      app: role === "pm" ? "roadmap-pm" : role === "eng" ? "eng-triage" : "exec-rollup",
      plannable:
        role === "pm" ? share([...byStatus.triaged, ...byStatus.planned], role, index) : [],
      untriaged: role === "eng" ? share(byStatus.new, role, index) : [],
      working: role === "eng" ? share(working, role, index) : [],
      milestones,
    };
  });
}

function nextCall(caller, random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const roll = random();
  if (caller.role === "exec" || (caller.role === "pm" && roll < 0.2))
    return { operation: "rollup" };
  if (roll < (caller.role === "pm" ? 0.7 : 0.5))
    return { operation: "listItems", input: { status: pick(STATUSES) } };
  if (caller.role === "pm") {
    if (roll < 0.9) {
      const item = pick(caller.plannable);
      return {
        item,
        operation: "planItem",
        input: {
          id: item.id,
          version: item.version,
          priority: Math.floor(random() * 4),
          milestoneId: pick(caller.milestones),
        },
      };
    }
    return {
      operation: "createItem",
      input: { title: `Benchmark request ${Math.floor(random() * 1e6)}`, area: pick(AREAS) },
    };
  }
  if (caller.untriaged.length && roll < 0.75) {
    const item = caller.untriaged.pop();
    return {
      item,
      operation: "triageItem",
      input: { id: item.id, version: item.version, estimateDays: 1 + Math.floor(random() * 10) },
    };
  }
  const item = pick(caller.working);
  item.status = item.status === "done" ? "in_progress" : "done";
  return {
    item,
    operation: "updateStatus",
    input: { id: item.id, version: item.version, status: item.status },
  };
}

async function workload(f, group, total, random, record) {
  let remaining = total;
  const started = performance.now();
  await Promise.all(
    group.map(async (caller) => {
      while (remaining > 0) {
        remaining--;
        const { operation, input, item } = nextCall(caller, random);
        const { trace, result } = await f.call(caller.name, caller.app, operation, input);
        if (item && result?.item) item.version = result.item.version;
        record(trace);
      }
    }),
  );
  return performance.now() - started;
}

function percentile(sorted, p) {
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}
const ms = (value) => value.toFixed(value < 10 ? 2 : 1);

async function runLevel(level, withTiming) {
  instrumented = withTiming;
  const f = await open(level);
  try {
    const { seedMs, byStatus } = await seed(f);
    const { result } = await f.call("pm", "roadmap-pm", "rollup");
    const group = callers(
      level,
      byStatus,
      result.milestones.map((milestone) => milestone.id),
    );
    for (const caller of group) if (caller.role === "eng") f.grant(caller.name);
    const random = seeded(level);
    await workload(f, group, WARMUP, random, () => {});
    const traces = [];
    f.snapshots.length = 0;
    for (const key of Object.keys(usage)) usage[key] = 0;
    const loop = performance.eventLoopUtilization();
    const elapsed = await workload(f, group, OPS, random, (trace) => traces.push(trace));
    const hostBusy = performance.eventLoopUtilization(loop).active;
    return {
      level,
      seedMs,
      elapsed,
      traces,
      snapshots: [...f.snapshots],
      sqlite: f.sqliteVersion,
      usage: { ...usage },
      hostBusy,
    };
  } finally {
    await f.close();
    instrumented = false;
  }
}

function breakdown(run) {
  const ok = run.traces.filter((trace) => !trace.error);
  const per = (value) => value / Math.max(1, ok.length);
  const { hostSqlite, ipc, workerSqlite, boot, guest, checkpoints } = run.usage;
  return {
    wall: per(run.elapsed),
    latency: per(ok.reduce((sum, trace) => sum + trace.end - trace.start, 0)),
    hostBusy: per(run.hostBusy),
    hostSqlite: per(hostSqlite),
    hostJs: per(run.hostBusy - hostSqlite),
    worker: per(workerSqlite + boot + guest + checkpoints),
    workerSqlite: per(workerSqlite),
    boot: per(boot),
    guest: per(guest),
    checkpoints: per(checkpoints),
    ipc: per(ipc),
  };
}

const print = (line = "") => console.log(line);
const cpu = cpus()[0]?.model ?? "unknown CPU";
const results = [];
for (const level of LEVELS) {
  const plain = await runLevel(level, false);
  const timed = await runLevel(level, true);
  results.push({ plain, timed });
}

print(
  `Team roadmap benchmark: ${SEED_ITEMS} seeded items, ${OPS} measured operations per run after ${WARMUP} warm-up.`,
);
print(
  `${cpu}, ${cpus().length} threads, ${Math.round(totalmem() / 2 ** 30)} GiB, ${platform()} ${release()}, Node ${process.versions.node}, SQLite ${results[0].plain.sqlite}.`,
);
print(
  "Mix per 10 callers: 2 product (roadmap-pm), 5 engineering (eng-triage), 3 exec (exec-rollup).",
);
print();
print("| Callers | Seed 5,000 (ms) | Ops/s | p50 ms | p95 ms | p99 ms | Refused | Snapshots |");
print("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const { plain } of results) {
  const latency = stats(
    plain.traces.filter((trace) => !trace.error).map((trace) => trace.end - trace.start),
  );
  const ok = plain.traces.filter((trace) => !trace.error).length;
  const refused = plain.traces.length - ok;
  print(
    `| ${plain.level} | ${ms(plain.seedMs)} | ${Math.round((ok / plain.elapsed) * 1000)} | ${ms(latency.p50)} | ${ms(latency.p95)} | ${ms(latency.p99)} | ${refused} | ${plain.snapshots.length} |`,
  );
}
print();
print("Latency by operation (plain run, ms):");
print();
print("| Callers | Operation | Count | p50 | p95 | p99 |");
print("| --- | --- | --- | --- | --- | --- |");
for (const { plain } of results) {
  const names = [...new Set(plain.traces.map((trace) => trace.operation))].sort();
  for (const name of names) {
    const latency = stats(
      plain.traces
        .filter((trace) => trace.operation === name && !trace.error)
        .map((trace) => trace.end - trace.start),
    );
    print(
      `| ${plain.level} | ${name} | ${latency.count} | ${ms(latency.p50)} | ${ms(latency.p95)} | ${ms(latency.p99)} |`,
    );
  }
}
print();
print("Where the time goes (instrumented run, ms per successful operation):");
print();
print(
  "| Callers | Wall | Mean latency | Host thread busy | Host SQLite | Host JS | Worker busy | Worker SQLite | QuickJS boot | Guest + worker JS | Checkpoints | IPC + reply wait |",
);
print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const { timed } of results) {
  const b = breakdown(timed);
  print(
    `| ${timed.level} | ${ms(b.wall)} | ${ms(b.latency)} | ${ms(b.hostBusy)} | ${ms(b.hostSqlite)} | ${ms(b.hostJs)} | ${ms(b.worker)} | ${ms(b.workerSqlite)} | ${ms(b.boot)} | ${ms(b.guest)} | ${ms(b.checkpoints)} | ${ms(b.ipc)} |`,
  );
}
print();
print(
  "Wall is the measured run's duration divided by successful operations, so it is 1,000 / ops per second. Every other column is a total over the run divided by the same count, so no time is charged to the wrong operation.",
);
print(
  "The host thread and the worker process run at the same time, so their busy times can add up to more than Wall. The side whose busy time is closest to Wall is the bottleneck.",
);
print(
  "One Collection runs one operation at a time, so Mean latency minus Wall is roughly time spent waiting behind other callers.",
);
print(
  "Host thread busy is event loop utilization: host SQLite, host JS such as authorization, hashing and JSON, and the benchmark's own callers. Host JS is busy time minus host SQLite.",
);
print(
  "QuickJS boot is the 24 MiB Wasm memory plus instantiate; QuickJS runtime setup after instantiate counts as guest time. Checkpoints are materialization snapshots the worker took during the run.",
);
print(
  "IPC + reply wait is round-trip time minus the worker's own time, so it includes structured cloning and any wait for the busy host thread to read the reply.",
);
for (const { plain, timed } of results)
  for (const run of [plain, timed]) {
    const errors = run.traces
      .filter((trace) => trace.error)
      .map((trace) => `${trace.operation}:${trace.error}`);
    if (errors.length)
      console.error(
        `${run.level} callers ${run === plain ? "plain" : "instrumented"} refusals:`,
        [...new Set(errors)].join(", "),
      );
  }
await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
