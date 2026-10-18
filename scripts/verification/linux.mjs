// The Rust gate on Linux. On the shared Windows host, a PR run that selects Rust also runs
// it in the host's WSL distro, so a change that breaks only the Linux build or its tests
// fails before merge. `verification-linux` beside the build slots names the distro.
// Without it, nothing runs on Linux.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireBuildSlot, acquireLinuxSlot, freeDiskGb, resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";
import { git, readJson, repoRoot, run } from "./process.mjs";

// Runs take turns in one checkout, so the distro holds one build's output.
const home = "$HOME/.dohc-verification";
const scopePrefix = "dohc-verification-linux-";
// The checkout keeps refs to this many commits. A run's bundle leaves out what they reach.
const keptCommits = 40;
// The verifier's two-hour limit, so a scope whose watchdog failed still ends.
const scopeLimitSeconds = 2 * 60 * 60;
// Every WSL distro shares one VM, Docker's included, under the host's WSL memory limit.
// The run's own limit keeps an out-of-memory kill inside the run. The run continues after
// a kill, so its receipt and `scope.json` record what happened.
const scopeMemory = "-p MemoryHigh=9G -p MemoryMax=11G -p OOMPolicy=continue";

/** The WSL distro this host verifies Linux in, or null. */
export function linuxDistro(env = process.env, platform = process.platform) {
  if (platform !== "win32") return null;
  const root = resolveBuildBudget(env)?.root;
  if (!root) return null;
  const path = join(root, "verification-linux");
  let name;
  try { name = readFileSync(path, "utf8").trim(); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!/^[\w.-]+$/u.test(name)) throw new Error(`${path} must name one WSL distro.`);
  return name;
}

/** A Windows path as WSL mounts it. */
export function wslPath(path) {
  const [, drive, rest] = resolve(path).match(/^([A-Za-z]):[\\/](.*)$/u) ?? [];
  if (!drive) throw new Error(`${path} is not on a Windows drive.`);
  return `/mnt/${drive.toLowerCase()}/${rest.replaceAll("\\", "/")}`;
}

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

/** Prints the commits the Linux checkout keeps, then `head` and `base` if it has them. Creates the checkout on first use. */
export const tipsScript = ({ head, base }) => `set -euo pipefail
repo="${home}/linux"
mkdir -p "$repo"
[ -d "$repo/.git" ] || git init -q "$repo"
cd "$repo"
git for-each-ref --format='tip %(objectname)' refs/dohc/
for commit in ${quote(head)} ${quote(base)}; do git cat-file -e "$commit^{commit}" 2>/dev/null && echo "has $commit"; done
true
`;

/** What the tips script found: the checkout's commits, and whether it has `head` and `base`. */
export function parseTips(stdout) {
  const lines = stdout.split(/\r?\n/u).map(line => line.trim().split(" "));
  const sha = value => /^[0-9a-f]{40}$/u.test(value ?? "");
  return { tips: lines.filter(([kind, value]) => kind === "tip" && sha(value)).map(([, value]) => value),
    has: new Set(lines.filter(([kind, value]) => kind === "has" && sha(value)).map(([, value]) => value)) };
}

/**
 * Stops any earlier run's processes, then puts the checkout at `head`, fetching the bundle's `missing` commits first,
 * and installs its dependencies, as the queue prepares a Windows lane. The verifier reads them before its own install.
 * Only one run holds the Linux slot, so every scope with the prefix belongs to a run that is gone.
 */
export function syncScript({ bundle, ref, missing, head, base }) {
  const fetch = missing.map(name => quote(`+${ref}/${name}:refs/dohc/${name === "head" ? head : base}`));
  return `set -euo pipefail
systemctl --user stop ${quote(`${scopePrefix}*.scope`)} 2>/dev/null || true
rm -rf "${home}/tmp"
mkdir -p "${home}/tmp"
cd "${home}/linux"
${bundle ? `git fetch -q --no-tags ${quote(bundle)} ${fetch.join(" ")}` : ""}
git for-each-ref --sort=-creatordate --format='%(refname)' refs/dohc/ | { grep -v -e ${quote(head)} -e ${quote(base)} || true; } | tail -n +${keptCommits - 1} | xargs -r -n 1 git update-ref -d
git checkout -q --force --detach ${quote(head)}
git clean -q -ffdx --exclude=node_modules --exclude=target
test "$(git rev-parse HEAD)" = ${quote(head)}
git cat-file -e ${quote(`${base}^{commit}`)}
test -z "$(git status --porcelain)"
pnpm install --frozen-lockfile --config.confirm-modules-purge=false
`;
}

/**
 * Runs the verifier's Rust job in a user scope. A watchdog in the scope stops it when the
 * launcher ends, so a run whose Windows side was killed leaves nothing behind.
 * Afterwards the scope's peak memory and out-of-memory kills go to `scope.json`.
 */
export function runScript({ unit, base, grant, output, jobs }) {
  const verify = `launcher=$$
setsid bash -c "while kill -0 $launcher 2>/dev/null; do sleep 5; done; systemctl --user stop ${unit}.scope" </dev/null >/dev/null 2>&1 &
node scripts/verification/verify.mjs pr --base ${base} --job rust
status=$?
cgroup=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)
peak=$(cat "$cgroup/memory.peak" 2>/dev/null || true)
kills=$(awk '$1 == "oom_kill" {print $2}' "$cgroup/memory.events" 2>/dev/null || true)
printf '{"memoryPeak":%s,"oomKills":%s}\\n' "\${peak:-null}" "\${kills:-null}" > "$DOHC_VERIFICATION_OUTPUT/scope.json"
exit $status`;
  return `set -euo pipefail
cd "${home}/linux"
export TMPDIR="${home}/tmp" CARGO_BUILD_JOBS=${jobs} RUST_TEST_THREADS=${jobs} NEXTEST_TEST_THREADS=${jobs}
export DOHC_VERIFICATION_GRANT=${quote(JSON.stringify(grant))} DOHC_VERIFICATION_OUTPUT=${quote(output)}
exec systemd-run --user --scope --quiet --collect --unit=${unit} -p RuntimeMaxSec=${scopeLimitSeconds} ${scopeMemory} bash -c ${quote(verify)}
`;
}

/**
 * Run the Rust gate for `head` against `base` in `distro`. Returns the Linux verifier's receipt and the scope's memory use.
 * `output` is a Windows folder for its evidence. A failure of the host, of the transfer, or one after an
 * out-of-memory kill carries `environment`, so the queue retries it instead of failing the change.
 */
export async function linuxRustJob({ distro, head, base, output, signal, request = "inline", attempt = null, command = run, gitRead = git, budget = resolveBuildBudget() }) {
  const environment = cause => error => {
    if (signal?.aborted || error?.interrupted) throw error;
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { environment: cause });
  };
  const wsl = (name, script, options = {}) => {
    const path = join(output, `wsl-${name}.sh`);
    writeFileSync(path, script);
    return command("wsl.exe", ["-d", distro, "--exec", "bash", "-l", wslPath(path)], { log: join(output, `wsl-${name}.log`), signal, ...options });
  };
  mkdirSync(output, { recursive: true });
  const run = randomUUID().slice(0, 8);
  const unit = `${scopePrefix}${run}`;
  const ref = `refs/verification-linux/${run}`;
  const metadata = { purpose: "Linux Rust gate", checkout: repoRoot, commit: head, phase: request };
  const slot = await acquireLinuxSlot({ root: budget.root, metadata, signal }).catch(environment("linux slot"));
  let cargo;
  try {
    // Refs left by a run killed before its cleanup. None belongs to a live run, because this one holds the slot.
    for (const stale of gitRead(["for-each-ref", "--format=%(refname)", "refs/verification-linux/"]).split(/\r?\n/u).filter(Boolean)) gitRead(["update-ref", "-d", stale]);
    const { tips, has } = parseTips((await wsl("tips", tipsScript({ head, base }), { quietStdout: true }).catch(environment("linux host"))).stdout);
    const missing = ["head", "base"].filter(name => !has.has(name === "head" ? head : base));
    const bundle = missing.length ? join(output, "sync.bundle") : null;
    try {
      if (bundle) {
        for (const name of missing) gitRead(["update-ref", `${ref}/${name}`, name === "head" ? head : base]);
        const known = tips.length ? gitRead(["rev-list", "--no-walk", "--ignore-missing", ...tips]).split(/\s+/u).filter(Boolean) : [];
        await command("git", ["bundle", "create", bundle, ...missing.map(name => `${ref}/${name}`), ...known.map(sha => `^${sha}`)],
          { log: join(output, "wsl-bundle.log"), signal, quietStdout: true }).catch(environment("linux sync"));
      }
      await wsl("sync", syncScript({ bundle: bundle && wslPath(bundle), ref, missing, head, base })).catch(environment("linux sync"));
    } finally {
      for (const name of missing) try { gitRead(["update-ref", "-d", `${ref}/${name}`]); } catch { /* Not created. */ }
      if (bundle) rmSync(bundle, { force: true });
    }
    // The Linux build counts against the host's disk floor and cargo lanes, like a build in another lane.
    const free = freeDiskGb(repoRoot);
    if (free === null || free < budget.diskFloorGb) throw Object.assign(new Error(`The Linux build needs ${budget.diskFloorGb} GB free; observed ${free ?? "unknown"}.`), { environment: "disk space" });
    cargo = await acquireBuildSlot({ ...budget, cooperativeCancellation: true, signal, metadata }).catch(environment("linux slot"));
    const grant = { request, attempt, head, base };
    const failure = await wsl("run", runScript({ unit, base, grant, output: wslPath(output), jobs: budget.jobs })).then(() => null, error => error);
    if (failure && (signal?.aborted || failure.interrupted)) throw failure;
    const receipt = readJson(join(output, "result.json"));
    if (!receipt?.final) environment("linux host")(failure ?? new Error("The Linux verifier wrote no final receipt."));
    if (receipt.failure?.kind === "environment") environment(`linux ${receipt.failure.cause}`)(new Error(receipt.error ?? "The Linux host failed."));
    if (receipt.commit !== head) environment("linux host")(new Error(`The Linux verifier checked ${receipt.commit ?? "no commit"}, not ${head}.`));
    const scope = readJson(join(output, "scope.json"));
    // A compiler or test killed at the run's memory limit says nothing about the change.
    if (receipt.verdict !== "PASS" && scope?.oomKills > 0) environment("linux memory")(new Error(`The Linux job failed after ${scope.oomKills} out-of-memory kills at its limit.`));
    return { receipt, scope };
  } finally {
    cargo?.release();
    // Belt and braces with the scope's watchdog: nothing this run started outlives it.
    await command("wsl.exe", ["-d", distro, "--exec", "systemctl", "--user", "stop", `${unit}.scope`], { quietStdout: true, timeoutMs: 60_000 }).catch(() => {});
    slot.release();
  }
}
