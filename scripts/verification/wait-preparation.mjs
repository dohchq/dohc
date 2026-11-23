import { appendFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { resolve } from "node:path";
import { carriedOver, cloudApi, QUEUED_STATUSES, WorkflowAllowanceError } from "./cloud-api.mjs";

export async function waitForPreparation(
  scope,
  { env = process.env, request = fetch, pause = setTimeout, now = Date.now, download = false } = {},
) {
  const preparation =
    scope === "js"
      ? { job: "shared preparation", artifact: "javascript-prepared", minutes: 15 }
      : scope === "rust"
        ? // Rust consumers start while engine gate compiles, so the cap covers a cold build.
          { job: "engine gate", artifact: "rust-tests", minutes: 25 }
        : null;
  if (!preparation) throw new Error("Select js or rust preparation.");
  for (const key of [
    "GITHUB_API_URL",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_TOKEN",
  ]) {
    if (!env[key]) throw new Error(`Missing ${key} for shared preparation.`);
  }
  const startedAt = now(),
    deadline = startedAt + preparation.minutes * 60_000,
    api = cloudApi({ env, request, pause, now, deadline }),
    attempt = Number(env.GITHUB_RUN_ATTEMPT);
  const current = `${preparation.artifact}-${attempt}`;
  let name = current,
    build,
    checkAt = startedAt + 120_000;
  const carriedArtifact = async () => {
    for (let earlier = attempt - 1; earlier > 0; earlier--) {
      const candidate = `${preparation.artifact}-${earlier}`;
      const { artifacts } = await api.read(
        `/artifacts?name=${encodeURIComponent(candidate)}&per_page=100`,
      );
      if (artifacts?.some((artifact) => artifact.name === candidate && !artifact.expired))
        return candidate;
    }
    throw new Error(
      `${preparation.job} passed in an earlier attempt, but no earlier ${preparation.artifact} artifact is available.`,
    );
  };
  const checkBuild = async () => {
    const { jobs } = await api.read(`/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`, {
      deadline: now() >= deadline ? now() + 10_000 : deadline,
    });
    if (!Array.isArray(jobs) || jobs.length >= 100)
      throw new Error("Cannot identify the complete preparation job group.");
    const builds = jobs.filter((job) => job.name === preparation.job);
    if (builds.length > 1) throw new Error(`Duplicate ${preparation.job} jobs.`);
    build = builds[0];
    checkAt = now() + 120_000;
    if (build?.status === "completed" && build.conclusion !== "success")
      throw new Error(`${preparation.job} ended with ${build.conclusion}.`);
    if (build && carriedOver(build) && name === current) name = await carriedArtifact();
  };
  try {
    if (attempt > 1) await checkBuild();
    console.log(`Waiting for ${name}; dependency setup overlaps the shared build.`);
    for (;;) {
      if (now() >= deadline) await checkBuild();
      const queued = build && QUEUED_STATUSES.includes(build.status);
      if (now() >= deadline)
        throw new Error(
          `Shared ${scope} preparation exceeded its ${preparation.minutes}-minute wait cap; ${preparation.job} ${!build ? "build job missing from the job list" : queued ? "still queued for a runner" : build.status === "in_progress" ? "still running" : "has no published artifact"}.`,
        );
      {
        const { artifacts } = await api.read(
          `/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
          { conditional: true },
        );
        if (!Array.isArray(artifacts))
          throw new Error("The preparation artifact inventory is missing.");
        const matching = artifacts.filter(
          (artifact) => artifact.name === name && !artifact.expired,
        );
        if (matching.length > 1) throw new Error(`Duplicate preparation artifact ${name}.`);
        if (matching.length === 1 && now() < deadline) {
          const artifact = matching[0];
          let downloadDeadline = Math.min(deadline, now() + 30_000),
            attempts = 0,
            transferStartedAt;
          if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0)
            throw new Error("The prepared artifact has no valid identity.");
          let sawUnavailable = false,
            lastRequestError;
          const unavailable = (cause = lastRequestError) =>
            new Error(
              sawUnavailable
                ? `Preparation artifact ${name} was listed but never became downloadable within its 30-second retry cap.`
                : `Preparation artifact ${name} download timed out waiting for a response within its 30-second retry cap.`,
              { cause },
            );
          for (;;) {
            if (now() >= downloadDeadline) throw unavailable();
            let response;
            try {
              response = await api.download(
                artifact.id,
                downloadDeadline - now(),
                deadline - now(),
              );
            } catch (error) {
              if (error instanceof WorkflowAllowanceError) throw error;
              lastRequestError = error;
              if (now() >= downloadDeadline) throw unavailable(error);
              await pause(Math.min(2_000, downloadDeadline - now()));
              continue;
            }
            if (
              ![404, 429].includes(response.status) &&
              (response.status < 500 || response.status >= 600)
            ) {
              if (!response.ok || !response.body) {
                await response.body?.cancel();
                throw new Error(`Cannot download the prepared artifact: HTTP ${response.status}.`);
              }
              if (download) {
                transferStartedAt ??= now();
                attempts++;
                try {
                  return { artifact, value: await download(response) };
                } catch (cause) {
                  const seconds = (now() - transferStartedAt) / 1000;
                  if (
                    attempts < 2 &&
                    now() < deadline &&
                    (["AbortError", "TimeoutError", "TypeError"].includes(cause.name) ||
                      cause.code === "ERR_STREAM_PREMATURE_CLOSE")
                  ) {
                    console.log(
                      `Retrying preparation artifact ${name} body transfer after ${seconds}s: ${cause.message}`,
                    );
                    downloadDeadline = Math.min(deadline, now() + 30_000);
                    sawUnavailable = false;
                    lastRequestError = undefined;
                    continue;
                  }
                  throw new Error(
                    `Preparation artifact ${name} (${artifact.id}) body transfer failed after ${seconds}s (${attempts} attempt${attempts === 1 ? "" : "s"}).`,
                    { cause },
                  );
                }
              }
              await response.body.cancel();
              return { artifact };
            }
            sawUnavailable = true;
            await response.body?.cancel();
            if (now() >= downloadDeadline) throw unavailable();
            await pause(Math.min(2_000, downloadDeadline - now()));
          }
        } else if (now() >= checkAt && now() < deadline) {
          await checkBuild();
        }
      }
      await pause(
        Math.max(0, Math.min(api.pollMs, deadline - now(), Math.max(0, checkAt - now()))),
      );
    }
  } finally {
    api.log(`${scope} preparation wait`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  waitForPreparation(process.argv[2]).then(
    ({ artifact }) => {
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, `name=${artifact.name}\n`);
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
