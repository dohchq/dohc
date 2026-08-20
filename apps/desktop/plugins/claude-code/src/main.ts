import type { PluginActivateContext, PluginHandler } from "@dohc/sdk/node";
import { join } from "node:path";
import { createChatWebApp, type ChatWebApp } from "./chatWebApp.ts";
import { claudeCommandSpec, createClaudeDriver, readyTimeoutMs } from "./claudeDriver.ts";

let chatWebApp: ChatWebApp | null = null;

function requireChatWebApp(): ChatWebApp {
  if (!chatWebApp) throw new Error("The Claude Code plugin is not active.");
  return chatWebApp;
}

const handler: PluginHandler = {
  activate(ctx: PluginActivateContext): void {
    const driver = createClaudeDriver(
      (input, options) => ctx.childProcesses.spawnCommand(input, options),
      claudeCommandSpec(process.env),
      readyTimeoutMs(process.env),
    );
    ctx.drivers.register(
      "claude-code",
      driver,
    );
    // The built plugin root keeps static source assets in its approved snapshot.
    chatWebApp = createChatWebApp(
      driver,
      ctx.workspaceRoot,
      join(ctx.pluginRoot, "snapshot", "ui"),
    );
  },
  startWebApp(webAppId, instanceKey) {
    return requireChatWebApp().startWebApp(webAppId, instanceKey);
  },
  stopWebApp(webAppId, instanceKey) {
    return requireChatWebApp().stopWebApp(webAppId, instanceKey);
  },
  async deactivate() {
    const app = chatWebApp;
    chatWebApp = null;
    await app?.deactivate();
  },
};

export default handler;
