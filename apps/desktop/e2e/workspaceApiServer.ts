import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function spawnWorkspaceApi(env: Record<string, string>): ChildProcess {
  const builtEntry = join(process.cwd(), "services/workspace-api/dist/main.js");
  if (!existsSync(builtEntry)) {
    execFileSync(process.execPath, [join(process.cwd(), "services/workspace-api/scripts/build.mjs")], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
  }
  return spawn(process.execPath, [builtEntry], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
}
