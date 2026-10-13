import { parseArgs } from "node:util";
import { operatorSocketPath, parseDisableRequest } from "./appPublicationOperatorProtocol";
import { requestPublicationTakedown } from "./appPublicationOperatorClient";

const usage = `Run inside the running relay container with host operator access:
--publication-id ID --reason TEXT
This disables one publication. The owner sees the reason and cannot reactivate this publication.
Retries preserve the first takedown record. Other publications keep serving.
Exit codes: 0 success, 2 bad input, 3 not found, 1 connection or operation failure.`;

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {console.log(usage); return;}
  let request;
  try {
    const {values} = parseArgs({args, options: {"publication-id": {type: "string"}, reason: {type: "string"}}});
    request = parseDisableRequest({type: "disable-publication", publicationId: values["publication-id"], reason: values.reason});
  } catch {console.error("Invalid takedown arguments. Use --help for the required publication ID and reason."); process.exitCode = 2; return;}
  try {
    const result = await requestPublicationTakedown(operatorSocketPath(), request);
    if (result.code === 0) {console.log(result.message); console.log(JSON.stringify(result));}
    else console.error(result.message);
    process.exitCode = result.code;
  } catch (error) {
    console.error(`Could not complete publication takedown. Check that the relay is running. ${error instanceof Error ? error.message : "Connection failed."}`);
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
