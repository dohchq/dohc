import { isAbsolute, join, resolve } from "node:path";
import { parseHostControlIdentifier, parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { openRelayDeployment } from "./relayDeployment.js";
import { DeviceHostCredentialFileUnavailable, prepareDeviceHostCredentialFile, requireDeviceHostCredentialFileSupport } from "./deviceHostCredentialFile.js";

const usage = `Run on the relay host with deployment-operator access to its external deployment config.
provision --deployment-config PATH --host-id ID --output-directory NEW_PRIVATE_DIRECTORY
revoke --deployment-config PATH --host-id ID --instance-id ID --confirm-revoke
Provisioning creates the initial credential at the current host epoch. Retries reuse that credential.
This command does not renew credentials across host epochs or replace a device instance.
Store the credential file on durable storage. The relay does not keep a recoverable copy.
Losing the file prevents recovery at the current host epoch.
Credential-file provisioning is unavailable on macOS until ACL validation is implemented.
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
  const expected = action === "provision" ? ["--deployment-config", "--host-id", "--output-directory"] :
    ["--deployment-config", "--host-id", "--instance-id", "--confirm-revoke"];
  if (fields.size !== expected.length || expected.some(key => !fields.has(key))) throw new Error();
  const configPath = fields.get("--deployment-config")!, hostId = parseHostControlIdentifier(fields.get("--host-id"), "host ID");
  if (!isAbsolute(configPath)) throw new Error();
  const output = fields.get("--output-directory");
  if (output !== undefined && !isAbsolute(output)) throw new Error();
  if (action === "provision") requireDeviceHostCredentialFileSupport();
  const { storage } = openRelayDeployment(configPath);
  try {
    const credential = action === "provision"
      ? await prepareDeviceHostCredentialFile(output!, hostId, storage.getLiveHostControl()?.hostEpoch ?? parseHostEpoch(1))
      : null;
    const result = credential !== null
      ? storage.provisionDeviceHostCredential({ credential, updatedAtMs: Date.now() })
      : storage.revokeDeviceHostCredential({ hostId, instanceId: parseHostControlIdentifier(fields.get("--instance-id"), "instance ID"), updatedAtMs: Date.now() });
    if (!result.ok) throw new Error();
    console.log(action === "provision" ? "Device host credential provisioned." : "Device host credential revoked.");
    console.log(`Deployment config: ${JSON.stringify(resolve(configPath))}`);
    if (credential !== null) {
      console.log(`Instance ID: ${JSON.stringify(credential.instanceId)}`);
      console.log(`Credential file: ${JSON.stringify(join(resolve(output!), "device-host-credential.json"))}`);
    } else console.log(`Host admission: ${result.snapshot.admissionState}`);
  } finally { storage.close(); }
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof DeviceHostCredentialFileUnavailable ? error.message :
    "Device host credential command refused. Use --help for required arguments and revocation consequences.");
  process.exitCode = 1;
});
