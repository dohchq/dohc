import { isAbsolute, resolve } from "node:path";
import { initializeRelayDeployment } from "./relayDeployment.js";

const usage = `initialize --config PATH --database PATH --continuity-directory NEW_PATH
All paths must be absolute. The config, database, and continuity directory must not exist.
Keep the deployment config and continuity directory outside the relay database directory.
This command creates a fresh deployment. It does not restore or reset an existing deployment.`;

function main(args: string[]): void {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  const [action, ...rest] = args;
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

try {
  main(process.argv.slice(2));
} catch {
  console.error("Relay deployment initialization refused. Use --help for the required paths.");
  process.exitCode = 1;
}
