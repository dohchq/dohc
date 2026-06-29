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

All chat primitives are workspace-scoped data. `Channel`, `ChatThread`,
`ThreadMessage`, `ThreadLink`, `ThreadActivity`, and `ThreadReadState` all carry
`workspaceId`, and create/read/update/delete, lookup, projection, notification,
and search paths must include `workspaceId` in their keys. Channels are persisted
and keyed by stable `(workspaceId, channelId)`. Slugs are lookup aliases only:
channel APIs may resolve `(workspaceId, channelSlug)` to `channelId`, but durable
threads, messages, links, activity, read state, projections, notifications, and
search indexes must use `channelId` so slug changes cannot fork or duplicate
channel state. Thread links must reference workspace-scoped source and target
objects and reject cross-workspace links by default. Cross-workspace `ThreadLink`
records are permitted only as explicit
shared-channel exceptions: the link must carry the owning `workspaceId`, target
workspace/resource identity, share/grant id, and visibility scope, and every
read path, projection, search result, notification, export, replay job, history
reconstruction, or other reconstruction consumer must re-authorize that grant.
For `scopeKind: 'internal'`, `targetWorkspaceId` must equal `workspaceId`; any
internal link with a different target workspace is rejected before persistence,
activity fanout, projection, search, notification, export, or replay.
Missing, expired, revoked, or ambiguous shared-channel grants fail closed for
all of those paths. Grant revoke/expiry also triggers cleanup of server-held derived
projections, search snippets, notification caches, export staging artifacts, and
other service-owned materialized chat context for that exception so stale shared
data does not remain exposed after access changes. Thread activity records are
append-only events keyed by `(workspaceId, threadId, activityId)` or an
equivalent workspace/thread scoped sequence.
`ThreadLink` create/update paths must validate the target workspace/resource
identity, share/grant id, and visibility scope against trusted server-side grant
state before any link or activity record is persisted. Client-provided grant
fields are hints only; missing, expired, revoked, forged, mismatched, or
ambiguous grants fail closed before persistence.

The UI can say chat. The system should not inherit a stream-first data model.

Minimal `ThreadReadState`:

```ts
type UInt64DecimalString = string // canonical base-10 unsigned 64-bit integer
type UnixMsDecimalString = string // canonical base-10 Unix epoch milliseconds

type ThreadReadState = {
  workspaceId: string
  threadId: string
  actorId: string
  lastReadCursor: {
    threadSequence: UInt64DecimalString
    createdAt: UnixMsDecimalString
    messageId: string
  }
  updatedAt: UnixMsDecimalString
}
```

Canonical decimal strings must use ASCII base-10 digits only. Writers and readers
must reject signs, decimal points, separators, whitespace, locale/non-ASCII
digits, empty strings, leading zeros except the literal `0`, and values outside
the declared range. `UInt64DecimalString` is `0` through
`18446744073709551615`. `UnixMsDecimalString` is non-negative Unix epoch
milliseconds through `8640000000000000` unless a narrower shared-schema range is
declared. All boundary readers must parse, range-check, and reserialize to the
canonical form before storing, comparing, indexing, or projecting
`threadSequence`, `bodyRevision`, `createdAt`, `editedAt`, `deletedAt`,
`lastActivityAt`, `updatedAt`, or read-state cursor fields.

`threadSequence`, `bodyRevision`, `createdAt`, `editedAt`, `deletedAt`,
`lastActivityAt`, and `updatedAt` use these canonical decimal-string encodings at
storage, API, projection, and worker boundaries. Implementations compare them as
integer values using a 64-bit/BigInt-safe path, never as floating-point
JavaScript numbers and never with locale string collation.

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
the canonical comparator before advancing. For every read-state write, `actorId`
must be derived from authenticated server/engine identity, never trusted from
client payload fields; caller-supplied actor identity is ignored or rejected
before message-existence or ordering checks run. The write must be atomic: use a
conditional upsert, transactional compare-and-swap, or equivalent CAS semantics
that advances `lastReadCursor` only when the incoming
`(threadSequence, createdAt, messageId)` tuple is greater than the stored tuple.
Before CAS evaluation or any tuple-to-message existence lookup, the caller must
be authorized for the target workspace/thread using server-derived identity:
workspace scope, thread visibility, and channel/DM membership must pass first.
If the incoming tuple exactly equals the stored `lastReadCursor`, the operation
is an idempotent success with no state change after authorization; it does not
re-check `ThreadMessage` existence. Only after authorization succeeds and the
incoming tuple is strictly greater than the stored cursor may the tuple resolve
against `ThreadMessage` in the same `(workspaceId, threadId)` and match that
message's canonical persisted ordering fields. If authorization fails, no message
existence signal is returned. If no such message exists after authorization, the
workspace or thread does not match, or the tuple is forged/stale relative to
persisted message state, the read-state update is rejected fail-closed.
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
  - reports/finance-dashboard.md
  - docs/budget-notes.md
```

This lets dohc show relevant chats from the file, folder, or version being
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

After canonicalization/deduplication, `dmParticipantIds` must contain 2-16 unique
participants. Raw duplicates are removed or rejected before persistence.
Oversized canonical participant lists fail closed before persistence. Larger
conversations should use channels or shared channels.

DMs should still be source-aware when needed:

```text
Ice -> Sarah
Can you check this?

linked:
- docs/pricing.md
- Version: q3-plan
```

But DMs must stay fast. The UX does not have to feel like a formal work thread,
but internally every one-to-one or small group DM is represented as a DM-backed
`ChatThread`; there is no separate durable DM model.

## Chat threads

A chat thread is a durable work conversation.

Fields:

```ts
type ChatThreadBase = {
  id: string
  workspaceId: string
  title?: string
  status: 'open' | 'closed' | 'decided' | 'archived'
  readonly createdBy: string // server-owned immutable creator label
  createdAt: UnixMsDecimalString
  lastActivityAt: UnixMsDecimalString // server-managed from canonical activity writes
  pinned: boolean
}

type ChatThreadProjection = ChatThread & {
  linkedWork: ActiveThreadLink[]
}

type ChannelChatThread = ChatThreadBase & {
  channelId: string
  channelConversationId: string
  dmParticipantIds?: never
}

type DmChatThread = ChatThreadBase & {
  channelId?: never
  dmParticipantIds: [string, string, ...string[]]
}

type ChatThread = ChannelChatThread | DmChatThread

type ThreadLinkTargetType =
  | 'atom'
  | 'file'
  | 'folder'
  | 'version'
  | 'history_moment'
  | 'agent_run'
  | 'share'
  | 'chat_thread'

type ThreadLinkScope =
  | { scopeKind: 'internal'; shareGrantId?: never; visibilityScope?: never }
  | { scopeKind: 'shared'; shareGrantId: string; visibilityScope: string }

type ThreadLinkBase = ThreadLinkScope & {
  id: string
  workspaceId: string
  threadId: string
  targetWorkspaceId: string
  targetId: string
  readonly createdById: string // server-owned immutable creator actor id
  createdAt: UnixMsDecimalString
  deletedAt?: UnixMsDecimalString
  deletedById?: string
}

type VersionedObjectThreadLink = ThreadLinkBase & {
  targetType: 'atom' | 'file' | 'folder' | 'version' | 'history_moment'
  targetVersionRef: VersionRef
}

type AgentRunThreadLink = ThreadLinkBase & {
  targetType: 'agent_run'
  targetVersionRef?: never
}

type ShareThreadLink = ThreadLinkBase & {
  targetType: 'share'
  scopeKind: 'shared'
  shareGrantId: string
  visibilityScope: string
  targetVersionRef?: VersionRef
}

type ChatThreadThreadLink = ThreadLinkBase & {
  targetType: 'chat_thread'
  targetVersionRef?: never
}

type ThreadLink =
  | VersionedObjectThreadLink
  | AgentRunThreadLink
  | ShareThreadLink
  | ChatThreadThreadLink

type ActiveThreadLink = ThreadLink & {
  deletedAt?: never
  deletedById?: never
}

type CanonicalThreadLinkKey = {
  workspaceId: string
  threadId: string
  scopeKind: 'internal' | 'shared'
  targetWorkspaceId: string
  targetType: ThreadLinkTargetType
  targetId: string
  versionKey: string
  shareGrantKey: string
  visibilityKey: string
}
```

For `ChannelChatThread`, `channelId` and `channelConversationId` are immutable
after creation. The active uniqueness key is
`(workspaceId, channelId, channelConversationId)`, with
`channelConversationId: "default"` for the default channel stream conversation.
Renaming or moving a channel changes channel metadata, not this key. Changing the
channel association requires tombstoning/archiving the old thread and creating a
new thread, so one conversation cannot fork into multiple active `ChatThread`
records for the same channel identity.

`ThreadLink` records are the canonical source for linked work.
`ChatThreadProjection.linkedWork` is a derived read model/cache of the current
non-tombstoned links, and `ThreadActivity` `link_added`/`link_removed` events are
append-only provenance. Link add/remove flows must update the canonical
`ThreadLink` record and append the corresponding activity in the same transaction
or serialized unit of work, then rebuild/invalidate `ChatThreadProjection.linkedWork`,
projections, search, and notifications from active canonical links only. If the
derived list includes a tombstoned link, omits an active link, or otherwise
disagrees with `ThreadLink`, the engine treats the derived list as stale and
repairs it instead of using it for authorization or export.
Active link creation is idempotent by `CanonicalThreadLinkKey`. The key is
derived from `(workspaceId, threadId, scopeKind, targetWorkspaceId, targetType,
targetId, targetVersionRef, shareGrantId, visibilityScope)` after canonical
normalization:

- `versionKey` is the stable serialized `VersionRef` for versioned targets; for
  target types that forbid `targetVersionRef`, it is the reserved sentinel
  `version:none`; for share targets without a version ref, it is the reserved
  sentinel `version:share-current`.
- `shareGrantKey` is `share:<shareGrantId>` for shared-scope links and the
  reserved sentinel `share:none` for internal links.
- `visibilityKey` is `visibility:<visibilityScope>` for shared-scope links and
  the reserved sentinel `visibility:internal` for internal links.

Reserved sentinels are not legal user/object identifiers. A retry for the same
normalized key must upsert or no-op against the existing active `ThreadLink` and
must not create a second active link or duplicate `link_added` fanout.
`ChatThreadProjection.linkedWork`, projections, search, and export all build
from one active canonical link per normalized uniqueness key and must use the
same normalization helper as link creation.
The uniqueness key applies only to active links where `deletedAt` is absent.
Tombstoned links remain historical records and do not block a future relink with
the same target tuple; relinking creates a new active `ThreadLink` and a new
`link_added` activity after validation succeeds.
Links are never hard-deleted in normal operation: removal sets `deletedAt` and
`deletedById`, and link visibility reads only non-tombstoned records. A link is
uniquely auditable by `ThreadLink.id`; replay systems may additionally validate
the normalized `CanonicalThreadLinkKey` plus raw target tuple
`(targetWorkspaceId, targetType, targetId, targetVersionRef, shareGrantId,
visibilityScope)` captured on the activity event.
`ThreadLink` target fields, `shareGrantId`, and `visibilityScope` are immutable
after creation. Changing a link means tombstoning the old link with
`link_removed` activity and creating a new link with `link_added` activity; there
is no in-place link update path for replay/export to miss.
Target types resolve through a server-side resolver registry keyed by
`ThreadLinkTargetType`. Unknown or unregistered target types fail closed before
link creation, resolution, search projection, export, notification fanout, or UI
rendering. Each resolver enforces workspace scope and target ACLs; adding a new
target kind requires extending the enum, registering a resolver, and adding
authorization, projection, export, and replay tests for that kind.
`chat_thread` links must be acyclic. A thread cannot link to itself, and link
creation must reject any target that would introduce a cycle in the thread-link
graph before `link_added` is recorded or linked-work projection, search,
notification, or export fanout runs.

Thread create/update paths must ignore or reject client-provided
`lastActivityAt`. The server updates `ChatThreadBase.lastActivityAt` only from
canonical `ThreadActivity` writes, using the same ordering source that drives
thread activity feeds and read-state updates.
Chat provenance fields are server-owned and immutable. `createdBy`,
`createdById`, `authorId`, and `actorId` are derived from authenticated
server/engine identity at write time, never accepted from browser/client
payloads, and cannot be changed by edit, replay, import, or projection paths
except through an explicit trusted migration that preserves original provenance
evidence.

`ChatThread.title` and any other user/agent-authored thread metadata are
untrusted text. They must be escaped by default or sanitized through the same
allowlisted formatting subset used for message bodies before appearing in UI,
search snippets, notifications, summaries, projections, or exports.

A thread must have exactly one owner shape: channel-backed or DM-backed. It
must never have both `channelId` and `dmParticipantIds`, and it must never have
neither. Creation and update paths must validate this XOR before routing,
authorization checks, notifications, search indexing, or projection handling.
DM-backed threads require at least two unique participants after
canonicalization; a one-person DM is invalid, and the canonicalized
`dmParticipantIds` set must stay at or below 16 participants. Oversized
canonical participant sets are rejected before persistence, routing, key
generation, indexing, ACL checks, fanout, or atomic create logic. Before the
remaining write path runs, `dmParticipantIds` must be
canonicalized with one deterministic algorithm shared across runtimes:
normalize actor IDs to their canonical persisted form, deduplicate by exact
canonical ID match, then sort by bytewise ascending UTF-8 encoding of the
canonical ID, not locale collation and not runtime-native UTF-16 code-unit
order. All services must use this comparator before key generation. The XOR
ownership rule is enforced after canonicalization. For DM-backed thread
create/update, the authenticated actor identity must be derived server-side,
must be included in the canonical participant set, and must be authorized to
message every participant before routing, key generation, indexing, ACL checks,
persistence, fanout, or atomic create logic. The same server-derived membership
rule applies to every DM read/write path: `read_chat`, `reply_to_chat`,
`edit_chat_message`, `delete_chat_message`, reactions, notifications, and
read-state updates. Membership must be verified against the canonical participant
set before routing, indexing, persistence, fanout, notification generation,
search snippet exposure, or cursor advancement. If membership changes or is
revoked, new reads, replies, edits, deletes, reactions, notifications, and
read-state updates for that actor fail closed unless an explicit retained-history
policy grants narrower access. For
DM-backed threads, the canonical participant set must derive a collision-safe
unique persistence key
within the workspace by using an exact canonical participant-set value, or a
hash plus exact-set verification, scoped by `workspaceId`. Creation must be
atomic through upsert, CAS, a transaction, or an equivalent uniqueness
constraint so concurrent creates resolve to one canonical thread instead of
duplicate DM threads for the same participant set.
DM participant sets are immutable after thread creation. Any membership change
creates or resolves a new canonical DM-backed `ChatThread` for the new exact
participant set and records a linkage event from the prior thread, rather than
mutating `dmParticipantIds` in place. `read_chat`, `reply_to_chat`, reactions,
`edit_chat_message`, `delete_chat_message`, notifications, and read-state
updates continue to authorize against the canonical participant set of the
specific thread being accessed, so membership changes cannot silently merge,
split, or reassign thread history.

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
  threadSequence: UInt64DecimalString
  parentMessageId?: string
  readonly authorId: string // server-owned immutable author actor id
  authorKind: 'human' | 'agent' | 'system'
  body: string
  bodyRevision: UInt64DecimalString
  createdAt: UnixMsDecimalString
  editedAt?: UnixMsDecimalString
  editedById?: string
  // Derived cache from the canonical message_deleted activity.
  deletedAt?: UnixMsDecimalString
  deletedById?: string
  deleteReason?: string
  tombstone?: boolean
}
```

If `parentMessageId` is present, it must reference an existing message in the
same workspace and `threadId`, must not equal the message's own `id`, and must
not introduce a cycle in the ancestry chain. `ThreadMessage.workspaceId` must
match `ChatThread.workspaceId` wherever messages are written, read, indexed,
notified, or projected. Message create/update paths must reject the write before
persistence unless the parent reference exists in the same workspace/thread, is
not self-referential, and does not introduce a cycle. Rendering nested replies,
indexing, notification fanout, and projection generation recheck the same
invariant as downstream safeguards only.
New `ThreadMessage` bodies start at `bodyRevision: "1"`. Every successful edit
must use a CAS-style update that verifies the current `bodyRevision` or
equivalent message version, then advances `bodyRevision` by exactly one decimal
integer in the same atomic unit that appends the matching `ThreadActivity`.
Concurrent edits with a stale revision fail closed or retry; they must not skip
revision numbers, overwrite each other, or duplicate revision history.
Message creation is also atomic: the initial `ThreadMessage` row and its
`message_created` `ThreadActivity` must be written in the same transaction or
serialized unit of work and become visible together. The activity is the
canonical creation event for replay, projections, exports, and audit; the
message row must not become visible without it, and a creation activity must not
be exposed without the corresponding row.

`ThreadMessage.body` is untrusted user/agent input. Rendering must escape plain
text by default or sanitize through an allowlisted formatting subset before
display. If rich text is supported, the permitted subset is limited to ordinary
inline formatting, code, links with safe protocols, mentions, and file/work
references; raw HTML, scriptable URLs, event handlers, and embedded active
content are not allowed. The same sanitization contract applies to chat
projections, search snippets, notifications, and summaries.

Deletes are tombstones, not hard deletes. The append-only
`MessageDeleteThreadActivity` is the canonical deletion state. `ThreadMessage`
`deletedAt`, `deletedById`, `deleteReason`, and `tombstone` are derived cache
fields copied from the canonical delete activity in the same atomic unit; they
must not be written independently, mutated after delete, or treated as a second
source of truth. If `deletedAt` is present, `tombstone` must be true, `body` must
render as a deletion placeholder, and the original body must remain available
only through authorized audit/history paths.
If the original body contains or may contain secrets, audit/history retention
must store secret-backed references, encrypted payloads, or redacted forms, not
plaintext secret content.
Replay, export, audit, projections, search, notifications, and summaries all
read the canonical delete activity, or a verified `ThreadMessage` cache derived
from it, and must repair or reject drift between the activity and row fields.
They must not invent ad hoc redaction behavior or retain plaintext secrets in
history, audit, search, export, or agent-log flows.
Authorized legal erasure is the exception to original-body retention: when a
GDPR/CCPA or equivalent request is approved through policy, the engine may
cryptographically purge, destroy keys for, or irreversibly redact the original
body while preserving `deletedAt`, `tombstone`, deletion-placeholder rendering,
and minimal audit metadata. Secret-backed references, encrypted payloads, or
redacted forms replace plaintext wherever audit/history access would otherwise
have retained the original body.

Edits must append immutable activity and replace the current message body in the
same transaction or serialized unit of work, with the activity written first
inside that atomic unit. The write must verify the current
`ThreadMessage.bodyRevision` or equivalent message version before commit, so
concurrent edits fail closed or retry instead of overwriting each other or
duplicating revision history. The matching `ThreadActivity` and updated
`ThreadMessage.body`/`ThreadMessage.bodyRevision` become visible together at
commit; if the commit fails, neither the activity nor the body change becomes
visible. Implementations may stage the activity internally before commit, but
must not expose a revision-history event without the corresponding current body
state.
`ThreadMessage.body` is the latest renderable state, while
`ThreadMessage.bodyRevision` identifies the current revision. The previous body,
editor identity, and edit timestamp are preserved in append-only
`ThreadActivity` records:

```ts
type ChatBodySnapshot =
  | { kind: 'plaintext', body: string }
  | { kind: 'redacted', reason: string }
  | { kind: 'secretRef', secretObjectId: string, redactedPreview?: string }

type ThreadActivityBase = {
  id: string
  workspaceId: string
  threadId: string
  readonly actorId: string // server-owned immutable activity actor id
  actorKind: 'human' | 'agent' | 'system'
  createdAt: UnixMsDecimalString
}

type MessageCreateThreadActivity = ThreadActivityBase & {
  messageId: string
  kind: 'message_created'
  nextBodyHash?: string
}

type MessageEditThreadActivity = ThreadActivityBase & {
  messageId: string
  kind: 'message_edited'
  previousBody: ChatBodySnapshot
  previousBodyRevision: UInt64DecimalString
  nextBodyHash?: string
}

type MessageDeleteThreadActivity = ThreadActivityBase & {
  messageId: string
  kind: 'message_deleted'
  previousBody: ChatBodySnapshot
  previousBodyRevision: UInt64DecimalString
  deleteReason?: string
  tombstoneHash?: string
}

type MessageDeleteLegacyThreadActivity = ThreadActivityBase & {
  messageId: string
  kind: 'message_deleted_legacy'
  legacyImportId: string
  previousBody?: ChatBodySnapshot
  deleteReason?: string
  tombstoneHash?: string
}

type ReactionIdentity =
  | { reactionId: string; reactionKey?: never; reactionActorId?: never }
  | { reactionId?: never; reactionKey: string; reactionActorId?: never }

type ReactionThreadActivity = ThreadActivityBase & ReactionIdentity & {
  messageId: string
  kind: 'reaction_added' | 'reaction_removed'
}

type LinkThreadActivity = ThreadActivityBase & {
  kind: 'link_added' | 'link_removed'
  linkId: string
  linkTarget: ThreadLinkScope & {
    targetType: ThreadLinkTargetType
    targetWorkspaceId: string
    targetId: string
    targetVersionRef?: VersionRef
  }
}

type MentionNotificationThreadActivity = ThreadActivityBase & {
  kind: 'mention_notification_enqueued' | 'mention_notification_resolved'
  messageId: string
  bodyRevision: UInt64DecimalString
  mentionedActorIds: string[]
  notificationId: string
  notificationStatus?: 'queued' | 'sent' | 'suppressed' | 'resolved'
  bodyHash: string
}

`MentionNotificationThreadActivity.mentionedActorIds` must be canonical before
storage: normalize each actor ID to its persisted form, deduplicate by exact
canonical ID match, then sort by bytewise ascending UTF-8 encoding. Enqueue,
resolve, replay, export, and notification fanout paths all use that canonical
array so duplicate mentions or runtime-specific ordering cannot create duplicate
notifications or unstable history.
`notificationId` is deterministic for a mention notification lifecycle:
`mention:<workspaceId>:<threadId>:<messageId>:<bodyRevision>:<sha256(canonicalMentionedActorIdsJson)>`.
`canonicalMentionedActorIdsJson` is the UTF-8 JSON array of the canonical,
deduplicated, bytewise-sorted actor ID strings with no extra whitespace.
`bodyHash` is required audit evidence for the immutable persisted body revision,
but it is not part of `notificationId` so redaction/sanitization views cannot
change the notification identity.
The enqueue path must upsert or no-op by that id, and resolve/replay/fanout must
dedupe by the same `notificationId`. Repeated enqueue or resolve attempts for
the same message revision and canonical mention set return the existing result
or a deterministic no-op; they must not append duplicate activities, duplicate
queue rows, unstable unread/mention badges, duplicate notifications, or duplicate
export/history records.

type ThreadActivity =
  | MessageCreateThreadActivity
  | MessageEditThreadActivity
  | MessageDeleteThreadActivity
  | MessageDeleteLegacyThreadActivity
  | ReactionThreadActivity
  | LinkThreadActivity
  | MentionNotificationThreadActivity
```

For `message_created`, `message_edited`, `message_deleted`, `reaction_added`,
and `reaction_removed`, `messageId`, `actorId`, `actorKind`, and `createdAt` are
required. For `message_edited`, `previousBody` and `previousBodyRevision` are
also required. For in-system `message_deleted` events, `previousBody` and
`previousBodyRevision` are required and must preserve the deleted body as
plaintext, redacted, or secret-backed snapshot according to policy. Legacy import
flows that cannot recover a prior body revision must map to
`message_deleted_legacy`, which renders as a tombstone, preserves
`legacyImportId`, `deleteReason`, and any available redacted/secret-backed body
snapshot, and is handled explicitly by history/export/replay as incomplete legacy
evidence rather than a normal in-system delete. Reaction events must satisfy
exactly one identity mode: either a
stable `reactionId`, or the complete deterministic tuple `(messageId, actorId,
reactionKey)`. `ThreadActivityBase.actorId` is the authoritative reaction actor
identity for authorization, replay, export, notification fanout, and idempotency.
`ReactionIdentity` must not introduce a second reaction actor field; legacy
imports that contain a mismatched reaction actor must normalize to the event
`actorId` or fail closed before replay.
Reaction writes are idempotent by the chosen identity mode. A stable
`reactionId` dedupes by that id; tuple mode treats `(messageId, actorId,
reactionKey)` as one idempotent key. Repeated `reaction_added` or
`reaction_removed` writes for the same key must return the existing result or a
deterministic no-op and must not create duplicate activity, reactions,
notifications, export entries, or replay effects.
Authorized history and export paths reconstruct the revision trail from these
events. Normal chat rendering, search, notifications, projections, and summaries
use the current `ThreadMessage.body` unless policy explicitly materializes
historical revisions. Legal erasure may replace `previousBody` with a redacted
snapshot while retaining edit provenance.
For `link_added` and `link_removed`, `linkId` and `linkTarget` are required so
audit/replay can identify the exact affected link even after the derived
`linkedWork` cache is rebuilt. Reaction add/remove replay affects one exact
reaction through the `ReactionIdentity` XOR above.
Mention and notification rebuilds use
`MentionNotificationThreadActivity` as the durable source of truth. Notification
queues, search snippets, unread/mention badges, exports, and replay jobs rebuild
from these activity records plus the current policy view; they must not rely on
ephemeral queue rows as the only record that a mention notification was enqueued,
suppressed, sent, or resolved.

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
- `edit_chat_message`
- `delete_chat_message`
- `add_reaction`
- `remove_reaction`
- `mark_thread_read`
- `update_read_state`
- `link_chat_to_work`
- `summarize_chat`

Callers must not be able to assert user/workspace identity, widen chat
visibility, or link a chat to work they cannot access. Agent messages use the
same authorization model as human messages; the display label is different, not
the authority model.
All chat API and worker mutation paths, including edits, deletes, reactions,
read-state updates, links, notifications, summaries, and projections, must also
respect user locks, folder/atom/file sharing boundaries, protected work, and
skill-turn/review gates before persisting or materializing derived state.

Renderer surfaces that load channels, chats, linked work, summaries, search
results, or side-rail state asynchronously must guard responses with a
workspace/request token and verify that token again at apply time before
mutating UI state. Abort signals are supplemental cancellation, not the only
guard. A slow response for workspace A must be ignored rather than repainting
workspace B after a workspace switch.

This does not violate the dohc file philosophy. Chats are social actions, not
plain file writes. Posting a message triggers activity, mentions, read state,
and notifications. It should be an action.

Agents should still get readable context projections:

```text
.dohc/chats/v1-<digest>.md
```

That projection is primarily for reading/reference/export. It should not be the
canonical write path for posting. Before any chat text is written to this
projected Markdown file, the projection pipeline must classify secret content
and apply the same policy-aware redaction rules used by chat rendering, search,
notifications, summaries, and export. Derived chat files must never persist
plaintext secrets outside the authorized secret-backed read path.
`.dohc/chats/**` is an explicit reserved internal projection scope under the
same fail-closed `.dohc/**` reserved-namespace rules used by the native
filesystem model. It is not a source-backed policy file, not an allowlisted
user-content path, and is not re-ingested as canonical user content.
The displayed `v1-<digest>.md` filename is the canonical deterministic
projection path shape; the raw thread id must not be used as a projection
filename. Projection writers must map the canonical thread id and visibility
scope to a deterministic filename using one fixed algorithm across all runtimes.
For v1, `projectionKind` is an explicit canonical enum with these exact values:

```ts
type ChatProjectionKind =
  | 'agent_context'
  | 'export'
  | 'search_index'
  | 'notification_context'
```

Writers and readers must not invent aliases, fallbacks, or implementation-local
strings. New projection kinds require a documented compatibility rule; if the
digest tuple changes incompatibly, use a new filename prefix such as `v2-`.
The projection scope is `owner` for the workspace-private internal projection,
or a grant-aware value such as `shareGrant:<grantId>:<authzScopeId>`, where
`authzScopeId` is a server-issued opaque identifier for the exact authorization
and redaction set used to materialize the projection. Compute the digest
over a length-prefixed tuple with fields in this exact order: `workspaceId`,
`threadId`, `projectionKind`, and `projectionScope`. Each field is first
normalized to Unicode NFC, encoded as UTF-8 bytes, then framed as
`uint32-be-byte-length || bytes`; the concatenated framed tuple is hashed with
`sha256`. Then encode the digest as lowercase RFC 4648 base32 with no padding,
and write `.dohc/chats/v1-<digest>.md`. The field order, length-prefix framing,
Unicode normalization, UTF-8 encoding, hash, lowercase digest encoding,
no-padding rule, grant-aware projection scope, and `v1-` prefix are the canonical
contract and must not vary by implementation. The projection must store or
otherwise verify the exact canonical thread id, workspace id, projection kind,
projection scope, and derived filename in metadata before writing, and must
reject ambiguous ids or any computed filename that already maps to a different
canonical tuple. Before writing or reusing a shared projection, the implementation
must verify the precise authorization/redaction context represented by
`authzScopeId`; grant or redaction changes require a new scope id and therefore a
new filename digest. Projection writers must reject path separators, relative
path segments, control characters, reserved names, and any other unsafe input
before constructing the projection path, so a crafted thread id cannot traverse
directories or overwrite another projection.
At write time, the projection writer must resolve and verify that the final
target remains under the workspace `.dohc/chats/` root, refuse to follow
symlinks for parent or target path components, and open/create the target with
safe no-follow primitives where the platform provides them. Writes must use
atomic create/replace semantics and fail closed if any canonicalization,
descriptor/handle continuity, or root-containment check changes between
validation and write, so symlink swaps or other TOCTOU races cannot redirect
projection output.

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
preserve recovery data only through secret-safe storage such as secret-backed,
encrypted, or policy-redacted artifacts/status items, and regenerate the
projection from canonical chat state. The user or agent should be directed to
post through chat actions instead of editing the projection. Projection
renderers must use the same body escaping/sanitization rules as the interactive
chat UI, and must run secret classification/redaction before writing any message
body into the canonical deterministic projection path
`.dohc/chats/v1-<digest>.md`.

## Integration with files and versions

The first engine-backed chat links should target defined Phase 0 identities:

- files.
- folders.
- versions.
- history moments.
- agent runs.
- decisions/tasks if they already resolve to stable workspace objects.

Later substrate identities can add links to:

- apps/sites.
- databases/rows.
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
the object that survives and resurfaces. A channel send maps to a
`ThreadMessage` inside exactly one `ChatThread` for that conversation.
`channelId` is a container/context identifier, not the durable thread identity.
Resolving or creating the channel-backed `ChatThread` must be an atomic
get-or-create by `(workspaceId, channelId, channelConversationId)` before the
`ThreadMessage` is written, so concurrent sends cannot create duplicate threads
for the same conversation. There is no separate durable `ChannelMessage` entity
outside the canonical `ChatThread -> ThreadMessage` model.

## Side rail integration

When viewing a file, folder, or version, dohc should show related chats. Later
workspace object types can opt into the same side rail after their stable
identity and ACL contracts exist.

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
- selected chat threads.

Later app/dashboard sharing can be added after those identities are part of the
sharing substrate.

The channel should not grant broad workspace access. Shared channel access must
compose with normal file/folder/version visibility.
Every message, link, projected reference, and free-text mention inside a shared
channel must be re-authorized or redacted against normal workspace policy before
rendering, search, projection, notification materialization, or export. An
external viewer can see only the chat content and work artifacts explicitly
shared with them; non-shared files, atoms, versions, app views, agent runs, and
links remain hidden even if they are mentioned inside an otherwise shared thread.

User-facing preview before sharing:

```text
Share #client-acme with Acme?

They will see:
- #client-acme chats
- docs/acme/proposal.md
- docs/acme/dashboard.md

They will not see:
- private notes
- internal versions
- raw finance data
- secret-backed files
```

This connects dohc Chats directly to the versioned workspace and native
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
3. Users can send fast messages in a channel, and each send creates or resolves
   a durable `ChatThread` and persists a `ThreadMessage`.
4. A burst of messages can become or belong to a durable chat thread without
   introducing a separate canonical channel-stream message model.
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
