import { isAbsolute } from "node:path";
import { parseDeviceControlLimits } from "@dohc/live-session-contract/device-control";
import { readDeviceHostCredentialFile } from "./deviceHostCredentialFile.js";
import { connectDeviceHost } from "./deviceHostConnect.js";

const usage = `Connect this device outbound to share-web. No inbound listener or relay database is needed.
--url wss://HOST/api/device-control --credential-directory PRIVATE_DIRECTORY --limits-json JSON
Credential-file reading and this connector are unavailable on macOS until ACL validation is implemented.
Use an existing operator-provisioned credential directory. This command does not provision or renew credentials.
Limits must explicitly set maxConnections, maxHeaderBytes, maxCredentialBytes, maxPayloadBytes, maxPendingBytes,
maxFragments, maxBufferedChunks, handshakeTimeoutMs, heartbeatIntervalMs, heartbeatTimeoutMs, and closeTimeoutMs.
Registration establishes control only. It does not make a document editable.
The command exits when the connection closes. Run it again to reconnect the same credential.`;

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const fields = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1];
    if (fields.has(key) || !value || value.startsWith("--")) throw new Error();
    fields.set(key, value);
  }
  if (fields.size !== 3 || ["--url", "--credential-directory", "--limits-json"].some(key => !fields.has(key))) throw new Error();
  const directory = fields.get("--credential-directory")!;
  if (!isAbsolute(directory)) throw new Error();
  const limits = parseDeviceControlLimits(JSON.parse(fields.get("--limits-json")!));
  const credential = await readDeviceHostCredentialFile(directory);
  let registered = false, requestedStop = false;
  const connection = connectDeviceHost({ url: fields.get("--url")!, credential, limits, onRegistered(notice) {
    registered = true;
    console.log(JSON.stringify(notice));
  } });
  const stop = () => { requestedStop = true; connection.stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { await connection.closed; }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  if (!registered || !requestedStop) throw new Error();
}

main(process.argv.slice(2)).catch(() => {
  console.error("Device host connection closed or refused. Check the service, credential, and limits. Use --help for arguments.");
  process.exitCode = 1;
});
