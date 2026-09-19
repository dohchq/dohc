#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { archiveDeployment } from "./archive.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const usage = `node scripts/self-host/recovery.mjs <backup|check-backup|restore|archive> <directory>
  [--env-file PATH] [--compose-file PATH] [--project-name NAME]

The command stops this Compose project. Backup and check restart its previously running services after success.
Restore leaves services stopped for inspection. Replaced relay files remain in the relay volume.
Only relay data is backed up or restored. Auth, service-host data and independent continuity stay untouched.
The snapshot must match current continuity on the original host. Old snapshots and host loss are not supported.
Archive saves all stopped named volumes and configuration, including private credentials. It provides no full-deployment restore.`;

function docker(args) {
  const result = spawnSync("docker", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    // Compose config contains secrets. Never include captured output in exceptions.
    throw new Error(`Docker command failed (${args[0]} ${args[1] ?? ""}). Check Docker and the selected deployment.`);
  }
  return result.stdout;
}

export function parseRecoveryArguments(args) {
  const [action, directory, ...rest] = args;
  if (!["backup", "check-backup", "restore", "archive"].includes(action) || !directory || directory.startsWith("--")) throw new Error(usage);
  const options = { action, directory: resolve(directory), envFile: resolve(root, ".env.self-host"), composeFiles: [], project: undefined };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(usage);
    if (flag === "--env-file") options.envFile = resolve(value);
    else if (flag === "--compose-file") options.composeFiles.push(resolve(value));
    else if (flag === "--project-name" && /^[a-z0-9][a-z0-9_-]*$/.test(value)) options.project = value;
    else throw new Error(usage);
  }
  return options;
}

export async function recoveryComposeArgs(options) {
  const { composeArgs, readSettings } = await import("../../tools/self-host/config.mjs");
  return composeArgs(options.envFile, readSettings(options.envFile),
    ...options.composeFiles.flatMap(path => ["-f", path]), ...(options.project ? ["--project-name", options.project] : []));
}

export async function runRecovery(options, run = docker, log = console.log, composePrefix) {
  const parent = dirname(options.directory), name = basename(options.directory);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || parent.includes(",")) {
    throw new Error("Use a backup directory name containing letters, numbers, dots, underscores or hyphens; its parent must not contain commas.");
  }
  if (options.action === "backup" || options.action === "archive") {
    if (await stat(options.directory).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
      throw new Error("Choose a new backup directory. Existing backups are never overwritten.");
    }
    await mkdir(parent, { recursive: true, mode: 0o700 });
  } else if (!(await stat(options.directory)).isDirectory()) throw new Error("The backup directory does not exist.");
  const compose = composePrefix ?? await recoveryComposeArgs(options);
  const config = JSON.parse(run([...compose, "config", "--format", "json"]));
  const relay = config.services?.["sync-relay"];
  if (relay?.environment?.DOHC_RELAY_DEPLOYMENT_CONFIG !== "/continuity/deployment.json") {
    throw new Error("This command requires the supported self-host deployment layout.");
  }
  const volumeNames = new Set(Object.values(config.volumes ?? {}).map(volume => volume.name));
  const current = run([...compose, "ps", "--services", "--filter", "status=running"]).trim().split(/\r?\n/).filter(Boolean);
  const runningIds = run(["ps", "--quiet"]).trim().split(/\r?\n/).filter(Boolean);
  if (runningIds.length) {
    const containers = JSON.parse(run(["inspect", ...runningIds]));
    for (const container of containers) {
      if ((container.Mounts ?? []).some(mount => mount.Type === "volume" && volumeNames.has(mount.Name)) &&
          container.Config?.Labels?.["com.docker.compose.project"] !== config.name) {
        throw new Error("Another running project uses a deployment volume. Stop it before recovery.");
      }
    }
  }
  log(`Stopping ${config.name} for ${options.action}.`);
  run([...compose, "stop"]);
  const remaining = run(["ps", "--quiet"]).trim().split(/\r?\n/).filter(Boolean);
  if (remaining.length) {
    const containers = JSON.parse(run(["inspect", ...remaining]));
    if (containers.some(container => (container.Mounts ?? []).some(mount => mount.Type === "volume" && volumeNames.has(mount.Name)))) {
      throw new Error("A running container still uses a deployment volume. Services remain stopped; stop that writer before recovery.");
    }
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
