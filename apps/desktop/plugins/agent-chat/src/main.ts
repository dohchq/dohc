import type { PluginActivateContext, PluginHandler } from "@dohc/sdk/node";
import { join } from "node:path";
import { createChatWebApp, type ChatWebApp } from "./chatWebApp.ts";
import { claudeCommandSpec, createClaudeDriver, readyTimeoutMs } from "./claudeDriver.ts";
import { codexCommandSpec, createCodexDriver } from "./codexDriver.ts";

/** One chat per driver, keyed by the web app id the manifest declares. */
const chats = new Map<string, ChatWebApp>();

function requireChat(webAppId: string): ChatWebApp {
  if (chats.size === 0) throw new Error("The agent-chat plugin is not active.");
  const chat = chats.get(webAppId);
  if (!chat) throw new Error('The agent-chat plugin serves no "' + webAppId + '" web app.');
  return chat;
}

const handler: PluginHandler = {
  activate(ctx: PluginActivateContext): void {
    const spawn: Parameters<typeof createClaudeDriver>[0] = (input, options) =>
      ctx.childProcesses.spawnCommand(input, options);
    // Static plugin assets live in the built root's snapshot subdirectory, not beside the bundle.
    const uiRoot = join(ctx.pluginRoot, "snapshot", "ui");
    const claude = createClaudeDriver(
      spawn,
      claudeCommandSpec(process.env),
      readyTimeoutMs(process.env),
    );
    const codex = createCodexDriver(spawn, codexCommandSpec(process.env));
    ctx.drivers.register("claude-code", claude);
    ctx.drivers.register("codex", codex);
    const workspaceRoot = ctx.workspaceRoot;
    chats.set(
      "claude-code-chat",
      createChatWebApp({
        agent: "Claude Code",
        webAppId: "claude-code-chat",
        driver: claude,
        workspaceRoot,
        uiRoot,
      }),
    );
    chats.set(
      "codex-chat",
      createChatWebApp({ agent: "Codex", webAppId: "codex-chat", driver: codex, workspaceRoot, uiRoot }),
    );
  },
  startWebApp(webAppId, instanceKey) {
    return requireChat(webAppId).startWebApp(webAppId, instanceKey);
  },
  stopWebApp(webAppId, instanceKey) {
    return requireChat(webAppId).stopWebApp(webAppId, instanceKey);
  },
  async deactivate() {
    const open = [...chats.values()];
    chats.clear();
    await Promise.all(open.map((chat) => chat.deactivate()));
  },
};

export default handler;
