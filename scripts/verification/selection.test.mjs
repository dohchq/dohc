import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("site changes select renderer compatibility without native preparation or desktop proofs", () => {
  const plan = select(["apps/site/src/ProductDemo.tsx"]);
  assert.equal(plan.full, false);
  assert.equal(plan.repository, "source");
  assert.deepEqual(plan.affected, ["@dohc/site"]);
  assert.deepEqual(plan.packages, ["@dohc/desktop", "@dohc/site"]);
  assert.deepEqual(plan.testFiles, {"@dohc/desktop": [
    "src/renderer/workbench/ChatLane.test.tsx", "src/renderer/workbench/ProductDemo.test.tsx",
  ]});
  for (const file of plan.testFiles["@dohc/desktop"]) assert.ok(existsSync(join(root, "apps/desktop", file)), file);
  assert.equal(plan.desktopScripts, false);
  assert.deepEqual(plan.proofs, { accounts: false, selfHostNative: false, desktop: false });
  assert.deepEqual(plan.needs, { postgres: false, engine: false, desktop: false });
});

test("desktop production and shared inputs override the site's compatibility-only selection", () => {
  const site = "apps/site/src/ProductDemo.tsx";
  for (const input of ["apps/desktop/src/renderer/Toolbar.tsx", "apps/desktop/src/testSetup.ts",
    "apps/desktop/src/testGlobalSetup.ts", "apps/desktop/src/workspaces/testTemp.ts", "apps/desktop/vitest.config.ts",
    "packages/brand/src/index.ts", "pnpm-lock.yaml", "unknown/input.ts"]) {
    const plan = select([site, input]);
    assert.equal(plan.testFiles["@dohc/desktop"], undefined, input);
    assert.equal(plan.desktopScripts, true, input);
    assert.equal(plan.proofs.desktop, true, input);
    assert.deepEqual(plan.needs, {postgres: true, engine: true, desktop: true}, input);
  }
  const full = select([site], {full: true});
  assert.deepEqual(full.testFiles, {});
  assert.equal(full.desktopScripts, true);
  assert.equal(full.proofs.desktop, true);
});

test("browser proof inputs retain preparation without unrelated desktop unit or script tests", () => {
  const site = "apps/site/src/ProductDemo.tsx";
  for (const input of ["services/workspace-api/src/main.ts", "packages/workspace-postgres/src/db/migrations/0001_better_auth.sql",
    "services/share-web/src/server.ts"]) {
    const plan = select([input]);
    assert.equal(plan.packages.includes("@dohc/desktop"), false, input);
    assert.equal(plan.desktopScripts, false, input);
    assert.equal(plan.proofs.desktop, true, input);
    assert.deepEqual(plan.needs, {postgres: true, engine: true, desktop: true}, input);
    const mixed = select([site, input]);
    assert.deepEqual(mixed.testFiles["@dohc/desktop"], select([site]).testFiles["@dohc/desktop"], input);
    assert.equal(mixed.desktopScripts, false, input);
    assert.equal(mixed.proofs.desktop, true, input);
    const full = select([input], {full: true});
    assert.ok(full.packages.includes("@dohc/desktop"), input);
    assert.deepEqual(full.testFiles, {}, input);
    assert.equal(full.desktopScripts, true, input);
    assert.equal(full.proofs.desktop, true, input);
    for (const other of ["apps/desktop/src/main.ts", "packages/app-backend-runtime/src/index.ts", "unknown/input.ts"]) {
      const combined = select([input, other]);
      assert.ok(combined.packages.includes("@dohc/desktop"), `${input}, ${other}`);
      assert.equal(combined.testFiles["@dohc/desktop"], undefined, `${input}, ${other}`);
      assert.equal(combined.desktopScripts, true, `${input}, ${other}`);
    }
  }
});

test("new desktop consumers cannot silently reuse browser-only input coverage", () => {
  for (const [input, helper] of [
    ["services/workspace-api/e2e/harness", "selfHostOnboarding"],
    ["packages/workspace-postgres/src/db/migrations/0001_better_auth.sql", "selfHostOnboarding"],
    ["services/share-web/src/server", "sharedDatasetBrowser"],
  ]) {
    const source = `import "../../../../${input}";`;
    const path = `apps/desktop/e2e/helpers/${helper}.ts`;
    assert.ok(existsSync(join(root, path)), path);
    assert.deepEqual(uncoveredWorkspaceInputs([{path, source}], packages), [], path);
    for (const path of ["apps/desktop/e2e/helpers/new.ts", "apps/desktop/src/testing/new.test.ts", "apps/desktop/src/testing/new.ts"])
      assert.deepEqual(uncoveredWorkspaceInputs([{path, source}], packages).map(finding => finding.path), [path]);
  }
  for (const helper of ["selfHostOnboarding", "sharedDatasetBrowser"]) {
    const path = "apps/desktop/src/testing/new.test.ts";
    for (const extension of ["", ".ts", ".js"]) {
      const source = `import "../../e2e/helpers/${helper}${extension}";`;
      assert.deepEqual(uncoveredWorkspaceInputs([{path, source}], packages).map(finding => finding.path), [path]);
    }
    const wrapper = "apps/desktop/e2e/helpers/wrapper.ts";
    assert.deepEqual(uncoveredWorkspaceInputs([
      {path: wrapper, source: `export * from "./${helper}.js";`},
      {path, source: 'import "../../e2e/helpers/wrapper.js";'},
    ], packages).map(finding => finding.path), [wrapper]);
  }
});

test("new site imports cannot escape the selected desktop compatibility files", () => {
  const source = 'import "../../../../site/src/ProductDemo";';
  for (const path of ["apps/desktop/src/renderer/workbench/new.test.tsx", "apps/desktop/src/renderer/workbench/new.tsx"]) {
    assert.deepEqual(uncoveredWorkspaceInputs([{path, source}], packages).map(finding => finding.path), [path]);
  }
  for (const name of ["ChatLane", "ProductDemo"]) {
    assert.deepEqual(uncoveredWorkspaceInputs([{path: `apps/desktop/src/renderer/workbench/${name}.test.tsx`, source}], packages), []);
  }
});

test("desktop changes cover the site consumer and native delivery test inputs", () => {
  const plan = select(["apps/desktop/src/workspaces/nativeOwnerDelivery.ts"]);
  assert.deepEqual(plan.affected, ["@dohc/desktop", "@dohc/site"]);
  assert.deepEqual(plan.packages, ["@dohc/desktop", "@dohc/share-web", "@dohc/site", "@dohc/sync-relay", "@dohc/ydoc-projection"]);
  assert.deepEqual(plan.proofs, { accounts: false, selfHostNative: true, desktop: true });
  assert.equal(plan.desktopScripts, true);
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
  assert.deepEqual(plan.packages, ["@dohc/share-web", "@dohc/workspace-api", "@dohc/workspace-auth", "@dohc/workspace-postgres"]);
  assert.deepEqual(plan.proofs, { accounts: true, selfHostNative: true, desktop: true });
  assert.deepEqual(plan.needs, { postgres: true, engine: true, desktop: true });
});

test("account API changes retain browser and desktop onboarding proofs", () => {
  const plan = select(["services/workspace-api/src/main.ts"]);
  assert.deepEqual(plan.affected, ["@dohc/workspace-api"]);
  assert.deepEqual(plan.packages, ["@dohc/workspace-api"]);
  assert.deepEqual(plan.proofs, { accounts: true, selfHostNative: false, desktop: true });
});

test("share changes include relay and Y.Doc tests that import its source", () => {
  const plan = select(["services/share-web/src/liveGateway.ts"]);
  assert.deepEqual(plan.affected, ["@dohc/share-web"]);
  assert.deepEqual(plan.packages, ["@dohc/share-web", "@dohc/sync-relay", "@dohc/ydoc-projection"]);
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
    "scripts/verification/verify.mjs", "scripts/verification/verification-matrix.test.mjs", "scripts/verification/ordered-delivery-fixture.test.mjs", "scripts/self-host-health.test.mjs", "tools/self-host/health.mjs", "tools/rust-engine-program/ydoc-replay-fixtures.json", ".github/workflows/pr-checks.yml",
    "crates/dohc-engine-domain/tests/fixtures/collection-field-values.json", "vendor/yrs/src/lib.rs", ".cargo/config.toml", "Cargo.lock", "rust-toolchain.toml",
    "examples/fundraiser/backend.ts", "examples/stock-orders/frontend.tsx", "examples/trip-poll/main.tsx", "patches/example.patch",
    "docker-compose.self-host.yml", ".env.self-host.example", ".dockerignore", "apps/desktop/scripts/stage-plugin-tools.mjs", "apps/removed/src/index.ts", "unclassified/input.ts",
  ]) {
    const plan = select([path]);
    assert.equal(plan.full, true, path);
    assert.equal(plan.repository, "full", path);
    assert.deepEqual(plan.packages, packages.map(pkg => pkg.name).sort(), path);
    assert.deepEqual(plan.proofs, { accounts: true, selfHostNative: true, desktop: true }, path);
  }
});

test("full mode overrides an empty diff and ordinary empty selection stays empty", () => {
  const empty = select([]);
  assert.deepEqual(empty.packages, []);
  assert.deepEqual(empty.needs, { postgres: false, engine: false, desktop: false });
  assert.equal(empty.desktopScripts, false);
  const full = select([], { full: true });
  assert.equal(full.full, true);
  assert.equal(full.repository, "full");
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
    { path: "apps/desktop/e2e/helpers/selfHostOnboarding.ts", source: 'import "../../../../services/workspace-api/e2e/harness";' },
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

test("canonical repository checks include every script contract except the Docker proof", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const listed = new Set([...manifest.scripts["test:repo"].matchAll(/[^\s]+\.test\.mjs/gu),
    ...manifest.scripts["test:repo:source"].matchAll(/[^\s]+\.test\.mjs/gu)].map(([path]) => path));
  const optIn = new Set(["scripts/self-host/recovery.docker.test.mjs"]);
  for (const file of globSync(["scripts/**/*.test.mjs", "tools/**/*.test.mjs"], { cwd: root })) {
    const path = file.replaceAll("\\", "/");
    assert.ok(listed.has(path) || optIn.has(path), `Missing canonical repository contract: ${path}`);
  }
});
