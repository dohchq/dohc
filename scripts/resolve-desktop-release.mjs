#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DATE_PATTERN = /^\d{8}$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function repoRootFromScript() {
  return resolve(fileURLToPath(new URL("..", import.meta.url)));
}

export function stripVersionPrefix(version) {
  return version.startsWith("v") ? version.slice(1) : version;
}

export function stableCore(version) {
  return stripVersionPrefix(version).replace(/[-+].*$/, "");
}

export function nextNightlyBaseVersion(version) {
  const core = stableCore(version);
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(core);
  if (!match) throw new Error(`Invalid desktop package version '${version}'.`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export async function readDesktopPackageVersion(root = repoRootFromScript()) {
  const packageJsonPath = join(root, "apps/desktop/package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(`Desktop package version is missing in ${packageJsonPath}.`);
  }
  return packageJson.version;
}

export function defaultUtcDate(now = new Date()) {
  return now.toISOString().slice(0, 10).replaceAll("-", "");
}

function normalizeChannel(channel) {
  if (channel === "stable") return "latest";
  if (channel === "latest" || channel === "nightly") return channel;
  throw new Error(
    `Invalid release channel '${channel}'. Expected stable, latest, or nightly.`,
  );
}

function validateReleaseInputs({ channel, date, runNumber, runAttempt, sha }) {
  if (channel === "nightly" && !DATE_PATTERN.test(date)) {
    throw new Error(`Invalid nightly date '${date}'. Expected YYYYMMDD.`);
  }
  if (channel === "nightly") {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(4, 6));
    const day = Number(date.slice(6, 8));
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      throw new Error(`Invalid nightly date '${date}'. Date does not exist.`);
    }
  }
  if (channel === "nightly" && (!Number.isInteger(runNumber) || runNumber < 1)) {
    throw new Error(`Invalid run number '${runNumber}'.`);
  }
  if (channel === "nightly" && (!Number.isInteger(runAttempt) || runAttempt < 1)) {
    throw new Error(`Invalid run attempt '${runAttempt}'.`);
  }
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`Invalid commit sha '${sha}'.`);
  }
}

export async function resolveDesktopRelease(options = {}) {
  const root = resolve(options.root ?? repoRootFromScript());
  const packageVersion =
    options.packageVersion ?? (await readDesktopPackageVersion(root));
  const explicitChannel = options.channel
    ? normalizeChannel(options.channel)
    : options.version?.includes("-nightly.")
      ? "nightly"
      : "latest";
  const sha = options.sha ?? process.env.GITHUB_SHA;
  if (!sha) throw new Error("Commit SHA is required for release metadata.");
  const date = options.date ?? defaultUtcDate();
  const runNumber = Number(options.runNumber ?? process.env.GITHUB_RUN_NUMBER ?? 1);
  const runAttempt = Number(
    options.runAttempt ?? process.env.GITHUB_RUN_ATTEMPT ?? 1,
  );
  validateReleaseInputs({
    channel: explicitChannel,
    date,
    runNumber,
    runAttempt,
    sha,
  });

  let version;
  if (explicitChannel === "nightly") {
    const baseVersion = nextNightlyBaseVersion(packageVersion);
    version = `${baseVersion}-nightly.${date}.${runNumber}.${runAttempt}`;
  } else {
    version = stripVersionPrefix(options.version ?? packageVersion);
    if (!STABLE_VERSION_PATTERN.test(version)) {
      throw new Error(`Stable desktop releases require x.y.z, got '${version}'.`);
    }
    if (stableCore(packageVersion) !== version) {
      throw new Error(
        `Stable release version '${version}' must match apps/desktop/package.json '${packageVersion}'.`,
      );
    }
  }

  const releaseChannel = explicitChannel;
  const shortSha = sha.slice(0, 12);
  return {
    release_channel: releaseChannel,
    version,
    tag: `v${version}`,
    name:
      releaseChannel === "nightly"
        ? `dohc Desktop Nightly ${version} (${shortSha})`
        : `dohc Desktop v${version}`,
    short_sha: shortSha,
    is_prerelease: releaseChannel === "nightly" ? "true" : "false",
    make_latest: releaseChannel === "nightly" ? "false" : "true",
  };
}

export async function writeGithubOutput(metadata, outputPath) {
  const serialized = Object.entries(metadata)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  await appendFile(outputPath, serialized);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}.`);
      }
      index += 1;
      return value;
    };
    if (arg === "--channel") out.channel = readValue();
    else if (arg === "--version") out.version = readValue();
    else if (arg === "--date") out.date = readValue();
    else if (arg === "--run-number") out.runNumber = readValue();
    else if (arg === "--run-attempt") out.runAttempt = readValue();
    else if (arg === "--sha") out.sha = readValue();
    else if (arg === "--root") out.root = readValue();
    else if (arg === "--github-output") out.githubOutput = true;
    else throw new Error(`Unknown argument '${arg}'.`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const metadata = await resolveDesktopRelease(args);
  if (args.githubOutput) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath) throw new Error("GITHUB_OUTPUT is required with --github-output.");
    await writeGithubOutput(metadata, outputPath);
  } else {
    for (const [key, value] of Object.entries(metadata)) {
      console.log(`${key}=${value}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
