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
  case "duplicate-command":
    handler = {
      activate(ctx) {
        registerHelloCommand(ctx);
        registerHelloCommand(ctx);
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
  case "web-app":
    handler = {
      activate() {},
      startWebApp(webAppId) {
        return { url: `http://127.0.0.1:43210/pair#token=fixture-${webAppId}` };
      },
    };
    break;
  // A wrapper's pairing model in miniature: the first start hands out a
  // one-time credential, later starts ride the session it paired, and
  // stopWebApp retires that session so the next start pairs again.
  case "web-app-pairing": {
    let paired = false;
    let issued = 0;
    handler = {
      activate() {},
      startWebApp(webAppId) {
        if (paired) return { url: `http://127.0.0.1:43210/?app=${webAppId}` };
        paired = true;
        issued += 1;
        return { url: `http://127.0.0.1:43210/pair#token=fixture-${issued}` };
      },
      stopWebApp() {
        paired = false;
      },
    };
    break;
  }
  case "web-app-hang":
    handler = {
      activate() {},
      startWebApp: () => new Promise(() => {}),
    };
    break;
  case "web-app-bad-result":
    handler = {
      activate() {},
      startWebApp: () => ({ url: "" }),
    };
    break;
  case "report-context":
    handler = {
      activate(ctx) {
        ctx.commands.register("report.context", () => ({
          stateRoot: ctx.stateRoot,
          workspaceRoot: ctx.workspaceRoot,
          pluginRoot: ctx.pluginRoot,
        }));
      },
    };
    break;
  // Proves the settings path end to end: the plugin reads what the host sent
  // with activation, and hears about every change through its own listener —
  // so the command can report both, and a test can tell them apart.
  case "report-settings": {
    let heard = null;
    let changeCount = 0;
    handler = {
      activate(ctx) {
        const atActivation = ctx.settings.get();
        ctx.settings.onChange((values) => {
          heard = values;
          changeCount += 1;
        });
        ctx.commands.register("report.settings", () => ({
          atActivation,
          current: ctx.settings.get(),
          heard,
          changeCount,
        }));
      },
    };
    break;
  }
  // Exercises the workspace capabilities the plugin host routes: a database
  // snapshot, a row edit the host attributes to this plugin, and the ui.open
  // a plugin's own process cannot serve because it has no renderer.
  case "use-workspace":
    handler = {
      activate(ctx) {
        ctx.commands.register("database.roundTrip", async () => {
          const before = await ctx.client.databases.read({
            path: "data/app.sqlite",
          });
          await ctx.client.databases.edit({
            path: "data/app.sqlite",
            operations: [
              {
                table: "sentinel",
                op: "update",
                pkColumn: "id",
                rowId: "1",
                payload: { marker: "edited-by-plugin" },
              },
            ],
          });
          return { tables: before.tables.map((table) => table.name) };
        });
        ctx.commands.register("ui.tryOpen", async () => {
          try {
            await ctx.client.ui.open("notes/today.md");
            return { opened: true, message: null };
          } catch (error) {
            return { opened: false, message: String(error?.message ?? error) };
          }
        });
      },
    };
    break;
  // Subscribes to a prefix of the workspace on activation and reports what
  // arrived, so a test can prove settled changes reach a plugin's own code
  // over the real host protocol.
  case "watch-workspace": {
    const received = [];
    let started = null;
    let unsubscribe = null;
    handler = {
      async activate(ctx) {
        ctx.commands.register("watch.received", () => received);
        ctx.commands.register("watch.started", () => started);
        ctx.commands.register("watch.stop", async () => {
          await unsubscribe?.();
          unsubscribe = null;
          return { stopped: true };
        });
        try {
          unsubscribe = await ctx.client.files.watch(
            process.env.DOHC_PLUGIN_WATCH_PREFIX ?? "notes",
            (event) => {
              received.push({ event: event.event, data: event.data });
            },
          );
          started = { ok: true, message: null };
        } catch (error) {
          started = { ok: false, message: String(error?.message ?? error) };
        }
      },
    };
    break;
  }
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
