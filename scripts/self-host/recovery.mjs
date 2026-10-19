#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { composeArgs, describeWriters, readSettings, readValidSettings, storageWriters } from "../../tools/self-host/config.mjs";
import { archiveDeployment } from "./archive.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const usage = `node scripts/self-host/recovery.mjs <backup|check-backup|restore|archive|snapshot> <directory>
node scripts/self-host/recovery.mjs verify <new-directory> --snapshot FILE
  [--env-file PATH] [--compose-file PATH] [--project-name NAME]

Snapshot saves an encrypted relay snapshot of the running deployment in the directory without stopping it.
Verify decrypts a snapshot with DOHC_SNAPSHOT_KEY and checks it. The new directory receives unencrypted relay data.
The other commands stop this Compose project. Backup, check-backup, and archive restart its previously running services after success.
Restore leaves services stopped for inspection. Replaced relay files remain in the relay volume.
Backup, check-backup, and restore affect only relay data. Archive preserves deployment data and configuration, excluding disposable replicas.
The snapshot must match current continuity on the original host. Old snapshots and host loss are not supported.
Archive saves stopped deployment volumes and configuration, including private credentials. It skips replicas and provides no full-deployment restore.`;

const snapshotCommand = "/app/services/sync-relay/dist/relay-snapshot.js";

function docker(args, env = {}) {
  const result = spawnSync("docker", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } });
  if (result.error || result.status !== 0) {
    // Compose config contains secrets. Never include captured output in exceptions.
    const maintenance = args.includes("/app/services/sync-relay/dist/relay-deployment.js") || args.includes(snapshotCommand) || args.includes("relay-snapshot");
    const detail = maintenance ? ` ${result.stderr?.trim() ?? ""}` : "";
    throw new Error(`Docker command failed (${args[0]} ${args[1] ?? ""}). Check Docker and the selected deployment.${detail}`);
  }
  return result.stdout;
}

export function parseRecoveryArguments(args) {
  const [action, directory, ...rest] = args;
  if (!["backup", "check-backup", "restore", "archive", "snapshot", "verify"].includes(action) || !directory || directory.startsWith("--")) throw new Error(usage);
  const options = { action, directory: resolve(directory), envFile: resolve(root, ".env.self-host"), composeFiles: [], project: undefined, snapshot: undefined };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(usage);
    if (flag === "--env-file") options.envFile = resolve(value);
    else if (flag === "--compose-file") options.composeFiles.push(resolve(value));
    else if (flag === "--project-name" && /^[a-z0-9][a-z0-9_-]*$/.test(value)) options.project = value;
    else if (flag === "--snapshot" && action === "verify" && !options.snapshot) options.snapshot = resolve(value);
    else throw new Error(usage);
  }
  if ((action === "verify") !== Boolean(options.snapshot)) throw new Error(usage);
  return options;
}

export function recoveryComposeArgs(options) {
  return composeArgs(options.envFile, readValidSettings(options.envFile),
    ...options.composeFiles.flatMap(path => ["-f", path]), ...(options.project ? ["--project-name", options.project] : []));
}

function mountable(path) {
  const parent = dirname(path), name = basename(path);
  const mountParent = process.platform === "win32" ? parent.replace(/^[a-zA-Z]:/, "") : parent;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || parent.includes(",") || mountParent.includes(":")) {
    throw new Error("Use a backup directory name containing letters, numbers, dots, underscores or hyphens; its parent must not contain commas or colons except a Windows drive prefix.");
  }
  return { parent, name };
}
const exists = path => stat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });

export async function runRecovery(options, run = docker, log = console.log, composePrefix) {
  const { parent, name } = mountable(options.directory);
  const source = options.snapshot && mountable(options.snapshot);
  const sealed = options.action === "snapshot" || options.action === "verify";
  const key = sealed ? readSettings(options.envFile).DOHC_SNAPSHOT_KEY : undefined;
  if (sealed && !key) {
    throw new Error(`Set DOHC_SNAPSHOT_KEY in ${options.envFile} to the snapshot key. On a replacement host, use the copy you kept away from the old host.`);
  }
  if (options.action === "snapshot") await mkdir(parent, { recursive: true, mode: 0o700 });
  else if (options.action === "verify") {
    if (!(await stat(options.snapshot)).isFile()) throw new Error("The snapshot must be a file.");
    if (await exists(options.directory)) throw new Error("Choose a new directory for the verified snapshot.");
  } else if (options.action === "backup" || options.action === "archive") {
    if (await exists(options.directory)) throw new Error("Choose a new backup directory. Existing backups are never overwritten.");
    await mkdir(parent, { recursive: true, mode: 0o700 });
  } else if (!(await stat(options.directory)).isDirectory()) throw new Error("The backup directory does not exist.");
  const compose = composePrefix ?? recoveryComposeArgs(options);
  const config = JSON.parse(run([...compose, "config", "--format", "json"]));
  const relay = config.services?.["sync-relay"];
  if (relay?.environment?.DOHC_RELAY_DEPLOYMENT_CONFIG !== "/continuity/deployment.json") {
    throw new Error("This command requires the supported self-host deployment layout.");
  }
  if (source) {
    // Verification mounts no deployment volume, so it also works on a replacement host before setup.
    log(run(["run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", "--env", "DOHC_SNAPSHOT_KEY",
      "--mount", `type=bind,source=${source.parent},target=/source,readonly`, "--mount", `type=bind,source=${parent},target=/backup`,
      "--entrypoint", "node", relay.image, snapshotCommand, "verify", "--file", `/source/${source.name}`, "--output", `/backup/${name}`],
    { DOHC_SNAPSHOT_KEY: key }).trim());
    return;
  }
  // Every deployment volume must exist; a missing one fails here before anything stops.
  const volumeNames = Object.values(config.volumes ?? {}).map(volume => volume.name);
  const volumes = volumeNames.length ? JSON.parse(run(["volume", "inspect", ...volumeNames])) : [];
  if (options.action === "snapshot") {
    // Online: the snapshot container reads the relay database read-only while services keep running.
    log(run([...compose, "run", "--rm", "-T", "--no-deps", "--volume", `${parent}:/backup`, "relay-snapshot",
      "snapshot", "--database", "/data/sync-relay.sqlite", "--state-directory", "/snapshots", "--directory", `/backup/${name}`]).trim());
    return;
  }
  const writers = storageWriters(config, volumes, run);
  const current = run([...compose, "ps", "--services", "--filter", "status=running"]).trim().split(/\r?\n/).filter(Boolean);
  const foreign = writers().filter(({ container }) => container.Config?.Labels?.["com.docker.compose.project"] !== config.name);
  if (foreign.length) {
    throw new Error(`Running containers outside ${config.name} can write its storage. Stop them before recovery: ${describeWriters(foreign)}.`);
  }
  log(`Stopping ${config.name} for ${options.action}.`);
  run([...compose, "stop"]);
  const remaining = writers();
  if (remaining.length) {
    throw new Error(`Running containers can still write this deployment's storage. Services remain stopped; stop them before recovery: ${describeWriters(remaining)}.`);
  }
  const entrypoint = "/app/services/sync-relay/dist/relay-deployment.js";
  try {
    if (options.action === "archive") {
      await archiveDeployment(options, config, run);
      log("Private deployment archive saved. No full-deployment restore is supported.");
    } else {
      const output = run([...compose, "run", "--rm", "-T", "--no-deps",
        "--volume", `${parent}:/backup`, "--entrypoint", "node", "sync-relay", entrypoint,
        options.action, "--config", "/continuity/deployment.json", "--directory", `/backup/${name}`]);
      log(output.trim());
    }
  } catch (error) {
    log("Maintenance failed. Services remain stopped; preserve the snapshot and deployment volumes.");
    throw error;
  }
  if (options.action !== "restore" && current.length) {
    run([...compose, "start", ...current]);
    log("Previously running services restarted.");
  } else log("Services remain stopped. Start the deployment after checking the result.");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.slice(2).join() === "--help") console.log(usage);
  else Promise.resolve().then(() => runRecovery(parseRecoveryArguments(process.argv.slice(2)))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
