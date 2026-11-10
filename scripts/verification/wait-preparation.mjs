import { setTimeout } from "node:timers/promises";
import { resolve } from "node:path";

// Shards install their dependencies while the shared build runs. The complete
// gate still includes both jobs, their transfer, and this wait.
export async function waitForPreparation(scope, { env = process.env, request = fetch, pause = setTimeout, now = Date.now } = {}) {
  const preparation = scope === "js" ? { job: "shared preparation + confinement", artifact: "javascript-prepared", seconds: 300 }
    : scope === "rust" ? { job: "Rust build once", artifact: "rust-tests", seconds: 600 } : null;
  if (!preparation) throw new Error("Select js or rust preparation.");
  for (const key of ["GITHUB_API_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_TOKEN"]) {
    if (!env[key]) throw new Error(`Missing ${key} for shared preparation.`);
  }
  const base = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const name = `${preparation.artifact}-${env.GITHUB_RUN_ATTEMPT}`;
  let deadline = now() + preparation.seconds * 1000, requests = 0;
  const overBudget = () => new Error(`Shared ${scope} preparation exceeded the complete gate's ${preparation.seconds}s budget.`);
  async function read(path) {
    const remaining = deadline - now();
    if (remaining <= 0) throw overBudget();
    if (++requests > 128) throw new Error("Shared preparation exceeded its 128-request bound.");
    const response = await request(base + path, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(Math.min(10_000, remaining)),
    });
    if (!response.ok) throw new Error(`Cannot read shared ${scope} preparation: HTTP ${response.status}.`);
    const data = await response.json();
    if (now() >= deadline) throw overBudget();
    return data;
  }
  console.log(`Waiting for ${name}; dependency setup overlaps the shared build.`);
  while (true) {
    const { jobs } = await read(`/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`);
    if (!Array.isArray(jobs) || jobs.length >= 100) throw new Error("Cannot identify the complete preparation job group.");
    const selections = jobs.filter(job => job.name === "what changed");
    if (selections.length !== 1 || !Number.isFinite(Date.parse(selections[0].started_at))) throw new Error("Gate selection has no unique start time.");
    deadline = Date.parse(selections[0].started_at) + preparation.seconds * 1000;
    const builds = jobs.filter(job => job.name === preparation.job);
    if (builds.length > 1) throw new Error(`Duplicate ${preparation.job} jobs.`);
    if (builds.some(job => job.status === "completed" && job.conclusion !== "success")) throw new Error(`${preparation.job} ended with ${builds[0].conclusion}.`);
    const { artifacts } = await read(`/artifacts?name=${encodeURIComponent(name)}&per_page=100`);
    if (!Array.isArray(artifacts)) throw new Error("The preparation artifact inventory is missing.");
    const matching = artifacts.filter(artifact => artifact.name === name && !artifact.expired);
    if (matching.length > 1) throw new Error(`Duplicate preparation artifact ${name}.`);
    if (matching.length === 1 && builds.length === 1) return { artifact: matching[0], deadline };
    const remaining = deadline - now();
    if (remaining <= 0) throw overBudget();
    await pause(Math.min(10_000, remaining));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  waitForPreparation(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
}
