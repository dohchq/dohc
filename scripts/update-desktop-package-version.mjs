#!/usr/bin/env node

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

export function repoRootFromScript() {
  return resolve(fileURLToPath(new URL("..", import.meta.url)));
}

export function validateDesktopPackageVersion(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid desktop package version '${version}'.`);
  }
  return version;
}

export async function updateDesktopPackageVersion(version, options = {}) {
  const nextVersion = validateDesktopPackageVersion(version);
  const root = resolve(options.root ?? repoRootFromScript());
  const packageJsonPath = join(root, "apps/desktop/package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const changed = packageJson.version !== nextVersion;
  if (changed) {
    packageJson.version = nextVersion;
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }
  return { changed, packageJsonPath, version: nextVersion };
}

export async function writeGithubOutput(result, outputPath) {
  await appendFile(
    outputPath,
    `changed=${result.changed ? "true" : "false"}\nversion=${result.version}\n`,
  );
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
    if (arg === "--version") out.version = readValue();
    else if (arg === "--root") out.root = readValue();
    else if (arg === "--github-output") out.githubOutput = true;
    else if (!arg.startsWith("--") && !out.version) out.version = arg;
    else throw new Error(`Unknown argument '${arg}'.`);
  }
  if (!out.version) throw new Error("Usage: update-desktop-package-version <version>");
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await updateDesktopPackageVersion(args.version, {
    root: args.root,
  });
  if (args.githubOutput) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath) throw new Error("GITHUB_OUTPUT is required with --github-output.");
    await writeGithubOutput(result, outputPath);
  }
  console.log(
    `${result.changed ? "updated" : "unchanged"} ${result.packageJsonPath} ${result.version}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
