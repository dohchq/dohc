// A harness stand-in: a real executable that speaks a line protocol on
// standard input and output, the way the CLIs a driver plugin drives do.
// Started by the plugin through dohc's child-process broker, so dohc owns its
// process tree.
import { spawn } from "node:child_process";

const heartbeatPath = process.argv[2];

// One grandchild, so the process this driver started is a tree and a test can
// prove dohc takes the whole tree down.
if (heartbeatPath) {
  const grandchild = spawn(
    process.execPath,
    [
      "-e",
      'const { appendFileSync } = require("node:fs");' +
        "setInterval(() => appendFileSync(process.argv[1], String(Date.now()) + String.fromCharCode(10)), 100);",
      heartbeatPath,
    ],
    { detached: true, stdio: "ignore" },
  );
  grandchild.unref();
  send({ type: "grandchild", pid: grandchild.pid });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

send({ type: "ready", pid: process.pid });

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let breakAt = buffered.indexOf("\n");
  while (breakAt >= 0) {
    const line = buffered.slice(0, breakAt);
    buffered = buffered.slice(breakAt + 1);
    if (line.trim().length > 0) handle(JSON.parse(line));
    breakAt = buffered.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(message) {
  if (message.type === "prompt") {
    send({ type: "delta", text: `working on ${message.text}` });
    send({ type: "tool", title: "read notes.md", secret: "provider payload" });
    if (message.text.includes("ask")) {
      send({ type: "permission", requestId: "permission-1" });
      return;
    }
    send({ type: "done", turnId: message.turnId });
    return;
  }
  if (message.type === "permission-answer") {
    send({ type: "permission-resolved", requestId: message.requestId, decision: message.decision });
    send({ type: "done", turnId: "turn-after-permission" });
    return;
  }
  if (message.type === "expire-login") {
    send({ type: "login-required" });
  }
}
