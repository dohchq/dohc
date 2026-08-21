# Codex

Runs the [Codex CLI](https://github.com/openai/codex) on a dohc workspace as an
agent driver.

This is dohc's own worked example of a driver plugin. It was dohc's built-in
Codex driver until the driver contribution point existed; it now runs as an
ordinary plugin, with no path through core that a plugin of your own could not
take.

## What it needs

The `codex` command, installed and logged in. The plugin never reads Codex's
credentials — Codex's own login owns them, and the plugin refuses the
app-server's token-refresh request back to the CLI.

The plugin has no dependencies. It imports types from `@dohc/sdk`, which
disappear at build time, and Node's own `crypto` for request ids.

## How it talks to Codex

dohc's broker starts `codex app-server` as a supervised child and owns its
process tree; the plugin owns only the JSON-RPC conversation on that child's
standard streams:

- `initialize`, then `thread/start` with `cwd` set to the workspace root and
  dohc's own MCP server injected as `config.mcp_servers.dohc`.
- `turn/start` per prompt, `turn/interrupt` to cancel.
- Codex's approval requests become dohc permission requests. dohc decides —
  the permission policy stays in dohc's main process and never reaches this
  plugin — and the answer returns to Codex as `accept`, `acceptForSession`,
  `decline`, or `cancel`.

### Modes and sandboxes

dohc's three modes map to Codex's own approval policy and sandbox. The values
are Codex's: `codex --sandbox` and `codex --ask-for-approval` accept exactly
these (verified against codex-cli 0.146.0).

| dohc mode           | Codex approval policy | Codex sandbox        |
| ------------------- | --------------------- | -------------------- |
| `approval-required` | `untrusted`           | `read-only`          |
| `auto-accept-edits` | `on-request`          | `workspace-write`    |
| `full-access`       | `never`               | `danger-full-access` |

`approval-required` is also the default, so a mode this driver does not know
gets the read-only sandbox rather than a permissive one.

## Pointing it at another Codex

Two environment variables, read once when the plugin activates:

- `DOHC_AGENT_CODEX_COMMAND` — the command to run instead of `codex`.
- `DOHC_AGENT_CODEX_ARGS_JSON` — a JSON array of arguments to put before the
  plugin's own (`app-server`, `--version`). A value that is not JSON is split
  on spaces.

## Its own chat

The plugin also serves a singleton web app (`chat`): a dedicated Codex chat UI
on the plugin's own loopback HTTP server, separate from dohc's built-in
workspace chat. It reuses the same `createCodexDriver` instance the `codex`
driver above registers — dohc's own chat and this one are still two
independent sessions at runtime.

**MCP is credential-free and local-only here.** dohc's built-in chat spawns
`dohc-mcp` with `--home` pointed at the desktop's own state directory, SDK
package metadata, and — when cached — cloud credentials
(`mcpRuntimeConfigFor` in `apps/desktop/src/main.ts`). All of that is
main-process-only state a plugin has no SDK seam to reach, and a plugin must
not be handed it to fetch it: that would route host credentials into
full-trust plugin code. Without `--home`, `dohc-mcp` resolves its home to the
OS default instead, so registry-backed MCP tools this chat's session reaches
read that default registry rather than the desktop's, and cloud-aware tools
have no runtime environment. Shared views are unaffected either way: they are
already refused before a plugin web app starts (`assertWritableWorkspace`).

## Proofs

- `src/*.test.ts` — the mapping rules and the JSON-RPC framing, in isolation.
- `apps/desktop/src/plugins/codexDriverPlugin.test.ts` — this plugin through
  the whole real chain: dohc's driver registry, a forked plugin process, and a
  harness running as a real brokered command child.
- The same file's last test runs against the **real** `codex` on this machine.
  It needs a login and a network, so it runs only when
  `DOHC_TEST_REAL_CODEX=1`.
