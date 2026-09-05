import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { freeDiskGb, resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";
import { preparedStatus } from "./build.mjs";
import { git, repoRoot } from "./process.mjs";

export function doctor({ ready = false } = {}) {
  const checks = [];
  const add = (name, ok, detail, optional = false) => checks.push({ name, state: ok ? "PASS" : optional ? "PENDING" : "FAIL", detail });
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const [major, minor] = process.versions.node.split(".").map(Number);
  add("node", major > 24 || major === 24 && minor >= 14, process.version);
  const require = createRequire(join(repoRoot, "apps/desktop/package.json"));
  for (const dependency of ["pnpm", "electron", "playwright"]) {
    try {
      const installed = require(dependency === "pnpm" ? "pnpm" : `${dependency}/package.json`).version;
      add(dependency, dependency !== "pnpm" || installed === pkg.engines.pnpm, installed);
    } catch { add(dependency, false, "Run pnpm setup:worktree."); }
  }
  try {
    const electronRoot = dirname(require.resolve("electron/package.json"));
    const binary = readFileSync(join(electronRoot, "path.txt"), "utf8").trim();
    add("electron binary", existsSync(join(electronRoot, "dist", binary)), "Desktop runtime");
  }
  catch { add("electron binary", false, "Run node apps/desktop/scripts/ensure-electron-installed.mjs."); }
  for (const tool of ["rustc", "cargo"]) {
    try { add(tool, true, execFileSync(tool, ["--version"], { encoding: "utf8", env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" } }).trim()); }
    catch { add(tool, false, "Install the repository Rust toolchain."); }
  }
  const free = freeDiskGb(repoRoot);
  const floor = resolveBuildBudget()?.diskFloorGb ?? 0;
  add("disk", free !== null && free >= floor, `${free?.toFixed(1) ?? "unknown"} GB free; ${floor} GB required`);
  for (const kind of ["engine", "desktop"]) {
    try { add(`${kind} build`, preparedStatus(kind), "Run pnpm qa:prepare when inputs or artifacts differ.", !ready); }
    catch { add(`${kind} build`, false, "Build readiness could not be checked. Fix the toolchain or build receipt, then run pnpm qa:prepare."); }
  }
  return { root: repoRoot, commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "", checks };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const result = doctor({ ready: process.argv.includes("--ready") });
  console.log(JSON.stringify(result, null, 2));
  if (result.checks.some((check) => check.state === "FAIL")) process.exitCode = 1;
}
