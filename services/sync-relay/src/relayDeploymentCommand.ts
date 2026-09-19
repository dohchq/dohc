import { isAbsolute, resolve } from "node:path";
import { initializeRelayDeployment, openRelayDeployment } from "./relayDeployment.js";
import { parseHostControlIdentifier } from "@dohc/live-session-contract/host-control";
import { backupRelayDeployment, checkRelayBackup, restoreRelayDeployment } from "./relayDeploymentRecovery";
import { salvageRelayContent } from "./relayContentSalvage";

const usage = `initialize --config PATH --database PATH --continuity-directory NEW_PATH
All paths must be absolute. The config, database, and continuity directory must not exist.
Keep the deployment config and continuity directory outside the relay database directory.
This command creates a fresh deployment. It does not restore or reset an existing deployment.

provision-service --config PATH --host-id ID
Run while the relay is stopped. This provisions the initial service host and keeps admission closed.
Repeating the same provision preserves its identity. A different host or existing device mode is refused.

backup --config PATH --directory NEW_PATH
check-backup --config PATH --directory PATH
restore --config PATH --directory PATH
Stop the application services first. Paths must be absolute and have no symbolic links.
Backups contain relay data only. Protect the directory as private workspace data.
Restore requires unchanged independent continuity on the original host.
Restore preserves replaced files and never changes auth, service-host data or continuity.
Old snapshots and lost continuity require a separate recovery procedure; no reset is provided.

salvage --directory PATH --output NEW_PATH
Export settled tracked files from a completed snapshot into a new private directory.
No deployment config, credentials or current continuity are required.
Retain the original database as offline evidence. Do not serve or attach that database.
Protected files, unsettled live edits, chat and history are not imported into the new workspace.`;

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  const [action, ...rest] = args;
  if (action === "salvage") {
    if (rest.length !== 4) throw new Error();
    const fields = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index]!, value = rest[index + 1]!;
      if (!["--directory", "--output"].includes(key) || fields.has(key) || !isAbsolute(value)) throw new Error();
      fields.set(key, value);
    }
    const result = await salvageRelayContent(fields.get("--directory")!, fields.get("--output")!);
    console.log(`Exported ${result.exported} files; skipped ${result.skipped}. Read recovery.json before using the output.`);
    return;
  }
  if (["backup", "check-backup", "restore"].includes(action ?? "")) {
    if (rest.length !== 4) throw new Error();
    const fields = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index]!, value = rest[index + 1]!;
      if (!["--config", "--directory"].includes(key) || fields.has(key) || !isAbsolute(value)) throw new Error();
      fields.set(key, value);
    }
    const config = fields.get("--config")!, directory = fields.get("--directory")!;
    if (action === "backup") {
      await backupRelayDeployment(config, directory);
      console.log("Relay snapshot saved. Auth, service-host data and independent continuity are not included.");
    } else if (action === "check-backup") {
      await checkRelayBackup(config, directory);
      console.log("Relay snapshot matches current independent continuity.");
    } else {
      const result = await restoreRelayDeployment(config, directory);
      console.log(`Relay snapshot restored. Previous files: ${JSON.stringify(result.preservedDirectory)}`);
    }
    return;
  }
  if (action === "provision-service") {
    if (rest.length !== 4) throw new Error();
    const fields = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index]!, value = rest[index + 1]!;
      if (!["--config", "--host-id"].includes(key) || fields.has(key)) throw new Error();
      fields.set(key, value);
    }
    const config = fields.get("--config");
    if (!config || !isAbsolute(config)) throw new Error();
    const hostId = parseHostControlIdentifier(fields.get("--host-id"), "host ID");
    const { storage } = openRelayDeployment(config);
    try {
      const result = storage.provisionLiveHostControl({ mode: "service", hostId, updatedAtMs: Date.now(), guard: storage.captureStanding() });
      if (!result.ok) throw new Error();
      console.log("Service host provisioned.");
    } finally { storage.close(); }
    return;
  }
  if (action !== "initialize" || rest.length !== 6) throw new Error();
  const fields = new Map<string, string>();
  const expected = ["--config", "--database", "--continuity-directory"];
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]!, value = rest[index + 1]!;
    if (!expected.includes(key) || fields.has(key) || !isAbsolute(value)) throw new Error();
    fields.set(key, value);
  }
  if (fields.size !== expected.length) throw new Error();
  const configPath = resolve(fields.get("--config")!);
  initializeRelayDeployment({
    configPath,
    relayPath: resolve(fields.get("--database")!),
    continuityDirectory: resolve(fields.get("--continuity-directory")!),
  });
  console.log("Relay deployment initialized.");
  console.log(`Deployment config: ${JSON.stringify(configPath)}`);
}

main(process.argv.slice(2)).catch(error => {
  console.error("Relay deployment command refused. Use --help for the required arguments.");
  if (error instanceof Error && error.message) console.error(error.message);
  process.exitCode = 1;
});
