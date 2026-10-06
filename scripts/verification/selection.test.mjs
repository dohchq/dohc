import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { gateInputMessage, isGateReader, readWorkspacePackages, selectJavaScript, uncoveredGateInputs, uncoveredWorkspaceInputs } from "./selection.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const yaml = createRequire(new URL("../../apps/desktop/package.json", import.meta.url))("js-yaml");
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
    "src/renderer/tokens.test.ts", "src/renderer/workbench/ChatLane.test.tsx", "src/renderer/workbench/ProductDemo.test.tsx",
  ]});
  for (const file of plan.testFiles["@dohc/desktop"]) assert.ok(existsSync(join(root, "apps/desktop", file)), file);
  assert.equal(plan.desktopScripts, false);
  assert.deepEqual(plan.proofs, { accounts: false, selfHostNative: false, desktop: false, statesPage: false });
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

test("onboarding inputs select the two-daemon test and browser proofs without unrelated desktop tests", () => {
  const site = "apps/site/src/ProductDemo.tsx";
  for (const input of ["services/workspace-api/src/main.ts", "packages/workspace-postgres/src/db/migrations/0001_better_auth.sql",
    "services/share-web/src/server.ts"]) {
    const plan = select([input]);
    assert.equal(plan.packages.includes("@dohc/desktop"), true, input);
    assert.deepEqual(plan.testFiles["@dohc/desktop"], ["src/workspaces/twoDaemonSync.e2e.test.ts"], input);
    assert.equal(plan.desktopScripts, false, input);
    assert.equal(plan.proofs.desktop, true, input);
    assert.deepEqual(plan.needs, {postgres: true, engine: true, desktop: true}, input);
    const mixed = select([site, input]);
    assert.deepEqual(mixed.testFiles["@dohc/desktop"], [...select([site]).testFiles["@dohc/desktop"],
      "src/workspaces/twoDaemonSync.e2e.test.ts"].sort(), input);
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
    ["services/share-web/src/testing/localhostCa", "selfHostOnboarding"],
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

test("renderer and states-page inputs add the pixel gallery to the desktop proofs", () => {
  for (const input of ["apps/desktop/src/renderer/ui/controls.tsx", "apps/desktop/src/renderer/styles.css",
    "apps/desktop/e2e/states-page.spec.ts", "apps/desktop/e2e/states-page.spec.ts-snapshots/buttons-light-win32.png"]) {
    const plan = select([input]);
    assert.equal(plan.proofs.desktop, true, input);
    assert.equal(plan.proofs.statesPage, true, input);
  }
  for (const input of ["apps/desktop/src/main.ts", "apps/desktop/e2e/apps.spec.ts", "services/workspace-api/src/main.ts"]) {
    assert.equal(select([input]).proofs.statesPage, false, input);
  }
  assert.equal(select(["apps/site/src/ProductDemo.tsx"], {full: true}).proofs.statesPage, true);
});

test("desktop changes cover the site consumer and native delivery test inputs", () => {
  const plan = select(["apps/desktop/src/workspaces/nativeOwnerDelivery.ts"]);
  assert.deepEqual(plan.affected, ["@dohc/desktop", "@dohc/site"]);
  assert.deepEqual(plan.packages, ["@dohc/desktop", "@dohc/share-web", "@dohc/site", "@dohc/sync-relay", "@dohc/ydoc-projection"]);
  assert.deepEqual(plan.proofs, { accounts: false, selfHostNative: true, desktop: true, statesPage: false });
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

test("Y.Doc transport tests declare the relay HTTP and auth sources they import", () => {
  const source = 'import "../../service-http/src/index.js"; import "../../workspace-auth/src/session.js";';
  assert.deepEqual(uncoveredWorkspaceInputs([{path: "packages/ydoc-projection/src/ownerDesktopTransport.test.ts", source}], packages), []);
  assert.deepEqual(uncoveredWorkspaceInputs([{path: "packages/ydoc-projection/src/import-export.ts", source}], packages)
    .map(finding => finding.input), ["@dohc/service-http", "@dohc/workspace-auth"]);
  for (const input of ["packages/service-http/src/index.ts", "packages/workspace-auth/src/session.ts"]) {
    assert.ok(select([input]).packages.includes("@dohc/ydoc-projection"), input);
  }
});

test("database migrations include consumers that read SQL outside their manifests", () => {
  const plan = select(["packages/workspace-postgres/src/db/migrations/0001_better_auth.sql"]);
  assert.deepEqual(plan.affected, ["@dohc/workspace-postgres"]);
  assert.deepEqual(plan.packages, ["@dohc/desktop", "@dohc/share-web", "@dohc/workspace-api", "@dohc/workspace-auth", "@dohc/workspace-postgres"]);
  assert.deepEqual(plan.proofs, { accounts: true, selfHostNative: true, desktop: true, statesPage: false });
  assert.deepEqual(plan.needs, { postgres: true, engine: true, desktop: true });
});

test("account API changes retain browser and desktop onboarding proofs", () => {
  const plan = select(["services/workspace-api/src/main.ts"]);
  assert.deepEqual(plan.affected, ["@dohc/workspace-api"]);
  assert.deepEqual(plan.packages, ["@dohc/desktop", "@dohc/workspace-api"]);
  assert.deepEqual(plan.proofs, { accounts: true, selfHostNative: false, desktop: true, statesPage: false });
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
    "scripts/verification/verify.mjs", "scripts/verification/verification-matrix.test.mjs", "scripts/verification/ordered-delivery-fixture.test.mjs", "scripts/self-host-health.test.mjs", "tools/self-host/health.mjs", "tools/rust-engine-program/ydoc-replay-fixtures.json", ".github/workflows/pr-checks.yml",
    "crates/dohc-engine-domain/tests/fixtures/collection-field-values.json", "vendor/yrs/src/lib.rs", ".cargo/config.toml", "Cargo.lock", "rust-toolchain.toml",
    "examples/fundraiser/backend.ts", "examples/stock-orders/frontend.tsx", "examples/trip-poll/main.tsx", "patches/example.patch",
    "docker-compose.self-host.yml", ".env.self-host.example", ".dockerignore", "apps/desktop/scripts/stage-plugin-tools.mjs", "apps/removed/src/index.ts", "unclassified/input.ts",
  ]) {
    const plan = select([path]);
    assert.equal(plan.full, true, path);
    assert.equal(plan.repository, "full", path);
    assert.deepEqual(plan.packages, packages.map(pkg => pkg.name).sort(), path);
    assert.deepEqual(plan.proofs, { accounts: true, selfHostNative: true, desktop: true, statesPage: true }, path);
  }
});

test("desktop shutdown budgets retain the plain Node debug and verification runtime checks", () => {
  const input = "apps/desktop/src/shutdownBudgets.ts";
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const path of [input, input.replaceAll("/", "\\")]) {
    const plan = select([path]);
    assert.equal(plan.full, true);
    assert.equal(plan.repository, "full");
    assert.equal(plan.reason, `Shared verification input changed: ${input}`);
    const command = manifest.scripts[plan.repository === "full" ? "test:repo" : "test:repo:source"];
    for (const consumer of ["scripts/verification/debug.test.mjs", "scripts/verification/verification.test.mjs"]) {
      assert.ok(command.split(/\s+/u).includes(consumer), `Missing shutdown budget runtime check: ${consumer}`);
    }
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
  const tracked = execFileSync("git", ["ls-files", "-z", "--", ":(glob)scripts/**/*.test.mjs", ":(glob)tools/**/*.test.mjs"],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split("\0").filter(Boolean);
  assert.ok(tracked.includes("scripts/build-slot.test.mjs"));
  assert.ok(tracked.includes("scripts/verification/selection.test.mjs"));
  for (const path of tracked) {
    assert.ok(listed.has(path) || optIn.has(path), `Missing canonical repository contract: ${path}`);
  }
});

const gateWorkflow = `jobs:
  changes:
    steps:
      - with:
          filters: |
            rust:
              - 'crates/**'
              - 'scripts/rust-input.mjs'
            js:
              - 'scripts/**'
`;
const gateFinding = (reader, input, gate) => ({ reader, input, gate, filterLine: `- '${input.replaceAll("'", "''")}'` });
const gateFixture = (reader, source, input) => uncoveredGateInputs([{ path: reader, source }], [reader, input], gateWorkflow);

test("gate input guard rejects a relative fixture outside the reader's gate", () => {
  const reader = "crates/engine/src/fixture.rs";
  const input = "packages/scenes/fixtures/canonical.json";
  assert.deepEqual(gateFixture(reader, 'include_str!("../../../packages/scenes/fixtures/canonical.json")', input),
    [gateFinding(reader, input, "rust")]);
});

test("gate input guard rejects a bare direct read outside the reader's gate", () => {
  const reader = "scripts/compose.test.mjs";
  const input = "docker-compose.self-host.yml";
  assert.deepEqual(gateFixture(reader, 'readFileSync("docker-compose.self-host.yml", "utf8")', input),
    [gateFinding(reader, input, "js")]);
  assert.deepEqual(gateFixture(reader, 'readFile("LICENSE")', "LICENSE"), [gateFinding(reader, "LICENSE", "js")]);
});

test("gate input guard admits read_to_string without another read or path word", () => {
  const reader = "scripts/read.mjs";
  assert.deepEqual(gateFixture(reader, 'read_to_string("LICENSE");', "LICENSE"),
    [gateFinding(reader, "LICENSE", "js")]);
});

test("gate input guard resolves bare URL inputs from the reader directory", () => {
  const reader = "scripts/read.mjs";
  const input = "scripts/fixture.json";
  const workflow = gateWorkflow.replace("scripts/**", reader);
  for (const source of ['readFileSync(new URL("fixture.json", import.meta.url));',
    "new URL('fixture.json', import.meta.url);", 'new URL(`fixture.json`, import.meta.url);',
    'new URL(/* input */ "fixture.json" /* note */, /* base */ import.meta.url);']) {
    assert.deepEqual(uncoveredGateInputs([{path: reader, source}], [reader, input, "fixture.json"], workflow),
      [gateFinding(reader, input, "js")], source);
  }
  assert.deepEqual(uncoveredGateInputs([{path: reader, source: 'new URL("fixture.json", otherBase);'}],
    [reader, input], workflow), []);
});

test("gate input guard decodes file-relative URL inputs", () => {
  const reader = "scripts/read.mjs";
  const workflow = gateWorkflow.replace("scripts/**", reader);
  for (const [reference, input] of [["my%20file.json", "scripts/my file.json"],
    ["./my%20file.json", "scripts/my file.json"], ["../my%20file.json", "my file.json"],
    ["caf%C3%A9.json", "scripts/café.json"], ["100%25.json", "scripts/100%.json"],
    ["my%20file.json?version=1#part", "scripts/my file.json"]]) {
    for (const quote of ['"', "'", "`"]) {
      const source = 'readFileSync(new URL(' + quote + reference + quote + ', import.meta.url));';
      assert.deepEqual(uncoveredGateInputs([{path: reader, source}], [reader, input], workflow),
        [gateFinding(reader, input, "js")], source);
    }
  }
  for (const reference of ["bad%ZZ.json", "bad%FF.json", "nested%2Ffile.json", "https://example.com/my%20file.json"]) {
    const source = 'new URL("' + reference + '", import.meta.url);';
    assert.deepEqual(uncoveredGateInputs([{path: reader, source}],
      [reader, "scripts/" + reference, "scripts/nested/file.json"], workflow), [], source);
  }
  assert.deepEqual(uncoveredGateInputs([{path: reader, source: 'readFileSync("my%20file.json");'}],
    [reader, "scripts/my file.json"], workflow), []);
});

test("gate input guard resolves bare names under known directory bases", () => {
  const reader = "apps/tool/src/read.mjs";
  const input = "apps/tool/src/fixture.json";
  const workflow = gateWorkflow.replace("scripts/**", reader);
  const tracked = [reader, input, "apps/tool/package.json", "apps/tool/fixture.json", "fixture.json"];
  for (const call of ["join", "resolve"]) {
    for (const base of ["import.meta.dirname", "__dirname"]) {
      const source = call + '(' + base + ', "fixture.json");';
      assert.deepEqual(uncoveredGateInputs([{path: reader, source}], tracked, workflow),
        [gateFinding(reader, input, "js")], source);
      const commented = call + '(/* base */ ' + base + ' /* note */, /* input */ "fixture.json");';
      assert.deepEqual(uncoveredGateInputs([{path: reader, source: commented}], tracked, workflow),
        [gateFinding(reader, input, "js")], commented);
    }
    for (const base of ["temp", "other.dirname"]) {
      const source = call + '(' + base + ', "fixture.json");';
      assert.deepEqual(uncoveredGateInputs([{path: reader, source}], tracked, workflow), [], source);
    }
  }
});

test("gate input guard checks direct reads against each possible working directory", () => {
  const reader = "apps/tool/src/read.mjs";
  const inputs = ["apps/tool/src/fixture.json", "apps/tool/fixture.json", "fixture.json"];
  const workflow = gateWorkflow.replace("scripts/**", reader);
  const tracked = [reader, ...inputs, "apps/package.json", "apps/tool/package.json", "apps/fixture.json"];
  for (const reference of ["./fixture.json", "fixture.json"]) {
    const source = 'readFileSync("' + reference + '"); readFileSync("' + reference + '");';
    assert.deepEqual(uncoveredGateInputs([{path: reader, source}], tracked, workflow),
      inputs.map(input => gateFinding(reader, input, "js")), reference);
  }
  assert.deepEqual(uncoveredGateInputs([{path: reader, source: 'readFileSync("../fixture.json");'}], tracked, workflow),
    [gateFinding(reader, "apps/tool/fixture.json", "js"), gateFinding(reader, "apps/fixture.json", "js")]);
  const covered = workflow.replace("- '" + reader + "'", "- '" + reader + "'\n              - '" + inputs[0] + "'");
  assert.deepEqual(uncoveredGateInputs([{path: reader, source: 'readFile("./fixture.json");'}], tracked, covered),
    inputs.slice(1).map(input => gateFinding(reader, input, "js")));
});

test("gate input guard keeps URL and directory joins file-relative", () => {
  const reader = "apps/tool/src/read.mjs";
  const input = "apps/tool/src/fixture.json";
  const workflow = gateWorkflow.replace("scripts/**", reader);
  for (const source of ['new URL("./fixture.json", import.meta.url);', 'join(import.meta.dirname, "./fixture.json");',
    'resolve(import.meta.dirname, "./fixture.json");']) {
    assert.deepEqual(uncoveredGateInputs([{path: reader, source}],
      [reader, input, "apps/tool/package.json", "apps/tool/fixture.json", "fixture.json"], workflow),
      [gateFinding(reader, input, "js")], source);
  }
});

test("gate input guard emits valid YAML for paths with apostrophes", () => {
  const reader = "scripts/read.mjs";
  const input = "assets/it's.json";
  const findings = gateFixture(reader, 'readFileSync("assets/it\'s.json");', input);
  assert.deepEqual(findings, [{reader, input, gate: "js", filterLine: "- 'assets/it''s.json'"}]);
  assert.deepEqual(yaml.load(findings[0].filterLine), [input]);
});

test("gate input guard ignores comment mentions and commented reads", () => {
  const source = `// readFileSync("docker-compose.self-host.yml")
/*
readFileSync("docker-compose.self-host.yml")
*/
const value = 1; // readFileSync("docker-compose.self-host.yml")`;
  assert.deepEqual(gateFixture("scripts/compose.test.mjs", source, "docker-compose.self-host.yml"), []);
});

test("gate input guard ignores selector assertions and strings outside call arguments", () => {
  const reader = "scripts/selection.test.mjs";
  const input = ".config/nextest.toml";
  const source = 'readFileSync("scripts/covered.mjs"); assert.deepEqual(selectedGates([".config/nextest.toml"], workflow), {});';
  assert.deepEqual(gateFixture(reader, source, input), []);
  for (const source of ['readFileSync(variable) + "./missing.json";', 'readFileSync("./missing.json" + suffix);',
    'readFileSync(`./${name}.json`);']) {
    assert.deepEqual(gateFixture(reader, source, "scripts/missing.json"), []);
  }
});

test("JavaScript files inside the Rust filter are inputs rather than Rust readers", () => {
  const reader = "scripts/rust-input.mjs";
  const input = "scripts/js-only.mjs";
  assert.deepEqual(gateFixture(reader, 'readFileSync("./js-only.mjs")', input), []);
});

test("gate input guard accepts covered inputs and ignores bare path-builder arguments", () => {
  const reader = "scripts/compose.test.mjs";
  assert.deepEqual(gateFixture(reader, 'readFileSync("./covered.mjs")', "scripts/covered.mjs"), []);
  for (const source of ['join(temp, "docker-compose.self-host.yml")', 'new URL("docker-compose.self-host.yml", import.meta.url)',
    'readFileSync(variable, "docker-compose.self-host.yml")']) {
    assert.deepEqual(gateFixture(reader, source, "docker-compose.self-host.yml"), []);
  }
});

test("gate input guard checks literal read and path call arguments and deduplicates findings", () => {
  const input = "packages/scenes/fixtures/canonical.json";
  const rust = "crates/engine/src/fixture.rs";
  for (const call of ["include_str!", "include_bytes!", "read_to_string", "std::fs::read", "File::open", "Path::new", "PathBuf::from", "join"]) {
    const reference = call.startsWith("include_") ? "../../../" + input : "../../" + input;
    const source = `${call}("${reference}"); ${call}("${reference}");`;
    assert.deepEqual(uncoveredGateInputs([{path: rust, source}], [rust, input, "crates/engine/Cargo.toml"], gateWorkflow),
      [gateFinding(rust, input, "rust")], call);
  }
  const js = "scripts/fixture.mjs";
  for (const call of ["readFileSync", "readFile", "createReadStream", "new URL", "join", "resolve", "existsSync"]) {
    const source = `${call}("../${input}"); ${call}("../${input}");`;
    assert.deepEqual(gateFixture(js, source, input), [gateFinding(js, input, "js")], call);
  }
});

test("current workspace literal gate inputs are covered", () => {
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\0").filter(Boolean);
  const files = paths.filter(isGateReader)
    .map(path => ({ path, source: readFileSync(resolve(root, path), "utf8") }));
  const workflow = readFileSync(join(root, ".github/workflows/pr-checks.yml"), "utf8");
  const findings = uncoveredGateInputs(files, paths, workflow);
  assert.deepEqual(findings, [], findings.map(gateInputMessage).join("\n"));
});

test("regex quotes do not hide a later literal read and division keeps its read arguments", () => {
  const reader = "scripts/compose.test.mjs";
  const input = ".env.self-host.example";
  const source = String.raw`if (/[\r\n'\x00]/.test(name)) throw new Error('invalid');
readFileSync(new URL('../.env.self-host.example', import.meta.url));`;
  assert.deepEqual(gateFixture(reader, source, input), [gateFinding(reader, input, "js")]);
  assert.deepEqual(gateFixture(reader, 'numerator / readFileSync(".env.self-host.example") / denominator;', input),
    [gateFinding(reader, input, "js")]);
});

test("gate input guard keeps reads after Rust and JavaScript string continuations", () => {
  const reader = "crates/engine/src/fixture.rs";
  const input = "packages/scenes/fixtures/canonical.json";
  for (const newline of ["\n", "\r\n"]) {
    const source = 'const MESSAGE: &str = "a long \\' + newline + 'message";\ninclude_str!("../../../packages/scenes/fixtures/canonical.json");';
    assert.deepEqual(gateFixture(reader, source, input), [gateFinding(reader, input, "rust")]);
    const js = 'const message = "a long \\' + newline + 'message";\nreadFileSync("LICENSE");';
    assert.deepEqual(gateFixture("scripts/read.mjs", js, "LICENSE"), [gateFinding("scripts/read.mjs", "LICENSE", "js")]);
  }
});

test("gate input guard resolves Rust runtime reads from the nearest crate manifest", () => {
  const reader = "crates/engine/src/tests/fixture.rs";
  const input = "packages/scenes/fixtures/canonical.json";
  for (const source of [
    'let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/scenes/fixtures/canonical.json");',
    'let text = std::fs::read_to_string("../../packages/scenes/fixtures/canonical.json");',
  ]) {
    assert.deepEqual(uncoveredGateInputs([{path: reader, source}],
      [reader, input, "Cargo.toml", "crates/engine/Cargo.toml"], gateWorkflow), [gateFinding(reader, input, "rust")]);
  }
});

test("gate input guard recognizes Rust raw and byte string literals", () => {
  const reader = "crates/engine/src/fixture.rs";
  const input = "packages/scenes/fixtures/canonical.json";
  for (const literal of ['r"../../../packages/scenes/fixtures/canonical.json"',
    'r#"../../../packages/scenes/fixtures/canonical.json"#', 'r###"../../../packages/scenes/fixtures/canonical.json"###']) {
    assert.deepEqual(gateFixture(reader, 'include_bytes!(' + literal + ');', input), [gateFinding(reader, input, "rust")], literal);
  }
  for (const literal of ['b"quoted \\" data"', 'br##"quoted " data"##']) {
    const source = "const BYTES: &[u8] = " + literal + '; include_bytes!("../../../packages/scenes/fixtures/canonical.json");';
    assert.deepEqual(gateFixture(reader, source, input), [gateFinding(reader, input, "rust")], literal);
  }
});

test("gate input guard visits template expressions while ignoring template text", () => {
  const reader = "scripts/read.mjs";
  const input = "LICENSE";
  const source = 'const text = `readFileSync("ignored.json") ${readFileSync("LICENSE")}`;';
  assert.deepEqual(gateFixture(reader, source, input), [gateFinding(reader, input, "js")]);
  assert.deepEqual(gateFixture(reader, 'const text = `${`${readFileSync("LICENSE")}`}`;', input), [gateFinding(reader, input, "js")]);
  assert.deepEqual(gateFixture(reader, 'const text = `readFileSync("LICENSE")`;', input), []);
});

test("gate input guard keeps reads after an arrow-function regex", () => {
  const reader = "scripts/read.mjs";
  const input = "LICENSE";
  const source = 'const valid = name => /["\\x27()]/.test(name);\nreadFileSync("LICENSE");';
  assert.deepEqual(gateFixture(reader, source, input), [gateFinding(reader, input, "js")]);
});

test("gate input guard ignores nested Rust block comments", () => {
  const source = '/* disabled /* note */ include_str!("../../../packages/scenes/fixtures/canonical.json") */';
  assert.deepEqual(gateFixture("crates/engine/src/fixture.rs", source, "packages/scenes/fixtures/canonical.json"), []);
});

test("gate input guard distinguishes Rust lifetimes from character literals", () => {
  const reader = "crates/engine/src/fixture.rs";
  const input = "packages/scenes/fixtures/canonical.json";
  const source = "fn fixture<'a>() { include_str!(\"../../../packages/scenes/fixtures/canonical.json\"); let character = 'x'; }";
  assert.deepEqual(gateFixture(reader, source, input), [gateFinding(reader, input, "rust")]);
});

test("gate input guard resolves bare include paths from the file directory", () => {
  const reader = "crates/engine/src/fixture.rs";
  const input = "crates/engine/src/README.md";
  const workflow = gateWorkflow.replace("crates/**", reader);
  assert.deepEqual(uncoveredGateInputs([{path: reader, source: 'include_str!("README.md");'}],
    [reader, input, "README.md"], workflow), [gateFinding(reader, input, "rust")]);
});

test("gate input guard admits a bare read after argument comments", () => {
  assert.deepEqual(gateFixture("scripts/read.mjs", 'readFileSync(/* input */ "LICENSE");', "LICENSE"),
    [gateFinding("scripts/read.mjs", "LICENSE", "js")]);
});

test("gate input prefilter preserves commented, optional, and later literal arguments", () => {
  const reader = "scripts/fixture.ts";
  const input = "LICENSE";
  for (const source of [
    'readFileSync /* call */ (/* input */ "LICENSE");',
    'readFileSync // call\n(// input\n"LICENSE");',
    'fs.readFileSync?.("LICENSE");',
    'readFileSync(unknown, "../LICENSE");',
    'join(unknown, /* input */ "../LICENSE");',
    'resolve?.(unknown, "../LICENSE");',
    'new /* call */ URL(/* input */ "../LICENSE", import.meta.url);',
    'const text = \x60\x24{join("../LICENSE")}\x60;',
  ]) {
    assert.deepEqual(gateFixture(reader, source, input), [gateFinding(reader, input, "js")], source);
  }
});

test("gate input prefilter retains overlapping quotes and mixed quotes in paths", () => {
  const reader = "scripts/fixture.mjs";
  for (const [source, input] of [
    ['import value from "./covered.mjs"; const text = \x60\x24{new URL("../LICENSE", import.meta.url)}\x60;', "LICENSE"],
    ['// "unmatched quote\nresolve("../LICENSE");', "LICENSE"],
    [String.raw`const text = "escaped \" quote"; resolve("../LICENSE");`, "LICENSE"],
    [`resolve("../assets/it's.json");`, "assets/it's.json"],
    [`resolve('../assets/a"b.json');`, 'assets/a"b.json'],
  ]) {
    assert.deepEqual(gateFixture(reader, source, input), [gateFinding(reader, input, "js")], source);
  }
});
