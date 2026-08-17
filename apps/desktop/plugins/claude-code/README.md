# Claude Code

Runs the [Claude Code CLI](https://github.com/anthropics/claude-code) on a dohc
workspace as an agent driver.

The plugin has no dependencies. It imports types from `@dohc/sdk`, which
disappear at build time, and Node's own `crypto` for session and turn ids.

## What it needs

The `claude` command, installed and logged in. The plugin never reads Claude's
credentials — Claude's own login owns them. It asks `claude auth status`
whether a login exists and reports only that, so an installed Claude Code that
nobody is logged into reads as a missing login rather than a missing harness.
The account's email address is in that answer and stays in the plugin: dohc has
no surface that shows it.

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
dohc answers. Without it, Claude answers its own prompt — it denies, reports
`system/permission_denied`, and dohc is never asked. This was measured, not
assumed (claude 2.1.233, 2026-08-17).

The session is long-lived. One process takes a user message per turn on
standard input and keeps the conversation across turns, so dohc does not resend
a thread it already sent. `--session-id` names a new session and `--resume`
continues one; they are alternatives, and `--resume` with an id Claude does not
know exits the process rather than starting a fresh session.

dohc's MCP server arrives additively as `--mcp-config`. Claude keeps the MCP
servers the user configured for themselves, because `--strict-mcp-config` —
which would drop them — is not passed.

### Modes

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

### Permissions

dohc decides — the permission policy stays in dohc's main process and never
reaches this plugin. What crosses to dohc is the tool, what it says it will do,
and where; the tool's own input stays in the plugin, which needs it to answer.

"Allow for session" forwards only the allow rules Claude itself suggested, and
only for the session. A `setMode` suggestion would widen every later tool call,
and a suggestion bound for `localSettings` would write the user's own Claude
configuration — a durable change to a file dohc does not own, made from a click
that said "for session".

## Pointing it at another Claude

Two environment variables, read once when the plugin activates:

- `DOHC_AGENT_CLAUDE_CODE_COMMAND` — the command to run instead of `claude`.
- `DOHC_AGENT_CLAUDE_CODE_ARGS_JSON` — a JSON array of arguments to put before
  the plugin's own. A value that is not JSON is split on spaces.

## The ACP driver dohc still ships

Core's `claude-acp` driver spawns `claude-code-acp`, the ACP **adapter** — a
separate package, and one that is absent on machines where Claude Code itself
works. This plugin drives the `claude` CLI directly and takes an id of its own,
so the two stand side by side. Whether the adapter path stays in core is a
separate decision.

## Proofs

- `src/*.test.ts` — the protocol mapping and the line framing, in isolation.
- `apps/desktop/src/plugins/claudeCodeDriverPlugin.test.ts` — this plugin
  through the whole real chain: dohc's driver registry, a forked plugin
  process, and a harness running as a real brokered command child.
- The same file's last test runs against the **real** `claude` on this machine.
  It needs a login and a network, so it runs only when
  `DOHC_TEST_REAL_CLAUDE=1`.
