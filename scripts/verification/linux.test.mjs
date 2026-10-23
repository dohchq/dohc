// Rust on Linux, with WSL, Git, and the Linux verifier replaced by recorded fakes.
// Slots are real, in a private root, so a test never holds the host's.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linuxDistro, linuxRustJob, neededMemoryGb, networkFailed, parseTips, runScript, stopScript, syncScript, wslPath } from "./linux.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const known = "c".repeat(40);
// The job maps its paths onto WSL's drive mounts, so it runs only from a Windows host.
const windowsOnly = { skip: process.platform !== "win32" && "the Linux job runs from a Windows host" };

test("the host names its distro beside the build slots, and only a Windows host outside CI does", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-linux-setting-"));
  try {
    const env = { DOHC_BUILD_SLOT_ROOT: root };
    assert.equal(linuxDistro(env, "win32"), null);
    writeFileSync(join(root, "verification-linux"), "Ubuntu-24.04\n");
    assert.equal(linuxDistro(env, "win32"), "Ubuntu-24.04");
    assert.equal(linuxDistro(env, "linux"), null);
    assert.equal(linuxDistro({ CI: "true" }, "win32"), null);
    assert.equal(linuxDistro({ ...env, CI: "true" }, "win32"), null);
    assert.equal(linuxDistro({ ...env, CI: "false" }, "win32"), "Ubuntu-24.04");
    writeFileSync(join(root, "verification-linux"), "Ubuntu; rm -rf ~\n");
    assert.throws(() => linuxDistro(env, "win32"), /must name one WSL distro/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows paths map to WSL's mounts", () => {
  assert.equal(wslPath(String.raw`C:\w\_verification\requests\1\attempts\2\rust-linux`), "/mnt/c/w/_verification/requests/1/attempts/2/rust-linux");
  assert.equal(wslPath("D:/x y/z"), "/mnt/d/x y/z");
});

test("a script's report names kept commits, the ones it already has, and the VM's page cache", () => {
  assert.deepEqual(parseTips(`tip ${known}\ntip not-a-sha\nhas ${base}\n\nwarning: noise\n`), { tips: [known], has: new Set([base]), cachedGb: 0 });
  assert.equal(parseTips("cached 10485760\n").cachedGb, 10);
});

test("the job needs only the memory its limit exceeds the VM's page cache, above the queue's floor", () => {
  assert.equal(neededMemoryGb(0), 14);
  assert.equal(neededMemoryGb(4), 10);
  assert.equal(neededMemoryGb(12), 3);
});

test("a sync refuses a leftover scope, fetches only missing commits, prunes none of the run's own, and reports the page cache", () => {
  const script = syncScript({ bundle: "/mnt/c/o/sync.bundle", ref: "refs/verification-linux/r1", missing: ["head"], head, base });
  assert.match(script, /systemctl --user stop 'dohc-verification-linux-\*\.scope' 2>\/dev\/null \|\| true\nif systemctl --user list-units [^\n]*--state=active,activating,deactivating 'dohc-verification-linux-\*\.scope' \| grep -q \.; then\n[^\n]*\n {2}exit 1\nfi\n/);
  assert.match(script, new RegExp(`git fetch -q --no-tags '/mnt/c/o/sync.bundle' '\\+refs/verification-linux/r1/head:refs/dohc/${head}'\n`));
  assert.match(script, new RegExp(`grep -v -e '${head}' -e '${base}' \\|\\| true`));
  assert.match(script, /\nawk '\$1 == "Cached:" \{print "cached", \$2\}' \/proc\/meminfo\n$/);
  assert.doesNotMatch(script, /pnpm install/);
  assert.doesNotMatch(syncScript({ bundle: null, ref: "refs/verification-linux/r1", missing: [], head, base }), /git fetch/);
});

test("the run script downloads the crates first, then runs clippy and the compiler owner's tests for a PR and installs then verifies for a full run, quotes the grant, and limits memory and time", () => {
  const grant = { request: "it's", attempt: 1, head, base };
  const script = full => runScript({ unit: "dohc-verification-linux-r1", base, grant, output: "/mnt/c/o", jobs: 8, full });
  assert.match(script(true), /DOHC_VERIFICATION_GRANT='\{"request":"it'\\''s"/);
  assert.match(script(true), /CARGO_BUILD_JOBS=8 RUST_TEST_THREADS=8 NEXTEST_TEST_THREADS=8 CARGO_INCREMENTAL=0 RUSTUP_AUTO_INSTALL=0/);
  assert.match(script(true), /--unit=dohc-verification-linux-r1 -p RuntimeMaxSec=7200 -p MemoryHigh=9G -p MemoryMax=11G -p OOMPolicy=continue/);
  for (const full of [true, false]) {
    assert.match(script(full), /\nif cargo fetch --locked; then\n {2}fetched=true\n/);
    assert.match(script(full), /,"fetched":%s\}/);
  }
  assert.match(script(true), new RegExp(`\n  pnpm install --frozen-lockfile --config\\.confirm-modules-purge=false && node scripts/verification/verify\\.mjs pr --base ${base} --job rust\n`));
  assert.match(script(false), /\n {2}cargo clippy --locked --workspace --all-targets --all-features -- -D warnings && cargo nextest run --locked --package dohc-compiler-owner\n/);
  assert.doesNotMatch(script(false), /verify\.mjs|pnpm/);
  // Tests bind Unix sockets under the temp folder, whose paths must stay under SUN_LEN, so the job keeps /tmp.
  assert.doesNotMatch(script(true), /TMPDIR/);
});

/**
 * Run the job against fakes. `verify` stands in for the scope's command: it writes the Linux
 * verifier's receipt and the scope's record, or throws for the command's failure.
 */
async function job({ tips = `tip ${known}\n`, synced = "", verify, full = true, signal, gitRefs = [], gitFails, freeMemory = () => 64, waitMs, stopFails, onStop, diskFloorGb = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dohc-linux-job-"));
  const output = join(root, "output");
  const budget = { root: join(root, "slots"), slots: 4, jobs: 2, diskFloorGb };
  const calls = [];
  const gitCalls = [];
  const refs = new Set(gitRefs);
  const gitRead = args => {
    gitCalls.push(args);
    if (gitFails?.(args)) throw new Error(`git ${args[0]} failed`);
    if (args[0] === "for-each-ref") return [...refs].join("\n");
    if (args[0] === "update-ref") { if (args[1] === "-d") refs.delete(args[2]); else refs.add(args[1]); return ""; }
    if (args[0] === "rev-list") return args.slice(3).filter(sha => sha === known).join("\n");
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  let cargoHeldAtStop = null;
  const command = async (executable, args, options) => {
    calls.push({ executable, args, options });
    if (executable === "git") return { stdout: "" };
    const script = args.at(-1);
    if (script.endsWith("wsl-tips.sh")) return { stdout: tips };
    if (script.endsWith("wsl-sync.sh")) return { stdout: synced };
    if (script.endsWith("wsl-run.sh")) { await verify?.(output); return { stdout: "" }; }
    if (script.endsWith("wsl-stop.sh")) {
      cargoHeldAtStop = readdirSync(budget.root).some(name => /^build-slot-\d$/u.test(name));
      onStop?.();
      if (stopFails) throw Object.assign(new Error("wsl.exe failed (1)."), { exitCode: 1 });
    }
    return { stdout: "" };
  };
  try {
    const result = await linuxRustJob({ distro: "Ubuntu", head, base, output, full, signal, command, gitRead, budget, freeMemoryGb: freeMemory, ...(waitMs ? { waitMs } : {}) })
      .then(({ receipt, scope }) => ({ receipt, scope }), error => ({ error }));
    const written = readJson(join(output, "result.json"));
    const scripts = Object.fromEntries(["sync", "run", "stop"].map(name => [name, existsSync(join(output, `wsl-${name}.sh`)) ? readFileSync(join(output, `wsl-${name}.sh`), "utf8") : null]));
    const slotsLeft = readdirSync(budget.root).filter(name => /-slot-\d$/u.test(name));
    return { ...result, written, calls, gitCalls, refs, scripts, cargoHeldAtStop, slotsLeft };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

const quiet = { memoryPeak: 1, oomKills: 0, fetched: true };
/** The scope's command as it ends: an optional receipt and log, the scope's record, then an optional failure. */
const ends = ({ receipt, log, scope = quiet, exitCode } = {}) => output => {
  if (receipt) writeFileSync(join(output, "result.json"), JSON.stringify(receipt));
  if (log) writeFileSync(join(output, "wsl-run.log"), log);
  if (scope) writeFileSync(join(output, "scope.json"), JSON.stringify(scope));
  if (exitCode !== undefined) throw Object.assign(new Error(`wsl.exe failed (${exitCode}).`), { exitCode, commandExitFailure: true });
};
const passed = { final: true, commit: head, baseCommit: base, verdict: "PASS" };
const stopReason = () => Object.assign(new Error("Stopped after rust failed."), { stopped: true });

test("a run bundles the missing commits, verifies in WSL, and stops its scope before it frees its slots", windowsOnly, async () => {
  const result = await job({ verify: ends({ receipt: passed }), gitRefs: ["refs/verification-linux/old/head"] });
  assert.deepEqual(result.receipt, passed);
  assert.deepEqual(result.scope, quiet);
  const bundle = result.calls.find(call => call.executable === "git");
  assert.deepEqual(bundle.args.slice(0, 2), ["bundle", "create"]);
  assert.match(bundle.args[2], /sync\.bundle$/);
  assert.deepEqual(bundle.args.slice(3).map(arg => arg.replace(/linux\/\w+\//u, "linux/<run>/")), ["refs/verification-linux/<run>/head", "refs/verification-linux/<run>/base", `^${known}`]);
  // The stale ref and the run's own refs are gone afterwards.
  assert.equal(result.refs.size, 0);
  const wsl = result.calls.filter(call => call.executable === "wsl.exe").map(call => call.args.at(-1).split("/").at(-1));
  assert.deepEqual(wsl, ["wsl-tips.sh", "wsl-sync.sh", "wsl-run.sh", "wsl-stop.sh"]);
  assert.deepEqual(result.calls.at(-1).args.slice(0, 5), ["-d", "Ubuntu", "--exec", "bash", "-l"]);
  // The stop ignores the run's signal, so it runs after a stop too.
  assert.equal(result.calls.at(-1).options.signal, undefined);
  const unit = result.scripts.run.match(/--unit=(dohc-verification-linux-\w+)/u)[1];
  assert.equal(result.scripts.stop, stopScript(unit));
  assert.equal(result.cargoHeldAtStop, true);
  assert.deepEqual(result.slotsLeft, []);
});

test("the stop script stops the scope, kills what remains, and succeeds only once the scope is inactive or failed", () => {
  const script = stopScript("dohc-verification-linux-r1");
  assert.match(script, /^systemctl --user stop dohc-verification-linux-r1\.scope 2>\/dev\/null \|\| true\n/);
  assert.match(script, /systemctl --user show -p ActiveState --value dohc-verification-linux-r1\.scope/);
  assert.match(script, /case "\$state" in inactive\|failed\) exit 0 ;; esac\n {2}systemctl --user kill --signal=SIGKILL dohc-verification-linux-r1\.scope/);
  assert.match(script, /\nexit 1\n$/);
});

test("a scope that would not stop keeps both slots and fails the run as the host's, unless the run was stopped", windowsOnly, async () => {
  const kept = await job({ verify: ends({ receipt: passed }), stopFails: true });
  assert.equal(kept.error.environment, "linux cleanup");
  assert.match(kept.error.message, /did not stop/);
  assert.deepEqual(kept.slotsLeft.map(name => name.replace(/\d$/u, "N")).sort(), ["build-slot-N", "linux-slot-N"]);
  const stop = new AbortController();
  const verify = () => { stop.abort(stopReason()); throw Object.assign(new Error("wsl.exe failed (interrupted)."), { interrupted: true }); };
  const stopped = await job({ verify, signal: stop.signal, stopFails: true });
  assert.equal(stopped.error.stopped, true);
  // A run that passed, then was stopped while its scope would not stop, keeps the stop too.
  const late = new AbortController();
  const stoppedInCleanup = await job({ verify: ends({ receipt: passed }), signal: late.signal, stopFails: true, onStop: () => late.abort(stopReason()) });
  assert.equal(stoppedInCleanup.error.stopped, true);
});

test("an output folder that cannot be made is the host's failure, before any slot", windowsOnly, async () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-linux-output-"));
  try {
    writeFileSync(join(root, "file"), "");
    const budget = { root, slots: 4, jobs: 2, diskFloorGb: 0 };
    const error = await linuxRustJob({ distro: "Ubuntu", head, base, output: join(root, "file", "output"), command: async () => ({ stdout: "" }), gitRead: () => "", budget }).catch(error => error);
    assert.equal(error.environment, "linux host");
    assert.deepEqual(readdirSync(root), ["file"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the disk floor is checked after the cargo lane's wait, and a short disk runs nothing", windowsOnly, async () => {
  const result = await job({ verify: ends({ receipt: passed }), diskFloorGb: 1e9 });
  assert.equal(result.error.environment, "disk space");
  assert.equal(result.calls.some(call => call.args.at(-1).endsWith("wsl-run.sh")), false);
  assert.equal(result.cargoHeldAtStop, true);
  assert.deepEqual(result.slotsLeft, []);
});

test("a checkout that has both commits gets no bundle", windowsOnly, async () => {
  const result = await job({ tips: `has ${head}\nhas ${base}\n`, verify: ends({ receipt: passed }) });
  assert.equal(result.calls.filter(call => call.executable === "git").length, 0);
  assert.equal(result.gitCalls.filter(args => args[0] === "update-ref").length, 0);
});

test("a PR's clippy and compiler owner's tests pass or fail the change by cargo's exit, and its own receipt names the failed and flaky tests", windowsOnly, async () => {
  const pass = await job({ full: false, verify: ends() });
  assert.deepEqual(pass.receipt, { version: 1, mode: "pr", final: true, commit: head, baseCommit: base, verdict: "PASS", failed: [], flaky: [] });
  assert.deepEqual(pass.written, pass.receipt);
  assert.match(pass.scripts.run, /\n {2}cargo clippy .* && cargo nextest run /);
  const fail = await job({ full: false, verify: ends({ exitCode: 101 }) });
  assert.equal(fail.error, undefined);
  assert.equal(fail.receipt.verdict, "FAIL");
  assert.match(fail.receipt.error, /cargo clippy or the compiler owner's tests failed/);
  assert.deepEqual(fail.receipt.failed, []);
  const rules = "dohc-compiler-owner::bin/dohc-compiler-owner sys::linux::tests::the_rules_keep_a_confined_child_to_its_build";
  const reaper = "dohc-compiler-owner::bin/dohc-compiler-owner sys::linux::tests::the_owner_reaps_an_exited_child_but_not_the_worker";
  const log = `        FAIL [   0.020s] (1/13) ${rules}\n     Summary [  12.345s] 13 tests run: 12 passed (1 flaky), 1 failed, 0 skipped\n`
    + `       FLAKY 2/2 [   0.010s] ${reaper}\n        FAIL [   0.020s] ${rules}\nerror: test run failed\n`;
  const tests = await job({ full: false, verify: ends({ log, exitCode: 100 }) });
  assert.equal(tests.receipt.verdict, "FAIL");
  assert.deepEqual(tests.receipt.failed, [{ step: "rust", test: rules }]);
  assert.deepEqual(tests.receipt.flaky, [{ step: "rust", test: reaper }]);
  assert.deepEqual(tests.written, tests.receipt);
  for (const exitCode of [127, 4294967295]) assert.equal((await job({ full: false, verify: ends({ exitCode }) })).error.environment, "linux host");
});

test("a failed check comes back as the receipt; anything the scope or verifier did not finish is the host's failure", windowsOnly, async () => {
  const failed = { ...passed, verdict: "FAIL", failure: { kind: "check", cause: "rust" } };
  assert.deepEqual((await job({ verify: ends({ receipt: failed, exitCode: 1 }) })).receipt, failed);
  const selection = await job({ verify: ends({ receipt: { final: true, verdict: "FAIL", error: "Cannot find module 'js-yaml'", failure: { kind: "environment", cause: "selection" } }, exitCode: 1 }) });
  assert.equal(selection.error.environment, "linux selection");
  assert.match(selection.error.message, /js-yaml/);
  for (const [full, verify] of [[true, ends()], [true, ends({ receipt: { ...passed, final: false } })], [true, ends({ receipt: { ...passed, commit: base } })],
    [true, ends({ receipt: { ...passed, baseCommit: known } })],
    // systemd-run could not start the scope, so neither the command nor the scope's record ran.
    [true, ends({ receipt: passed, scope: null })], [false, ends({ scope: null, exitCode: 1 })]]) {
    const { error, calls, slotsLeft } = await job({ full, verify });
    assert.equal(error.environment, "linux host");
    assert.match(calls.at(-1).args.at(-1), /wsl-stop\.sh$/);
    assert.deepEqual(slotsLeft, []);
  }
});

// cargo's output in request 481, and for a lockfile that needs an update, with the pinned toolchain.
const resolveHost = "[6] Could not resolve hostname (Could not resolve host: static.crates.io)";
const offline = [3, 2, 1].map(left => `warning: spurious network error (${left} ${left === 1 ? "try" : "tries"} remaining): ${resolveHost}\n`).join("")
  + `error: failed to download from \`https://static.crates.io/crates/rustls-webpki/0.103.16/download\`\n\nCaused by:\n  ${resolveHost}\n`;
const stale = "    Updating crates.io index\nerror: cannot update the lock file /home/ice/.dohc-verification/linux/Cargo.lock because --locked was passed to prevent this\n"
  + "help: to generate the lock file without accessing the network, remove the --locked flag and use --offline instead.\n";

test("cargo's last error decides a network failure: one cargo retries, not the warnings before it", () => {
  assert.equal(networkFailed(offline), true);
  const causedBy = cause => `error: failed to get \`itoa\` as a dependency of package \`probe v0.1.0\`\n\nCaused by:\n  ${cause}\n`;
  const warned = cause => `warning: spurious network error (1 try remaining): ${cause}\n`;
  // The last try can fail differently from the ones before it.
  const timeout = "[28] Timeout was reached (Operation timed out after 30001 milliseconds with 0 bytes received)";
  assert.equal(networkFailed(warned(resolveHost) + causedBy(timeout)), true);
  const http = (code, ip = "18.65.3.12") => `failed to get successful HTTP response from \`https://index.crates.io/config.json\` (${ip}), got ${code}`;
  assert.equal(networkFailed(`${warned(http(503))}body:\n\nerror: ${http(503, "18.65.3.71")}\nbody:\n`), true);
  assert.equal(networkFailed(causedBy(http(429))), true);
  assert.equal(networkFailed(causedBy("transfer too slow: failed to transfer more than 10 bytes in 30s (transferred 0 bytes)")), true);
  // A retry that worked, then a missing crate or the lockfile.
  assert.equal(networkFailed(warned(http(503)) + causedBy(http(404))), false);
  assert.equal(networkFailed(warned(resolveHost) + stale), false);
  assert.equal(networkFailed(stale), false);
  assert.equal(networkFailed(causedBy("[60] SSL peer certificate or SSH remote key was not OK (SSL certificate problem: unable to get local issuer certificate)")), false);
  assert.equal(networkFailed(""), false);
});

test("a fetch cargo gave up on after network errors is the host's failure in either mode; any other failed fetch fails the change", windowsOnly, async () => {
  const unfetched = { ...quiet, fetched: false };
  const recovered = `warning: spurious network error (3 tries remaining): ${resolveHost}\n${stale}`;
  for (const full of [true, false]) {
    const network = await job({ full, verify: ends({ log: offline, scope: unfetched, exitCode: 101 }) });
    assert.equal(network.error.environment, "linux network");
    assert.match(network.error.message, /could not download its crates/);
    assert.equal(network.written, null);
    assert.match(network.calls.at(-1).args.at(-1), /wsl-stop\.sh$/);
    assert.deepEqual(network.slotsLeft, []);
    for (const log of [stale, recovered]) {
      const change = await job({ full, verify: ends({ log, scope: unfetched, exitCode: 101 }) });
      assert.equal(change.error, undefined);
      assert.equal(change.receipt.mode, full ? "gate" : "pr");
      assert.equal(change.receipt.verdict, "FAIL");
      assert.match(change.receipt.error, /^cargo fetch failed/);
      assert.deepEqual(change.written, change.receipt);
    }
  }
});

test("a host error outside any command is the host's failure, and the run's refs still go", windowsOnly, async () => {
  const result = await job({ gitFails: args => args[0] === "rev-list", verify: ends({ receipt: passed }) });
  assert.equal(result.error.environment, "linux host");
  assert.match(result.error.message, /git rev-list failed/);
  assert.equal(result.refs.size, 0);
  assert.deepEqual(result.slotsLeft, []);
});

test("a failure after an out-of-memory kill is the host's; a pass after one stands", windowsOnly, async () => {
  const kills = { memoryPeak: 11811160064, oomKills: 2 };
  const afterKill = await job({ verify: ends({ receipt: { ...passed, verdict: "FAIL", failure: { kind: "check", cause: "rust" } }, scope: kills, exitCode: 1 }) });
  assert.equal(afterKill.error.environment, "linux memory");
  assert.match(afterKill.error.message, /2 out-of-memory kills/);
  assert.equal((await job({ full: false, verify: ends({ scope: kills, exitCode: 101 }) })).error.environment, "linux memory");
  const passedAfterKill = await job({ verify: ends({ receipt: passed, scope: kills }) });
  assert.equal(passedAfterKill.receipt.verdict, "PASS");
  assert.deepEqual(passedAfterKill.scope, kills);
});

test("an unreachable WSL is the host's failure and holds no slot afterwards", windowsOnly, async () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-linux-host-"));
  try {
    const budget = { root, slots: 4, jobs: 2, diskFloorGb: 0 };
    const command = async (executable, args) => { if (args.at(-1).endsWith("wsl-tips.sh")) throw new Error("wsl.exe failed (-1)"); return { stdout: "" }; };
    const error = await linuxRustJob({ distro: "Ubuntu", head, base, output: join(root, "output"), command, gitRead: () => "", budget, freeMemoryGb: () => 64 }).catch(error => error);
    assert.equal(error.environment, "linux host");
    assert.equal(existsSync(join(root, "linux-slot-1")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a stopped run keeps the stop, not a host failure, and still stops its scope", windowsOnly, async () => {
  const stop = new AbortController();
  const verify = () => { stop.abort(stopReason()); throw Object.assign(new Error("wsl.exe failed (interrupted)."), { interrupted: true }); };
  const { error, calls } = await job({ verify, signal: stop.signal });
  assert.equal(error.stopped, true);
  assert.equal(error.environment, undefined);
  assert.match(calls.at(-1).args.at(-1), /wsl-stop\.sh$/);
});

test("the job waits for memory at its cargo lane, gives up at its deadline, and a stop ends the wait with the stop's reason", windowsOnly, async () => {
  const frees = [2, 2, 20];
  const waited = await job({ verify: ends({ receipt: passed }), synced: "cached 0\n", freeMemory: () => frees.length > 1 ? frees.shift() : frees[0] });
  assert.equal(waited.receipt.verdict, "PASS");
  assert.equal(frees.length, 1);
  // With 12 GB of page cache the job needs only the floor.
  assert.equal((await job({ verify: ends({ receipt: passed }), synced: "cached 12582912\n", freeMemory: () => 4 })).receipt.verdict, "PASS");
  const short = await job({ synced: "cached 0\n", freeMemory: () => 1, waitMs: 300 });
  assert.equal(short.error.environment, "linux admission");
  assert.deepEqual(short.slotsLeft, []);
  // The stop arrives during the memory wait: the hold's first look at memory sends it.
  const stop = new AbortController();
  let looked = false;
  const { error, calls } = await job({ synced: "cached 0\n", signal: stop.signal, freeMemory: () => { looked = true; stop.abort(stopReason()); return 1; } });
  assert.equal(looked, true);
  assert.equal(error.stopped, true);
  assert.equal(calls.some(call => call.args.at(-1).endsWith("wsl-run.sh")), false);
});

test("a stop while the job waits for the Linux slot keeps the stop's reason", windowsOnly, async () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-linux-wait-"));
  try {
    const budget = { root, slots: 4, jobs: 2, diskFloorGb: 0 };
    mkdirSync(join(root, "linux-slot-1"));
    writeFileSync(join(root, "linux-slot-1", "owner.json"), JSON.stringify({ pid: process.pid, start: new Date().toISOString() }));
    const stop = new AbortController();
    setTimeout(() => stop.abort(stopReason()), 50);
    const error = await linuxRustJob({ distro: "Ubuntu", head, base, output: join(root, "output"), signal: stop.signal, command: async () => ({ stdout: "" }), gitRead: () => "", budget }).catch(error => error);
    assert.equal(error.stopped, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the slot root keeps one Linux run at a time", windowsOnly, async () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-linux-turns-"));
  try {
    mkdirSync(join(root, "slots"), { recursive: true });
    const budget = { root: join(root, "slots"), slots: 4, jobs: 2, diskFloorGb: 0 };
    let active = 0;
    let most = 0;
    const command = async (executable, args) => {
      const script = args.at(-1);
      if (script.endsWith("wsl-run.sh")) {
        active += 1; most = Math.max(most, active);
        await new Promise(done => setTimeout(done, 200));
        writeFileSync(join(script.replace(/^\/mnt\/(\w)\//u, "$1:/").replace(/\/wsl-run\.sh$/u, ""), "scope.json"), JSON.stringify(quiet));
        active -= 1;
      }
      return { stdout: script.endsWith("wsl-tips.sh") ? `has ${head}\nhas ${base}\n` : "" };
    };
    const runs = [1, 2].map(n => linuxRustJob({ distro: "Ubuntu", head, base, output: join(root, `output-${n}`), command, gitRead: () => "", budget, freeMemoryGb: () => 64 }));
    for (const { receipt } of await Promise.all(runs)) assert.equal(receipt.verdict, "PASS");
    assert.equal(most, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
