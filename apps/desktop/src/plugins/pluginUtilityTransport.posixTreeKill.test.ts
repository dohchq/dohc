import type { UtilityProcess } from "electron";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { createPluginUtilityTransport } from "./pluginUtilityTransport";

async function waitFor(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("createPluginUtilityTransport", () => {
  it.skipIf(process.platform === "win32")(
    "stops a detached heartbeat descendant on POSIX",
    async () => {
      const scratch = await createTestScratch("plugin-utility-tree-");
      const heartbeatPath = join(scratch, "heartbeat.txt");
      const grandchildPidPath = join(scratch, "grandchild.pid");
      const parentScript = `
        const { spawn } = require("node:child_process");
        const { writeFileSync } = require("node:fs");
        const [heartbeatPath, grandchildPidPath] = process.argv.slice(1);
        const heartbeatScript = \`
          const { appendFileSync } = require("node:fs");
          const heartbeatPath = process.argv[1];
          setInterval(() => appendFileSync(heartbeatPath, "x"), 50);
        \`;
        const grandchild = spawn(
          process.execPath,
          ["-e", heartbeatScript, "--", heartbeatPath],
          { detached: true, stdio: "ignore" },
        );
        writeFileSync(grandchildPidPath, String(grandchild.pid));
        grandchild.unref();
        setInterval(() => {}, 1_000);
      `;
      const parent = spawn(
        process.execPath,
        ["-e", parentScript, "--", heartbeatPath, grandchildPidPath],
        { stdio: "ignore" },
      );
      const transport = createPluginUtilityTransport(
        parent as unknown as UtilityProcess,
        {
          onExit: vi.fn(),
          onNotification: vi.fn(),
          onRequest: vi.fn(async () => undefined),
          onStderr: vi.fn(),
        },
      );
      let grandchildPid: number | undefined;

      try {
        await waitFor(
          async () =>
            ((await stat(heartbeatPath).catch(() => null))?.size ?? 0) >= 2,
          "Detached descendant did not write its heartbeat.",
        );
        grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));

        await transport.dispose();

        await delay(400);
        const settledSize = (await stat(heartbeatPath)).size;
        await delay(400);
        expect((await stat(heartbeatPath)).size).toBe(settledSize);
        expect(() => process.kill(grandchildPid as number, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        if (grandchildPid !== undefined) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // The transport already stopped it.
          }
        }
        if (parent.pid !== undefined) {
          try {
            process.kill(parent.pid, "SIGKILL");
          } catch {
            // The transport already stopped it.
          }
        }
      }
    },
    15_000,
  );
});
