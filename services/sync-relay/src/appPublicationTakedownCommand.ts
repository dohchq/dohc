import { isAbsolute } from "node:path";
import { openRelayDeployment } from "./relayDeployment.js";

const usage = `Run on the relay host with operator access to its deployment config.
--deployment-config PATH --publication-id ID --reason TEXT
Stop the relay first. The deployment config path must be absolute.
This permanently disables this publication. The owner cannot reactivate it.
The owner sees the reason. Retries preserve the first takedown record.`;

function main(args: string[]): void {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const expected = ["--deployment-config", "--publication-id", "--reason"];
  const fields = new Map<string, string>();
  if (args.length !== 6) throw new Error();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1]!;
    if (!expected.includes(key) || fields.has(key) || !value || value.startsWith("--")) throw new Error();
    fields.set(key, value);
  }
  const config = fields.get("--deployment-config")!, publicationId = fields.get("--publication-id")!, reason = fields.get("--reason")!;
  if (!isAbsolute(config) || !/^[a-f0-9]{64}$/.test(publicationId) || !reason.trim() || reason.length > 1024 || reason.includes("\0")) throw new Error();
  const { storage } = openRelayDeployment(config);
  try {
    const result = storage.disableAppPublication({publicationId, reason, nowMs: Date.now()});
    console.log(JSON.stringify({publicationId: result.publicationId, authorityRevision: result.authorityRevision, operatorTakedown: result.operatorTakedown}));
  } finally { storage.close(); }
}

try { main(process.argv.slice(2)); }
catch {
  console.error("Publication takedown refused. Stop the relay and use --help for the required arguments.");
  process.exitCode = 1;
}
