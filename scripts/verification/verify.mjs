import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { nextestFailures, nextestFlaky, nextestTimes, playwrightFailures, playwrightFlaky, playwrightTimes, readLog, readTestRecord, rerunCommand, slowest, testRecordReporter, vitestFailures } from "./flaky.mjs";
import { prepare, assertPrepared, assertIndependentStagedEngine, sourceFingerprint, buildEnvironment, stagedEnginePath, hashFile, withBuildBudget } from "./build.mjs";
import { doctor } from "./doctor.mjs";
import { git, pnpm, repoRoot, run } from "./process.mjs";
import { cancellationScope } from "./cancellation.mjs";
import { startTiming, timed } from "./timing.mjs";
import { testWorkspace } from "./js-tests.mjs";
import { affectedPackages, packageReferences, readWorkspacePackages, selectedGates, selectsRepositoryTests } from "./selection.mjs";
import { classifyTreeProvenance, readTreeState } from "../../tools/rust-engine-program/tree-provenance.mjs";
import { acquireExclusiveSlot, acquireVerificationSlot, resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";
import { processIdentity, ticketEvidence } from "./ticket-evidence.mjs";
import { admissionPreflight, installedDependenciesMatch } from "./admission.mjs";
import { readGit } from "../../tools/rust-engine-program/git-read.mjs";
import { clippy, fmtCheck, nextest } from "../../tools/rust-engine-program/gate-commands.mjs";
import { finishRustEvidence, refreshRustReuse, rustIdentity } from "./rust-reuse.mjs";
import { pauseHold, queueRoot, sharedFailures, verifyThroughQueue } from "./queue.mjs";
import { linuxDistro, linuxRustJob } from "./linux.mjs";

// Windows reports a console program that could not start as STATUS_DLL_INIT_FAILED. The job relay
// (windows-job.ps1 and windows-command.mjs) exits with 0xD0C5 when its command never started.
const startupFailures = new Set([3221225794, -1073741502, 0xD0C5]);
// Phases that test the host, not the change. A failure there says nothing about the commit.
const hostPhases = new Set(["selection", "checkout", "preflight", "preflight:admission", "source-fingerprints:start", "electron-install", "doctor", "postgres-start", "browser-install", "queue"]);

/** Whether a failure is the change's fault ("check") or the machine's ("environment"). The queue retries only the second. */
export function failureKind(error) {
  // Test output can contain any text, so only structured causes and the gate's own refusal count.
  // The queue also measures the host after a failure: low disk or a silent Docker makes it a machine failure.
  if (error?.environment) return { kind: "environment", cause: error.environment };
  // A program that could not start ran no check, whatever the reason.
  if (String(error?.syscall ?? error?.cause?.syscall ?? "").startsWith("spawn")) return { kind: "environment", cause: `${error.code ?? "failure"} starting a program` };
  if (startupFailures.has(error?.exitCode) || startupFailures.has(error?.status)) return { kind: "environment", cause: "a program could not start" };
  if (/^refusing to run the gate: [\d.]+ GB free/mu.test(String(error?.stdout ?? "").slice(-65536) + String(error?.stderr ?? "").slice(-65536))) return { kind: "environment", cause: "disk space" };
  if (hostPhases.has(error?.step)) return { kind: "environment", cause: error.step };
  if (error?.step === "install" && !/ERR_PNPM_(OUTDATED_LOCKFILE|LOCKFILE|PEER)/u.test(`${error?.message ?? ""}\n${String(error?.stderr ?? "").slice(-65536)}`)) return { kind: "environment", cause: "install" };
  return { kind: "check", cause: error?.step ?? "verification" };
}

/**
 * The queue's grant and evidence folder, removed from the environment so that
 * nothing this verifier starts, such as a test that runs another verifier,
 * inherits them.
 */
export function takeGrant(env = process.env) {
  const grant = env.DOHC_VERIFICATION_GRANT ? JSON.parse(env.DOHC_VERIFICATION_GRANT) : null;
  const output = env.DOHC_VERIFICATION_OUTPUT ?? null;
  delete env.DOHC_VERIFICATION_GRANT;
  delete env.DOHC_VERIFICATION_OUTPUT;
  return { grant, output };
}

const require = createRequire(join(repoRoot, "apps/desktop/package.json"));
export function desktopProofCommand(args, { platform = process.platform, env = process.env } = {}) {
  const command = [process.execPath, ["apps/desktop/scripts/run-playwright.mjs", ...args]];
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY
    ? ["xvfb-run", ["-a", command[0], ...command[1]]]
    : command;
}

// The states page compares its baselines on Windows, where they were taken.
// Elsewhere its pixel test skips itself, which the desktop proof's skip check
// would count as a failure, so it is left out and the report says so.
// @states-page selects both of its tests; the pixel test alone carries
// @states-baselines, and that is the proof required.
export function desktopProofTags({platform = process.platform} = {}) {
  const gallery = platform === "win32";
  const restart = ["@restart-durability-idle-external", "@restart-durability-overlapping-typing", "@restart-durability-capture-before-reopen", "@restart-durability-person-agent"];
  return {
    selected: ["@verification-smoke", ...restart, "@self-host-onboarding", ...(gallery ? ["@states-page"] : [])],
    required: ["@verification-smoke", ...restart, "@self-host-onboarding", ...(gallery ? ["@states-baselines"] : [])],
  };
}

function createTreeReader() {
  const headLogPath = resolve(repoRoot, git(["rev-parse", "--git-path", "logs/HEAD"]));
  // The checkout stays in place during a run; its log can still disappear.
  return () => readTreeState(
    (command) => git(command.split(" ").slice(1)),
    () => existsSync(headLogPath),
  );
}
function passedSpecTitles(suites = []) {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []).filter((spec) => spec.ok === true && spec.tests?.some((test) => test.results?.some((result) => result.status === "passed"))).map((spec) => spec.title),
    ...passedSpecTitles(suite.suites),
  ]);
}

export function changedFiles(baseCommit, includeUncommitted = false, root = repoRoot) {
  const paths = (args) => readGit(args, root).split("\0").filter(Boolean);
  return [...new Set([
    ...paths(["diff", "--no-renames", "--name-only", "-z", `${baseCommit}...HEAD`]),
    ...(includeUncommitted ? [
      ...paths(["diff", "--no-renames", "--name-only", "-z", "HEAD"]),
      ...paths(["ls-files", "--others", "--exclude-standard", "-z"]),
    ] : []),
  ])];
}

export function readSelfHostNativeProof(output, executable, sha256) {
  const tests = JSON.parse(readFileSync(join(output, "vitest.json"), "utf8"));
  if (!tests.success || !Number.isSafeInteger(tests.numTotalTests) || tests.numTotalTests < 1 || tests.numPassedTests !== tests.numTotalTests ||
    tests.numFailedTests || tests.numPendingTests || tests.numTodoTests) {
    throw new Error("The self-host native proof did not complete its mandatory tests.");
  }
  const directories = readdirSync(output, {withFileTypes: true}).filter(entry => entry.isDirectory() && entry.name.startsWith("self-host-live-"));
  if (directories.length !== 1) throw new Error("The self-host native proof did not produce one evidence record.");
  const path = join(output, directories[0].name, "result.json");
  const proof = JSON.parse(readFileSync(path, "utf8"));
  if (proof.verdict !== "PASS" || resolve(proof.executable) !== resolve(executable) || proof.sha256 !== sha256 || proof.acceptance ||
    proof.results?.ownerDelivery?.restartPreservedDraft !== true || proof.results?.ownerDelivery?.concurrentOwnerAndNamedEditsMerged !== true ||
    proof.results?.ownerDelivery?.idleOwnerPulledRecipientEdit !== true || proof.results?.settledAndPublished?.ordinaryOwnerReadMatched !== true) {
    throw new Error("The self-host native proof does not cover the prepared engine and complete delivery flow.");
  }
  return {path, executable, sha256, tests: {passed: tests.numPassedTests}};
}

export async function postgres(output, command = run, measure = (_name, action) => action(), label = "inline") {
  const name = `dohc-verify-${randomUUID()}`;
  let id;
  let cancellation;
  let wake;
  const interrupt = (signal) => {
    cancellation ??= new Error(`Verification Postgres interrupted by ${signal}.`);
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    wake?.();
  };
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  const listen = () => { process.on("SIGINT", onInt); process.on("SIGTERM", onTerm); };
  const unlisten = () => { process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); };
  const checkCancellation = () => { if (cancellation) throw cancellation; };
  const stop = async () => {
    // Also protect cleanup when the successfully started database is stopped later.
    unlisten(); listen();
    // --volumes also removes the anonymous data volume the image declares, about 49 MB a run.
    try { return await measure("postgres-stop", () => command("docker", ["rm", "--force", "--volumes", id ?? name], { log: join(output, "postgres-stop.log"), timeoutMs: 30_000 })); }
    finally { unlisten(); }
  };
  listen();
  try {
    // A fresh postgres:17-alpine needed 54 s for its first initdb on Windows. Failed checks inside the start period do not count toward the retries.
    const result = await command("docker", ["run", "--detach", "--name", name, "--label", `dohc.verification=${label}`, "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=dohc", "--env", "POSTGRES_PASSWORD=dohc", "--env", "POSTGRES_DB=dohc", "--health-cmd", "pg_isready -h 127.0.0.1 -U dohc -d dohc", "--health-interval", "1s", "--health-retries", "30", "--health-start-period", "90s", "--health-start-interval", "1s", "postgres:17-alpine"], { log: join(output, "postgres-start.log"), timeoutMs: 300_000 });
    const returnedId = result.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(returnedId)) throw new Error(`Docker returned no container ID. Inspect container ${name}.`);
    id = returnedId;
    checkCancellation();
    const deadline = Date.now() + 120_000;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Verification Postgres did not become healthy.");
      const health = await command("docker", ["inspect", "--format", "{{.State.Health.Status}}", id], { timeoutMs: Math.min(30_000, remaining) });
      checkCancellation();
      if (health.stdout.trim() === "healthy") break;
      if (Date.now() > deadline || health.stdout.trim() === "unhealthy") throw new Error("Verification Postgres did not become healthy.");
      await new Promise((done) => {
        const timer = setTimeout(finish, 1000);
        function finish() { clearTimeout(timer); wake = undefined; done(); }
        wake = finish;
        if (cancellation) finish();
      });
      checkCancellation();
    }
    const port = (await command("docker", ["port", id, "5432/tcp"], { timeoutMs: 30_000 })).stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1];
    checkCancellation();
    if (!port) throw new Error("Docker did not report a loopback Postgres port.");
    return { id, url: `postgres://dohc:dohc@127.0.0.1:${port}/dohc`, stop };
  } catch (error) {
    try { await stop(); }
    catch (cleanupError) { error.cleanupError = `Could not remove verification Postgres ${id ?? name}: ${cleanupError.message}`; }
    throw error;
  } finally { unlisten(); }
}

export async function verify(args) {
  const total = {};
  const finishTiming = startTiming(total);
  const mode = args[0] ?? "smoke";
  if (!["smoke", "e2e", "pr", "plan"].includes(mode)) throw new Error("Use smoke, e2e, plan --base <ref>, or pr --base <ref>.");
  const baseIndex = args.indexOf("--base");
  const base = baseIndex >= 0 ? args[baseIndex + 1] : null;
  const jobIndex = args.indexOf("--job");
  const job = jobIndex < 0 ? null : args[jobIndex + 1];
  const full = args.includes("--full");
  // A failed step stops the rest of a PR run unless it keeps going. A full run, such as the nightly, always keeps going so triage sees every failure.
  const keepGoing = full || args.includes("--keep-going");
  const detach = args.includes("--detach");
  const inline = args.includes("--inline");
  // Names who a queued run belongs to when T3 does not know its thread.
  const ownerIndex = args.indexOf("--owner");
  const ownerName = ownerIndex < 0 ? null : args[ownerIndex + 1];
  if (ownerIndex >= 0 && (mode !== "pr" || !ownerName?.trim() || ownerName.startsWith("--"))) throw new Error("Use --owner <name> with a PR run.");
  // The queue service runs this verifier in its lane with a grant; it must not queue again.
  const { grant, output: grantOutput } = takeGrant();
  const reuseIndex = args.indexOf("--reuse-rust");
  const reuseRust = reuseIndex < 0 ? null : args[reuseIndex + 1];
  if (reuseIndex >= 0 && (mode !== "pr" || !reuseRust || reuseRust.startsWith("--") || job === "js")) {
    throw new Error("Use --reuse-rust <canonical-result.json> with a PR run that includes Rust.");
  }
  if (full && !["pr", "plan"].includes(mode)) throw new Error("--full is available only for PR verification and planning.");
  if (args.includes("--keep-going") && mode !== "pr") throw new Error("--keep-going is available only for PR verification.");
  if (jobIndex >= 0 && (mode !== "pr" || !["rust", "js"].includes(job))) throw new Error("--job rust|js is available only for PR verification.");
  if (["pr", "plan"].includes(mode) && (!base || base.startsWith("--"))) throw new Error("Supply --base <ref> for PR gate selection.");
  function selection() {
    const baseCommit = base ? git(["rev-parse", "--verify", `${base}^{commit}`]) : null;
    const files = base ? changedFiles(baseCommit, mode === "plan") : [];
    const workflow = readFileSync(join(repoRoot, ".github/workflows/pr-checks.yml"), "utf8");
    const requiredGates = selectedGates(files, workflow);
    if (full) Object.assign(requiredGates, { rust: true, js: true });
    if (job) requiredGates[job] = true;
    const gates = Object.fromEntries(Object.entries(requiredGates).map(([name, needed]) => [name, needed && (!job || name === job)]));
    // The JavaScript gate runs every repository test when the change reaches a file they read, when the run keeps going,
    // and when no changed file narrows it, as for packages. Otherwise it runs only the tests that read the source tree.
    const repositoryTests = !gates.js ? undefined
      : keepGoing || !files.length || selectsRepositoryTests(files, workflow) ? "test:repo" : "test:repo:tree";
    // On a host that names a WSL distro, Rust is also checked there. Reused Rust evidence covers renderer changes only, so it needs none.
    const linux = gates.rust && !reuseRust ? linuxDistro() : null;
    return { baseCommit, files, workflow, requiredGates, gates, repositoryTests, linux };
  }
  if (mode === "plan") {
    const {baseCommit, files, gates, repositoryTests, linux} = selection();
    // Package tests run for the affected packages only; --full and changes outside packages run every package.
    const workspace = gates.js && !full ? readWorkspacePackages(repoRoot) : null;
    const packages = workspace && affectedPackages(files, workspace, packageReferences(repoRoot, workspace));
    // The JavaScript gate runs the affected packages' tests and the selected repository tests, then these proofs.
    const javascript = gates.js ? {needs: ["postgres", "engine", "desktop"], packages: packages ?? "all", repositoryTests, proofs: ["self-host-native", "accounts", ...desktopProofTags().required]} : null;
    console.log(JSON.stringify({base, baseCommit, files, gates, javascript, linux}, null, 2));
    return;
  }
  let treeState;
  let branch = null;
  const output = grant ? grantOutput : join(repoRoot, ".agent-artifacts/verification", `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`);
  mkdirSync(output, { recursive: true });
  const report = { version: 1, mode, scope: job ?? "all", full, keepGoing, root: repoRoot, base, ...(grant ? { grant } : {}), ...total, steps: [], timings: [], treeReadings: [], flaky: [], failed: [], output, verdict: "RUNNING" };
  // Tests that passed only on retry: { step, test }, with passedAlone when they failed both tries and passed only alone.
  const flaky = report.flaky;
  // Tests that failed on their last try, named as in `flaky`.
  const failed = report.failed;
  // Every test time the gate saw, from which result.json keeps the slowest: { step, test, seconds }.
  const times = [];
  const reportPath = join(output, "result.json");
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  const measure = (name, action) => {
    lane?.update?.({phase: name});
    checkoutOwner?.update?.({phase: name});
    const row = {name};
    report.timings.push(row);
    return timed(row, action, save).catch(error => { if (error && typeof error === "object") error.step ??= name; throw error; });
  };
  let startSource = {};
  function recordTree(name) {
    try { report.treeReadings.push({ step: name, state: treeState() }); }
    catch (error) {
      report.treeReadings.push({ step: name, state: { head: null, dirty: null, reflog: null } });
      report.provenance = classifyTreeProvenance(report.treeReadings);
      throw error;
    }
  }
  async function checkTree(name) {
    await measure(`source-check:${name}`, async () => {
      recordTree(name);
      report.provenance = classifyTreeProvenance(report.treeReadings);
      if (report.provenance.status !== "PASS") throw new Error(report.provenance.reason);
      if (Object.entries(startSource).some(([kind, hash]) => sourceFingerprint(kind) !== hash)) throw new Error("Source changed during verification. The result cannot prove the starting checkout.");
      await cancellation.checkpoint();
    });
  }
  let database;
  let lane;
  let checkoutOwner;
  const previousIncremental = process.env.CARGO_INCREMENTAL;
  let desktopEnvironment;
  let originalRustIdentity;
  let rustTools;
  const jobSteps = {};
  async function checkedStep(row, action, checkpoint = () => cancellation.checkpoint()) {
    await checkpoint();
    cancellation.signal.throwIfAborted();
    lane?.update?.({phase: row.name});
    checkoutOwner?.update?.({phase: row.name});
    report.steps.push(row); save();
    const result = await timed(row, action, save).catch(error => {
      if (error && typeof error === "object") error.step ??= row.name;
      if (cancellation.notRun(row, error)) save();
      throw error;
    });
    await checkTree(row.name);
    return result;
  }
  function step(name, command, commandArgs, env = process.env, checkpoint) {
    const row = { name, command, args: commandArgs, log: join(output, `${name}.log`) };
    return checkedStep(row, () => run(command, commandArgs, { env, log: row.log, signal: cancellation.signal }), checkpoint);
  }
  const typecheck = () => pnpm(["run", "typecheck"]);
  save();
  const cancellation = cancellationScope("Verification", { stopOnFailure: !keepGoing });
  try {
    if (mode === "pr") process.env.CARGO_INCREMENTAL = "0";
    desktopEnvironment = {...process.env, DOHC_TEST_ENGINE_BINARY: stagedEnginePath};
    const {workflow, gates, repositoryTests, linux} = await measure("selection", () => {
      treeState = createTreeReader();
      const selected = selection();
      Object.assign(report, {baseCommit: selected.baseCommit, files: selected.files, requiredGates: selected.requiredGates, gates: selected.gates,
        repositoryTests: selected.repositoryTests, ...(selected.linux ? {linux: {distro: selected.linux}} : {}),
        commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== ""});
      // A detached HEAD names no branch. symbolic-ref would fail there, and git() retries a failure.
      try { const ref = git(["rev-parse", "--symbolic-full-name", "HEAD"]); branch = ref.startsWith("refs/") ? ref : null; } catch { /* No branch. */ }
      recordTree("start");
      return selected;
    });
    if (mode === "pr") checkoutOwner = await measure("checkout", () => acquireExclusiveSlot({
      root: join(repoRoot, ".dohc-dev/verification"), kind: "verification-checkout",
      metadata: {purpose: `PR verification (${report.scope})`, checkout: repoRoot, commit: report.commit, phase: "selection"},
    }));
    if (mode === "pr" && report.dirty) throw new Error("Commit the worktree before running the PR gate.");
    if (grant && (report.commit !== grant.head || report.baseCommit !== grant.base)) {
      throw Object.assign(new Error(`The lane is at ${report.commit} against ${report.baseCommit}, not the granted ${grant.head} against ${grant.base}.`), { environment: "lane mismatch" });
    }
    if (reuseRust && !gates.rust) throw new Error("--reuse-rust requires a selected Rust job. Use --job rust when needed.");
    if (mode === "pr" && !gates.js && !gates.rust) {
      report.reason = "No code gate applies to the changed files.";
      await checkTree("finish");
      report.verdict = "PASS";
      return report;
    }
    // Desktop smoke, e2e, and the JavaScript gate prepare the engine and desktop.
    const desktop = mode !== "pr" || gates.js;
    const native = gates.rust || desktop;
    if (mode === "pr") {
      const preflight = () => admissionPreflight({rust: gates.rust, native, root: repoRoot, pins: require("js-yaml").load(workflow).env});
      await measure("preflight", preflight);
      // Checks that need no lane fail here, fastest first, instead of after the wait. The lane repeats them as evidence.
      if (!grant && gates.rust && !reuseRust) await step("pre-queue-fmt", "cargo", fmtCheck);
      if (!grant && gates.js && installedDependenciesMatch(repoRoot)) await step("pre-queue-typecheck", ...typecheck());
      if (!grant && gates.rust && !reuseRust) await withBuildBudget(async env => {
        await step("pre-queue-clippy", "cargo", clippy, env);
        await step("pre-queue-test-build", "cargo", [...nextest, "--no-run"], env);
      });
      const hostQueue = grant ? null : queueRoot();
      const queue = inline ? null : hostQueue;
      if (queue && reuseRust) throw new Error("The queue cannot reuse Rust evidence yet. Add --inline to reuse it in this checkout.");
      if (queue && keepGoing && !full) throw new Error("The queue keeps going only with --full. Add --full, or --inline to keep going in this checkout.");
      if (queue) {
        // The service verifies the commit in its own checkout, so this checkout is free to change now.
        checkoutOwner.release();
        const outcome = await measure("queue", () => verifyThroughQueue({ root: queue, detach, checkpoint: () => cancellation.checkpoint(), submission: {
          head: report.commit, base: report.baseCommit, baseRef: base, scope: report.scope, full,
          gates, branch, checkout: repoRoot, ownerName, requester: { pid: process.pid } } }));
        report.queue = outcome;
        try {
          const receipt = JSON.parse(readLog(outcome.result ?? "") || "{}");
          flaky.push(...(receipt.flaky ?? []));
          failed.push(...(receipt.failed ?? []));
          if (receipt.stopped) report.stopped = receipt.stopped;
        } catch { /* The lane receipt is the record. */ }
        save();
        if (detach) { report.verdict = "QUEUED"; return report; }
        if (outcome.verdict !== "PASS") throw Object.assign(new Error(outcome.reason ?? `The queued run ended ${outcome.state}.`), { queued: outcome.state });
        report.verdict = "PASS";
        return report;
      }
      if (inline && hostQueue) console.log("[verification] This inline gate runs outside the queue's turns between owners. pnpm verify:pr without --inline takes a fair turn.");
      // Identify this process before publishing a ticket; no lookup may delay admission.
      const tickets = !grant && resolveBuildBudget() ? ticketEvidence({output, checkout: repoRoot, commit: report.commit,
        producer: await measure("producer-identity", () => processIdentity()), persist: save}) : null;
      report.ticketEvidence = tickets?.record;
      let ticketCleanup;
      if (!grant) try {
        lane = await measure("queue", () => acquireVerificationSlot(process.env, {
          metadata: {purpose: "PR verification", checkout: repoRoot, commit: report.commit, phase: "admission"},
          observeTicket: tickets?.observe,
          // An inline run takes no lane while the host's queue is paused.
          hold: hostQueue && pauseHold(hostQueue),
        }));
      } finally {
        ticketCleanup = tickets?.settle();
        save();
      }
      if (ticketCleanup) throw new Error(ticketCleanup);
      await checkTree("admission");
      await measure("preflight:admission", preflight);
    }
    startSource = await measure("source-fingerprints:start", () => ({ ...(native ? {engine: sourceFingerprint("engine")} : {}), desktop: sourceFingerprint("desktop") }));
    await cancellation.checkpoint();
    // No terminal can confirm a modules purge, so a pnpm settings change reinstalls instead of aborting.
    if (mode === "pr") await step("install", ...pnpm(["install", "--frozen-lockfile", "--config.confirm-modules-purge=false"]));
    if (desktop) await step("electron-install", process.execPath, ["apps/desktop/scripts/ensure-electron-installed.mjs"]);
    report.doctor = await measure("doctor", () => doctor({engine: native, desktop, browser: desktop})); save();
    await cancellation.checkpoint();
    if (report.doctor.checks.some((check) => check.state === "FAIL")) throw Object.assign(new Error("Preflight failed. Read result.json and run pnpm setup:worktree."), { environment: "doctor" });
    await step("app-backend-runtime", ...pnpm(["--filter", "@dohc/app-backend-runtime", "build"]));
    const preparedOptions = {engineBinary: stagedEnginePath};
    if (desktop) {
      await measure("prepare", () => prepare({ ...preparedOptions, output, install: mode !== "pr" }));
      report.build = await measure("prepared-build", () => assertPrepared(preparedOptions)); save();
      if (gates.rust) assertIndependentStagedEngine();
      await checkTree("prepare");
    }
    async function rustJob() {
      if (mode !== "pr" || !gates.rust) return;
      try {
        const pins = require("js-yaml").load(workflow).env;
        rustTools = Object.fromEntries(report.doctor.checks.filter(check => ["rustc", "cargo"].includes(check.name) && check.state === "PASS")
          .map(check => [check.name, check.detail]));
        for (const [tool, variable] of [["deny", "CARGO_DENY_VERSION"], ["audit", "CARGO_AUDIT_VERSION"], ["nextest", "CARGO_NEXTEST_VERSION"]]) {
          const result = await step(`cargo-${tool}-version`, "cargo", [tool, "--version"]);
          if (result.stdout.split(/\r?\n/)[0].split(/\s+/)[1] !== pins[variable]) throw new Error(`Install cargo-${tool} ${pins[variable]} to match the workflow.`);
          rustTools[tool] = result.stdout.trim();
        }
        const identity = rustIdentity({root: repoRoot, engine: sourceFingerprint("engine"), tools: rustTools});
        originalRustIdentity = identity;
        if (reuseRust) {
          report.rustEvidence = await checkedStep({name: "rust-reuse", reused: true, report: resolve(reuseRust)},
            () => refreshRustReuse(reuseRust, {root: repoRoot, identity,
              step: (name, command, args) => step(name, command, args, buildEnvironment())}));
          flaky.push(...nextestFlaky(readLog(report.rustEvidence.log)).map(test => ({ step: "rust", test })));
          save();
          return;
        }
        try {
          await step("rust", process.execPath, ["tools/rust-engine-program/run-rust-checks.mjs", "--prepared-runtime"], buildEnvironment());
          await step("rust-verdict", process.execPath, ["tools/rust-engine-program/require-ci-pass-verdict.mjs", join(output, "rust.log")]);
        } finally {
          const log = readLog(join(output, "rust.log"));
          flaky.push(...nextestFlaky(log).map(test => ({ step: "rust", test })));
          failed.push(...nextestFailures(log).map(test => ({ step: "rust", test })));
          times.push(...nextestTimes(log).map(test => ({ step: "rust", ...test })));
          save();
        }
      } catch (error) {
        report.rustError = error.message; save();
        await checkTree("rust-failure");
        throw error;
      }
    }
    // Rust in the host's WSL distro, beside the Windows job: clippy and the compiler owner's tests for a PR,
    // the whole Rust job for a full run.
    async function linuxJob() {
      if (!linux) return;
      const linuxOutput = join(output, "rust-linux");
      const mode = full ? "gate" : "pr";
      let receipt;
      let scope;
      try {
        await checkedStep({ name: "rust-linux", distro: linux, mode, log: join(linuxOutput, "wsl-run.log"), report: join(linuxOutput, "result.json") }, async () => {
          ({ receipt, scope } = await linuxRustJob({ distro: linux, head: report.commit, base: report.baseCommit, output: linuxOutput, full,
            signal: cancellation.signal, request: grant?.request, attempt: grant?.attempt }));
          if (receipt.verdict !== "PASS") throw new Error(`Rust failed on Linux: ${receipt.error ?? "read its receipt"}`);
        });
      } finally {
        const linuxStep = row => ({ ...row, step: row.step === "rust" ? "rust-linux" : `rust-linux ${row.step}` });
        flaky.push(...(receipt?.flaky ?? []).map(linuxStep));
        failed.push(...(receipt?.failed ?? []).map(linuxStep));
        report.linux = { distro: linux, mode, result: join(linuxOutput, "result.json"), verdict: receipt?.verdict ?? null, memoryPeak: scope?.memoryPeak ?? null };
        save();
      }
    }
    async function javascriptJob() {
      async function integrationProofs(env, checkpoint) {
        const proofStep = (name, command, commandArgs, env) => step(name, command, commandArgs, env, checkpoint);
        const recordPlaywright = (name, path) => {
          try {
            const suites = JSON.parse(readLog(path) || "{}").suites;
            flaky.push(...playwrightFlaky(suites).map(test => ({ step: name, test })));
            failed.push(...playwrightFailures(suites).map(test => ({ step: name, test })));
            times.push(...playwrightTimes(suites).map(test => ({ step: name, ...test })));
          } catch { /* No report. */ }
          save();
        };
        if (mode === "pr") {
          const nativeOutput = join(output, "self-host-native");
          const nativeHash = hashFile(stagedEnginePath);
          const nativeProof = name => {
            rmSync(nativeOutput, {recursive: true, force: true});
            mkdirSync(nativeOutput, {recursive: true});
            return proofStep(name, ...pnpm(["--filter", "@dohc/share-web", "exec", "vitest", "run", "--config", "vitest.self-host-native.config.ts",
              "--reporter=default", "--reporter=json", `--outputFile.json=${join(nativeOutput, "vitest.json")}`, `--reporter=${testRecordReporter}`]),
              {...env, DOHC_TEST_RECORD: join(nativeOutput, "tests.jsonl"), DOHC_SERVICE_HOST_PROOF_BINARY: stagedEnginePath, DOHC_SERVICE_HOST_PROOF_SHA256: nativeHash, DOHC_SERVICE_HOST_PROOF_OUTPUT: nativeOutput});
          };
          try { await nativeProof("self-host-native"); }
          catch (error) {
            const failed = error.commandExitFailure ? vitestFailures(join(nativeOutput, "vitest.json")) : [];
            if (!failed.length) throw error;
            // The failed attempt's evidence stays beside the folder the proof check reads.
            renameSync(nativeOutput, `${nativeOutput}-attempt-1`);
            await nativeProof("self-host-native-retry");
            flaky.push(...failed.map(test => ({ step: "self-host-native", test })));
          }
          times.push(...readTestRecord(join(nativeOutput, "tests.jsonl")).map(test => ({ step: "self-host-native", test: test.test, seconds: test.seconds })));
          report.selfHostNative = readSelfHostNativeProof(nativeOutput, stagedEnginePath, nativeHash); save();
          await proofStep("browser-install", ...pnpm(["exec", "playwright", "install", "chromium"]), env);
          const accountReport = join(output, "accounts-playwright.json");
          try { await proofStep("accounts", process.execPath, ["apps/desktop/scripts/run-playwright.mjs", "--config", "services/workspace-api/playwright.config.ts", "--output", join(output, "accounts"), "--retries=1", "--reporter=list,json"], { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: accountReport }); }
          finally { recordPlaywright("accounts", accountReport); }
          const accounts = JSON.parse(readFileSync(accountReport, "utf8"));
          report.accounts = accounts.stats;
          if (!(report.accounts?.expected + (report.accounts?.flaky ?? 0)) || report.accounts.unexpected || report.accounts.skipped) throw new Error("Account browser verification did not complete without failures or skips.");
          if (process.platform !== "win32") {
            report.statesPage = `not run: the states page compares pixels on win32 only, and this host is ${process.platform}`; save();
          }
        }
        // Desktop specs that open a browser page use the same pinned browser as the PR gate's account proof.
        if (mode === "e2e") await proofStep("browser-install", ...pnpm(["exec", "playwright", "install", "chromium"]), env);
        const tags = mode === "pr" ? desktopProofTags() : {selected: ["@verification-smoke"], required: ["@verification-smoke"]};
        const forwarded = mode === "e2e" ? args.slice(1).filter((arg) => arg !== "--") : ["--grep", tags.selected.join("|")];
        const jsonReport = join(output, "playwright.json");
        try { await proofStep("desktop", ...desktopProofCommand(["--config", "apps/desktop/playwright.config.ts", "--output", join(output, "desktop"), ...forwarded, ...(mode === "pr" ? ["--retries=1"] : []), "--reporter=list,json"], { env }), { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonReport, DOHC_QA_OUTPUT: output, DOHC_REQUIRE_ENGINE_E2E: "1" }); }
        finally { recordPlaywright("desktop", jsonReport); }
        const desktopReport = JSON.parse(readFileSync(jsonReport, "utf8"));
        report.desktop = desktopReport.stats;
        report.desktopProofs = passedSpecTitles(desktopReport.suites);
        // Only the PR gate retries proofs, so only it accepts a proof that passed on retry.
        const retried = mode === "pr" ? report.desktop?.flaky ?? 0 : 0;
        if (!(report.desktop?.expected + retried) || report.desktop.unexpected || report.desktop.flaky > retried) throw new Error("Desktop verification did not complete a passing test run.");
        if (mode !== "e2e" && report.desktop.skipped) throw new Error("A mandatory desktop smoke test was skipped.");
        if (mode === "pr" && tags.required.some((tag) => !report.desktopProofs.some((title) => title.split(/\s+/u).includes(tag)))) throw new Error(`The desktop gate did not pass every required proof: ${tags.required.join(", ")}.`);
      }
      if (mode === "pr" && gates.js) {
        database = await measure("postgres-start", () => postgres(output, run, measure, grant?.request ?? "inline"));
        report.postgres = { id: database.id }; save();
        const env = { ...process.env, POSTGRES_URL: database.url, DOHC_REQUIRE_POSTGRES: "1", DOHC_REQUIRE_ENGINE_E2E: "1", DOHC_TEST_ENGINE_BINARY: stagedEnginePath };
        await step("typecheck", ...typecheck(), env);
        report.jsTests = join(output, "js-tests", "result.json");
        // Keep package groups under this owner so cancellation finishes their
        // escalation before database cleanup, without a competing parent timer.
        try {
          await checkedStep({ name: "tests", runner: "testWorkspace", report: report.jsTests },
            () => testWorkspace({ prepared: true, output: join(output, "js-tests"), env, changed: full ? null : report.files, repositoryTests, full,
              beforeDesktopScripts: () => measure("packaging-wait", () => rustSettled), stop: cancellation,
              runProofs: checkpoint => integrationProofs(env, checkpoint) }));
        } finally {
          try {
            const tests = JSON.parse(readFileSync(report.jsTests, "utf8"));
            flaky.push(...(tests.flaky ?? []));
            failed.push(...(tests.failed ?? []));
            times.push(...(tests.slowest ?? []));
          } catch { /* No package report. */ }
          save();
        }
      } else if (mode !== "pr") {
        await integrationProofs(desktopEnvironment, () => cancellation.checkpoint());
      }
    }
    // A job's failure stops the other job unless the run keeps going. Every expected step that never starts, in either job, is reported as not run.
    if (mode === "pr") Object.assign(jobSteps, { rust: !gates.rust ? [] : reuseRust ? ["rust-reuse"] : ["rust", "rust-verdict"], linux: linux ? ["rust-linux"] : [], js: gates.js ? ["typecheck", "tests"] : [] });
    const stopOther = job => error => {
      cancellation.stop(error?.step ?? job, error);
      throw error;
    };
    const rustWork = rustJob().catch(stopOther("rust"));
    const rustSettled = rustWork.then(() => {}, () => {});
    const [rustResult, linuxResult, javascriptResult] = await Promise.allSettled([rustWork, linuxJob().catch(stopOther("rust-linux")), javascriptJob().catch(stopOther("js"))]);
    if (cancellation.stopped) throw cancellation.stopped.error;
    await cancellation.checkpoint();
    if (javascriptResult.status === "rejected") throw javascriptResult.reason;
    if (rustResult.status === "rejected") throw rustResult.reason;
    if (linuxResult.status === "rejected") throw linuxResult.reason;
    if (desktop) await measure("prepared-build:finish", () => assertPrepared(preparedOptions));
    await checkTree("finish");
    report.verdict = "PASS";
  } catch (error) {
    report.verdict = "FAIL"; report.error = error.message;
    // A queued "error" is the host's failure; a queued FAIL was classified in the lane.
    if (!error.queued) report.failure = failureKind(error);
    else if (error.queued === "error") report.failure = { kind: "environment", cause: "queue error" };
    if (error.cleanupError) report.cleanupError = error.cleanupError;
    throw error;
  }
  finally {
    try {
      lane?.update?.({phase: "cleanup"});
      checkoutOwner?.update?.({phase: "cleanup"});
      try { await database?.stop(); }
      catch (error) {
        report.cleanupError = error.message;
        // In the lane the service removes this request's labeled containers; elsewhere a leak fails the run.
        if (!grant) { report.verdict = "FAIL"; process.exitCode = 1; }
      }
      const interrupted = await cancellation.dispose();
      lane?.release();
      if (interrupted) { report.verdict = "FAIL"; report.error ??= interrupted.message; report.failure ??= { kind: "environment", cause: "interrupted" }; }
      finishTiming(); Object.assign(report, total);
      // In the lane a failed container removal does not change the verdict, so the Rust evidence still finishes.
      if (originalRustIdentity && !interrupted && !report.rustError && (grant || !report.cleanupError)) {
        try {
          recordTree("rust-receipt:finish");
          report.provenance = classifyTreeProvenance(report.treeReadings);
          const finalIdentity = rustIdentity({root: repoRoot, engine: sourceFingerprint("engine"), tools: rustTools});
          report.rustEvidence = finishRustEvidence(report, originalRustIdentity, finalIdentity);
        } catch (error) {
          report.rustEvidence = {kind: "unavailable", reason: error.message};
          report.verdict = "FAIL"; report.error ??= error.message; process.exitCode = 1;
        }
      }
      if (mode === "pr") {
        if (previousIncremental === undefined) delete process.env.CARGO_INCREMENTAL;
        else process.env.CARGO_INCREMENTAL = previousIncremental;
      }
      finishTiming(); Object.assign(report, total);
      const stopped = cancellation.unfinished(report.steps, Object.values(jobSteps).flat());
      if (stopped) {
        try { stopped.notRun.push(...(JSON.parse(readLog(report.jsTests ?? "") || "{}").stopped?.notRun ?? []).map(name => `tests: ${name}`)); }
        catch { /* No package report. */ }
        report.stopped = stopped;
      }
      // Nothing after this changes the verdict. The queue accepts only a final receipt.
      report.final = true;
      report.slowest = slowest(times);
      // The run that submitted to the queue reports this, not the lane's worker, which runs detached and knows no branch.
      const queue = report.verdict === "FAIL" && failed.length && !grant ? queueRoot() : null;
      if (queue) report.shared = sharedFailures(queue, failed, { branch: branch ?? repoRoot });
      const rerun = report.verdict === "FAIL" ? [...new Set(failed.map(rerunCommand).filter(Boolean))] : [];
      if (rerun.length) report.rerun = rerun;
      save(); console.log(`[verification] ${report.verdict} (${report.scope}): ${reportPath}`);
      if (report.repositoryTests === "test:repo:tree") console.log("[verification] repository tests: tree set only (no tooling change). --full runs every repository test.");
      if (report.stopped?.notRun.length) console.log(`[verification] Stopped after ${report.stopped.after} failed. These steps did not finish, so coverage is partial (--keep-going runs them):\n${report.stopped.notRun.map(name => `  ${name}`).join("\n")}`);
      if (report.slowest.length) console.log(`[verification] slowest tests:\n${report.slowest.slice(0, 5).map(row => `  ${row.seconds}s ${row.step}: ${row.test}`).join("\n")}`);
      if (flaky.length) console.log(`[verification] ${flaky.length} flaky test(s) passed only on retry. Each one is a defect to fix:\n${flaky.map(row => `  ${row.step}: ${row.test}${row.passedAlone ? " (failed both tries, passed alone)" : ""}${row.error ? `\n    first try: ${row.error.split("\n")[0]}` : ""}`).join("\n")}`);
      const shared = report.shared ?? [];
      if (shared.length) console.log(`[verification] ${shared.length === 1 ? "1 failed test" : `${shared.length} failed tests`} also failed on other branches in the last day. A failure that other branches share often comes from main or a flaky test, not from this change. Check origin/main and the nightly before you change this branch to fix ${shared.length === 1 ? "it" : "them"}:\n${shared.map(row => `  ${row.step}: ${row.test} (also ${row.branches.join(", ")})`).join("\n")}`);
      if (rerun.length) console.log(`[verification] Rerun the failed tests locally before resubmitting. Set DOHC_REQUIRE_POSTGRES=1 and DOHC_REQUIRE_ENGINE_E2E=1, as the gate does, so a missing database or engine fails instead of skipping:\n${rerun.map(command => `  ${command}`).join("\n")}`);
    } finally { checkoutOwner?.release(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) verify(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
