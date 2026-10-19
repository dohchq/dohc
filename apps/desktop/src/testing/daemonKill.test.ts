import { spawn } from "node:child_process";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { engineDaemonPids } from "../../e2e/helpers/daemonKill";
import { createTestScratch } from "../workspaces/testTemp";

// The crash and outage e2e specs find the engine by name in the OS process
// table. Node, linked under the engine's name, stands in for it.
it.skipIf(process.platform === "win32")("finds an engine child by its executable name", async () => {
  const executable = join(await createTestScratch("daemon-kill-"), "dohc-workspace-engine");
  await symlink(process.execPath, executable);
  const child = spawn(executable, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await expect.poll(() => engineDaemonPids(process.pid)).toContain(child.pid);
  } finally {
    child.kill("SIGKILL");
  }
});
