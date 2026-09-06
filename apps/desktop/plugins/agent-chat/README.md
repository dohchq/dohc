# Agent chat

Runs the [Claude Code CLI](https://github.com/anthropics/claude-code) and the
[Codex CLI](https://github.com/openai/codex) on a dohc workspace as agent
drivers, and serves a chat page for each.

One plugin, two drivers (`claude-code`, `codex`), two web apps
(`claude-code-chat`, `codex-chat`). The drivers share nothing but
`src/shared.ts`: line framing, the command override, and the shape of a probe
that found nothing. The chat server and page (`src/chatWebApp.ts`, `ui/`) are
one implementation created once per driver with the agent's name; the server
fills the name into `index.html` as it serves it and `chat.js` reads it back
from `<html data-agent>`.

This is dohc's own worked example of a driver plugin. Codex was dohc's
built-in driver until the driver contribution point existed; both now run as
an ordinary plugin, with no path through core that a plugin of your own could
not take.

The plugin has no dependencies. It imports types from `@dohc/sdk`, which
disappear at build time, and Node's own `crypto` for ids.

## What it needs

The `claude` and `codex` commands, installed and logged in. A driver whose
command is missing reports itself absent; the other keeps working. The plugin
never reads either CLI's credentials. Claude's own login owns Claude's: the
plugin asks `claude auth status` whether a login exists and reports only that,
so an installed Claude Code that nobody is logged into reads as a missing login
rather than a missing harness. The account's email address is in that answer
and stays in the plugin. Codex's own login owns Codex's: the plugin refuses the
app-server's token-refresh request back to the CLI.

## How it talks to Claude

Claude Code's native duplex protocol, not the ACP adapter. dohc's broker starts
one `claude` process per session as a supervised child and owns its process
tree; the plugin owns only the conversation on that child's standard streams:

```
claude -p --input-format stream-json --output-format stream-json --verbose
       --session-id <uuid>  |  --resume <cursor>
       --permission-prompt-tool stdio
       --permission-mode <mode>
       --mcp-config <inline dohc-mcp json>
```

The working directory is the workspace root, because Claude Code has no
working-directory flag.

**`--permission-prompt-tool stdio` is the whole permission seam.** With it,
Claude asks before it runs a tool, as a `can_use_tool` control request that
dohc answers. Without it, Claude answers its own prompt: it denies, reports
`system/permission_denied`, and dohc is never asked. This was measured, not
assumed (claude 2.1.233, 2026-08-17).

The session is long-lived. One process takes a user message per turn on
standard input and keeps the conversation across turns, so dohc does not resend
a thread it already sent. `--session-id` names a new session and `--resume`
continues one; they are alternatives, and `--resume` with an id Claude does not
know exits the process rather than starting a fresh session.

dohc's MCP server arrives additively as `--mcp-config`. Claude keeps the MCP
servers the user configured for themselves, because `--strict-mcp-config`,
which would drop them, is not passed.

Two limits worth knowing. Keeping the user's servers rests on Claude's merge
default rather than on a flag dohc passes, so a future Claude that made
`--mcp-config` replacing instead of merging would drop them silently. And dohc
registers its server under the name `dohc`, so a user server with that exact
name is shadowed.

### Claude modes

dohc's three modes map to Claude's own `--permission-mode` values. The values
are Claude's: `--permission-mode` accepts exactly these (verified against
claude 2.1.233).

| dohc mode           | Claude permission mode |
| ------------------- | ---------------------- |
| `approval-required` | `manual`               |
| `auto-accept-edits` | `acceptEdits`          |
| `full-access`       | `bypassPermissions`    |

`approval-required` is also the default, so a mode this driver does not know
asks a person rather than proceeding.

### Claude permissions

dohc decides. The permission policy stays in dohc's main process and never
reaches this plugin. What crosses to dohc is the tool, what it says it will do,
and where; the tool's own input stays in the plugin, which needs it to answer.

"Allow for session" forwards only the allow rules Claude itself suggested, and
only for the session. A `setMode` suggestion would widen every later tool call,
and a suggestion bound for `localSettings` would write the user's own Claude
configuration, a durable change to a file dohc does not own, made from a click
that said "for session".

## How it talks to Codex

dohc's broker starts `codex app-server` as a supervised child and owns its
process tree; the plugin owns only the JSON-RPC conversation on that child's
standard streams:

- `initialize`, then `thread/start` with `cwd` set to the workspace root and
  dohc's own MCP server injected as `config.mcp_servers.dohc`.
- `turn/start` per prompt, `turn/interrupt` to cancel.
- Codex's approval requests become dohc permission requests. dohc decides, as
  above, and the answer returns to Codex as `accept`, `acceptForSession`,
  `decline`, or `cancel`.

### Codex modes and sandboxes

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

## Pointing a driver at another build

Environment variables, read once when the plugin activates. `<PREFIX>` is
`CLAUDE_CODE` or `CODEX`.

- `DOHC_AGENT_<PREFIX>_COMMAND`: the command to run instead of `claude` or
  `codex`.
- `DOHC_AGENT_<PREFIX>_ARGS_JSON`: a JSON array of arguments to put before the
  driver's own. A value that is not JSON is split on spaces.
- `DOHC_AGENT_CLAUDE_CODE_READY_TIMEOUT_MS`: how long Claude has to answer
  dohc's handshake before the session gives up. The default is 20000, against
  a measured answer of about one second.

## Its own chats

The plugin serves one singleton web app per driver: a dedicated chat UI on the
plugin's own loopback HTTP server, separate from dohc's built-in workspace
chat. Each reuses the driver instance the plugin registers; dohc's own chat and
these are still independent sessions at runtime. The permission seams
described above are unchanged: a Claude `can_use_tool` request or a Codex
approval request surfaces in the chat page the same way it reaches dohc's own
chat.

**MCP is credential-free and local-only here.** dohc's built-in chat spawns
`dohc-mcp` with `--home` pointed at the desktop's own state directory, SDK
package metadata, and, when cached, cloud credentials (`mcpRuntimeConfigFor`
in `apps/desktop/src/main.ts`). All of that is main-process-only state a plugin
has no SDK seam to reach, and a plugin must not be handed it to fetch it: that
would route host credentials into full-trust plugin code. Without `--home`,
`dohc-mcp` resolves its home to the OS default instead, so registry-backed MCP
tools this chat's session reaches read that default registry rather than the
desktop's, and cloud-aware tools have no runtime environment. Shared views are
unaffected either way: they are already refused before a plugin web app starts
(`assertWritableWorkspace`).

## Proofs

- `src/*.test.ts`: the protocol mappings, the framings, and the chat server
  and page, in isolation.
- `apps/desktop/src/plugins/claudeCodeDriverPlugin.test.ts` and
  `codexDriverPlugin.test.ts`: each driver through the whole real chain:
  dohc's driver registry, a forked plugin process, and a harness running as a
  real brokered command child.
- Each file's last test runs against the **real** CLI on this machine. It
  needs a login and a network, so it runs only when `DOHC_TEST_REAL_CLAUDE=1`
  or `DOHC_TEST_REAL_CODEX=1`.
