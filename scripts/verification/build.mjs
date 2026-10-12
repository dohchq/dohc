import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, matchesGlob, relative, resolve } from "node:path";
import { acquireBuildSlot, capBuildParallelism, freeDiskGb, resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";
import { requireE2eEngine } from "../../apps/desktop/scripts/require-e2e-engine.mjs";
import { git, pnpm, readJson, repoRoot, run } from "./process.mjs";
import { cancellationScope } from "./cancellation.mjs";

export const receiptPath = join(repoRoot, ".dohc-dev/verification/build.json");
export const enginePath = join(repoRoot, "target/debug", `dohc-workspace-engine${process.platform === "win32" ? ".exe" : ""}`);
export const stagedEnginePath = join(repoRoot, "apps/desktop/target/debug", enginePath.split(/[\\/]/).at(-1));
const configFiles = {
  engine: [".cargo/config", ".cargo/config.toml"],
  desktop: [
    ".npmrc", ".pnpmfile.cjs", ".pnpmfile.mjs",
    // electron-vite builds all three targets in production mode from the desktop package.
    ...[".env", ".env.local", ".env.production", ".env.production.local"].map((name) => `apps/desktop/${name}`),
    ...[".env", ".env.local", ".env.production", ".env.production.local"].map((name) => `services/share-web/viewer/${name}`),
  ],
};
// Native tests include these shared fixtures. The daemon does not.
const nativeTestInputs = [
  "packages/excalidraw-scene/fixtures/canonical-json.json", "packages/live-session-contract/src/liveObjectBinding.vectors.json",
  "packages/live-session-contract/vectors/live-update-admission-vectors.json", "packages/security-contract/vectors/share-grant-vectors.json",
  "packages/workspace-contracts/src/relayValues.ts", "packages/workspace-fs/text-media-cases.json",
  "services/sync-relay/relay-error-codes.json", "tools/rust-engine-program/capture-fixtures.json", "tools/rust-engine-program/capture-goldens.json",
  "tools/rust-engine-program/ydoc-replay-fixtures.json", "tools/rust-engine-program/ydoc-replay-goldens.json",
];
// Receipts depend on the helpers that discover inputs and launch each build.
// process.mjs runs Windows commands through windows-command.mjs and windows-job.ps1.
const preparationInputs = [
  "scripts/verification/build.mjs", "scripts/verification/process.mjs", "scripts/verification/cancellation.mjs",
  "scripts/verification/windows-command.mjs", "scripts/verification/windows-job.ps1",
  "tools/rust-engine-program/git-read.mjs", "tools/rust-engine-program/build-slot.mjs",
  "apps/desktop/scripts/require-e2e-engine.mjs",
];
// Verification provenance: the production inputs plus tests, proofs, profiling
// and dependency patches. artifactSourceFingerprint selects what a build consumes.
const inputPaths = {
  engine: ["crates", "vendor", ".cargo", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "packages/ydoc-projection", "pnpm-lock.yaml", "scripts/verification", ".gitignore", ...preparationInputs, ...nativeTestInputs],
  desktop: ["apps/desktop", "packages", "services", "patches", "scripts", "tools", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", ".gitignore", ...configFiles.desktop],
};
const environmentInputs = {
  engine: /^(CARGO_(BUILD_|PROFILE_|TARGET_|INCREMENTAL$|ENCODED_RUSTFLAGS$)|RUST(?:FLAGS|UP_TOOLCHAIN|C|C_WRAPPER|C_WORKSPACE_WRAPPER|DOC|DOCFLAGS)$|(?:CC|CXX|AR|CFLAGS|CXXFLAGS)(?:_|$))/,
  desktop: /^(VITE_|NODE_ENV$|NODE_OPTIONS$|ESBUILD_BINARY_PATH$|DOHC_(?:POSTHOG_KEY|POSTHOG_HOST|SENTRY_DSN|SENTRY_DIST)$)/,
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

export function sourceFingerprint(kind, root = repoRoot, selectedPaths, contents = new Map()) {
  const paths = selectedPaths ?? git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...inputPaths[kind]], root).split("\0").filter(Boolean);
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
  for (const [name, value] of environment) {
    if (!/^(?:ESBUILD_BINARY_PATH|RUSTC(?:_WRAPPER|_WORKSPACE_WRAPPER)?|(?:CC|CXX|AR)(?:_[\w]+)?)$/u.test(name) || !value) continue;
    const paths = [resolve(root, value), ...(process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")
      .flatMap(directory => (process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""])
        .map(extension => join(directory, value + extension)))];
    const executable = paths.find(path => existsSync(path) && statSync(path).isFile());
    if (executable) { hash.update(name + "\0" + executable + "\0"); hash.update(readFileSync(executable)); }
  }
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
    try { hash.update(contents.get(path) ?? readFileSync(absolute)); }
    catch (error) { if (error.code !== "ENOENT") throw error; hash.update("<deleted>"); }
    hash.update("\0");
  }
  return hash.digest("hex");
}

const testInput = path => /(?:^|\/)(?:tests|__tests__|testing|e2e)\/|\.(?:test|spec|testSupport|fixture|integration-helper)\.[^/]+$|[Tt]estFixture\.[^/]+$/u.test(path);

export function artifactSourceFingerprint(kind, root = repoRoot) {
  const files = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root).split("\0").filter(Boolean);
  const contents = new Map();
  const read = path => {
    if (!contents.has(path)) contents.set(path, readFileSync(join(root, path)));
    return contents.get(path);
  };
  const manifests = files.filter(path => path.endsWith("/package.json"));
  const packages = manifests.flatMap(path => {
    if (!existsSync(join(root, path))) return [];
    const manifest = JSON.parse(read(path).toString("utf8"));
    return manifest.name ? [{path: dirname(path).replaceAll("\\", "/"), manifest}] : [];
  });
  const owners = new Set(kind === "engine" ? ["crates", "vendor", ".cargo"] : kind === "runtime"
    ? ["packages/app-backend-runtime"] : ["apps/desktop", "services/share-web"]);
  const pending = kind === "runtime" ? ["@dohc/app-backend-runtime"] : ["@dohc/desktop", "@dohc/share-web"];
  const visited = new Set();
  const buildScripts = new Set(["scripts/verification/build.mjs"]);
  if (kind !== "engine") while (pending.length) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    const pkg = packages.find(pkg => pkg.manifest.name === name);
    if (!pkg) continue;
    owners.add(pkg.path);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, version] of Object.entries(pkg.manifest[field] ?? {})) {
        if (packages.some(pkg => pkg.manifest.name === name)) pending.push(name);
        else if (version.startsWith("workspace:")) throw new Error(`Missing build dependency: ${name}`);
      }
    }
    for (const [name, command] of Object.entries(pkg.manifest.scripts ?? {})) if (/^build(?::|$)/u.test(name)) {
      for (const match of command.matchAll(/(?:^|\s)([^\s]+\.(?:[cm]?js|ts))(?=\s|$)/gu)) {
        buildScripts.add(relative(root, resolve(root, pkg.path, match[1])).replaceAll("\\", "/"));
      }
    }
  }
  const shared = path => !path.includes("/") && !/\.md$/iu.test(path)
    || /^(?:patches|\.cargo)\//u.test(path)
    || /^scripts\/(?!verification\/)/u.test(path) && !testInput(path)
    || preparationInputs.includes(path);
  const inOwner = path => [...owners].some(owner => path.startsWith(owner + "/"));
  // Tailwind scans the Vite renderer root even when a file is not bundled.
  const selected = new Set(files.filter(path => shared(path) || inOwner(path) && (!testInput(path)
    || kind === "desktop" && path.startsWith("apps/desktop/src/renderer/"))));
  // Receipts depend on the helpers that discover inputs and launch each build.
  for (const path of preparationInputs) selected.add(path);
  // A test-named file can still be a production import or build resource.
  // Retain references from source, including build-script globs, before excluding it.
  const references = new Map();
  const directories = new Map();
  for (const candidate of files) {
    references.set(candidate, [candidate]);
    for (let key = dirname(candidate).replaceAll("\\", "/"); key !== "."; key = dirname(key).replaceAll("\\", "/")) {
      if (!directories.has(key)) directories.set(key, []);
      directories.get(key).push(candidate);
    }
    for (const key of [candidate.replace(/\.[^/.]+$/u, ""), candidate.replace(/\.tsx?$/u, ".js")]) {
      if (!references.has(key)) references.set(key, []);
      references.get(key).push(candidate);
    }
  }
  const names = new Set([...references.keys(), ...directories.keys()].map(path => basename(path)));
  for (const path of selected) {
    if (!/\.(?:[cm]?[jt]sx?|rs|css)$/u.test(path) || !existsSync(join(root, path))) continue;
    if (/^(?:scripts\/verification|tools\/rust-engine-program)\//u.test(path)) continue;
    if (/(?:^|\/)scripts\//u.test(path) && !buildScripts.has(path)) continue;
    const text = read(path).toString("utf8");
    const owner = [...owners].filter(owner => path.startsWith(owner + "/")).sort((a, b) => b.length - a.length)[0];
    for (const match of text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\r\n])*?)\1/gu)) {
      const value = match[2].split("${", 1)[0];
      if (!value || value === "." || value === ".." || value.length > 512 || /\s/u.test(value)) continue;
      const cssSource = path.endsWith(".css") && /@source\s+(?:not\s+)?$/u.test(text.slice(Math.max(0, match.index - 100), match.index));
      if (!buildScripts.has(path) && !value.includes("/") && !value.includes("\\") && !/\.[\w]+$/u.test(value)) continue;
      const glob = /[?*[{]/u.test(value);
      if (glob && !buildScripts.has(path) && !cssSource
        && !/import\.meta\.glob\s*\(\s*$/u.test(text.slice(Math.max(0, match.index - 100), match.index))) continue;
      if (!glob && !names.has(basename(value.replace(/\/$/u, "")))) continue;
      for (const base of [dirname(path), owner, ""].filter(base => base !== undefined)) {
        const target = relative(root, resolve(root, base, value)).replaceAll("\\", "/");
        const resourceDirectory = cssSource || match[2].includes("${") || /(?:^|\/)(?:tests|__tests__|e2e)(?:\/|$)/u.test(value)
          || /\b(?:cp|readdir(?:Sync)?|glob(?:Sync)?)\s*\([^;\n]{0,200}$/u.test(text.slice(Math.max(0, match.index - 200), match.index));
        const globPrefix = target.split(/[?*[{]/u, 1)[0];
        const referenced = references.get(target) ?? references.get(target + "/index")
          ?? directories.get(target)?.filter(candidate => resourceDirectory || !testInput(candidate))
          ?? (glob ? files.filter(candidate => candidate.startsWith(globPrefix) && matchesGlob(candidate, target)) : []);
        for (const candidate of referenced) {
          if (references.has(target) && /(?:^|\/)scripts\//u.test(candidate) && !buildScripts.has(candidate)) {
            buildScripts.add(candidate);
            selected.delete(candidate);
          }
          selected.add(candidate);
        }
      }
    }
  }
  // Runtime bundles use the desktop's Node/esbuild environment, not Cargo.
  return sourceFingerprint(kind === "runtime" ? "desktop" : kind, root, [...selected], contents);
}

export function directoryFingerprint(path) {
  if (!lstatSync(path).isDirectory()) throw new Error(`Unexpected build artifact directory: ${path}`);
  const hash = createHash("sha256");
  function visit(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) visit(join(directory, entry.name), name + "/");
      else if (entry.isFile()) { hash.update(name + "\0"); hash.update(readFileSync(join(directory, entry.name))); }
      else throw new Error(`Unexpected build artifact: ${join(directory, entry.name)}`);
    }
  }
  visit(path);
  return hash.digest("hex");
}

// The Windows x64 probe owner and relay run on the compiler's pinned Node, so both trees are desktop artifacts.
export function artifactFingerprint(kind, root = repoRoot, platform = process.platform, arch = process.arch) {
  if (kind === "engine") return hashFile(enginePath);
  return createHash("sha256").update(JSON.stringify([
    "apps/desktop/dist", "apps/desktop/resources/cli-bin", "apps/desktop/resources/app-backend-runtime", "services/share-web/viewer/dist",
    ...(platform === "win32" && arch === "x64" ? ["apps/desktop/resources/app-compiler", "apps/desktop/resources/agent-probe"] : []),
  ].map((path) => [path, directoryFingerprint(join(root, path))]))).digest("hex");
}

// A receipt is reusable while the inputs its build consumed are unchanged.
// Its `source` is the full provenance a proof records; `production` decides reuse.
export function preparedStatus(kind, receipt = readJson(receiptPath), engineBinary = enginePath, production = artifactSourceFingerprint(kind)) {
  try {
    if (kind === "desktop" && process.platform !== "win32") {
      for (const name of ["dohc", "dohc-mcp"]) accessSync(join(repoRoot, "apps/desktop/resources/cli-bin", name), constants.X_OK);
    }
    return receipt?.[kind]?.production === production
      && (kind === "engine" ? engineArtifactMatches(engineBinary, receipt[kind].artifact)
        : receipt[kind].artifact === artifactFingerprint(kind));
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return false;
    throw error;
  }
}

export function assertPrepared({ engineOnly = false, engineBinary = process.env.DOHC_TEST_ENGINE_BINARY?.trim() || enginePath } = {}) {
  const receipt = readJson(receiptPath);
  if (!preparedStatus("engine", receipt, engineBinary) || !engineOnly && !preparedStatus("desktop", receipt)) {
    throw new Error("The desktop or engine does not match this checkout. Run pnpm qa:prepare before driving it.");
  }
  if (engineOnly) return { version: receipt.version, engine: receipt.engine };
  if (!engineArtifactMatches(stagedEnginePath, receipt.engine.artifact)) {
    throw new Error("The staged engine differs from the prepared engine. Run pnpm qa:prepare.");
  }
  return receipt;
}

export function assertIndependentStagedEngine() {
  const built = statSync(enginePath, {bigint: true});
  const staged = statSync(stagedEnginePath, {bigint: true});
  if (built.dev === staged.dev && built.ino === staged.ino) {
    throw new Error("Parallel verification requires an independent staged engine copy, not a link to the Cargo output.");
  }
}

export function buildEnvironment(maxJobs, source = process.env) {
  const env = maxJobs ? capBuildParallelism(source, maxJobs) : { ...source };
  for (const name of Object.keys(env)) {
    if (["CARGO_BUILD_TARGET", "CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR", "CARGO_BUILD_BUILD_DIR"].includes(name.toUpperCase())) delete env[name];
  }
  for (const name of ["CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR", "CARGO_BUILD_BUILD_DIR"]) env[name] = join(repoRoot, "target");
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

export async function prepare({ engineOnly = false, output = join(repoRoot, ".dohc-dev/verification"), install = true } = {}) {
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
  if (install) await run(...pnpm(["install", "--frozen-lockfile"]), { log: join(output, "prepare-install.log") });
  await cancellation.checkpoint();
  const receipt = readJson(receiptPath) ?? { version: 1 };
  const kinds = engineOnly ? ["engine"] : ["engine", "desktop"];
  const pending = [], start = {};
  for (const kind of kinds) {
    if (kind === "engine" && existsSync(enginePath)) repairOwnedEngineExecutable(enginePath);
    start[kind] = { source: sourceFingerprint(kind), production: artifactSourceFingerprint(kind) };
    const prepared = preparedStatus(kind, receipt, enginePath, start[kind].production);
    await cancellation.checkpoint();
    if (prepared) { console.log(`[prepare] reuse ${kind} ${receipt[kind].artifact.slice(0, 12)}`); continue; }
    pending.push({kind, ...start[kind], commit: git(["rev-parse", "HEAD"])});
  }
  // A build records its source and production inputs only if both held from
  // start to finish.
  const changed = (kind) => sourceFingerprint(kind) !== start[kind].source
    || artifactSourceFingerprint(kind) !== start[kind].production;
  async function prepareKind({kind, source, production, commit}, env) {
    await cancellation.checkpoint();
    if (kind === "engine") {
      const result = await run("cargo", ["build", "--locked", "--target-dir", join(repoRoot, "target"), "--message-format=json-render-diagnostics", "-p", "dohc-workspace-engine", "--bin", "dohc-workspace-engine"], { env, log: join(output, "engine-build.log"), quietStdout: true });
      const artifacts = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
      const executable = artifacts.findLast((entry) => entry.reason === "compiler-artifact" && entry.target?.name === "dohc-workspace-engine" && entry.executable)?.executable;
      if (!executable || resolve(executable).toLowerCase() !== resolve(enginePath).toLowerCase()) throw new Error(`Cargo did not build the native engine at ${enginePath}. Check Cargo target configuration.`);
      repairOwnedEngineExecutable(enginePath);
    } else {
      await run(...pnpm(["--filter", "@dohc/desktop", "build"]), { log: join(output, "desktop-build.log") });
      await run(...pnpm(["--filter", "@dohc/share-web", "build"]), { log: join(output, "share-web-build.log") });
    }
    if (changed(kind)) throw new Error(`${kind} inputs changed during the build. Run preparation again.`);
    receipt[kind] = { source, production, artifact: artifactFingerprint(kind), commit, builtAt: new Date().toISOString() };
    await cancellation.checkpoint();
    mkdirSync(resolve(receiptPath, ".."), { recursive: true });
    writeFileSync(receiptPath + ".tmp", JSON.stringify(receipt, null, 2) + "\n");
    renameSync(receiptPath + ".tmp", receiptPath);
  }
  async function buildPending(env) {
    const results = await Promise.allSettled(pending.map(item => prepareKind(item, env)));
    const rejected = results.find(result => result.status === "rejected");
    if (rejected) throw rejected.reason;
  }
  if (pending.some(({kind}) => kind === "engine")) await withBuildBudget(buildPending);
  else await buildPending();
  // A completed or reused build can become stale while its sibling is still running.
  for (const kind of kinds) {
    if (changed(kind)) throw new Error(`${kind} inputs changed during preparation. Run preparation again.`);
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
