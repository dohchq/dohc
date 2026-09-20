import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseRecoveryArguments, runRecovery } from "./recovery.mjs";

const config = { name: "recovery-test", services: { "sync-relay": { image: "image", environment: { DOHC_RELAY_DEPLOYMENT_CONFIG: "/continuity/deployment.json" } } }, volumes: { data: { name: "recovery_data" } } };

test("help describes archive scope and service restart behavior", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./recovery.mjs", import.meta.url)), "--help"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const usage = result.stdout;
  assert.match(usage, /Backup, check-backup, and archive restart its previously running services after success\./);
  assert.match(usage, /Backup, check-backup, and restore affect only relay data\. Archive preserves all declared deployment volumes and configuration\./);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "dohc-recovery-wrapper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function runner({ failMaintenance = false, foreign = false, missingVolume = false } = {}) {
  const calls = [];
  return { calls, run(args) {
    calls.push(args);
    if (args.includes("config")) return JSON.stringify(config);
    if (args[0] === "volume" && args[1] === "inspect" && missingVolume) throw new Error("missing deployment volume");
    if (args[0] === "ps") return foreign ? "foreign-container\n" : "";
    if (args[0] === "inspect") return JSON.stringify([{ Mounts: [{ Type: "volume", Name: "recovery_data" }], Config: { Labels: { "com.docker.compose.project": "other" } } }]);
    if (args.includes("ps")) return "sync-relay\nshare-web\n";
    if (args.includes("run") && failMaintenance) throw new Error("refused");
    return "done";
  } };
}

test("backup stops before maintenance and resumes only previously running services", async t => {
  const root = await fixture(t), mock = runner();
  await runRecovery(parseRecoveryArguments(["backup", join(root, "snapshot")]), mock.run, () => {}, ["compose"]);
  assert.ok(mock.calls.findIndex(args => args.includes("stop")) < mock.calls.findIndex(args => args.includes("run")));
  assert.ok(mock.calls.findIndex(args => args[0] === "volume" && args[1] === "inspect") < mock.calls.findIndex(args => args.includes("stop")));
  assert.deepEqual(mock.calls.at(-1), ["compose", "start", "sync-relay", "share-web"]);
});

test("missing deployment volumes refuse every maintenance operation before stop", async t => {
  const root = await fixture(t);
  for (const action of ["backup", "check-backup", "restore", "archive"]) {
    const directory = join(root, action);
    if (["check-backup", "restore"].includes(action)) await mkdir(directory);
    const mock = runner({ missingVolume: true });
    await assert.rejects(runRecovery(parseRecoveryArguments([action, directory]), mock.run, () => {}, ["compose"]), /missing deployment volume/);
    assert.equal(mock.calls.some(args => args.includes("stop") || args.includes("run") || args.includes("start")), false);
  }
});

test("ambiguous bind-mount parents are refused before Docker changes", async t => {
  const root = await fixture(t);
  for (const parent of ["colon:parent", "comma,parent"]) {
    const mock = runner();
    await assert.rejects(runRecovery(parseRecoveryArguments(["backup", join(root, parent, "snapshot")]), mock.run, () => {}, ["compose"]), /parent must not contain/);
    assert.deepEqual(mock.calls, []);
  }
});

test("archive failure after stop never restarts services", async t => {
  const root = await fixture(t), mock = runner();
  const options = parseRecoveryArguments(["archive", join(root, "archive"), "--env-file", join(root, "missing.env")]);
  await assert.rejects(runRecovery(options, mock.run, () => {}, ["compose"]), /ENOENT/);
  assert.equal(mock.calls.some(args => args.includes("stop")), true);
  assert.equal(mock.calls.some(args => args.includes("start")), false);
});
test("restore and failed maintenance remain stopped", async t => {
  const root = await fixture(t), directory = join(root, "snapshot");
  await mkdir(directory);
  for (const failMaintenance of [false, true]) {
    const mock = runner({ failMaintenance });
    const run = runRecovery(parseRecoveryArguments(["restore", directory]), mock.run, () => {}, ["compose"]);
    if (failMaintenance) await assert.rejects(run, /refused/); else await run;
    assert.equal(mock.calls.some(args => args.includes("start")), false);
  }
});
test("a foreign volume user is refused before stop", async t => {
  const root = await fixture(t), mock = runner({ foreign: true });
  await assert.rejects(runRecovery(parseRecoveryArguments(["backup", join(root, "snapshot")]), mock.run, () => {}, ["compose"]), /Another running project/);
  assert.equal(mock.calls.some(args => args.includes("stop")), false);
});
test("a same-project orphan writer is refused after stop", async t => {
  const root = await fixture(t), mock = runner();
  let stopped = false;
  const run = args => {
    if (args.includes("stop")) stopped = true;
    if (stopped && args[0] === "ps") return "orphan\n";
    if (stopped && args[0] === "inspect") return JSON.stringify([{ Mounts: [{ Type: "volume", Name: "recovery_data" }] }]);
    return mock.run(args);
  };
  await assert.rejects(runRecovery(parseRecoveryArguments(["backup", join(root, "snapshot")]), run, () => {}, ["compose"]), /still uses/);
  assert.equal(mock.calls.some(args => args.includes("run")), false);
});
