#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { composeArgs, readSettings } from "../../tools/self-host/config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const usage = `node scripts/self-host/move.mjs [--env-file PATH]

Starts this deployment on a new host from its attached data disk, then checks it.
Stop the old server first and make sure it cannot start again.
The command refuses to start when the disk holds no relay deployment.
See "Move to a new host" in docs/how-to/self-host-recovery.md.`;

// Reads through the relay's own volumes, so it checks the folders Docker mounts.
const deploymentCheck = "for (const path of ['/continuity/deployment.json', '/data/sync-relay.sqlite']) require('node:fs').accessSync(path);";

function spawn(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
  return result.error ? 1 : result.status;
}

export function parseMoveArguments(args) {
  const options = { envFile: resolve(root, ".env.self-host") };
  if (args.length === 2 && args[0] === "--env-file" && args[1] && !args[1].startsWith("--")) options.envFile = resolve(args[1]);
  else if (args.length) throw new Error(usage);
  return options;
}

export function runMove(options, run = spawn, log = console.log) {
  const settings = readSettings(options.envFile);
  if (!settings.DOHC_DATA_DIRECTORY) throw new Error("Set DOHC_DATA_DIRECTORY to the deployment folder on the attached disk.");
  const check = run("docker", composeArgs(options.envFile, settings, "run", "--rm", "--no-deps", "-T",
    "--entrypoint", "node", "relay-initialize", "-e", deploymentCheck));
  if (check !== 0) {
    throw new Error(`No relay deployment found in ${settings.DOHC_DATA_DIRECTORY}. Mount the data disk there and try again. Never start an empty folder: setup would create a new deployment.`);
  }
  log("Found the relay deployment on the data disk. Starting the deployment.");
  if (run(process.execPath, ["scripts/check-self-host.mjs", "--start", "--env-file", options.envFile]) !== 0) {
    throw new Error("The deployment did not pass its checks. Keep the old server stopped and inspect the reported service error.");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.slice(2).join() === "--help") console.log(usage);
  else {
    try { runMove(parseMoveArguments(process.argv.slice(2))); } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
