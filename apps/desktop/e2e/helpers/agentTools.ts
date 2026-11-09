import { expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { AGENT_TOOLS } from "../../src/agents/agentToolCatalog";
import type { McpConfigResult } from "../../src/ipc/bridgeContract";
import { desktopRoot, testSearchPath } from "./desktopApp";
import { openChatsView, type TempWorkspace } from "./workspace";

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
  await openAgentChat(page, "default", "Nova");
}

// Opens the chat with one agent from Settings, by its id and name.
export async function openAgentChat(page: Page, agentId: string, name: string): Promise<void> {
  // Workspace open starts the UI-independent dispatch scan, which provisions
  // each agent's owner-only channel. Wait on that real main-process result before
  // mounting Chats so its one-shot overview load cannot race provisioning.
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const api = (window as unknown as {
          dohcDesktop: {
            getWorkspaceRegistry(): Promise<{
              workspaces: Array<{ workspaceId: string }>;
            }>;
            listChatChannels(payload: { workspaceId: string }): Promise<{
              channels: Array<{ kind: string; agentId?: string }>;
            }>;
          };
        }).dohcDesktop;
        const registry = await api.getWorkspaceRegistry();
        const workspace = registry.workspaces[0];
        if (!workspace) return false;
        const result = await api.listChatChannels({ workspaceId: workspace.workspaceId });
        return result.channels.some((channel) => channel.kind === "agent" && channel.agentId === id);
      }, agentId),
    )
    .toBe(true);

  // Clicking Chats while it is open would close it.
  await openChatsView(page);
  await page.locator(`[data-testid="chats-my-agent"][data-agent-id="${agentId}"]`).click();
  await expect(page.getByTestId("chats-channel-title")).toHaveText(name);
}

// Starts e2e/fixtures/agentYouRun.mjs as the agent you run with this id. It
// connects with the arguments Copy MCP config gives that agent, and answers
// its first message with `reply`. Stop it with stopAgentYouRun.
export async function startAgentYouRun(page: Page, workspaceId: string, agentId: string, reply: string): Promise<ChildProcess> {
  const config = await page.evaluate((id) => (window as unknown as {
    dohcDesktop: { getMcpConfig(payload: { workspaceId: string }): Promise<McpConfigResult> };
  }).dohcDesktop.getMcpConfig({ workspaceId: id }), workspaceId);
  if ("unavailable" in config) throw new Error(`The MCP config is unavailable: ${config.message}`);
  return spawn(
    process.execPath,
    [resolve(desktopRoot, "e2e/fixtures/agentYouRun.mjs"), reply, ...config.args, "--agent-id", agentId],
    { stdio: ["pipe", "inherit", "inherit"], windowsHide: true },
  );
}

// Closing its stdin stops the agent and its MCP server.
export async function stopAgentYouRun(agent: ChildProcess | null): Promise<void> {
  if (!agent || agent.exitCode !== null || agent.signalCode !== null) return;
  const exited = once(agent, "exit");
  agent.stdin?.end();
  await exited;
}

// The agents you run that wait for messages now, as main reports them.
export async function agentsListening(page: Page): Promise<string[]> {
  const { agentIds } = await page.evaluate(() => (window as unknown as {
    dohcDesktop: { readAgentsListening(payload: Record<string, never>): Promise<{ agentIds: string[] }> };
  }).dohcDesktop.readAgentsListening({}));
  return agentIds;
}
