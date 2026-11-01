#!/usr/bin/env node
// Rehearses the Drive recipe without provider accounts, on a new server before its deployment exists. See "Rehearse on the new server" in docs/how-to/drive.md.
// It needs root, Docker, the release bundle, and its image. It changes only resources it creates, and removes them at the end.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { request } from "node:https";
import { join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const usage = "sudo node /srv/dohc-drive/tools/drive/rehearse.mjs --bundle DIR --image IMAGE --output DIR";
const recipe = fileURLToPath(new URL(".", import.meta.url));
const { values } = parseArgs({ options: { bundle: { type: "string" }, image: { type: "string" }, output: { type: "string" } } });
if (!values.bundle || !values.image || !values.output) throw new Error(usage);
if (process.platform !== "linux" || process.getuid() !== 0) throw new Error(`Run the rehearsal as root on the new Linux server: ${usage}`);
const bundle = resolve(values.bundle), output = resolve(values.output);
const release = JSON.parse(readFileSync(join(bundle, "release.json"), "utf8"));
if (release.image !== values.image) throw new Error(`The bundle records image ${release.image}, not ${values.image}.`);
const { redactor, secretNames } = await import("./drive.mjs");
const { composeArgs, readSettings } = await import(pathToFileURL(join(bundle, "tools/self-host/config.mjs")).href);

const owner = `dohc-rehearsal-${randomUUID().slice(0, 8)}`, work = join(output, owner);
const mount = join(work, "mnt"), tls = join(work, "tls"), envFile = join(work, "drive.env");
const subnet = `10.237.${100 + Math.floor(Math.random() * 100)}`, neonAddress = `${subnet}.10`;
const publicHost = "drive.rehearsal.test", appDomain = "apps.rehearsal.test";
const evidence = { revision: release.revision, imageId: release.imageId, owner, commands: [], assertions: [], residual: [] };
// Command output stays in memory, so a leaked secret never reaches the evidence file.
const transcript = [];
let redact = text => text;

function run(command, args, { allowFailure = false, cwd = recipe, env, timeout = 900_000 } = {}) {
  evidence.commands.push([command, ...args].join(" "));
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: env && { ...process.env, ...env }, timeout, maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  transcript.push(output);
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(" ")} failed:\n${output}`);
  return { status: result.status, output };
}
async function check(name, action) {
  await action();
  evidence.assertions.push(name);
  console.log(`[ok] ${name}`);
}

const ipv6 = JSON.parse(run("ip", ["-json", "-6", "address", "show", "scope", "global"]).output || "[]").flatMap(link => link.addr_info ?? []);
if (ipv6.length) throw new Error("This server has a global IPv6 address, and drive.mjs refuses such a host. Create the server with IPv6 off.");
// The rehearsal runs first on a new server. Its leftovers then cannot meet a deployment's containers, volumes or data.
if (run("docker", ["ps", "--all", "--quiet"]).output.trim() || run("docker", ["volume", "ls", "--quiet"]).output.trim()) {
  throw new Error("Docker already has containers or volumes on this server. Run the rehearsal first, on a new server, before the deployment exists.");
}

const drive = (command, uuid, extra = []) => run(process.execPath, [join(recipe, "drive.mjs"), command, "--bundle", bundle, "--env-file", envFile,
  "--volume-uuid", uuid, ...extra], { allowFailure: true });
const compose = (file, ...args) => run("docker", composeArgs(file, readSettings(file), ...args), { cwd: bundle });
const neonEnv = { REHEARSAL_POSTGRES_PASSWORD: "", REHEARSAL_TLS_DIRECTORY: tls, REHEARSAL_POSTGRES_ADDRESS: neonAddress, REHEARSAL_NETWORK: `${owner}_dohc` };
const neon = (...args) => run("docker", ["compose", "--project-name", `${owner}-neon`, "-f", join(recipe, "compose.rehearsal.yml"), ...args],
  { env: neonEnv });
const missingChecks = text => [...text.matchAll(/^\[missing\] (.+?)(?: - .*)?$/gm)].map(match => match[1]);
// Without public DNS and a publicly trusted viewer certificate, only the release's public HTTPS checks can fail.
const publicChecks = ["public HTTPS connection and device approval", "native executable and relay HTTPS reachability"];
function startedWithoutPublicHttps(result) {
  assert.match(result.output, /\[ok\] compose startup/);
  assert.match(result.output, /\[ok\] server automations/);
  for (const service of ["workspace-api", "sync-relay", "share-web"]) assert.match(result.output, new RegExp(`\\[ok\\] ready service:${service}`));
  const missing = missingChecks(result.output);
  assert.ok(missing.includes(publicChecks[0]), result.output);
  assert.deepEqual(missing.filter(name => !publicChecks.includes(name)), [], result.output);
}

const devices = [], images = [];
function attach(image) {
  const device = run("losetup", ["--find", "--show", image]).output.trim();
  devices.push(device);
  run("udevadm", ["settle"]);
  return device;
}
function detach(device) {
  run("losetup", ["--detach", device]);
  devices.splice(devices.indexOf(device), 1);
  run("udevadm", ["settle"]);
}
function volume(name) {
  const image = join(work, `${name}.img`);
  images.push(image);
  run("truncate", ["--size", "2G", image]);
  run("mkfs.ext4", ["-q", "-F", image]);
  const device = attach(image), uuid = run("blkid", ["--match-tag", "UUID", "--output", "value", device]).output.trim();
  // The operator's one-time preparation in docs/how-to/drive.md.
  run("mount", ["-o", "nodev,nosuid,noexec", `UUID=${uuid}`, mount]);
  run("install", ["-d", "-m", "0700", "-o", "1000", "-g", "1000", ...["sync-relay", "continuity", "host-data", "snapshots"].map(folder => join(mount, "dohc", folder))]);
  run("umount", [mount]);
  return { image, device, uuid };
}
function certificate(name, subjectAltName, ca = "ca") {
  const path = file => join(tls, file);
  if (!subjectAltName) {
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", `/CN=dohc rehearsal ${name}`, "-keyout", path(`${name}.key`),
      "-out", path(`${name}.pem`), "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    return;
  }
  writeFileSync(path(`${name}.ext`), `subjectAltName=${subjectAltName}\nextendedKeyUsage=serverAuth\n`);
  run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=dohc rehearsal ${name}`, "-keyout", path(`${name}.key`), "-out", path(`${name}.csr`)]);
  run("openssl", ["x509", "-req", "-in", path(`${name}.csr`), "-CA", path(`${ca}.pem`), "-CAkey", path(`${ca}.key`), "-CAcreateserial", "-days", "2",
    "-extfile", path(`${name}.ext`), "-out", path(`${name}.pem`)]);
}
function writeEnv(file, settings) {
  const line = ([key, value]) => `${key}=${/^[A-Za-z0-9_./:@,+-]*$/.test(value) ? value : `'${value}'`}\n`;
  writeFileSync(file, Object.entries(settings).map(line).join(""), { mode: 0o600 });
  chmodSync(file, 0o600);
}
function appRequest(host, path = "/") {
  return new Promise((done, fail) => {
    const call = request({ host: "127.0.0.1", port: 443, servername: host, path, headers: { host }, ca: readFileSync(join(tls, "ca.pem")), timeout: 15_000, agent: false },
      response => {
        // Read the certificate before the body ends: the client can release the socket at the end.
        const fingerprint = response.socket.getPeerX509Certificate()?.fingerprint256;
        response.on("error", fail);
        response.on("end", () => done({ status: response.statusCode, fingerprint }));
        response.resume();
      });
    call.on("timeout", () => call.destroy(new Error("timeout")));
    call.on("error", fail);
    call.end();
  });
}
async function appRoutes() {
  const leaf = new X509Certificate(readFileSync(join(tls, "app.pem"))).fingerprint256;
  const unknown = await appRequest(`unknown.${appDomain}`);
  assert.equal(unknown.fingerprint, leaf);
  assert.ok(unknown.status >= 400 && unknown.status < 500, `an unknown app returned HTTP ${unknown.status}`);
  assert.equal((await appRequest(`unknown.${appDomain}`, "/internal/health")).status, 404);
  await assert.rejects(appRequest(`deeper.unknown.${appDomain}`));
  await assert.rejects(appRequest(appDomain));
}
function continuity() {
  return JSON.parse(run("docker", ["run", "--rm", "--network", "none", "--user", "0:0", "--mount", `type=bind,source=${mount},target=/volume`,
    "--entrypoint", "node", values.image, "-e", `const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs');
    const config=JSON.parse(fs.readFileSync('/volume/dohc/continuity/deployment.json','utf8'));
    const db=new DatabaseSync('/volume/dohc/continuity/history/continuity.sqlite',{readOnly:true});
    try{console.log(JSON.stringify({namespace:config.namespace,stamp:db.prepare('SELECT confirmed_stamp FROM continuity').get().confirmed_stamp}));}finally{db.close();}`])
    .output.trim().split("\n").at(-1));
}
const accounts = () => neon("exec", "-T", "neon", "psql", "-At", "-U", "drive", "-d", "drive", "-c", 'SELECT id FROM "user" ORDER BY id').output.trim();

try {
  mkdirSync(output, { recursive: true });
  mkdirSync(mount, { recursive: true, mode: 0o755 });
  mkdirSync(tls, { mode: 0o755 });
  const disk = volume("volume"), empty = volume("empty");

  certificate("ca");
  certificate("other");
  certificate("neon", `IP:${neonAddress}`);
  certificate("app", `DNS:*.${appDomain}`);
  writeFileSync(join(tls, "pg_hba.conf"), "local all all trust\nhostssl all all all scram-sha-256\n");
  for (const file of ["ca.pem", "other.pem", "neon.pem", "neon.key", "app.pem", "pg_hba.conf"]) chmodSync(join(tls, file), 0o644);
  chmodSync(join(tls, "app.key"), 0o600);

  run(process.execPath, [join(bundle, "tools/self-host/bootstrap.mjs"), "init", "--origin", `https://${publicHost}`, "--name", "dohc Drive rehearsal",
    "--image", values.image, "--env-file", envFile], { cwd: bundle });
  const settings = { ...parseEnv(readFileSync(envFile, "utf8")),
    DOHC_DEPLOYMENT_NAME: owner, DOHC_BEHIND_CLOUDFLARE: "1", DOHC_RELAY_AUTOMATIONS: "0", DOHC_DATA_DIRECTORY: join(mount, "dohc"),
    DOHC_NETWORK_SUBNET: `${subnet}.0/24`, DOHC_NETWORK_IP_RANGE: `${subnet}.128/25`, DOHC_GATEWAY_ADDRESS: `${subnet}.2`, DOHC_SHARE_WEB_ADDRESS: `${subnet}.3`,
    DOHC_POSTGRES_HOST: neonAddress, DOHC_POSTGRES_PORT: "5432", DOHC_POSTGRES_CA_FILE: join(tls, "ca.pem"), POSTGRES_DB: "drive", POSTGRES_USER: "drive",
    DOHC_SMTP_HOST: "smtp.rehearsal.invalid", DOHC_SMTP_PORT: "2525", DOHC_SMTP_SECURE: "false", DOHC_SMTP_FROM: `noreply@${publicHost}`,
    DOHC_SIGN_UP_EMAILS: "owner@rehearsal.test",
    DOHC_RELAY_APP_PUBLICATIONS: "1", DOHC_SHARE_WEB_APP_DOMAIN: appDomain, DOHC_APP_TLS_CERT_FILE: join(tls, "app.pem"), DOHC_APP_TLS_KEY_FILE: join(tls, "app.key"),
    DOHC_SNAPSHOT_S3_ENDPOINT: "https://s3.rehearsal.invalid", DOHC_SNAPSHOT_S3_REGION: "auto", DOHC_SNAPSHOT_S3_BUCKET: "rehearsal",
    DOHC_SNAPSHOT_S3_ACCESS_KEY_ID: randomBytes(16).toString("hex"), DOHC_SNAPSHOT_S3_SECRET_ACCESS_KEY: randomBytes(32).toString("base64url"),
    DOHC_SNAPSHOT_ALERT_EMAIL: "operator@rehearsal.test", DOHC_SNAPSHOT_HEARTBEAT_URL: `https://heartbeat.rehearsal.invalid/${randomUUID()}` };
  writeEnv(envFile, settings);
  neonEnv.REHEARSAL_POSTGRES_PASSWORD = settings.POSTGRES_PASSWORD;
  redact = redactor(settings);

  await check("check refuses an unmounted volume and passes once the operator mounts it", () => {
    assert.match(drive("check", disk.uuid).output, new RegExp(`Volume ${disk.uuid} is not mounted at ${mount}`));
    run("mount", ["-o", "nodev,nosuid,noexec", `UUID=${disk.uuid}`, mount]);
    const result = drive("check", disk.uuid);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Self-host check summary: (\d+)\/\1 checks passed/);
  });
  await check("start without --first-start refuses empty deployment folders", () => {
    const result = drive("start", disk.uuid);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /No relay deployment found/);
  });
  // The release check above ran the relay's disk check, which created the deployment's network. Neon's stand-in joins it.
  if (run("docker", ["network", "inspect", `${owner}_dohc`], { allowFailure: true }).status !== 0) compose(envFile, "up", "--no-start");
  neon("up", "-d", "--wait");

  await check("migrations refuse Neon's stand-in with another CA or a name its certificate does not cover", () => {
    for (const [name, change, pattern] of [["other-ca", { DOHC_POSTGRES_CA_FILE: join(tls, "other.pem") }, /self[- ]signed|unable to (get|verify)|certificate/i],
      ["other-name", { DOHC_POSTGRES_HOST: "neon-rehearsal" }, /altnames|Hostname\/IP does not match|certificate/i]]) {
      const file = join(work, `${name}.env`);
      writeEnv(file, { ...settings, ...change });
      const result = run("docker", composeArgs(file, readSettings(file), "run", "--rm", "--no-deps", "-T", "postgres-migrate"), { cwd: bundle, allowFailure: true });
      assert.notEqual(result.status, 0, `${name}: migrations connected`);
      assert.match(result.output, pattern, name);
    }
  });
  await check("first start passes every check that does not need public DNS", () => startedWithoutPublicHttps(drive("start", disk.uuid, ["--first-start"])));
  await check("app hosts reach the viewer with the app certificate, refuse /internal, and refuse deeper names and the apex", appRoutes);

  neon("exec", "-T", "neon", "psql", "-v", "ON_ERROR_STOP=1", "-U", "drive", "-d", "drive", "-c",
    `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ('rehearsal-owner', 'Owner', 'owner@rehearsal.test', true)`);
  const before = continuity();

  await check("move refuses while the old deployment runs", () => {
    const result = drive("move", disk.uuid);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Running containers can write this deployment's storage/);
  });
  compose(envFile, "stop");
  run("umount", [mount]);
  await check("move refuses a wrong UUID, a detached volume, and a mount point that is not empty", () => {
    assert.match(drive("move", randomUUID()).output, /No attached volume has filesystem UUID/);
    detach(disk.device);
    assert.match(drive("move", disk.uuid).output, /No attached volume has filesystem UUID/);
    disk.device = attach(disk.image);
    writeFileSync(join(mount, "stray"), "");
    assert.match(drive("move", disk.uuid).output, /as an empty folder for the mount point/);
    rmSync(join(mount, "stray"));
  });
  await check("move mounts a volume with empty deployment folders, refuses it, and leaves it empty", () => {
    assert.match(drive("move", empty.uuid).output, /No relay deployment found/);
    for (const folder of ["sync-relay", "continuity", "host-data", "snapshots"]) assert.deepEqual(readdirSync(join(mount, "dohc", folder)), []);
    run("umount", [mount]);
  });
  await check("move mounts the deployment's volume by UUID and continues the same deployment", async () => {
    const result = drive("move", disk.uuid);
    assert.match(result.output, new RegExp(`Mounting volume ${disk.uuid}`));
    assert.match(result.output, /Found the accounts database and the relay deployment/);
    startedWithoutPublicHttps(result);
    const after = continuity();
    assert.equal(after.namespace, before.namespace);
    assert.ok(after.stamp >= before.stamp, `continuity moved back from ${before.stamp} to ${after.stamp}`);
    assert.equal(accounts(), "rehearsal-owner");
    await appRoutes();
  });
  await check("no command or output shows a secret", () => {
    const text = [...evidence.commands, ...transcript].join("\n");
    for (const name of secretNames) if (settings[name]) assert.equal(text.includes(settings[name]), false, name);
  });
  evidence.result = "passed";
} catch (error) {
  evidence.result = "failed";
  evidence.error = redact(error.message);
  process.exitCode = 1;
  console.error(evidence.error);
} finally {
  // Clean only what this rehearsal created. Record anything that remains.
  const clean = (name, action) => { try { action(); } catch { evidence.residual.push(name); } };
  if (neonEnv.REHEARSAL_POSTGRES_PASSWORD) clean(`${owner}-neon`, () => neon("down", "--volumes", "--remove-orphans", "--timeout", "0"));
  if (existsSync(envFile)) clean(owner, () => compose(envFile, "down", "--remove-orphans", "--timeout", "0"));
  clean(`${owner} volumes`, () => {
    const names = run("docker", ["volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${owner}`]).output.trim().split("\n").filter(Boolean);
    if (names.length) run("docker", ["volume", "rm", ...names]);
  });
  clean(mount, () => { if (run("findmnt", [mount], { allowFailure: true }).status === 0) run("umount", [mount]); });
  for (const device of [...devices]) clean(device, () => detach(device));
  // A busy loop device detaches lazily, so check that no mount or loop device is left.
  clean(`mounts or loop devices under ${work}`, () => {
    const targets = run("findmnt", ["--list", "--noheadings", "--output", "TARGET"]).output.split("\n");
    if (targets.some(target => target === work || target.startsWith(`${work}/`)) ||
      images.some(image => run("losetup", ["--associated", image]).output.trim())) throw new Error("left over");
  });
  if (!evidence.residual.length) clean(work, () => rmSync(work, { recursive: true, force: true }));
  writeFileSync(join(output, `${owner}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Evidence: ${join(output, `${owner}.json`)}`);
  if (evidence.residual.length) {
    process.exitCode = 1;
    console.error(`Cleanup left ${evidence.residual.join(", ")}. Rebuild this server before you set up the deployment.`);
  }
}
