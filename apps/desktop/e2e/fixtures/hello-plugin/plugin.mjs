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
  case "non-json-command-result":
    handler = {
      activate(ctx) {
        ctx.commands.register("transport.sideEffect", async () => {
          await ctx.client.files.write(
            "transport-command-output.txt",
            "command ran\n",
          );
          // This fixture runs over the test harness's stdio JSON transport,
          // where BigInt cannot be encoded. Electron's production utility
          // process uses structured clone and does support BigInt. Command
          // return values should cross neither transport.
          return 1n;
        });
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
  // A per-instance web app that behaves like the real thing: one HTTP server
  // per instance, on its own ephemeral port, so two instances of one web app
  // really are two origins. Each page says which instance it is, so a guest
  // locked to one origin can be shown to have reached that instance and no
  // other. stopWebApp closes only the instance it names.
  case "instanced-web-app": {
    const servers = new Map();
    handler = {
      activate() {},
      async startWebApp(webAppId, instanceKey) {
        const existing = servers.get(instanceKey);
        if (existing) return { url: existing.url, title: `Preview ${instanceKey}` };
        const { createServer } = await import("node:http");
        const server = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(`<!doctype html><title>${instanceKey}</title>`);
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address();
        const url = `http://127.0.0.1:${port}/?app=${encodeURIComponent(webAppId)}`;
        servers.set(instanceKey, { server, url });
        return { url, title: `Preview ${instanceKey}` };
      },
      async stopWebApp(_webAppId, instanceKey) {
        const running = servers.get(instanceKey);
        if (!running) return;
        servers.delete(instanceKey);
        await new Promise((resolve) => running.server.close(resolve));
      },
    };
    break;
  }
  case "instanced-static-web-app": {
    const servers = new Map();
    let pluginRoot = null;
    handler = {
      activate(ctx) {
        pluginRoot = ctx.pluginRoot;
      },
      async startWebApp(_webAppId, instanceKey) {
        const existing = servers.get(instanceKey);
        if (existing) return { url: existing.url, title: `Preview ${instanceKey}` };

        const { readFile } = await import("node:fs/promises");
        const { createServer } = await import("node:http");
        const { join } = await import("node:path");
        const server = createServer(async (request, response) => {
          const decodedPath = decodeURIComponent(
            new URL(request.url ?? "/", "http://x").pathname,
          );
          const relativePath =
            decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
          try {
            response.end(
              await readFile(join(pluginRoot, "snapshot", "preview", relativePath)),
            );
          } catch {
            response.statusCode = 404;
            response.end("Not found");
          }
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address();
        const url = `http://127.0.0.1:${port}/`;
        servers.set(instanceKey, { server, url });
        return { url, title: `Preview ${instanceKey}` };
      },
      async stopWebApp(_webAppId, instanceKey) {
        const running = servers.get(instanceKey);
        if (!running) return;
        servers.delete(instanceKey);
        await new Promise((resolve) => running.server.close(resolve));
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
        ctx.commands.register("report.context", async () => {
          await ctx.client.files.write(
            "plugin-context-report.json",
            `${JSON.stringify({
              stateRoot: ctx.stateRoot,
              workspaceRoot: ctx.workspaceRoot,
              pluginRoot: ctx.pluginRoot,
            })}\n`,
          );
        });
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
        ctx.commands.register("report.settings", async () => {
          await ctx.client.files.write(
            "plugin-settings-report.json",
            `${JSON.stringify({
              atActivation,
              current: ctx.settings.get(),
              heard,
              changeCount,
            })}\n`,
          );
        });
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
          await ctx.client.files.write(
            "database-roundtrip-report.json",
            `${JSON.stringify({
              tables: before.tables.map((table) => table.name),
            })}\n`,
          );
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
        });
        ctx.commands.register("ui.tryOpen", async () => {
          let result;
          try {
            await ctx.client.ui.open("notes/today.md");
            result = { opened: true, message: null };
          } catch (error) {
            result = {
              opened: false,
              message: String(error?.message ?? error),
            };
          }
          await ctx.client.files.write(
            "ui-open-report.json",
            `${JSON.stringify(result)}\n`,
          );
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
        ctx.commands.register("watch.received", async () => {
          await ctx.client.files.write(
            "watch-received-report.json",
            `${JSON.stringify(received)}\n`,
          );
        });
        ctx.commands.register("watch.started", async () => {
          await ctx.client.files.write(
            "watch-started-report.json",
            `${JSON.stringify(started)}\n`,
          );
        });
        ctx.commands.register("watch.stop", async () => {
          await unsubscribe?.();
          unsubscribe = null;
          await ctx.client.files.write(
            "watch-stop-report.json",
            `${JSON.stringify({ stopped: true })}\n`,
          );
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
