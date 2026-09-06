import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeElectronApplication } from "./close-electron.mjs";

async function bounded(promise, message, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

for (const close of ["rejected", "hung"]) {
  test(`POSIX ${close} Electron close stops a TERM-ignoring descendant`, {
    skip: process.platform === "win32" ? "Native POSIX process-group signals" : false,
    timeout: 8000,
  }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "dohc-electron-group-"));
    let descendantSocket;
    let descendantClosed;
    let descendantPid;
    let leader;
    let leaderClosed;
    let ready;
    const connected = new Promise((resolve) => { ready = resolve; });
    const server = createServer((socket) => {
      descendantSocket = socket;
      descendantClosed = new Promise((resolve) => socket.once("close", resolve));
      socket.on("error", () => {});
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk;
        if (!received.includes("\n")) return;
        descendantPid = Number(received.trim());
        ready();
      });
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(join(root, "cleanup.sock"), resolve);
      });
      writeFileSync(join(root, "descendant.mjs"), `
        import { connect } from 'node:net';
        import { join } from 'node:path';
        const owner = connect(join(import.meta.dirname, 'cleanup.sock'));
        owner.on('end', () => process.exit(0));
        owner.on('error', () => process.exit(1));
        owner.resume();
        process.on('SIGTERM', () => {});
        owner.once('connect', () => owner.write(String(process.pid) + '\\n'));
        setTimeout(() => process.exit(72), 5000);
      `);
      leader = spawn(process.execPath, ["--input-type=module", "-e", `
        import { spawn } from 'node:child_process';
        spawn(process.execPath, [process.argv[1]], { stdio: ['ignore', 'inherit', 'inherit'] });
        setInterval(() => {}, 1000);
      `, join(root, "descendant.mjs")], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      leader.stdout.resume();
      leader.stderr.resume();
      leaderClosed = new Promise((resolve) => leader.once("close", resolve));
      await bounded(connected, "Descendant did not establish its cleanup connection.");
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
      const app = { close: close === "rejected"
        ? async () => { throw new Error("fixture close rejected"); }
        : () => new Promise(() => {}) };
      await assert.rejects(closeElectronApplication(app, leader, 25),
        close === "rejected" ? /fixture close rejected/ : /Electron close timed out/);
      t.diagnostic(JSON.stringify({ phase: "helper-returned", leaderPid: leader.pid, descendantPid,
        leaderSignal: leader.signalCode, descendantConnectionClosed: descendantSocket.destroyed }));
      // Inherited pipes and the retained connection must close without fixture cleanup.
      await bounded(Promise.all([leaderClosed, descendantClosed]), "Descendant survived forced Electron cleanup.", 500);
      assert.equal(descendantSocket.destroyed, true);
    } finally {
      // The connection owns descendant cleanup even after the group leader exits.
      descendantSocket?.end();
      if (leader?.pid && leader.exitCode === null && leader.signalCode === null) {
        try { process.kill(-leader.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      await bounded(Promise.all([leaderClosed, descendantClosed]), "Fixture cleanup did not finish.", 6000);
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
      t.diagnostic(JSON.stringify({ phase: "fixture-cleaned", leaderPid: leader?.pid, descendantPid,
        leaderExited: !leader || leader.exitCode !== null || leader.signalCode !== null,
        descendantConnectionClosed: descendantSocket?.destroyed ?? true, serverClosed: !server.listening }));
    }
  });
}
