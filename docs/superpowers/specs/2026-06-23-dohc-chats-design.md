# dohc Chats Design

Status: exploratory architecture direction
Date: 2026-06-23

Companions:

- `docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md`
- `docs/superpowers/specs/2026-06-23-dohc-native-filesystem-design.md`

## Core thesis

dohc should not add Slack as a sidebar. dohc should make conversation part of
the workspace.

The user-facing label should be **Chats** because it is familiar and obvious.
The underlying shape should be durable, post-like work threads attached to
files, folders, versions, agent runs, decisions, apps, and data.

The product promise:

> Chat about work where the work actually lives.

Slack is mostly a stream of messages. dohc chats should be durable work
conversations with source context.

## Naming

Use familiar words in the interface:

- **Chats**: top-level product surface.
- **Channels**: places where people gather.
- **DMs**: direct or small group conversations.
- **Messages**: individual replies/comments.

Use better primitives internally:

- `Channel`
- `ChatThread`
- `ThreadMessage`
- `ThreadLink`
- `ThreadActivity`
- `ThreadReadState`

The UI can say chat. The system should not inherit Slack's stream-first data
model.

## Core model

```text
Channel / DM
  -> ChatThread
    -> ThreadMessage
    -> ThreadLink
    -> ThreadActivity
```

Channels organize chats. Chats hold the work.

This is the key difference from Slack:

```text
Slack:
  channel stream -> messages -> occasional thread

dohc:
  channel/group -> durable chats -> messages/replies
```

The channel is a place. The chat is the work conversation.

## Channels and groups

Channels are important. People need places.

Examples:

```text
#general
#product
#engineering
#customers
#finance
#client-acme
```

A channel can be a general discussion space or can attach to workspace scope:

- folder.
- project.
- client/entity.
- app.
- version.
- workspace object.

Example:

```text
#finance
  linked to:
  - data/finance/**
  - apps/finance-dashboard/
  - docs/budget-notes.md
```

This lets dohc show relevant chats from the file, folder, app, or version being
viewed.

## DMs and small group chats

dohc needs fast personal conversation.

If dohc only supports channels and durable work threads, it will feel stiff.
Slack and Teams are sticky partly because direct conversation is effortless.

Required surfaces:

- one-to-one DMs.
- small group chats.
- quick handoff from a DM into a linked work chat.
- ability to mention an agent in a DM.

DMs should still be source-aware when needed:

```text
Ice -> Sarah
Can you check this?

linked:
- docs/pricing.md
- Version: q3-plan
```

But DMs must stay fast. Do not force every DM to become a formal work thread.

## Chat threads

A chat thread is a durable work conversation.

Fields:

```ts
type ChatThreadBase = {
  id: string
  workspaceId: string
  title?: string
  status: 'open' | 'closed' | 'decided' | 'archived'
  createdBy: string
  createdAt: number
  lastActivityAt: number
  linkedWork: ThreadLink[]
  pinned: boolean
}

type ChannelChatThread = ChatThreadBase & {
  channelId: string
  dmParticipantIds?: never
}

type DmChatThread = ChatThreadBase & {
  channelId?: never
  dmParticipantIds: [string, ...string[]]
}

type ChatThread = ChannelChatThread | DmChatThread
```

A thread must have exactly one owner shape: channel-backed or DM-backed. It
must never have both `channelId` and `dmParticipantIds`, and it must never have
neither. Creation and update paths must validate this XOR before routing,
authorization checks, notifications, search indexing, or projection handling.

Threads can start titleless for speed, then dohc or the user can name them once
they become durable.

The interface must not feel like a forum. Starting a chat should be as fast as
typing in Slack:

```text
open channel -> type -> send
```

The system can later promote or summarize a burst of messages into a named
thread when it becomes real work.

## Messages

Messages are comments/replies inside a chat thread.

Fields:

```ts
type ThreadMessage = {
  id: string
  threadId: string
  parentMessageId?: string
  authorId: string
  authorKind: 'human' | 'agent' | 'system'
  body: string
  createdAt: number
  editedAt?: number
}
```

Nested replies should be supported, but the UI should avoid becoming a maze.
Most conversations should read linearly, with targeted replies when useful.

## Agent authorship

Agent messages should be socially clear and simple.

Human message:

```text
Ice
Can we check the pricing?
```

Agent message:

```text
<User Name>'s agent
I checked the forecast. The enterprise tier looks underpriced.
```

Do not show model names, tool names, or permission badges in the normal chat
surface.

The provenance can exist in history or message details if needed, but the main
conversation should stay readable.

Display rule:

```text
Human message: <User Name>
Agent message: <User Name>'s agent
```

## Agent participation

Agents should be able to participate without scraping UI.

Core actions:

```text
list_channels
list_chats
read_chat
create_chat
reply_to_chat
link_chat_to_work
summarize_chat
```

Every chat action must derive actor identity server-side or engine-side and
enforce workspace scope on every entity and result:

- `list_chats`
- `read_chat`
- `create_chat`
- `reply_to_chat`
- `link_chat_to_work`
- `summarize_chat`

Callers must not be able to assert user/workspace identity, widen chat
visibility, or link a chat to work they cannot access. Agent messages use the
same authorization model as human messages; the display label is different, not
the authority model.

Renderer surfaces that load channels, chats, linked work, summaries, search
results, or side-rail state asynchronously must guard responses with a
workspace/request token, abort signal, or equivalent. A slow response for
workspace A must never repaint workspace B after a workspace switch.

This does not violate the dohc file philosophy. Chats are social actions, not
plain file writes. Posting a message triggers activity, mentions, read state,
and notifications. It should be an action.

Agents should still get readable context projections:

```text
.dohc/chats/<thread-id>.md
```

That projection is primarily for reading/reference/export. It should not be the
canonical write path for posting.

## File projections

Chats should have text projections for search, export, and agent context.

Example projection:

```md
---
id: chat_123
channel: engineering
status: open
linked:
  - docs/versioned-workspace.md
  - version: q3-plan
---

# Versioned workspace conflict handling

## Messages

<User Name>:
Can we make conflict handling feel more like Google Docs?

<User Name>'s agent:
I checked the filesystem spec and found one risk...
```

This is one-way by default. Editing this file should not be how users post
messages.

## Integration with files and versions

Chats can link to:

- files.
- folders.
- versions.
- history moments.
- apps/sites.
- databases/rows.
- agent runs.
- decisions.
- tasks.
- shares/exports.

The same chat can appear in multiple places:

```text
#engineering channel
docs/versioned-workspace.md side rail
Version: q3-plan activity
Inbox because Ice was mentioned
Search results for "conflict handling"
```

One conversation, many relevant surfaces.

## Interface placement

Primary navigation:

```text
Files
Chats
Activity
Agent
Search
Settings
```

Chats should not be opt-in for now. They are part of dohc's core workspace
model.

The first screen for Chats should feel fast and familiar:

```text
Chats
  Inbox
  DMs
  Channels
    general
    product
    engineering
```

Channel view:

```text
#engineering

Composer...

Active
- Versioned workspace conflict handling
- Desktop update rollout
- Agent filesystem findings

Pinned
- Release checklist
- Engineering decisions
```

The channel may support lightweight stream messages, but durable chats should be
the object that survives and resurfaces.

## Side rail integration

When viewing a file, folder, app, data source, or version, dohc should show
related chats.

Example:

```text
docs/pricing.md

Right rail:
  Chats
    Q3 pricing decision
    Enterprise tier concern
    Agent forecast update

  Activity
    <User Name> edited this file
    <User Name>'s agent updated the forecast
```

This is where dohc becomes better than Slack. The conversation is beside the
work, not in a separate stream.

## Presence and lightweight reactions

Chats need human texture.

Required lightweight features:

- presence: online, away, offline.
- typing indicators.
- read/seen state where appropriate.
- quick reactions.
- simple acknowledgements.
- message edit/delete with history.

Keep reactions lightweight. They should make collaboration feel alive without
turning work into noise.

## Notifications that do not suck

Notifications decide whether people trust the chat system.

Required notification controls:

- mentions.
- direct messages.
- assigned/followed chats.
- replies to chats you follow.
- channel mute/unmute.
- per-channel notification level.
- digest mode.
- quiet hours.
- agent update controls.

Notification priority should come from work relevance:

- you were mentioned.
- a chat you follow became active.
- an agent finished work you requested.
- a decision/review/share needs attention.
- a linked file/version changed in a way that affects a chat you follow.

Avoid noisy bot spam. Integrations and agents should post into relevant chats,
not dump every event into a channel stream.

## Search better than Slack

Search must span the workspace, not just chat text.

Search should cover:

- chats.
- messages.
- channels.
- DMs.
- files.
- versions.
- history moments.
- decisions.
- agent runs.
- apps/data.

Search results should show source context:

```text
"pricing risk"

Chat: Q3 pricing decision
  linked docs/pricing.md and Version q3-plan

Document: docs/pricing.md
  discussed in Q3 pricing decision

Agent run: <User Name>'s agent forecast pass
  replied in Q3 pricing decision
```

This is a major advantage over Slack: search can understand the relationship
between the conversation and the work.

## External and shared channels

Shared channels are one of Slack's strongest lock-in features.

dohc should eventually support external/shared channels across workspaces.
This fits dohc especially well because dohc can already share files, folders,
atoms, apps, and versions across workspace boundaries.

External channel examples:

```text
#client-acme
#vendor-payments
#contractor-design
```

A shared channel can expose selected workspace resources:

- selected files/folders.
- selected atoms/documents.
- selected versions.
- selected apps/dashboards.
- selected chat threads.

The channel should not grant broad workspace access. Shared channel access must
compose with normal file/folder/version visibility.

User-facing preview before sharing:

```text
Share #client-acme with Acme?

They will see:
- #client-acme chats
- docs/acme/proposal.md
- apps/client-dashboard/

They will not see:
- private notes
- internal versions
- raw finance data
- secret-backed files
```

This connects Better Chats directly to the versioned workspace and native
filesystem designs.

## Resurfacing

Chats should resurface when they become active or important.

Resurface when:

- someone replies.
- a user is mentioned.
- an agent replies.
- linked files/versions change.
- a decision is due.
- a review/share/publish boundary needs attention.
- an external participant responds.

Do not resurface every tiny event. The feed should feel like active work, not an
activity firehose.

## Chat-to-work loop

The killer dohc loop:

```text
chat -> task
chat -> decision
chat -> agent run
chat -> version
chat -> document
chat -> workflow
```

Examples:

- turn a chat into a decision.
- ask <User Name>'s agent to investigate from a message.
- create a version from a chat.
- link a file to a chat.
- summarize a chat into a document.
- create tasks from a chat.

This is what makes dohc more than Slack.

## What not to do

Do not make chats feel like a forum:

- no slow post composer as the default.
- no forced title/type before sending.
- no heavy templates for casual conversation.
- no making every message a formal artifact in the UI.

Do not make chats feel like a generic Slack clone:

- no channel-only stream as the core model.
- no bot spam firehose.
- no detached discussions with no source context.
- no burying active old work.

Do not make chat an audit log:

- agent messages should read naturally.
- provenance details can be one click away.
- normal chat should stay human-readable.

## First proof slice

The first useful version should prove dohc-native collaboration:

1. Chats top-level navigation exists.
2. Users can create channels.
3. Users can send fast messages in a channel.
4. A burst of messages can become or belong to a durable chat thread.
5. Users can create a DM or small group chat.
6. Users can link a chat to a file.
7. Related chats show in the file side rail.
8. Users can mention another user.
9. Users can react to a message.
10. Presence/typing basics work.
11. Search finds chats and linked files together.
12. Agents can read and reply to a chat.
13. Agent messages display as `<User Name>'s agent`.
14. A chat can link to a version or history moment.
15. Notification rules cover mentions, DMs, followed chats, and agent updates.

This slice should feel fast, obvious, and natural before adding heavier
workflow features.

## North star

Slack is where people talk around the work.

dohc Chats should be where people and agents talk inside the work.

The interface should feel familiar enough that Slack users understand it, but
the model should be much stronger:

> Channels gather people. Chats hold work. Every chat can connect to files,
> versions, agents, decisions, and shared workspace context.
