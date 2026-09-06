import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

if (process.argv[2] === "fixture") {
  const root = process.argv[3];
  const signal = process.argv[4];
  const cleanupFails = process.argv[5] === "true";
  const { postgres } = await import("./verify.mjs");
  const container = join(root, "container");
  const nativeTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = nativeTimeout(callback, delay, ...args);
    if (delay === 1000) process.send({ phase: "between-probes" });
    return timer;
  };
  process.on("message", () => process.emit(signal)); // Windows has no POSIX signal delivery.
  let probes = 0;
  let removals = 0;
  let outcome;
  try {
    await postgres(root, async (command, args) => {
      assert.equal(command, "docker");
      if (args[0] === "run") { writeFileSync(container, "owned fixture"); return { stdout: "a".repeat(64) }; }
      if (args[0] === "inspect") return { stdout: ++probes === 1 ? "starting" : "healthy" };
      if (args[0] === "port") return { stdout: "127.0.0.1:1234" };
      assert.deepEqual(args, ["rm", "--force", "a".repeat(64)]);
      removals++;
      assert.ok(process.listenerCount(signal) > 0, "cleanup retains cancellation protection");
      if (cleanupFails) throw new Error("fixture cleanup rejected");
      rmSync(container);
      return { stdout: "removed" };
    });
    outcome = { resolved: true };
  } catch (error) { outcome = { error: error.message, cleanupError: error.cleanupError }; }
  writeFileSync(join(root, "outcome.json"), JSON.stringify({ ...outcome, probes, removals, containerExists: existsSync(container),
    listeners: [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")] }));
  process.disconnect();
} else {
  for (const signal of ["SIGINT", "SIGTERM"]) for (const cleanupFails of [false, true]) {
    test(`Postgres ${signal} between probes cleans owned startup${cleanupFails ? " and reports cleanup failure" : ""} (${process.platform === "win32" ? "synthetic Windows event" : "real POSIX signal"})`, { timeout: 10_000 }, async () => {
      const root = mkdtempSync(join(tmpdir(), "dohc-postgres-cancel-"));
      const child = spawn(process.execPath, [import.meta.filename, "fixture", root, signal, String(cleanupFails)], {
        windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let stderr = "";
      let signaled = false;
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("message", () => {
        if (signaled) return;
        signaled = true;
        if (process.platform === "win32") child.send("signal");
        else child.kill(signal);
      });
      const deadline = setTimeout(() => child.kill("SIGKILL"), 8000);
      try {
        const result = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, exitSignal) => resolve({ code, exitSignal }));
        });
        assert.equal(signaled, true, stderr);
        assert.equal(result.exitSignal, null, "signal must unwind startup before process exit");
        assert.equal(result.code, signal === "SIGINT" ? 130 : 143, stderr);
        const outcome = JSON.parse(readFileSync(join(root, "outcome.json"), "utf8"));
        assert.match(outcome.error, /Postgres.*interrupted/);
        assert.equal(outcome.probes, 1);
        assert.equal(outcome.removals, 1);
        assert.equal(outcome.containerExists, cleanupFails);
        if (cleanupFails) assert.match(outcome.cleanupError, /Could not remove verification Postgres.*fixture cleanup rejected/);
        else assert.equal(outcome.cleanupError, undefined);
        assert.deepEqual(outcome.listeners, [0, 0]);
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
