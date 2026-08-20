import type { PluginActivateContext, PluginHandler } from "@dohc/sdk/node";
import { join } from "node:path";
import { createChatWebApp, type ChatWebApp } from "./chatWebApp.ts";
import { codexCommandSpec, createCodexDriver } from "./codexDriver.ts";

let chatWebApp: ChatWebApp | null = null;

function requireChatWebApp(): ChatWebApp {
  if (!chatWebApp) throw new Error("The Codex plugin is not active.");
  return chatWebApp;
}

const handler: PluginHandler = {
  activate(ctx: PluginActivateContext): void {
    const driver = createCodexDriver(
      (input, options) => ctx.childProcesses.spawnCommand(input, options),
      codexCommandSpec(process.env),
    );
    ctx.drivers.register("codex", driver);
    chatWebApp = createChatWebApp(driver, ctx.workspaceRoot, join(ctx.pluginRoot, "ui"));
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
