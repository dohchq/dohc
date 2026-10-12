import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, matchesGlob, resolve } from "node:path";
import { prepare, assertPrepared, assertIndependentStagedEngine, sourceFingerprint, buildEnvironment, stagedEnginePath, hashFile } from "./build.mjs";
import { doctor } from "./doctor.mjs";
import { git, pnpm, repoRoot, run } from "./process.mjs";
import { cancellationScope } from "./cancellation.mjs";
import { startTiming, timed } from "./timing.mjs";
import { testWorkspace } from "./js-tests.mjs";
import { readWorkspacePackages, selectJavaScript, selectedGates, workflowFilters } from "./selection.mjs";
import { readFocusedRendererSelection } from "./renderer-selection.mjs";
import { classifyTreeProvenance, readTreeState } from "../../tools/rust-engine-program/tree-provenance.mjs";
import { acquireExclusiveSlot, acquireVerificationSlot, resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";
import { processIdentity, ticketEvidence } from "./ticket-evidence.mjs";
import { admissionPreflight, installedDependenciesMatch, verificationAdmission } from "./admission.mjs";
import { readGit } from "../../tools/rust-engine-program/git-read.mjs";
import { finishRustEvidence, refreshRustReuse, rustIdentity } from "./rust-reuse.mjs";

const require = createRequire(join(repoRoot, "apps/desktop/package.json"));
export function desktopProofCommand(args, { platform = process.platform, env = process.env } = {}) {
  const command = [process.execPath, ["apps/desktop/scripts/run-playwright.mjs", ...args]];
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY
    ? ["xvfb-run", ["-a", command[0], ...command[1]]]
    : command;
}

export function desktopProofTags(proofs, {platform = process.platform} = {}) {
  const gallery = proofs.statesPage && platform === "win32";
  const smoke = proofs.desktop || proofs.smoke;
  return {
    selected: [...(smoke ? ["@verification-smoke"] : []), ...(proofs.desktop ? ["@self-host-onboarding"] : []), ...(gallery ? ["@states-page"] : [])],
    required: [...(smoke ? ["@verification-smoke"] : []), ...(proofs.desktop ? ["@self-host-onboarding"] : []), ...(gallery ? ["@states-baselines"] : [])],
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
  if (!tests.success || tests.numTotalTests !== 1 || tests.numPassedTests !== 1 || tests.numFailedTests || tests.numPendingTests || tests.numTodoTests) {
    throw new Error("The self-host native proof did not complete its mandatory test.");
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

export async function postgres(output, command = run, measure = (_name, action) => action()) {
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
    try { return await measure("postgres-stop", () => command("docker", ["rm", "--force", id ?? name], { log: join(output, "postgres-stop.log"), timeoutMs: 30_000 })); }
    finally { unlisten(); }
  };
  listen();
  try {
    // A fresh postgres:17-alpine needed 54 s for its first initdb on Windows. Failed checks inside the start period do not count toward the retries.
    const result = await command("docker", ["run", "--detach", "--name", name, "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=dohc", "--env", "POSTGRES_PASSWORD=dohc", "--env", "POSTGRES_DB=dohc", "--health-cmd", "pg_isready -h 127.0.0.1 -U dohc -d dohc", "--health-interval", "1s", "--health-retries", "30", "--health-start-period", "90s", "--health-start-interval", "1s", "postgres:17-alpine"], { log: join(output, "postgres-start.log"), timeoutMs: 300_000 });
    const returnedId = result.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(returnedId)) throw new Error(`Docker returned no container ID. Inspect container ${name}.`);
    id = returnedId;
    checkCancellation();
    const deadline = Date.now() + 120_000;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Verification Postgres did not become healthy.");
      const health = await command("docker", ["inspect", "--format", "{{.State.Health.Status}}", id], { timeoutMs: Math.min(10_000, remaining) });
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
    const port = (await command("docker", ["port", id, "5432/tcp"], { timeoutMs: 10_000 })).stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1];
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
  const reuseIndex = args.indexOf("--reuse-rust");
  const reuseRust = reuseIndex < 0 ? null : args[reuseIndex + 1];
  if (reuseIndex >= 0 && (mode !== "pr" || !reuseRust || reuseRust.startsWith("--") || job === "js")) {
    throw new Error("Use --reuse-rust <canonical-result.json> with a PR run that includes Rust.");
  }
  if (full && !["pr", "plan"].includes(mode)) throw new Error("--full is available only for PR verification and planning.");
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
    const jsPatterns = workflowFilters(workflow).js;
    const jsFiles = files.filter(file => jsPatterns.some(pattern => matchesGlob(file, pattern)));
    const forceFull = full || job === "js" && !jsFiles.length;
    const javascript = gates.js ? (!forceFull && readFocusedRendererSelection(repoRoot, jsFiles, baseCommit)
      || selectJavaScript(jsFiles, readWorkspacePackages(repoRoot), { full: forceFull })) : null;
    return { baseCommit, files, workflow, requiredGates, gates, javascript };
  }
  if (mode === "plan") {
    const {baseCommit, files, gates, javascript} = selection();
    const admission = verificationAdmission({gates, javascript}, gates.js ? readWorkspacePackages(repoRoot) : [], installedDependenciesMatch(repoRoot));
    console.log(JSON.stringify({base, baseCommit, files, gates, javascript, admission}, null, 2));
    return;
  }
  let treeState;
  const output = join(repoRoot, ".agent-artifacts/verification", `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`);
  mkdirSync(output, { recursive: true });
  const report = { version: 1, mode, scope: job ?? "all", full, root: repoRoot, base, ...total, steps: [], timings: [], treeReadings: [], output, verdict: "RUNNING" };
  const reportPath = join(output, "result.json");
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  const measure = (name, action) => {
    lane?.update?.({phase: name});
    checkoutOwner?.update?.({phase: name});
    const row = {name};
    report.timings.push(row);
    return timed(row, action, save);
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
  async function checkedStep(row, action, checkpoint = () => cancellation.checkpoint()) {
    await checkpoint();
    lane?.update?.({phase: row.name});
    checkoutOwner?.update?.({phase: row.name});
    report.steps.push(row); save();
    const result = await timed(row, action, save);
    await checkTree(row.name);
    return result;
  }
  function step(name, command, commandArgs, env = process.env, checkpoint) {
    const row = { name, command, args: commandArgs, log: join(output, `${name}.log`) };
    return checkedStep(row, () => run(command, commandArgs, { env, log: row.log }), checkpoint);
  }
  save();
  const cancellation = cancellationScope("Verification");
  try {
    if (mode === "pr") process.env.CARGO_INCREMENTAL = "0";
    desktopEnvironment = {...process.env, DOHC_TEST_ENGINE_BINARY: stagedEnginePath};
    const {workflow, gates, javascript} = await measure("selection", () => {
      treeState = createTreeReader();
      const selected = selection();
      Object.assign(report, {baseCommit: selected.baseCommit, files: selected.files, requiredGates: selected.requiredGates, gates: selected.gates,
        javascript: selected.javascript, commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== ""});
      recordTree("start");
      return selected;
    });
    if (mode === "pr") checkoutOwner = await measure("checkout", () => acquireExclusiveSlot({
      root: join(repoRoot, ".dohc-dev/verification"), kind: "verification-checkout",
      metadata: {purpose: `PR verification (${report.scope})`, checkout: repoRoot, commit: report.commit, phase: "selection"},
    }));
    if (mode === "pr" && report.dirty) throw new Error("Commit the worktree before running the PR gate.");
    if (reuseRust && !gates.rust) throw new Error("--reuse-rust requires a selected Rust job. Use --job rust when needed.");
    if (mode === "pr" && !gates.js && !gates.rust) {
      report.reason = "No code gate applies to the changed files.";
      await checkTree("finish");
      report.verdict = "PASS";
      return report;
    }
    const needs = mode === "pr" ? (javascript?.needs ?? {engine: false, desktop: false, postgres: false}) : {engine: true, desktop: true};
    const proofs = mode === "pr" ? (javascript?.proofs ?? {}) : {desktop: true};
    const native = gates.rust || needs.engine || needs.desktop;
    if (mode === "pr") {
      const preflight = () => admissionPreflight({rust: gates.rust, native, root: repoRoot, pins: require("js-yaml").load(workflow).env});
      await measure("preflight", preflight);
      report.admission = verificationAdmission({gates, javascript}, readWorkspacePackages(repoRoot), installedDependenciesMatch(repoRoot));
      // Identify this process before publishing a ticket; no lookup may delay admission.
      const tickets = resolveBuildBudget() ? ticketEvidence({output, checkout: repoRoot, commit: report.commit,
        producer: await measure("producer-identity", () => processIdentity()), persist: save}) : null;
      report.ticketEvidence = tickets?.record;
      let ticketCleanup;
      try {
        lane = await measure("queue", () => acquireVerificationSlot(process.env, {
          lightweight: report.admission.lightweight,
          metadata: {purpose: report.admission.lightweight ? "light PR verification" : "full PR verification", checkout: repoRoot, commit: report.commit, phase: "admission"},
          observeTicket: tickets?.observe,
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
    if (mode === "pr" && (gates.js || gates.rust)) {
      if (report.admission.lightweight) {
        if (!installedDependenciesMatch(repoRoot)) throw new Error("Installed dependencies changed while waiting. Rerun verification for full-lane admission.");
      } else await step("install", ...pnpm(["install", "--frozen-lockfile"]));
    }
    if (needs.desktop) await step("electron-install", process.execPath, ["apps/desktop/scripts/ensure-electron-installed.mjs"]);
    report.doctor = await measure("doctor", () => doctor({engine: native, desktop: needs.desktop, browser: Boolean(proofs.accounts || desktopProofTags(proofs).selected.length)})); save();
    await cancellation.checkpoint();
    if (report.doctor.checks.some((check) => check.state === "FAIL")) throw new Error("Preflight failed. Read result.json and run pnpm setup:worktree.");
    if (!report.admission?.lightweight) await step("app-backend-runtime", ...pnpm(["--filter", "@dohc/app-backend-runtime", "build"]));
    const preparedOptions = {engineOnly: !needs.desktop, engineBinary: stagedEnginePath};
    if (needs.engine || needs.desktop) {
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
          save();
          return;
        }
        await step("rust", process.execPath, ["tools/rust-engine-program/run-rust-checks.mjs", "--prepared-runtime"], buildEnvironment());
        await step("rust-verdict", process.execPath, ["tools/rust-engine-program/require-ci-pass-verdict.mjs", join(output, "rust.log")]);
      } catch (error) {
        report.rustError = error.message; save();
        await checkTree("rust-failure");
        throw error;
      }
    }
    async function javascriptJob() {
      async function selectedProofs(env, checkpoint) {
        const proofStep = (name, command, commandArgs, env) => step(name, command, commandArgs, env, checkpoint);
        if (mode === "pr" && proofs.selfHostNative) {
          const nativeOutput = join(output, "self-host-native");
          mkdirSync(nativeOutput, {recursive: true});
          const nativeHash = hashFile(stagedEnginePath);
          await proofStep("self-host-native", ...pnpm(["--filter", "@dohc/share-web", "exec", "vitest", "run", "--config", "vitest.self-host-native.config.ts",
            "--reporter=default", "--reporter=json", `--outputFile.json=${join(nativeOutput, "vitest.json")}`]),
            {...env, DOHC_SERVICE_HOST_PROOF_BINARY: stagedEnginePath, DOHC_SERVICE_HOST_PROOF_SHA256: nativeHash, DOHC_SERVICE_HOST_PROOF_OUTPUT: nativeOutput});
          report.selfHostNative = readSelfHostNativeProof(nativeOutput, stagedEnginePath, nativeHash); save();
        }
        const tags = mode === "pr" ? desktopProofTags(proofs) : {selected: ["@verification-smoke"], required: ["@verification-smoke"]};
        if (mode === "pr" && (proofs.accounts || tags.selected.length)) {
          await proofStep("browser-install", ...pnpm(["exec", "playwright", "install", ...(process.platform === "linux" ? ["--with-deps"] : []), "chromium"]), env);
        }
        if (mode === "pr" && proofs.accounts) {
          const accountReport = join(output, "accounts-playwright.json");
          await proofStep("accounts", process.execPath, ["apps/desktop/scripts/run-playwright.mjs", "--config", "services/workspace-api/playwright.config.ts", "--output", join(output, "accounts"), "--reporter=list,json"], { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: accountReport });
          report.accounts = JSON.parse(readFileSync(accountReport, "utf8")).stats;
          if (!report.accounts?.expected || report.accounts.unexpected || report.accounts.flaky || report.accounts.skipped) throw new Error("Account browser verification did not complete without failures or skips.");
        }
        if (mode === "pr" && proofs.statesPage && process.platform !== "win32") {
          report.statesPage = `not run: the states page compares pixels on win32 only, and this host is ${process.platform}`; save();
        }
        if (tags.selected.length) {
          // The states page compares its baselines on Windows, where they were
          // taken. Elsewhere its pixel test skips itself, which the skip check
          // below would count as a failure, so it is left out and the report
          // says so. @states-page selects both of its tests; the pixel test
          // alone carries @states-baselines, and that is the proof required.
          const forwarded = mode === "e2e" ? args.slice(1).filter((arg) => arg !== "--") : ["--grep", tags.selected.join("|")];
          const jsonReport = join(output, "playwright.json");
          await proofStep("desktop", ...desktopProofCommand(["--config", "apps/desktop/playwright.config.ts", "--output", join(output, "desktop"), ...forwarded, "--reporter=list,json"], { env }), { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonReport, DOHC_QA_OUTPUT: output, DOHC_REQUIRE_ENGINE_E2E: "1" });
          const desktopReport = JSON.parse(readFileSync(jsonReport, "utf8"));
          report.desktop = desktopReport.stats;
          report.desktopProofs = passedSpecTitles(desktopReport.suites);
          if (!report.desktop?.expected || report.desktop.unexpected || report.desktop.flaky) throw new Error("Desktop verification did not complete a passing test run.");
          if (mode !== "e2e" && report.desktop.skipped) throw new Error("A mandatory desktop smoke test was skipped.");
          if (mode === "pr" && tags.required.some((tag) => !report.desktopProofs.some((title) => title.split(/\s+/u).includes(tag)))) throw new Error(`The desktop gate did not pass every required proof: ${tags.required.join(", ")}.`);
        }
      }
      if (mode === "pr" && gates.js) {
        if (needs.postgres) {
          database = await measure("postgres-start", () => postgres(output, run, measure));
          report.postgres = { id: database.id }; save();
        }
        const env = { ...process.env, POSTGRES_URL: database?.url ?? "", DOHC_REQUIRE_POSTGRES: "1", DOHC_REQUIRE_ENGINE_E2E: "1", DOHC_TEST_ENGINE_BINARY: stagedEnginePath };
        await step("typecheck", ...pnpm(report.admission?.lightweight ? ["-r", "--workspace-concurrency=1", "--if-present", "typecheck"] : ["run", "typecheck"]), env);
        report.jsTests = join(output, "js-tests", "result.json");
        // Keep package groups under this owner so cancellation finishes their
        // escalation before database cleanup, without a competing parent timer.
        await checkedStep({ name: "tests", runner: "testWorkspace", report: report.jsTests },
          () => testWorkspace({ prepared: true, output: join(output, "js-tests"), env, selectedPackages: javascript.packages, testFiles: javascript.testFiles, repository: javascript.repository, desktopScripts: javascript.desktopScripts,
            bounded: report.admission?.lightweight ?? false,
            beforeDesktopScripts: () => measure("packaging-wait", () => rustSettled),
            ...(Object.values(proofs).some(Boolean) ? {runProofs: checkpoint => selectedProofs(env, checkpoint)} : {}) }));
      } else if (mode !== "pr") {
        await selectedProofs(desktopEnvironment, () => cancellation.checkpoint());
      }
    }
    const rustWork = rustJob();
    const rustSettled = rustWork.then(() => {}, () => {});
    const [rustResult, javascriptResult] = await Promise.allSettled([rustWork, javascriptJob()]);
    await cancellation.checkpoint();
    if (javascriptResult.status === "rejected") throw javascriptResult.reason;
    if (rustResult.status === "rejected") throw rustResult.reason;
    if (needs.engine || needs.desktop) await measure("prepared-build:finish", () => assertPrepared(preparedOptions));
    await checkTree("finish");
    report.verdict = "PASS";
  } catch (error) {
    report.verdict = "FAIL"; report.error = error.message;
    if (error.cleanupError) report.cleanupError = error.cleanupError;
    throw error;
  }
  finally {
    try {
      lane?.update?.({phase: "cleanup"});
      checkoutOwner?.update?.({phase: "cleanup"});
      try { await database?.stop(); }
      catch (error) { report.verdict = "FAIL"; report.cleanupError = error.message; process.exitCode = 1; }
      const interrupted = await cancellation.dispose();
      lane?.release();
      if (interrupted) { report.verdict = "FAIL"; report.error ??= interrupted.message; }
      finishTiming(); Object.assign(report, total);
      if (originalRustIdentity && !interrupted && !report.rustError && !report.cleanupError) {
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
      save(); console.log(`[verification] ${report.verdict} (${report.scope}): ${reportPath}`);
    } finally { checkoutOwner?.release(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) verify(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
