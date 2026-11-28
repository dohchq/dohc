import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { initialSettings } from "../../tools/self-host/bootstrap.mjs";
import { apnsKeyTarget } from "../../tools/self-host/config.mjs";
import { archiveDeployment } from "./archive.mjs";
import { parseRecoveryArguments, recoveryComposeArgs, runRecovery } from "./recovery.mjs";

const config = {
  name: "recovery-test",
  services: {
    "sync-relay": {
      image: "image",
      environment: { DOHC_RELAY_DEPLOYMENT_CONFIG: "/continuity/deployment.json" },
    },
  },
  volumes: { data: { name: "recovery_data" } },
};

test("help describes archive scope and service restart behavior", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./recovery.mjs", import.meta.url)), "--help"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  const usage = result.stdout;
  assert.match(
    usage,
    /Backup, check-backup, and archive restart its previously running services after success\./,
  );
  assert.match(
    usage,
    /Backup, check-backup, and restore affect only relay data\. Archive preserves deployment data and configuration\./,
  );
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "dohc-recovery-wrapper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const bound = (device, o = "bind") => ({ Driver: "local", Options: { type: "none", o, device } });
function runner({
  failMaintenance = false,
  foreign = false,
  missingVolume = false,
  mounts = [{ Type: "volume", Name: "recovery_data", RW: true }],
  volumes = {},
  served = config,
  running = "sync-relay\nshare-web\n",
} = {}) {
  const calls = [];
  const known = { recovery_data: bound("/mnt/disk/dohc/sync-relay"), ...volumes };
  return {
    calls,
    run(args) {
      calls.push(args);
      if (args.includes("config")) return JSON.stringify(served);
      if (args[0] === "volume" && args[1] === "inspect") {
        if (missingVolume) throw new Error("missing deployment volume");
        return JSON.stringify(
          args.slice(2).map((name) => {
            if (!known[name]) throw new Error("no such volume");
            return { Name: name, ...known[name] };
          }),
        );
      }
      if (args[0] === "ps") return foreign ? "foreign-container\n" : "";
      if (args[0] === "inspect")
        return JSON.stringify([
          {
            Name: "/portainer_agent",
            Mounts: mounts,
            Config: { Labels: { "com.docker.compose.project": "other" } },
          },
        ]);
      if (args.includes("ps")) return running;
      if (args.includes("run") && failMaintenance) throw new Error("refused");
      return "done";
    },
  };
}

test("backup stops before maintenance and resumes only previously running services", async (t) => {
  const root = await fixture(t),
    mock = runner();
  await runRecovery(
    parseRecoveryArguments(["backup", join(root, "snapshot")]),
    mock.run,
    () => {},
    ["compose"],
  );
  assert.ok(
    mock.calls.findIndex((args) => args.includes("stop")) <
      mock.calls.findIndex((args) => args.includes("run")),
  );
  assert.ok(
    mock.calls.findIndex((args) => args[0] === "volume" && args[1] === "inspect") <
      mock.calls.findIndex((args) => args.includes("stop")),
  );
  assert.deepEqual(mock.calls.at(-1), ["compose", "start", "sync-relay", "share-web"]);
});

test("backup leaves a deployment that was already stopped stopped", async (t) => {
  const root = await fixture(t),
    mock = runner({ running: "" }),
    logged = [];
  await runRecovery(
    parseRecoveryArguments(["backup", join(root, "snapshot")]),
    mock.run,
    (line) => logged.push(line),
    ["compose"],
  );
  assert.equal(
    mock.calls.some((args) => args.includes("run")),
    true,
  );
  assert.equal(
    mock.calls.some((args) => args.includes("start")),
    false,
  );
  assert.match(logged.at(-1), /^Services remain stopped\./);
});

test("missing deployment volumes refuse every maintenance operation before stop", async (t) => {
  const root = await fixture(t);
  for (const action of ["backup", "check-backup", "restore", "archive"]) {
    const directory = join(root, action);
    if (["check-backup", "restore"].includes(action)) await mkdir(directory);
    const mock = runner({ missingVolume: true });
    await assert.rejects(
      runRecovery(parseRecoveryArguments([action, directory]), mock.run, () => {}, ["compose"]),
      /missing deployment volume/,
    );
    assert.equal(
      mock.calls.some(
        (args) => args.includes("stop") || args.includes("run") || args.includes("start"),
      ),
      false,
    );
  }
});

test("ambiguous bind-mount parents are refused before Docker changes", async (t) => {
  const root = await fixture(t);
  for (const parent of ["colon:parent", "comma,parent"]) {
    const mock = runner();
    await assert.rejects(
      runRecovery(
        parseRecoveryArguments(["backup", join(root, parent, "snapshot")]),
        mock.run,
        () => {},
        ["compose"],
      ),
      /parent must not contain/,
    );
    assert.deepEqual(mock.calls, []);
  }
});

test("archive failure after stop never restarts services", async (t) => {
  const root = await fixture(t),
    mock = runner();
  const options = parseRecoveryArguments([
    "archive",
    join(root, "archive"),
    "--env-path",
    join(root, "missing.env"),
  ]);
  await assert.rejects(
    runRecovery(options, mock.run, () => {}, ["compose"]),
    /ENOENT/,
  );
  assert.equal(
    mock.calls.some((args) => args.includes("stop")),
    true,
  );
  assert.equal(
    mock.calls.some((args) => args.includes("start")),
    false,
  );
});
test("restore and failed maintenance remain stopped", async (t) => {
  const root = await fixture(t),
    directory = join(root, "snapshot");
  await mkdir(directory);
  for (const failMaintenance of [false, true]) {
    const mock = runner({ failMaintenance });
    const run = runRecovery(parseRecoveryArguments(["restore", directory]), mock.run, () => {}, [
      "compose",
    ]);
    if (failMaintenance) await assert.rejects(run, /refused/);
    else await run;
    assert.equal(
      mock.calls.some((args) => args.includes("start")),
      false,
    );
  }
});
test("snapshot runs online and never stops, restarts or deletes anything", async (t) => {
  const root = await fixture(t),
    mock = runner(),
    envFile = join(root, "env");
  await writeFile(envFile, "DOHC_SNAPSHOT_KEY=key-from-env\n");
  await runRecovery(
    parseRecoveryArguments(["snapshot", join(root, "offsite"), "--env-path", envFile]),
    mock.run,
    () => {},
    ["compose"],
  );
  assert.equal(
    mock.calls.some(
      (args) =>
        args.includes("stop") ||
        args.includes("start") ||
        args.includes("rm") ||
        args.includes("down"),
    ),
    false,
  );
  const run = mock.calls.find((args) => args.includes("run"));
  assert.deepEqual(run.slice(run.indexOf("relay-snapshot")), [
    "relay-snapshot",
    "snapshot",
    "--database",
    "/data/sync-relay.sqlite",
    "--state-directory",
    "/snapshots",
    "--directory",
    "/backup/offsite",
  ]);
  assert.ok(run.includes(`${root}:/backup`));
  const inspected = mock.calls.find((args) => args[0] === "volume" && args[1] === "inspect");
  assert.deepEqual(inspected, ["volume", "inspect", "recovery_data"]);
});

test("snapshot succeeds even when the snapshots volume has not been created yet", async (t) => {
  const root = await fixture(t),
    envFile = join(root, "env");
  await writeFile(envFile, "DOHC_SNAPSHOT_KEY=key-from-env\n");
  const mock = runner({
    served: {
      ...config,
      volumes: {
        ...config.volumes,
        dohc_self_host_snapshots: { name: "recovery_snapshots" },
      },
    },
  });
  await runRecovery(
    parseRecoveryArguments(["snapshot", join(root, "offsite"), "--env-path", envFile]),
    mock.run,
    () => {},
    ["compose"],
  );
  const inspected = mock.calls.find((args) => args[0] === "volume" && args[1] === "inspect");
  assert.deepEqual(inspected, ["volume", "inspect", "recovery_data"]);
});

test("verify mounts no deployment volume and passes only the snapshot key", async (t) => {
  const root = await fixture(t),
    envFile = join(root, "env");
  await writeFile(envFile, "DOHC_SNAPSHOT_KEY=key-from-env\nPOSTGRES_PASSWORD=not-passed\n");
  const snapshot = join(root, "taken.dohc-snapshot");
  await writeFile(snapshot, "sealed");
  const calls = [];
  const run = (args, env) => {
    calls.push({ args, env });
    return args.includes("config") ? JSON.stringify(config) : "verified";
  };
  await runRecovery(
    parseRecoveryArguments([
      "verify",
      join(root, "checked"),
      "--snapshot",
      snapshot,
      "--env-path",
      envFile,
    ]),
    run,
    () => {},
    ["compose"],
  );
  const verify = calls.at(-1);
  assert.deepEqual(verify.env, { DOHC_SNAPSHOT_KEY: "key-from-env" });
  assert.equal(verify.args.filter((value) => value.startsWith("type=volume")).length, 0);
  assert.deepEqual(
    verify.args.slice(verify.args.indexOf("--network"), verify.args.indexOf("--network") + 2),
    ["--network", "none"],
  );
  assert.ok(verify.args.includes(`type=bind,source=${root},target=/source,readonly`));
  assert.equal(
    calls.some(({ args }) => args.includes("stop") || args[0] === "volume"),
    false,
  );
  await mkdir(join(root, "existing"));
  await assert.rejects(
    runRecovery(
      parseRecoveryArguments([
        "verify",
        join(root, "existing"),
        "--snapshot",
        snapshot,
        "--env-path",
        envFile,
      ]),
      run,
      () => {},
      ["compose"],
    ),
    /new directory/,
  );
  assert.throws(() => parseRecoveryArguments(["verify", join(root, "checked")]));
  assert.throws(() => parseRecoveryArguments(["backup", join(root, "b"), "--snapshot", snapshot]));
});

test("snapshot and verify refuse to run without a snapshot key", async (t) => {
  const root = await fixture(t),
    envFile = join(root, "env"),
    snapshot = join(root, "taken.dohc-snapshot");
  await writeFile(envFile, "DOHC_SNAPSHOT_KEY=\n");
  await writeFile(snapshot, "sealed");
  for (const args of [
    ["snapshot", join(root, "offsite")],
    ["verify", join(root, "checked"), "--snapshot", snapshot],
  ]) {
    const mock = runner();
    await assert.rejects(
      runRecovery(parseRecoveryArguments([...args, "--env-path", envFile]), mock.run, () => {}, [
        "compose",
      ]),
      /Set DOHC_SNAPSHOT_KEY in .* to the snapshot key/,
    );
    assert.deepEqual(mock.calls, []);
  }
});

test("invalid settings are refused before Docker runs", async (t) => {
  const root = await fixture(t),
    mock = runner(),
    envFile = join(root, "deployment.env");
  await writeFile(
    envFile,
    "DOHC_POSTGRES_HOST=db.provider.invalid:5432/dohc?sslmode=disable&unused=\n",
  );
  await assert.rejects(
    runRecovery(
      parseRecoveryArguments(["backup", join(root, "snapshot"), "--env-path", envFile]),
      mock.run,
      () => {},
    ),
    /Set DOHC_POSTGRES_HOST to your database host name/,
  );
  assert.deepEqual(mock.calls, []);
});
test("a foreign volume writer is refused before stop and named with its mount", async (t) => {
  const root = await fixture(t),
    mock = runner({ foreign: true });
  await assert.rejects(
    runRecovery(parseRecoveryArguments(["backup", join(root, "snapshot")]), mock.run, () => {}, [
      "compose",
    ]),
    {
      message:
        "Running containers outside recovery-test can write its storage. Stop them before recovery: portainer_agent (recovery_data).",
    },
  );
  assert.equal(
    mock.calls.some((args) => args.includes("stop")),
    false,
  );
});
test("another project writing the disk folder, or a folder inside or above it, is refused before stop", async (t) => {
  const root = await fixture(t);
  for (const options of [
    {
      mounts: [{ Type: "volume", Name: "other_relay", RW: true }],
      volumes: { other_relay: bound("/mnt/disk/dohc/sync-relay/") },
    },
    {
      mounts: [{ Type: "volume", Name: "other_relay", RW: true }],
      volumes: { other_relay: bound("/mnt/disk/dohc", "rbind") },
    },
    {
      mounts: [{ Type: "volume", Name: "other_relay", RW: true }],
      volumes: { other_relay: bound("/mnt/disk/dohc/sync-relay", "rw,rbind") },
    },
    {
      mounts: [{ Type: "bind", Source: "/mnt/disk/data", RW: true }],
      volumes: { recovery_data: bound("/mnt/disk/data/sync-relay", "rbind") },
    },
    { mounts: [{ Type: "bind", Source: "/mnt/disk/dohc/sync-relay", RW: true }] },
    { mounts: [{ Type: "bind", Source: "/mnt/disk/dohc", RW: true }] },
    { mounts: [{ Type: "bind", Source: "/", RW: true }] },
    {
      mounts: [{ Type: "volume", Name: "other_disk", RW: true }],
      volumes: { other_disk: bound("/mnt/disk/dohc") },
    },
    { mounts: [{ Type: "bind", Source: "/mnt/disk/dohc/sync-relay/files", RW: true }] },
    {
      mounts: [{ Type: "bind", Source: "/var/lib/docker/volumes", RW: true }],
      volumes: {
        recovery_data: {
          Driver: "local",
          Mountpoint: "/var/lib/docker/volumes/recovery_data/_data",
          Options: null,
        },
      },
    },
  ]) {
    const mock = runner({ foreign: true, ...options }),
      [mount] = options.mounts;
    await assert.rejects(
      runRecovery(parseRecoveryArguments(["archive", join(root, "archive")]), mock.run, () => {}, [
        "compose",
      ]),
      {
        message: `Running containers outside recovery-test can write its storage. Stop them before recovery: portainer_agent (${mount.Name ?? mount.Source}).`,
      },
      JSON.stringify(options.mounts),
    );
    assert.equal(
      mock.calls.some((args) => args.includes("stop")),
      false,
    );
  }
});
test("another project writing the data disk's snapshot folder is refused before stop", async (t) => {
  const root = await fixture(t);
  const disk = {
    ...config,
    volumes: {
      ...config.volumes,
      snapshots: {
        name: "recovery_snapshots",
        driver: "local",
        driver_opts: bound("/mnt/disk/dohc/snapshots").Options,
      },
    },
  };
  const mock = runner({
    foreign: true,
    mounts: [{ Type: "bind", Source: "/mnt/disk/dohc/snapshots/staging", RW: true }],
    volumes: { recovery_snapshots: bound("/mnt/disk/dohc/snapshots") },
  });
  const run = (args) => (args.includes("config") ? JSON.stringify(disk) : mock.run(args));
  await assert.rejects(
    runRecovery(parseRecoveryArguments(["backup", join(root, "snapshot")]), run, () => {}, [
      "compose",
    ]),
    {
      message:
        "Running containers outside recovery-test can write its storage. Stop them before recovery: portainer_agent (/mnt/disk/dohc/snapshots/staging).",
    },
  );
  assert.equal(
    mock.calls.some((args) => args.includes("stop")),
    false,
  );
});
test("read-only mounts and other folders do not block recovery", async (t) => {
  const root = await fixture(t);
  for (const [index, options] of [
    {
      mounts: [
        { Type: "volume", Name: "other_relay", RW: true },
        { Type: "bind", Source: "/mnt/disk/other", RW: true },
        { Type: "bind", Source: "/mnt/disk/dohc-old", RW: true },
      ],
      volumes: { other_relay: bound("/mnt/disk/other/sync-relay") },
    },
    {
      mounts: [
        { Type: "bind", Source: "/mnt/disk/dohc", RW: false },
        { Type: "bind", Source: "/", RW: false },
      ],
    },
    {
      mounts: [{ Type: "volume", Name: "other_disk", RW: false }],
      volumes: { other_disk: bound("/mnt/disk/dohc") },
    },
    {
      mounts: [{ Type: "volume", Name: "other_disk", RW: false }],
      volumes: { other_disk: bound("/mnt/disk/dohc", "rbind") },
    },
    { mounts: [{ Type: "volume", Name: "recovery_data", RW: false }] },
  ].entries()) {
    const mock = runner({ foreign: true, ...options });
    await runRecovery(
      parseRecoveryArguments(["backup", join(root, `snapshot-${index}`)]),
      mock.run,
      () => {},
      ["compose"],
    );
    assert.ok(
      mock.calls.some((args) => args.includes("run")),
      JSON.stringify(options.mounts),
    );
  }
});
test("a same-project orphan writer is refused after stop", async (t) => {
  const root = await fixture(t),
    mock = runner();
  let stopped = false;
  const run = (args) => {
    if (args.includes("stop")) stopped = true;
    if (stopped && args[0] === "ps") return "orphan\n";
    if (stopped && args[0] === "inspect")
      return JSON.stringify([
        {
          Name: "/recovery-test-orphan-1",
          Mounts: [{ Type: "volume", Name: "recovery_data", RW: true }],
        },
      ]);
    return mock.run(args);
  };
  await assert.rejects(
    runRecovery(parseRecoveryArguments(["backup", join(root, "snapshot")]), run, () => {}, [
      "compose",
    ]),
    {
      message:
        "Running containers can still write this deployment's storage. Services remain stopped; stop them before recovery: recovery-test-orphan-1 (recovery_data).",
    },
  );
  assert.equal(
    mock.calls.some((args) => args.includes("run")),
    false,
  );
});

test("an archive keeps bound configuration files but leaves out the APNs auth key", async (t) => {
  const root = await fixture(t);
  const ca = join(root, "postgres-ca.pem"),
    key = join(root, "AuthKey_KEY1234567.p8"),
    envFile = join(root, ".env.self-host");
  await writeFile(ca, "provider CA");
  await writeFile(key, "apple signing key");
  await writeFile(envFile, `DOHC_RELAY_APNS_KEY_FILE=${key}\n`);
  const bind = (source, target) => ({ type: "bind", source, target, read_only: true });
  const archived = {
    name: "archive-test",
    services: {
      "sync-relay": {
        image: "image",
        volumes: [bind(ca, "/etc/dohc/postgres-ca.pem"), bind(key, apnsKeyTarget)],
      },
      "workspace-api": {
        image: "image",
        volumes: [bind(ca, "/etc/dohc/postgres-ca.pem"), bind(key, "/run/override/apns.p8")],
      },
    },
    volumes: {},
  };
  const directory = join(root, "archive");
  await archiveDeployment({ directory, envFile }, archived, () => "[]");
  const manifest = JSON.parse(await readFile(join(directory, "archive.json"), "utf8"));
  assert.deepEqual(
    manifest.files.filter((file) => file.source).map((file) => file.source),
    [ca],
  );
  for (const name of await readdir(directory))
    assert.ok(!(await readFile(join(directory, name), "utf8")).includes("apple signing key"), name);
  assert.ok(
    manifest.limitations.includes(
      `Leaves out the APNs auth key ${key}. Keep your own copy: Apple lets you download it only once.`,
    ),
  );
});

test("an archive refuses an APNs auth key inside the deployment's storage before it stops anything", async (t) => {
  const root = await fixture(t),
    key = "/mnt/disk/dohc/sync-relay/apns-key.p8";
  const mock = runner({
    served: {
      ...config,
      services: {
        "sync-relay": {
          ...config.services["sync-relay"],
          volumes: [{ type: "bind", source: key, target: apnsKeyTarget, read_only: true }],
        },
      },
    },
  });
  await assert.rejects(
    runRecovery(parseRecoveryArguments(["archive", join(root, "archive")]), mock.run, () => {}, [
      "compose",
    ]),
    new RegExp(`The APNs auth key ${key} is inside the deployment's storage`),
  );
  assert.equal(
    mock.calls.some((args) => args.includes("stop")),
    false,
  );
});

test(
  "an archive refuses a link to an APNs auth key inside the deployment's storage",
  { skip: process.platform === "win32" && "Links need administrator rights on Windows." },
  async (t) => {
    const root = await fixture(t),
      folder = join(root, "disk", "sync-relay"),
      link = join(root, "apns-key.p8");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "apns-key.p8"), "apple signing key");
    await symlink(join(folder, "apns-key.p8"), link);
    const mock = runner({
      volumes: { recovery_data: bound(folder) },
      served: {
        ...config,
        services: {
          "sync-relay": {
            ...config.services["sync-relay"],
            volumes: [{ type: "bind", source: link, target: apnsKeyTarget, read_only: true }],
          },
        },
      },
    });
    await assert.rejects(
      runRecovery(parseRecoveryArguments(["archive", join(root, "archive")]), mock.run, () => {}, [
        "compose",
      ]),
      /is inside the deployment's storage/,
    );
  },
);

test("offline verify needs no APNs auth key, and every other command does", async (t) => {
  const root = await fixture(t),
    envFile = join(root, "drive.env");
  const settings = {
    ...parseEnv(readFileSync(".env.self-host.example", "utf8")),
    ...initialSettings({ origin: "https://dohc.team.invalid", image: "dohc-self-host:v1" }),
    DOHC_SMTP_HOST: "mail.team.invalid",
    DOHC_SMTP_FROM: "dohc@team.invalid",
    DOHC_RELAY_APNS_TOPIC: "app.dohc.mobile",
    DOHC_RELAY_APNS_ENVIRONMENTS: "production",
    DOHC_RELAY_APNS_KEY_FILE: "/etc/dohc/missing-apns-key.p8",
    DOHC_RELAY_APNS_KEY_ID: "KEY1234567",
    DOHC_RELAY_APNS_TEAM_ID: "TEAM123456",
  };
  await writeFile(
    envFile,
    Object.entries(settings)
      .map(([name, value]) => `${name}='${value}'\n`)
      .join(""),
  );
  const options = (action, ...args) =>
    parseRecoveryArguments([action, join(root, "out"), ...args, "--env-path", envFile]);
  const verify = recoveryComposeArgs(options("verify", "--snapshot", join(root, "taken")));
  assert.ok(!verify.includes("tools/self-host/compose.apns.yml"));
  for (const action of ["backup", "archive", "snapshot"])
    assert.throws(() => recoveryComposeArgs(options(action)), /DOHC_RELAY_APNS_KEY_FILE/, action);
});
