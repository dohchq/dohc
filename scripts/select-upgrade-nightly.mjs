#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";

// These nightlies predate the packaged engine, so they have no engine store to
// upgrade. Every later nightly must ship an AppImage with an executable engine.
export const LEGACY_NIGHTLIES = ["v0.1.1-nightly.20260622.15.1"];

/**
 * The published nightly whose engine the release opens a workspace with. The
 * newest nightly is chosen before its assets are read, so a nightly without an
 * AppImage fails the check instead of handing it to an older one.
 *
 * @returns {{ tag: string | null, notice?: string }} a null tag skips the check.
 */
export function selectUpgradeNightly(releases) {
  if (!Array.isArray(releases)) throw new Error("Release history must be an array of GitHub releases.");
  const nightlies = releases.filter((release) => {
    if (!release || typeof release.draft !== "boolean" || typeof release.tag_name !== "string" || !Array.isArray(release.assets)) {
      throw new Error("Release history contains an invalid GitHub release.");
    }
    return !release.draft && release.tag_name.includes("-nightly.");
  });
  if (nightlies.some((release) => typeof release.published_at !== "string")) {
    throw new Error("A published nightly has no publication time.");
  }
  // ISO 8601 UTC times sort as strings.
  const newest = nightlies.sort((a, b) => b.published_at.localeCompare(a.published_at))[0];
  if (!newest) return { tag: null, notice: "No nightly is published yet, so the engine upgrade check has nothing to open." };
  if (LEGACY_NIGHTLIES.includes(newest.tag_name)) {
    return { tag: null, notice: `${newest.tag_name} predates the packaged engine, so the engine upgrade check has nothing to open.` };
  }
  if (!newest.assets.some((asset) => typeof asset?.name === "string" && asset.name.endsWith(".AppImage"))) {
    throw new Error(`${newest.tag_name}, the newest published nightly, has no Linux AppImage to check an engine upgrade from.`);
  }
  return { tag: newest.tag_name };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== "--releases" || args[2] !== "--github-output") {
    throw new Error("Usage: select-upgrade-nightly.mjs --releases <GitHub release history JSONL> --github-output");
  }
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required with --github-output.");
  const releases = (await readFile(args[1], "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const { tag, notice } = selectUpgradeNightly(releases);
  if (notice) console.log(`::notice::${notice}`);
  else console.log(`Checking an engine upgrade from ${tag}.`);
  await appendFile(outputPath, `tag=${tag ?? ""}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
