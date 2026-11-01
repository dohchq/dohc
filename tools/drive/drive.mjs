#!/usr/bin/env node
// Checks, starts and moves the dohc Drive server through the self-host release's own commands. See docs/how-to/drive.md.
import { spawn } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

const usage = `node tools/drive/drive.mjs check|start|move --bundle DIR --env-file PATH --volume-uuid UUID [--first-start]

check   Checks this host, the release, the configuration and the mounted volume, then runs the release check.
start   Runs the same checks, then starts the deployment. Add --first-start only for the deployment's first start.
move    Mounts the attached volume by its filesystem UUID, runs the same checks, then runs the release move.
        Stop the old server and attach its volume to this Droplet first. This command never attaches a volume.

No command formats a disk, creates a deployment folder or prints a secret.`;

/** Settings whose values never reach the terminal. The Healthchecks URL is itself a credential. */
export const secretNames = ["POSTGRES_PASSWORD", "BETTER_AUTH_SECRET", "DOHC_RELAY_LINK_KEY", "DOHC_RELAY_EXCHANGE_KEY", "DOHC_SNAPSHOT_KEY",
  "DOHC_SMTP_USER", "DOHC_SMTP_PASSWORD", "DOHC_SNAPSHOT_S3_ACCESS_KEY_ID", "DOHC_SNAPSHOT_S3_SECRET_ACCESS_KEY", "DOHC_SNAPSHOT_HEARTBEAT_URL"];
export const deploymentFolders = ["sync-relay", "continuity", "host-data", "snapshots"];
const dockerArchitectures = { x64: "amd64", arm64: "arm64" };

export function parseDriveArguments(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      bundle: { type: "string" }, "env-file": { type: "string" }, "volume-uuid": { type: "string" }, "first-start": { type: "boolean" } } });
  } catch { throw new Error(usage); }
  const { values, positionals } = parsed, [command] = positionals;
  if (positionals.length !== 1 || !["check", "start", "move"].includes(command) || !values.bundle || !values["env-file"] || !values["volume-uuid"]) {
    throw new Error(usage);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(values["volume-uuid"])) {
    throw new Error("Set --volume-uuid to the volume's lowercase filesystem UUID, as lsblk -o NAME,UUID shows it.");
  }
  if (values["first-start"] && command !== "start") throw new Error("Use --first-start only with start.");
  return { command, bundle: posix.resolve(values.bundle), envFile: posix.resolve(values["env-file"]), volumeUuid: values["volume-uuid"],
    firstStart: Boolean(values["first-start"]) };
}

export function redactor(settings) {
  const values = [...new Set(secretNames.map(name => settings[name]).filter(value => value && value.length >= 6)
    .flatMap(value => [value, encodeURIComponent(value)]))].sort((a, b) => b.length - a.length);
  return text => values.reduce((result, value) => result.split(value).join("[redacted]"), text);
}

/** Writes child output a line at a time, so a secret split across two chunks is still redacted. */
function lineWriter(redact, write) {
  let rest = "";
  return {
    push(chunk) {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      for (const line of lines) write(`${redact(line)}\n`);
    },
    end() { if (rest) write(`${redact(rest)}\n`); rest = ""; },
  };
}

function spawnRun(command, args, { cwd, onOutput } = {}) {
  return new Promise(done => {
    let stdout = "", stderr = "";
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; onOutput?.(chunk); });
    child.stderr.on("data", chunk => { stderr += chunk; onOutput?.(chunk); });
    child.on("error", () => done({ status: null, stdout, stderr }));
    child.on("close", status => done({ status, stdout, stderr }));
  });
}

export const systemHost = {
  platform: process.platform, arch: process.arch, uid: process.getuid?.(),
  lstat: path => lstatSync(path, { throwIfNoEntry: false }),
  readFile: path => readFileSync(path, "utf8"),
  readdir: path => readdirSync(path),
  loadConfig: bundle => import(pathToFileURL(posix.join(bundle, "tools/self-host/config.mjs")).href),
  run: spawnRun,
  write: text => process.stdout.write(text),
};

const privateMode = stats => (stats.mode & 0o077) === 0;

function checkRelease(options, host) {
  const read = path => { try { return JSON.parse(host.readFile(path)); } catch { return undefined; } };
  const release = read(posix.join(options.bundle, "release.json")), architecture = dockerArchitectures[host.arch];
  if (release?.version !== 1 || !/^[0-9a-f]{40}$/.test(release.revision ?? "") || typeof release.image !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(release.imageId ?? "") || !Array.isArray(release.files)) {
    throw new Error(`${options.bundle} holds no release bundle. Use the folder that release.mjs wrote, with its release.json.`);
  }
  if (release.dirty !== false) throw new Error("The release was built from uncommitted source. Build Drive's release from a clean checkout.");
  if (!architecture || release.platform !== `linux/${architecture}`) {
    throw new Error(`The release is for ${release.platform}, but this host is linux/${architecture ?? host.arch}. Build the release for this host.`);
  }
  const missing = release.files.filter(file => !host.lstat(posix.join(options.bundle, file))?.isFile());
  if (missing.length) throw new Error(`The release bundle is missing ${missing.join(", ")}. Copy the whole bundle again.`);
  return { ...release, architecture };
}

function checkSettings(options, settings, release, config) {
  const errors = config.validateSettings(settings);
  const placeholders = Object.keys(settings).filter(name => /<[a-z0-9-]+>/i.test(settings[name]));
  if (placeholders.length) errors.push(`Replace the placeholder in ${placeholders.join(", ")}.`);
  if (settings.DOHC_IMAGE !== release.image) errors.push(`Set DOHC_IMAGE to ${release.image}, the image this release bundle records.`);
  if (settings.DOHC_BEHIND_CLOUDFLARE !== "1") errors.push("Drive runs behind Cloudflare. Set DOHC_BEHIND_CLOUDFLARE=1.");
  if (!settings.DOHC_POSTGRES_HOST) errors.push("Drive keeps accounts in Neon. Set DOHC_POSTGRES_HOST and the other external database settings.");
  if (!settings.DOHC_SIGN_UP_EMAILS?.trim()) errors.push("Drive keeps sign-up private. List the approved addresses in DOHC_SIGN_UP_EMAILS.");
  if (!settings.DOHC_SNAPSHOT_S3_BUCKET || !settings.DOHC_SNAPSHOT_HEARTBEAT_URL) {
    errors.push("Drive takes hourly snapshots. Set the DOHC_SNAPSHOT_S3_ values and DOHC_SNAPSHOT_HEARTBEAT_URL.");
  }
  const mount = settings.DOHC_DATA_DIRECTORY ? posix.dirname(settings.DOHC_DATA_DIRECTORY) : "/";
  if (mount === "/") errors.push("Set DOHC_DATA_DIRECTORY to a folder directly on the volume's mount point, such as /mnt/dohc-drive/dohc.");
  if (errors.length) throw new Error(errors.join("\n"));
  return mount;
}

function checkFiles(settings, host) {
  const file = (name, check, problem) => {
    const stats = host.lstat(settings[name]);
    if (!stats?.isFile() || !check(stats)) throw new Error(`${settings[name]}, named by ${name}, ${problem}`);
  };
  // The services run as UID 1000 and read the CA file. The gateway runs as root and reads the app certificate and key.
  file("DOHC_POSTGRES_CA_FILE", stats => (stats.mode & 0o004) !== 0, "must be a regular file that UID 1000 can read, with mode 0644.");
  if (settings.DOHC_APP_TLS_CERT_FILE) {
    file("DOHC_APP_TLS_CERT_FILE", () => true, "must be a regular file.");
    file("DOHC_APP_TLS_KEY_FILE", privateMode, "must be a regular file that only its owner can read, with mode 0600.");
  }
}

async function checkHost(settings, release, host) {
  const inspected = await host.run("docker", ["image", "inspect", settings.DOHC_IMAGE]);
  let image;
  try { image = inspected.status === 0 ? JSON.parse(inspected.stdout)[0] : undefined; } catch { image = undefined; }
  if (!image) throw new Error(`Docker has no image ${settings.DOHC_IMAGE}. Load services.tar from the release bundle, then try again.`);
  if (image.Id !== release.imageId || image.Os !== "linux" || image.Architecture !== release.architecture ||
    image.Config?.Labels?.["org.opencontainers.image.revision"] !== release.revision) {
    throw new Error(`Image ${settings.DOHC_IMAGE} is not the image this release bundle records. Load services.tar from the same bundle.`);
  }
  // Docker publishes ports 80 and 443 on IPv6 too, and DOCKER-USER filters only IPv4, so an IPv6 address bypasses Cloudflare's ranges.
  const addresses = await host.run("ip", ["-json", "-6", "address", "show", "scope", "global"]);
  let global;
  try { global = addresses.status === 0 ? JSON.parse(addresses.stdout || "[]").flatMap(link => link.addr_info ?? []) : undefined; } catch { global = undefined; }
  if (!global) throw new Error("Could not list this host's IPv6 addresses with ip. Check that iproute2 is installed, then try again.");
  if (global.length) throw new Error("This host has a public IPv6 address. Turn off IPv6 for the Droplet: the origin accepts only IPv4 from Cloudflare.");
}

async function mounts(host) {
  const result = await host.run("findmnt", ["--json", "--list", "--output", "TARGET,SOURCE,UUID,FSTYPE"]);
  try { if (result.status === 0) return JSON.parse(result.stdout).filesystems; } catch { /* reported below */ }
  throw new Error("Could not list mounted filesystems with findmnt. Check that util-linux is installed, then try again.");
}

/** Returns true when the volume is mounted at `mount`. Throws when anything else holds the mount point or the volume. */
async function mountState(mount, uuid, host) {
  const list = await mounts(host), current = list.filter(entry => entry.target === mount).at(-1);
  const elsewhere = list.filter(entry => entry.uuid?.toLowerCase() === uuid && entry.target !== mount).map(entry => entry.target);
  if (elsewhere.length) throw new Error(`Volume ${uuid} is mounted at ${elsewhere.join(", ")}, not ${mount}. Keep one mount, at ${mount}.`);
  if (current && current.uuid?.toLowerCase() !== uuid) {
    throw new Error(`Another filesystem is mounted at ${mount}. Check that --volume-uuid names this deployment's volume.`);
  }
  return Boolean(current);
}

async function mountVolume(mount, uuid, host) {
  if (!host.lstat(`/dev/disk/by-uuid/${uuid}`)) {
    throw new Error(`No attached volume has filesystem UUID ${uuid}. Attach the volume to this Droplet in DigitalOcean, then try again. ` +
      "This command never attaches, formats or creates a volume.");
  }
  if (!host.lstat(mount)?.isDirectory() || host.readdir(mount).length) {
    throw new Error(`Create ${mount} as an empty folder for the mount point, then try again. This command never creates it.`);
  }
  host.write(`Mounting volume ${uuid} at ${mount}.\n`);
  const result = await host.run("mount", ["-o", "nodev,nosuid,noexec", `UUID=${uuid}`, mount]);
  if (result.status !== 0 || !await mountState(mount, uuid, host)) throw new Error(`Could not mount volume ${uuid} at ${mount}. Run this command as root.`);
}

function checkFolders(settings, mount, host) {
  const device = host.lstat(mount)?.dev, directory = settings.DOHC_DATA_DIRECTORY;
  for (const path of [directory, ...deploymentFolders.map(folder => posix.join(directory, folder))]) {
    const stats = host.lstat(path);
    // A missing folder means the wrong volume or a new one. Recreating it would start a new, empty deployment.
    if (!stats) throw new Error(`${path} is missing from the volume. Check --volume-uuid and DOHC_DATA_DIRECTORY. Never recreate deployment folders.`);
    if (!stats.isDirectory() || stats.dev !== device) throw new Error(`${path} must be a folder on the volume mounted at ${mount}.`);
    if (path !== directory && (stats.uid !== 1000 || stats.gid !== 1000 || !privateMode(stats))) {
      throw new Error(`${path} must belong to UID 1000 and group 1000, with mode 0700.`);
    }
  }
}

const releaseCommands = {
  check: options => ["scripts/check-self-host.mjs", "--env-file", options.envFile],
  start: options => ["scripts/check-self-host.mjs", "--start", ...(options.firstStart ? ["--first-start"] : []), "--env-file", options.envFile],
  move: options => ["scripts/self-host/move.mjs", "--env-file", options.envFile],
};

export async function runDrive(options, host = systemHost) {
  let redact = text => text;
  try {
    if (host.platform !== "linux") throw new Error("Run Drive commands on the Drive server, which runs Linux.");
    const release = checkRelease(options, host);
    const envStats = host.lstat(options.envFile);
    if (!envStats?.isFile() || envStats.uid !== host.uid || !privateMode(envStats)) {
      throw new Error(`${options.envFile} must be a regular file that belongs to you and only you can read, with mode 0600. It holds the server's secrets.`);
    }
    const settings = parseEnv(host.readFile(options.envFile));
    redact = redactor(settings);
    const mount = checkSettings(options, settings, release, await host.loadConfig(options.bundle));
    checkFiles(settings, host);
    await checkHost(settings, release, host);
    if (!await mountState(mount, options.volumeUuid, host)) {
      if (options.command !== "move") {
        throw new Error(`Volume ${options.volumeUuid} is not mounted at ${mount}. Mount it as described in docs/how-to/drive.md, then try again.`);
      }
      await mountVolume(mount, options.volumeUuid, host);
    }
    checkFolders(settings, mount, host);
    host.write(`Release ${release.revision} for ${release.platform}, volume ${options.volumeUuid} at ${mount}: checks passed.\n`);
    if (options.firstStart) host.write("First start: the release creates a new relay deployment and refuses if any deployment folder holds data.\n");
    const output = lineWriter(redact, host.write);
    const result = await host.run(process.execPath, releaseCommands[options.command](options), { cwd: options.bundle, onOutput: chunk => output.push(chunk) });
    output.end();
    if (result.status !== 0) throw new Error(`The release ${options.command} command failed. Read its output above.`);
  } catch (error) { throw new Error(redact(error.message)); }
}

if (process.argv[1] && pathToFileURL(posix.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help")) console.log(usage);
  else {
    try { await runDrive(parseDriveArguments(args)); } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
