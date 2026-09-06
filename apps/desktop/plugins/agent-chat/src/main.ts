import type { PluginActivateContext, PluginHandler } from "@dohc/sdk/node";
import { join } from "node:path";
import { createChatWebApp, type ChatWebApp } from "./chatWebApp.ts";
import { claudeCommandSpec, createClaudeDriver, readyTimeoutMs } from "./claudeDriver.ts";
import { codexCommandSpec, createCodexDriver } from "./codexDriver.ts";
import type { SpawnCommand } from "./shared.ts";

/** One chat per driver, keyed by the web app id the manifest declares. */
const chats = new Map<string, ChatWebApp>();

/** The singleton chat for one manifest web app id; any other id or an
 * instance key is refused, since every chat here is a singleton. */
function requireChat(webAppId: string, instanceKey: string | null): ChatWebApp {
  if (chats.size === 0) throw new Error("The agent-chat plugin is not active.");
  const chat = chats.get(webAppId);
  if (!chat || instanceKey !== null) {
    throw new Error(
      'The agent-chat plugin serves only the singleton web apps ' +
        [...chats.keys()].map((id) => '"' + id + '"').join(" and ") +
        ".",
    );
  }
  return chat;
}

const handler: PluginHandler = {
  activate(ctx: PluginActivateContext): void {
    const spawn: SpawnCommand = (input, options) => ctx.childProcesses.spawnCommand(input, options);
    // Static plugin assets live in the built root's snapshot subdirectory, not beside the bundle.
    const uiRoot = join(ctx.pluginRoot, "snapshot", "ui");
    const agents = [
      {
        driverId: "claude-code",
        webAppId: "claude-code-chat",
        agent: "Claude Code",
        driver: createClaudeDriver(spawn, claudeCommandSpec(process.env), readyTimeoutMs(process.env)),
      },
      {
        driverId: "codex",
        webAppId: "codex-chat",
        agent: "Codex",
        driver: createCodexDriver(spawn, codexCommandSpec(process.env)),
      },
    ];
    for (const { driverId, webAppId, agent, driver } of agents) {
      ctx.drivers.register(driverId, driver);
      chats.set(
        webAppId,
        createChatWebApp({ agent, driver, workspaceRoot: ctx.workspaceRoot, uiRoot }),
      );
    }
  },
  startWebApp(webAppId, instanceKey) {
    return requireChat(webAppId, instanceKey).startWebApp();
  },
  stopWebApp(webAppId, instanceKey) {
    return requireChat(webAppId, instanceKey).stopWebApp();
  },
  async deactivate() {
    const open = [...chats.values()];
    chats.clear();
    await Promise.all(open.map((chat) => chat.deactivate()));
  },
};

export default handler;
