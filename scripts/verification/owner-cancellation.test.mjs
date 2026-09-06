import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runOwnerCancellationFixture } from "./owner-cancellation-fixture.mjs";

for (const kind of ["prepare", "verify"]) for (const signal of ["SIGINT", "SIGTERM"]) {
  for (const cleanupFails of kind === "verify" ? [false, true] : [false]) {
    test(`${kind} owns ${signal} across synchronous fingerprint work${cleanupFails ? " and retains cleanup failure" : ""} (${process.platform === "win32" ? "synthetic Windows event" : "real POSIX signal"})`, () => {
      const root = mkdtempSync(join(tmpdir(), "dohc-owner-cancel-"));
      try {
        const result = runOwnerCancellationFixture(root, resolve(import.meta.dirname, "../.."), kind, signal, cleanupFails);
        assert.equal(result.error, undefined, result.stderr);
        assert.equal(result.entered, true, result.stderr);
        assert.equal(result.syncReturned, true, "the owner must survive the synchronous signal boundary");
        assert.equal(result.signal, null);
        assert.equal(result.status, cleanupFails ? 1 : signal === "SIGINT" ? 130 : 143);
        assert.match(result.outcome.error, new RegExp(`interrupted by ${signal}`));
        assert.deepEqual(result.outcome.listeners, [0, 0]);
        assert.equal(result.lockExists, false);
        assert.equal(result.containerExists, cleanupFails);
        assert.equal(result.commands.some(({ command }) => command === "cargo"), false);
        if (kind === "prepare") assert.deepEqual(result.commands, [{ command: "pnpm", args: ["install", "--frozen-lockfile"] }]);
        else {
          assert.equal(result.report.verdict, "FAIL");
          assert.match(result.report.error, new RegExp(`interrupted by ${signal}`));
          assert.deepEqual(result.commands.at(-1), { command: "docker", args: ["rm", "--force", "a".repeat(64)] });
          assert.equal(result.commands.some(({ args }) => args.includes("test")), false);
          if (cleanupFails) assert.match(result.report.cleanupError, /fixture cleanup rejected/);
          else assert.equal(result.report.cleanupError, undefined);
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}
