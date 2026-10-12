#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { recoveryComposeArgs } from "./recovery.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const entrypoint = "/app/services/sync-relay/dist/app-publication-takedown.js";
const usage = `node scripts/self-host/app-takedown.mjs --publication-id ID --reason TEXT
  [--env-file PATH] [--compose-file PATH] [--project-name NAME]
This permanently disables one publication. Its owner sees the reason and cannot reactivate it.
The command stops this Compose project and restarts previously running services after success.
On failure, services remain stopped. Retries preserve the first takedown record.`;

export function parseTakedownArguments(args) {
  const { values } = parseArgs({ args, options: { "publication-id": { type: "string" }, reason: { type: "string" },
    "env-file": { type: "string" }, "compose-file": { type: "string", multiple: true }, "project-name": { type: "string" } } });
  const publicationId = values["publication-id"], reason = values.reason, project = values["project-name"];
  if (!publicationId || !/^[a-f0-9]{64}$/.test(publicationId) || !reason?.trim() || reason.length > 1024 || reason.includes("\0") ||
      (project !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(project))) throw new Error(usage);
  return { publicationId, reason, envFile: resolve(values["env-file"] ?? resolve(root, ".env.self-host")),
    composeFiles: (values["compose-file"] ?? []).map(path => resolve(path)), project };
}

function docker(args) {
  const result = spawnSync("docker", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("Docker command failed. Check Docker and the selected deployment.");
  return result.stdout;
}

export async function runTakedown(options, run = docker, log = console.log, composePrefix) {
  const compose = composePrefix ?? await recoveryComposeArgs(options);
  const config = JSON.parse(run([...compose, "config", "--format", "json"]));
  if (config.services?.["sync-relay"]?.environment?.DOHC_RELAY_DEPLOYMENT_CONFIG !== "/continuity/deployment.json") {
    throw new Error("This command requires the supported self-host deployment layout.");
  }
  const volumes = new Set(Object.values(config.volumes ?? {}).map(volume => volume.name));
  if (volumes.size) run(["volume", "inspect", ...volumes]);
  const current = run([...compose, "ps", "--services", "--filter", "status=running"]).trim().split(/\r?\n/).filter(Boolean);
  const inspectWriters = () => {
    const ids = run(["ps", "--quiet"]).trim().split(/\r?\n/).filter(Boolean);
    return ids.length ? JSON.parse(run(["inspect", ...ids])).filter(container =>
      (container.Mounts ?? []).some(mount => mount.Type === "volume" && volumes.has(mount.Name))) : [];
  };
  if (inspectWriters().some(container => container.Config?.Labels?.["com.docker.compose.project"] !== config.name)) {
    throw new Error("Another running project uses a deployment volume. Stop it before takedown.");
  }
  log(`Stopping ${config.name} to disable the publication.`);
  run([...compose, "stop"]);
  try {
    if (inspectWriters().length) throw new Error("A running container still uses a deployment volume.");
    const output = run([...compose, "run", "--rm", "-T", "--no-deps", "--entrypoint", "node", "sync-relay", entrypoint,
      "--deployment-config", "/continuity/deployment.json", "--publication-id", options.publicationId, "--reason", options.reason]);
    log(output.trim());
  } catch (error) {
    log("Takedown failed. Services remain stopped; inspect the deployment before restarting.");
    throw error;
  }
  if (current.length) run([...compose, "start", ...current]);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.slice(2).join() === "--help") console.log(usage);
  else Promise.resolve().then(() => runTakedown(parseTakedownArguments(process.argv.slice(2)))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
