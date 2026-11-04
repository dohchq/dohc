import { expect, type Page } from "@playwright/test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { AGENT_TOOLS } from "../../src/agents/agentToolCatalog";
import { activityPin } from "../../src/testPins";
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

// Opens the chat with the agent the settings call "default".
export async function openMyAgent(page: Page): Promise<void> {
  // Workspace open starts the UI-independent dispatch scan, which provisions
  // the owner-only agent channel. Wait on that real main-process result before
  // mounting Chats so its one-shot overview load cannot race provisioning.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const api = (window as unknown as {
          dohcDesktop: {
            getWorkspaceRegistry(): Promise<{
              workspaces: Array<{ workspaceId: string }>;
            }>;
            listChatChannels(payload: { workspaceId: string }): Promise<{
              channels: Array<{ kind: string }>;
            }>;
          };
        }).dohcDesktop;
        const registry = await api.getWorkspaceRegistry();
        const workspace = registry.workspaces[0];
        if (!workspace) return false;
        const result = await api.listChatChannels({ workspaceId: workspace.workspaceId });
        return result.channels.some((channel) => channel.kind === "agent");
      }),
    )
    .toBe(true);

  await page.getByTestId(activityPin("chats")).click();
  await expect(page.getByTestId("chats-view")).toBeVisible();
  await page.locator('[data-testid="chats-my-agent"][data-agent-id="default"]').click();
  await expect(page.getByTestId("chats-channel-title")).toHaveText("Nova");
}
