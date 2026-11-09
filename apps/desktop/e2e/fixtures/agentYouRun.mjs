#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// An agent you run, as a person's own agent connects: it starts the dohc MCP
// server with the arguments from Copy MCP config, which name it with
// --agent-id, and waits for its messages. It answers the first one with the
// reply it was given, then exits. Closing its stdin stops it and its server
// on every platform.
//
//   node agentYouRun.mjs <reply> <dohc-mcp arguments...>
const [body, ...serverArgs] = process.argv.slice(2);
if (!body || !serverArgs.includes("--agent-id")) {
  console.error("agent you run: expected a reply, then the dohc MCP server's arguments with --agent-id.");
  process.exit(2);
}

const server = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../packages/mcp/bin/dohc-mcp.js");
const child = spawn(process.execPath, [server, ...serverArgs], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
child.on("exit", (code) => {
  console.error(`dohc-mcp exited early: ${code}`);
  process.exit(1);
});
const stop = (code) => {
  child.removeAllListeners("exit");
  child.kill();
  process.exit(code);
};
process.stdin.on("end", () => stop(0)).resume();

const pending = new Map();
let nextId = 1;
let buffer = "";
child.stdout.setEncoding("utf8").on("data", (chunk) => {
  buffer += chunk;
  for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    // A request or notification from the server is not an answer.
    if (message.method !== undefined) continue;
    const call = pending.get(message.id);
    if (!call) continue;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(JSON.stringify(message.error)));
    else call.resolve(message.result);
  }
});
const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const request = (method, params) => new Promise((resolveCall, rejectCall) => {
  const id = nextId++;
  pending.set(id, { resolve: resolveCall, reject: rejectCall });
  send({ id, method, params });
});

// What a dohc tool answered. A refusal ends the agent with its reason.
async function callTool(name, args) {
  const result = await request("tools/call", { name, arguments: args });
  const answer = result.structuredContent;
  if (result.isError || !answer || answer.ok === false) {
    console.error(`${name} failed`, JSON.stringify(result));
    stop(1);
  }
  return answer;
}

await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-you-run", version: "0" } });
send({ method: "notifications/initialized" });

// A wait that times out answers no messages and a cursor, and the agent waits again.
let cursor;
for (;;) {
  const answer = await callTool("dohc_wait_for_messages", cursor ? { cursor } : {});
  cursor = answer.cursor;
  const [message] = answer.messages;
  if (!message) continue;
  await callTool("dohc_reply_to_chat", { threadId: message.threadId, body });
  break;
}
stop(0);
