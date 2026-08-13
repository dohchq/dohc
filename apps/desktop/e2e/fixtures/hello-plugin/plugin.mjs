import { activatePlugin } from "@dohc/sdk/node";

const mode = process.env.DOHC_PLUGIN_FIXTURE_MODE ?? "hello";

if (mode === "crash-immediately") process.exit(1);

function registerHelloCommand(ctx) {
  ctx.commands.register("hello.write", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(
      join(ctx.workspaceRoot, "hello-plugin-output.txt"),
      `Hello from ${ctx.pluginId}\n`,
    );
  });
}

switch (mode) {
  case "hello":
    activatePlugin({
      activate(ctx) {
        registerHelloCommand(ctx);
      },
    });
    break;
  case "slow-hello":
    activatePlugin({
      async activate(ctx) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        registerHelloCommand(ctx);
      },
    });
    break;
  case "never-resolves":
    activatePlugin({ activate: () => new Promise(() => {}) });
    break;
  case "throws":
    activatePlugin({
      activate() {
        throw new Error("fixture activation failed");
      },
    });
    break;
  case "crash-after-activate":
    activatePlugin({
      activate(ctx) {
        ctx.commands.register("hello.write", () => {
          void ctx.client.request("noop");
          process.exit(1);
        });
      },
    });
    break;
  case "grandchild-heartbeat":
    activatePlugin({
      async activate(ctx) {
        const { spawn } = await import("node:child_process");
        const { join } = await import("node:path");
        const heartbeat = join(ctx.workspaceRoot, "grandchild-heartbeat.txt");
        const script = `
          const { appendFile } = require("node:fs");
          const heartbeat = process.argv[1];
          setInterval(() => appendFile(heartbeat, Date.now() + "\\n", () => {}), 200);
        `;
        const child = spawn(process.execPath, ["-e", script, heartbeat], {
          cwd: ctx.workspaceRoot,
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      },
    });
    break;
  default:
    throw new Error(`Unknown hello-plugin fixture mode: ${mode}`);
}
