#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "acp";
const requireMcpEnv = mode.endsWith("-require-mcp-env");
const protocolMode = requireMcpEnv ? mode.replace("-require-mcp-env", "") : mode;
if (process.argv.includes("--version")) {
  console.log(`fake-${mode} 1.0.0`);
  process.exit(0);
}

let nextId = 1;
const pending = new Map();
const input = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function respondError(id, message) {
  send({ id, error: { code: -32000, message } });
}

function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function notify(method, params) {
  send({ method, params });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMessageId(message) {
  return isRecord(message) && Object.hasOwn(message, "id");
}

async function writeWorkspaceFile(relativePath, content) {
  const path = join(process.cwd(), relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function runAcpPrompt(id, params) {
  notify("session/update", {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: {
        type: "agent_message_chunk",
        itemId: "assistant-1",
        content: "Preparing workspace note.\n",
      },
    },
  });
  notify("session/update", {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: {
        type: "tool_call",
        toolCallId: "tool-1",
        title: "Write notes/agent-output.md",
        kind: "edit",
        status: "in_progress",
        locations: ["notes/agent-output.md"],
      },
    },
  });
  const permission = await request("session/request_permission", {
    requestId: "fake-acp-permission",
    sessionId: params.sessionId,
    toolCall: {
      toolCallId: "tool-1",
      title: "Write notes/agent-output.md",
      kind: "edit",
      locations: ["notes/agent-output.md"],
    },
    options: [
      { optionId: "fake-allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "fake-allow-always", name: "Allow for session", kind: "allow_always" },
      { optionId: "fake-reject-once", name: "Reject", kind: "reject_once" },
      { optionId: "fake-reject-always", name: "Reject for session", kind: "reject_always" },
    ],
  });
  const selectedOptionId =
    permission?.outcome?.outcome === "selected" ? permission.outcome.optionId : null;
  if (selectedOptionId === "fake-allow-once" || selectedOptionId === "fake-allow-always") {
    await writeWorkspaceFile(
      "notes/agent-output.md",
      "# Agent output\n\nFake ACP wrote this through the agent harness.\n",
    );
  }
  notify("session/update", {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: {
        type: "tool_call_update",
        toolCallId: "tool-1",
        title: "Write notes/agent-output.md",
        status: "completed",
      },
    },
  });
  notify("session/update", {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: {
        type: "agent_message_chunk",
        itemId: "assistant-1",
        content: "Done.\n",
      },
    },
  });
  respond(id, { stopReason: "end_turn" });
}

input.on("line", (line) => {
  void (async () => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!isRecord(message)) return;
    if (hasMessageId(message) && !message.method) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(message.error);
      else waiter.resolve(message.result);
      return;
    }
    if (protocolMode === "acp") {
      if (message.method === "initialize") {
        respond(message.id, { protocolVersion: 1 });
      } else if (message.method === "session/new") {
        if (
          requireMcpEnv &&
          message.params?.mcpServers?.[0]?.env?.DOHC_MCP_CLOUD_USER_ID !== "user-1"
        ) {
          respondError(message.id, "missing MCP env");
          return;
        }
        respond(message.id, {
          sessionId: "fake-acp-session",
          models: [{ id: "fake-acp", name: "Fake ACP" }],
        });
      } else if (message.method === "session/prompt") {
        await runAcpPrompt(message.id, message.params);
      } else if (message.method === "session/cancel") {
        notify("session/update", {
          sessionId: message.params?.sessionId,
          update: { sessionUpdate: { type: "agent_message_chunk", content: "Cancelled.\n" } },
        });
      } else if (hasMessageId(message)) {
        respond(message.id, {});
      }
      return;
    }
    if (protocolMode === "acp-fail-init") {
      if (message.method === "initialize") respondError(message.id, "fake ACP init failed");
      else if (hasMessageId(message)) respond(message.id, {});
      return;
    }
    if (hasMessageId(message)) respond(message.id, {});
  })().catch((error) => {
    if (typeof error === "object" && error && "message" in error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
  });
});
