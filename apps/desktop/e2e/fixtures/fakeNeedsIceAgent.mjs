#!/usr/bin/env node
// An agent dohc starts that works a card on the board and asks Ice in
// #needs-ice when it is blocked. It works through dohc's MCP server or its
// CLI, as the first argument says, the way an installed agent would.
//
// The first run blocks the card, makes #needs-ice, and posts the question
// with the card attached. With "mid-run" it then waits for Ice's reply in
// the same run; with "after-run" it ends, and dohc starts a run for the
// reply. Either way, the run that has the reply reads the thread, sets the
// card, and resolves the decision with its answer.
//
// Each run appends one JSON line to NEEDS_ICE_RUNS, so the test can count
// runs and check what the woken run's prompt carried.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [door, when] = process.argv.slice(2);
if (!["mcp", "cli"].includes(door) || !["mid-run", "after-run"].includes(when)) {
  console.error(`fake needs-ice agent: unknown mode ${door} ${when}`);
  process.exit(2);
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const { DOHC_CHAT_THREAD: runThread, DOHC_RUN_ID: runId, DOHC_STATE_DIR: home, NEEDS_ICE_RUNS: runsFile } = process.env;
const CARD = "board/launch.md";
const QUESTION = "Which day do we ship the launch?";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function fail(message) {
  console.error(`fake needs-ice agent: ${message}`);
  process.exit(1);
}

// dohc's MCP server, started by the agent with the run's environment, so it
// carries the run's secret and offers the tools of a run dohc started.
async function mcpDoor() {
  const server = resolve(repoRoot, "packages/mcp/bin/dohc-mcp.js");
  const { DOHC_RUN_ID: _id, DOHC_CHAT_THREAD: _thread, ...env } = process.env;
  const child = spawn(process.execPath, [server, "--workspace", process.cwd(), "--home", home], {
    cwd: process.cwd(), env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
  });
  child.on("exit", (code) => fail(`dohc-mcp exited early: ${code}`));
  const waiting = new Map();
  let nextId = 1;
  let buffer = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const send = (method, params) => new Promise((settle) => {
    const id = nextId++;
    waiting.set(id, settle);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-needs-ice", version: "0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await send("tools/list", {});
  const names = new Set(listed.result?.tools?.map((tool) => tool.name) ?? []);
  for (const name of ["dohc_create_group", "dohc_start_group_chat", "dohc_read_chat", "dohc_wait_for_messages", "dohc_reply_to_chat", "dohc_set_record_fields"]) {
    if (!names.has(name)) fail(`the run's MCP server does not offer ${name}`);
  }
  const call = async (name, args) => {
    const message = await send("tools/call", { name, arguments: args });
    const text = message.result?.content?.[0]?.text;
    const result = text === undefined ? undefined : JSON.parse(text);
    if (message.error || message.result?.isError || result?.ok === false) fail(`${name} failed: ${JSON.stringify(message)}`);
    return result;
  };
  return {
    close: () => { child.removeAllListeners("exit"); child.kill(); },
    createGroup: () => call("dohc_create_group", { name: "needs-ice", purpose: "Decisions waiting for Ice", type: "posts" }),
    post: (input) => call("dohc_start_group_chat", { ...input, runId }),
    setCard: (fields) => call("dohc_set_record_fields", { recordPath: CARD, fields }),
    readThread: async (threadId) => (await call("dohc_read_chat", { threadId })).messages.map((message) => ({
      id: message.id, human: message.authorKind === "human", body: message.body,
      open: message.decisionState === "open", paths: message.attachments.map((attachment) => attachment.pathHint),
    })),
    waitInThread: async (threadId, cursor) => await call("dohc_wait_for_messages", { thread: threadId, ...(cursor ? { cursor } : {}) }),
    reply: (input) => call("dohc_reply_to_chat", { ...input, runId }),
  };
}

// --json goes before a -- that ends the options.
function withJson(args) {
  const end = args.indexOf("--");
  return end < 0 ? [...args, "--json"] : [...args.slice(0, end), "--json", ...args.slice(end)];
}

// dohc's CLI, found the way an agent's shell finds it.
function cliDoor() {
  const cli = resolve(repoRoot, "packages/cli/bin/dohc.js");
  const run = (args) => new Promise((settle) => {
    const child = spawn(process.execPath, [cli, ...withJson(args)], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; });
    child.on("exit", (code) => {
      if (code !== 0) fail(`dohc ${args.join(" ")} exited ${code}`);
      settle(JSON.parse(out));
    });
  });
  return {
    close: () => {},
    createGroup: () => run(["chat", "create-group", "needs-ice", "--purpose", "Decisions waiting for Ice", "--type", "posts"]),
    post: (input) => run(["chat", "post", input.group, "--title", input.title, ...input.attachments.flatMap((path) => ["--attach", path]), "--needs-decision", "--", input.body]),
    setCard: (fields) => run(["document", "set-fields", CARD, ...Object.entries(fields).flatMap(([name, value]) => ["--field", `${name}=${value}`])]),
    readThread: async (threadId) => (await run(["chat", "show", threadId, "--peek"])).messages.map((message) => ({
      id: message.id, human: message.author.kind === "human", body: message.body,
      open: message.decisionState === "open", paths: message.attachments.map((attachment) => attachment.pathHint),
    })),
    waitInThread: (threadId, cursor) => run(["chat", "watch", "--thread", threadId, "--once", ...(cursor ? ["--cursor", cursor] : [])]),
    reply: (input) => run(["chat", "reply", input.threadId, "--resolve", input.resolve, "--", input.body]),
  };
}

// The question, Ice's answer, and the card it is about, read from the thread.
async function answerIn(tools, threadId) {
  const messages = await tools.readThread(threadId);
  const question = messages.find((message) => message.open);
  const answer = messages.findLast((message) => message.human);
  const card = question?.paths.find((path) => path?.endsWith(".md"));
  return question && answer && card ? { question, answer: answer.body.trim(), card } : null;
}

async function finish(tools, threadId, found) {
  if (found.card !== CARD) fail(`the question is about ${found.card}, not ${CARD}`);
  await tools.setCard({ Status: "In progress", Decision: found.answer });
  await tools.reply({ threadId, resolve: found.question.id, body: `Going with ${found.answer}. The card is back In progress.` });
}

const tools = door === "mcp" ? await mcpDoor() : cliDoor();
const record = (entry) => appendFileSync(runsFile, `${JSON.stringify({ runId, door, ...entry })}\n`);
try {
  const woken = await answerIn(tools, runThread);
  if (woken) {
    // dohc started this run for Ice's reply. Its prompt is the thread.
    record({ phase: "answer", threadId: runThread, promptHasAnswer: prompt.includes(woken.answer), promptHasCard: prompt.includes(CARD), promptHasQuestion: prompt.includes(QUESTION) });
    await finish(tools, runThread, woken);
  } else {
    record({ phase: "ask", threadId: runThread });
    await tools.setCard({ Status: "Blocked" });
    await tools.createGroup();
    const posted = await tools.post({ group: "needs-ice", title: "Launch: pick a ship date", body: QUESTION, attachments: [CARD], needsDecision: true });
    if (when === "mid-run") {
      let cursor;
      for (;;) {
        const batch = await tools.waitInThread(posted.threadId, cursor);
        cursor = batch.cursor;
        const found = batch.messages.length > 0 ? await answerIn(tools, posted.threadId) : null;
        if (found) {
          record({ phase: "answer", threadId: posted.threadId, sameRun: true });
          await finish(tools, posted.threadId, found);
          break;
        }
      }
    }
  }
} finally {
  tools.close();
}
