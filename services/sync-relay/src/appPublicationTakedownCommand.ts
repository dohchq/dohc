import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { operatorSecretPath, operatorSocketPath, parseOperatorRequest } from "./appPublicationOperatorProtocol";
import { requestPublicationTakedown } from "./appPublicationOperatorClient";

const usage = `Run inside the running relay container with host operator access:
--publication-id ID --reason TEXT
  Disables one publication and stops its owner from publishing apps on this server.
  The owner sees the reason. Their other publications keep serving.
  The reply lists the owner's other active publications of the same app, so you can disable each one.
  A retry keeps the first takedown record and places the hold again.
--publication-id ID --lift-hold
  Lets that publication's owner publish apps again. The publication stays disabled.
Exit codes: 0 success, 2 bad input, 3 not found, 1 connection or operation failure.`;

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {console.log(usage); return;}
  let request;
  try {
    const {values} = parseArgs({args, options: {"publication-id": {type: "string"}, reason: {type: "string"}, "lift-hold": {type: "boolean"}}});
    const publicationId = values["publication-id"];
    if (values["lift-hold"] && values.reason !== undefined) throw new Error("A hold lift takes no reason.");
    request = parseOperatorRequest(values["lift-hold"] ? {type: "lift-publishing-hold", publicationId} : {type: "disable-publication", publicationId, reason: values.reason});
  } catch {console.error("Invalid takedown arguments. Use --help for the arguments each action needs."); process.exitCode = 2; return;}
  try {
    const result = await requestPublicationTakedown(operatorSocketPath(), request, await readFile(operatorSecretPath(), "utf8"));
    if (result.code === 0) {console.log(result.message); console.log(JSON.stringify(result));}
    else console.error(result.message);
    process.exitCode = result.code;
  } catch (error) {
    console.error(`Could not complete publication takedown. Check that the relay is running. ${error instanceof Error ? error.message : "Connection failed."}`);
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
