import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readWorkspacePackages, selectJavaScript, uncoveredWorkspaceInputs } from "./selection.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const packages = readWorkspacePackages(root);
const select = (files, options) => selectJavaScript(files, packages, options);

test("workspace discovery follows declared globs, exclusions, and nested packages", t => {
  const fixture = mkdtempSync(join(tmpdir(), "dohc-selection-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  writeFileSync(join(fixture, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - "!apps/excluded"\n  - "crates/interop/scripts"\n');
  for (const [path, name] of [["apps/included", "included"], ["apps/excluded", "excluded"], ["crates/interop/scripts", "nested"], ["elsewhere/ignored", "ignored"]]) {
    mkdirSync(join(fixture, path), { recursive: true });
    writeFileSync(join(fixture, path, "package.json"), JSON.stringify({ name }));
  }
  assert.deepEqual(readWorkspacePackages(fixture).map(({ name, path }) => ({ name, path })), [
    { name: "included", path: "apps/included" }, { name: "nested", path: "crates/interop/scripts" },
  ]);
  assert.ok(packages.some(pkg => pkg.name === "@dohc/yrs-interop-scripts" && pkg.path === "crates/yrs-interop/scripts"));
});

test("site changes select desktop tests without inventing a desktop production change", () => {
  const plan = select(["apps/site/src/ProductDemo.tsx"]);
  assert.equal(plan.full, false);
  assert.deepEqual(plan.affected, ["@dohc/site"]);
  assert.deepEqual(plan.packages, ["@dohc/desktop", "@dohc/site"]);
  assert.deepEqual(plan.proofs, { accounts: false, selfHostNative: false, desktop: true });
  assert.deepEqual(plan.needs, { postgres: true, engine: true, desktop: true });
});

test("desktop changes cover the site consumer and native delivery test inputs", () => {
  const plan = select(["apps/desktop/src/workspaces/nativeOwnerDelivery.ts"]);
  assert.deepEqual(plan.affected, ["@dohc/desktop", "@dohc/site"]);
  assert.deepEqual(plan.packages, ["@dohc/desktop", "@dohc/share-web", "@dohc/site", "@dohc/sync-relay", "@dohc/ydoc-projection"]);
  assert.deepEqual(plan.proofs, { accounts: false, selfHostNative: true, desktop: true });
  assert.deepEqual(plan.testFiles, {"@dohc/ydoc-projection": ["src/liveRestoreDrain.test.ts", "src/ownerDesktopTransport.test.ts"]});
});

test("projection and shared inputs override desktop-only compatibility selection", () => {
  const desktop = "apps/desktop/src/renderer/Toolbar.tsx";
  for (const input of ["packages/ydoc-projection/src/import-export.ts", "services/sync-relay/src/storage.ts",
    "packages/workspace-engine-client/src/daemon/engineClient.ts", "services/share-web/src/deviceControlBridge.ts",
    "packages/workspace-contracts/src/index.ts", "crates/dohc-engine-collab/src/lib.rs", "pnpm-lock.yaml", "unknown/input.ts"]) {
    assert.deepEqual(select([desktop, input]).testFiles, {}, input);
  }
  assert.deepEqual(select([desktop], {full: true}).testFiles, {});
});

test("new desktop imports cannot silently escape the selected compatibility files", () => {
  const source = 'import "../../../apps/desktop/src/ipc/ownerRestoreContract.js";';
  for (const path of ["packages/ydoc-projection/src/new.test.ts", "packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.ts"]) {
    assert.deepEqual(uncoveredWorkspaceInputs([{path, source}], packages).map(finding => finding.path), [path]);
  }
  assert.deepEqual(uncoveredWorkspaceInputs([{path: "packages/ydoc-projection/src/liveRestoreDrain.test.ts", source}], packages), []);
});

test("database migrations include consumers that read SQL outside their manifests", () => {
  const plan = select(["packages/workspace-postgres/src/db/migrations/0001_better_auth.sql"]);
  assert.deepEqual(plan.affected, ["@dohc/workspace-postgres"]);
  assert.deepEqual(plan.packages, ["@dohc/desktop", "@dohc/share-web", "@dohc/workspace-api", "@dohc/workspace-auth", "@dohc/workspace-postgres"]);
  assert.deepEqual(plan.proofs, { accounts: true, selfHostNative: true, desktop: true });
  assert.deepEqual(plan.needs, { postgres: true, engine: true, desktop: true });
});

test("account API changes retain browser and desktop onboarding proofs", () => {
  const plan = select(["services/workspace-api/src/main.ts"]);
  assert.deepEqual(plan.affected, ["@dohc/workspace-api"]);
  assert.deepEqual(plan.packages, ["@dohc/desktop", "@dohc/workspace-api"]);
  assert.deepEqual(plan.proofs, { accounts: true, selfHostNative: false, desktop: true });
});

test("share changes include relay and Y.Doc tests that import its source", () => {
  const plan = select(["services/share-web/src/liveGateway.ts"]);
  assert.deepEqual(plan.affected, ["@dohc/share-web"]);
  assert.deepEqual(plan.packages, ["@dohc/desktop", "@dohc/share-web", "@dohc/sync-relay", "@dohc/ydoc-projection"]);
});

test("workspace dependency closure includes every manifest dependency field", () => {
  const fixture = [
    { name: "input", path: "packages/input", manifest: {} },
    ...["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].map((field, i) => ({
      name: `consumer${i}`, path: `packages/consumer${i}`, manifest: { [field]: { [i ? `consumer${i - 1}` : "input"]: "workspace:*" } },
    })),
  ];
  const plan = selectJavaScript(["packages/input/src/input.ts"], fixture);
  assert.equal(plan.full, false);
  assert.deepEqual(plan.packages, fixture.map(pkg => pkg.name).sort());
  assert.deepEqual(plan.needs, { postgres: false, engine: false, desktop: false });
});

test("shared contracts select transitive runtime consumers", () => {
  const plan = select(["packages/workspace-contracts/src/index.ts"]);
  for (const name of ["@dohc/workspace-core", "@dohc/workspace-engine-client", "@dohc/desktop", "@dohc/site", "@dohc/sync-relay", "@dohc/workspace-api"]) {
    assert.ok(plan.affected.includes(name), `Missing dependent ${name}`);
  }
});

test("shared, native, fixture, config, and unknown inputs select all packages", () => {
  for (const path of [
    "package.json", "apps/removed/package.json", "packages/sdk/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs", ".gitignore",
    "tsconfig.base.json", "packages/sdk/tsconfig.json", "apps/desktop/vitest.config.ts", "apps/desktop/.env.production",
    "scripts/verification/verify.mjs", "tools/rust-engine-program/ydoc-replay-fixtures.json", ".github/workflows/pr-checks.yml",
    "crates/dohc-engine-domain/tests/fixtures/collection-field-values.json", "vendor/yrs/src/lib.rs", ".cargo/config.toml", "Cargo.lock", "rust-toolchain.toml",
    "examples/fundraiser/backend.ts", "examples/stock-orders/frontend.tsx", "examples/trip-poll/main.tsx", "patches/example.patch",
    "docker-compose.self-host.yml", ".env.self-host.example", ".dockerignore", "apps/desktop/scripts/stage-plugin-tools.mjs", "apps/removed/src/index.ts", "unclassified/input.ts",
  ]) {
    const plan = select([path]);
    assert.equal(plan.full, true, path);
    assert.deepEqual(plan.packages, packages.map(pkg => pkg.name).sort(), path);
    assert.deepEqual(plan.proofs, { accounts: true, selfHostNative: true, desktop: true }, path);
  }
});

test("full mode overrides an empty diff and ordinary empty selection stays empty", () => {
  const empty = select([]);
  assert.deepEqual(empty.packages, []);
  assert.deepEqual(empty.needs, { postgres: false, engine: false, desktop: false });
  const full = select([], { full: true });
  assert.equal(full.full, true);
  assert.deepEqual(full.packages, packages.map(pkg => pkg.name).sort());
});

test("deleted workspace dependencies force full verification", () => {
  const fixture = [{ name: "consumer", path: "packages/consumer", manifest: { dependencies: { removed: "workspace:*" } } }];
  const plan = selectJavaScript(["packages/consumer/src/index.ts"], fixture);
  assert.equal(plan.full, true);
  assert.match(plan.reason, /Unresolved workspace dependency/u);
});

test("literal input guard accepts imports, fixture reads, and CSS covered by the model", () => {
  const files = [
    { path: "apps/site/src/demo.css", source: '@import "../../desktop/src/renderer/styles.css";' },
    { path: "packages/workspace-auth/src/auth.test.ts", source: 'readFile(new URL("../../workspace-postgres/src/db/migrations/0001_better_auth.sql", import.meta.url))' },
    { path: "apps/desktop/e2e/helpers/onboarding.ts", source: 'import "../../../../services/workspace-api/e2e/harness";' },
    { path: "apps/desktop/src/test.ts", source: 'import "@dohc/workspace-core";' },
  ];
  assert.deepEqual(uncoveredWorkspaceInputs(files, packages), []);
});

test("literal input guard detects undeclared inputs and production use of test-only edges", () => {
  const files = [
    { path: "packages/brand/src/new.test.ts", source: 'import "../../workspace-core/src/index";' },
    { path: "apps/site/src/new.ts", source: 'import "@dohc/cli/dataset";' },
    { path: "packages/workspace-auth/src/new.ts", source: 'readFile(new URL("../../workspace-postgres/src/db/migrations/0001_better_auth.sql", import.meta.url))' },
  ];
  const findings = uncoveredWorkspaceInputs(files, packages);
  assert.deepEqual(findings.map(finding => finding.path), files.map(file => file.path));
});

test("current workspace literal cross-package inputs are covered", () => {
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split("\0")
    .filter(path => /\.(?:[cm]?[jt]sx?|css|json)$/u.test(path) && packages.some(pkg => path.startsWith(pkg.path + "/")));
  const files = paths.map(path => ({ path, source: readFileSync(resolve(root, path), "utf8") }));
  assert.deepEqual(uncoveredWorkspaceInputs(files, packages), []);
});
