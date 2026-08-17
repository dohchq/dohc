import type { PluginActivateContext, PluginHandler } from "@dohc/sdk/node";
import { codexCommandSpec, createCodexDriver } from "./codexDriver.ts";

// Thin wiring only. Activation registers the driver and returns: dohc decides
// when to probe Codex and when to start it, so nothing here starts a process.

const handler: PluginHandler = {
  activate(ctx: PluginActivateContext): void {
    ctx.drivers.register(
      "codex",
      createCodexDriver(
        (input, options) => ctx.childProcesses.spawnCommand(input, options),
        codexCommandSpec(process.env),
      ),
    );
  },
};

export default handler;
