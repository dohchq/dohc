import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createSmtpSender, smtpSettingsFromEnv } from "@dohc/workspace-auth/smtp";
import { clearRelaySnapshotStaging, openRelaySnapshot, relayRelease, relaySnapshotKey, saveRelaySnapshot, snapshotStorageFromEnv,
  uploadRelaySnapshot, withRelaySnapshot } from "./relaySnapshot";
import { createSnapshotJob, pingHeartbeat, saveSnapshotJobState } from "./relaySnapshotJob";

const usage = `run --database PATH --state-directory PATH
Take an encrypted relay snapshot every hour and upload it to the configured S3-compatible bucket.
Requires DOHC_SNAPSHOT_KEY, DOHC_SNAPSHOT_S3_*, DOHC_SNAPSHOT_ALERT_EMAIL and the DOHC_SMTP_* settings.
The job never deletes snapshots. Configure retention as a bucket lifecycle rule.

snapshot --database PATH --state-directory PATH --directory PATH
Take one encrypted relay snapshot of the running relay and save it in the directory.

verify --file PATH --output NEW_PATH
Decrypt a snapshot and check its checksum, SQLite integrity and manifest.
The new directory receives relay.sqlite and manifest.json for check-backup, restore or salvage.
It contains unencrypted workspace data. Protect it like the relay volume.

All paths must be absolute. DOHC_SNAPSHOT_KEY must hold the key that sealed the snapshot.`;

const hour = 60 * 60 * 1000;

function fields(rest: string[], expected: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]!, value = rest[index + 1];
    if (!expected.includes(key) || values.has(key) || !value || !isAbsolute(value)) throw new Error();
    values.set(key, value);
  }
  if (values.size !== expected.length) throw new Error();
  return values;
}

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  const [action, ...rest] = args;
  const key = relaySnapshotKey(process.env.DOHC_SNAPSHOT_KEY);
  if (action === "verify") {
    const values = fields(rest, ["--file", "--output"]);
    const manifest = await openRelaySnapshot(values.get("--file")!, key, values.get("--output")!);
    console.log(`Relay snapshot verified: namespace ${manifest.namespace}, generation ${manifest.generation}, stamp ${manifest.stamp}, taken ${manifest.createdAt} by release ${manifest.release}.`);
    console.log("The output contains unencrypted workspace data. Protect it like the relay volume.");
    return;
  }
  if (action === "snapshot") {
    const values = fields(rest, ["--database", "--state-directory", "--directory"]);
    const stagingDirectory = await clearRelaySnapshotStaging(values.get("--state-directory")!, "manual");
    const saved = await withRelaySnapshot({ relayPath: values.get("--database")!, stagingDirectory, key, release: relayRelease() },
      snapshot => saveRelaySnapshot(snapshot, values.get("--directory")!));
    console.log(`Relay snapshot saved: ${saved}`);
    console.log("Keep DOHC_SNAPSHOT_KEY in escrow away from this host. Without it, the snapshot cannot be opened.");
    return;
  }
  if (action !== "run") throw new Error();
  const values = fields(rest, ["--database", "--state-directory"]);
  const storage = snapshotStorageFromEnv(process.env);
  if (!storage) throw new Error("Snapshot storage is not configured. Set DOHC_SNAPSHOT_S3_* to turn on hourly snapshots.");
  const alertEmail = process.env.DOHC_SNAPSHOT_ALERT_EMAIL?.trim();
  if (!alertEmail) throw new Error("Set DOHC_SNAPSHOT_ALERT_EMAIL to the operator address for snapshot failure email.");
  const smtp = smtpSettingsFromEnv(process.env);
  if (!smtp) throw new Error("Configure DOHC_SMTP_* so snapshot failures can reach the operator.");
  const heartbeatUrl = process.env.DOHC_SNAPSHOT_HEARTBEAT_URL?.trim() || undefined;
  if (heartbeatUrl && new URL(heartbeatUrl).protocol !== "https:") throw new Error("Set DOHC_SNAPSHOT_HEARTBEAT_URL to an HTTPS URL.");
  const stateDirectory = values.get("--state-directory")!, stagingDirectory = await clearRelaySnapshotStaging(stateDirectory, "hourly");
  const pass = createSnapshotJob({ statePath: join(stateDirectory, "notifications.json"), alertEmail, heartbeatUrl,
    serverName: process.env.DOHC_SERVER_NAME?.trim() || "your dohc server" }, {
    snapshot: () => withRelaySnapshot({ relayPath: values.get("--database")!, stagingDirectory, key, release: relayRelease() },
      snapshot => uploadRelaySnapshot(snapshot, storage)),
    sendEmail: createSmtpSender(smtp),
    ping: pingHeartbeat,
    saveState: saveSnapshotJobState,
    now: () => new Date(),
    log: (message: string) => console.log(message),
  });
  // A restart takes a snapshot at once and can repeat an email, so a failed pass waits for the next hour instead.
  for (;;) {
    const started = Date.now();
    try { await pass(); }
    catch (error) { console.error(`The snapshot pass failed. The next pass runs in an hour. ${error instanceof Error ? error.message : String(error)}`); }
    await delay(Math.max(0, started + hour - Date.now()));
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error("Relay snapshot command refused. Use --help for the required arguments.");
  if (error instanceof Error && error.message) console.error(error.message);
  process.exitCode = 1;
});
