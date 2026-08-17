import type { PluginActivateContext, PluginHandler } from "@dohc/sdk/node";
import { claudeCommandSpec, createClaudeDriver } from "./claudeDriver.ts";

// Thin wiring only. Activation registers the driver and returns: dohc decides
// when to probe Claude Code and when to start it, so nothing here starts a
// process.

const handler: PluginHandler = {
  activate(ctx: PluginActivateContext): void {
    ctx.drivers.register(
      "claude-code",
      createClaudeDriver(
        (input, options) => ctx.childProcesses.spawnCommand(input, options),
        claudeCommandSpec(process.env),
      ),
    );
  },
};

export default handler;
