import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startSiteDevServer } from "./siteRunner";
import { createTestScratch } from "./testTemp";

const started: ChildProcess[] = [];
afterEach(() => {
  for (const each of started.splice(0)) {
    try { each.kill("SIGKILL"); } catch { /* gone */ }
  }
});

const SERVER = "require('node:http').createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', function () { console.log('http://127.0.0.1:' + this.address().port + '/'); });";

describe.runIf(process.platform === "win32")("a Windows stop with the real tree kill", () => {
  it("ends a captured helper outside the wrapper's tree in the first stop", async () => {
    // Started outside the dev server's tree, as a helper whose own parent
    // died would be.
    const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    started.push(helper);
    const workspaceRoot = await realpath(await createTestScratch("site-runner-windows-helpers-"));
    await mkdir(join(workspaceRoot, "portal"));
    await writeFile(join(workspaceRoot, "portal", "server.js"), SERVER);
    const handle = await startSiteDevServer({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["server.js"],
      descendantsReader: async () => [helper.pid!],
    });
    const helperExit = new Promise((resolve) => helper.once("exit", resolve));
    await handle.stop();
    await helperExit;
    expect(await handle.stillRunning!()).toEqual([]);
  });
});
