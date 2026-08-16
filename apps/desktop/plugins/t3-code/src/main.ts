import type {
  PluginActivateContext,
  PluginHandler,
  PluginWebAppStart,
} from "@dohc/sdk/node";
import { createT3Bridge, type T3Bridge } from "./bridge";

// Thin wiring only: everything with behavior lives in the bridge modules,
// where it is tested. Activation must stay fast — the server spawns on
// demand when the host asks for the web app, never here.

let bridge: T3Bridge | null = null;

const handler: PluginHandler = {
  activate(ctx: PluginActivateContext): void {
    bridge = createT3Bridge({
      pluginId: ctx.pluginId,
      pluginRoot: ctx.pluginRoot,
      workspaceRoot: ctx.workspaceRoot,
      stateRoot: ctx.stateRoot,
      childProcesses: ctx.childProcesses,
    });
  },

  startWebApp(webAppId: string): Promise<PluginWebAppStart> {
    if (!bridge) {
      return Promise.reject(new Error("The t3-code plugin is not activated."));
    }
    return bridge.startWebApp(webAppId);
  },

  stopWebApp(webAppId: string): Promise<void> {
    if (!bridge) return Promise.resolve();
    return bridge.stopWebApp(webAppId);
  },

  async deactivate(): Promise<void> {
    const current = bridge;
    bridge = null;
    await current?.dispose();
  },
};

export default handler;
