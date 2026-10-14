import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseMoveArguments, runMove } from "./move.mjs";

async function envFile(t, contents) {
  const root = await mkdtemp(join(tmpdir(), "dohc-move-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "deployment.env");
  await writeFile(path, contents);
  return path;
}
const folders = { dohc_self_host_sync_relay: "sync-relay", dohc_self_host_relay_continuity: "continuity", dohc_self_host_host_data: "host-data" };
const bind = folder => ({ type: "none", o: "bind", device: `/mnt/disk/dohc/${folder}` });
const config = { name: "dohc-self-host", services: { postgres: { image: "postgres:17.9-alpine" } }, volumes: {
  dohc_self_host_postgres: { name: "dohc-self-host_dohc_self_host_postgres" },
  ...Object.fromEntries(Object.entries(folders).map(([key, folder]) => [key, { name: `dohc-self-host_${key}`, driver: "local", driver_opts: bind(folder) }])),
} };
const deployment = ["/pg/PG_VERSION", "/continuity/deployment.json", "/data/sync-relay.sqlite"];
const accounts = { "dohc-self-host_dohc_self_host_postgres": { Driver: "local", Options: null } };

// Runs each Docker check against an in-memory host: `volumes` exist in Docker, `files` exist inside them.
// `fail` names a Docker call that fails without saying why, as a busy or restarting daemon does.
function host({ files = deployment, volumes = accounts, fail = () => false } = {}) {
  const calls = [], present = new Set(files);
  return { calls, run(command, args) {
    calls.push([command, ...args]);
    if (command !== "docker") return { status: 0, stdout: "" };
    if (args.includes("config")) return { status: 0, stdout: JSON.stringify(config) };
    if (fail(args)) return { status: 125, stdout: "", stderr: "Cannot connect to the Docker daemon." };
    if (args[0] === "volume" && args[1] === "inspect") {
      return volumes[args[2]] ? { status: 0, stdout: JSON.stringify([{ Name: args[2], ...volumes[args[2]] }]) }
        : { status: 1, stdout: "", stderr: `Error response from daemon: get ${args[2]}: no such volume` };
    }
    if (args[0] === "run" && args.includes("test")) return { status: args.at(-2) === "-s" && present.has(args.at(-1)) ? 0 : 1, stdout: "" };
    if (args.includes("relay-initialize")) return { status: relayCheck(args.at(-1), present), stdout: "" };
    throw new Error(`Unexpected Docker call: ${args.join(" ")}`);
  } };
}
function relayCheck(script, present) {
  const fs = { statSync: path => present.has(path) ? {} : undefined,
    readdirSync: folder => [...present].filter(path => path.startsWith(`${folder}/`)) };
  const process = { exitCode: 0 };
  new Function("require", "process", "console", script)(name => { assert.equal(name, "node:fs"); return fs; }, process, { error() {} });
  return process.exitCode;
}
const started = calls => calls.some(([command]) => command !== "docker");
const changed = calls => calls.some(([command, ...args]) => command === "docker" && (args.includes("up") || args.includes("rm") || args.includes("create")));

test("move checks volumes, accounts and the relay deployment through Docker before starting and checking the deployment", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=/mnt/disk/dohc\n"), mock = host();
  runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {});
  const check = mock.calls.find(call => call.includes("relay-initialize"));
  assert.ok(check.includes("tools/self-host/compose.data-disk.yml"));
  assert.deepEqual(check.slice(check.indexOf("run")), ["run", "--rm", "--no-deps", "-T", "--entrypoint", "node", "relay-initialize", "-e", check.at(-1)]);
  const probe = mock.calls.find(call => call.includes("test"));
  assert.ok(probe.includes("type=volume,source=dohc-self-host_dohc_self_host_postgres,target=/pg,readonly"));
  // The accounts volume is inspected before a container mounts it, so a missing volume is never created.
  assert.ok(mock.calls.findIndex(call => call.includes("dohc-self-host_dohc_self_host_postgres") && call.includes("inspect")) < mock.calls.indexOf(probe));
  assert.deepEqual(mock.calls.at(-1).slice(1), ["scripts/check-self-host.mjs", "--start", "--env-file", path]);
  assert.equal(changed(mock.calls), false);
});

test("move never starts when a file the deployment needs is missing", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=/mnt/disk/dohc\n");
  const incomplete = /The relay deployment in \/mnt\/disk\/dohc is missing its record or its database/;
  const refusals = [[["/pg/PG_VERSION"], /dohc-self-host_dohc_self_host_postgres holds no accounts database/],
    [["/continuity/deployment.json"], incomplete], [["/data/sync-relay.sqlite"], incomplete],
    [["/continuity/deployment.json", "/data/sync-relay.sqlite"], /No relay deployment found in \/mnt\/disk\/dohc/]];
  for (const [missing, refusal] of refusals) {
    const mock = host({ files: deployment.filter(file => !missing.includes(file)) });
    assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {}), refusal, missing.join());
    assert.equal(started(mock.calls), false, missing.join());
    assert.equal(changed(mock.calls), false, missing.join());
  }
});

test("move never starts when Docker cannot complete a check", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=/mnt/disk/dohc\n");
  const failures = [
    [args => args.includes("dohc-self-host_dohc_self_host_sync_relay"), /Docker could not inspect volume dohc-self-host_dohc_self_host_sync_relay/],
    [args => args[0] === "volume" && args.includes("dohc-self-host_dohc_self_host_postgres"), /Docker could not inspect volume dohc-self-host_dohc_self_host_postgres/],
    [args => args.includes("test"), /Could not check Docker volume dohc-self-host_dohc_self_host_postgres/],
    [args => args.includes("relay-initialize"), /Could not check the data disk in \/mnt\/disk\/dohc/],
  ];
  for (const [fail, refusal] of failures) {
    // Without the failure every check passes, as the first test shows, so the failed check alone must refuse.
    const mock = host({ fail });
    assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {}), refusal);
    assert.equal(started(mock.calls), false, String(refusal));
  }
});

test("move never mounts a missing accounts volume", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=/mnt/disk/dohc\n"), mock = host({ volumes: {} });
  assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {}), /holds no accounts database/);
  assert.deepEqual(mock.calls.filter(([, first]) => first === "run"), []);
  assert.equal(started(mock.calls), false);
});

test("move refuses existing volumes stored outside the data disk and leaves them unchanged", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=/mnt/disk/dohc\n");
  for (const relay of [{ Driver: "local", Options: null }, { Driver: "local", Options: { ...bind("sync-relay"), device: "/mnt/old-disk/dohc/sync-relay" } }]) {
    const mock = host({ volumes: { ...accounts, "dohc-self-host_dohc_self_host_sync_relay": relay } });
    assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {}),
      /Docker volume dohc-self-host_dohc_self_host_sync_relay keeps its data in .*, not \/mnt\/disk\/dohc\/sync-relay/);
    assert.ok(mock.calls.every(([command, ...args]) => command === "docker" && (args.includes("config") || args[0] === "volume" && args[1] === "inspect")));
  }
});

test("move refuses a deployment that keeps relay data in host volumes before Docker runs", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=\n"), mock = host();
  assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {}), /Set DOHC_DATA_DIRECTORY/);
  assert.deepEqual(mock.calls, []);
});

test("move accepts only an env file option", () => {
  for (const args of [["--env-file"], ["--env-file", "--start"], ["--project-name", "dohc"], ["extra"]]) {
    assert.throws(() => parseMoveArguments(args), /move\.mjs \[--env-file PATH\]/);
  }
});
