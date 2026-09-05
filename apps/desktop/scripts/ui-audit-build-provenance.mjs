import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const uiAuditBuildProvenanceName = "ui-audit-build.json";

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Tree(directory) {
  const entries = [];
  function visit(path, relative) {
    const children = readdirSync(path, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const child of children) {
      const childPath = join(path, child.name);
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      if (child.isDirectory()) visit(childPath, childRelative);
      else if (child.isFile()) entries.push(`${childRelative}\0${sha256File(childPath)}`);
    }
  }
  visit(directory, "");
  if (entries.length === 0) {
    throw new Error(`UI audit artifact tree is empty: ${directory}`);
  }
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

export function currentUiAuditBundles(desktopRoot, platform = process.platform) {
  return {
    mainTreeSha256: sha256Tree(join(desktopRoot, "dist/main")),
    preloadTreeSha256: sha256Tree(join(desktopRoot, "dist/preload")),
    rendererTreeSha256: sha256Tree(join(desktopRoot, "dist/renderer")),
    engineSha256: sha256File(
      join(
        desktopRoot,
        "target/debug",
        `dohc-workspace-engine${platform === "win32" ? ".exe" : ""}`,
      ),
    ),
  };
}

function validateBundles(actual, expected, label) {
  for (const key of [
    "mainTreeSha256",
    "preloadTreeSha256",
    "rendererTreeSha256",
    "engineSha256",
  ]) {
    if (typeof actual?.[key] !== "string" || !/^[0-9a-f]{64}$/.test(actual[key])) {
      throw new Error(`${label} has invalid ${key}`);
    }
    if (actual[key] !== expected?.[key]) {
      throw new Error(`${label} ${key} does not match the current desktop build`);
    }
  }
}

export function writeUiAuditBuildProvenance(desktopRoot, commit, bundles, builtAt) {
  const provenance = {
    schemaVersion: 1,
    commit,
    builtAt,
    bundles,
  };
  const directory = join(desktopRoot, ".dohc-dev");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, uiAuditBuildProvenanceName),
    `${JSON.stringify(provenance, null, 2)}\n`,
    "utf8",
  );
  return provenance;
}

export function readUiAuditBuildProvenance(desktopRoot, expectedCommit, expectedBundles) {
  const path = join(desktopRoot, ".dohc-dev", uiAuditBuildProvenanceName);
  let provenance;
  try {
    provenance = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`could not read ${uiAuditBuildProvenanceName}${detail}`);
  }
  if (
    provenance?.schemaVersion !== 1 ||
    typeof provenance.commit !== "string" ||
    typeof provenance.builtAt !== "string" ||
    !Number.isFinite(Date.parse(provenance.builtAt))
  ) {
    throw new Error(`${uiAuditBuildProvenanceName} has an invalid shape`);
  }
  if (provenance.commit !== expectedCommit) {
    throw new Error(
      `desktop artifacts were built from ${provenance.commit}; expected ${expectedCommit}`,
    );
  }
  validateBundles(provenance.bundles, expectedBundles, uiAuditBuildProvenanceName);
  return provenance;
}

export function validateUiAuditBundles(actual, expected, label) {
  validateBundles(actual, expected, label);
}
