import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function killRecorded(path, group = false) {
  if (!existsSync(path)) return;
  const { pid } = JSON.parse(readFileSync(path, "utf8"));
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(group ? -pid : pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

test("POSIX timeout kills descendants holding pipes after their leader exits", {
  skip: process.platform === "win32" ? "POSIX detached process-group lifecycle" : false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-process-group-"));
  let completed = false;
  try {
    writeFileSync(join(root, "descendant.mjs"), `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      writeFileSync(join(process.argv[2], "descendant.json"), JSON.stringify({ pid: process.pid }));
      process.on("SIGTERM", () => process.stderr.write("descendant ignored SIGTERM\\n"));
      setInterval(() => {}, 1000);
      process.stdout.write("descendant ready\\n");
      process.send("ready");
    `);
    writeFileSync(join(root, "leader.mjs"), `
      import { spawn } from "node:child_process";
      import { join } from "node:path";
      const root = process.argv[2];
      const descendant = spawn(process.execPath, [join(root, "descendant.mjs"), root], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      descendant.once("message", () => { descendant.disconnect(); process.exit(0); });
    `);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { run } from ${JSON.stringify(new URL("./process.mjs", import.meta.url).href)};
      const root = process.argv[1];
      const log = join(root, "group.log");
      let leaderExit;
      let closed = false;
      await assert.rejects(run(process.execPath, [join(root, "leader.mjs"), root], {
        timeoutMs: 2500, log,
        onSpawn: leader => {
          writeFileSync(join(root, "leader.json"), JSON.stringify({ pid: leader.pid }));
          leader.once("exit", (code, signal) => { leaderExit = { code, signal }; });
          leader.once("close", () => { closed = true; });
        },
      }), /timed out after 2500ms/);
      assert.deepEqual(leaderExit, { code: 0, signal: null });
      assert.equal(closed, true);
      const evidence = readFileSync(log, "utf8");
      assert.match(evidence, /descendant ready/);
      assert.match(evidence, /descendant ignored SIGTERM/);
      writeFileSync(join(root, "completed.json"), JSON.stringify({ leaderExit, closed }));
    `, root], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
    completed = existsSync(join(root, "completed.json"));
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(completed, true);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "completed.json"), "utf8")), {
      leaderExit: { code: 0, signal: null }, closed: true,
    });
  } finally {
    if (!completed) {
      killRecorded(join(root, "descendant.json"));
      killRecorded(join(root, "leader.json"), true);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
