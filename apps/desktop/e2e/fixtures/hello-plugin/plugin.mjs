const mode = process.env.DOHC_PLUGIN_FIXTURE_MODE ?? "hello";

if (mode === "crash-immediately") process.exit(1);

function registerHelloCommand(ctx) {
  ctx.commands.register("hello.write", async () => {
    await ctx.client.files.write(
      "hello-plugin-output.txt",
      `Hello from ${ctx.pluginId}\n`,
    );
  });
}

let handler;

switch (mode) {
  case "hello":
    handler = {
      activate(ctx) {
        registerHelloCommand(ctx);
      },
    };
    break;
  case "slow-hello":
    handler = {
      async activate(ctx) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        registerHelloCommand(ctx);
      },
    };
    break;
  case "never-resolves":
    handler = { activate: () => new Promise(() => {}) };
    break;
  case "throws":
    handler = {
      activate() {
        throw new Error("fixture activation failed");
      },
    };
    break;
  case "async-throw-after-activate":
    handler = {
      activate(ctx) {
        ctx.commands.register("noop", () => {});
        setImmediate(() => {
          queueMicrotask(() => {
            throw new Error("fixture: uncaught error after activation");
          });
        });
      },
    };
    break;
  case "crash-after-activate":
    handler = {
      activate(ctx) {
        ctx.commands.register("hello.write", () => {
          void ctx.client.request("noop");
          process.exit(1);
        });
      },
    };
    break;
  case "grandchild-heartbeat":
    handler = {
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
    };
    break;
  default:
    throw new Error(`Unknown hello-plugin fixture mode: ${mode}`);
}

export default handler;
