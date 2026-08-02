// One vitest, resolvable everywhere. The root must declare vitest, and every
// package must declare the same major. Without the root declaration, `npx
// vitest` at the repo root cannot resolve a local binary, so npm installs an
// arbitrary registry version into its own cache and runs the suite with it.
// That run collects from the npx cache instead of the repo and still exits 0.
// A root `npx vitest run` now resolves and sweeps the whole repo, including
// Playwright specs and node:test scripts, so it exits non-zero by design; run
// suites through the per-package scripts.
// See https://github.com/dohc-ai/dohc/issues/405.
import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);

async function readPackage(relativePath) {
  const raw = await readFile(new URL(relativePath, repoRoot), "utf8");
  return JSON.parse(raw);
}

function workspacePatterns(workspaceYaml) {
  const patterns = [];
  let inPackages = false;
  for (const line of workspaceYaml.split(/\r?\n/)) {
    if (/^packages:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    const entry = inPackages && line.match(/^\s+-\s+["']?([^"'\s#]+)["']?/);
    if (entry) patterns.push(entry[1]);
  }
  return patterns;
}

// autoInstallPeers is on, so a peer-declared vitest is installed like any
// other. Every field that can put a vitest on disk has to be read here.
function declaredVitest(pkg) {
  return (
    pkg.devDependencies?.vitest ??
    pkg.dependencies?.vitest ??
    pkg.peerDependencies?.vitest ??
    pkg.optionalDependencies?.vitest
  );
}

function major(range) {
  const digits = range.match(/(\d+)\./);
  assert.ok(digits, `cannot read a major from the vitest range "${range}"`);
  return digits[1];
}

const workspaceYaml = await readFile(
  new URL("pnpm-workspace.yaml", repoRoot),
  "utf8",
);
const patterns = workspacePatterns(workspaceYaml);
assert.ok(patterns.length > 0, "pnpm-workspace.yaml declares no packages");

const rootRange = declaredVitest(await readPackage("package.json"));
const declarations = rootRange
  ? [{ path: "package.json", range: rootRange }]
  : [];
for (const pattern of patterns) {
  for await (const match of glob(`${pattern}/package.json`, {
    cwd: repoRoot,
  })) {
    const path = match.replaceAll("\\", "/");
    const range = declaredVitest(await readPackage(path));
    if (range) declarations.push({ path, range });
  }
}

test("the repo root declares vitest so npx cannot substitute its own", () => {
  assert.ok(
    rootRange,
    "the root package.json declares no vitest. `npx vitest` at the repo root " +
      "then resolves no local binary, and npm installs an unpinned registry " +
      "version into its cache and runs the suite with it.",
  );
});

// Without this the guard can pass on nothing: if the pattern parsing ever
// stops matching, the glob finds no package.json, and a lone root declaration
// is trivially one major.
test("pattern parsing finds the packages, so the check is not vacuous", () => {
  assert.ok(
    declarations.length > 1,
    `found ${declarations.length} vitest declarations, expected the root plus ` +
      "the workspace packages. Pattern parsing of pnpm-workspace.yaml matched " +
      `no package declarations; it read patterns [${patterns.join(", ")}].`,
  );
});

test("every package declares the same vitest major", () => {
  const byMajor = new Map();
  for (const { path, range } of declarations) {
    const key = major(range);
    byMajor.set(key, [...(byMajor.get(key) ?? []), `${path} (${range})`]);
  }
  assert.equal(
    byMajor.size,
    1,
    `the workspace declares ${byMajor.size} vitest majors; it must declare 1. ` +
      [...byMajor]
        .map(([key, paths]) => `major ${key}: ${paths.join(", ")}`)
        .join("; ") +
      ". A second major makes the runner depend on the directory you stand " +
      "in, and a run under the wrong major under-collects and still exits 0.",
  );
});
