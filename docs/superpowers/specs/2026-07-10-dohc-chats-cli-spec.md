# dohc Chats — CLI Spec (`dohc chat`)

Status: draft for review, rev 2 (incorporates multi-agent review findings)
Date: 2026-07-10
Companion to: `2026-07-10-dohc-chats-hybrid-feed-spec.md`,
`2026-07-10-dohc-chats-agent-runner-spec.md`

## Summary

`dohc chat` is the agent-facing interface to Chats: a small, stable set of
verbs any agent can be prompted against. Agents act through the CLI; humans
act through the UI; both hit the same engine mutations, so posting stays an
action (authorship, activity, read state, notifications, gates) and never a
raw file write.

The CLI is a **prompt-facing contract**. Every verb and output format below
will be baked into runner prompts and AGENTS.md conventions across user
workspaces — treat changes to it like breaking a public API. Keep the surface
minimal and boring.

## Decisions locked

1. **Verbs, v1:**

   ```
   dohc chat channels                          # list channels
   dohc chat threads <channel>                 # list a channel's posts (unread marked)
   dohc chat inbox                             # unread DMs + mentions for this actor
   dohc chat grep <pattern> [scope]            # search all chats, grep-style
   dohc chat show <thread|message>             # thread (or branch) as markdown; marks read (--peek to not)
   dohc chat post <channel> [flags] [body]     # new post
   dohc chat reply <thread> [flags] [body]     # comment (--to <message> for nested reply)
   dohc chat react <message> <emoji>           # toggle reaction
   dohc chat export [--all|--channel <c>|--thread <t>] --out <dir>
   ```

   `post` targets channels (including the agent channel, where a post starts
   a task thread) and rejects DM channels — DMs are streams; reply into the
   existing thread. Body is the trailing argument or `-` for stdin (long
   content always via stdin). Shared flags: `--attach <path>` (repeatable), `--needs-decision`,
   `--resolve <message>` (reply only — closes the open decision record on
   that message; the resolving reply is recorded as the leaving message),
   `--title <t>` (post only; otherwise first line becomes the title, same as
   the UI).
2. **`grep` is the context workhorse.** Chat search shaped like the tool
   every agent already knows:

   ```
   dohc chat grep <pattern> [--channel <c>] [--thread <t>] [--from <actor>]
                  [--since <7d|date>] [-i] [-l] [-C <n>] [--limit <n>]
   ```

   Default: smart-case substring match over message bodies and post titles,
   accelerated by the shipped FTS index (`engine_search_chat_messages_fts`);
   `--regex` for a true regex scan. Output is ripgrep-shaped — one match per
   line, prefixed with the handles the next verb needs:

   ```
   #engineering th_8f2k1c msg_d4e5f6 Ice's agent 2026-07-03  …a stable blockId or replay drifts…
   ```

   `-C n` prints n surrounding messages from the same thread; `-l` prints
   matching thread ids only (pipe into `show`). Results pass the same
   redaction rules as every other surface.
3. **Output is markdown by default, `--json` for structure.** Agents read
   markdown natively; scripts get stable JSON. `show` output is the same
   rendering the runner packs into prompts and the projection writes to files
   — one canonical text form of a thread, three consumers.
4. **Every listed item shows its id.** Short stable id prefixes are accepted
   wherever an id is taken (git-style). Channels resolve by slug or id.
5. **Identity is explicit, ambient for runs.** Actor defaults to human.
   `--as-agent` or `DOHC_CHAT_ACTOR=agent` posts as `<User>'s agent`. Trust
   boundary, precisely: **attribution to the posting user (`authorUserId`)
   is server-derived; `author.kind` (human/agent) is a persisted,
   behavior-bearing client claim.** Spoofing `kind` grants nothing — both
   hands share one verified `authorUserId` — but it authoritatively drives
   UX (badge, run chip, agent-tinted rendering, including cross-user in
   shared channels) and per-actor read state, so the CLI must persist it
   faithfully. The agent badge is a display convenience, never a security
   boundary: no gate or consent logic may key on it. The runner exports the
   env var so dispatched runs are auto-agent with zero prompt burden — but
   attribution is never load-bearing for dispatch or loop decisions (runner
   spec decisions 10–11).
6. **`inbox` requires two real model changes.** (a) Per-actor read state:
   today `ChatThreadReadState` is simplified to the one local human actor;
   the agent needs its own read cursor per thread. The cursor is a display
   signal only — dispatch acking is the runner spec's durable ledger, never
   this cursor, which is why `show --peek` exists for context packing. (b)
   Mentions: "unread DMs + mentions" needs mention parsing at post/reply
   time plus a per-actor mention index; neither exists in the shipped ops or
   schema. (`@agent` resolution to the owner's agent is the runner's variant
   of the same parse.) Both are called out here so they aren't discovered
   during implementation.
7. **The CLI talks to the local engine host.** v1: the desktop app must be
   running; the CLI connects over a local IPC socket and fails with a clear
   one-line error when it can't (`dohc: desktop app not running`). A headless
   engine mode is a later addition. The relay token and all sync machinery
   stay in the main process, exactly as with presence (MU-C5). Writes
   arriving over this socket never create dispatch triggers (runner spec
   decision 5): CLI-origin means an agent's hands or a terminal, not the
   remote flow.
8. **Errors are one plain-text line on stderr + nonzero exit.** No stack
   traces at agents. Common failures (unknown id, no such channel, gate
   refused the write) each get a distinct, greppable message.
9. **Gates are enforced at the engine, not the CLI.** A CLI call cannot
   bypass locks, folder/atom access, sharing boundaries, or skill-turn gates;
   when a write is held for review (future held-for-review posts), the CLI
   says so and exits zero — the post existing-but-gated is success.
10. **Workspace discovery via AGENTS.md.** dohc maintains a short section in
    the workspace's agent-facing instructions: "this workspace has chats —
    run `dohc chat inbox` to check yours, `dohc chat grep` to search them;
    always pass `--as-agent` on chat writes." The flag is per-invocation
    because interactive harnesses (Claude Code among them) don't persist
    shell state between commands — an exported env var silently vanishes by
    the next tool call and posts land human-attributed with no error. The
    ambient env var is reserved for runner-dispatched processes, where
    inheritance actually works. The workspace self-describes; no agent needs
    dohc-specific training.

## Getting context: the funnel

The design principle for agent ergonomics is a funnel where **every output
embeds the handles the next verb takes**, so an agent is never stranded
without an id to act on:

```
inbox   →  what needs me            (thread ids)
grep    →  find anything, anywhere  (thread + message ids, -C for surround)
show    →  read a thread or branch  (message ids, run ids, attachment paths)
reply   →  act
export  →  bulk context when a run genuinely needs everything
```

`show` accepts a message id and prints just that branch — the cheap path for
mention-in-comment dispatches. `show` output is byte-identical to what the
runner packs into prompts and what projection writes to files: one canonical
text form of a thread, three consumers. An agent that knows grep and markdown
already knows how to research dohc chats.

## Installation & distribution

- **The desktop app ships the CLI; there is no separate install.** Download
  the app → `dohc` is on PATH (installed on first run, with an "install
  CLI" affordance in settings for repair — the VS Code `code`-command
  pattern). This is load-bearing, not convenience: AGENTS.md blocks and
  runner prompts assume the binary exists, so a fresh machine must get it
  for free.
- **The CLI is a thin client.** It speaks only the local IPC protocol; all
  logic lives in the app. That keeps it a tiny binary, auto-updated with the
  app, with a version handshake so a stale shim fails with one clear line
  (`dohc: CLI/app version mismatch — restart the app`) instead of subtle
  breakage.
- **Per-platform PATH mechanics:** macOS/Linux — symlink into `~/.local/bin`
  (fall back to `/usr/local/bin` with consent); Windows — shim directory
  appended to the user PATH. No admin/root required on any platform.
- **WSL:** when the app runs on Windows, installation also drops a
  Linux-side shim inside WSL so agents running there reach the Windows app —
  agents overwhelmingly live in WSL on Windows machines, so this is part of
  the default install, not an extra. Transport across the boundary: prefer
  an `AF_UNIX`-interop bridge where available (it preserves
  filesystem-permission scoping); fall back to loopback TCP only with the
  full hardening set — token stored 0600 in a per-user directory, port bound
  to loopback only, connections rejected before any verb runs without the
  token, token rotated on app restart, version handshake after auth. This is
  worth the ceremony because the socket is total authority over chat:
  `export --all` and DM reads are full-workspace exfiltration for any local
  process that can connect.
- **`dohc` is the umbrella binary.** `dohc chat` is the first subcommand
  family; files/search/etc. can join later without new PATH entries.

## Non-goals, v1

- **No bookmark/projection verbs.** Bookmarks are a human curation gesture in
  the UI; the rules file covers automation. Revisit if agents turn out to
  need it.
- **No channel/DM administration** (create channel, start DM, archive) —
  channels are user-created by locked decision, and admin actions stay in the
  UI for now. `post` into an existing channel is the agent's whole write
  surface, plus replies and reactions.
- **No watch/stream mode** (`--follow`). Runners are dispatched per turn;
  polling agents can call `inbox`. A follow mode invites agents to run as
  daemons, which is the runner's job, not the CLI's.

## Sketch of `show` output

```markdown
# Conflict handling should feel like a doc editor
thread: th_8f2k1c · #engineering · 12 comments · open decisions: none

**Ice de Vera** · 2h ago
Right now versioning pops a merge dialog... [attach: q3-plan.md]

**Sam Okafor** · 2h ago · msg_a1b2c3
Love this. The hard part is block-level forks...

**Ice's agent** · 2h ago · msg_d4e5f6 · replying to msg_a1b2c3 · run rn_77xy
Risk: block forks need a stable blockId...
```

One text form, honest ids inline, nesting flattened to `replying to` tags —
the same flatten rule the UI uses at its depth cap.

## Open questions

1. `react` toggle vs. explicit add/remove (lean: toggle, matching the UI and
   the existing tombstoned set semantics).
2. JSON schema versioning — a `dohc chat --version`-gated schema, or a
   `schemaVersion` field per payload (lean: field per payload).
3. Does `grep -C` count context in messages or lines? (Lean: messages — the
   unit of meaning in a thread is the message, not the line.)

(Resolved since rev 1: WSL↔Windows transport — `AF_UNIX`-interop preferred,
hardened loopback fallback; see Installation. Note the loopback path cannot
support the engine's process-ancestry loop correlation, which is why the
runner spec's re-dispatch budget is mandatory.)

## First slice

1. `inbox`, `show`, `reply` — the minimum loop a runner needs.
2. `grep` (substring + FTS; `--regex` can lag) — context is half the product.
3. `post`, `react`, `threads`, `channels`.
4. `--as-agent` / env attribution + agent read cursor + mention parse/index.
5. `--attach` with file chips.
6. `export`.
7. AGENTS.md self-description block.
