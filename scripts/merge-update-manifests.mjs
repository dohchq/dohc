#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const SUPPORTED_PLATFORMS = new Set(["mac", "win"]);

function parseScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function stringifyScalar(value) {
  if (typeof value === "number") return String(value);
  if (/^[A-Za-z0-9._:/@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export function parseUpdateManifest(raw, sourcePath = "manifest") {
  const manifest = { files: [] };
  let currentFile = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      currentFile = null;
      continue;
    }
    const fileStart = /^\s*-\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (fileStart) {
      currentFile = { [fileStart[1]]: parseScalar(fileStart[2]) };
      manifest.files.push(currentFile);
      continue;
    }
    const fileProperty = /^\s{4,}([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (fileProperty && currentFile) {
      currentFile[fileProperty[1]] = parseScalar(fileProperty[2]);
      continue;
    }
    const property = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (property) {
      currentFile = null;
      const [, key, value] = property;
      if (key === "files") continue;
      manifest[key] = parseScalar(value);
      continue;
    }
    throw new Error(`Could not parse ${sourcePath}: ${line}`);
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`${sourcePath} is missing version.`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${sourcePath} is missing files.`);
  }
  for (const file of manifest.files) {
    if (typeof file.url !== "string" || file.url.length === 0) {
      throw new Error(`${sourcePath} has a file entry without url.`);
    }
    if (typeof file.sha512 !== "string" || file.sha512.length === 0) {
      throw new Error(`${sourcePath} has a file entry without sha512.`);
    }
    if (typeof file.size !== "number" || !Number.isFinite(file.size)) {
      throw new Error(`${sourcePath} has a file entry without numeric size.`);
    }
  }
  return manifest;
}

export function mergeUpdateManifests(primary, secondary, platform = "mac") {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`Unsupported update manifest platform '${platform}'.`);
  }
  if (primary.version !== secondary.version) {
    throw new Error(
      `Cannot merge ${platform} manifests with different versions: ${primary.version} vs ${secondary.version}.`,
    );
  }
  const byUrl = new Map();
  for (const file of [...primary.files, ...secondary.files]) {
    byUrl.set(file.url, { ...file });
  }
  const files = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
  const firstFile = files[0];
  return {
    ...primary,
    files,
    ...(firstFile ? { path: firstFile.url, sha512: firstFile.sha512 } : {}),
    releaseDate: primary.releaseDate ?? secondary.releaseDate ?? new Date().toISOString(),
  };
}

export function serializeUpdateManifest(manifest) {
  const lines = [`version: ${stringifyScalar(manifest.version)}`, "files:"];
  for (const file of manifest.files) {
    const entries = Object.entries(file);
    const [firstKey, firstValue] = entries[0];
    lines.push(`  - ${firstKey}: ${stringifyScalar(firstValue)}`);
    for (const [key, value] of entries.slice(1)) {
      lines.push(`    ${key}: ${stringifyScalar(value)}`);
    }
  }
  const reserved = new Set(["version", "files"]);
  for (const [key, value] of Object.entries(manifest)) {
    if (reserved.has(key) || value === undefined) continue;
    lines.push(`${key}: ${stringifyScalar(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function mergeUpdateManifestFiles({
  platform,
  primaryPath,
  secondaryPath,
  outputPath,
}) {
  const primaryFile = resolve(primaryPath);
  const secondaryFile = resolve(secondaryPath);
  const outFile = resolve(outputPath ?? primaryPath);
  const primary = parseUpdateManifest(await readFile(primaryFile, "utf8"), primaryFile);
  const secondary = parseUpdateManifest(
    await readFile(secondaryFile, "utf8"),
    secondaryFile,
  );
  const merged = mergeUpdateManifests(primary, secondary, platform);
  await writeFile(outFile, serializeUpdateManifest(merged));
  return merged;
}

function parseArgs(argv) {
  const out = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--platform") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --platform.");
      out.platform = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument '${arg}'.`);
    } else {
      positionals.push(arg);
    }
  }
  const [primaryPath, secondaryPath, outputPath] = positionals;
  if (!out.platform || !primaryPath || !secondaryPath) {
    throw new Error(
      "Usage: merge-update-manifests --platform mac|win <primary.yml> <secondary.yml> [output.yml]",
    );
  }
  return { ...out, primaryPath, secondaryPath, outputPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mergeUpdateManifestFiles(args);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
