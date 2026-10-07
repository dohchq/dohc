#!/usr/bin/env node

import { spawnSync } from "node:child_process";

// The flags below are the ones @sentry/cli 3.8.0 reads.
export const SENTRY_CLI = "@sentry/cli@3.8.0";
const DIST_PATTERN = /^[\w.-]{1,64}$/;

/**
 * The upload one desktop package needs. A build without a Sentry DSN sends
 * no error reports, so it needs no source maps. A build with one must
 * upload them: without them Sentry cannot show the lines its reports name.
 * The release, dist, and URL prefix match what the app's reports carry.
 */
export function sourceMapUpload(env) {
  if (!env.DOHC_SENTRY_DSN?.trim()) {
    return { skip: "DOHC_SENTRY_DSN is not set, so this build sends no error reports and needs no source maps." };
  }
  if (!env.SENTRY_AUTH_TOKEN?.trim()) {
    throw new Error(
      "DOHC_SENTRY_DSN is set but SENTRY_AUTH_TOKEN is empty. Add the SENTRY_AUTH_TOKEN secret to the desktop-release environment, or clear DOHC_SENTRY_DSN.",
    );
  }
  const version = env.DESKTOP_VERSION?.trim();
  if (!version) throw new Error("DESKTOP_VERSION is required to name the release.");
  const dist = env.DOHC_SENTRY_DIST?.trim() ?? "";
  if (!DIST_PATTERN.test(dist)) throw new Error(`DOHC_SENTRY_DIST '${dist}' is not a dist the app accepts.`);
  return {
    args: [
      "dlx", SENTRY_CLI, "sourcemaps", "upload",
      "--release", `dohc-desktop@${version}`,
      "--dist", dist,
      "--url-prefix", "app:///dist",
      "apps/desktop/dist",
    ],
  };
}

function main() {
  const upload = sourceMapUpload(process.env);
  if (upload.skip) {
    console.log(upload.skip);
    return;
  }
  const result = spawnSync("pnpm", upload.args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    throw new Error(`The source map upload failed${result.error ? `: ${result.error.message}` : ` with exit code ${result.status}`}.`);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
