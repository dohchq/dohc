// Rust on Linux. On the shared Windows host, a PR run that selects Rust also runs the gate's
// clippy command in the host's WSL distro, so a change that breaks only the Linux build fails
// before merge, then the app compiler owner's tests, which only Linux runs. A full run, such as the
// nightly, runs the whole Rust job there, tests included.
// A full Rust job on every PR would take as long as the Windows one, one at a time for every lane.
// `verification-linux` beside the build slots names the distro. Without it, nothing runs on Linux.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import { join, win32 } from "node:path";
import { acquireBuildSlot, acquireLinuxSlot, freeDiskGb, resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";
import { clippy } from "../../tools/rust-engine-program/gate-commands.mjs";
import { nextestFailures, nextestFlaky, readLog } from "./flaky.mjs";
import { git, readJson, repoRoot, run } from "./process.mjs";

// The app compiler owner's Landlock and seccomp rules and its /proc process table compile only on Linux,
// so the Windows and Mac gates never run their tests.
const linuxTests = ["nextest", "run", "--locked", "--package", "dohc-compiler-owner"];

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
// The queue fails an attempt that passes its two-hour limit, so the job stops waiting for its slots
// and memory in time to finish inside it, as a machine failure the queue retries. Until the attempt's
// own Windows jobs end, about 45 minutes in, or 60 in a full run, they hold a cargo lane and memory, so the
// wait outlasts them. A full run's Linux job then takes about 45 minutes; clippy takes a few.
const admissionMs = full => (full ? 55 : 75) * 60_000;

/** The WSL distro this host verifies Linux in, or null. */
export function linuxDistro(env = process.env, platform = process.platform) {
  const ci = env.CI && !["false", "0"].includes(env.CI.toLowerCase());
  if (platform !== "win32" || ci) return null;
  const root = resolveBuildBudget(env)?.root;
  if (!root) return null;
  const path = join(root, "verification-linux");
  let name;
  try { name = readFileSync(path, "utf8").trim(); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!/^[\w.-]+$/u.test(name)) throw new Error(`${path} must name one WSL distro.`);
  return name;
}

/** A Windows path as WSL mounts it, read as a Windows path on any host. */
export function wslPath(path) {
  const [, drive, rest] = win32.resolve(path).match(/^([A-Za-z]):[\\/](.*)$/u) ?? [];
  if (!drive) throw new Error(`${path} is not on a Windows drive.`);
  return `/mnt/${drive.toLowerCase()}/${rest.replaceAll("\\", "/")}`;
}

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// The curl errors cargo retries as spurious: a proxy or host it could not resolve or reach, a timeout, a failed
// send or receive, an HTTP/2 or TLS connection error, or a partial file (`maybe_spurious` in cargo's `src/cargo/util/network/retry.rs`).
const spuriousCurlErrors = new Set([5, 6, 7, 16, 18, 28, 35, 55, 56, 92]);

/**
 * Whether cargo's last error is a download that failed for a reason cargo retries: one of those curl errors, a server error
 * or rate limit, or a transfer too slow. Once its retries run out, cargo ends with that error. A missing crate, a certificate,
 * or a lockfile that needs an update ends with another one, even after a retry that worked.
 */
export function networkFailed(log) {
  const lines = log.split(/\r?\n/u);
  const last = lines.findLastIndex(line => line.startsWith("error:"));
  return last !== -1 && lines.slice(last).some(line => spuriousCurlErrors.has(Number(/^(?:error:)?\s*\[(\d+)\] /u.exec(line)?.[1]))
    || /^(?:error:)?\s*failed to get successful HTTP response from .*, got (?:5\d\d|429)$/u.test(line) || /transfer too slow: /u.test(line));
}

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

/** What a script reported: the checkout's commits, whether it has `head` and `base`, and the VM's page cache in GB. */
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
 * Stops any earlier run's scope and refuses to go on while one still runs. Only one run holds the Linux slot,
 * so every scope with the prefix belongs to a run that is gone. Then puts the checkout at `head`, fetching the
 * bundle's `missing` commits first, and prints the VM's page cache in kB.
 */
export function syncScript({ bundle, ref, missing, head, base }) {
  const fetch = missing.map(name => quote(`+${ref}/${name}:refs/dohc/${name === "head" ? head : base}`));
  return `set -euo pipefail
systemctl --user stop ${quote(`${scopePrefix}*.scope`)} 2>/dev/null || true
if systemctl --user list-units --no-legend --plain --state=active,activating,deactivating ${quote(`${scopePrefix}*.scope`)} | grep -q .; then
  echo "An earlier Linux job's scope is still running." >&2
  exit 1
fi
cd "${home}/linux"
${bundle ? `git fetch -q --no-tags ${quote(bundle)} ${fetch.join(" ")}` : ""}
git for-each-ref --sort=-creatordate --format='%(refname)' refs/dohc/ | { grep -v -e ${quote(head)} -e ${quote(base)} || true; } | tail -n +${keptCommits - 1} | xargs -r -n 1 git update-ref -d
git checkout -q --force --detach ${quote(head)}
git clean -q -ffdx --exclude=node_modules --exclude=target
test "$(git rev-parse HEAD)" = ${quote(head)}
git cat-file -e ${quote(`${base}^{commit}`)}
test -z "$(git status --porcelain)"
awk '$1 == "Cached:" {print "cached", $2}' /proc/meminfo
`;
}

/**
 * Runs the job in a user scope. It first downloads every crate the lockfile names, for every platform, because a full run's
 * cargo-deny reads them all. Then, with `full`, it installs dependencies,
 * as the queue prepares a Windows lane, and runs the verifier's Rust job; otherwise it runs the gate's clippy command,
 * then the compiler owner's tests.
 * A watchdog in the scope stops it when the launcher ends, so a run whose Windows side was killed leaves nothing behind.
 * Afterwards the scope's peak memory, out-of-memory kills, and whether the download worked go to `scope.json`.
 */
export function runScript({ unit, base, grant, output, jobs, full }) {
  const verify = `launcher=$$
setsid bash -c "while kill -0 $launcher 2>/dev/null; do sleep 5; done; systemctl --user stop ${unit}.scope" </dev/null >/dev/null 2>&1 &
if cargo fetch --locked; then
  fetched=true
  ${full ? `pnpm install --frozen-lockfile --config.confirm-modules-purge=false && node scripts/verification/verify.mjs pr --base ${base} --job rust` : `cargo ${clippy.join(" ")} && cargo ${linuxTests.join(" ")}`}
  status=$?
else
  status=$?
  fetched=false
fi
cgroup=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)
peak=$(cat "$cgroup/memory.peak" 2>/dev/null || true)
kills=$(awk '$1 == "oom_kill" {print $2}' "$cgroup/memory.events" 2>/dev/null || true)
printf '{"memoryPeak":%s,"oomKills":%s,"fetched":%s}\\n' "\${peak:-null}" "\${kills:-null}" "$fetched" > "$DOHC_VERIFICATION_OUTPUT/scope.json"
exit $status`;
  return `set -euo pipefail
cd "${home}/linux"
export CARGO_BUILD_JOBS=${jobs} RUST_TEST_THREADS=${jobs} NEXTEST_TEST_THREADS=${jobs} CARGO_INCREMENTAL=0 RUSTUP_AUTO_INSTALL=0
export DOHC_VERIFICATION_GRANT=${quote(JSON.stringify(grant))} DOHC_VERIFICATION_OUTPUT=${quote(output)}
exec systemd-run --user --scope --quiet --collect --unit=${unit} -p RuntimeMaxSec=${scopeLimitSeconds} ${scopeMemory} bash -c ${quote(verify)}
`;
}

/** Stops the scope and confirms it is gone, killing what the stop leaves. Exits nonzero while it may still run. */
export const stopScript = unit => `systemctl --user stop ${unit}.scope 2>/dev/null || true
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  state=$(systemctl --user show -p ActiveState --value ${unit}.scope 2>/dev/null) || state=unknown
  case "$state" in inactive|failed) exit 0 ;; esac
  systemctl --user kill --signal=SIGKILL ${unit}.scope 2>/dev/null || true
  sleep 1
done
echo "${unit}.scope is still $state." >&2
exit 1
`;

/**
 * Check `head` against `base` in `distro`: with `full`, the whole Rust job; otherwise the gate's clippy command,
 * which builds every target, then the compiler owner's tests. Returns a receipt, the Linux verifier's when `full`
 * and the crates downloaded, and the scope's memory use.
 * `output` is a Windows folder for its evidence.
 * A check's failure comes back as a FAIL receipt. Everything thrown is a stop, which keeps its reason,
 * or a machine failure, which carries `environment` so the queue retries it instead of failing the change.
 */
export async function linuxRustJob({ distro, head, base, output, full = false, signal, request = "inline", attempt = null, command = run, gitRead = git,
  budget = resolveBuildBudget(), freeMemoryGb = () => freemem() / 1024 ** 3, waitMs = admissionMs(full) }) {
  const environment = cause => error => {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error?.interrupted) throw error;
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { environment: error?.environment ?? cause });
  };
  const wsl = (name, script, options = {}) => {
    const path = join(output, `wsl-${name}.sh`);
    writeFileSync(path, script);
    return command("wsl.exe", ["-d", distro, "--exec", "bash", "-l", wslPath(path)], { log: join(output, `wsl-${name}.log`), signal, ...options });
  };
  const admitBy = Date.now() + waitMs;
  const remaining = () => Math.max(1, admitBy - Date.now());
  const run = randomUUID().slice(0, 8);
  const unit = `${scopePrefix}${run}`;
  const ref = `refs/verification-linux/${run}`;
  const metadata = { purpose: full ? "Linux Rust gate" : "Linux PR checks", checkout: repoRoot, commit: head, phase: request };
  try { mkdirSync(output, { recursive: true }); } catch (error) { environment("linux host")(error); }
  const slot = await acquireLinuxSlot({ root: budget.root, metadata, signal, waitMs: remaining() }).catch(environment("linux slot"));
  let cargo;
  let result;
  let failure;
  try {
    // Refs left by a run killed before its cleanup. None belongs to a live run, because this one holds the slot.
    for (const stale of gitRead(["for-each-ref", "--format=%(refname)", "refs/verification-linux/"]).split(/\r?\n/u).filter(Boolean)) gitRead(["update-ref", "-d", stale]);
    const { tips, has } = parseTips((await wsl("tips", tipsScript({ head, base }), { quietStdout: true }).catch(environment("linux host"))).stdout);
    const missing = ["head", "base"].filter(name => !has.has(name === "head" ? head : base));
    const bundle = missing.length ? join(output, "sync.bundle") : null;
    let synced;
    try {
      if (bundle) {
        for (const name of missing) gitRead(["update-ref", `${ref}/${name}`, name === "head" ? head : base]);
        const known = tips.length ? gitRead(["rev-list", "--no-walk", "--ignore-missing", ...tips]).split(/\s+/u).filter(Boolean) : [];
        await command("git", ["bundle", "create", bundle, ...missing.map(name => `${ref}/${name}`), ...known.map(sha => `^${sha}`)],
          { log: join(output, "wsl-bundle.log"), signal, quietStdout: true }).catch(environment("linux sync"));
      }
      synced = await wsl("sync", syncScript({ bundle: bundle && wslPath(bundle), ref, missing, head, base })).catch(environment("linux sync"));
    } finally {
      for (const name of missing) try { gitRead(["update-ref", "-d", `${ref}/${name}`]); } catch { /* Not created. */ }
      if (bundle) rmSync(bundle, { force: true });
    }
    // The Linux build counts against the host's memory, cargo lanes, and disk floor, like a build in another lane.
    const needed = neededMemoryGb(parseTips(synced.stdout).cachedGb);
    // The cargo lane waits while memory is short, so the job starts only on memory measured at its admission.
    // A wait for a lane restarts its own limit after a hold, so the hold ends the whole wait at the deadline.
    const hold = () => {
      if (Date.now() >= admitBy) throw Object.assign(new Error(`The Linux job waited ${Math.round(waitMs / 60_000)} minutes for a cargo lane and ${needed.toFixed(1)} GB of free memory.`), { environment: "linux admission" });
      const available = freeMemoryGb();
      return available >= needed ? null : `The Linux job waits for ${needed.toFixed(1)} GB of free memory; ${available.toFixed(1)} GB is free.`;
    };
    cargo = await acquireBuildSlot({ ...budget, cooperativeCancellation: true, signal, metadata, waitMs: remaining(), hold }).catch(environment("linux slot"));
    // Measured after the wait, which other builds can spend.
    const free = freeDiskGb(repoRoot);
    if (free === null || free < budget.diskFloorGb) throw Object.assign(new Error(`The Linux build needs ${budget.diskFloorGb} GB free; observed ${free ?? "unknown"}.`), { environment: "disk space" });
    const grant = { request, attempt, head, base };
    const exit = await wsl("run", runScript({ unit, base, grant, output: wslPath(output), jobs: budget.jobs, full })).then(() => null, error => error);
    if (exit && (signal?.aborted || exit.interrupted)) throw exit;
    // The scope writes this after its command, so without it the command never ran.
    const scope = readJson(join(output, "scope.json"));
    if (!scope) throw exit ?? new Error("The Linux scope recorded nothing.");
    const log = join(output, "wsl-run.log");
    const text = readLog(log);
    // Any other failed fetch, such as one whose lockfile needs an update, fails the change.
    if (scope.fetched === false && networkFailed(text)) throw Object.assign(new Error(`The Linux job could not download its crates. Read ${log}.`), { environment: "linux network" });
    let receipt;
    if (full && scope.fetched !== false) {
      receipt = readJson(join(output, "result.json"));
      if (!receipt?.final) throw exit ?? new Error("The Linux verifier wrote no final receipt.");
      if (receipt.failure?.kind === "environment") throw Object.assign(new Error(receipt.error ?? "The Linux host failed."), { environment: `linux ${receipt.failure.cause}` });
      if (receipt.commit !== head || receipt.baseCommit !== base) throw new Error(`The Linux verifier checked ${receipt.commit ?? "no commit"} against ${receipt.baseCommit ?? "no base"}, not ${head} against ${base}.`);
    } else {
      // cargo exits 101 on a build error or warning, and nextest 100 on a failed test. 126 and 127, or wsl.exe's own
      // failure, mean the shell could not run it.
      if (exit && !(exit.exitCode >= 1 && exit.exitCode <= 125)) throw exit;
      const tests = names => names(text).map(test => ({ step: "rust", test }));
      const checks = scope.fetched === false ? "cargo fetch" : "cargo clippy or the compiler owner's tests";
      receipt = { version: 1, mode: full ? "gate" : "pr", final: true, commit: head, baseCommit: base, verdict: exit ? "FAIL" : "PASS",
        ...(exit ? { error: `${checks} failed. Read ${log}.` } : {}), failed: tests(nextestFailures), flaky: tests(nextestFlaky) };
      writeFileSync(join(output, "result.json"), JSON.stringify(receipt, null, 2) + "\n");
    }
    // A compiler or test killed at the run's memory limit says nothing about the change.
    if (receipt.verdict !== "PASS" && scope.oomKills > 0) throw Object.assign(new Error(`The Linux job failed after ${scope.oomKills} out-of-memory kills at its limit.`), { environment: "linux memory" });
    result = { receipt, scope };
  } catch (error) { failure = error; }
  // The scope stops before the slots go, so no other build starts beside its last processes.
  // This runs after a stop too, and it ignores the stop's signal.
  let stopped = true;
  try { await wsl("stop", stopScript(unit), { signal: undefined, quietStdout: true, timeoutMs: 3 * 60_000 }); }
  catch (error) { stopped = false; console.log(`[verification] ${unit}.scope may still run: ${error.message}`); }
  if (stopped) { cargo?.release(); slot.release(); }
  // A scope that may still run keeps its slots as a holder that died keeps them: they free only after their grace,
  // 30 minutes for a cargo lane, once this verifier is gone. The next Linux job will not start beside the scope.
  else { cargo?.abandon(); slot.abandon(); }
  // Only a stop or the host reaches the catch: a check's failure is a receipt.
  if (failure) environment("linux host")(failure);
  if (!stopped) environment("linux cleanup")(new Error(`${unit}.scope did not stop. Its processes may still run.`));
  return result;
}
