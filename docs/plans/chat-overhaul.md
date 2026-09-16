# Chat overhaul plan

Reader: the agent implementing the chat overhaul, one phase at a time. Each phase names what it builds, what it must settle first, and the gate that ends it. Do not start a phase before its predecessor's gate passes.

The design was settled in a throwaway prototype on branch `prototype/chat-2026-09` at `docs/prototypes/chat-prototype.html`. Its `Model` object is the intended shape for the engine contract, and the comment at the top of that file lists every decision. This plan does not repeat the exploration. It says what to build.

## What chat is after this plan

A group is a folder. It holds posts, a chat lane, and files. It is private until it has members. Adding a person to a group shares it. Members on the workspace root are members of every group inside. Members flow down, never up. There are no workspace kinds.

A person opens chat and sees Home, one list of everything new across the groups they can see, newest first. A group opens on its own posts, newest first. Nothing is ranked.

A post is drawn like a social feed card: avatar, name, group and time, title or text, files as cards, then Like, Comment, Save as file. Comments are bubbles under the post. A poll is a post with stacked options. An agent's work is a post with a run line and a Show change link. A chat lane is a stream of short messages, grouped by author.

An agent is added like a person, under Agents in the nav, by naming it and choosing what runs it. There is no dedicated agent chat. Mention `@agent` anywhere and it answers there.

Vocabulary: home, group, member, post, comment, chat, poll, file, agent. Gone from the interface: channel, thread, feed, follow, bookmark, snapshot, live, decision, "My agent", "This file".

## Product bar

The human side. Someone who has used Facebook groups can use this without learning anything. Every group says who can see it before anything else. Every row says what it is. No screen has more than one header bar.

The agent side. An agent reaches every group it is a member of through the same MCP tools and CLI it has today. A post with options is a tool result it can answer. A group's folder is where its files land. Nothing here needs the UI.

Performance. The panel opens on cached data and repaints on the same revision watermarks the current view uses. A group with a thousand posts scrolls at 60 frames. Measure with the renderer marks before and after each phase.

## Settled decisions

Recorded so no phase re-litigates them.

- A group is a folder. Group id maps to a folder path. Creating a group creates the folder. Files in the folder are the group's files.
- Membership lives on the group. The workspace root is a group. Effective members are the union up the ancestor chain plus the owner.
- Sharing a group is adding a person. One act grants both posts and files. The receiver gets the group flat, never the sharer's tree, with paths spelled from the shared group down.
- Group types: posts, chat, both. A chat group holds no groups. Groups nest two deep in the nav; deeper is allowed on disk and reached from the parent.
- A DM is a two-member chat group with no name of its own.
- Home is one list, newest first. A group opens on its posts. No roll-up, no bands, no ranking.
- A poll is a post with options. The engine's decision table backs it. "Decision" never appears in the interface.
- Following is implicit. Posting, commenting, reacting, or being mentioned follows the post. The manual follow switches go.
- Save as file is the existing bookmark. The mode choice moves to a second step.
- Posts have no edit and no delete in this plan.
- Every pinned `data-testid`, `aria-*`, `role`, and accessible name stays. Restyle freely. Never rename or remove one.
- Library-first for the feed and composer where a maintained library fits the existing stack. No new dependency without a reason written in the PR.

## Phase 1: renderer, posts and groups

**Status: implemented on `feat/chat-overhaul`; in review.**

Redraw chat on the existing engine contract. No engine change. No IPC change except where a field is already on the wire and unused.

What it builds:

1. A `Post` card: avatar, name, group and time, kind word, title or text, file cards, run line, poll options, social line, Like / Comment / Save as file, bubble comments, reply field on demand. Replaces `ChatPosts.tsx`'s `PostCard` and `ThreadMessages`.
2. A collapsed composer, "What's happening in #group?", that opens into title, body, Mention, File, Poll, Post. Replaces the always-open composer. Keeps `MentionComposer`'s autocomplete.
3. A chat lane: messages grouped by author within five minutes, day dividers, hover timestamp, "Make a post" on hover. Replaces the current per-thread reply list for the quick lane.
4. The nav: Home, Groups with two-level disclosure, Shared with you, People, Agents. No Files section. No agent lane. Replaces the root list in `ChatsView.tsx`.
5. Home as one list. A group screen with one header: breadcrumb, purpose, member avatars, more menu, tabs. Replaces the channel and thread pages.
6. The panel owns chat. Clicking a group renders it in the panel. The Chats editor tab stays reachable from the panel's expand button only.
7. The agent as participant: olive name, sparkle avatar, run line. Runner errors render as a system line, never as agent speech.

What it maps to today, so nothing is invented:

| New word | Engine object | Renderer source today |
| --- | --- | --- |
| Group | `ChatChannel` | `ChatsView.tsx` channel list |
| Post | `ChatThread` and its opening message | `ChatPosts.tsx` `PostCard` |
| Comment | `ChatMessage` with `parentMessageId` | `ThreadMessages` |
| Chat lane | one thread per channel, flagged in phase 2; until then the channel's newest thread | `ThreadMessages` |
| Poll | thread with an open `ChatDecision` | decision resolve UI |
| Home | `listPersonalChatFeed` flattened, newest first | `ChatsView.tsx` feed |
| Save as file | `saveChatBookmark` | `BookmarkAction` |
| Members | share grants on the channel | `chats-share-panel` |

What it settles first:

- Which of the 231 tests across `ChatsView.*.test.tsx`, `LinkedChats.test.tsx`, `chatMessages.test.tsx`, and `MentionComposer.test.tsx` pin behavior the new surfaces keep, and which pin layout that goes. Keep the first set green. Retire the second set in the same commit that retires the surface, with the reason in the commit body.
- Which pinned names the ten e2e specs under `apps/desktop/e2e` actually reference. Those names move to the new surfaces unchanged. Names no spec references may still be renamed only after `pnpm test:desktop:e2e` proves it.

Gate: `pnpm verify:pr --base main` green. `pnpm test:desktop:e2e` green on the chat specs. A screenshot pass in both themes of Home, a group with posts, a chat lane, a poll, an agent run, and the composer open. Renderer marks for panel open and group switch no worse than main.

## Phase 2: engine, group as folder

**Status: implemented on `feat/chat-engine`, stacked on phase 1; in review. Item 2, members as an engine op, is not built: members remain relay grants, and `chat-overhaul-phase2.md` records why.**

The changes the prototype needs that the engine does not have. Each is small on its own. Together they replace two share systems with one.

What it builds:

1. A channel has a folder path. `chat.channel.create` takes a path. The engine creates the folder. Renames move the folder. The channel's files are the folder's files.
2. Members on a channel. A new op `chat.channel.member.set` with `userId` and `state`. The root channel exists per workspace. Effective membership resolves up the path.
3. One share. Adding a member to a channel issues the file mount grant for the folder and the chat-channel grant for the channel in one relay call. Accepting places the folder under `shared-with-me/` and the channel under Shared with you. Removing a member revokes both.
4. Channel `type` in `posts | chat | both` and `purpose`. Extends the existing `kind`.
5. The chat lane is one thread per channel flagged `lane: "chat"`. It never enters the feed or search by default.
6. Poll options. `chat.decision.set` carries `options: string[]`. Resolving carries the chosen option. The agent runner protocol gains the same field so an agent can post a question with choices.
7. Implicit follow. The engine writes `chat.follow.set` when a user posts, comments, reacts, or is mentioned. The renderer stops offering follow toggles.
8. `lastOpenedAt` is already on the registry. Nothing to add.

What it settles first:

- Whether a folder share grant today can carry chat ops, or whether chat sync and file sync are separate relay lanes that one grant must open together. Read `services/sync-relay/src/sharedChannels.ts`, `fileChatShares.ts`, and `apps/desktop/src/workspaces/shareMounts.ts` before designing item 3. If they are separate, item 3 issues two grants under one id and the revoke path must revoke both or neither.
- The symlink guard in `shareMounts.ts` keys on `shared-with-me/<label>`. A group's folder path is the label. Confirm the guard holds for nested paths, or keep mounts flat and map the group path to a flat label.

Gate: `pnpm verify:pr --base main` with both `--job js` and `--job rust` green. The Rust gate through the `rust-gate` skill. A two-desktop e2e that shares a group, accepts it, posts from both sides, and sees both posts and a file. A second independent reviewer for the authorization delta, because item 3 merges two permission boundaries.

## Phase 3: agents

**Status: implemented on `feat/chat-engine` with phase 2; in review.**

1. Add agent under Agents in the nav: name, runner, check. Writes the existing `runner` settings. Replaces the "Set up your agent" card in the channel view.
2. The agent's screen: runner, what it reaches, recent work.
3. An agent's question with options posts as a poll addressed to one person. Answering resolves it and the answer reaches the run.
4. Other people's agents that reach the workspace list under Agents, read-only.

Gate: `pnpm verify:pr --base main` green. The dispatch e2e green. A screenshot pass of the add-agent flow and an agent's question answered.

## Order inside phase 1

Each step is one PR, reviewed and merged before the next. Every step is shippable.

1. `Post` card and comments, mounted inside the existing channel view. The old card is deleted in this PR.
2. The collapsed composer.
3. The nav and the group header, in the panel. The Chats editor tab keeps working from the expand button.
4. Home as one list. The feed page and follow toggles go.
5. The chat lane.
6. The agent as participant.

## What this plan does not do

- Message edit or delete.
- Reactions beyond one emoji per person per post.
- Notifications outside the app.
- Search changes. Chat stays in the engine index as it is.
- Share links to posts. That is the share-links program.
