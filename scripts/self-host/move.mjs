#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { accountsDatabaseError, composeConfig, dataDiskVolumeErrors, readSettings, relayDeploymentError } from "../../tools/self-host/config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const usage = `node scripts/self-host/move.mjs [--env-file PATH]

Starts this deployment on a new host from its attached data disk, then checks it.
Stop the old server first and make sure it cannot start again.
The command refuses to start without the accounts database and the relay deployment on the disk.
See "Move to a new host" in docs/how-to/self-host-recovery.md.`;

function spawn(command, args) {
  // Docker output is read as data, and its errors are copied to the terminal. The final check reports to the terminal.
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    stdio: command === "docker" ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (result.stderr) process.stderr.write(result.stderr);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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
  const docker = args => run("docker", args);
  const config = composeConfig(options.envFile, settings, docker);
  const errors = dataDiskVolumeErrors(config, docker);
  if (errors.length) throw new Error(errors.join("\n"));
  const problem = accountsDatabaseError(config, docker) || relayDeploymentError(options.envFile, settings, docker, false);
  if (problem) throw new Error(problem);
  log("Found the accounts database and the relay deployment. Starting the deployment.");
  if (run(process.execPath, ["scripts/check-self-host.mjs", "--start", "--env-file", options.envFile]).status !== 0) {
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
