#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The flags below are the ones @posthog/cli 0.18.10 reads. Its install
// script downloads the binary, so pnpm must allow that script to run.
export const POSTHOG_CLI = "@posthog/cli@0.18.10";
const CLI = ["dlx", "--allow-build=@posthog/cli", POSTHOG_CLI];
const DIST_PATTERN = /^[\w.-]{1,64}$/;
// The folders whose scripts error reports name. The CLI writes a chunk ID
// into each of their scripts, and the installer must ship those files.
export const REPORTED_CODE = ["apps/desktop/dist/main", "apps/desktop/dist/renderer"];
// The CLI takes an empty host as a host it cannot use rather than its default.
const OPTIONAL_POSTHOG_SETTINGS = ["POSTHOG_CLI_HOST"];
const REQUIRED_POSTHOG_SETTINGS = ["POSTHOG_CLI_API_KEY", "POSTHOG_CLI_PROJECT_ID"];

/**
 * What one desktop package needs before it is packaged. A build without a
 * PostHog key sends no error reports, so it needs no source maps. A build
 * with one must inject and upload them: PostHog reads a report's frames
 * against the source map whose chunk ID the shipped file carries. The
 * release name, version, and build match the release and dist the app
 * reports.
 */
export function sourceMapUpload(env, platform = process.platform) {
  const childEnv = { ...env };
  for (const name of OPTIONAL_POSTHOG_SETTINGS) {
    if (!env[name]?.trim()) delete childEnv[name];
  }
  // The CLI's Windows installer unzips with Windows PowerShell, which cannot load
  // Expand-Archive from the PowerShell 7 folders a pwsh step puts on PSModulePath.
  for (const name of Object.keys(childEnv)) {
    if (platform === "win32" && name.toUpperCase() === "PSMODULEPATH") delete childEnv[name];
  }
  // A dry run uploads nothing, but installs and runs the CLI as a release does.
  if (env.DOHC_SOURCE_MAPS_DRY_RUN === "true") return { args: [...CLI, "--version"], env: childEnv, dryRun: true };
  if (!env.DOHC_POSTHOG_KEY?.trim()) {
    return { skip: "DOHC_POSTHOG_KEY is not set, so this build sends no error reports and needs no source maps." };
  }
  const missing = REQUIRED_POSTHOG_SETTINGS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `DOHC_POSTHOG_KEY is set but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} empty. Add ${missing.length > 1 ? "them" : "it"} to the desktop-release environment, or clear DOHC_POSTHOG_KEY.`,
    );
  }
  const version = env.DESKTOP_VERSION?.trim();
  if (!version) throw new Error("DESKTOP_VERSION is required to name the release.");
  const dist = env.DOHC_DESKTOP_DIST?.trim() ?? "";
  if (!DIST_PATTERN.test(dist)) throw new Error(`DOHC_DESKTOP_DIST '${dist}' is not a dist the app accepts.`);
  return {
    args: [
      ...CLI, "sourcemap", "process",
      ...REPORTED_CODE.flatMap((directory) => ["--directory", directory]),
      "--release-name", "dohc-desktop",
      "--release-version", version,
      "--build", dist,
    ],
    env: childEnv,
  };
}

/** The scripts under `directories` with a source map that carry no chunk ID. */
export function scriptsWithoutChunkIds(directories) {
  const missing = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.[cm]?js$/.test(entry.name) && existsSync(`${path}.map`)
        && !/\n\/\/# chunkId=[0-9a-f-]{36}\s*$/.test(readFileSync(path, "utf8"))) missing.push(path);
    }
  };
  for (const directory of directories) visit(directory);
  return missing;
}

/** Injects and uploads this build's source maps, or says why it needs none. A dry run only runs the CLI. */
export function uploadSourceMaps(env, spawn = spawnSync, directories = REPORTED_CODE) {
  const upload = sourceMapUpload(env);
  if (upload.skip) {
    console.log(upload.skip);
    return;
  }
  const result = spawn("pnpm", upload.args, { env: upload.env, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    throw new Error(`The source map upload failed${result.error ? `: ${result.error.message}` : ` with exit code ${result.status}`}.`);
  }
  if (upload.dryRun) return;
  const missing = scriptsWithoutChunkIds(directories);
  if (missing.length > 0) {
    throw new Error(`These scripts carry no chunk ID, so PostHog cannot read their frames:\n${missing.join("\n")}`);
  }
}

if (import.meta.main) {
  try {
    uploadSourceMaps(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
