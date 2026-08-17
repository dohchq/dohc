#!/usr/bin/env node
// A stand-in for `codex app-server`, speaking the same JSON-RPC the real one
// does. It answers what Codex answers and, on top of that, echoes the exact
// policy dohc asked for back as assistant text — so a test can read what
// crossed the wire instead of trusting the driver's own account of it.
//
// Usage: node fakeCodexAppServer.mjs <mode> [app-server | --version]

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "ok";

if (process.argv.includes("--version")) {
  if (mode === "probe-hangs") {
    // Never answers. The driver's probe timeout is the only thing that ends
    // this process.
    setInterval(() => {}, 1000);
  } else if (mode === "probe-fails") {
    process.stderr.write("fake codex is not installed properly\n");
    process.exit(1);
  } else if (mode === "probe-noisy") {
    process.stdout.write("fake-codex 1.0.0\nbuilt from a fake tree\n");
    process.exit(0);
  } else {
    process.stdout.write("fake-codex 1.0.0\n");
    process.exit(0);
  }
} else {
  runAppServer();
}

function runAppServer() {
  let nextId = 1;
  const pending = new Map();

  const send = (message) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const respond = (id, result) => send({ id, result });
  const respondError = (id, message) => send({ id, error: { code: -32000, message } });
  const notify = (method, params) => send({ method, params });
  const request = (method, params) => {
    const id = nextId++;
    send({ id, method, params });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  /** Reports what dohc actually sent, for the test to read. */
  const echo = (itemId, value) => {
    notify("item/agentMessage/delta", { itemId, delta: JSON.stringify(value) });
  };

  const isRecord = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  async function writeWorkspaceFile(relativePath, content) {
    const path = join(process.cwd(), relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  async function runTurn(params) {
    // Refused by dohc, which has no surface to ask a person: the driver must
    // report it and reject rather than answer on the person's behalf.
    try {
      await request("item/tool/requestUserInput", {
        threadId: params.threadId,
        itemId: "input-1",
        questions: [{ id: "next-step", header: "Question", question: "Next?" }],
      });
    } catch {
      // Expected.
    }
    // Also refused: Codex's own login owns its tokens.
    try {
      await request("account/chatgptAuthTokens/refresh", { threadId: params.threadId });
    } catch {
      // Expected.
    }
    notify("item/agentMessage/delta", {
      threadId: params.threadId,
      itemId: "assistant-1",
      delta: "Codex fake is preparing a file.\n",
    });
    notify("item/started", {
      threadId: params.threadId,
      item: { id: "cmd-1", type: "command", title: "Write notes/codex-output.md", status: "in_progress" },
    });
    const approval = await request("item/commandExecution/requestApproval", {
      threadId: params.threadId,
      turnId: "fake-turn",
      itemId: "cmd-1",
      approvalId: "fake-codex-approval",
      command: "write notes/codex-output.md",
      reason: "The fake Codex harness needs to create the requested note.",
    });
    if (approval?.decision === "accept" || approval?.decision === "acceptForSession") {
      await writeWorkspaceFile(
        "notes/codex-output.md",
        "# Codex output\n\nFake Codex wrote this through the agent harness.\n",
      );
    }
    notify("item/completed", {
      threadId: params.threadId,
      item: { id: "cmd-1", type: "command", title: "Write notes/codex-output.md", status: "completed" },
    });
    notify("thread/tokenUsage/updated", {
      threadId: params.threadId,
      usage: { total: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } },
    });
    notify("turn/completed", {
      threadId: params.threadId,
      turn: { id: "fake-turn", status: "completed" },
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

      if (message.id !== undefined && !message.method) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(message.error);
        else waiter.resolve(message.result);
        return;
      }

      if (message.method === "initialize") {
        respond(message.id, { userAgent: "fake-codex/1.0.0" });
        return;
      }
      if (message.method === "thread/start") {
        if (mode === "fail-thread") {
          respondError(message.id, "fake Codex thread failed");
          return;
        }
        echo("thread-start", {
          cwd: message.params?.cwd ?? null,
          approvalPolicy: message.params?.approvalPolicy ?? null,
          sandbox: message.params?.sandbox ?? null,
          mcp: message.params?.config?.mcp_servers?.dohc ?? null,
        });
        notify("thread/started", { thread: { id: "fake-codex-thread" } });
        respond(message.id, { thread: { id: "fake-codex-thread" } });
        return;
      }
      if (message.method === "turn/start") {
        if (message.params?.threadId !== "fake-codex-thread") {
          respondError(message.id, "invalid fake Codex thread id");
          return;
        }
        echo("turn-start", {
          approvalPolicy: message.params?.approvalPolicy ?? null,
          sandboxPolicy: message.params?.sandboxPolicy ?? null,
          input: message.params?.input ?? null,
        });
        respond(message.id, { turn: { id: "fake-turn" } });
        if (mode !== "no-turn") await runTurn(message.params);
        return;
      }
      if (message.method === "turn/interrupt") {
        echo("turn-interrupt", {
          threadId: message.params?.threadId ?? null,
          turnId: message.params?.turnId ?? null,
        });
        respond(message.id, {});
        return;
      }
      if (message.id !== undefined) respond(message.id, {});
    })().catch(() => {});
  });
}
