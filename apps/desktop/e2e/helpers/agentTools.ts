import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { desktopRoot } from "./desktopApp";
import type { TempWorkspace } from "./workspace";

export async function installFakeAgentTools(
  temp: Pick<TempWorkspace, "baseDir">,
): Promise<NodeJS.ProcessEnv> {
  const fakeRunner = resolve(desktopRoot, "e2e/fixtures/fakeChatRunner.mjs");
  const bin = join(temp.baseDir, "agent tools");
  await mkdir(bin);
  for (const tool of ["claude", "codex"]) {
    const executable = join(bin, `${tool}${process.platform === "win32" ? ".cmd" : ""}`);
    await writeFile(executable, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fakeRunner}" profile-${tool} %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fakeRunner.replaceAll("'", "'\\''")}' profile-${tool} "$@"\n`);
    await chmod(executable, 0o755);
  }
  const path = `${bin}${delimiter}${process.env.Path ?? process.env.PATH ?? ""}`;
  return { PATH: path, Path: path };
}
