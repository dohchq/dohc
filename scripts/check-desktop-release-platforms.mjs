#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { desktopReleaseTargets } from "./resolve-desktop-release.mjs";

export function checkDesktopReleasePlatforms({ channel, platforms, releases }) {
  if (!["latest", "nightly"].includes(channel)) {
    throw new Error(`Invalid release channel '${channel}'. Expected latest or nightly.`);
  }
  const selected = new Set(desktopReleaseTargets(platforms).map((target) => target.artifact_platform));
  if (!Array.isArray(releases)) throw new Error("Release history must be an array of GitHub releases.");
  const previous = new Set();
  const manifests = new Map([
    [`${channel}.yml`, "win"],
    [`${channel}-mac.yml`, "mac"],
    [`${channel}-linux.yml`, "linux"],
  ]);
  for (const release of releases) {
    if (!release || typeof release.draft !== "boolean" || !Array.isArray(release.assets)) {
      throw new Error("Release history contains an invalid GitHub release.");
    }
    if (release.draft) continue;
    for (const asset of release.assets) {
      if (typeof asset?.name !== "string") throw new Error("Release history contains an invalid asset.");
      const platform = manifests.get(asset.name);
      if (platform) previous.add(platform);
    }
  }
  const missing = [...previous].filter((platform) => !selected.has(platform)).sort();
  if (missing.length) {
    throw new Error(
      `The ${channel} channel already publishes ${missing.join(", ")} update manifests. Select platforms=all before publishing, or use dry_run=true to test only the selected platforms.`,
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
    throw new Error("Usage: check-desktop-release-platforms.mjs --channel latest|nightly --platforms windows|linux|macos|windows-linux|all --releases <GitHub release history JSONL>");
  }
  const releases = (await readFile(options.releases, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  checkDesktopReleasePlatforms({ ...options, releases });
  console.log(`The ${options.channel} release keeps every previously published platform manifest.`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
