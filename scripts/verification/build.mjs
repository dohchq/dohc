import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { acquireBuildSlot, freeDiskGb, resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";
import { requireE2eEngine } from "../../apps/desktop/scripts/require-e2e-engine.mjs";
import { git, pnpm, readJson, repoRoot, run } from "./process.mjs";

export const receiptPath = join(repoRoot, ".dohc-dev/verification/build.json");
export const enginePath = join(repoRoot, "target/debug", `dohc-workspace-engine${process.platform === "win32" ? ".exe" : ""}`);
const inputPaths = {
  engine: ["crates", "fuzz", "fixtures", ".cargo", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "packages/ydoc-projection", "pnpm-lock.yaml", "scripts/verification", ".gitignore"],
  desktop: ["apps/desktop", "packages", "services", "scripts", "tools", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", ".gitignore"],
};

export function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sourceFingerprint(kind, root = repoRoot) {
  const paths = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...inputPaths[kind]], root).split("\0").filter(Boolean);
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version,
    rustflags: process.env.RUSTFLAGS ?? "", encodedRustflags: process.env.CARGO_ENCODED_RUSTFLAGS ?? "" }));
  const environment = Object.entries(process.env).filter(([key]) => /^(VITE_|RUSTUP_TOOLCHAIN$|CC$|CXX$|CFLAGS$|CXXFLAGS$|NODE_ENV$)/.test(key)).sort(([a], [b]) => a.localeCompare(b));
  hash.update(JSON.stringify(environment));
  if (kind === "engine") {
    hash.update(execFileSync("rustc", ["-vV"], { cwd: root }));
    const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
    for (const name of ["config", "config.toml"]) {
      const path = join(cargoHome, name);
      if (existsSync(path)) hash.update(readFileSync(path));
    }
  }
  for (const directory of [root, join(root, "apps/desktop")]) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).filter((name) => /^\.env(?:\.|$)/.test(name)).sort()) {
      hash.update(name + "\0"); hash.update(readFileSync(join(directory, name)));
    }
  }
  for (const path of [...new Set(paths)].sort()) {
    hash.update(path + "\0");
    const absolute = join(root, path);
    hash.update(existsSync(absolute) ? readFileSync(absolute) : "<deleted>");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function directoryFingerprint(path) {
  const hash = createHash("sha256");
  function visit(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) visit(join(directory, entry.name), name + "/");
      else { hash.update(name + "\0"); hash.update(readFileSync(join(directory, entry.name))); }
    }
  }
  visit(path);
  return hash.digest("hex");
}

function artifactFingerprint(kind) {
  if (kind === "engine") return hashFile(enginePath);
  return createHash("sha256").update(JSON.stringify([
    "apps/desktop/dist", "apps/desktop/resources/cli-bin", "apps/desktop/resources/plugin-tools", "packages/sdk/dist",
  ].map((path) => [path, directoryFingerprint(join(repoRoot, path))]))).digest("hex");
}

export function preparedStatus(kind, receipt = readJson(receiptPath)) {
  try {
    return receipt?.[kind]?.source === sourceFingerprint(kind)
      && receipt[kind].artifact === artifactFingerprint(kind);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function assertPrepared() {
  const receipt = readJson(receiptPath);
  if (!preparedStatus("engine", receipt) || !preparedStatus("desktop", receipt)) {
    throw new Error("The desktop or engine does not match this checkout. Run pnpm qa:prepare before driving it.");
  }
  const staged = join(repoRoot, "apps/desktop/target/debug", enginePath.split(/[\\/]/).at(-1));
  if (!existsSync(staged) || hashFile(staged) !== receipt.engine.artifact) {
    throw new Error("The staged engine differs from the prepared engine. Run pnpm qa:prepare.");
  }
  return receipt;
}

export function buildEnvironment(maxJobs, source = process.env) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (["CARGO_BUILD_TARGET", "CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR", "CARGO_BUILD_BUILD_DIR"].includes(name.toUpperCase())) delete env[name];
  }
  for (const name of ["CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR", "CARGO_BUILD_BUILD_DIR"]) env[name] = join(repoRoot, "target");
  if (maxJobs) {
    const requested = Number(env.CARGO_BUILD_JOBS);
    env.CARGO_BUILD_JOBS = String(Number.isInteger(requested) && requested > 0 ? Math.min(requested, maxJobs) : maxJobs);
  }
  return env;
}

export async function withBuildBudget(action) {
  const budget = resolveBuildBudget();
  if (budget) {
    const free = freeDiskGb(repoRoot);
    if (free === null || free < budget.diskFloorGb) throw new Error(`Build needs ${budget.diskFloorGb} GB free; observed ${free ?? "unknown"}.`);
  }
  const slot = budget ? await acquireBuildSlot(budget) : null;
  const env = buildEnvironment(budget?.jobs);
  try { return await action(env); }
  finally { slot?.release(); }
}

export async function prepare({ engineOnly = false, output = join(repoRoot, ".dohc-dev/verification") } = {}) {
  mkdirSync(output, { recursive: true });
  mkdirSync(resolve(receiptPath, ".."), { recursive: true });
  const lock = receiptPath + ".lock";
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" }); }
  catch (error) { if (error.code === "EEXIST") throw new Error(`Another preparation owns ${lock}. Inspect its PID before removing a stale lock.`); throw error; }
  try {
  const receipt = readJson(receiptPath) ?? { version: 1 };
  for (const kind of engineOnly ? ["engine"] : ["engine", "desktop"]) {
    if (preparedStatus(kind, receipt)) { console.log(`[prepare] reuse ${kind} ${receipt[kind].artifact.slice(0, 12)}`); continue; }
    const source = sourceFingerprint(kind);
    if (kind === "engine") {
      await withBuildBudget(async (env) => {
        const result = await run("cargo", ["build", "--locked", "--target-dir", join(repoRoot, "target"), "--message-format=json-render-diagnostics", "-p", "dohc-workspace-engine", "--bin", "dohc-workspace-engine"], { env, log: join(output, "engine-build.log"), quietStdout: true });
        const artifacts = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
        const executable = artifacts.findLast((entry) => entry.reason === "compiler-artifact" && entry.target?.name === "dohc-workspace-engine" && entry.executable)?.executable;
        if (!executable || resolve(executable).toLowerCase() !== resolve(enginePath).toLowerCase()) throw new Error(`Cargo did not build the native engine at ${enginePath}. Check Cargo target configuration.`);
      });
    } else {
      await run(...pnpm(["--filter", "@dohc/desktop", "build"]), { log: join(output, "desktop-build.log") });
    }
    if (sourceFingerprint(kind) !== source) throw new Error(`${kind} inputs changed during the build. Run preparation again.`);
    receipt[kind] = { source, artifact: artifactFingerprint(kind), commit: git(["rev-parse", "HEAD"]), builtAt: new Date().toISOString() };
    mkdirSync(resolve(receiptPath, ".."), { recursive: true });
    writeFileSync(receiptPath + ".tmp", JSON.stringify(receipt, null, 2) + "\n");
    renameSync(receiptPath + ".tmp", receiptPath);
  }
  requireE2eEngine({ override: enginePath });
  return receipt;
  } finally { unlinkSync(lock); }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  prepare({ engineOnly: process.argv.includes("--engine-only") }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
