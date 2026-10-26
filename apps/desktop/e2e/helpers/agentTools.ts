import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { AGENT_TOOLS } from "../../src/agents/agentToolCatalog";
import { desktopRoot, testSearchPath } from "./desktopApp";
import type { TempWorkspace } from "./workspace";

export async function installFakeAgentTools(
  temp: Pick<TempWorkspace, "baseDir">,
): Promise<NodeJS.ProcessEnv> {
  const fakeRunner = resolve(desktopRoot, "e2e/fixtures/fakeChatRunner.mjs");
  const bin = join(temp.baseDir, "agent tools");
  await mkdir(bin);
  // A fake for every tool, so detection never reaches one installed in a
  // folder it always searches, such as /opt/homebrew/bin.
  for (const { id, command } of AGENT_TOOLS) {
    const executable = join(bin, `${command}${process.platform === "win32" ? ".cmd" : ""}`);
    await writeFile(executable, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fakeRunner}" profile-${id} %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fakeRunner.replaceAll("'", "'\\''")}' profile-${id} "$@"\n`);
    await chmod(executable, 0o755);
  }
  const path = `${bin}${delimiter}${testSearchPath}`;
  return { PATH: path, Path: path };
}
