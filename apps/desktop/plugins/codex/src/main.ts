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
    // ctx.pluginRoot is the built bundle's live root (bundle.mjs, meta.json,
    // dohc-plugin.generated.json). The build never copies static assets next
    // to the bundle -- it only moves the full source copy it already had
    // under a nested "snapshot" directory, so a plugin's own non-bundled
    // files, like this ui/ folder, live at pluginRoot/snapshot/ui.
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
