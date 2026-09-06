#!/usr/bin/env node
// A JSON-RPC child that answers `initialize` and exits on stdin close, for
// JsonRpcTransport's disposal tests.
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  console.log("fake-agent 1.0.0");
  process.exit(0);
}

const input = createInterface({ input: process.stdin });

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return;
  }
  if (typeof message !== "object" || message === null || !Object.hasOwn(message, "id")) return;
  respond(message.id, message.method === "initialize" ? { protocolVersion: 1 } : {});
});
