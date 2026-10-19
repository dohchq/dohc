#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { desktopReleaseTargets } from "./resolve-desktop-release.mjs";

// The rules a release must meet before it publishes. Dry runs skip them.
// A nightly ships every platform this workflow builds, and at most one nightly
// publishes per UTC day, counted by when each release published. Any release
// keeps every platform its channel already publishes, so no installation loses
// its update feed.
export function checkDesktopReleasePublication({ channel, platforms, releases, now = new Date() }) {
  if (!["latest", "nightly"].includes(channel)) {
    throw new Error(`Invalid release channel '${channel}'. Expected latest or nightly.`);
  }
  const selected = new Set(desktopReleaseTargets(platforms).map((target) => target.artifact_platform));
  if (!Array.isArray(releases)) throw new Error("Release history must be an array of GitHub releases.");
  for (const release of releases) {
    if (
      !release || typeof release.draft !== "boolean" || typeof release.tag_name !== "string" || !Array.isArray(release.assets) ||
      (!release.draft && Number.isNaN(Date.parse(release.published_at)))
    ) {
      throw new Error("Release history contains an invalid GitHub release.");
    }
    for (const asset of release.assets) {
      if (typeof asset?.name !== "string") throw new Error("Release history contains an invalid asset.");
    }
  }
  const published = releases.filter((release) => !release.draft);

  if (channel === "nightly") {
    if (platforms !== "windows-linux") {
      throw new Error("A nightly publishes every platform this workflow builds. Select platforms=windows-linux, or use dry_run=true to test fewer platforms.");
    }
    const today = now.toISOString().slice(0, 10);
    const todays = published.find((release) =>
      release.tag_name.includes("-nightly.") && new Date(release.published_at).toISOString().slice(0, 10) === today);
    if (todays) {
      throw new Error(`${todays.tag_name} published at ${todays.published_at}, so ${today} (UTC) already has its nightly. Publish the next nightly after 00:00 UTC, or use dry_run=true.`);
    }
  }

  // The macOS manifest comes from the release command on a Mac, after this
  // workflow publishes, so the workflow keeps only Windows and Linux.
  const manifests = new Map([
    [`${channel}.yml`, "win"],
    [`${channel}-linux.yml`, "linux"],
  ]);
  const previous = new Set(published.flatMap((release) => release.assets.map((asset) => manifests.get(asset.name)).filter(Boolean)));
  const missing = [...previous].filter((platform) => !selected.has(platform)).sort();
  if (missing.length) {
    throw new Error(
      `The ${channel} channel already publishes ${missing.join(", ")} update manifests. Select platforms=windows-linux before publishing, or use dry_run=true to test only the selected platforms.`,
    );
  }
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!["--channel", "--platforms", "--releases"].includes(name)) throw new Error(`Unknown argument '${name}'.`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
    options[name.slice(2)] = value;
  }
  if (!options.channel || !options.platforms || !options.releases) {
    throw new Error("Usage: check-desktop-release-publication.mjs --channel latest|nightly --platforms windows|linux|windows-linux --releases <GitHub release history JSONL>");
  }
  const releases = (await readFile(options.releases, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  checkDesktopReleasePublication({ ...options, releases });
  console.log(`The ${options.channel} release meets the publication rules.`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
