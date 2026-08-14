# @dohc/sdk

The default `dohc` export uses a browser preview context with a dohc host
window.

## Node plugin runtime

The `@dohc/sdk/node` entry provides the process transport and plugin authoring
types.

The trusted plugin host uses the process transport:

```ts
import {
  createDohcClient,
  createProcessTransport,
} from "@dohc/sdk/node";

const transport = createProcessTransport();
const client = createDohcClient({ transport });
```

A plugin entry module default-exports its lifecycle handler:

```ts
import type {
  PluginActivateContext,
  PluginHandler,
} from "@dohc/sdk/node";

const activate = (ctx: PluginActivateContext) => {
  ctx.commands.register("example.run", () => ctx.client.capabilities());
};

const handler: PluginHandler = {
  activate,
  deactivate() {
    // Release plugin resources here.
  },
};

export default handler;
```

Plugins that need a Node child use the host-owned child-process broker:

```ts
async function startServer(ctx: PluginActivateContext) {
  const child = await ctx.childProcesses.spawn({
    modulePath: "snapshot/server.mjs",
    args: ["--port", "0"],
    cwd: "snapshot/data",
    env: { LOG_LEVEL: "info" },
  });
  const unsubscribe = await child.onOutput(({ stream, text }) => {
    console.log(`[${stream}] ${text}`);
  });
  await child.send({ type: "status" });
  const exit = await child.wait();
  await unsubscribe();
  return exit;
}
```

The host contains `modulePath` and `cwd` inside the plugin's built directory.
That directory holds the built bundle at its root and the plugin's own
installed files under `snapshot/`, so a path to a file the plugin ships starts
with `snapshot/`.
The host also terminates every brokered child when that plugin spawn ends.

The type-only import adds no runtime dependency on `@dohc/sdk`.

This contract never requires the plugin and host to share a loaded SDK module
instance, so it remains safe when the plugin carries its own dependencies.

`createProcessTransport()` detects an Electron utility-process message channel
or plain stdio. Plugin authors do not select the binding.

Sites can use the typed APIs for common dohc operations:

```ts
import { dohc } from "@dohc/sdk";

const text = await dohc.files.read("site-data/status.txt");
await dohc.files.write("site-data/status.txt", `${text}\nUpdated by my site.`);
const files = await dohc.files.list("notes");
const matches = await dohc.workspace.search("next action");
const database = await dohc.databases.read({ path: "data/tasks.sqlite" });
await dohc.ui.open("notes/today.md");
```

The client also exposes `request`/`invoke` and `subscribe` escape hatches so a
new host capability never has to wait for an SDK release. `capabilities()` is
an availability map for the current local, shared, or published context; it is
not a permission-prompt API. Calls support `AbortSignal` and per-request
timeouts through `{ signal, timeoutMs }` request options.

`files.read()` throws if the host had to return only a bounded prefix, which
prevents an accidental partial read-modify-write from truncating a large file.
Use `files.readInfo()` when a site intentionally wants to inspect
`{ text, truncated }` itself. Raw `files.write()` is for ordinary source and
text artifacts; canonical Markdown documents require dohc's document-editing
path so live Y.Doc state, locks, history, and collaboration remain coherent.

## Security Note: file:// Previews

For `file://` dohc hosts, browser `postMessage` requires request `targetOrigin`
`"*"` because there is no stable origin to target. Response source and origin
checks still guard replies, but they cannot protect request payloads already
sent to the page: every script on that `file://` page can observe request
parameters. Workspace-relative paths passed to APIs such as `files.read(path)`
are acceptable because authorization is enforced by the dohc host, but do not
send absolute file paths, user identities, workspace IDs, internal state,
tokens, or other sensitive data in `file://` request messages. Authorization
and user identity validation must always happen in the dohc host/server layer;
browser callers are untrusted. `file://` sandboxing is inherently weaker than
an HTTP(S) origin, even though response validation still checks `event.source`
and response data remains origin-checked. Production sites should be previewed
over HTTP(S) for full origin isolation. Prefer normal dohc preview origins, or
another restricted same-origin transport, when the app needs isolation.
