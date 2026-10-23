import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Not in the root test list: it needs Docker with Linux containers and current builds of @dohc/app-backend-runtime and @dohc/sync-relay.
// It uses the plain Node image and the checkout's bundles, so it needs no self-host image. See docs/how-to/self-host-recovery.md.
const root = fileURLToPath(new URL("../../", import.meta.url));
const image = "node:24.16.0-bookworm-slim";
const skip = process.env.DOHC_SNAPSHOT_DOCKER_TEST === "1" ? false : "Set DOHC_SNAPSHOT_DOCKER_TEST=1 on a host with Docker.";

/** Commits evidence rows and their tally together, so a copy of one transaction has count = max(id) = tally. */
const writerScript = `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/sync-relay.sqlite");
db.exec("PRAGMA busy_timeout=5000; CREATE TABLE evidence(id INTEGER PRIMARY KEY, padding BLOB) STRICT; CREATE TABLE tally(n INTEGER NOT NULL) STRICT; INSERT INTO tally VALUES (0)");
const step = db.prepare("UPDATE tally SET n = n + 1 RETURNING n"), insert = db.prepare("INSERT INTO evidence VALUES (?, randomblob(512))");
for (;;) { db.exec("BEGIN IMMEDIATE"); const { n } = step.get(); insert.run(n); db.exec("COMMIT"); if (n % 100 === 0) console.log(n); }`;

/** Polls until `read` returns a value. A stalled container fails the test instead of hanging it. */
function waitFor(what, read, limit = 120_000) {
  const deadline = Date.now() + limit;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `${what} made no progress in ${limit / 1000} s.`);
  }
}

test("online snapshots of a relay under constant writes, verified offline with only the key", { skip, timeout: 900_000 }, t => {
  const owner = `dohc-snapshot-proof-${randomUUID().slice(0, 8)}`;
  const containers = [], volumes = [];
  let failed = true;
  const scratch = mkdtempSync(join(tmpdir(), `${owner}-`));
  const key = randomBytes(32).toString("base64url");
  function docker(args, { allowFailure = false, snapshotKey } = {}) {
    const result = spawnSync("docker", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
      env: snapshotKey ? { ...process.env, DOHC_SNAPSHOT_KEY: snapshotKey } : process.env });
    if (!allowFailure) assert.equal(result.status, 0, `docker ${args.slice(0, 3).join(" ")}: ${result.stderr}`);
    return result;
  }
  const volume = kind => `${owner}-${kind}`;
  const mount = (kind, target, readonly = false) => ["--mount", `type=volume,source=${volume(kind)},target=${target}${readonly ? ",readonly" : ""}`];
  // Every container carries a name from this run, so cleanup removes exactly what the test started.
  function node(args, { mounts = [], snapshotKey, detach = false, allowFailure = false } = {}) {
    const name = `${owner}-${containers.length + 1}`;
    containers.push(name);
    const result = docker(["run", detach ? "-d" : "--rm", "--name", name, "--network", "none", ...mounts.flat(),
      ...(snapshotKey ? ["--env", "DOHC_SNAPSHOT_KEY"] : []), image, "node", ...args], { allowFailure, snapshotKey });
    return Object.assign(result, { name });
  }
  const inspect = script => JSON.parse(node(["-e", script], { mounts: [mount("out", "/backup", true), mount("staging", "/snapshots", true)] }).stdout);
  const listing = path => inspect(`console.log(JSON.stringify(require("node:fs").readdirSync(${JSON.stringify(path)}).sort()))`);
  const proof = mount("proof", "/proof", true);
  try {
    for (const kind of ["relay", "continuity", "staging", "proof", "out"]) {
      docker(["volume", "create", "--label", `dohc.snapshot-proof=${owner}`, volume(kind)]);
      volumes.push(volume(kind));
    }
    // Docker Desktop cannot bind every host path, so the bundles reach the containers through a volume.
    const runtime = join(scratch, "node_modules", "@dohc", "app-backend-runtime");
    cpSync(join(root, "services/sync-relay/dist"), scratch, { recursive: true });
    cpSync(join(root, "packages/app-backend-runtime/dist"), join(runtime, "dist"), { recursive: true });
    cpSync(join(root, "packages/app-backend-runtime/package.json"), join(runtime, "package.json"));
    writeFileSync(join(scratch, "package.json"), '{"type":"module"}\n');
    const copier = `${owner}-copy`;
    containers.push(copier);
    docker(["create", "--name", copier, ...mount("proof", "/proof"), image]);
    docker(["cp", `${scratch}/.`, `${copier}:/proof`]);

    node(["/proof/relay-deployment.js", "initialize", "--config", "/continuity/deployment.json", "--database", "/data/sync-relay.sqlite",
      "--continuity-directory", "/continuity/history"], { mounts: [mount("relay", "/data"), mount("continuity", "/continuity"), proof] });
    const writer = node(["-e", writerScript], { mounts: [mount("relay", "/data")], detach: true }).name;
    const writesPast = above => waitFor("The writer", () => {
      const state = JSON.parse(docker(["inspect", "--format", "{{json .State}}", writer]).stdout);
      assert.equal(state.Running, true, `The writer stopped: ${docker(["logs", writer]).stderr}`);
      const latest = Math.max(0, ...docker(["logs", writer]).stdout.split("\n").filter(Boolean).map(Number));
      return latest > above ? latest : undefined;
    });

    // The relay volume is read-only here, as in Compose; SQLite reads the live WAL beside the writer.
    const snapshot = () => node(["/proof/relay-snapshot.js", "snapshot", "--database", "/data/sync-relay.sqlite", "--state-directory", "/snapshots",
      "--directory", "/backup/saved"], { mounts: [mount("relay", "/data", true), mount("staging", "/snapshots"), mount("out", "/backup"), proof],
      snapshotKey: key, allowFailure: true });
    const savedName = result => {
      assert.equal(result.status, 0, result.stderr);
      return /Relay snapshot saved: \/backup\/saved\/(\S+\.dohc-snapshot)/.exec(result.stdout)?.[1];
    };
    const names = [];
    for (let seen = writesPast(0), index = 0; index < 3; index++, seen = writesPast(seen + 200)) names.push(savedName(snapshot()));
    assert.ok(names.every(Boolean), "every snapshot reports its file");
    assert.deepEqual(listing("/backup/saved"), [...names].sort());
    assert.deepEqual(listing("/snapshots"), ["snapshot.lock"]);

    // One snapshot at a time across containers. The holder takes the lock like a run, then stages an unfinished copy.
    const holder = node(["-e", `const { DatabaseSync } = require("node:sqlite");
      globalThis.lock = new DatabaseSync("/snapshots/snapshot.lock"); lock.exec("BEGIN EXCLUSIVE");
      require("node:fs").mkdirSync("/snapshots/staging/unfinished", { recursive: true }); console.log("held"); setInterval(() => {}, 60_000);`],
      { mounts: [mount("staging", "/snapshots")], detach: true }).name;
    waitFor("The lock holder", () => docker(["logs", holder]).stdout.includes("held") || undefined);
    const refused = snapshot();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Another snapshot is running/);
    assert.deepEqual(listing("/snapshots/staging"), ["unfinished"]);
    // A killed holder frees the lock; the next run clears its staging.
    docker(["kill", holder]);
    docker(["wait", holder]);
    assert.ok(savedName(snapshot()));
    assert.deepEqual(listing("/snapshots"), ["snapshot.lock"]);

    // No network and no deployment volume: only the package and the key.
    const verify = (file, output, snapshotKey = key) => node(["/proof/relay-snapshot.js", "verify", "--file", file, "--output", output],
      { mounts: [mount("out", "/backup"), proof], snapshotKey, allowFailure: true });
    for (const [index, name] of names.entries()) assert.equal(verify(`/backup/saved/${name}`, `/backup/verified-${index}`).status, 0);
    const copies = inspect(`const { DatabaseSync } = require("node:sqlite");
      console.log(JSON.stringify([0, 1, 2].map(index => {
        const db = new DatabaseSync("/backup/verified-" + index + "/relay.sqlite", { readOnly: true });
        try { return { ...db.prepare("SELECT (SELECT n FROM tally) AS tally, count(*) AS count, max(id) AS latest FROM evidence").get() }; } finally { db.close(); }
      })));`);
    for (const copy of copies) assert.deepEqual(copy, { tally: copy.count, count: copy.count, latest: copy.count });
    assert.ok(copies[0].tally > 0 && copies[0].tally < copies[1].tally && copies[1].tally < copies[2].tally, JSON.stringify(copies));
    writesPast(copies[2].tally);
    // check-backup's own check: integrity, the deployment marker against continuity, and the manifest checksum.
    // Like recovery.mjs, it runs on the stopped deployment with its relay and continuity volumes.
    docker(["stop", writer]);
    // A relay that stops cleanly closes its database, which folds the WAL in and removes it. The killed writer can't,
    // and maintenance refuses a leftover WAL as unsettled continuity. SQLite touches the WAL only on its first read.
    node(["-e", `const db = new (require("node:sqlite").DatabaseSync)("/data/sync-relay.sqlite"); db.prepare("SELECT count(*) FROM sqlite_master").get(); db.close();`],
      { mounts: [mount("relay", "/data")] });
    for (const index of [0, 1, 2]) {
      node(["/proof/relay-deployment.js", "check-backup", "--config", "/continuity/deployment.json", "--directory", `/backup/verified-${index}`],
        { mounts: [mount("relay", "/data"), mount("continuity", "/continuity"), mount("out", "/backup", true), proof] });
    }

    const wrongKey = verify(`/backup/saved/${names[0]}`, "/backup/wrong-key", randomBytes(32).toString("base64url"));
    assert.notEqual(wrongKey.status, 0);
    assert.match(wrongKey.stderr, /different snapshot key/);
    node(["-e", `const fs = require("node:fs"), bytes = fs.readFileSync("/backup/saved/${names[0]}");
      bytes[bytes.length - 100] ^= 1; fs.writeFileSync("/backup/changed.dohc-snapshot", bytes);`], { mounts: [mount("out", "/backup")] });
    const changed = verify("/backup/changed.dohc-snapshot", "/backup/changed");
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /could not be decrypted/);
    assert.deepEqual(listing("/backup"), ["changed.dohc-snapshot", "saved", "verified-0", "verified-1", "verified-2"]);
    failed = false;
  } finally {
    // Cleanup failures fail a passing test; after a failure they are reported beside its error.
    const problems = [];
    for (const name of containers) docker(["rm", "--force", name], { allowFailure: true });
    for (const name of volumes) docker(["volume", "rm", name], { allowFailure: true });
    for (const [kind, args] of [["containers", ["ps", "--all", "--quiet", "--filter", `name=${owner}`]],
      ["volumes", ["volume", "ls", "--quiet", "--filter", `label=dohc.snapshot-proof=${owner}`]]]) {
      const left = docker(args, { allowFailure: true });
      if (left.status !== 0 || left.stdout.trim()) problems.push(`${kind} left behind: ${left.stdout.trim() || left.stderr.trim()}`);
    }
    try { rmSync(scratch, { recursive: true, force: true }); } catch (error) { problems.push(`${scratch}: ${error.message}`); }
    if (problems.length) {
      const message = `Cleanup failed:\n${problems.join("\n")}`;
      if (failed) t.diagnostic(message); else assert.fail(message);
    }
  }
});
