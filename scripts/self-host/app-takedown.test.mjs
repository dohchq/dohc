import assert from "node:assert/strict";
import test from "node:test";
import { parseTakedownArguments, runTakedown } from "./app-takedown.mjs";

const id = "a".repeat(64);
const config = {name: "takedown", services: {"sync-relay": {environment: {DOHC_RELAY_DEPLOYMENT_CONFIG: "/continuity/deployment.json"}}}, volumes: {relay: {name: "relay-data"}}};
function runner({failed = false, foreign = false} = {}) {
  const calls = [];
  return {calls, run(args) {
    calls.push(args);
    if (args.includes("config")) return JSON.stringify(config);
    if (args[0] === "ps") return foreign ? "foreign-container" : "";
    if (args[0] === "inspect") return JSON.stringify([{Mounts: [{Type: "volume", Name: "relay-data"}], Config: {Labels: {"com.docker.compose.project": "another"}}}]);
    if (args.includes("ps")) return "sync-relay\nshare-web\n";
    if (args.includes("run") && failed) throw new Error("refused");
    return "disabled";
  }};
}
const options = () => parseTakedownArguments(["--publication-id", id, "--reason", "Confirmed phishing"]);

test("requires one publication and a nonempty bounded reason", () => {
  for (const args of [[], ["--publication-id", "bad", "--reason", "Malware"], ["--publication-id", id], ["--publication-id", id, "--reason", " "], ["--publication-id", id, "--reason", "x".repeat(1025)]]) {
    assert.throws(() => parseTakedownArguments(args));
  }
});
test("stops the selected project, passes the reason as one argument, and resumes only its running services", async () => {
  const mock = runner();
  await runTakedown(options(), mock.run, () => {}, ["compose"]);
  const stop = mock.calls.findIndex(args => args.includes("stop")), command = mock.calls.findIndex(args => args.includes("run"));
  assert.ok(stop >= 0 && command > stop);
  assert.deepEqual(mock.calls[command].slice(-6), ["--deployment-config", "/continuity/deployment.json", "--publication-id", id, "--reason", "Confirmed phishing"]);
  assert.deepEqual(mock.calls.at(-1), ["compose", "start", "sync-relay", "share-web"]);
});
test("keeps services stopped when the takedown command fails", async () => {
  const mock = runner({failed: true});
  await assert.rejects(runTakedown(options(), mock.run, () => {}, ["compose"]), /refused/);
  assert.equal(mock.calls.some(args => args.includes("start")), false);
});
test("refuses another project's writer before stopping services", async () => {
  const mock = runner({foreign: true});
  await assert.rejects(runTakedown(options(), mock.run, () => {}, ["compose"]), /Another running project/);
  assert.equal(mock.calls.some(args => args.includes("stop") || args.includes("run")), false);
});
