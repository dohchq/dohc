# dohc Chats Design

Status: exploratory architecture direction
Date: 2026-06-23

Companions:

- `docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md`
- `docs/superpowers/specs/2026-06-23-dohc-native-filesystem-design.md`

## Core thesis

dohc should not bolt chat onto the side. dohc should make conversation part of
the workspace itself.

The user-facing label should be **Chats** because it is familiar and obvious.
The underlying shape should be durable, post-like work threads attached to
files, folders, versions, agent runs, decisions, apps, and data.

The product promise:

> Chat about work where the work actually lives.

Stream-first chat tools are mostly message timelines. dohc chats should be
durable work conversations with source context.

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

The UI can say chat. The system should not inherit a stream-first data model.

Minimal `ThreadReadState`:

```ts
type ThreadReadState = {
  workspaceId: string
  threadId: string
  actorId: string
  lastReadCursor: {
    threadSequence: number
    createdAt: number
    messageId: string
  }
  updatedAt: number
}
```

The canonical read cursor is sequence-based, not timestamp-based. No row means
nothing in the thread has been read by that actor. Updates are monotonic: read
state can only advance forward in the thread, never move backward. Chats, Inbox,
file side rails, notification badges, and search result read/unread markers must
all derive from this workspace-scoped state. Monotonicity is validated against
the canonical per-thread ordering comparator:
`(threadSequence, createdAt, messageId)`. Message IDs alone are not an ordering
contract, and `lastReadAt` is not a valid advancement fallback. `ThreadReadState`
is unique on `(workspaceId, threadId, actorId)` and writes are upserts, not
inserts that can duplicate rows. Updating `lastReadCursor` must compare against
the canonical comparator before advancing. The write must be atomic: use a
conditional upsert, transactional compare-and-swap, or equivalent CAS semantics
that advances `lastReadCursor` only when the incoming
`(threadSequence, createdAt, messageId)` tuple is greater than the stored tuple.
Concurrent stale updates must no-op or retry, never overwrite a newer cursor
with an older one.

`ThreadMessage.threadSequence` is the authoritative per-thread monotonic
sequence assigned by the canonical `ChatThread`/`ThreadMessage` store at message
creation time. It is scoped to `(workspaceId, threadId)`, never reused, and used
with `createdAt` and `messageId` only as the deterministic ordering tuple for
cursor advancement. Projection builders, notification workers, search indexers,
and read-state updates must all use that same
`(threadSequence, createdAt, messageId)` tuple. The canonical store must enforce
a unique constraint on `(workspaceId, threadId, threadSequence)`, and sequence
allocation must happen transactionally or under serialized per-thread locking
during message creation so duplicate sequence numbers cannot be persisted.

## Core model

```text
Channel / DM
  -> ChatThread
    -> ThreadMessage
    -> ThreadLink
    -> ThreadActivity
```

Channels organize chats. Chats hold the work.

This is the key model difference:

```text
conventional chat:
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
Messaging tools are sticky partly because direct conversation is effortless.

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
  dmParticipantIds: [string, string, ...string[]]
}

type ChatThread = ChannelChatThread | DmChatThread
```

A thread must have exactly one owner shape: channel-backed or DM-backed. It
must never have both `channelId` and `dmParticipantIds`, and it must never have
neither. Creation and update paths must validate this XOR before routing,
authorization checks, notifications, search indexing, or projection handling.
DM-backed threads require at least two unique participants; a one-person DM is
invalid. Before persistence, routing, key generation, indexing, or ACL checks,
`dmParticipantIds` must be deduplicated and stable-sorted. The XOR ownership
rule is enforced after canonicalization. For DM-backed threads, the canonical
participant set must derive a stable unique persistence key within the workspace
such as `(workspaceId, dmParticipantSetHash)`. Creation must be atomic through
upsert, CAS, a transaction, or an equivalent uniqueness constraint so
concurrent creates resolve to one canonical thread instead of duplicate DM
threads for the same participant set.

Threads can start titleless for speed, then dohc or the user can name them once
they become durable.

The interface must not feel like a forum. Starting a chat should be as fast as
typing in a normal chat:

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
  workspaceId: string
  threadId: string
  threadSequence: number
  parentMessageId?: string
  authorId: string
  authorKind: 'human' | 'agent' | 'system'
  body: string
  createdAt: number
  editedAt?: number
  deletedAt?: number
  deletedById?: string
  deleteReason?: string
  tombstone?: boolean
}
```

If `parentMessageId` is present, it must reference an existing message in the
same workspace and `threadId`, must not equal the message's own `id`, and must
not introduce a cycle in the ancestry chain. `ThreadMessage.workspaceId` must
match `ChatThread.workspaceId` wherever messages are written, read, indexed,
notified, or projected. Message create/update paths must validate this before
rendering nested replies, indexing, notification fanout, or projection
generation.

`ThreadMessage.body` is untrusted user/agent input. Rendering must escape plain
text by default or sanitize through an allowlisted formatting subset before
display. If rich text is supported, the permitted subset is limited to ordinary
inline formatting, code, links with safe protocols, mentions, and file/work
references; raw HTML, scriptable URLs, event handlers, and embedded active
content are not allowed. The same sanitization contract applies to chat
projections, search snippets, notifications, and summaries.

Deletes are tombstones, not hard deletes. If `deletedAt` is present,
`tombstone` must be true, `body` must render as a deletion placeholder, and the
original body must remain available only through authorized audit/history paths.
If the original body contains or may contain secrets, audit/history retention
must store secret-backed references, encrypted payloads, or redacted forms, not
plaintext secret content.
Projections, search, notifications, and summaries all read the same
`ThreadMessage` deletion state and must not invent ad hoc redaction behavior or
retain plaintext secrets in history, audit, search, export, or agent-log flows.

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
- `list_channels`
- `read_chat`
- `create_chat`
- `reply_to_chat`
- `link_chat_to_work`
- `summarize_chat`

Callers must not be able to assert user/workspace identity, widen chat
visibility, or link a chat to work they cannot access. Agent messages use the
same authorization model as human messages; the display label is different, not
the authority model.
Chat writes and links must also respect user locks, folder/atom/file sharing
boundaries, protected work, and skill-turn/review gates before persisting
messages, links, notifications, or projections.

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
canonical write path for posting. Before any chat text is written to this
projected Markdown file, the projection pipeline must classify secret content
and apply the same policy-aware redaction rules used by chat rendering, search,
notifications, summaries, and export. Derived chat files must never persist
plaintext secrets outside the authorized secret-backed read path.

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

If a projected chat file is edited locally, the edit must not mutate the
canonical chat. The engine should treat it as an invalid projection write,
preserve the edited bytes as a local recovery artifact or status item, and
regenerate the projection from canonical chat state. The user or agent should
be directed to post through chat actions instead of editing the projection.
Projection renderers must use the same body escaping/sanitization rules as the
interactive chat UI, and must run secret classification/redaction before
writing any message body into `.dohc/chats/<thread-id>.md`.

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
the object that survives and resurfaces. A channel send always maps to a
`ThreadMessage` inside a `ChatThread`, creating or resolving that thread
implicitly when needed. There is no separate durable `ChannelMessage` entity
outside the canonical `ChatThread -> ThreadMessage` model.

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

This is where dohc becomes work-native. The conversation is beside the work,
not in a separate stream.

## Presence and lightweight reactions

Chats need human texture.

Required lightweight features:

- presence: online, away, offline.
- typing indicators.
- read/seen state where appropriate.
- quick reactions.
- simple acknowledgements.
- message edit/delete with history through the `ThreadMessage` edit and
  tombstone fields.

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

## Workspace-native search

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

This is a major advantage over standalone chat: search can understand the
relationship between the conversation and the work.
The search pipeline must classify or redact secrets before indexing or rendering
results across chats, messages, files, versions, history moments, agent runs,
apps/data, and source-context snippets. Search snippets must never expose
plaintext secrets that are not visible through the same policy-aware read path.

## External and shared channels

Shared channels are one of standalone chat products' strongest retention loops.

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
Every message, link, and projected reference inside a shared channel must be
re-authorized against normal workspace policy before exposure. An external
viewer can see only the chat content and work artifacts explicitly shared with
them; non-shared files, atoms, versions, app views, agent runs, and links remain
hidden even if they are mentioned inside an otherwise shared thread.

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

This is what makes dohc more than standalone chat.

## What not to do

Do not make chats feel like a forum:

- no slow post composer as the default.
- no forced title/type before sending.
- no heavy templates for casual conversation.
- no making every message a formal artifact in the UI.

Do not make chats feel like a generic chat clone:

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

Standalone chat is where people talk around the work.

dohc Chats should be where people and agents talk inside the work.

The interface should feel familiar enough that chat users understand it, but
the model should be much stronger:

> Channels gather people. Chats hold work. Every chat can connect to files,
> versions, agents, decisions, and shared workspace context.
