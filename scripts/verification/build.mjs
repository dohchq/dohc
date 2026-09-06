import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { acquireBuildSlot, freeDiskGb, resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";
import { requireE2eEngine } from "../../apps/desktop/scripts/require-e2e-engine.mjs";
import { stagedEsbuildExecutable } from "../../apps/desktop/scripts/stage-plugin-tools.mjs";
import { git, pnpm, readJson, repoRoot, run } from "./process.mjs";
import { cancellationScope } from "./cancellation.mjs";

export const receiptPath = join(repoRoot, ".dohc-dev/verification/build.json");
export const enginePath = join(repoRoot, "target/debug", `dohc-workspace-engine${process.platform === "win32" ? ".exe" : ""}`);
const configFiles = {
  engine: [".cargo/config", ".cargo/config.toml"],
  desktop: [
    ".npmrc", ".pnpmfile.cjs", ".pnpmfile.mjs",
    // electron-vite builds all three targets in production mode from the desktop package.
    ...[".env", ".env.local", ".env.production", ".env.production.local"].map((name) => `apps/desktop/${name}`),
  ],
};
const inputPaths = {
  engine: ["crates", "fuzz", "fixtures", ".cargo", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "packages/ydoc-projection", "pnpm-lock.yaml", "scripts/verification", ".gitignore"],
  desktop: ["apps/desktop", "packages", "services", "scripts", "tools", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", ".gitignore", ...configFiles.desktop],
};
const environmentInputs = {
  engine: /^(CARGO_(BUILD_|PROFILE_|TARGET_|INCREMENTAL$|ENCODED_RUSTFLAGS$)|RUST(?:FLAGS|UP_TOOLCHAIN|C|C_WRAPPER|C_WORKSPACE_WRAPPER|DOC|DOCFLAGS)$|(?:CC|CXX|AR|CFLAGS|CXXFLAGS)(?:_|$))/,
  desktop: /^(VITE_|NODE_ENV$)/,
};

export function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function engineArtifactMatches(path, expectedHash) {
  try {
    accessSync(path, constants.X_OK);
    return hashFile(path) === expectedHash;
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return false;
    throw error;
  }
}

export function repairOwnedEngineExecutable(path) {
  if (process.platform === "win32") return;
  try { accessSync(path, constants.X_OK); return; }
  catch (error) { if (error.code !== "EACCES") throw error; }
  const artifact = lstatSync(path);
  if (!artifact.isFile() || artifact.uid !== process.getuid()) {
    throw new Error(`Cannot repair execute permission on an unowned engine artifact: ${path}`);
  }
  chmodSync(path, artifact.mode | 0o100);
  accessSync(path, constants.X_OK);
}

export function sourceFingerprint(kind, root = repoRoot) {
  const paths = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...inputPaths[kind]], root).split("\0").filter(Boolean);
  paths.push(...configFiles[kind]);
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version }));
  const environmentKeys = new Set();
  const environment = Object.keys(process.env).sort().flatMap((name) => {
    const key = process.platform === "win32" ? name.toUpperCase() : name;
    if (environmentKeys.has(key)) return [];
    environmentKeys.add(key);
    return [[key, process.env[name]]];
  }).filter(([key]) => environmentInputs[kind].test(key)).sort(([a], [b]) => a.localeCompare(b));
  hash.update(JSON.stringify(environment));
  if (kind === "engine") {
    hash.update(execFileSync("rustc", ["-vV"], { cwd: root, env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" } }));
    // Cargo discovers configuration from its working directory through the filesystem root.
    for (let directory = resolve(root); dirname(directory) !== directory;) {
      directory = dirname(directory);
      for (const name of ["config", "config.toml"]) {
        const path = join(directory, ".cargo", name);
        hash.update(path + "\0");
        hash.update(existsSync(path) ? readFileSync(path) : "<deleted>");
        hash.update("\0");
      }
    }
    const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
    for (const name of ["config", "config.toml"]) {
      const path = join(cargoHome, name);
      if (existsSync(path)) hash.update(readFileSync(path));
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
    if (kind === "desktop" && process.platform !== "win32") {
      for (const name of ["dohc", "dohc-mcp"]) accessSync(join(repoRoot, "apps/desktop/resources/cli-bin", name), constants.X_OK);
    }
    return receipt?.[kind]?.source === sourceFingerprint(kind)
      && (kind === "engine" ? engineArtifactMatches(enginePath, receipt[kind].artifact)
        : receipt[kind].artifact === artifactFingerprint(kind)
          && stagedEsbuildExecutable(join(repoRoot, "apps/desktop/resources/plugin-tools")));
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return false;
    throw error;
  }
}

export function assertPrepared() {
  const receipt = readJson(receiptPath);
  if (!preparedStatus("engine", receipt) || !preparedStatus("desktop", receipt)) {
    throw new Error("The desktop or engine does not match this checkout. Run pnpm qa:prepare before driving it.");
  }
  const staged = join(repoRoot, "apps/desktop/target/debug", enginePath.split(/[\\/]/).at(-1));
  if (!engineArtifactMatches(staged, receipt.engine.artifact)) {
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
  const slot = budget ? await acquireBuildSlot({ ...budget, cooperativeCancellation: true }) : null;
  const env = buildEnvironment(budget?.jobs);
  try { return await action(env); }
  finally { slot?.release(); }
}

export async function prepare({ engineOnly = false, output = join(repoRoot, ".dohc-dev/verification") } = {}) {
  mkdirSync(output, { recursive: true });
  mkdirSync(resolve(receiptPath, ".."), { recursive: true });
  const lock = receiptPath + ".lock";
  const cancellation = cancellationScope("Preparation");
  let failure;
  try {
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" }); }
  catch (error) { if (error.code === "EEXIST") throw new Error(`Another preparation owns ${lock}. Inspect its PID before removing a stale lock.`); throw error; }
  try {
  await cancellation.checkpoint();
  await run(...pnpm(["install", "--frozen-lockfile"]), { log: join(output, "prepare-install.log") });
  await cancellation.checkpoint();
  const receipt = readJson(receiptPath) ?? { version: 1 };
  for (const kind of engineOnly ? ["engine"] : ["engine", "desktop"]) {
    if (kind === "engine" && existsSync(enginePath)) repairOwnedEngineExecutable(enginePath);
    const prepared = preparedStatus(kind, receipt);
    await cancellation.checkpoint();
    if (prepared) { console.log(`[prepare] reuse ${kind} ${receipt[kind].artifact.slice(0, 12)}`); continue; }
    const source = sourceFingerprint(kind);
    await cancellation.checkpoint();
    if (kind === "engine") {
      await withBuildBudget(async (env) => {
        await cancellation.checkpoint();
        const result = await run("cargo", ["build", "--locked", "--target-dir", join(repoRoot, "target"), "--message-format=json-render-diagnostics", "-p", "dohc-workspace-engine", "--bin", "dohc-workspace-engine"], { env, log: join(output, "engine-build.log"), quietStdout: true });
        const artifacts = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
        const executable = artifacts.findLast((entry) => entry.reason === "compiler-artifact" && entry.target?.name === "dohc-workspace-engine" && entry.executable)?.executable;
        if (!executable || resolve(executable).toLowerCase() !== resolve(enginePath).toLowerCase()) throw new Error(`Cargo did not build the native engine at ${enginePath}. Check Cargo target configuration.`);
      });
      repairOwnedEngineExecutable(enginePath);
    } else {
      await run(...pnpm(["--filter", "@dohc/desktop", "build"]), { log: join(output, "desktop-build.log") });
    }
    if (sourceFingerprint(kind) !== source) throw new Error(`${kind} inputs changed during the build. Run preparation again.`);
    receipt[kind] = { source, artifact: artifactFingerprint(kind), commit: git(["rev-parse", "HEAD"]), builtAt: new Date().toISOString() };
    await cancellation.checkpoint();
    mkdirSync(resolve(receiptPath, ".."), { recursive: true });
    writeFileSync(receiptPath + ".tmp", JSON.stringify(receipt, null, 2) + "\n");
    renameSync(receiptPath + ".tmp", receiptPath);
  }
  requireE2eEngine({ override: enginePath });
  await cancellation.checkpoint();
  return receipt;
  } finally { unlinkSync(lock); }
  } catch (error) { failure = error; throw error; }
  finally {
    const interrupted = await cancellation.dispose();
    if (!failure && interrupted) throw interrupted;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  prepare({ engineOnly: process.argv.includes("--engine-only") }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
