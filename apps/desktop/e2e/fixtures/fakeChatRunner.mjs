#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Dispatch spawns the runner with the mode on argv and the prompt on stdin,
// never argv (chatRunnerProcess.ts spawnConfiguredRunner). Read stdin the way
// a real harness does, before branching on the mode, so both modes pin the
// delivery.
const mode = process.argv[2];
const profileTool = mode?.startsWith("profile-") ? mode.slice("profile-".length) : null;
// What each fake tool answers to detection's version and sign-in checks.
const PROBE_ANSWERS = {
  claude: { version: "2.1.278 (Claude Code)", auth: '{"loggedIn":true}' },
  codex: { version: "codex-cli 0.155.1", auth: "Logged in using ChatGPT" },
  opencode: { version: "1.18.31", auth: "0 credentials" },
  cursor: { version: "2026.10.01-a1b2c3d", auth: '{"isAuthenticated":false}' },
};
if (profileTool && process.argv[3] === "--version") {
  console.log(PROBE_ANSWERS[profileTool].version);
  process.exit(0);
}
if (profileTool && ["auth", "login", "status"].includes(process.argv[3])) {
  console.log(PROBE_ANSWERS[profileTool].auth);
  process.exit(0);
}
const threadId = process.env.DOHC_CHAT_THREAD;
const runId = process.env.DOHC_RUN_ID;

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
// A runner self-test asks for one reply that carries its marker.
const selfTestMarker = prompt.includes("This is a dohc runner self-test.")
  ? /dohc-runner-self-test:[\w-]+/u.exec(prompt)?.[0] ?? null
  : null;

if (!runId || prompt.trim().length === 0 || !threadId) {
  console.error(
    "fake chat runner: expected a non-empty prompt on stdin, plus " +
      "DOHC_RUN_ID and DOHC_CHAT_THREAD in the environment. Got " +
      `${prompt.length} prompt bytes on stdin, ` +
      `DOHC_CHAT_THREAD=${threadId ?? "unset"}, ` +
      `DOHC_RUN_ID=${runId ?? "unset"}.`,
  );
  process.exit(2);
}

if (mode === "silent-fail") {
  process.exit(3);
}

// Do what the prompt asks, as an installed tool would. The shell resolves dohc
// from the runner's PATH, as installed tools must do.
function runCommand(command) {
  if (!/^dohc chat reply [\w-]+ --as-agent [^\r\n]*$/u.test(command)) {
    console.error("Unexpected runner command", command);
    process.exit(2);
  }
  const child = spawn(command, {
    cwd: process.cwd(), env: process.env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true, shell: true,
  });
  child.on("error", (error) => { console.error(error); process.exit(1); });
  child.on("exit", (code) => process.exit(code ?? 1));
}

// The values of a TOML string or array of strings in a Codex config entry.
function tomlStrings(value) {
  return [...value.matchAll(/'([^']*)'|("(?:[^"\\]|\\.)*")/gu)].map((match) => match[1] ?? JSON.parse(match[2]));
}

// The dohc MCP server a Codex launch names, after checking the launch. The
// run's permissions profile and folder trust follow the server's entries, and
// on Windows so does the unelevated sandbox when no config chose one
// (codexRunConfig.ts). The profile is named for the run and keeps .dohc
// read-only. Every name Codex looks the workspace up by is untrusted.
function codexReplyServer(args) {
  const config = new Map(args.flatMap((arg, index) => args[index - 1] === "--config" ? [arg.split(/=(.*)/su).slice(0, 2)] : []));
  const profile = `dohc_run_${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
  const sandbox = process.platform === "win32" && config.has("windows.sandbox") ? ["windows.sandbox"] : [];
  const keys = ["approval_policy", "mcp_servers.dohc.command", "mcp_servers.dohc.args", "mcp_servers.dohc.cwd", "mcp_servers.dohc.required", "mcp_servers.dohc.enabled_tools", "mcp_servers.dohc.tools.dohc_reply_to_chat.approval_mode", `permissions.${profile}`, "default_permissions", "projects", ...sandbox];
  const [command] = tomlStrings(config.get("mcp_servers.dohc.command") ?? "");
  const [cwd] = tomlStrings(config.get("mcp_servers.dohc.cwd") ?? "");
  const trust = [...(config.get("projects") ?? "").matchAll(/('[^']*'|"(?:[^"\\]|\\.)*")=\{trust_level='untrusted'\}/gu)];
  const root = realpathSync.native(process.cwd());
  const rootKey = process.platform === "win32" ? root.replace(/[A-Z]/gu, (letter) => letter.toLowerCase()) : root;
  if (args.length !== 1 + 2 * keys.length + 3 ||
    !command || cwd !== dirname(command) ||
    !/^\{extends=':workspace',filesystem=\{':workspace_roots'=\{'\.dohc'='read'\}(,':tmpdir'='read')?(,':slash_tmp'='read')?\}(,network=\{enabled=true\})?\}$/u.test(config.get(`permissions.${profile}`) ?? "") ||
    config.get("default_permissions") !== `'${profile}'` ||
    config.get("projects") !== `{${trust.map(([entry]) => entry).join(",")}}` ||
    !tomlStrings(trust.map(([, key]) => key).join(",")).includes(rootKey) ||
    (sandbox.length > 0 && config.get("windows.sandbox") !== "'unelevated'") ||
    config.get("mcp_servers.dohc.required") !== "true" ||
    JSON.stringify(args.slice(0, 3)) !== JSON.stringify(["exec", "--config", "approval_policy=never"]) ||
    JSON.stringify(args.slice(-3)) !== JSON.stringify(["--skip-git-repo-check", "--ephemeral", "-"]) ||
    JSON.stringify([...config.keys()]) !== JSON.stringify(keys) ||
    config.get("mcp_servers.dohc.enabled_tools") !== "['dohc_reply_to_chat']" ||
    config.get("mcp_servers.dohc.tools.dohc_reply_to_chat.approval_mode") !== "'approve'") {
    return null;
  }
  return { command, args: tomlStrings(config.get("mcp_servers.dohc.args") ?? ""), cwd };
}

// The dohc MCP server a Claude Code launch names, after checking the launch.
// Claude Code starts its servers in its own working directory.
function claudeReplyServer(args) {
  const expected = ["-p", "--permission-prompts", "none", "--no-session-persistence", "--setting-sources", "user", "--mcp-config", args[7], "--allowedTools", "Edit(/**)", "mcp__dohc__dohc_reply_to_chat", "--disallowedTools", "Edit(/.dohc/**)", "Edit(/.codex/**)"];
  if (JSON.stringify(args) !== JSON.stringify(expected) || !existsSync(args[7])) return null;
  const servers = JSON.parse(readFileSync(args[7], "utf8")).mcpServers;
  return Object.keys(servers).join() === "dohc" && servers.dohc.type === "stdio"
    ? { command: servers.dohc.command, args: servers.dohc.args, cwd: process.cwd() }
    : null;
}

// Reply as Claude Code and Codex do: start the dohc MCP server the launch
// names, outside the runner's environment, and call the reply tool once.
function replyThroughMcp(args, body) {
  const launch = profileTool === "codex" ? codexReplyServer(args) : claudeReplyServer(args);
  if (!launch || !existsSync(launch.command)) {
    console.error("Unexpected profile arguments", args);
    process.exit(2);
  }
  const server = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../packages/mcp/bin/dohc-mcp.js");
  const { DOHC_RUN_ID: _runId, DOHC_CHAT_THREAD: _thread, ...env } = process.env;
  const child = spawn(process.execPath, [server, ...launch.args], { cwd: launch.cwd, env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  let buffer = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (message.id === 1) {
        send({ method: "notifications/initialized" });
        send({ id: 2, method: "tools/list" });
      } else if (message.id === 2) {
        // The run's server offers the reply tool and nothing else.
        const names = message.result?.tools?.map((tool) => tool.name);
        if (JSON.stringify(names) !== JSON.stringify(["dohc_reply_to_chat"])) {
          console.error("Unexpected dohc tools", JSON.stringify(message));
          child.kill();
          process.exit(2);
        }
        send({ id: 3, method: "tools/call", params: { name: "dohc_reply_to_chat", arguments: { threadId, runId, body } } });
      } else if (message.id === 3) {
        if (message.error || message.result?.isError) console.error("dohc_reply_to_chat failed", JSON.stringify(message));
        child.kill();
        process.exit(message.error || message.result?.isError ? 1 : 0);
      }
    }
  });
  child.on("exit", (code) => { console.error(`dohc-mcp exited early: ${code}`); process.exit(1); });
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-codex", version: "0" } } });
}

if (profileTool) {
  const args = process.argv.slice(3);
  const body = selfTestMarker ?? "# Done\n\ndone: checked the exports";
  // A profile's self-test asks for the same reply form as its runs.
  if (!prompt.includes(`the \`dohc_reply_to_chat\` tool of the \`dohc\` MCP server with \`threadId\` \`${threadId}\` and \`runId\` \`${runId}\``)) {
    console.error("Unexpected reply form in the prompt");
    process.exit(2);
  }
  replyThroughMcp(args, body);
} else if (selfTestMarker) {
  runCommand(`dohc chat reply ${threadId} --as-agent "${selfTestMarker}"`);
} else {

if (mode !== "report" && mode !== "ask") {
  console.error(`unknown fake chat runner mode: ${mode ?? "missing"}`);
  process.exit(2);
}

// In ask mode the prompt decides: a taken choice renders as "- [x] <choice>"
// in the thread markdown, so the second run reports it; the first run asks.
const taken = mode === "ask" ? /^- \[x\] (.+)$/mu.exec(prompt)?.[1] : undefined;
const replyArgs =
  mode === "report"
    ? ["done: checked the exports"]
    : taken
      ? [`going with ${taken}`]
      : ["--needs-decision", "--option", "Friday", "--option", "Monday", "Which day do we ship?"];

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(fixtureDir, "../../../..");
const cliBin = resolve(repoRoot, "packages/cli/bin/dohc.js");
const child = spawn(
  process.execPath,
  [
    cliBin,
    "chat",
    "reply",
    threadId,
    "--as-agent",
    ...replyArgs.slice(0, -1),
    "-",
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "inherit", "inherit"],
  },
);
child.stdin.end(replyArgs.at(-1));

child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
}
