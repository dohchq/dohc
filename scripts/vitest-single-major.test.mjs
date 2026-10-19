// Keep a local Vitest at the root and one installed major across its consumers.
// Otherwise npx can fetch its own runner, or a package can under-collect tests
// under a different major. See https://github.com/dohchq/dohc/issues/405.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readWorkspacePackages } from "./verification/selection.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// Peer auto-installation can put Vitest on disk too.
function declaredVitest(pkg) {
  return pkg.devDependencies?.vitest ?? pkg.dependencies?.vitest
    ?? pkg.peerDependencies?.vitest ?? pkg.optionalDependencies?.vitest;
}

function vitestDeclarations(root) {
  return [{ path: "", manifest: JSON.parse(readFileSync(join(root, "package.json"), "utf8")) },
    ...readWorkspacePackages(root)]
    .filter(({ manifest }) => declaredVitest(manifest))
    .map(({ path, manifest }) => ({ path: join(path, "package.json"), range: declaredVitest(manifest) }));
}

function assertSingleMajor(root, declarations) {
  const byMajor = new Map();
  for (const { path, range } of declarations) {
    const require = createRequire(join(root, path));
    const { version } = require("vitest/package.json");
    const major = version?.match(/^(\d+)\./)?.[1];
    assert.ok(major, `${path} resolves an invalid Vitest version: ${version}`);
    byMajor.set(major, [...(byMajor.get(major) ?? []), `${path} (${range} -> ${version})`]);
  }
  assert.equal(byMajor.size, 1,
    `The workspace resolves ${byMajor.size} Vitest majors; it must resolve 1. `
    + [...byMajor].map(([major, paths]) => `major ${major}: ${paths.join(", ")}`).join("; "));
}

const declarations = vitestDeclarations(repoRoot);

test("the repo root declares vitest so npx cannot substitute its own", () => {
  assert.ok(declarations.some(({ path }) => path === "package.json"),
    "The root package.json must declare Vitest so npx resolves a local runner.");
});

test("workspace discovery finds Vitest consumers beyond the root", () => {
  assert.ok(declarations.length > 1,
    `Found ${declarations.length} Vitest declarations; expected the root and workspace consumers.`);
});

test("every Vitest consumer resolves the same installed major", () => {
  assertSingleMajor(repoRoot, declarations);
});

test("installed majors determine the guard even with disjunctive ranges", () => {
  for (const [rootVersion, peerVersion, error] of [
    ["4.1.11", "5.0.0", /resolves 2 Vitest majors/],
    ["4.1.11", "4.2.0"],
    ["4.1.11"], // Node resolves the root installation for both consumers.
  ]) {
    const root = mkdtempSync(join(tmpdir(), "dohc-vitest-major-"));
    const write = (path, value) => {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, JSON.stringify(value));
    };
    try {
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: ['apps/*']\n");
      write("package.json", { name: "root", devDependencies: { vitest: "^4 || ^5" } });
      write("apps/peer/package.json", { name: "peer", peerDependencies: { vitest: "^4 || ^5" } });
      if (rootVersion) write("node_modules/vitest/package.json", { name: "vitest", version: rootVersion });
      if (peerVersion) write("apps/peer/node_modules/vitest/package.json", { name: "vitest", version: peerVersion });
      const check = () => assertSingleMajor(root, vitestDeclarations(root));
      if (error) assert.throws(check, error);
      else check();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
