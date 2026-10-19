#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const platforms = {
  mac: { suffix: "-mac", extensions: ["dmg", "zip"], updateExtension: "zip", arches: ["arm64"] },
  win: { suffix: "", extensions: ["exe"], updateExtension: "exe", arches: ["x64"] },
  linux: { suffix: "-linux", extensions: ["AppImage"], updateExtension: "AppImage", arches: ["x64"], artifactArch: "x86_64" },
};

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

function parseUpdateManifest(raw, sourcePath = "manifest") {
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

async function inspectFile(root, name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new Error(`Release artifact must be a local filename: ${name}`);
  }
  const path = await realpath(join(root, name));
  if (dirname(path) !== root) throw new Error(`Release artifact escapes its directory: ${name}`);
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`Release artifact is not a nonempty file: ${name}`);
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { name, size: info.size, sha512: hash.digest("base64") };
}

// This checks distributable bytes, not installation, signatures, or app startup.
export async function verifyDesktopReleaseArtifacts({ directory, platform, arch, version, channel }) {
  const target = platforms[platform];
  if (!target || !target.arches.includes(arch)) throw new Error(`Unsupported release target: ${platform}-${arch}`);
  if (!["latest", "nightly"].includes(channel)) throw new Error("Channel must be latest or nightly.");
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("A release version is required.");
  }
  const root = await realpath(resolve(directory));
  const manifestName = `${channel}${target.suffix}.yml`;
  const manifestFile = await inspectFile(root, manifestName);
  const manifest = parseUpdateManifest(await readFile(join(root, manifestName), "utf8"), manifestName);
  if (manifest.version !== version) throw new Error(`Manifest version ${manifest.version} does not match ${version}.`);
  const inspected = new Map();
  const inspect = async name => {
    if (!inspected.has(name)) inspected.set(name, await inspectFile(root, name));
    return inspected.get(name);
  };
  const seen = new Set();
  for (const file of manifest.files) {
    if (seen.has(file.url)) throw new Error(`Duplicate manifest artifact: ${file.url}`);
    seen.add(file.url);
    const artifact = await inspect(file.url);
    if (artifact.size !== file.size || artifact.sha512 !== file.sha512) {
      throw new Error(`Manifest size or SHA-512 does not match artifact: ${file.url}`);
    }
  }
  const legacy = manifest.files.find(file => file.url === manifest.path);
  if (!legacy || legacy.sha512 !== manifest.sha512) {
    throw new Error("Manifest path and SHA-512 must match a listed artifact.");
  }
  for (const extension of target.extensions) {
    const name = `dohc-${version}-${platform}-${target.artifactArch ?? arch}.${extension}`;
    await inspect(name);
    if (extension === target.updateExtension && !seen.has(name)) {
      throw new Error(`Update manifest does not list the ${arch} update artifact: ${name}`);
    }
  }
  return {
    status: "passed", scope: "release artifact sizes and SHA-512 checksums",
    directory: root, platform, arch, version, channel,
    manifest: manifestFile, artifacts: [...inspected.values()],
    excludes: ["installation", "code signing", "application startup", "update installation"],
  };
}

async function main() {
  const options = {};
  const allowed = new Set(["directory", "platform", "arch", "version", "channel"]);
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index].slice(2);
    const value = process.argv[index + 1];
    if (!process.argv[index].startsWith("--") || !allowed.has(name) || options[name] || !value || value.startsWith("--")) {
      throw new Error("Usage: verify-desktop-release-artifacts --directory <release> --platform mac|win|linux --arch x64|arm64 --version <version> --channel latest|nightly");
    }
    options[name] = value;
  }
  if ([...allowed].some(name => !options[name])) throw new Error("Provide directory, platform, arch, version, and channel.");
  console.log(JSON.stringify(await verifyDesktopReleaseArtifacts(options), null, 2));
}

if (import.meta.main) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
