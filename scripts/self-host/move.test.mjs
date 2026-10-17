import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initialSettings } from "../../tools/self-host/bootstrap.mjs";
import { parseMoveArguments, runMove } from "./move.mjs";

// Valid settings for a public deployment. Each test's `contents` add to them or replace them.
const valid = readFileSync(new URL("../../.env.self-host.example", import.meta.url), "utf8") +
  Object.entries({ ...initialSettings({ origin: "https://dohc.team.invalid", image: "dohc-self-host:v1" }),
    DOHC_SMTP_HOST: "mail.team.invalid", DOHC_SMTP_FROM: "dohc@team.invalid" }).map(([key, value]) => `${key}=${value}\n`).join("");
async function envFile(t, contents) {
  const root = await mkdtemp(join(tmpdir(), "dohc-move-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "deployment.env");
  await writeFile(path, valid + contents);
  return path;
}
const folders = { dohc_self_host_sync_relay: "sync-relay", dohc_self_host_relay_continuity: "continuity", dohc_self_host_host_data: "host-data",
  dohc_self_host_snapshots: "snapshots" };
const bind = folder => ({ type: "none", o: "bind", device: `/mnt/disk/dohc/${folder}` });
const config = { name: "dohc-self-host", services: { postgres: { image: "postgres:17.9-alpine" } }, volumes: {
  dohc_self_host_postgres: { name: "dohc-self-host_dohc_self_host_postgres" },
  ...Object.fromEntries(Object.entries(folders).map(([key, folder]) => [key, { name: `dohc-self-host_${key}`, driver: "local", driver_opts: bind(folder) }])),
} };
// The external-database overlay leaves out the bundled database and its volume.
const externalConfig = { ...config, services: {}, volumes: Object.fromEntries(Object.entries(config.volumes).filter(([key]) => key !== "dohc_self_host_postgres")) };
const externalSettings = "DOHC_DATA_DIRECTORY=/mnt/disk/dohc\nDOHC_POSTGRES_HOST=db.provider.invalid\nDOHC_POSTGRES_PORT=25060\n" +
  "DOHC_POSTGRES_CA_FILE=/etc/dohc/postgres-ca.pem\nPOSTGRES_DB=dohc\n";
const deployment = ["/pg/PG_VERSION", "/continuity/deployment.json", "/data/sync-relay.sqlite"];
const accounts = { "dohc-self-host_dohc_self_host_postgres": { Driver: "local", Options: null } };

// Runs each Docker check against an in-memory host: `volumes` exist in Docker, `files` exist inside them,
// and `containers` are running. `fail` names a Docker call that fails without saying why, as a busy or restarting daemon does.
// `external` is what the external database's accounts check prints.
function host({ files = deployment, volumes = accounts, containers = [], fail = () => false, external } = {}) {
  const calls = [], present = new Set(files);
  return { calls, run(command, args) {
    calls.push([command, ...args]);
    if (command !== "docker") return { status: 0, stdout: "" };
    if (args.includes("config")) return { status: 0, stdout: JSON.stringify(external ? externalConfig : config) };
    if (fail(args)) return { status: 125, stdout: "", stderr: "Cannot connect to the Docker daemon." };
    if (external && args.includes("check-accounts")) return { status: 0, stdout: `${external}\n` };
    if (args[0] === "volume" && args[1] === "inspect") {
      const names = args.slice(2), missing = names.find(name => !volumes[name]);
      return missing ? { status: 1, stdout: "", stderr: `Error response from daemon: get ${missing}: no such volume` }
        : { status: 0, stdout: JSON.stringify(names.map(name => ({ Name: name, ...volumes[name] }))) };
    }
    if (args[0] === "ps") return { status: 0, stdout: containers.map(container => `${container.Id}\n`).join("") };
    if (args[0] === "inspect") return { status: 0, stdout: JSON.stringify(containers.filter(container => args.includes(container.Id))) };
    if (args[0] === "run" && args.includes("sh")) {
      const [, file] = /^if test -s (\S+); then echo present; else echo missing; fi$/.exec(args.at(-1));
      return { status: 0, stdout: present.has(file) ? "present\n" : "missing\n" };
    }
    if (args.includes("relay-initialize")) return relayCheck(args.at(-1), present);
    throw new Error(`Unexpected Docker call: ${args.join(" ")}`);
  } };
}
function relayCheck(script, present) {
  const fs = { statSync: path => present.has(path) ? {} : undefined,
    readdirSync: folder => [...present].filter(path => path.startsWith(`${folder}/`)) };
  const process = { exitCode: 0 }, output = [];
  new Function("require", "process", "console", script)(name => { assert.equal(name, "node:fs"); return fs; }, process,
    { error() {}, log: line => output.push(`${line}\n`) });
  return { status: process.exitCode, stdout: output.join("") };
}
const container = (name, ...mounts) => ({ Id: name, Name: `/${name}`, Mounts: mounts });
const started = calls => calls.some(([command]) => command !== "docker");
const changed = calls => calls.some(([command, ...args]) => command === "docker" && (args.includes("up") || args.includes("rm") || args.includes("create")));

test("move checks volumes, accounts and the relay deployment through Docker before starting and checking the deployment", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=/mnt/disk/dohc\n"), mock = host();
  runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {});
  const check = mock.calls.find(call => call.includes("relay-initialize"));
  assert.ok(check.includes("tools/self-host/compose.data-disk.yml"));
  assert.deepEqual(check.slice(check.indexOf("run")), ["run", "--rm", "--no-deps", "-T", "--entrypoint", "node", "relay-initialize", "-e", check.at(-1)]);
  // Running containers are checked for writers before any check container runs.
  assert.ok(mock.calls.findIndex(([, first]) => first === "ps") >= 0);
  assert.ok(mock.calls.findIndex(([, first]) => first === "ps") < mock.calls.findIndex(([, first]) => first === "run"));
  const probe = mock.calls.find(call => call.includes("sh"));
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
  // Snapshot state and host data on the disk are not a relay deployment.
  const leftovers = host({ files: ["/pg/PG_VERSION", "/snapshots/notifications.json", "/host-data/automations/replica.db"] });
  assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), leftovers.run, () => {}), /No relay deployment found in \/mnt\/disk\/dohc/);
  assert.equal(started(leftovers.calls), false);
});

test("move never starts when Docker cannot complete a check", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=/mnt/disk/dohc\n");
  const failures = [
    [args => args.includes("dohc-self-host_dohc_self_host_sync_relay"), /Docker could not inspect volume dohc-self-host_dohc_self_host_sync_relay/],
    [args => args[0] === "volume" && args.includes("dohc-self-host_dohc_self_host_postgres"), /Docker could not inspect volume dohc-self-host_dohc_self_host_postgres/],
    [args => args.includes("sh"), /Could not check Docker volume dohc-self-host_dohc_self_host_postgres/],
    [args => args.includes("relay-initialize"), /Could not check the data disk in \/mnt\/disk\/dohc/],
    [args => args[0] === "ps", /Docker could not check which running containers can write this deployment's storage/],
    [args => args[0] === "inspect", /Docker could not check which running containers can write this deployment's storage/],
    [args => args[0] === "volume" && args.includes("monitor_cache"), /Docker could not check which running containers can write/],
  ];
  // A running container with only an unrelated volume makes the writer check inspect that volume and the container.
  const containers = [container("monitor", { Type: "volume", Name: "monitor_cache", RW: true })];
  const volumes = { ...accounts, monitor_cache: { Driver: "local", Options: null } };
  for (const [fail, refusal] of failures) {
    // Without the failure every check passes, as the first test shows, so the failed check alone must refuse.
    const mock = host({ fail, containers, volumes });
    assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {}), refusal);
    assert.equal(started(mock.calls), false, String(refusal));
  }
});

test("move refuses while a running container can write the deployment's storage and names each one", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=/mnt/disk/dohc\n");
  const relay = { Driver: "local", Options: bind("sync-relay") };
  const writers = [
    // The old project still runs on this host, with this deployment's own volume.
    [{ volumes: { ...accounts, "dohc-self-host_dohc_self_host_sync_relay": relay },
      containers: [container("dohc-self-host-sync-relay-1", { Type: "volume", Name: "dohc-self-host_dohc_self_host_sync_relay", RW: true })] },
    "dohc-self-host-sync-relay-1 (dohc-self-host_dohc_self_host_sync_relay)"],
    // Another Compose project binds the same disk folder through its own volume.
    [{ volumes: { ...accounts, old_continuity: { Driver: "local", Options: bind("continuity") } },
      containers: [container("old-sync-relay-1", { Type: "volume", Name: "old_continuity", RW: true })] }, "old-sync-relay-1 (old_continuity)"],
    [{ volumes: { ...accounts, old_disk: { Driver: "local", Options: { type: "none", o: "rbind", device: "/mnt/disk" } } },
      containers: [container("old-sync-relay-1", { Type: "volume", Name: "old_disk", RW: true })] }, "old-sync-relay-1 (old_disk)"],
    // A bind of a parent folder, and of a folder whose volume Docker has not created yet.
    [{ containers: [container("backup", { Type: "bind", Source: "/mnt/disk", RW: true }), container("agent", { Type: "bind", Source: "/", RW: true })] },
      "backup (/mnt/disk), agent (/)"],
    [{ containers: [container("old-sync-relay-1", { Type: "bind", Source: "/mnt/disk/dohc/host-data", RW: true })] }, "old-sync-relay-1 (/mnt/disk/dohc/host-data)"],
    // The old host's snapshot job still writes its staging on the disk.
    [{ volumes: { ...accounts, old_snapshots: { Driver: "local", Options: bind("snapshots") } },
      containers: [container("old-relay-snapshot-1", { Type: "volume", Name: "old_snapshots", RW: true })] }, "old-relay-snapshot-1 (old_snapshots)"],
  ];
  for (const [options, named] of writers) {
    const mock = host(options);
    assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {}),
      { message: `Running containers can write this deployment's storage. Stop them before you start the deployment here: ${named}.` });
    // The refusal comes before any container runs, including the relay check.
    assert.equal(mock.calls.some(call => call.includes("run") || call.includes("relay-initialize")), false, named);
    assert.equal(started(mock.calls), false, named);
  }
});

test("move starts beside read-only mounts and containers that write other folders", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=/mnt/disk/dohc\n");
  const mock = host({ containers: [
    container("monitor", { Type: "bind", Source: "/mnt/disk/dohc", RW: false }, { Type: "bind", Source: "/", RW: false },
      { Type: "volume", Name: "dohc-self-host_dohc_self_host_postgres", RW: false }),
    container("other", { Type: "bind", Source: "/mnt/disk/dohc-old", RW: true }, { Type: "bind", Source: "/mnt/disk/other/sync-relay", RW: true }),
  ] });
  runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {});
  assert.equal(started(mock.calls), true);
});

test("move never mounts a missing accounts volume", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=/mnt/disk/dohc\n"), mock = host({ volumes: {} });
  assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {}), /holds no accounts database/);
  assert.deepEqual(mock.calls.filter(([, first]) => first === "run"), []);
  assert.equal(started(mock.calls), false);
});

test("with an external database, move needs dohc accounts there and keeps every relay check", async t => {
  const path = await envFile(t, externalSettings);
  const accountsCheck = calls => calls.find(call => call.includes("check-accounts"));
  const moved = host({ external: "present", files: deployment.slice(1) });
  runMove(parseMoveArguments(["--env-file", path]), moved.run, () => {});
  assert.ok(accountsCheck(moved.calls).includes("tools/self-host/compose.external-postgres.yml"));
  assert.ok(moved.calls.some(call => call.includes("relay-initialize")));
  // No local accounts volume exists, so nothing inspects or mounts one.
  assert.ok(!moved.calls.some(call => call.some(value => value.includes("dohc_self_host_postgres"))));
  assert.deepEqual(moved.calls.at(-1).slice(1), ["scripts/check-self-host.mjs", "--start", "--env-file", path]);
  const refusals = [[{ external: "missing" }, /Database dohc on db\.provider\.invalid holds no dohc accounts/],
    [{ external: "present", fail: args => args.includes("check-accounts") }, /Could not check database dohc on db\.provider\.invalid/],
    [{ external: "present", files: ["/continuity/deployment.json"] }, /missing its record or its database/]];
  for (const [options, refusal] of refusals) {
    const mock = host(options);
    assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {}), refusal);
    assert.equal(started(mock.calls), false, String(refusal));
    assert.equal(changed(mock.calls), false, String(refusal));
  }
  // A running writer refuses before the accounts check connects to the database.
  const written = host({ external: "present", containers: [container("old-sync-relay-1", { Type: "bind", Source: "/mnt/disk/dohc/sync-relay", RW: true })] });
  assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), written.run, () => {}), /Running containers can write this deployment's storage/);
  assert.equal(accountsCheck(written.calls), undefined);
});

test("move refuses existing volumes stored outside the data disk and leaves them unchanged", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=/mnt/disk/dohc\n");
  for (const folder of ["sync-relay", "snapshots"]) {
    const name = `dohc-self-host_${Object.keys(folders).find(key => folders[key] === folder)}`;
    for (const volume of [{ Driver: "local", Options: null }, { Driver: "local", Options: { ...bind(folder), device: `/mnt/old-disk/dohc/${folder}` } }]) {
      const mock = host({ volumes: { ...accounts, [name]: volume } });
      assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {}),
        new RegExp(`Docker volume ${name} keeps its data in .*, not /mnt/disk/dohc/${folder}`));
      assert.ok(mock.calls.every(([command, ...args]) => command === "docker" && (args.includes("config") || args[0] === "volume" && args[1] === "inspect")));
    }
  }
});

test("move refuses a deployment that keeps relay data in host volumes before Docker runs", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=\n"), mock = host();
  assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {}), /Set DOHC_DATA_DIRECTORY/);
  assert.deepEqual(mock.calls, []);
});

test("move refuses invalid settings before Docker or the database sees them", async t => {
  // The host would turn TLS off in the connection URL. The database name would fall back to another database.
  const refusals = [["DOHC_POSTGRES_HOST=db.provider.invalid:5432/dohc?sslmode=disable&unused=\n", /Set DOHC_POSTGRES_HOST to your database host name/],
    ["POSTGRES_DB=..\n", /Use only letters, digits, underscores, hyphens and dots in POSTGRES_DB/]];
  for (const [setting, refusal] of refusals) {
    const path = await envFile(t, externalSettings + setting), mock = host({ external: "present" });
    assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {}), refusal);
    assert.deepEqual(mock.calls, [], setting);
  }
});

test("move accepts only an env file option", () => {
  for (const args of [["--env-file"], ["--env-file", "--start"], ["--project-name", "dohc"], ["extra"]]) {
    assert.throws(() => parseMoveArguments(args), /move\.mjs \[--env-file PATH\]/);
  }
});
