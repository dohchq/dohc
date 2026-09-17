# Chat overhaul, phase 2: the engine

Reader: whoever implements or reviews `feat/chat-engine`. The parent plan is `chat-overhaul.md`; this file settles its phase 2 items against the code as it is.

**Status: implemented; in review.** The relay serves a group one half per request: the channel pull names the channel and gets its chat, the folder mount names nothing and gets its files. The two-desktop e2e is `apps/desktop/e2e/workspace-group-share.spec.ts`.

## What the maps found

Two facts change the shape of the work.

**The relay already has one create surface and one table for both share kinds.** `sync_relay_shares.selector_json` holds either `{paths, versionId}` or `{kind: "chat-channel", channelWireId}`, and `POST /sync/<ws>/shares` accepts either. A share id is one selector. Nothing forbids a third selector shape. So "one share" is not two grants under one id; it is one grant whose selector names both the folder and the channel.

**The engine has no members and no per-thread flag.** `chat_channels` is `(name, slug, kind)`. `chat_threads` is discriminated only by `channel_id IS NULL`. The migration ledger has one entry; every schema change is a new appended migration, and every new table must also join `REQUIRED_TABLES`.

## Decisions

1. **A channel has a folder path.** `chat_channels.folder_path TEXT` (null for `dm` and `agent`, and for channels older than this migration). `chats.channels.create` takes `folderPath`; the default is the slug. `chat.channel.create` carries it on the wire. The engine does not touch the filesystem: the desktop creates the folder when it creates the channel, the same way it creates a workspace folder. Renaming a channel is out of this phase (posts have no edit; channels have no rename op today).

2. **Members live on the relay, not in the engine.** The plan's `chat.channel.member.set` op would put membership in the engine and replicate it. But a member is a relay grant; the engine already treats a joined channel as a grant projection. Putting a second copy in the engine means two sources of truth for who can see what. So membership stays a relay grant, and the desktop's Members panel keeps reading grants. What changes: one grant covers the channel and its folder.

   The workspace root as a channel: not built. The plan's "members flow down from root" is the same as "a folder share covers its subtree", which the file selector already does. Sharing a channel whose folder is `a` shares `a/**`, and any channel whose folder sits under `a` is reachable through that grant's files. Its chat is not; that needs a channel grant per channel, which is one call per channel and is left for the sharing UI to batch.

3. **One share is one grant with a group selector.** New relay selector `{kind: "group", channelWireId, paths: [folderPath], versionId: null}`. Access is the chat vocabulary (`read-write | read-only`); file access derives from it (`edit | view`). The relay's op filter treats a group grant as a chat-channel grant for `chat.*` ops on that channel plus a path grant for file ops on the folder. Revoke is one call because it is one share.

   Accepting on the desktop: a group grant joins the channel (existing path) and mounts the folder under `shared-with-me/<label>` (existing path) in one action, from Shared with you. The mount label stays flat: the label is derived from the channel name, deduplicated the way share mounts already are. The nested-label question in the plan is closed by keeping mounts flat.

4. **Channel type and purpose.** `chat_channels.type TEXT NOT NULL DEFAULT 'posts' CHECK (type IN ('posts','chat','both'))` and `purpose TEXT NOT NULL DEFAULT ''`. Carried on `chat.channel.create`. `kind` stays as the privacy discriminator (`dm` stays hidden from the feed).

5. **The chat lane is a flagged thread.** `chat_threads.lane TEXT NOT NULL DEFAULT 'posts' CHECK (lane IN ('posts','chat'))`. `chats.threads.start` takes `lane`. `chat.thread.create` carries it. `list_channel_threads` excludes `lane = 'chat'` by default and takes `lane` to select it. The feed predicate excludes chat-lane threads. Search leaves them in (the plan says "by default"; a search that finds a chat line is not a bug).

6. **Poll options.** `chat_decisions.options_json TEXT` (a JSON array of strings, null when the decision is a bare question) and `chosen_option TEXT`. `chats.threads.start` and `chats.messages.send` take `options?: string[]` beside `needsDecision`; `chats.decisions.resolve` takes `chosenOption?`. `chat.decision.set` carries both. The CLI gains `--option <text>` (repeatable) and `--choose <text>` on `--resolve`. The runner's thread context renders options and the chosen one.

7. **Implicit follow.** When a user posts, comments, or reacts with a relay identity, the engine writes a thread follow for that user in the same transaction. Mentions: when a message body mentions a handle that resolves to a user id, write a thread follow for that user too. All go through the existing `set_follow` LWW path and journal `chat.follow.set`, so the follow reaches the user's other devices. The renderer's `ensureDefaultChannelFollows` seed stays.

8. **`lastOpenedAt`.** Nothing to do.

## What this phase does not do

- No engine member table, no root channel, no `chat.channel.member.set`. See decision 2.
- No channel rename or delete.
- No filesystem work in the engine.
- No migration path for existing stores beyond the additive migration: new columns default, old rows keep working.

## Order

Each step compiles and passes the Rust gate on its own.

1. Migration 1: the six new columns. `type`, `purpose`, `folder_path` on channels; `lane` on threads; `options_json`, `chosen_option` on decisions.
2. Channel type, purpose, folder path through domain, RPC, sync apply, wire contract, desktop store, IPC, and the create-group dialog.
3. Thread lane through the same layers, plus the list filter and feed predicate.
4. Poll options through the same layers, plus the CLI and the runner context.
5. Implicit follow in the domain write paths.
6. Group selector on the relay, the one-share accept and revoke on the desktop, and the two-desktop e2e.

## Gate

`pnpm verify:pr --base feat/chat-overhaul` with both `--job js` and `--job rust` green. The Rust gate through the `rust-gate` skill. A two-desktop e2e that shares a group, accepts it, posts from both sides, and sees both posts and a file. A second independent reviewer for the authorization delta in step 6.
