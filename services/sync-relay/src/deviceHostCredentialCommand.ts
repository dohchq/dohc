import { isAbsolute, resolve } from "node:path";
import { parseHostControlIdentifier, parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { openSyncRelayStorage } from "./storage.js";
import { prepareDeviceHostCredentialFile } from "./deviceHostCredentialFile.js";

const usage = `Run on the relay host with deployment-operator access to its database.
provision --database PATH --host-id ID --output-directory NEW_PRIVATE_DIRECTORY
revoke --database PATH --host-id ID --instance-id ID --confirm-revoke
Provisioning creates the initial credential at the current host epoch. Retries reuse that credential.
This command does not renew credentials across host epochs or replace a device instance.
Revocation permanently disables this credential. It preserves any maintenance transition.`;

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const [action, ...rest] = args;
  if (action !== "provision" && action !== "revoke") throw new Error();
  const fields = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index]!;
    if (fields.has(key)) throw new Error();
    if (key === "--confirm-revoke") fields.set(key, "yes");
    else {
      const value = rest[++index];
      if (!value || value.startsWith("--")) throw new Error();
      fields.set(key, value);
    }
  }
  const expected = action === "provision" ? ["--database", "--host-id", "--output-directory"] :
    ["--database", "--host-id", "--instance-id", "--confirm-revoke"];
  if (fields.size !== expected.length || expected.some(key => !fields.has(key))) throw new Error();
  const database = fields.get("--database")!, hostId = parseHostControlIdentifier(fields.get("--host-id"), "host ID");
  if (!isAbsolute(database)) throw new Error();
  const output = fields.get("--output-directory");
  if (output !== undefined && !isAbsolute(output)) throw new Error();
  const storage = openSyncRelayStorage(database);
  try {
    const result = action === "provision"
      ? storage.provisionDeviceHostCredential({ credential: await prepareDeviceHostCredentialFile(output!, hostId,
          storage.getLiveHostControl()?.hostEpoch ?? parseHostEpoch(1)), updatedAtMs: Date.now() })
      : storage.revokeDeviceHostCredential({ hostId, instanceId: parseHostControlIdentifier(fields.get("--instance-id"), "instance ID"), updatedAtMs: Date.now() });
    if (!result.ok) throw new Error();
    console.log(action === "provision" ? "Device host credential provisioned." : "Device host credential revoked.");
    console.log(`Database: ${JSON.stringify(resolve(database))}`);
    if (action === "revoke") console.log(`Host admission: ${result.snapshot.admissionState}`);
  } finally { storage.close(); }
}

main(process.argv.slice(2)).catch(() => {
  console.error("Device host credential command refused. Use --help for required arguments and revocation consequences.");
  process.exitCode = 1;
});
