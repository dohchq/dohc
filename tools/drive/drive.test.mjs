import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { parseEnv } from "node:util";
import test from "node:test";
import { initialSettings } from "../self-host/bootstrap.mjs";
import * as config from "../self-host/config.mjs";
import { deploymentFolders, parseDriveArguments, redactor, runDrive, secretNames } from "./drive.mjs";

const uuid = "0f3c9a52-6d1e-4b7a-9c2d-5e8f1a2b3c4d", bundle = "/srv/dohc-release", envFile = "/etc/dohc/drive.env";
const revision = "a".repeat(40), imageId = `sha256:${"b".repeat(64)}`, image = `dohc-self-host:${revision}`;
const files = ["docker-compose.self-host.yml", "scripts/check-self-host.mjs", "scripts/self-host/move.mjs", "tools/self-host/config.mjs"];
const baseSettings = () => ({ ...parseEnv(readFileSync(new URL("../../.env.self-host.example", import.meta.url), "utf8")),
  ...initialSettings({ origin: "https://drive.team.invalid", image }),
  DOHC_BEHIND_CLOUDFLARE: "1", DOHC_DATA_DIRECTORY: "/mnt/drive/dohc",
  DOHC_POSTGRES_HOST: "db.provider.invalid", DOHC_POSTGRES_PORT: "5432", DOHC_POSTGRES_CA_FILE: "/etc/dohc/postgres-ca.pem",
  POSTGRES_DB: "dohc", POSTGRES_USER: "dohc", POSTGRES_PASSWORD: "provider-database-password",
  DOHC_SMTP_HOST: "smtp.provider.invalid", DOHC_SMTP_PORT: "2525", DOHC_SMTP_SECURE: "false", DOHC_SMTP_USER: "smtp-server-token",
  DOHC_SMTP_PASSWORD: "smtp-server-token", DOHC_SMTP_FROM: "noreply@drive.team.invalid", DOHC_SIGN_UP_EMAILS: "owner@team.invalid",
  DOHC_RELAY_APP_PUBLICATIONS: "1", DOHC_SHARE_WEB_APP_DOMAIN: "team-apps.invalid",
  DOHC_APP_TLS_CERT_FILE: "/etc/dohc/app-tls/cert.pem", DOHC_APP_TLS_KEY_FILE: "/etc/dohc/app-tls/key.pem",
  DOHC_SNAPSHOT_S3_ENDPOINT: "https://storage.provider.invalid", DOHC_SNAPSHOT_S3_BUCKET: "dohc-snapshots",
  DOHC_SNAPSHOT_S3_ACCESS_KEY_ID: "storage-access-key", DOHC_SNAPSHOT_S3_SECRET_ACCESS_KEY: "storage-secret-key",
  DOHC_SNAPSHOT_ALERT_EMAIL: "ops@team.invalid", DOHC_SNAPSHOT_HEARTBEAT_URL: "https://heartbeat.provider.invalid/ping/private-check" });

const stat = (kind, { mode = kind === "dir" ? 0o700 : 0o600, uid = 0, gid = 0, dev = 2 } = {}) => ({
  isFile: () => kind === "file", isDirectory: () => kind === "dir", isSymbolicLink: () => kind === "link",
  mode: (kind === "dir" ? 0o040000 : kind === "file" ? 0o100000 : 0o120000) | mode, uid, gid, dev });

/**
 * An in-memory Drive host. The volume starts mounted unless `mounted` is false; a successful `mount` call mounts it.
 * `child` is the raw output of the release command. Every command the wrapper runs is recorded in `calls`.
 */
function driveHost({ settings = baseSettings(), release = {}, imageDetails = {}, mounted = true, otherMounts = [], devices = ["/dev/sda"],
  mountPoint = [], mountStatus = 0, ipv6 = [], folders = {}, stats = {}, accounts = "missing", child = "", childStatus = 0, platform = "linux", arch = "x64" } = {}) {
  const calls = [], written = [];
  const state = { mounted };
  const releaseJson = { version: 1, revision, dirty: false, image, imageId, platform: "linux/amd64", files, archive: "services.tar", ...release };
  const folderStats = name => folders[name] === undefined ? stat("dir", { uid: 1000, gid: 1000 }) : folders[name];
  const host = {
    platform, arch, uid: 0,
    lstat(path) {
      if (Object.hasOwn(stats, path)) return stats[path];
      if (path === envFile) return stat("file");
      if (path === `${bundle}/release.json` || files.some(file => path === `${bundle}/${file}`)) return stat("file", { mode: 0o644 });
      if (path === "/etc/dohc/postgres-ca.pem" || path === "/etc/dohc/app-tls/cert.pem") return stat("file", { mode: 0o644, dev: 1 });
      if (path === "/etc/dohc/app-tls/key.pem") return stat("file", { dev: 1 });
      if (path === "/mnt/drive") return stat("dir", { mode: 0o755, dev: state.mounted ? 2 : 1 });
      if (!state.mounted) return undefined;
      if (path === "/mnt/drive/dohc") return stat("dir", { mode: 0o755 });
      const folder = deploymentFolders.find(name => path === `/mnt/drive/dohc/${name}`);
      return folder ? folderStats(folder) : undefined;
    },
    readFile(path) {
      if (path === envFile) return Object.entries(settings).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}='${value}'\n`).join("");
      if (path === `${bundle}/release.json`) return JSON.stringify(releaseJson);
      throw new Error(`Unexpected read of ${path}`);
    },
    readdir(path) { assert.equal(path, "/mnt/drive"); return mountPoint; },
    loadConfig(path) { assert.equal(path, bundle); return config; },
    write: text => written.push(text),
    async run(command, args, options = {}) {
      calls.push({ command, args, cwd: options.cwd });
      if (command === "docker" && args[0] === "compose") {
        assert.deepEqual(args.slice(-6), ["run", "--rm", "--no-deps", "-T", "postgres-migrate", "check-accounts"]);
        assert.equal(options.cwd, bundle);
        return accounts === null ? { status: 1, stdout: "" } : { status: 0, stdout: `${accounts}\n` };
      }
      if (command === "docker") {
        assert.deepEqual(args.slice(0, 2), ["image", "inspect"]);
        return { status: 0, stdout: JSON.stringify([{ Id: imageId, Os: "linux", Architecture: "amd64",
          Config: { Labels: { "org.opencontainers.image.revision": revision } }, ...imageDetails }]) };
      }
      if (command === "blkid") {
        assert.deepEqual(args, ["-c", "/dev/null", "-t", `UUID=${uuid}`, "-o", "device"]);
        return devices.length ? { status: 0, stdout: devices.map(device => `${device}\n`).join("") } : { status: 2, stdout: "" };
      }
      if (command === "ip") return { status: 0, stdout: JSON.stringify(ipv6.length ? [{ ifname: "eth0", addr_info: ipv6 }] : []) };
      if (command === "findmnt") {
        const list = [{ target: "/", source: "/dev/vda1", uuid: "11111111-2222-4333-8444-555555555555", fstype: "ext4" }, ...otherMounts,
          ...(state.mounted ? [{ target: "/mnt/drive", source: "/dev/sda", uuid, fstype: "ext4" }] : [])];
        return { status: 0, stdout: JSON.stringify({ filesystems: list }) };
      }
      if (command === "mount") { if (mountStatus === 0) state.mounted = true; return { status: mountStatus, stdout: "" }; }
      if (command === process.execPath) {
        // Arrives in two chunks that split a line, as a pipe can deliver it.
        options.onOutput(child.slice(0, 7));
        options.onOutput(child.slice(7));
        return { status: childStatus, stdout: child };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  };
  return { host, calls, output: () => written.join(""), state };
}

const options = (command, extra = {}) => ({ command, bundle, envFile, volumeUuid: uuid, firstStart: false, ...extra });
const releaseCall = calls => calls.find(call => call.command === process.execPath);
// None of these may ever run: the wrapper never formats, partitions or creates storage, and never changes Docker state itself.
const forbidden = /^(mkfs.*|mke2fs|wipefs|parted|fdisk|sgdisk|mkdir|install|chown|chmod|umount|losetup)$/;
const accountsCheck = call => call.command === "docker" && call.args[0] === "compose";
const assertSafe = calls => {
  for (const call of calls) {
    assert.doesNotMatch(posix.basename(call.command), forbidden, call.command);
    if (call.command === "docker" && !accountsCheck(call)) assert.deepEqual(call.args.slice(0, 2), ["image", "inspect"]);
  }
};

test("arguments need a command, the bundle, the configuration and the volume's filesystem UUID", () => {
  assert.deepEqual(parseDriveArguments(["move", "--bundle", "/srv/dohc-release/", "--env-file", envFile, "--volume-uuid", uuid]),
    { command: "move", bundle, envFile, volumeUuid: uuid, firstStart: false });
  assert.equal(parseDriveArguments(["start", "--first-start", "--bundle", bundle, "--env-file", envFile, "--volume-uuid", uuid]).firstStart, true);
  for (const args of [[], ["check"], ["check", "--bundle", bundle, "--env-file", envFile], ["status", "--bundle", bundle, "--env-file", envFile, "--volume-uuid", uuid],
    ["check", "move", "--bundle", bundle, "--env-file", envFile, "--volume-uuid", uuid], ["check", "--bundle", bundle, "--env-file", envFile, "--volume-uuid", uuid, "--force"]]) {
    assert.throws(() => parseDriveArguments(args), /check\|start\|move --bundle DIR/, args.join(" "));
  }
  for (const value of ["0F3C9A52-6D1E-4B7A-9C2D-5E8F1A2B3C4D", "/dev/sda", "0f3c9a52", `${uuid} `]) {
    assert.throws(() => parseDriveArguments(["check", "--bundle", bundle, "--env-file", envFile, "--volume-uuid", value]), /lowercase filesystem UUID/, value);
  }
  for (const command of ["check", "move"]) {
    assert.throws(() => parseDriveArguments([command, "--first-start", "--bundle", bundle, "--env-file", envFile, "--volume-uuid", uuid]), /only with start/);
  }
});

test("check delegates to the release check with the same configuration and mounts nothing", async () => {
  const { host, calls, output } = driveHost({ child: "[ok] self-host env values\nSelf-host check summary: 9/9 checks passed.\n" });
  await runDrive(options("check"), host);
  assert.deepEqual(releaseCall(calls), { command: process.execPath, args: ["scripts/check-self-host.mjs", "--env-file", envFile], cwd: bundle });
  assert.deepEqual(calls.map(call => call.command), ["docker", "ip", "blkid", "findmnt", process.execPath]);
  assert.deepEqual(calls[0].args, ["image", "inspect", image]);
  assert.match(output(), new RegExp(`Release ${revision} for linux/amd64, volume ${uuid} at /mnt/drive: checks passed\\.\\n`));
  assert.match(output(), /Self-host check summary: 9\/9 checks passed\.\n$/);
  assertSafe(calls);
});

test("start runs a first start only when asked, and every other start as a normal start", async () => {
  const normal = driveHost();
  await runDrive(options("start"), normal.host);
  assert.deepEqual(releaseCall(normal.calls).args, ["scripts/check-self-host.mjs", "--start", "--env-file", envFile]);
  assert.doesNotMatch(normal.output(), /First start/);
  assert.ok(!normal.calls.some(accountsCheck));
  const first = driveHost();
  await runDrive(options("start", { firstStart: true }), first.host);
  assert.deepEqual(releaseCall(first.calls).args, ["scripts/check-self-host.mjs", "--start", "--first-start", "--env-file", envFile]);
  assert.ok(first.calls.findIndex(accountsCheck) < first.calls.indexOf(releaseCall(first.calls)));
  assert.match(first.output(), /First start: the release creates a new relay deployment/);
  assertSafe(first.calls);
  // Check and start never mount: an unmounted volume refuses before the release runs.
  for (const command of ["check", "start"]) {
    const { host, calls } = driveHost({ mounted: false });
    await assert.rejects(runDrive(options(command), host), new RegExp(`Volume ${uuid} is not mounted at /mnt/drive`));
    assert.ok(!calls.some(call => call.command === "mount" || call.command === process.execPath), command);
  }
});

test("a first start refuses a database that already holds accounts, or one it cannot check, before the release runs", async () => {
  for (const [accounts, message] of [["present", /already holds dohc accounts.*Recover from total loss/], [null, /Could not check database dohc on db\.provider\.invalid/]]) {
    const { host, calls } = driveHost({ accounts });
    await assert.rejects(runDrive(options("start", { firstStart: true }), host), message, String(accounts));
    assert.equal(releaseCall(calls), undefined);
  }
});

test("move mounts the attached volume by UUID, keeps every deployment folder, then runs the release move", async () => {
  const { host, calls, output, state } = driveHost({ mounted: false });
  await runDrive(options("move"), host);
  assert.equal(state.mounted, true);
  assert.deepEqual(calls.find(call => call.command === "mount").args, ["-o", "nodev,nosuid,noexec", `UUID=${uuid}`, "/mnt/drive"]);
  assert.deepEqual(releaseCall(calls), { command: process.execPath, args: ["scripts/self-host/move.mjs", "--env-file", envFile], cwd: bundle });
  assert.ok(calls.findIndex(call => call.command === "mount") < calls.indexOf(releaseCall(calls)));
  assert.match(output(), new RegExp(`Mounting volume ${uuid} at /mnt/drive\\.`));
  assertSafe(calls);
  // A volume that is already mounted in place is used as it is.
  const mounted = driveHost();
  await runDrive(options("move"), mounted.host);
  assert.ok(!mounted.calls.some(call => call.command === "mount"));
  assert.ok(releaseCall(mounted.calls));
});

test("move refuses without the attached volume, or with anything else at the mount point, and never runs the release", async () => {
  const refusals = [
    [{ devices: [] }, /No attached volume has filesystem UUID .* never attaches, formats or creates a volume/],
    [{ devices: ["/dev/sda", "/dev/sdb"] }, /Devices \/dev\/sda, \/dev\/sdb all have filesystem UUID .* Detach every copy/],
    [{ stats: { "/mnt/drive": undefined } }, /Create \/mnt\/drive as an empty folder .* never creates it/],
    [{ mountPoint: ["lost+found"] }, /Create \/mnt\/drive as an empty folder/],
    [{ mountStatus: 32 }, /Could not mount volume/],
    [{ otherMounts: [{ target: "/mnt/drive", source: "/dev/sdb", uuid: "99999999-8888-4777-8666-555555555555", fstype: "ext4" }] }, /Another filesystem is mounted at \/mnt\/drive/],
    [{ otherMounts: [{ target: "/mnt/other", source: "/dev/sda", uuid, fstype: "ext4" }] }, /is mounted at \/mnt\/other, not \/mnt\/drive/],
  ];
  for (const [setup, message] of refusals) {
    const { host, calls } = driveHost({ mounted: false, ...setup });
    await assert.rejects(runDrive(options("move"), host), message, JSON.stringify(setup));
    assert.equal(releaseCall(calls), undefined, JSON.stringify(setup));
    assertSafe(calls);
  }
});

test("a missing, moved or exposed deployment folder refuses without being created", async () => {
  for (const folder of deploymentFolders) {
    for (const [replacement, message] of [[undefined, /is missing from the volume\. .*Never recreate deployment folders/],
      [stat("dir", { uid: 1000, gid: 1000, dev: 1 }), /must be a folder on the volume mounted at \/mnt\/drive/],
      [stat("link"), /must be a folder on the volume/], [stat("dir", { uid: 0, gid: 0 }), /must belong to UID 1000 and group 1000, with mode 0700/],
      [stat("dir", { uid: 1000, gid: 1000, mode: 0o755 }), /mode 0700/], [stat("dir", { uid: 1000, gid: 1000, mode: 0o600 }), /mode 0700/]]) {
      const path = `/mnt/drive/dohc/${folder}`;
      for (const command of ["check", "move"]) {
        const { host, calls } = driveHost({ mounted: command === "check", stats: { [path]: replacement } });
        await assert.rejects(runDrive(options(command), host), message, `${command} ${path}`);
        assert.equal(releaseCall(calls), undefined);
        assertSafe(calls);
      }
    }
  }
  const { host } = driveHost({ stats: { "/mnt/drive/dohc": undefined } });
  await assert.rejects(runDrive(options("check"), host), /\/mnt\/drive\/dohc is missing from the volume/);
  // A copy of the volume attached beside it could be mounted in its place at the next boot.
  const clone = driveHost({ devices: ["/dev/sda", "/dev/sdb"] });
  await assert.rejects(runDrive(options("check"), clone.host), /Detach every copy of the volume/);
  assert.equal(releaseCall(clone.calls), undefined);
});

test("the release bundle, its image and the host architecture must match", async () => {
  const refusals = [
    [{ platform: "darwin" }, /runs Linux/],
    [{ release: { dirty: true } }, /uncommitted source/],
    [{ release: { revision: "main" } }, /holds no release bundle/],
    [{ release: { platform: "linux/arm64" } }, /release is for linux\/arm64, but this host is linux\/amd64/],
    [{ arch: "ia32" }, /this host is linux\/ia32/],
    [{ release: { files: [...files, "docs/how-to/self-host.md"] } }, /missing docs\/how-to\/self-host\.md/],
    [{ settings: { ...baseSettings(), DOHC_IMAGE: "dohc-self-host:other" } }, new RegExp(`Set DOHC_IMAGE to dohc-self-host:${revision}`)],
    [{ imageDetails: { Id: `sha256:${"c".repeat(64)}` } }, /not the image this release bundle records/],
    [{ imageDetails: { Architecture: "arm64" } }, /not the image this release bundle records/],
    [{ imageDetails: { Config: { Labels: { "org.opencontainers.image.revision": "d".repeat(40) } } } }, /not the image this release bundle records/],
  ];
  for (const [setup, message] of refusals) {
    const { host, calls } = driveHost(setup);
    await assert.rejects(runDrive(options("check"), host), message, JSON.stringify(setup));
    assert.equal(releaseCall(calls), undefined);
  }
});

test("the configuration must be private and complete for Drive, and the release's own validation applies", async () => {
  const refusals = [
    [{ stats: { [envFile]: stat("file", { mode: 0o640 }) } }, /must be a regular file that belongs to you, with mode 0600/],
    [{ stats: { [envFile]: stat("link") } }, /must be a regular file/],
    [{ stats: { [envFile]: stat("file", { uid: 1000 }) } }, /belongs to you/],
    [{ settings: { ...baseSettings(), DOHC_SIGN_UP_EMAILS: "" } }, /keeps sign-up private/],
    [{ settings: { ...baseSettings(), DOHC_BEHIND_CLOUDFLARE: "0", DOHC_APP_TLS_CERT_FILE: "", DOHC_APP_TLS_KEY_FILE: "" } }, /runs behind Cloudflare/],
    [{ settings: { ...baseSettings(), DOHC_POSTGRES_HOST: "", DOHC_POSTGRES_PORT: "", DOHC_POSTGRES_CA_FILE: "", POSTGRES_PASSWORD: "x".repeat(43) } }, /keeps accounts in Neon/],
    [{ settings: { ...baseSettings(), DOHC_SNAPSHOT_HEARTBEAT_URL: "" } }, /takes hourly snapshots/],
    [{ settings: { ...baseSettings(), DOHC_SNAPSHOT_S3_BUCKET: "<bucket>" } }, /Replace the placeholder in DOHC_SNAPSHOT_S3_BUCKET/],
    [{ settings: { ...baseSettings(), DOHC_DATA_DIRECTORY: "/dohc" } }, /directly on the volume's mount point/],
    [{ settings: { ...baseSettings(), DOHC_APP_TLS_KEY_FILE: "" } }, /Set DOHC_APP_TLS_KEY_FILE to the absolute path/],
    [{ settings: { ...baseSettings(), DOHC_SMTP_PORT: "25x" } }, /Set DOHC_SMTP_PORT to a valid port/],
    [{ stats: { "/etc/dohc/postgres-ca.pem": stat("file", { mode: 0o600 }) } }, /postgres-ca\.pem.* belongs to root, with mode 0644/],
    [{ stats: { "/etc/dohc/postgres-ca.pem": stat("file", { mode: 0o666 }) } }, /postgres-ca\.pem.* belongs to root, with mode 0644/],
    [{ stats: { "/etc/dohc/postgres-ca.pem": stat("file", { mode: 0o644, uid: 1000 }) } }, /postgres-ca\.pem.* belongs to root/],
    [{ stats: { "/etc/dohc/postgres-ca.pem": undefined } }, /must be a regular file/],
    [{ stats: { "/etc/dohc/app-tls/cert.pem": stat("file", { mode: 0o664 }) } }, /cert\.pem.* belongs to root, with mode 0644/],
    [{ stats: { "/etc/dohc/app-tls/key.pem": stat("file", { mode: 0o644 }) } }, /key\.pem.* belongs to root, with mode 0600/],
    [{ stats: { "/etc/dohc/app-tls/key.pem": stat("file", { uid: 1000 }) } }, /key\.pem.* belongs to root/],
    [{ ipv6: [{ family: "inet6", local: "2001:db8::10", scope: "global" }] }, /public IPv6 address/],
  ];
  for (const [setup, message] of refusals) {
    const { host, calls } = driveHost(setup);
    await assert.rejects(runDrive(options("check"), host), message, JSON.stringify(setup).slice(0, 200));
    assert.equal(releaseCall(calls), undefined);
  }
});

test("drive.env.example holds Drive's public settings and no credentials, and its placeholders refuse until replaced", async () => {
  const text = readFileSync(new URL("./drive.env.example", import.meta.url), "utf8"), example = parseEnv(text);
  for (const name of secretNames) assert.equal(example[name], undefined, name);
  assert.equal(example.DOHC_SIGN_UP_EMAILS, "<approved-addresses>");
  assert.deepEqual({ origin: example.DOHC_PUBLIC_ORIGIN, host: example.DOHC_PUBLIC_HOST, smtp: [example.DOHC_SMTP_HOST, example.DOHC_SMTP_PORT, example.DOHC_SMTP_SECURE],
    from: example.DOHC_SMTP_FROM, apps: [example.DOHC_RELAY_APP_PUBLICATIONS, example.DOHC_SHARE_WEB_APP_DOMAIN], cloudflare: example.DOHC_BEHIND_CLOUDFLARE,
    region: example.DOHC_SNAPSHOT_S3_REGION, data: example.DOHC_DATA_DIRECTORY }, {
    origin: "https://drive.dohc.computer", host: "drive.dohc.computer", smtp: ["smtp.postmarkapp.com", "2525", "false"], from: "noreply@drive.dohc.computer",
    apps: ["1", "dohc.app"], cloudflare: "1", region: "auto", data: "/mnt/dohc-drive/dohc" });
  const filled = { ...baseSettings(), ...example, DOHC_DATA_DIRECTORY: "/mnt/drive/dohc" };
  const placeholders = ["DOHC_IMAGE", "DOHC_POSTGRES_HOST", "POSTGRES_DB", "POSTGRES_USER", "DOHC_SIGN_UP_EMAILS", "DOHC_SNAPSHOT_S3_ENDPOINT", "DOHC_SNAPSHOT_S3_BUCKET"];
  const unfilled = driveHost({ settings: filled });
  await assert.rejects(runDrive(options("check"), unfilled.host), error => placeholders.every(name => error.message.includes(name)));
  const replaced = driveHost({ settings: { ...filled, DOHC_IMAGE: image, DOHC_POSTGRES_HOST: "db.provider.invalid", POSTGRES_DB: "dohc", POSTGRES_USER: "dohc",
    DOHC_SIGN_UP_EMAILS: "owner@team.invalid", DOHC_SNAPSHOT_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com", DOHC_SNAPSHOT_S3_BUCKET: "dohc-snapshots" } });
  await runDrive(options("check"), replaced.host);
  assert.ok(releaseCall(replaced.calls));
});

test("no secret reaches the terminal, in release output or in errors", async () => {
  const settings = baseSettings(), secrets = secretNames.map(name => settings[name]).filter(Boolean);
  assert.equal(secrets.length, secretNames.length);
  const child = `${secrets.join(" ")}\npostgres://dohc:${encodeURIComponent(settings.POSTGRES_PASSWORD)}@db.provider.invalid/dohc\nlast line without newline`;
  const failed = driveHost({ settings, child, childStatus: 1 });
  await assert.rejects(runDrive(options("start"), failed.host), /The release start command failed/);
  const output = failed.output();
  for (const secret of secrets) assert.ok(!output.includes(secret), secret);
  assert.match(output, /\[redacted\]/);
  assert.match(output, /last line without newline\n$/);
  // An error that quotes a setting is redacted as well.
  const redact = redactor(settings);
  assert.equal(redact(`token ${settings.DOHC_SMTP_PASSWORD} and ${settings.DOHC_SNAPSHOT_HEARTBEAT_URL}`), "token [redacted] and [redacted]");
  assert.equal(redact("drive.team.invalid"), "drive.team.invalid");
});

test("a short secret is redacted too, even when the output splits it", async () => {
  // The release accepts an external database password of any length.
  const short = "Qz7k9", { host, calls, output } = driveHost({ settings: { ...baseSettings(), POSTGRES_PASSWORD: short }, child: `start ${short} end\n` });
  await runDrive(options("check"), host);
  assert.ok(releaseCall(calls));
  assert.ok(!output().includes(short));
  assert.match(output(), /start \[redacted\] end\n$/);
});

test("a secret setting that spans lines refuses before anything runs, without its value", async () => {
  const { host, calls } = driveHost({ settings: { ...baseSettings(), DOHC_SMTP_PASSWORD: "first-half\nsecond-half" } });
  assert.match(parseEnv(host.readFile(envFile)).DOHC_SMTP_PASSWORD, /\n/);
  await assert.rejects(runDrive(options("check"), host), error =>
    /Put DOHC_SMTP_PASSWORD on one line/.test(error.message) && !/first-half|second-half/.test(error.message));
  assert.deepEqual(calls, []);
});
