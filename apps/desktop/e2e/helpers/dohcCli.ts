import { expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopRoot } from "./desktopApp";
import type { TempWorkspace } from "./workspace";

const repoRoot = resolve(desktopRoot, "../..");
const cliBin = join(repoRoot, "packages/cli/bin/dohc.js");
// Unix serves the CLI over a socket file. Windows serves the same protocol
// over a named pipe whose per-boot name lives in the endpoint descriptor.
const cliEndpointFile = process.platform === "win32"
  ? "dohc-cli-endpoint"
  : "dohc-cli.sock";
const cliTokenFile = "dohc-cli-token";

export function runDohcCli(
  workspace: Pick<TempWorkspace, "homeDir" | "rootPath">,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      process.execPath,
      [cliBin, ...args],
      {
        cwd: workspace.rootPath,
        env: {
          ...process.env,
          // The app's socket and token live directly in the hermetic test
          // state dir. DOHC_STATE_DIR is the explicit CLI override;
          // DOHC_TEST_HOME exercises the normal test discovery fallback too.
          DOHC_STATE_DIR: workspace.homeDir,
          DOHC_TEST_HOME: workspace.homeDir,
          // Playwright forces color while some developer shells export
          // NO_COLOR; Node warns about that inherited combination before the
          // CLI runs. Keep stderr reserved for actual CLI failures.
          NODE_NO_WARNINGS: "1",
        },
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectRun(
            new Error(
              `dohc ${args.join(" ")} failed: ${stderr.trim() || error.message}`,
              { cause: error },
            ),
          );
          return;
        }
        resolveRun({ stdout, stderr });
      },
    );
  });
}

export async function waitForCliEndpoint(homeDir: string): Promise<void> {
  const socketPath = join(homeDir, cliEndpointFile);
  const tokenPath = join(homeDir, cliTokenFile);
  await expect
    .poll(
      async () => {
        try {
          await Promise.all([access(socketPath), access(tokenPath)]);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10_000, intervals: [50, 100, 250] },
    )
    .toBe(true);
}
