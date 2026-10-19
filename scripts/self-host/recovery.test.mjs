import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseRecoveryArguments, runRecovery } from "./recovery.mjs";
import { archiveDeployment } from "./archive.mjs";
import { writeFileSync } from "node:fs";

const config = { name: "recovery-test", services: { "sync-relay": { image: "image", environment: { DOHC_RELAY_DEPLOYMENT_CONFIG: "/continuity/deployment.json" } } }, volumes: { data: { name: "recovery_data" } } };

test("deployment archives skip the disposable replicas volume", async t => {
  const root = await fixture(t), directory = join(root, "archive"), envFile = join(root, "environment");
  await writeFile(envFile, "LOCAL_PROOF=1\n");
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args[0] === "run") writeFileSync(join(directory, args.find(arg => /^volume-\d+\.tar\.gz$/.test(arg))), "archive test bytes");
    return "[]";
  };
  await archiveDeployment({directory, envFile}, {...config, volumes: {...config.volumes,
    replicas: {name: "disposable_replicas", labels: {"dohc.backup": "skip"}}}}, run);
  assert.deepEqual(calls.find(args => args[0] === "volume"), ["volume", "inspect", "recovery_data"]);
  assert.equal(calls.filter(args => args[0] === "run").length, 1);
  assert(!calls.flat().some(arg => arg.includes("source=disposable_replicas")));
});

test("help describes archive scope and service restart behavior", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./recovery.mjs", import.meta.url)), "--help"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const usage = result.stdout;
  assert.match(usage, /Backup, check-backup, and archive restart its previously running services after success\./);
  assert.match(usage, /Backup, check-backup, and restore affect only relay data\. Archive preserves deployment data and configuration, excluding disposable replicas\./);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "dohc-recovery-wrapper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const bound = (device, o = "bind") => ({ Driver: "local", Options: { type: "none", o, device } });
function runner({ failMaintenance = false, foreign = false, missingVolume = false, mounts = [{ Type: "volume", Name: "recovery_data", RW: true }], volumes = {} } = {}) {
  const calls = [];
  const known = { recovery_data: bound("/mnt/disk/dohc/sync-relay"), ...volumes };
  return { calls, run(args) {
    calls.push(args);
    if (args.includes("config")) return JSON.stringify(config);
    if (args[0] === "volume" && args[1] === "inspect") {
      if (missingVolume) throw new Error("missing deployment volume");
      return JSON.stringify(args.slice(2).map(name => { if (!known[name]) throw new Error("no such volume"); return { Name: name, ...known[name] }; }));
    }
    if (args[0] === "ps") return foreign ? "foreign-container\n" : "";
    if (args[0] === "inspect") return JSON.stringify([{ Name: "/portainer_agent", Mounts: mounts, Config: { Labels: { "com.docker.compose.project": "other" } } }]);
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
test("snapshot runs online and never stops, restarts or deletes anything", async t => {
  const root = await fixture(t), mock = runner(), envFile = join(root, "env");
  await writeFile(envFile, "DOHC_SNAPSHOT_KEY=key-from-env\n");
  await runRecovery(parseRecoveryArguments(["snapshot", join(root, "offsite"), "--env-file", envFile]), mock.run, () => {}, ["compose"]);
  assert.equal(mock.calls.some(args => args.includes("stop") || args.includes("start") || args.includes("rm") || args.includes("down")), false);
  const run = mock.calls.find(args => args.includes("run"));
  assert.deepEqual(run.slice(run.indexOf("relay-snapshot")), ["relay-snapshot", "snapshot", "--database", "/data/sync-relay.sqlite",
    "--state-directory", "/snapshots", "--directory", "/backup/offsite"]);
  assert.ok(run.includes(`${root}:/backup`));
});

test("verify mounts no deployment volume and passes only the snapshot key", async t => {
  const root = await fixture(t), envFile = join(root, "env");
  await writeFile(envFile, "DOHC_SNAPSHOT_KEY=key-from-env\nPOSTGRES_PASSWORD=not-passed\n");
  const snapshot = join(root, "taken.dohc-snapshot");
  await writeFile(snapshot, "sealed");
  const calls = [];
  const run = (args, env) => { calls.push({ args, env }); return args.includes("config") ? JSON.stringify(config) : "verified"; };
  await runRecovery(parseRecoveryArguments(["verify", join(root, "checked"), "--snapshot", snapshot, "--env-file", envFile]), run, () => {}, ["compose"]);
  const verify = calls.at(-1);
  assert.deepEqual(verify.env, { DOHC_SNAPSHOT_KEY: "key-from-env" });
  assert.equal(verify.args.filter(value => value.startsWith("type=volume")).length, 0);
  assert.deepEqual(verify.args.slice(verify.args.indexOf("--network"), verify.args.indexOf("--network") + 2), ["--network", "none"]);
  assert.ok(verify.args.includes(`type=bind,source=${root},target=/source,readonly`));
  assert.equal(calls.some(({ args }) => args.includes("stop") || args[0] === "volume"), false);
  await mkdir(join(root, "existing"));
  await assert.rejects(runRecovery(parseRecoveryArguments(["verify", join(root, "existing"), "--snapshot", snapshot, "--env-file", envFile]), run, () => {}, ["compose"]), /new directory/);
  assert.throws(() => parseRecoveryArguments(["verify", join(root, "checked")]));
  assert.throws(() => parseRecoveryArguments(["backup", join(root, "b"), "--snapshot", snapshot]));
});

test("snapshot and verify refuse to run without a snapshot key", async t => {
  const root = await fixture(t), envFile = join(root, "env"), snapshot = join(root, "taken.dohc-snapshot");
  await writeFile(envFile, "DOHC_SNAPSHOT_KEY=\n");
  await writeFile(snapshot, "sealed");
  for (const args of [["snapshot", join(root, "offsite")], ["verify", join(root, "checked"), "--snapshot", snapshot]]) {
    const mock = runner();
    await assert.rejects(runRecovery(parseRecoveryArguments([...args, "--env-file", envFile]), mock.run, () => {}, ["compose"]),
      /Set DOHC_SNAPSHOT_KEY in .* to the snapshot key/);
    assert.deepEqual(mock.calls, []);
  }
});

test("invalid settings are refused before Docker runs", async t => {
  const root = await fixture(t), mock = runner(), envFile = join(root, "deployment.env");
  await writeFile(envFile, "DOHC_POSTGRES_HOST=db.provider.invalid:5432/dohc?sslmode=disable&unused=\n");
  await assert.rejects(runRecovery(parseRecoveryArguments(["backup", join(root, "snapshot"), "--env-file", envFile]), mock.run, () => {}),
    /Set DOHC_POSTGRES_HOST to your database host name/);
  assert.deepEqual(mock.calls, []);
});
test("a foreign volume writer is refused before stop and named with its mount", async t => {
  const root = await fixture(t), mock = runner({ foreign: true });
  await assert.rejects(runRecovery(parseRecoveryArguments(["backup", join(root, "snapshot")]), mock.run, () => {}, ["compose"]),
    { message: "Running containers outside recovery-test can write its storage. Stop them before recovery: portainer_agent (recovery_data)." });
  assert.equal(mock.calls.some(args => args.includes("stop")), false);
});
test("another project writing the disk folder, or a folder inside or above it, is refused before stop", async t => {
  const root = await fixture(t);
  for (const options of [
    { mounts: [{ Type: "volume", Name: "other_relay", RW: true }], volumes: { other_relay: bound("/mnt/disk/dohc/sync-relay/") } },
    { mounts: [{ Type: "volume", Name: "other_relay", RW: true }], volumes: { other_relay: bound("/mnt/disk/dohc", "rbind") } },
    { mounts: [{ Type: "volume", Name: "other_relay", RW: true }], volumes: { other_relay: bound("/mnt/disk/dohc/sync-relay", "rw,rbind") } },
    { mounts: [{ Type: "bind", Source: "/mnt/disk/data", RW: true }], volumes: { recovery_data: bound("/mnt/disk/data/sync-relay", "rbind") } },
    { mounts: [{ Type: "bind", Source: "/mnt/disk/dohc/sync-relay", RW: true }] },
    { mounts: [{ Type: "bind", Source: "/mnt/disk/dohc", RW: true }] },
    { mounts: [{ Type: "bind", Source: "/", RW: true }] },
    { mounts: [{ Type: "volume", Name: "other_disk", RW: true }], volumes: { other_disk: bound("/mnt/disk/dohc") } },
    { mounts: [{ Type: "bind", Source: "/mnt/disk/dohc/sync-relay/files", RW: true }] },
    { mounts: [{ Type: "bind", Source: "/var/lib/docker/volumes", RW: true }],
      volumes: { recovery_data: { Driver: "local", Mountpoint: "/var/lib/docker/volumes/recovery_data/_data", Options: null } } },
  ]) {
    const mock = runner({ foreign: true, ...options }), [mount] = options.mounts;
    await assert.rejects(runRecovery(parseRecoveryArguments(["archive", join(root, "archive")]), mock.run, () => {}, ["compose"]),
      { message: `Running containers outside recovery-test can write its storage. Stop them before recovery: portainer_agent (${mount.Name ?? mount.Source}).` },
      JSON.stringify(options.mounts));
    assert.equal(mock.calls.some(args => args.includes("stop")), false);
  }
});
test("another project writing the data disk's snapshot folder is refused before stop", async t => {
  const root = await fixture(t);
  const disk = { ...config, volumes: { ...config.volumes, snapshots: { name: "recovery_snapshots", driver: "local", driver_opts: bound("/mnt/disk/dohc/snapshots").Options } } };
  const mock = runner({ foreign: true, mounts: [{ Type: "bind", Source: "/mnt/disk/dohc/snapshots/staging", RW: true }],
    volumes: { recovery_snapshots: bound("/mnt/disk/dohc/snapshots") } });
  const run = args => args.includes("config") ? JSON.stringify(disk) : mock.run(args);
  await assert.rejects(runRecovery(parseRecoveryArguments(["backup", join(root, "snapshot")]), run, () => {}, ["compose"]),
    { message: "Running containers outside recovery-test can write its storage. Stop them before recovery: portainer_agent (/mnt/disk/dohc/snapshots/staging)." });
  assert.equal(mock.calls.some(args => args.includes("stop")), false);
});
test("read-only mounts and other folders do not block recovery", async t => {
  const root = await fixture(t);
  for (const [index, options] of [
    { mounts: [{ Type: "volume", Name: "other_relay", RW: true }, { Type: "bind", Source: "/mnt/disk/other", RW: true }, { Type: "bind", Source: "/mnt/disk/dohc-old", RW: true }],
      volumes: { other_relay: bound("/mnt/disk/other/sync-relay") } },
    { mounts: [{ Type: "bind", Source: "/mnt/disk/dohc", RW: false }, { Type: "bind", Source: "/", RW: false }] },
    { mounts: [{ Type: "volume", Name: "other_disk", RW: false }], volumes: { other_disk: bound("/mnt/disk/dohc") } },
    { mounts: [{ Type: "volume", Name: "other_disk", RW: false }], volumes: { other_disk: bound("/mnt/disk/dohc", "rbind") } },
    { mounts: [{ Type: "volume", Name: "recovery_data", RW: false }] },
  ].entries()) {
    const mock = runner({ foreign: true, ...options });
    await runRecovery(parseRecoveryArguments(["backup", join(root, `snapshot-${index}`)]), mock.run, () => {}, ["compose"]);
    assert.ok(mock.calls.some(args => args.includes("run")), JSON.stringify(options.mounts));
  }
});
test("a same-project orphan writer is refused after stop", async t => {
  const root = await fixture(t), mock = runner();
  let stopped = false;
  const run = args => {
    if (args.includes("stop")) stopped = true;
    if (stopped && args[0] === "ps") return "orphan\n";
    if (stopped && args[0] === "inspect") return JSON.stringify([{ Name: "/recovery-test-orphan-1", Mounts: [{ Type: "volume", Name: "recovery_data", RW: true }] }]);
    return mock.run(args);
  };
  await assert.rejects(runRecovery(parseRecoveryArguments(["backup", join(root, "snapshot")]), run, () => {}, ["compose"]),
    { message: "Running containers can still write this deployment's storage. Services remain stopped; stop them before recovery: recovery-test-orphan-1 (recovery_data)." });
  assert.equal(mock.calls.some(args => args.includes("run")), false);
});
