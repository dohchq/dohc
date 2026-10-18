// The Linux Rust job, with WSL, Git, and the Linux verifier replaced by recorded fakes.
// Slots are real, in a private root, so a test never holds the host's.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linuxDistro, linuxRustJob, neededMemoryGb, parseTips, runScript, syncScript, wslPath } from "./linux.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const known = "c".repeat(40);
// The job maps its paths onto WSL's drive mounts, so it runs only from a Windows host.
const windowsOnly = { skip: process.platform !== "win32" && "the Linux job runs from a Windows host" };

test("the host names its distro beside the build slots, and only a Windows host does", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-linux-setting-"));
  try {
    const env = { DOHC_BUILD_SLOT_ROOT: root };
    assert.equal(linuxDistro(env, "win32"), null);
    writeFileSync(join(root, "verification-linux"), "Ubuntu-24.04\n");
    assert.equal(linuxDistro(env, "win32"), "Ubuntu-24.04");
    assert.equal(linuxDistro(env, "linux"), null);
    assert.equal(linuxDistro({ CI: "true" }, "win32"), null);
    writeFileSync(join(root, "verification-linux"), "Ubuntu; rm -rf ~\n");
    assert.throws(() => linuxDistro(env, "win32"), /must name one WSL distro/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows paths map to WSL's mounts", () => {
  assert.equal(wslPath(String.raw`C:\w\_verification\requests\1\attempts\2\rust-linux`), "/mnt/c/w/_verification/requests/1/attempts/2/rust-linux");
  assert.equal(wslPath("D:/x y/z"), "/mnt/d/x y/z");
});

test("the tips script's report names kept commits and the ones it already has", () => {
  assert.deepEqual(parseTips(`tip ${known}\ntip not-a-sha\nhas ${base}\n\nwarning: noise\n`), { tips: [known], has: new Set([base]), cachedGb: 0 });
});

test("a sync fetches only missing commits, and pruning never drops the run's own", () => {
  const script = syncScript({ bundle: "/mnt/c/o/sync.bundle", ref: "refs/verification-linux/r1", missing: ["head"], head, base });
  assert.match(script, new RegExp(`git fetch -q --no-tags '/mnt/c/o/sync.bundle' '\\+refs/verification-linux/r1/head:refs/dohc/${head}'\n`));
  assert.match(script, new RegExp(`grep -v -e '${head}' -e '${base}' \\|\\| true`));
  assert.match(script, /systemctl --user stop 'dohc-verification-linux-\*\.scope'/);
  assert.doesNotMatch(syncScript({ bundle: null, ref: "refs/verification-linux/r1", missing: [], head, base }), /git fetch/);
  assert.match(script, /\npnpm install --frozen-lockfile --config\.confirm-modules-purge=false\n$/);
});

test("the run script quotes the grant and limits the run's memory and time", () => {
  const grant = { request: "it's", attempt: 1, head, base };
  const script = runScript({ unit: "dohc-verification-linux-r1", base, grant, output: "/mnt/c/o", jobs: 8 });
  assert.match(script, /DOHC_VERIFICATION_GRANT='\{"request":"it'\\''s"/);
  assert.match(script, /CARGO_BUILD_JOBS=8 RUST_TEST_THREADS=8 NEXTEST_TEST_THREADS=8/);
  assert.match(script, /--unit=dohc-verification-linux-r1 -p RuntimeMaxSec=7200 -p MemoryHigh=9G -p MemoryMax=11G -p OOMPolicy=continue/);
  assert.match(script, new RegExp(`verify\\.mjs pr --base ${base} --job rust`));
});

/** Run the job against fakes. `verify` writes the Linux verifier's receipt, or throws for the run's failure. */
async function job({ tips = `tip ${known}\n`, verify, signal, gitRefs = [], freeMemory = () => 64 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dohc-linux-job-"));
  const output = join(root, "output");
  const calls = [];
  const gitCalls = [];
  const refs = new Set(gitRefs);
  const gitRead = args => {
    gitCalls.push(args);
    if (args[0] === "for-each-ref") return [...refs].join("\n");
    if (args[0] === "update-ref") { if (args[1] === "-d") refs.delete(args[2]); else refs.add(args[1]); return ""; }
    if (args[0] === "rev-list") return args.slice(3).filter(sha => sha === known).join("\n");
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const command = async (executable, args, options) => {
    calls.push({ executable, args, options });
    if (executable === "git") return { stdout: "" };
    const script = args.at(-1);
    if (script.endsWith("wsl-tips.sh")) return { stdout: tips };
    if (script.endsWith("wsl-run.sh")) { await verify?.(output); return { stdout: "" }; }
    return { stdout: "" };
  };
  try {
    const budget = { root: join(root, "slots"), slots: 4, jobs: 2, diskFloorGb: 0 };
    const result = await linuxRustJob({ distro: "Ubuntu", head, base, output, signal, command, gitRead, budget, freeMemoryGb: freeMemory, memoryPollMs: 5 }).then(({ receipt, scope }) => ({ receipt, scope }), error => ({ error }));
    return { ...result, calls, gitCalls, refs, slots: budget.root, scripts: name => readFileSync(join(output, `wsl-${name}.sh`), "utf8") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const writeReceipt = (receipt, scope) => output => {
  writeFileSync(join(output, "result.json"), JSON.stringify(receipt));
  if (scope) writeFileSync(join(output, "scope.json"), JSON.stringify(scope));
};

test("a run bundles the missing commits, verifies in WSL, and stops its scope", windowsOnly, async () => {
  const passed = { final: true, commit: head, verdict: "PASS" };
  const result = await job({ verify: writeReceipt(passed), gitRefs: ["refs/verification-linux/old/head"] });
  assert.deepEqual(result.receipt, passed);
  const bundle = result.calls.find(call => call.executable === "git");
  assert.deepEqual(bundle.args.slice(0, 2), ["bundle", "create"]);
  assert.match(bundle.args[2], /sync\.bundle$/);
  assert.deepEqual(bundle.args.slice(3).map(arg => arg.replace(/linux\/\w+\//u, "linux/<run>/")), ["refs/verification-linux/<run>/head", "refs/verification-linux/<run>/base", `^${known}`]);
  // The stale ref and the run's own refs are gone afterwards.
  assert.equal(result.refs.size, 0);
  const wsl = result.calls.filter(call => call.executable === "wsl.exe").map(call => call.args[3] === "systemctl" ? "stop" : call.args.at(-1).split("/").at(-1));
  assert.deepEqual(wsl, ["wsl-tips.sh", "wsl-sync.sh", "wsl-run.sh", "stop"]);
  const unit = result.calls.at(-1).args.at(-1);
  assert.match(unit, /^dohc-verification-linux-\w+\.scope$/);
  assert.deepEqual(result.calls.at(-1).args.slice(0, 6), ["-d", "Ubuntu", "--exec", "systemctl", "--user", "stop"]);
});

test("a checkout that has both commits gets no bundle", windowsOnly, async () => {
  const result = await job({ tips: `has ${head}\nhas ${base}\n`, verify: writeReceipt({ final: true, commit: head, verdict: "PASS" }) });
  assert.equal(result.calls.filter(call => call.executable === "git").length, 0);
  assert.equal(result.gitCalls.filter(args => args[0] === "update-ref").length, 0);
});

test("a failed check comes back as the receipt; a missing receipt is the host's failure", windowsOnly, async () => {
  const failed = { final: true, commit: head, verdict: "FAIL", failure: { kind: "check", cause: "rust" } };
  assert.deepEqual((await job({ verify: writeReceipt(failed) })).receipt, failed);
  const selection = await job({ verify: writeReceipt({ final: true, verdict: "FAIL", error: "Cannot find module 'js-yaml'", failure: { kind: "environment", cause: "selection" } }) });
  assert.equal(selection.error.environment, "linux selection");
  assert.match(selection.error.message, /js-yaml/);
  for (const verify of [() => {}, writeReceipt({ final: false, commit: head, verdict: "FAIL" }), writeReceipt({ final: true, commit: base, verdict: "PASS" }),
    () => { throw Object.assign(new Error("wsl.exe failed (1)"), { exitCode: 1 }); }]) {
    const { error, calls } = await job({ verify });
    assert.equal(error.environment, "linux host");
    assert.equal(calls.at(-1).args[3], "systemctl");
  }
});

test("a failure after an out-of-memory kill is the host's; a pass after one stands", windowsOnly, async () => {
  const kills = { memoryPeak: 11811160064, oomKills: 2 };
  const failedAfterKill = await job({ verify: writeReceipt({ final: true, commit: head, verdict: "FAIL", failure: { kind: "check", cause: "rust" } }, kills) });
  assert.equal(failedAfterKill.error.environment, "linux memory");
  assert.match(failedAfterKill.error.message, /2 out-of-memory kills/);
  const passed = await job({ verify: writeReceipt({ final: true, commit: head, verdict: "PASS" }, kills) });
  assert.equal(passed.receipt.verdict, "PASS");
  assert.deepEqual(passed.scope, kills);
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

test("a stopped run keeps the interruption, not a host failure, and still stops its scope", windowsOnly, async () => {
  const stop = new AbortController();
  const verify = () => { stop.abort(Object.assign(new Error("Stopped after rust failed."), { stopped: true })); throw Object.assign(new Error("wsl.exe failed (interrupted)."), { interrupted: true }); };
  const { error, calls } = await job({ verify, signal: stop.signal });
  assert.equal(error.interrupted, true);
  assert.equal(error.environment, undefined);
  assert.equal(calls.at(-1).args[3], "systemctl");
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
        writeFileSync(join(script.replace(/^\/mnt\/(\w)\//u, "$1:/").replace(/\/wsl-run\.sh$/u, ""), "result.json"), JSON.stringify({ final: true, commit: head, verdict: "PASS" }));
        active -= 1;
      }
      return { stdout: script.endsWith("wsl-tips.sh") ? `has ${head}\nhas ${base}\n` : "" };
    };
    const runs = [1, 2].map(n => linuxRustJob({ distro: "Ubuntu", head, base, output: join(root, `output-${n}`), command, gitRead: () => "", budget, freeMemoryGb: () => 64 }));
    for (const { receipt } of await Promise.all(runs)) assert.equal(receipt.verdict, "PASS");
    assert.equal(most, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the job needs only the memory its limit exceeds the VM's page cache, above the queue's floor", () => {
  assert.equal(neededMemoryGb(0), 14);
  assert.equal(neededMemoryGb(4), 10);
  assert.equal(neededMemoryGb(12), 3);
  assert.equal(parseTips("cached 10485760\n").cachedGb, 10);
  assert.equal(parseTips("").cachedGb, 0);
});

test("a short host waits for memory before it builds, and a stop ends the wait", windowsOnly, async () => {
  const frees = [2, 2, 20];
  const waited = await job({ verify: writeReceipt({ final: true, commit: head, verdict: "PASS" }), tips: `has ${head}\nhas ${base}\ncached 0\n`, freeMemory: () => frees.length > 1 ? frees.shift() : frees[0] });
  assert.equal(waited.receipt.verdict, "PASS");
  assert.equal(frees.length, 1);
  const stop = new AbortController();
  const stopped = job({ tips: `has ${head}\nhas ${base}\ncached 0\n`, freeMemory: () => 1, signal: stop.signal });
  setTimeout(() => stop.abort(Object.assign(new Error("Stopped after rust failed."), { stopped: true })), 50);
  const { error, calls } = await stopped;
  assert.equal(error.stopped, true);
  assert.equal(calls.some(call => call.args.at(-1).endsWith("wsl-run.sh")), false);
});
