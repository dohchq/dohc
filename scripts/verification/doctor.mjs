import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { freeDiskGb, resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";
import { preparedStatus } from "./build.mjs";
import { git, repoRoot } from "./process.mjs";

export function doctor({ ready = false, engine = true, desktop = true, browser = true } = {}) {
  const checks = [];
  const add = (name, ok, detail, optional = false) => checks.push({ name, state: ok ? "PASS" : optional ? "PENDING" : "FAIL", detail });
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const [major, minor] = process.versions.node.split(".").map(Number);
  add("node", major > 24 || major === 24 && minor >= 14, process.version);
  if (process.platform === "win32") {
    try {
      const version = execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
        encoding: "utf8", windowsHide: true, timeout: 10_000,
      }).trim();
      add("PowerShell", Number(version.split(".")[0]) >= 7, version);
    } catch { add("PowerShell", false, "Install PowerShell 7 and put pwsh.exe on PATH."); }
  }
  const require = createRequire(join(repoRoot, "apps/desktop/package.json"));
  for (const dependency of ["pnpm", ...(desktop ? ["electron"] : []), ...(browser ? ["playwright"] : [])]) {
    try {
      const installed = require(dependency === "pnpm" ? "pnpm" : `${dependency}/package.json`).version;
      add(dependency, dependency !== "pnpm" || installed === pkg.engines.pnpm, installed);
    } catch { add(dependency, false, "Run pnpm setup:worktree."); }
  }
  if (desktop) try {
    const electronRoot = dirname(require.resolve("electron/package.json"));
    const binary = readFileSync(join(electronRoot, "path.txt"), "utf8").trim();
    add("electron binary", existsSync(join(electronRoot, "dist", binary)), "Desktop runtime");
  }
  catch { add("electron binary", false, "Run node apps/desktop/scripts/ensure-electron-installed.mjs."); }
  for (const tool of engine || desktop ? ["rustc", "cargo"] : []) {
    try { add(tool, true, execFileSync(tool, ["--version"], { encoding: "utf8", env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" } }).trim()); }
    catch { add(tool, false, "Install the repository Rust toolchain."); }
  }
  const free = freeDiskGb(repoRoot);
  const budget = engine || desktop ? resolveBuildBudget() : null;
  const floor = budget?.diskFloorGb ?? 0;
  add("disk", free !== null && free >= floor, `${free?.toFixed(1) ?? "unknown"} GB free; ${budget ? `${floor} GB required` : "no build budget configured"}`, !budget);
  for (const kind of [...(engine || desktop ? ["engine"] : []), ...(desktop ? ["desktop"] : [])]) {
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
