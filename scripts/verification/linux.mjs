// Rust on Linux. On the shared Windows host, a PR run that selects Rust also runs the gate's
// clippy command in the host's WSL distro, so a change that breaks only the Linux build fails
// before merge. A full run, such as the nightly, runs the whole Rust job there, tests included.
// A full Rust job on every PR would take as long as the Windows one, one at a time for every lane.
// `verification-linux` beside the build slots names the distro. Without it, nothing runs on Linux.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireBuildSlot, acquireLinuxSlot, freeDiskGb, resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";
import { clippy } from "../../tools/rust-engine-program/gate-commands.mjs";
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
const scopeMaxGb = 11;
const scopeMemory = `-p MemoryHigh=${scopeMaxGb - 2}G -p MemoryMax=${scopeMaxGb}G -p OOMPolicy=continue`;
// The queue distrusts a check that failed after Windows free memory fell below this.
const hostFloorGb = 3;

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

/**
 * Prints the commits the Linux checkout keeps, then `head` and `base` if it has them, then the VM's page cache in kB.
 * Creates the checkout on first use.
 */
export const tipsScript = ({ head, base }) => `set -euo pipefail
repo="${home}/linux"
mkdir -p "$repo"
[ -d "$repo/.git" ] || git init -q "$repo"
cd "$repo"
git for-each-ref --format='tip %(objectname)' refs/dohc/
for commit in ${quote(head)} ${quote(base)}; do git cat-file -e "$commit^{commit}" 2>/dev/null && echo "has $commit"; done
awk '$1 == "Cached:" {print "cached", $2}' /proc/meminfo
`;

/** What the tips script found: the checkout's commits, whether it has `head` and `base`, and the VM's page cache in GB. */
export function parseTips(stdout) {
  const lines = stdout.split(/\r?\n/u).map(line => line.trim().split(" "));
  const sha = value => /^[0-9a-f]{40}$/u.test(value ?? "");
  const cached = Number(lines.find(([kind]) => kind === "cached")?.[1]);
  return { tips: lines.filter(([kind, value]) => kind === "tip" && sha(value)).map(([, value]) => value),
    has: new Set(lines.filter(([kind, value]) => kind === "has" && sha(value)).map(([, value]) => value)),
    cachedGb: Number.isFinite(cached) ? cached / 1024 ** 2 : 0 };
}

/**
 * The Windows free memory the Linux job needs before it builds. The VM already holds its page cache,
 * so the job grows the VM only by what its limit exceeds that cache. The host keeps the queue's floor beside it.
 */
export const neededMemoryGb = cachedGb => hostFloorGb + Math.max(0, scopeMaxGb - cachedGb);

/**
 * Stops any earlier run's processes, then puts the checkout at `head`, fetching the bundle's `missing` commits first.
 * With `install`, it installs dependencies, as the queue prepares a Windows lane: the verifier reads them before its own install.
 * Only one run holds the Linux slot, so every scope with the prefix belongs to a run that is gone.
 */
export function syncScript({ bundle, ref, missing, head, base, install }) {
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
${install ? "pnpm install --frozen-lockfile --config.confirm-modules-purge=false" : ""}
`;
}

/**
 * Runs the job in a user scope: with `full`, the verifier's Rust job; otherwise the gate's clippy command.
 * A watchdog in the scope stops it when the launcher ends, so a run whose Windows side was killed leaves nothing behind.
 * Afterwards the scope's peak memory and out-of-memory kills go to `scope.json`.
 */
export function runScript({ unit, base, grant, output, jobs, full }) {
  const verify = `launcher=$$
setsid bash -c "while kill -0 $launcher 2>/dev/null; do sleep 5; done; systemctl --user stop ${unit}.scope" </dev/null >/dev/null 2>&1 &
${full ? `node scripts/verification/verify.mjs pr --base ${base} --job rust` : `cargo ${clippy.join(" ")}`}
status=$?
cgroup=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)
peak=$(cat "$cgroup/memory.peak" 2>/dev/null || true)
kills=$(awk '$1 == "oom_kill" {print $2}' "$cgroup/memory.events" 2>/dev/null || true)
printf '{"memoryPeak":%s,"oomKills":%s}\\n' "\${peak:-null}" "\${kills:-null}" > "$DOHC_VERIFICATION_OUTPUT/scope.json"
exit $status`;
  return `set -euo pipefail
cd "${home}/linux"
export TMPDIR="${home}/tmp" CARGO_BUILD_JOBS=${jobs} RUST_TEST_THREADS=${jobs} NEXTEST_TEST_THREADS=${jobs} CARGO_INCREMENTAL=0 RUSTUP_AUTO_INSTALL=0
export DOHC_VERIFICATION_GRANT=${quote(JSON.stringify(grant))} DOHC_VERIFICATION_OUTPUT=${quote(output)}
exec systemd-run --user --scope --quiet --collect --unit=${unit} -p RuntimeMaxSec=${scopeLimitSeconds} ${scopeMemory} bash -c ${quote(verify)}
`;
}

/**
 * Check `head` against `base` in `distro`: with `full`, the whole Rust job; otherwise the gate's clippy command,
 * which builds every target. Returns a receipt, the Linux verifier's when `full`, and the scope's memory use.
 * `output` is a Windows folder for its evidence. A failure of the host, of the transfer, or one after an
 * out-of-memory kill carries `environment`, so the queue retries it instead of failing the change.
 */
export async function linuxRustJob({ distro, head, base, output, full = false, signal, request = "inline", attempt = null, command = run, gitRead = git, budget = resolveBuildBudget(),
  freeMemoryGb = () => freemem() / 1024 ** 3, memoryPollMs = 30_000 }) {
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
  const metadata = { purpose: full ? "Linux Rust gate" : "Linux clippy", checkout: repoRoot, commit: head, phase: request };
  const slot = await acquireLinuxSlot({ root: budget.root, metadata, signal }).catch(environment("linux slot"));
  let cargo;
  try {
    // Refs left by a run killed before its cleanup. None belongs to a live run, because this one holds the slot.
    for (const stale of gitRead(["for-each-ref", "--format=%(refname)", "refs/verification-linux/"]).split(/\r?\n/u).filter(Boolean)) gitRead(["update-ref", "-d", stale]);
    const { tips, has, cachedGb } = parseTips((await wsl("tips", tipsScript({ head, base }), { quietStdout: true }).catch(environment("linux host"))).stdout);
    const missing = ["head", "base"].filter(name => !has.has(name === "head" ? head : base));
    const bundle = missing.length ? join(output, "sync.bundle") : null;
    try {
      if (bundle) {
        for (const name of missing) gitRead(["update-ref", `${ref}/${name}`, name === "head" ? head : base]);
        const known = tips.length ? gitRead(["rev-list", "--no-walk", "--ignore-missing", ...tips]).split(/\s+/u).filter(Boolean) : [];
        await command("git", ["bundle", "create", bundle, ...missing.map(name => `${ref}/${name}`), ...known.map(sha => `^${sha}`)],
          { log: join(output, "wsl-bundle.log"), signal, quietStdout: true }).catch(environment("linux sync"));
      }
      await wsl("sync", syncScript({ bundle: bundle && wslPath(bundle), ref, missing, head, base, install: full })).catch(environment("linux sync"));
    } finally {
      for (const name of missing) try { gitRead(["update-ref", "-d", `${ref}/${name}`]); } catch { /* Not created. */ }
      if (bundle) rmSync(bundle, { force: true });
    }
    // The Linux build counts against the host's memory, disk floor, and cargo lanes, like a build in another lane.
    const needed = neededMemoryGb(cachedGb);
    if (freeMemoryGb() < needed) console.log(`[verification] The Linux job waits for ${needed.toFixed(1)} GB of free memory; ${freeMemoryGb().toFixed(1)} GB is free.`);
    while (freeMemoryGb() < needed) await sleep(memoryPollMs, undefined, { signal }).catch(error => { throw signal?.aborted ? signal.reason : error; });
    const free = freeDiskGb(repoRoot);
    if (free === null || free < budget.diskFloorGb) throw Object.assign(new Error(`The Linux build needs ${budget.diskFloorGb} GB free; observed ${free ?? "unknown"}.`), { environment: "disk space" });
    cargo = await acquireBuildSlot({ ...budget, cooperativeCancellation: true, signal, metadata }).catch(environment("linux slot"));
    const grant = { request, attempt, head, base };
    const failure = await wsl("run", runScript({ unit, base, grant, output: wslPath(output), jobs: budget.jobs, full })).then(() => null, error => error);
    if (failure && (signal?.aborted || failure.interrupted)) throw failure;
    // The scope writes this after its command, so without it the command never ran.
    const scope = readJson(join(output, "scope.json"));
    if (!scope) environment("linux host")(failure ?? new Error("The Linux scope recorded nothing."));
    let receipt;
    if (full) {
      receipt = readJson(join(output, "result.json"));
      if (!receipt?.final) environment("linux host")(failure ?? new Error("The Linux verifier wrote no final receipt."));
      if (receipt.failure?.kind === "environment") environment(`linux ${receipt.failure.cause}`)(new Error(receipt.error ?? "The Linux host failed."));
      if (receipt.commit !== head) environment("linux host")(new Error(`The Linux verifier checked ${receipt.commit ?? "no commit"}, not ${head}.`));
    } else {
      // cargo exits 101 on a build error or warning. 126 and 127, or wsl.exe's own failure, mean the shell could not run it.
      if (failure && !(failure.exitCode >= 1 && failure.exitCode <= 125)) environment("linux host")(failure);
      receipt = { version: 1, mode: "clippy", final: true, commit: head, verdict: failure ? "FAIL" : "PASS",
        ...(failure ? { error: `cargo clippy failed on Linux. Read ${join(output, "wsl-run.log")}.` } : {}), failed: [], flaky: [] };
      writeFileSync(join(output, "result.json"), JSON.stringify(receipt, null, 2) + "\n");
    }
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
