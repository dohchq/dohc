// This file is the deliberately unmocked sibling of pluginUtilityTransport.test.ts.
// Never merge them: fake timers and real process I/O hang in the same suite.
import type { UtilityProcess } from "electron";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { createPluginUtilityTransport } from "./pluginUtilityTransport";

describe("createPluginUtilityTransport", () => {
  it.skipIf(process.platform === "win32")(
    "stops a detached descendant on POSIX",
    async () => {
      const scratch = await createTestScratch("plugin-utility-tree-");
      const grandchildPidPath = join(scratch, "grandchild.pid");
      const grandchildReadyPath = join(scratch, "grandchild.ready");
      const parentScript = `
        const { spawn } = require("node:child_process");
        const { writeFileSync } = require("node:fs");
        const [grandchildPidPath, grandchildReadyPath] = process.argv.slice(1);
        const grandchildScript = \`
          const { writeFileSync } = require("node:fs");
          const [readyPath] = process.argv.slice(1);
          process.on("SIGTERM", () => {});
          writeFileSync(readyPath, "ready");
          setInterval(() => {}, 1_000);
        \`;
        const grandchild = spawn(
          process.execPath,
          ["-e", grandchildScript, "--", grandchildReadyPath],
          { detached: true, stdio: "ignore" },
        );
        writeFileSync(grandchildPidPath, String(grandchild.pid));
        grandchild.unref();
        setInterval(() => {}, 1_000);
      `;
      const parent = spawn(
        process.execPath,
        ["-e", parentScript, "--", grandchildPidPath, grandchildReadyPath],
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
        await vi.waitFor(async () => {
          expect(await readFile(grandchildPidPath, "utf8")).not.toBe("");
          expect(await readFile(grandchildReadyPath, "utf8")).toBe("ready");
        });
        grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
        expect(() => process.kill(grandchildPid as number, 0)).not.toThrow();

        await transport.dispose();

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
