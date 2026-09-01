#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireE2eEngine } from "./require-e2e-engine.mjs";
import {
  currentUiAuditBundles,
  writeUiAuditBuildProvenance,
} from "./ui-audit-build-provenance.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "../..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

if (!process.env.UI_AUDIT_SHOT_DIR?.trim()) {
  throw new Error("set UI_AUDIT_SHOT_DIR to an empty output directory");
}
const commit = git(["rev-parse", "HEAD"]);
if (git(["status", "--porcelain"]) !== "") {
  throw new Error("commit the worktree before building UI audit evidence");
}

run(pnpm, ["--filter", "@dohc/desktop", "build:engine"]);
run(pnpm, ["--filter", "@dohc/desktop", "build"]);
const stagedEngine = join(
  desktopRoot,
  "resources/workspace-engine",
  `dohc-workspace-engine${process.platform === "win32" ? ".exe" : ""}`,
);
requireE2eEngine({ override: stagedEngine });

if (git(["rev-parse", "HEAD"]) !== commit || git(["status", "--porcelain"]) !== "") {
  throw new Error("the worktree changed while building UI audit evidence");
}
const bundles = currentUiAuditBundles(desktopRoot);
writeUiAuditBuildProvenance(desktopRoot, commit, bundles, new Date().toISOString());

run(
  process.execPath,
  [
    join(desktopRoot, "scripts/run-playwright.mjs"),
    "--config",
    join(desktopRoot, "playwright.config.ts"),
    "--grep",
    "@ui-audit",
  ],
  { ...process.env, DOHC_TEST_ENGINE_BINARY: stagedEngine },
);
