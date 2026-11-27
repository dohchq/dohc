#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The flags below are the ones @posthog/cli 0.18.10 reads. Each archive is
// that release's build for a platform releases build on, pinned by the
// SHA-256 its sha256.sum lists.
const POSTHOG_CLI_RELEASE =
  "https://github.com/PostHog/posthog/releases/download/posthog-cli/v0.18.10";
export const POSTHOG_CLI_ARCHIVES = {
  "darwin-arm64": {
    name: "posthog-cli-aarch64-apple-darwin.tar.gz",
    sha256: "ac3610273be3c7bfd31b0e7f81d8b35119543bf66b99f669d1ec50abbb36d0da",
    binary: "posthog-cli-aarch64-apple-darwin/posthog-cli",
  },
  "linux-x64": {
    name: "posthog-cli-x86_64-unknown-linux-gnu.tar.gz",
    sha256: "29f2d4409f08205bab7d52f9cc919e964ea2c867ec568b3acdd9ee3eb4149c3d",
    binary: "posthog-cli-x86_64-unknown-linux-gnu/posthog-cli",
  },
  "win32-x64": {
    name: "posthog-cli-x86_64-pc-windows-msvc.zip",
    sha256: "14018e60a9c4bcd6feebe6e0e01017769bea0cb802e597c8879fdf8a5503472f",
    binary: "posthog-cli.exe",
  },
};
// Git's tar can come first on a Windows PATH, and it cannot read zip files.
export const TAR =
  process.platform === "win32" ? join(process.env.SystemRoot ?? "", "System32", "tar.exe") : "tar";
const SIGNING_SETTING = /^(WIN_)?CSC_|^APPLE_/i;
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
export function sourceMapUpload(env) {
  const childEnv = { ...env };
  for (const name of OPTIONAL_POSTHOG_SETTINGS) {
    if (!env[name]?.trim()) delete childEnv[name];
  }
  for (const name of Object.keys(childEnv)) {
    if (SIGNING_SETTING.test(name)) delete childEnv[name];
  }
  // A dry run uploads nothing, but installs and runs the CLI as a release does.
  if (env.DOHC_SOURCE_MAPS_DRY_RUN === "true")
    return { args: ["--version"], env: childEnv, dryRun: true };
  if (!env.DOHC_POSTHOG_KEY?.trim()) {
    return {
      skip: "DOHC_POSTHOG_KEY is not set, so this build sends no error reports and needs no source maps.",
    };
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
  if (!DIST_PATTERN.test(dist))
    throw new Error(`DOHC_DESKTOP_DIST '${dist}' is not a dist the app accepts.`);
  return {
    args: [
      "sourcemap",
      "process",
      ...REPORTED_CODE.flatMap((directory) => ["--directory", directory]),
      "--release-name",
      "dohc-desktop",
      "--release-version",
      version,
      "--build",
      dist,
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
      else if (
        /\.[cm]?js$/.test(entry.name) &&
        existsSync(`${path}.map`) &&
        !/\n\/\/# chunkId=[0-9a-f-]{36}\s*$/.test(readFileSync(path, "utf8"))
      )
        missing.push(path);
    }
  };
  for (const directory of directories) visit(directory);
  return missing;
}

/** Downloads the CLI archive into `directory`, checks its SHA-256 before anything reads it, and unpacks it. Returns the CLI's path. */
export async function installPosthogCli(
  directory,
  archive = POSTHOG_CLI_ARCHIVES[`${process.platform}-${process.arch}`],
  download = fetch,
) {
  if (!archive) {
    throw new Error(
      `@posthog/cli has no pinned archive for ${process.platform}-${process.arch}. Releases build on ${Object.keys(POSTHOG_CLI_ARCHIVES).join(", ")}.`,
    );
  }
  const url = `${POSTHOG_CLI_RELEASE}/${archive.name}`;
  const response = await download(url);
  if (!response.ok) throw new Error(`Downloading ${url} failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== archive.sha256) {
    throw new Error(`${archive.name} has SHA-256 ${sha256}, not the pinned ${archive.sha256}.`);
  }
  const path = join(directory, archive.name);
  await writeFile(path, bytes);
  const unpacked = spawnSync(TAR, ["-xf", path, "-C", directory], { stdio: "inherit" });
  if (unpacked.status !== 0) {
    throw new Error(
      `Unpacking ${archive.name} failed${unpacked.error ? `: ${unpacked.error.message}` : "."}`,
    );
  }
  return join(directory, archive.binary);
}

/** Injects and uploads this build's source maps, or says why it needs none. A dry run only runs the CLI. */
export async function uploadSourceMaps(
  env,
  { spawn = spawnSync, download = fetch, archive, directories = REPORTED_CODE } = {},
) {
  const upload = sourceMapUpload(env);
  if (upload.skip) {
    console.log(upload.skip);
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "dohc-posthog-cli-"));
  try {
    const cli = await installPosthogCli(directory, archive, download);
    const result = spawn(cli, upload.args, { env: upload.env, stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(
        `The source map upload failed${result.error ? `: ${result.error.message}` : ` with exit code ${result.status}`}.`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  if (upload.dryRun) return;
  const missing = scriptsWithoutChunkIds(directories);
  if (missing.length > 0) {
    throw new Error(
      `These scripts carry no chunk ID, so PostHog cannot read their frames:\n${missing.join("\n")}`,
    );
  }
}

if (import.meta.main) {
  try {
    await uploadSourceMaps(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
