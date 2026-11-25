import {
  appendFileSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { carriedOver, cloudApi } from "./cloud-api.mjs";
import { reportFlaky } from "./flaky.mjs";
import { JS_SHARDS, assertTaskCoverage } from "./shards.mjs";
import {
  RUST_ARCHIVE_PROOFS,
  RUST_POLICY_STEPS,
  RUST_READER_SHARD,
  RUST_SHARDS,
  RUST_TEST_PROOFS,
} from "./cloud-rust.mjs";

export function newestAttemptFiles(directory, file) {
  if (existsSync(join(directory, file))) return [join(directory, file)];
  const newest = new Map();
  for (const path of globSync(`${directory}/*/**/${file}`)) {
    const [artifact] = relative(directory, path).split(sep);
    const [, base, number] = /^(.+)-(\d+)$/u.exec(artifact) ?? [];
    if (!base) throw new Error(`Downloaded artifact ${artifact} names no attempt.`);
    const attempt = Number(number),
      kept = newest.get(base);
    if (!kept || attempt > kept.attempt) newest.set(base, { attempt, paths: [path] });
    else if (attempt === kept.attempt) kept.paths.push(path);
  }
  return [...newest.values()].flatMap(({ paths }) => paths);
}

export function aggregateJavascript(records) {
  const preparation = records.filter((record) => record.part === "prepare-0");
  if (preparation.length !== 1 || preparation[0].verdict !== "PASS")
    throw new Error(
      "The JavaScript preparation receipt is missing, duplicated, or unsuccessful; check preparation and worker jobs.",
    );
  const shards = records.filter((record) => /^worker-\d+$/u.test(record.part));
  const expectedParts = Array.from({ length: JS_SHARDS }, (_, index) => `worker-${index}`);
  if (
    records.length !== expectedParts.length + 1 ||
    shards.length !== expectedParts.length ||
    expectedParts.some((part) => shards.filter((record) => record.part === part).length !== 1)
  )
    throw new Error("JavaScript shard evidence is missing, duplicated, or unexpected.");
  if (new Set(records.map((record) => record.commit)).size !== 1)
    throw new Error("JavaScript parts examined different commits.");
  const inventory = [...shards[0].planned].sort();
  for (const row of shards) {
    if (JSON.stringify([...row.planned].sort()) !== JSON.stringify(inventory))
      throw new Error("JavaScript worker inventories disagree.");
    if (JSON.stringify([...row.assigned].sort()) !== JSON.stringify([...row.completed].sort()))
      throw new Error(`Incomplete JavaScript shard ${row.part}.`);
  }
  const expected = inventory.map((id) => ({ id }));
  assertTaskCoverage(expected, shards);
  if (records.filter((record) => record.selfHostNative).length !== 1)
    throw new Error("The native delivery and restart proof did not produce its evidence.");
  return {
    tasks: expected.length,
    flaky: shards.flatMap((record) => record.flaky ?? []),
    tests: shards.flatMap((record) => record.tests),
    steps: shards.flatMap((record) => record.steps ?? []),
    parts: records.map(({ part, seconds }) => ({ part, seconds })),
  };
}

export function aggregateRust(records) {
  const one = (part) => {
    const rows = records.filter((record) => record.part === part);
    if (rows.length !== 1 || rows[0].verdict !== "PASS" || rows[0].provenance?.status !== "PASS")
      throw new Error(`Rust ${part} evidence did not pass.`);
    return rows[0];
  };
  const policy = one("policy");
  if (
    policy.steps.length !== RUST_POLICY_STEPS.length ||
    RUST_POLICY_STEPS.some(
      (name) =>
        policy.steps.filter((step) => step.name === name && step.status === "PASS").length !== 1,
    )
  )
    throw new Error("A required Rust policy step is missing or did not pass.");
  const archive = one("archive-0");
  if (
    archive.scratch?.status !== "PASS" ||
    RUST_ARCHIVE_PROOFS.some(
      (name) =>
        archive.steps?.filter((step) => step.name === name && step.verdict === "PASS").length !== 1,
    )
  )
    throw new Error("A required Rust archive proof is missing or did not pass.");
  const shards = Array.from({ length: RUST_SHARDS }, (_, index) => one(`tests-${index}`));
  if (
    RUST_TEST_PROOFS.some(
      (name) =>
        records.flatMap((record) => record.steps ?? []).filter((step) => step.name === name)
          .length !== 1 ||
        shards[RUST_READER_SHARD].steps?.filter(
          (step) => step.name === name && step.verdict === "PASS",
        ).length !== 1,
    )
  )
    throw new Error("A required Rust test proof is missing, duplicated, or did not pass.");
  if (
    records.length !== shards.length + 2 ||
    new Set(records.map((record) => record.commit)).size !== 1
  )
    throw new Error("Rust parts examined different commits or unexpected evidence.");
  for (const shard of shards) {
    if (JSON.stringify([...shard.planned].sort()) !== JSON.stringify([...archive.planned].sort()))
      throw new Error("Rust inventories disagree.");
    if (JSON.stringify([...shard.assigned].sort()) !== JSON.stringify([...shard.completed].sort()))
      throw new Error(`Incomplete Rust shard ${shard.part}.`);
    if (shard.scratch?.status !== "PASS")
      throw new Error(`Rust scratch cleanup failed: ${shard.part}.`);
  }
  assertTaskCoverage(
    archive.planned.map((id) => ({ id })),
    shards,
  );
  return {
    tasks: archive.planned.length,
    steps: [
      ...policy.steps,
      ...[...RUST_ARCHIVE_PROOFS, ...RUST_TEST_PROOFS].map((name) => ({ name, status: "PASS" })),
      { name: "test --workspace", status: "PASS" },
    ],
    parts: records.map(({ part, seconds }) => ({ part, seconds })),
  };
}

// These are workflow `needs` edges. The workflow tests compare every edge and name.
export const CLOUD_JOB_GRAPH = {
  changes: { names: ["what changed"], needs: [] },
  "javascript-prepare": { names: ["shared preparation"], needs: ["changes"] },
  "javascript-workers": {
    names: Array.from({ length: JS_SHARDS }, (_, index) => `JS worker ${index}`),
    needs: ["changes"],
  },
  "rust-archive": { names: ["Rust build"], needs: ["changes"] },
  "rust-policy": { names: ["Rust policy checks"], needs: ["changes"] },
  "rust-tests": {
    names: Array.from({ length: RUST_SHARDS }, (_, index) => `Rust tests ${index}`),
    needs: ["changes", "rust-archive"],
  },
};

function gateJobNames(scope) {
  if (!["js", "rust"].includes(scope)) throw new Error(`Unknown distributed gate ${scope}.`);
  return Object.entries(CLOUD_JOB_GRAPH)
    .filter(
      ([id]) =>
        id === "changes" ||
        id === "javascript-prepare" ||
        (scope === "rust" ? id.startsWith("rust") : id.startsWith("javascript")),
    )
    .flatMap(([, node]) => node.names);
}

function jobReadyAt(job, metadata) {
  const node = Object.values(CLOUD_JOB_GRAPH).find((node) => node.names.includes(job.name));
  const sameHead = metadata.filter((dependency) => dependency.head_sha === job.head_sha);
  const dependencies = (node?.needs ?? []).flatMap((id) => {
    const { names } = CLOUD_JOB_GRAPH[id],
      present = sameHead.filter((dependency) => names.includes(dependency.name));
    return names.flatMap((name) => {
      const matches = present.filter((dependency) => dependency.name === name);
      return matches.length !== 1 ? [null] : matches[0].conclusion === "skipped" ? [] : matches;
    });
  });
  const createdAt = Date.parse(job.created_at);
  if (
    !dependencies.length ||
    dependencies.some(
      (dependency) => !dependency || !Number.isFinite(Date.parse(dependency.completed_at)),
    )
  )
    return createdAt;
  if (!carriedOver(job) && dependencies.every(carriedOver)) return createdAt;
  const readyAt = Math.max(
    ...dependencies.map((dependency) => Date.parse(dependency.completed_at)),
  );
  return readyAt <= Date.parse(job.started_at) ? readyAt : createdAt;
}

const CONTENTION_SECONDS = 30;

function gateCompletionDelay(jobs) {
  let workFinishedAt = -Infinity;
  let jobsFinishedAt = -Infinity;
  for (const job of jobs) {
    if (job.name === "what changed") continue;
    const step = Array.isArray(job.steps) ? job.steps.at(-1) : null;
    const stepEnd = Date.parse(step?.completed_at);
    const jobEnd = Date.parse(job.completed_at);
    if (
      step?.name !== "Complete job" ||
      step.conclusion !== "success" ||
      !(Date.parse(job.started_at) <= stepEnd && stepEnd <= jobEnd)
    )
      return null;
    workFinishedAt = Math.max(workFinishedAt, stepEnd);
    jobsFinishedAt = Math.max(jobsFinishedAt, jobEnd);
  }
  return Number.isFinite(workFinishedAt) ? (jobsFinishedAt - workFinishedAt) / 1000 : null;
}

function gateTiming(scope, required, metadata = required) {
  if (
    required.some(
      (job) =>
        ![job.created_at, job.started_at, job.completed_at].every((time) =>
          Number.isFinite(Date.parse(time)),
        ) || Date.parse(job.completed_at) < Date.parse(job.started_at),
    )
  )
    throw new Error(`A completed ${scope} job has invalid times.`);
  const start = Date.parse(required.find((job) => job.name === "what changed").started_at);
  const spanSeconds =
    (Math.max(...required.map((job) => Date.parse(job.completed_at))) - start) / 1000;
  const jobs = required.map((job) => ({
    name: job.name,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.completed_at,
    conclusion: job.conclusion,
    runnerWaitSeconds:
      Math.max(0, (Date.parse(job.started_at) - jobReadyAt(job, metadata)) / 1000) || 0,
  }));
  const longest = jobs
    .filter((job) => job.name !== "what changed")
    .reduce((a, b) => (a.runnerWaitSeconds > b.runnerWaitSeconds ? a : b));
  const completionDelaySeconds = gateCompletionDelay(required);
  const runnerContended = longest.runnerWaitSeconds > CONTENTION_SECONDS;
  const completionContended = completionDelaySeconds > CONTENTION_SECONDS;
  const seconds = spanSeconds;
  const targetSeconds = scope === "js" ? 300 : 600;
  const budgetSeconds = scope === "js" ? 400 : 700;
  const rerun = required.some(carriedOver);
  const contended = runnerContended || completionContended;
  const excused =
    rerun ||
    runnerContended ||
    (completionContended && seconds - completionDelaySeconds <= budgetSeconds);
  const timing =
    seconds <= targetSeconds
      ? "within budget"
      : excused
        ? "unmeasured"
        : seconds <= budgetSeconds
          ? "over target"
          : "over budget";
  const waitingFor =
    ((Date.parse(longest.startedAt) - Date.parse(longest.createdAt)) / 1000) * 2 >=
    longest.runnerWaitSeconds
      ? "runner wait"
      : "wait for GitHub to start";
  const delay = [
    rerun ? "part of the gate passed in an earlier attempt and did not run again" : null,
    runnerContended ? `longest ${waitingFor} ${longest.name}: ${longest.runnerWaitSeconds}s` : null,
    completionContended
      ? `GitHub took ${completionDelaySeconds}s to mark finished jobs complete`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  return {
    spanSeconds,
    seconds,
    targetSeconds,
    budgetSeconds,
    ...(completionDelaySeconds !== null ? { completionDelaySeconds } : {}),
    contended,
    timing,
    jobs,
    ...(timing === "unmeasured"
      ? {
          warning: `${scope} timing unmeasured: ${seconds}s exceeds the ${targetSeconds}s target; ${delay}.`,
        }
      : timing === "over target"
        ? {
            warning: `${scope} timing over target: ${seconds}s exceeds the ${targetSeconds}s target; the gate fails above ${budgetSeconds}s.`,
          }
        : {}),
  };
}

function requireBudget(scope, timing) {
  if (timing.timing === "over budget")
    throw Object.assign(
      new Error(
        `The complete ${scope} gate took ${timing.seconds}s, exceeding its ${timing.budgetSeconds}s budget.`,
      ),
      { timing },
    );
  return timing;
}

export function completedGateTiming(scope, jobs, commit) {
  const expected = gateJobNames(scope);
  const required = jobs.filter((job) => expected.includes(job.name));
  if (
    !commit ||
    required.length !== expected.length ||
    expected.some((name) => required.filter((job) => job.name === name).length !== 1) ||
    required.some(
      (job) =>
        job.status !== "completed" || job.conclusion !== "success" || job.head_sha !== commit,
    )
  ) {
    throw new Error(`A completed ${scope} job is missing, unsuccessful, or from another commit.`);
  }
  return requireBudget(scope, gateTiming(scope, required, jobs));
}

export async function verifyCompletedCloud(
  scope,
  {
    directory = `.agent-artifacts/verification/downloaded/${scope}`,
    env = process.env,
    readJobs = () => cloudApi({ env }).jobs(),
    outputDirectory = ".agent-artifacts/verification/aggregate",
  } = {},
) {
  const fullReport = {
    version: 1,
    scope,
    verdict: "FAIL",
    complete: true,
    commit: env.GITHUB_SHA,
    steps: [],
  };
  const completedReport = {
    version: 1,
    scope,
    verdict: "FAIL",
    complete: true,
    commit: env.DOHC_WORKFLOW_HEAD_SHA,
  };
  try {
    if (!["js", "rust"].includes(scope)) throw new Error(`Unknown distributed gate ${scope}.`);
    const records = newestAttemptFiles(directory, "result.json")
      .map((path) => JSON.parse(readFileSync(path, "utf8")))
      .filter((record) => record.scope === scope);
    if (!env.GITHUB_SHA || records.some((record) => record.commit !== env.GITHUB_SHA))
      throw new Error("The gate evidence does not cover the requested commit.");
    const aggregated = scope === "js" ? aggregateJavascript(records) : aggregateRust(records);
    Object.assign(fullReport, aggregated);
    if (scope === "js") completedReport.flaky = aggregated.flaky ?? [];
    const timing = completedGateTiming(scope, await readJobs(), completedReport.commit);
    Object.assign(fullReport, timing);
    Object.assign(completedReport, timing);
    fullReport.verdict = "PASS";
    completedReport.verdict = "PASS";
    return completedReport;
  } catch (error) {
    Object.assign(fullReport, error.timing, { error: error.message });
    Object.assign(completedReport, error.timing, { error: error.message });
    throw error;
  } finally {
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(
      `${outputDirectory}/${scope}-result.json`,
      JSON.stringify(fullReport, null, 2) + "\n",
    );
    writeFileSync(
      `${outputDirectory}/${scope}-completed-result.json`,
      JSON.stringify(completedReport, null, 2) + "\n",
    );
    if (scope === "rust") {
      console.log("\n== summary ==");
      for (const step of fullReport.steps) console.log(`  ${step.status} ${step.name}`);
      console.log(
        `  ${fullReport.verdict} complete gate${fullReport.error ? `: ${fullReport.error}` : ""}`,
      );
    }
    if (completedReport.warning) {
      console.warn(
        "::warning::" +
          completedReport.warning
            .replaceAll("%", "%25")
            .replaceAll("\r", "%0D")
            .replaceAll("\n", "%0A"),
      );
      if (env.GITHUB_STEP_SUMMARY)
        appendFileSync(env.GITHUB_STEP_SUMMARY, completedReport.warning + "\n");
    }
    if (scope === "js")
      reportFlaky(completedReport.flaky, { summary: env.GITHUB_STEP_SUMMARY, annotate: true });
    console.log(
      `[verification] ${completedReport.verdict} (${scope} completed group): ${JSON.stringify(completedReport)}`,
    );
  }
}
