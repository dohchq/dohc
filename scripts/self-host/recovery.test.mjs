import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseRecoveryArguments, runRecovery } from "./recovery.mjs";

const config = { name: "recovery-test", services: { "sync-relay": { image: "image", environment: { DOHC_RELAY_DEPLOYMENT_CONFIG: "/continuity/deployment.json" } } }, volumes: { data: { name: "recovery_data" } } };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "dohc-recovery-wrapper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function runner({ failMaintenance = false, foreign = false } = {}) {
  const calls = [];
  return { calls, run(args) {
    calls.push(args);
    if (args.includes("config")) return JSON.stringify(config);
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
  assert.deepEqual(mock.calls.at(-1), ["compose", "start", "sync-relay", "share-web"]);
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
