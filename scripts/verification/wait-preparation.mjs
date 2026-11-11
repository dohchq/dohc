import { setTimeout } from "node:timers/promises";
import { resolve } from "node:path";
import { cloudApi, QUEUED_STATUSES } from "./cloud-api.mjs";

export async function waitForPreparation(scope, { env = process.env, request = fetch, pause = setTimeout, now = Date.now, download = false } = {}) {
  const preparation = scope === "js" ? { job: "shared preparation", artifact: "javascript-prepared" }
    : scope === "rust" ? { job: "Rust build once", artifact: "rust-tests" } : null;
  if (!preparation) throw new Error("Select js or rust preparation.");
  for (const key of ["GITHUB_API_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_TOKEN"]) {
    if (!env[key]) throw new Error(`Missing ${key} for shared preparation.`);
  }
  const api = cloudApi({ env, request }), deadline = now() + 15 * 60_000;
  const name = `${preparation.artifact}-${env.GITHUB_RUN_ATTEMPT}`;
  let build, checkAt = -Infinity;
  console.log(`Waiting for ${name}; dependency setup overlaps the shared build.`);
  try {
    for (;;) {
      if (now() >= checkAt || now() >= deadline) {
        const { jobs } = await api.read(`/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`);
        if (!Array.isArray(jobs) || jobs.length >= 100) throw new Error("Cannot identify the complete preparation job group.");
        const builds = jobs.filter(job => job.name === preparation.job);
        if (builds.length > 1) throw new Error(`Duplicate ${preparation.job} jobs.`);
        build = builds[0]; checkAt = now() + 60_000;
        if (build?.status === "completed" && build.conclusion !== "success") throw new Error(`${preparation.job} ended with ${build.conclusion}.`);
      }
      const queued = build && QUEUED_STATUSES.includes(build.status);
      if (now() >= deadline) throw new Error(`Shared ${scope} preparation exceeded its 15-minute wait cap; ${preparation.job} ${!build ? "build job missing from the job list" : queued ? "still queued for a runner" : build.status === "in_progress" ? "still running" : "has no published artifact"}.`);
      if (build && ["in_progress", "completed"].includes(build.status)) {
        const { artifacts } = await api.read(`/artifacts?name=${encodeURIComponent(name)}&per_page=100`, { conditional: true });
        if (!Array.isArray(artifacts)) throw new Error("The preparation artifact inventory is missing.");
        const matching = artifacts.filter(artifact => artifact.name === name && !artifact.expired);
        if (matching.length > 1) throw new Error(`Duplicate preparation artifact ${name}.`);
        if (matching.length === 1 && now() < deadline) {
          const artifact = matching[0], downloadDeadline = Math.min(deadline, now() + 30_000);
          if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0) throw new Error("The prepared artifact has no valid identity.");
          const unavailable = () => new Error(`Preparation artifact ${name} was listed but never became downloadable within its 30-second retry cap.`);
          for (;;) {
            if (now() >= downloadDeadline) throw unavailable();
            let response;
            try { response = await api.download(artifact.id, downloadDeadline - now()); }
            catch (error) { if (now() >= downloadDeadline) throw unavailable(); throw error; }
            if (response.status !== 404) {
              if (!response.ok || !response.body) {
                await response.body?.cancel();
                throw new Error(`Cannot download the prepared artifact: HTTP ${response.status}.`);
              }
              if (download) return { artifact, response };
              await response.body.cancel();
              return { artifact };
            }
            await response.body?.cancel();
            if (now() >= downloadDeadline) throw unavailable();
            await pause(Math.min(2_000, downloadDeadline - now()));
          }
        }
      }
      await pause(Math.max(0, Math.min(api.pollMs, deadline - now())));
    }
  } finally { api.log(`${scope} preparation wait`); }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  waitForPreparation(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
}
