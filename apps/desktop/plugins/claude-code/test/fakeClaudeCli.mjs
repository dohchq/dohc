#!/usr/bin/env node
// A stand-in for the `claude` CLI, speaking the same stream-json protocol the
// real one does. It answers what Claude answers and, on top of that, echoes
// the exact arguments dohc started it with and the exact permission answer
// dohc gave — so a test can read what crossed the wire instead of trusting
// the driver's own account of it.
//
// Usage: node fakeClaudeCli.mjs <mode> [--version | auth status | -p ...]

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "ok";
const claudeArgs = process.argv.slice(3);

if (claudeArgs.includes("--version")) {
  if (mode === "probe-hangs") {
    // Never answers. The driver's probe timeout is the only thing that ends
    // this process.
    setInterval(() => {}, 1000);
  } else if (mode === "probe-fails") {
    process.stderr.write("fake claude is not installed properly\n");
    process.exit(1);
  } else if (mode === "probe-noisy") {
    process.stdout.write("2.1.233 (Fake Claude Code)\nbuilt from a fake tree\n");
    process.exit(0);
  } else {
    process.stdout.write("2.1.233 (Fake Claude Code)\n");
    process.exit(0);
  }
} else if (claudeArgs[0] === "auth" && claudeArgs[1] === "status") {
  if (mode === "logged-out") {
    process.stdout.write(JSON.stringify({ loggedIn: false }) + "\n");
    process.exit(0);
  }
  if (mode === "auth-unreadable") {
    process.stdout.write("Logged in as somebody\n");
    process.exit(0);
  }
  if (mode === "auth-fails") {
    process.stderr.write("fake claude cannot read its login\n");
    process.exit(1);
  }
  process.stdout.write(
    JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "someone@example.com",
      subscriptionType: "max",
    }) + "\n",
  );
  process.exit(0);
} else {
  runSession();
}

function runSession() {
  if (mode === "resume-missing") {
    const id = claudeArgs[claudeArgs.indexOf("--resume") + 1] ?? "unknown";
    process.stderr.write(`No conversation found with session ID: ${id}\n`);
    process.exit(1);
  }

  const write = (text) => process.stdout.write(text);

  /** Writes one message, in fragments when the test asks for fragments. */
  const send = (message) => {
    const line = `${JSON.stringify(message)}\n`;
    if (mode !== "chunked") {
      write(line);
      return;
    }
    // Whole messages arrive split across writes, and two messages arrive in
    // one write. A reader that treats a chunk as a message loses both.
    for (let at = 0; at < line.length; at += 7) write(line.slice(at, at + 7));
  };

  const assistant = (id, content) =>
    send({ type: "assistant", message: { id, role: "assistant", model: "fake", content } });
  const echo = (id, value) => assistant(id, [{ type: "text", text: JSON.stringify(value) }]);

  const isRecord = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  const pendingPermissions = new Map();

  const askPermission = (request) => {
    const requestId = "fake-permission";
    send({ type: "control_request", request_id: requestId, request });
    return new Promise((resolve) => pendingPermissions.set(requestId, resolve));
  };

  async function writeWorkspaceFile(relativePath, content) {
    const path = join(process.cwd(), relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  const notePath = "notes/claude-output.md";
  const noteBody = "# Claude output\n\nFake Claude wrote this through the agent harness.\n";

  async function runTurn() {
    // What dohc started this process with. A driver that sends the wrong
    // arguments is a driver whose permissions never arrive.
    echo("argv-echo", { args: claudeArgs, cwd: process.cwd() });

    if (mode === "dialog") {
      send({
        type: "control_request",
        request_id: "fake-dialog",
        request: { subtype: "request_user_dialog", dialog_kind: "text" },
      });
    }

    assistant("assistant-1", [
      { type: "thinking", thinking: "Deciding how to write the note." },
      { type: "text", text: "Writing the note now.\n" },
      {
        type: "tool_use",
        id: "tool-1",
        name: "Write",
        input: { file_path: notePath, content: noteBody },
      },
    ]);

    if (mode === "no-turn-end") return;

    const answer = await askPermission({
      subtype: "can_use_tool",
      tool_name: "Write",
      display_name: "Write",
      description: notePath,
      input: { file_path: notePath, content: noteBody },
      tool_use_id: "tool-1",
      permission_suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Write", ruleContent: "notes/**" }],
          behavior: "allow",
          destination: "session",
        },
        {
          type: "addRules",
          rules: [{ toolName: "Write", ruleContent: "**" }],
          behavior: "allow",
          destination: "localSettings",
        },
        { type: "setMode", mode: "acceptEdits" },
      ],
    });

    // Exactly what dohc answered, for the test to read.
    echo("permission-echo", answer ?? null);

    const allowed = answer?.behavior === "allow";
    if (allowed) await writeWorkspaceFile(notePath, noteBody);

    send({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            is_error: !allowed,
            content: allowed ? "File written." : "Denied.",
          },
        ],
      },
    });

    send({
      type: "result",
      subtype: "success",
      is_error: false,
      stop_reason: "end_turn",
      result: "The note is written.",
      session_id: "fake-claude-session",
      usage: { input_tokens: 11, output_tokens: 7 },
    });
  }

  createInterface({ input: process.stdin }).on("line", (line) => {
    void (async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(message)) return;

      if (message.type === "control_response") {
        const response = message.response ?? {};
        const settle = pendingPermissions.get(response.request_id);
        if (!settle) return;
        pendingPermissions.delete(response.request_id);
        settle(response.subtype === "success" ? response.response : null);
        return;
      }

      if (message.type === "control_request") {
        const subtype = message.request?.subtype;
        if (subtype === "initialize") {
          if (mode === "no-handshake") return;
          send({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: { commands: [], models: [], pid: process.pid },
            },
          });
          return;
        }
        if (subtype === "interrupt") {
          send({
            type: "control_response",
            response: { subtype: "success", request_id: message.request_id },
          });
          send({
            type: "result",
            subtype: "success",
            is_error: false,
            stop_reason: "abort",
            result: "Interrupted.",
            session_id: "fake-claude-session",
            usage: { input_tokens: 3, output_tokens: 0 },
          });
        }
        return;
      }

      if (message.type === "user") await runTurn();
    })().catch(() => {});
  });
}
