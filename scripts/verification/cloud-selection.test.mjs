import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { cloudChangedFiles } from "./cloud.mjs";
import { affectedPackages, selectedGates } from "./selection.mjs";

function git(root, ...args) {
  const result = spawnSync("git", ["-c", "core.hooksPath=", "-c", "commit.gpgsign=false", ...args], {
    cwd: root, encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function mergeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dohc-cloud-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "Verification test");
  git(source, "config", "user.email", "verification@example.test");
  const commit = (file, text) => {
    mkdirSync(dirname(join(source, file)), { recursive: true });
    writeFileSync(join(source, file), text);
    git(source, "add", "--all");
    git(source, "commit", "-m", text);
  };
  commit("packages/removed/original.ts", "recorded base");
  const recordedBase = git(source, "rev-parse", "HEAD");
  git(source, "checkout", "-b", "feature");
  git(source, "mv", "packages/removed/original.ts", "packages/removed/renamed.ts");
  commit("packages/feature/source.ts", "feature change");
  git(source, "checkout", "main");
  for (let index = 0; index < 3; index++) commit(`services/main-only/${index}.ts`, `main change ${index}`);
  const mergeBase = git(source, "rev-parse", "HEAD");
  git(source, "checkout", "-b", "proof");
  git(source, "merge", "--no-ff", "feature", "-m", "test merge");
  const shallow = join(root, "shallow");
  git(root, "clone", "--no-local", "--depth=2", "--single-branch", "--branch=proof", source, shallow);
  return { root, source, shallow, recordedBase, mergeBase, commit };
}

test("PR selection uses the merge first parent when the recorded base is outside the shallow checkout", t => {
  const { source, shallow, recordedBase, mergeBase, commit } = mergeFixture(t);
  assert.equal(git(shallow, "rev-parse", "--is-shallow-repository"), "true");
  assert.equal(git(shallow, "rev-parse", "HEAD^1"), mergeBase);
  assert.notEqual(recordedBase, mergeBase);
  assert.notEqual(spawnSync("git", ["cat-file", "-e", recordedBase], { cwd: shallow, windowsHide: true }).status, 0);
  const env = { GITHUB_EVENT_NAME: "pull_request", PR_BASE_SHA: recordedBase };
  const expected = ["packages/feature/source.ts", "packages/removed/original.ts", "packages/removed/renamed.ts"];
  assert.deepEqual(cloudChangedFiles(env, shallow).sort(), expected);
  assert.deepEqual(cloudChangedFiles(env, source).sort(), expected);

  // The selection action compares these same trees; main-only changes cannot widen its gate selection.
  const selected = git(source, "diff", "--no-renames", "--name-only", "HEAD^1", "HEAD").split("\n");
  assert.deepEqual(selected.sort(), expected);
  const workflow = readFileSync(new URL("../../.github/workflows/pr-checks.yml", import.meta.url), "utf8");
  assert.deepEqual(selectedGates(cloudChangedFiles(env, shallow), workflow), selectedGates(selected, workflow));
  const packages = ["feature", "removed", "main-only"].map(name => ({ name, path: `${name === "main-only" ? "services" : "packages"}/${name}`, manifest: {} }));
  assert.deepEqual(affectedPackages(cloudChangedFiles(env, shallow), packages), affectedPackages(selected, packages));

  // A rerun uses the old merge, even when main advances again.
  git(source, "checkout", "main");
  commit("services/main-only/later.ts", "later main change");
  assert.deepEqual(cloudChangedFiles(env, shallow).sort(), expected);
});

test("PR selection rejects a checkout without a merge commit", t => {
  const { root, source } = mergeFixture(t);
  const missingParents = join(root, "missing-parents");
  git(root, "clone", "--no-local", "--depth=1", "--single-branch", "--branch=proof", source, missingParents);
  assert.throws(() => cloudChangedFiles({ GITHUB_EVENT_NAME: "pull_request" }, missingParents), /Pull request selection requires HEAD to be a merge commit with both parents available/u);
  git(source, "checkout", "main");
  assert.throws(() => cloudChangedFiles({ GITHUB_EVENT_NAME: "pull_request" }, source), /Pull request selection requires HEAD to be a merge commit/u);
});

test("manual cloud selection keeps the full inventory without reading a PR base", () => {
  assert.equal(cloudChangedFiles({ GITHUB_EVENT_NAME: "workflow_dispatch", PR_BASE_SHA: "unavailable" }, "not-a-checkout"), null);
});
