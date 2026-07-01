# dohc Chats Design

Status: exploratory architecture direction
Cohort: dohc Think Bigger Workspace Engine
Think Bigger Spec: true
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
all of those paths. Grant revoke/expiry invalidates server-held derived
projections, search snippets, notification caches, export staging artifacts,
non-ledger queued fanout/replay materializations, and other service-owned
derived chat context for that exception so stale shared data does not remain
exposed after access changes. Durable outbox/ledger rows and
audit/history/export records stay immutable as records of fact, but any
emission, replay, consumption, materialization, export bundle, or notification
derived from them must revalidate the current grant and redaction scope before
leaving the service boundary. Thread
activity records are append-only events keyed by
`(workspaceId, threadId, activityId)` or an equivalent workspace/thread scoped
sequence. `activityId` is server-assigned and unique within the
`(workspaceId, threadId)` scope; clients cannot supply or override it, and replay
or dedupe logic must treat the server-issued `activityId`/sequence as the only
authoritative activity identity.
`ThreadLink` create paths accept a request DTO, not a persisted `ThreadLink`
row. Changes are modeled as tombstone plus recreate, never as in-place row
mutation. The server validates the target workspace/resource identity, derives
share/grant id and visibility scope from trusted authorization state, and
populates stored `ThreadLink.shareGrantId`/`visibilityScope` only after that
check. Client-provided `shareGrantId` or `visibilityScope` fields are rejected
before persistence; missing, expired, revoked, forged, mismatched, or ambiguous
server-side grants fail closed before any link or activity record is persisted.

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
  readStateRevision: UInt64DecimalString // server-owned CAS/revision token
  updatedAt: UnixMsDecimalString // server-assigned; client values rejected
}
```

Canonical decimal strings must use ASCII base-10 digits only. Writers and readers
must reject signs, decimal points, separators, whitespace, locale/non-ASCII
digits, empty strings, leading zeros except the literal `0`, and values outside
the declared range. `UInt64DecimalString` is `0` through
`18446744073709551615`. `UnixMsDecimalString` is non-negative Unix epoch
milliseconds. Runtime-specific timestamp bounds, if any, belong in translation
layers, not the shared schema. `ThreadReadState.updatedAt`,
`ThreadMessage.createdAt`, `ThreadMessage.editedAt`, and
`ThreadActivityBase.createdAt` are pinned to server time and must not be
accepted from client payloads. All boundary readers must parse, range-check, and
reserialize to the canonical form before storing, comparing, indexing, or
projecting `threadSequence`, `bodyRevision`, `createdAt`, `editedAt`,
`deletedAt`, `lastActivityAt`, `updatedAt`, `readStateRevision`, or read-state
cursor fields.
Implementations compare them as integer values using a 64-bit/BigInt-safe path,
never as floating-point JavaScript numbers and never with locale string
collation.

The canonical read cursor is sequence-based, not timestamp-based. No row means
nothing in the thread has been read by that actor. Updates are monotonic: read
state can only advance forward in the thread, never move backward. Chats, Inbox,
file side rails, notification badges, and search result read/unread markers must
all derive from this workspace-scoped state. Monotonicity is validated against
the canonical per-thread ordering comparator:
`(threadSequence, createdAt, messageId)`, where `messageId` compares by bytewise
UTF-8 order over the exact persisted ID string. Message IDs are opaque
identifiers: API/storage boundaries validate that the ID is a canonical UTF-8
string encoding for the persisted value, but must never Unicode-normalize,
case-fold, trim, or otherwise treat the ID as human text. Message IDs alone are
not an ordering contract, and `lastReadAt` is not a valid advancement fallback.
`ThreadReadState` is unique on `(workspaceId, threadId, actorId)` and writes are
upserts, not inserts that can duplicate rows. Updating `lastReadCursor` must
compare against the canonical comparator before advancing. For every read-state
write, `actorId` must be derived from authenticated server/engine identity,
never trusted from client payload fields; caller-supplied actor identity is
ignored or rejected before message-existence or ordering checks run. The write
must be atomic: use a conditional upsert, transactional compare-and-swap, or
equivalent CAS semantics that advances `lastReadCursor` only when the incoming
`(threadSequence, createdAt, messageId)` tuple is greater than the stored tuple.
Before CAS evaluation or any tuple-to-message existence lookup, the caller must
be authorized for the target workspace/thread using server-derived identity:
workspace scope, thread visibility, channel/DM membership, and any shared-channel
or shared-grant authorization must pass first. Revoked or expired shared grants
fail closed before `lastReadCursor` comparison or `ThreadMessage` existence
lookup.
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

The causal read-state revision token is `ThreadReadState.readStateRevision`.
It is server-owned, scoped to `(workspaceId, threadId, actorId)`, assigned by
the canonical read-state store, and advanced exactly when the persisted
`lastReadCursor` advances. Idempotent equal-cursor updates return the existing
revision without advancing it. `mark_thread_read` and `update_read_state`
derive their stable idempotency identity from actor, thread, and read cursor.
Callers may pass an expected revision for stale-write detection, but
`readStateRevision` is not part of the dedupe key and callers may never set or
mint the next revision. Equal-cursor retries must dedupe even if the live
revision has changed since the original response.

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

First-class channel contract:

```ts
type ChannelVisibility = 'workspace' | 'private' | 'shared'

type ChannelLinkedTargetScope =
  | { scopeKind: 'internal'; shareGrantId?: never; visibilityScope?: never }
  | { scopeKind: 'shared'; shareGrantId: string; visibilityScope: string }

type ChannelLinkedTargetBase = ChannelLinkedTargetScope & {
  targetWorkspaceId: string
  targetId: string
}

type VersionedChannelLinkedTargetRef =
  | (ChannelLinkedTargetBase & {
      targetType: 'atom' | 'file' | 'folder'
      targetVersionRef: ObjectTargetVersionRef
    })
  | (ChannelLinkedTargetBase & {
      targetType: 'version'
      targetVersionRef: WorkspaceVersionTargetRef
    })
  | (ChannelLinkedTargetBase & {
      targetType: 'history_moment'
      targetVersionRef: HistoryMomentTargetVersionRef
    })

type NonVersionedChannelLinkedTargetRef = ChannelLinkedTargetBase & {
  targetType: 'agent_run' | 'chat_thread' | 'decision' | 'task'
  targetVersionRef?: never
}

type ShareChannelLinkedTargetRef = ChannelLinkedTargetBase & {
  scopeKind: 'shared'
  shareGrantId: string
  visibilityScope: string
  targetType: 'share'
  targetVersionRef?: VersionRef
}

type ChannelLinkedTargetRef =
  | VersionedChannelLinkedTargetRef
  | NonVersionedChannelLinkedTargetRef
  | ShareChannelLinkedTargetRef

type InternalChannelLinkedTargetRef = Extract<ChannelLinkedTargetRef, { scopeKind: 'internal' }>
type SharedChannelLinkedTargetRef = Extract<ChannelLinkedTargetRef, { scopeKind: 'shared' }>

type Channel = {
  channelId: string
  workspaceId: string
  channelSlug: string
  displayName: string
  description?: string
  // `displayName` and `description` are user-authored untrusted text. They must
  // be escaped or sanitized before rendering and handled safely in search/export.
  visibility: ChannelVisibility
  createdById: string
  createdAt: UnixMsDecimalString
  updatedAt: UnixMsDecimalString
  archivedAt?: UnixMsDecimalString
}

type RedactedLinkedWorkProjection = {
  readonly sourceThreadLinkId: string
  scopeKind: 'internal' | 'shared'
  targetWorkspaceId: string
  targetId: string
  targetType: ThreadLinkTargetType
  targetVersionRef?: VersionRef
  shareGrantId?: never
  visibilityScope?: never
}

type RedactedChannelLinkedTargetRef = RedactedLinkedWorkProjection

type ChannelProjection = Channel & {
  // Redacted read-side projection derived from active ThreadLink rows.
  readonly linkedTargets: readonly RedactedChannelLinkedTargetRef[]
}

type ChannelTargetActivity = {
  readonly activityId: string
  workspaceId: string
  channelId: string
  threadId: string
  sourceThreadLinkId: string
  sourceCanonicalThreadLinkKey: CanonicalThreadLinkKey
  sourceThreadLinkState: 'active' | 'tombstoned'
  kind: 'channel_target_linked' | 'channel_target_unlinked'
  linkedTarget: ChannelLinkedTargetRef
  readonly actorId: string
  createdAt: UnixMsDecimalString
}
```

There is one canonical source for linked work: active `ThreadLink` rows where
`deletedAt` is absent. `ThreadLink` is the authority for reads, writes, replay,
retry, authorization, export, search, rebuild, and conflict repair. For channel
threads, `ChannelTargetActivity` is a derived append-only channel aggregation
ledger emitted from `ThreadLink` mutations for a specific `(channelId, threadId)`
pair; it is not an independent write authority.
`ChannelProjection.linkedTargets` and `ChatThreadProjection.linkedWork` are
redacted read-only projections/caches rebuilt from active `ThreadLink` rows
only; neither field is an authoritative mutable record, and neither exposes raw
`shareGrantId` or `visibilityScope`. `ChannelTargetActivity` is derived output
regenerated from the same `ThreadLink` source after repair, not a co-equal input
to the repair loop. If `ThreadLink`, `ChannelTargetActivity`,
`ChannelProjection.linkedTargets`, and `ChatThreadProjection.linkedWork`
disagree, `ThreadLink` wins, the derived ledger/projections are marked stale, and
the engine rebuilds or repairs the ledger and projections from active
`ThreadLink` rows before using them for authorization-sensitive read, replay,
retry, export, search, notification, or side-rail behavior. Full
`ChannelLinkedTargetRef` and `ActiveThreadLink` records remain internal to
authorized mutation, repair, audit, and replay paths; shared rendering, export,
search, and side rails receive only the redacted projection shapes.

The server canonicalizes each `ChannelLinkedTargetRef` to the same stable target
tuple used by channel-target activity and compatible with `ThreadLink` creation,
including `targetWorkspaceId`, `scopeKind`, `shareGrantId`, and
`visibilityScope` where applicable. For
`scopeKind: 'internal'`, `targetWorkspaceId` must equal the channel
`workspaceId` and shared metadata must be absent. For `scopeKind: 'shared'`, the
target must carry a server-derived share grant and visibility scope, and every
read, projection, notification, search, export, replay, and linked-work
side-rail path must re-authorize that grant before exposing the linked target.
The server rejects unsupported, unauthorized, expired, revoked, or ambiguous
targets, deduplicates exact duplicates, and writes only the normalized projection
cache sorted by canonical target serialization after the corresponding
`ThreadLink` mutation and derived `ChannelTargetActivity` repair/output are
durable. General channel context, ACL expansion, side-rail projection, search,
and export use that normalized projection only as a cache over active
`ThreadLink` rows. Array order and duplicates must never
participate in channel identity, thread identity, or conversation-id derivation.

`channelId` is the durable identity. `channelSlug` is a server-normalized lookup
alias that may change on rename, but renames must not change `channelId`, fork
existing `ChatThread` rows, rewrite message history, or invalidate durable
links. Active slugs are unique per workspace; old aliases may redirect or expire
according to product policy, but they are never the durable join key for
threads, notifications, search, projections, export, replay, or history.

Channel ACL and visibility are server-derived from workspace membership,
channel membership, explicit linked targets, and shared-channel grants. Every
channel list/read/write, `ChatThread` resolution, notification, projection,
search, export, and replay path must authorize against the current channel ACL
and then against any linked work target ACL. `visibility: 'shared'` requires an
explicit share grant; internal channel writes cannot silently become external.

Channel creation has two intentional paths:

- `create_channel` creates a new channel with an idempotency key and fails
  closed on active slug collision, missing ACL authority, invalid linked target,
  or ambiguous share grant.
- `get_or_create_channel` is allowed only for server-declared default channels
  or import/migration flows. It resolves by stable workspace policy plus
  normalized slug and returns an existing equivalent channel, or creates one in
  the same serialized unit. If requested metadata, visibility, or linked-target
  policy conflicts with the existing channel, it fails closed instead of
  mutating the channel opportunistically.

The channel creation proof slice owns stable `channelId` assignment,
slug-normalization and collision checks, ACL seed derivation, linked-target
validation, audit metadata, and concurrent create/get-or-create behavior.

A channel can be a general discussion space or can attach to workspace scope:

- folder.
- project through a folder, atom, file, or version target.
- client/entity through an atom or folder target.
- app through a file, folder, atom, or version target.
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
viewed. Broader concepts such as projects, clients, entities, apps, or arbitrary
workspace objects must map to an explicit supported `ThreadLinkTargetType`, or
wait for a new enum value plus registered resolver support.

## DMs and small group chats

dohc needs fast personal conversation.

If dohc only supports channels and durable work threads, it will feel stiff.
Messaging tools are sticky partly because direct conversation is effortless.

Required surfaces:

- one-to-one DMs.
- small group chats.
- quick handoff from a DM into a linked work chat.
- ability to mention an agent in a DM.

```ts
declare function canonicalizeDmParticipantIds(input: {
  serverActorId: string
  requestedParticipantIds: string[]
}): DmParticipantIds
```

`canonicalizeDmParticipantIds` receives the authenticated server-derived actor
separately from the client-supplied participant list. The server first normalizes
`serverActorId` and every requested participant ID to their persisted actor-id
form. Any client-supplied entry equal to the normalized `serverActorId` is
rejected before uniqueness-key generation or persistence; the authenticated actor
is added by the server, not accepted from the request. Raw duplicate requested
participants that normalize to the same persisted actor ID are rejected before
uniqueness-key generation or persistence; implementations must not silently
dedupe participants. The server actor is then merged into the normalized
participant set before uniqueness-key generation, persistence, authorization, or
fanout, so the creator cannot omit or spoof themself. After canonicalization,
`dmParticipantIds` must contain 2-16 unique participants. Oversized canonical
participant lists fail closed before persistence. Larger conversations should
use channels or shared channels. Every service that builds the canonical
participant set uses this same `canonicalizeDmParticipantIds` validation path
before uniqueness-key generation or persistence.

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
  threadId: string
  workspaceId: string
  title?: string
  status: 'open' | 'closed' | 'decided' | 'archived'
  readonly createdById: string // server-owned immutable creator actor id
  readonly createdBy: string // server-owned immutable creator label
  createdAt: UnixMsDecimalString
  lastActivityAt: UnixMsDecimalString // server-managed from canonical activity writes
  pinned: boolean
}

type ChatThreadProjection = ChatThread & {
  readonly linkedWork: readonly RedactedLinkedWorkProjection[]
}

type DmParticipantIds = readonly string[] & {
  readonly __brand: 'DmParticipantIds2To16'
}

type ChannelConversationKind =
  | 'default'
  | 'linked_work'
  | 'named_subconversation'

type ChannelConversationProvenance =
  | {
      conversationKind: 'default'
      linkedWorkTarget?: never
      namedSubconversationKey?: never
      namedSubconversationDisplayLabel?: never
      namedSubconversationLabelRevision?: never
    }
  | {
      conversationKind: 'linked_work'
      linkedWorkTarget: ChannelLinkedTargetRef
      namedSubconversationKey?: never
      namedSubconversationDisplayLabel?: never
      namedSubconversationLabelRevision?: never
    }
  | {
      conversationKind: 'named_subconversation'
      linkedWorkTarget?: never
      namedSubconversationKey: string
      namedSubconversationKeyVersion: string
      namedSubconversationDisplayLabel: string
      namedSubconversationLabelRevision: UInt64DecimalString
    }

type ChannelLinkedTargetRequestHandle =
  | {
      targetWorkspaceId: string
      targetId: string
      targetType: 'atom' | 'file' | 'folder'
      targetVersionRef: ObjectTargetVersionRef
      shareGrantId?: never
      visibilityScope?: never
    }
  | {
      targetWorkspaceId: string
      targetId: string
      targetType: 'version'
      targetVersionRef: WorkspaceVersionTargetRef
      shareGrantId?: never
      visibilityScope?: never
    }
  | {
      targetWorkspaceId: string
      targetId: string
      targetType: 'history_moment'
      targetVersionRef: HistoryMomentTargetVersionRef
      shareGrantId?: never
      visibilityScope?: never
    }
  | {
      targetWorkspaceId: string
      targetId: string
      targetType: 'agent_run' | 'chat_thread' | 'decision' | 'task'
      targetVersionRef?: never
      shareGrantId?: never
      visibilityScope?: never
    }
  | {
      targetWorkspaceId: string
      targetId: string
      targetType: 'share'
      targetVersionRef?: VersionRef
      shareGrantId?: never
      visibilityScope?: never
    }

type ChannelConversationCreateRequest =
  | {
      conversationKind: 'default'
      linkedWorkTarget?: never
      namedSubconversationName?: never
    }
  | {
      conversationKind: 'linked_work'
      linkedWorkTarget: ChannelLinkedTargetRequestHandle
      namedSubconversationName?: never
    }
  | {
      conversationKind: 'named_subconversation'
      linkedWorkTarget?: never
      namedSubconversationName: string
    }

type SendChannelMessageConversationSelector =
  | {
      channelId: string
      channelConversationId: string
      conversation?: never
    }
  | {
      channelId: string
      channelConversationId?: never
      conversation: ChannelConversationCreateRequest
    }

For `linked_work`, public create requests carry only
`ChannelLinkedTargetRequestHandle`, the user-selected target handle. They never
carry server-managed `scopeKind`, `shareGrantId`, or `visibilityScope` values.
The server resolves the handle against the actor, channel, workspace, share, and
target policy, derives the authorized `ChannelLinkedTargetRef`, and stores that
canonical ref on `ChannelConversationProvenance`. If the request cannot resolve
to exactly one authorized internal or shared target, creation fails closed before
deriving `channelConversationId`.

For `named_subconversation`, the server derives `namedSubconversationKey` from
the submitted `namedSubconversationName` in
`ChannelConversationCreateRequest`; persisted `namedSubconversationKey` is
server-owned and is not accepted as create authority. The normalization contract
is: decode as UTF-8, trim leading and trailing Unicode `White_Space`, normalize
to Unicode NFC, apply locale-independent Unicode simple case folding, reject an
empty result, reject ASCII control characters and path-like separators (`/`,
`\`, NUL), and enforce both a 96 Unicode-scalar limit and a 256 UTF-8 byte limit
after normalization. Internal whitespace is preserved exactly after NFC/case
folding; the server does not collapse or rewrite it. The server stores both the
versioned normalized value as `(namedSubconversationKey,
namedSubconversationKeyVersion)` and a durable
`namedSubconversationDisplayLabel` plus
`namedSubconversationLabelRevision: "1"` on `ChannelConversationProvenance`. The
display label is the accepted user-entered label after decode, trim, NFC, and
display-safety validation but before case folding; UI, export, rename, and
history surfaces read that label instead of rendering the normalized key.
Creation retries and identity checks compare against the stored key pair instead
of re-normalizing with the current rules, and retries replay the stored display
label. A later label change must use an explicit rename/history action rather
than a second create request: `rename_channel_conversation_label` validates the
existing `channelConversationId` is a `named_subconversation`, keeps the stored
`(namedSubconversationKey, namedSubconversationKeyVersion)` and
`channelConversationId` unchanged, verifies the caller's expected
`namedSubconversationLabelRevision`, stores the next
`namedSubconversationDisplayLabel` with the next revision, and appends
`NamedSubconversationLabelRenamedThreadActivity` in the same serialized unit. If
the normalizer changes later, migration must create a new versioned value
explicitly rather than silently reinterpreting old keys.

type ChannelChatThread = ChatThreadBase & ChannelConversationProvenance & {
  channelId: string
  channelConversationId: string
  dmParticipantIds?: never
}

type DmChatThread = ChatThreadBase & {
  channelId?: never
  dmParticipantIds: DmParticipantIds
}

type ChatThread = ChannelChatThread | DmChatThread

// ChatThread creation is append-only provenance, not invisible bootstrap state.
// The initial ChatThread row and matching chat_created activity are written in
// the same transaction or serialized unit and become visible together.
// Replay, export, audit, projection rebuilds, and migration/backfill jobs
// reconstruct thread origin from chat_created plus the canonical ChatThread row.
// A thread row without its creation activity is invalid outside explicit repair
// tooling.

type ThreadLinkTargetType =
  | 'atom'
  | 'file'
  | 'folder'
  | 'version'
  | 'history_moment'
  | 'agent_run'
  | 'decision'
  | 'task'
  | 'share'
  | 'chat_thread'

type ThreadLinkScope =
  | { scopeKind: 'internal'; shareGrantId?: never; visibilityScope?: never }
  | { scopeKind: 'shared'; shareGrantId: string; visibilityScope: string }

type ThreadLinkCreateRequestBase = {
  threadId: string
  targetWorkspaceId: string
  targetId: string
  requestedScopeKind: 'internal' | 'shared'
  shareGrantId?: never
  visibilityScope?: never
}

type SharedThreadLinkCreateRequestBase = ThreadLinkCreateRequestBase & {
  requestedScopeKind: 'shared'
}

type ObjectTargetVersionRef = {
  versionRefKind: 'object_version'
  versionId: string
  versionEtag: string
  historyMomentId?: never
}

type WorkspaceVersionTargetRef = {
  versionRefKind: 'workspace_version'
  versionId: string
  versionEtag?: string
  historyMomentId?: never
}

type HistoryMomentTargetVersionRef = {
  versionRefKind: 'history_moment'
  versionId: string
  versionEtag?: string
  historyMomentId: string
}

type VersionRef =
  | ObjectTargetVersionRef
  | WorkspaceVersionTargetRef
  | HistoryMomentTargetVersionRef

type ThreadLinkCreateRequest =
  | (ThreadLinkCreateRequestBase & {
      targetType: 'atom' | 'file' | 'folder'
      targetVersionRef: ObjectTargetVersionRef
    })
  | (SharedThreadLinkCreateRequestBase & {
      targetType: 'atom' | 'file' | 'folder'
      targetVersionRef: ObjectTargetVersionRef
    })
  | (ThreadLinkCreateRequestBase & {
      targetType: 'version'
      targetVersionRef: WorkspaceVersionTargetRef
    })
  | (SharedThreadLinkCreateRequestBase & {
      targetType: 'version'
      targetVersionRef: WorkspaceVersionTargetRef
    })
  | (ThreadLinkCreateRequestBase & {
      targetType: 'history_moment'
      targetVersionRef: HistoryMomentTargetVersionRef
    })
  | (SharedThreadLinkCreateRequestBase & {
      targetType: 'history_moment'
      targetVersionRef: HistoryMomentTargetVersionRef
    })
  | (ThreadLinkCreateRequestBase & {
      targetType: 'agent_run' | 'chat_thread'
      targetVersionRef?: never
    })
  | (SharedThreadLinkCreateRequestBase & {
      targetType: 'agent_run' | 'chat_thread'
      targetVersionRef?: never
    })
  | (SharedThreadLinkCreateRequestBase & {
      targetType: 'share'
      targetVersionRef?: VersionRef
    })
  | (ThreadLinkCreateRequestBase & {
      targetType: 'decision' | 'task'
      targetVersionRef?: never
    })
  | (SharedThreadLinkCreateRequestBase & {
      targetType: 'decision' | 'task'
      targetVersionRef?: never
    })

type ThreadLinkBase = ThreadLinkScope & {
  id: string
  workspaceId: string
  threadId: string
  targetWorkspaceId: string
  targetId: string
  readonly createdById: string // server-owned immutable creator actor id
  createdAt: UnixMsDecimalString
  deletedAt?: UnixMsDecimalString
  readonly deletedById?: string // server-owned immutable remover actor id
}

// Share-link creation is shared-only. A targetType: 'share' request with
// requestedScopeKind: 'internal' fails closed before key derivation, replay,
// projection, export, or fanout. Stored ShareThreadLink rows always carry
// scopeKind: 'shared', server-derived shareGrantId, and server-derived
// visibilityScope.

type VersionedObjectThreadLink =
  | (ThreadLinkBase & {
      targetType: 'atom' | 'file' | 'folder'
      targetVersionRef: ObjectTargetVersionRef
    })
  | (ThreadLinkBase & {
      targetType: 'version'
      targetVersionRef: WorkspaceVersionTargetRef
    })
  | (ThreadLinkBase & {
      targetType: 'history_moment'
      targetVersionRef: HistoryMomentTargetVersionRef
    })

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

type DecisionThreadLink = ThreadLinkBase & {
  targetType: 'decision'
  targetVersionRef?: never
}

type TaskThreadLink = ThreadLinkBase & {
  targetType: 'task'
  targetVersionRef?: never
}

type ThreadLink =
  | VersionedObjectThreadLink
  | AgentRunThreadLink
  | ShareThreadLink
  | ChatThreadThreadLink
  | DecisionThreadLink
  | TaskThreadLink

type ActiveThreadLink = ThreadLink & {
  deletedAt?: never
  deletedById?: never
}

type CanonicalThreadLinkKeyParts = {
  workspaceId: string
  threadId: string
  scopeKind: 'internal' | 'shared'
  targetWorkspaceId: string
  targetType: ThreadLinkTargetType
  targetId: string
  targetVersionRef: VersionRef | null
  shareGrantId: string | null
  visibilityScope: string | null
}

type CanonicalThreadLinkKey = string // thread-link:v1:<lowercase-sha256-hex>
```

For `ChannelChatThread`, `channelId` and `channelConversationId` are immutable
after creation. The active uniqueness key is
`(workspaceId, channelId, channelConversationId)`, with
`channelConversationId: "default"` for the default channel stream conversation.
The persisted thread row also stores the canonical conversation provenance:
`conversationKind` plus the selected `linkedWorkTarget` for `linked_work`, the
server-normalized `(namedSubconversationKey, namedSubconversationKeyVersion)`
pair for `named_subconversation`, or neither field for `default`. Reads, replay,
export, search, idempotent retries, and migration jobs must use that stored
provenance instead of reverse-engineering intent from `channelConversationId`.
Non-default `channelConversationId` values must be server-issued and
deterministic from one canonical channel-conversation context tuple; clients must
not invent them. That tuple includes `workspaceId`, `channelId`,
`conversationKind` (`default`, `linked_work`, or `named_subconversation`), and
the kind-specific immutable discriminator: exactly one canonical linked-work
target tuple for `linked_work`, normalized server-owned conversation key for
`named_subconversation`, or no extra discriminator for `default`. The same tuple
must reuse the existing id through atomic get-or-create; a materially different
tuple gets a new deterministic id and therefore a different thread. Ordinary
`ThreadLink` rows added or removed after thread creation are separate linked-work
metadata and never mutate the `channelConversationId`. Changing the channel
association, conversation kind, linked-work discriminator that defined a
`linked_work` conversation, or named-subconversation key requires tombstoning or
archiving the old thread and creating a new one. Channel renames, moves, topic
changes, ordering changes, and other channel metadata updates preserve
`channelConversationId`. Multi-target channel context from
`ChannelProjection.linkedTargets` does not derive a `linked_work` conversation id
from array order; a linked-work conversation chooses one normalized target
discriminator, while broader multi-target discussion uses the default
conversation or a server-owned `named_subconversation` key.
For `linked_work`, the request must include a
`ChannelLinkedTargetRequestHandle` that the server resolves into exactly one
authorized `ChannelLinkedTargetRef`. If the channel has multiple active linked
targets and the request does not select exactly one canonical target,
get-or-create must fail closed as ambiguous instead of picking from
`ChannelProjection.linkedTargets` order. The selected server-resolved target is
the sole linked-work discriminator for `channelConversationId` generation,
replay, export, search, and subsequent thread reads.
`send_channel_message` accepts a `SendChannelMessageConversationSelector` with
the target `channelId`: either an existing server-issued
`channelConversationId`, or a `ChannelConversationCreateRequest` whose
`named_subconversation` branch carries the raw `namedSubconversationName` used to
derive the stored `(namedSubconversationKey,
namedSubconversationKeyVersion)` pair. Callers obtain the server-issued
`channelConversationId` from the `send_channel_message` create/read response or
from `read_channel_conversation` for the same canonical context tuple. Clients
and agents should persist and reuse that returned `channelConversationId` with
the `threadId` for subsequent sends or reads; if they lose it, they must
re-resolve it through `read_channel_conversation` rather than reconstructing the
id locally.

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
For a `ChannelChatThread`, the same transaction or serialized unit must also run
`channel-target-ledger-sync`: normalize the changed `ThreadLink` target into a
`ChannelLinkedTargetRef`, append the matching `ChannelTargetActivity`
(`channel_target_linked` or `channel_target_unlinked`) for the thread's
`channelId` and `threadId`, carrying the originating `sourceThreadLinkId`,
`sourceCanonicalThreadLinkKey`, and `sourceThreadLinkState`, and enqueue the same
durable outbox identity used for side rails, search, export, replay, and
projection invalidation. `activityId` and `actorId` are server-owned fields; the
client never supplies them. DM threads do not emit `ChannelTargetActivity`. The
sync step is a derived repair/output contract: direct writes to `ChannelTargetActivity`,
`ChannelProjection.linkedTargets`, or `ChatThreadProjection.linkedWork` must
never create, remove, authorize, or tombstone linked work. If a retry observes an
already-active or tombstoned `ThreadLink`, it must verify the matching
`ChannelTargetActivity` for the thread's `(channelId, threadId)` pair, exact
`sourceThreadLinkId`, exact `sourceCanonicalThreadLinkKey`, normalized
`linkedTarget`, and current source state (`active` for an active link,
`tombstoned` for a removed link) before reporting the idempotent result. If the
ledger entry is missing, stale, points at another `ThreadLink`, or represents the
wrong active/tombstoned state, the retry must repair it in the same transaction
or serialized unit through `channel-target-ledger-sync`, then return success only
after the `ThreadLink` and channel-target ledger entry are both durable.
Active link creation is idempotent by `CanonicalThreadLinkKey`. The key is
derived from `(workspaceId, threadId, scopeKind, targetWorkspaceId, targetType,
targetId, targetVersionRef, shareGrantId, visibilityScope)` after canonical
normalization:

- Build `CanonicalThreadLinkKeyParts` with `null` for absent
  `targetVersionRef`, `shareGrantId`, or `visibilityScope`; do not use reserved
  sentinel strings or prefix-concatenated fields.
- `decision` and `task` links are stable workspace-object links and must always
  canonicalize `targetVersionRef` to `null`; create requests that include a
  `targetVersionRef` for those target types fail closed before key derivation.
- Encode the parts as a framed tuple in fixed field order:
  `[["workspaceId", value], ["threadId", value], ["scopeKind", value],
  ["targetWorkspaceId", value], ["targetType", value], ["targetId", value],
  ["targetVersionRef", versionRefTupleOrNull], ["shareGrantId", valueOrNull],
  ["visibilityScope", valueOrNull]]`.
- Serialize that tuple with canonical JSON: UTF-8, no insignificant whitespace,
  nested `VersionRef` tuples encoded in the fixed field order defined below, and
  numbers represented only as canonical decimal strings.
- The stored key is `thread-link:v1:<lowercase-sha256-hex>` over those exact
  bytes.

The store enforces active-link uniqueness with a workspace-scoped partial unique
index, compare-and-swap reservation, or equivalent serializable constraint on
`(workspaceId, CanonicalThreadLinkKey)` where `deletedAt` is absent. The helper
is not the authority: bypassed helpers, retries, replays, and concurrent writers
must still hit the storage constraint before `link_added` fanout or projection
updates. If the storage engine cannot express a partial unique index directly,
it must use an active-link reservation row keyed by
`(workspaceId, CanonicalThreadLinkKey)` and reserve it in the same transaction or
serialized unit of work as the `ThreadLink` mutation. Tombstoning a link must
release or supersede that active reservation in the same transaction that sets
`deletedAt`, while preserving the historical tombstone record. A uniqueness
conflict is resolved only after re-running the same workspace, thread
membership, target visibility, share-grant, and link-policy authorization checks
used by link creation. If those checks still pass, the engine may read the
existing active `ThreadLink`, verify or repair the matching channel-target ledger
entry when the thread is channel-backed, return the idempotent result, and skip
duplicate `link_added`/projection fanout. If any check fails, the retry fails
closed as an authorization or visibility denial without revealing whether an
active link still exists.
A retry for the same normalized key must re-run those checks before any
read/upsert/no-op against the existing active `ThreadLink`, and must not create
a second active link or duplicate `link_added` fanout.
`ChatThreadProjection.linkedWork`, projections, search, and export all build
from one active canonical link per normalized uniqueness key and must use the
same `canonicalThreadLinkKey(parts)` helper as link creation and `ThreadLink`
upserts. Channel-level linked-target rebuilds must start from the same active
`ThreadLink` set, replay or repair `ChannelTargetActivity` as derived output, and
then regenerate `ChannelProjection.linkedTargets`; they must not use a stale
channel target ledger as the source of truth over `ThreadLink`.
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
Cycle checks traverse only canonical active `ThreadLink` records where
`deletedAt` is absent, inside the same graph lock, CAS, serialized transaction,
or equivalent single-writer critical section used for the link mutation.
`ChatThreadProjection.linkedWork` is never authoritative for cycle validation
unless it has been rebuilt and locked against that same canonical set before the
check. Tombstoned historical links are retained for audit and replay but do not
participate in cycle detection or block a future relink.
`ThreadLink` target fields, `shareGrantId`, and `visibilityScope` are immutable
after creation. Changing a link means tombstoning the old link with
`link_removed` activity and creating a new link with `link_added` activity; there
is no in-place link update path for replay/export to miss.
Target types resolve through a server-side resolver registry keyed by
`(scopeKind, ThreadLinkTargetType)`, or through an entrypoint that consumes the
full `CanonicalThreadLinkKeyParts` tuple. Unknown or unregistered scope/type
pairs fail closed before link creation, resolution, search projection, export,
notification fanout, or UI rendering. Each resolver enforces workspace scope,
target ACLs, and shared-grant/redaction policy for its scope. The `decision` and
`task` resolvers must resolve stable workspace-scoped decision/task object IDs,
require `targetVersionRef: null` in the normalized canonical key, enforce the
target object's effective policy and visibility, and apply the same
shared-grant/redaction checks as file or atom links before link creation,
projection, export, notification, or replay. Adding any other target kind
requires extending the enum, registering internal and shared resolver behavior
where applicable, and adding authorization, projection, export, and replay tests
for that kind.
`chat_thread` links must be acyclic. A thread cannot link to itself, and link
creation must reject any target that would introduce a cycle in the
`chat_thread`-to-`chat_thread` graph under a graph lock, CAS, serialized
transaction, or equivalent single-writer critical section. Non-chat targets such
as `file`, `version`, `decision`, and `task` are excluded from the traversal and
rejection logic. The cycle check must run before `link_added` is recorded and
before linked-work projection, search, notification, or export fanout runs.

Thread create/update paths must ignore or reject client-provided
`lastActivityAt`. The server updates `ChatThreadBase.lastActivityAt` only from
canonical `ThreadActivity` writes, using the same ordering source that drives
thread activity feeds and read-state updates.
Chat provenance fields are server-owned and immutable. `createdBy`,
`createdById`, `authorId`, and `actorId` are derived from authenticated
server/engine identity at write time, never accepted from browser/client
payloads, and cannot be changed by edit, replay, import, or projection paths
except through an explicit trusted migration that preserves original provenance
evidence. `ChatThreadBase.createdById` is the audit/replay identity;
`ChatThreadBase.createdBy` is a presentation label only and must not be used for
authorization, replay, export identity, or dedupe.

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
normalize actor IDs to their canonical persisted form, reject the request if two
raw entries map to the same canonical actor, then sort by bytewise ascending
UTF-8 encoding of the canonical ID, not locale collation and not runtime-native
UTF-16 code-unit order. All services must use this reject-duplicates policy and
comparator before key generation. The XOR ownership rule is enforced after
canonicalization. For DM-backed thread
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
participant set and appends a deterministic `dm_thread_relinked` activity on the
prior thread, rather than mutating `dmParticipantIds` in place. `read_chat`,
`reply_to_chat`, reactions,
`edit_chat_message`, `delete_chat_message`, notifications, and read-state
updates continue to authorize against the canonical participant set of the
specific thread being accessed, so membership changes cannot silently merge,
split, or reassign thread history.
The `dm_thread_relinked` activity is appended only on the prior thread, with
`ThreadActivityBase.threadId` equal to `previousThreadId`; the new thread records
its own `chat_created` activity. The relink activity is idempotent by
`(workspaceId, previousThreadId, nextThreadId, nextDmParticipantIds)` after the
same canonical participant sorting used for DM creation. Replay, export,
migration, and retained-history reads use `dm_thread_relinked` to show continuity
between the old and new threads, but they must not treat it as permission to
mutate either thread's immutable `dmParticipantIds`.

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
  id: string // server-issued; unique within (workspaceId, threadId)
  workspaceId: string
  threadId: string
  threadSequence: UInt64DecimalString
  parentMessageId?: string
  readonly authorId: string // server-owned immutable author actor id
  readonly authorKind: 'human' | 'agent' | 'system' // server-assigned from authenticated identity
  body: string
  bodyRevision: UInt64DecimalString
  createdAt: UnixMsDecimalString // server-assigned; client values rejected
  editedAt?: UnixMsDecimalString // server-assigned; client values rejected
  readonly editedById?: string // server-assigned immutable edit actor id
  // Derived cache from the canonical message_deleted activity.
  deletedAt?: UnixMsDecimalString
  readonly deletedById?: string // server-assigned immutable delete actor id
  deleteReason?: string
  tombstone?: boolean
}
```

`ThreadMessage.id` is assigned by the server and unique within
`(workspaceId, threadId)`. Message create retries must reuse the same
server-assigned id through the idempotency result, or be rejected as
`replay_metadata_mismatch`, so ordering tie-breakers and read cursors can rely on
a stable unique message identifier.
The create path must reserve or replay the idempotency result and server-assigned
`ThreadMessage.id` before validating `parentMessageId`. That resolved id is then
used for self-parent rejection and ancestry cycle detection. The reservation is
not a visible message row: if parent validation, authorization, or commit fails,
the message body/activity/projection is not exposed, and retries must reuse the
same reserved id or return the recorded deterministic failure.
If `parentMessageId` is present, authorization for that parent message in the
same workspace/thread must be checked before any existence lookup or hidden-row
distinction is exposed. After authorization, the parent must reference an
existing accessible message in the same workspace and `threadId`, must not equal
the message's own `id`, and must not introduce a cycle in the ancestry chain.
`ThreadMessage.workspaceId` must match `ChatThread.workspaceId` wherever messages
are written, read, indexed, notified, or projected. Message create/update paths
must reject client-supplied `id`, `authorId`, `authorKind`, `editedById`, or
`deletedById` values; those fields are server-assigned from authenticated
activity identity only, never from browser-provided user identity. Rendering
nested replies, indexing, notification fanout, and projection generation recheck
the same invariant as downstream safeguards only.
`parentMessageId` is immutable after `message_created`. Generic message update
flows must reject any attempt to change it. If dohc later supports reparenting,
that must be a dedicated `ThreadActivity` with replay/projection rules that
consume the reparent event consistently with `message_created`; it cannot be a
silent row mutation.
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
be exposed without the corresponding row. `MessageCreateThreadActivity` stores
the created row's immutable `parentMessageId`, canonical `threadSequence`, and
initial `bodyRevision` so replay/export consumers can reconstruct reply topology,
deterministic ordering, and body identity without inferring them from timestamps.

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
Authorized legal erasure is the exception to original-body and user-authored
delete-reason retention: when a GDPR/CCPA or equivalent request is approved
through policy, the engine may cryptographically purge, destroy keys for, or
irreversibly redact the original body and any user-authored `deleteReason` while
preserving `deletedAt`, `tombstone`, deletion-placeholder rendering, minimal
audit metadata, and the original persisted-body `bodyHash`. `bodyHash` is
retained separately from the plaintext or encrypted body payload as
non-renderable verification metadata, so replay/export/audit jobs can still
prove which canonical body revision was deleted after the body itself is purged.
Secret-backed references, encrypted payloads, safe placeholders, or redacted
forms replace plaintext body and delete-reason text wherever audit/history,
tombstone, search, export, notification, or agent-log access would otherwise
have retained those values.

`message_edited` is valid only for non-deleted `ThreadMessage` rows. Once
`deletedAt` is present or `tombstone` is true, tombstone state is terminal for
the edit path: edit attempts must fail closed before commit, with no new
`ThreadActivity`, body revision, current-body mutation, projection update, search
update, notification update, or summary update. Restoring a deleted message, if
allowed by policy, requires a dedicated restore activity that preserves the
delete/edit audit trail instead of rewriting the tombstone in place.
A restore clears the derived `ThreadMessage.deletedAt`, `deletedById`,
`deleteReason`, and `tombstone` cache fields only in the same atomic unit that
appends the restore activity, writes the restored body revision, and rebuilds
authorized projections/search/notifications/summaries from the restored body.

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
  readonly activityId: string // server-assigned unique activity id within workspace/thread
  workspaceId: string
  threadId: string
  readonly actorId: string // server-owned immutable activity actor id
  readonly actorKind: 'human' | 'agent' | 'system'
  createdAt: UnixMsDecimalString // server-assigned; client values rejected
}

type SendChannelMessageThreadCreatedActivity = ThreadActivityBase & ChannelConversationProvenance & {
  kind: 'chat_created'
  threadKind: 'channel'
  title?: string
  channelId: string
  channelConversationId: string
  dmParticipantIds?: never
}

type CreateChatDmThreadCreatedActivity = ThreadActivityBase & {
  kind: 'chat_created'
  threadKind: 'dm'
  title?: string
  channelId?: never
  channelConversationId?: never
  dmParticipantIds: DmParticipantIds
}

type ThreadCreatedActivity =
  // create_chat emits only CreateChatDmThreadCreatedActivity. Channel-backed
  // threads are created only by send_channel_message, which emits
  // SendChannelMessageThreadCreatedActivity in the same atomic unit as the first
  // message.
  | SendChannelMessageThreadCreatedActivity
  | CreateChatDmThreadCreatedActivity

type DmThreadRelinkedThreadActivity = ThreadActivityBase & {
  kind: 'dm_thread_relinked'
  threadKind: 'dm'
  previousThreadId: string
  nextThreadId: string
  previousDmParticipantIds: DmParticipantIds
  nextDmParticipantIds: DmParticipantIds
  relinkReason: 'membership_changed' | 'membership_revoked'
}

type MessageCreateThreadActivity = ThreadActivityBase & {
  messageId: string
  parentMessageId?: string
  kind: 'message_created'
  threadSequence: UInt64DecimalString
  bodyRevision: UInt64DecimalString
  bodyHash: string
  nextBodyHash: string
}

type NamedSubconversationLabelRenamedThreadActivity = ThreadActivityBase & {
  kind: 'named_subconversation_label_renamed'
  channelId: string
  channelConversationId: string
  namedSubconversationKey: string
  namedSubconversationKeyVersion: string
  previousNamedSubconversationLabelRevision: UInt64DecimalString
  nextNamedSubconversationLabelRevision: UInt64DecimalString
  previousNamedSubconversationDisplayLabel: string
  nextNamedSubconversationDisplayLabel: string
}

type MessageEditThreadActivity = ThreadActivityBase & {
  messageId: string
  kind: 'message_edited'
  previousBody: ChatBodySnapshot
  previousBodyRevision: UInt64DecimalString
  nextBodyRevision: UInt64DecimalString
  bodyHash: string
  nextBodyHash: string
}

type MessageDeleteThreadActivity = ThreadActivityBase & {
  messageId: string
  kind: 'message_deleted'
  previousBody: ChatBodySnapshot
  previousBodyRevision: UInt64DecimalString
  deleteReason?: string
  bodyHash: string
  tombstoneHash: string
}

type MessageDeleteLegacyThreadActivity = ThreadActivityBase & {
  messageId: string
  kind: 'message_deleted_legacy'
  legacyImportId: string
  previousBody?: ChatBodySnapshot
  deleteReason?: string
  bodyHash: string
  tombstoneHash: string
  legacyHashSource: 'imported_body' | 'redacted_fallback'
}

type MessageRestoreThreadActivity = ThreadActivityBase & {
  messageId: string
  kind: 'message_restored'
  restoredBody: ChatBodySnapshot
  restoredBodyRevision: UInt64DecimalString
  restoreReason?: string
  bodyHash: string
  nextBodyHash: string
}

`nextBodyHash`, `bodyHash`, and `tombstoneHash` are lowercase hex keyed digests
over a canonical JSON payload, using a server-held chat history hash/MAC key
that is not exported with ordinary workspace data. Plain deterministic SHA-256
over message content is not allowed for deleted-body evidence because purged or
redacted bodies would be dictionary-attackable. The canonical payload uses
sorted object keys, no insignificant whitespace, and only user-authored text
fields normalized to Unicode NFC before UTF-8 encoding. Opaque IDs such as
`workspaceId`, `threadId`, and `messageId` are digested byte-for-byte from their
canonical stored form. `nextBodyHash` digests
`["chat-body:v1", workspaceId, threadId, messageId, bodyRevision,
nextBodySnapshot]`, where `nextBodySnapshot` is the canonical current
`ChatBodySnapshot` after create/edit/restore. `bodyHash` uses the same
`chat-body:v1` payload for the referenced persisted body revision.
`tombstoneHash` digests
`["chat-tombstone:v1", workspaceId, threadId, messageId, previousBodyRevision,
previousBodyHash, deleteReasonOrNull]`, where `previousBodyHash` is the
canonical `bodyHash` of the deleted body revision. `previousBody` may be retained
as plaintext, encrypted, secret-backed, or redacted audit material according to
policy, but tombstone verification depends on `previousBodyHash`, not on
re-reading the body payload. Replay, export, and audit jobs verify deletion
evidence only through the authorized keyed-digest service or a non-exported
verification capability; export bundles must not include the raw MAC key.
`deleteReason` is preserved user/agent text and must follow the same text-safety
rules as message bodies and thread titles: escape by default, sanitize only
through the allowlisted formatting subset, and redact or omit where the viewer
lacks access. History, export, projection, search snippet, and notification
surfaces must not render raw `deleteReason` text.
Message create, edit, restore, and delete lifecycle activities must populate `bodyHash`
from this same canonical persisted-body hash used by
`MentionNotificationThreadActivity`. For create/edit/restore, `bodyHash` is the
persisted resulting body revision and must match `nextBodyHash`; for delete,
`bodyHash` is the previous persisted body revision preserved by the delete
activity and is retained as non-renderable verification metadata even when legal
erasure purges or redacts the original body payload. Replay, export, mention
fanout, and history rebuilds must verify this hash before deriving notifications
or visible projections.
`MentionNotificationThreadActivity.bodyHash` always verifies the persisted body
revision that produced the mention notification. Create/edit mention fanout uses
the resulting body revision after the create/edit; delete or tombstone replay
uses the delete-specific preserved previous body hash plus `tombstoneHash` and
must not reinterpret the deletion placeholder as a new resulting message body.

type ReactionIdentity =
  | { reactionId: string; reactionKey?: never; reactionActorId?: never }
  | { reactionId?: never; reactionKey: string; reactionActorId?: never }

`reactionKey` is a canonical, case-sensitive Unicode scalar string after NFC
normalization with leading/trailing ASCII whitespace rejected before persistence.
Allowed keys are either one Unicode 15.1.0 extended grapheme cluster that is an
RGI emoji sequence under Unicode Emoji 15.1 data, or a namespaced custom key
matching `custom:[a-z0-9][a-z0-9_.-]{0,63}`. The emoji `reactionKey` check uses
Unicode Standard Annex #29 extended grapheme cluster segmentation for Unicode
15.1.0 plus checked-in Unicode Emoji 15.1 RGI tables; producers, replay, export,
and import readers must reject keys requiring newer tables until a recorded
schema/data migration upgrades the accepted version. They must validate and
store exactly that canonical `reactionKey` form; they must not case-fold, alias,
trim, or locale-normalize reaction keys.

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
    targetVersionRef: VersionRef | null
  }
}

`LinkThreadActivity.linkTarget.targetVersionRef` uses the same canonical
`VersionRef | null` representation as `CanonicalThreadLinkKeyParts`: object key
order is `versionRefKind`, `versionId`, `versionEtag`, then `historyMomentId`;
optional absent fields are omitted inside the object, and missing version refs
are serialized as `null`, never omitted. `decision` and `task` link activities
must store `targetVersionRef: null` for the same stable-object target tuple used
by link creation and resolver lookup. Link activity writers, replay, export, and
projection rebuilds must read and write that canonical form so the activity
payload and canonical link key produce the same normalized target tuple.

type MentionNotificationThreadActivityBase = ThreadActivityBase & {
  messageId: string
  bodyRevision: UInt64DecimalString
  authzScopeId: string
  mentionedActorIds: string[]
  notificationId: string
  bodyHash: string
}

type MentionNotificationEnqueuedThreadActivity =
  MentionNotificationThreadActivityBase & {
    kind: 'mention_notification_enqueued'
    notificationStatus: 'queued' | 'sent' | 'suppressed'
  }

type MentionNotificationResolvedThreadActivity =
  MentionNotificationThreadActivityBase & {
    kind: 'mention_notification_resolved'
    notificationStatus: 'resolved'
  }

type MentionNotificationThreadActivity =
  | MentionNotificationEnqueuedThreadActivity
  | MentionNotificationResolvedThreadActivity

`MentionNotificationThreadActivity.mentionedActorIds` must be canonical before
storage: normalize each actor ID to its persisted form, deduplicate by exact
canonical ID match, then sort by bytewise ascending UTF-8 encoding. Enqueue,
resolve, replay, export, and notification fanout paths all use that canonical
array so duplicate mentions or runtime-specific ordering cannot create duplicate
notifications or unstable history.
`notificationStatus` is required on every mention notification activity.
`mention_notification_enqueued` uses `queued`, `sent`, or `suppressed`;
`mention_notification_resolved` uses `resolved`. Replay, export, and fanout must
not infer lifecycle state from activity kind alone.
`ThreadActivityBase.activityId` is the append-only identity for each lifecycle
event. `notificationId` identifies the underlying mention notification aggregate,
not the activity row. Resolving a notification appends a distinct
`mention_notification_resolved` activity with its own `activityId` and the same
`notificationId`; it must not mutate, overwrite, or dedupe against the earlier
`mention_notification_enqueued` activity by `notificationId` alone.
`authzScopeId` is the exact server-issued authorization/redaction context for
the mention notification projection. It must be derived server-side from the
same grant/scope resolver used by shared chat and linked-work projections, and
client-supplied scope ids are ignored or rejected before enqueue. Scope changes
may update projection/fanout context, but they must not create a new immutable
notification identity for the same message revision and mentioned actor set.
`notificationId` is deterministic for a mention notification lifecycle:
`mention:<workspaceId>:<threadId>:<messageId>:<bodyRevision>:<sha256(canonicalMentionedActorIdsJson)>`.
Each non-hash component is UTF-8 percent-encoded with RFC 3986 unreserved
characters left literal (`A-Z a-z 0-9 - . _ ~`) and all other bytes encoded as
uppercase `%HH`, then joined with literal `:` separators. `bodyRevision` is the
canonical `UInt64DecimalString`. `canonicalMentionedActorIdsJson` is the UTF-8
JSON array of the canonical, deduplicated, bytewise-sorted actor ID strings with
no extra whitespace. The hash is lowercase hex SHA-256 over those exact UTF-8
JSON bytes and is always 64 ASCII hex characters.
`bodyHash` is required audit evidence for the immutable persisted body revision,
but it is not part of `notificationId` so redaction/sanitization views cannot
change the notification identity.
The enqueue path must upsert or no-op by that expanded `notificationId` for the
notification aggregate. Resolve uses the same `notificationId` to find/update
aggregate queue state, but activity dedupe is scoped to the lifecycle event:
`(notificationId, kind)` plus the mutation idempotency identity, or the
server-assigned `activityId`. A `mention_notification_resolved` write must not
be suppressed by an existing `mention_notification_enqueued` activity with the
same `notificationId`; it appends its own resolved activity once and then
retries return that resolved result or a deterministic no-op. Repeated enqueue or
resolve attempts for the same message revision and canonical mention set must
not append duplicate activities, duplicate queue rows, unstable unread/mention
badges, duplicate notifications, or duplicate export/history records.

type ThreadActivity =
  | ThreadCreatedActivity
  | DmThreadRelinkedThreadActivity
  | MessageCreateThreadActivity
  | NamedSubconversationLabelRenamedThreadActivity
  | MessageEditThreadActivity
  | MessageDeleteThreadActivity
  | MessageDeleteLegacyThreadActivity
  | MessageRestoreThreadActivity
  | ReactionThreadActivity
  | LinkThreadActivity
  | MentionNotificationThreadActivity
```

For `message_created`, `message_edited`, `message_deleted`, `message_restored`,
`reaction_added`, and `reaction_removed`, `messageId`, `actorId`, `actorKind`,
and `createdAt` are required. For `message_created`, `parentMessageId` is the
immutable reply parent captured from `ThreadMessage.parentMessageId` when present.
For `named_subconversation_label_renamed`, previous/next display labels,
previous/next label revisions, `channelConversationId`, and the stored
named-subconversation key pair are required. For `message_edited`, `previousBody`
`previousBodyRevision`, and `nextBodyRevision` are also required so
replay/export can reconstruct the post-edit revision without reading mutable row
state. For in-system `message_deleted` events,
`previousBody` and `previousBodyRevision` are required and must preserve the
deleted body as plaintext, redacted, or secret-backed snapshot according to
policy. `message_restored` must create a new current body revision from
`restoredBody`, preserve the earlier delete/edit activities for replay/export,
and atomically repair the `ThreadMessage` cache plus projections/search from the
new body. Legacy import flows that cannot recover a prior body revision must map to
`message_deleted_legacy`, which renders as a tombstone, preserves
`legacyImportId`, `deleteReason`, and any available redacted/secret-backed body
snapshot, and is handled explicitly by history/export/replay as incomplete legacy
evidence rather than a normal in-system delete. Legacy delete activities are
exempt from the in-system requirement to hash a recovered prior plaintext body,
but they must still carry `bodyHash` and `tombstoneHash`: use the imported body
when available, otherwise hash a deterministic redacted fallback and set
`legacyHashSource: 'redacted_fallback'` so export/replay can distinguish the
evidence quality. Reaction events must satisfy
exactly one identity mode: either a
stable `reactionId`, or the complete deterministic tuple `(workspaceId,
threadId, messageId, actorId, reactionKey)`. `ThreadActivityBase.actorId` is the
authoritative reaction actor identity for authorization, replay, export,
notification fanout, and idempotency.
`ReactionIdentity` must not introduce a second reaction actor field; legacy
imports that contain a mismatched reaction actor must normalize to the event
`actorId` or fail closed before replay.
Reaction writes are idempotent by the chosen identity mode. A stable
`reactionId` dedupes by that id; tuple mode treats `(workspaceId, threadId,
messageId, actorId, reactionKey)` as one idempotent key. Repeated `reaction_added` or
`reaction_removed` writes for the same key must return the existing result or a
deterministic no-op and must not create duplicate activity, reactions,
notifications, export entries, or replay effects.
The tuple uses the canonical `reactionKey` form defined above; non-canonical
reaction keys are rejected before idempotency reservation so different runtimes
cannot dedupe the same visible reaction differently.
Authorized history and export paths reconstruct the revision trail from these
events. Normal chat rendering, search, notifications, projections, and summaries
use the current `ThreadMessage.body` unless policy explicitly materializes
historical revisions. Legal erasure may replace `previousBody` with a redacted
snapshot while retaining edit provenance, the original `bodyHash`, and any
`tombstoneHash` derived from that body hash.
For `link_added` and `link_removed`, `linkId` and `linkTarget` are required so
audit/replay can identify the exact affected link even after the derived
`linkedWork` cache is rebuilt. Reaction add/remove replay affects one exact
reaction through the `ReactionIdentity` XOR above.
`ThreadLink.deletedById` is populated only from the server-owned actor on the
canonical `link_removed` activity written in the same atomic unit as the
tombstone; client-supplied remover identity is ignored or rejected and must never
override the persisted link deletion actor.
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
read_channel_conversation
rename_channel_conversation_label
create_chat
send_channel_message
reply_to_chat
link_chat_to_work
summarize_chat
```

Every chat action must derive actor identity server-side or engine-side and
enforce workspace scope on every entity and result:

- `list_chats`
- `list_channels`
- `read_chat`
- `read_channel_conversation`
- `rename_channel_conversation_label`
- `create_chat`
- `send_channel_message`
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

`read_channel_conversation` accepts a target `channelId` plus either an existing
server-issued `channelConversationId` or a `ChannelConversationCreateRequest`.
It runs the same canonical conversation resolver as `send_channel_message` and
returns the existing `threadId`, `channelConversationId`, and
`ChannelConversationProvenance` for that authorized channel thread. If no
channel-backed thread exists for the canonical tuple, it returns
`needs_first_send`/`not_found` and must not create or reserve a `ChatThread`,
emit `chat_created`, or reserve a message id. Clients and agents use this action
to recover a lost `channelConversationId` together with its `threadId`; they must
not reconstruct channel conversation ids locally.

Chat mutation handlers are idempotent by stable request identifiers and
server-assigned target identifiers:

- `create_chat` requires an `idempotencyKey`; it creates DM threads only, emits
  the `threadKind: 'dm'` `chat_created` activity, assigns `threadId` in the
  idempotency result, and retries return that same `threadId`. Its request body
  supplies `requestedParticipantIds: string[]`, excluding the authenticated
  actor. Before thread creation, the server calls
  `canonicalizeDmParticipantIds({ serverActorId, requestedParticipantIds })`;
  the result must satisfy the canonical 2-16 unique participant invariant and is
  the exact `dmParticipantIds` persisted on the `DmChatThread`, activity,
  uniqueness key, read-state fanout, and authorization checks. Invalid,
  duplicate, oversized, or self-including participant inputs fail before any
  thread row, activity, idempotency tombstone, or notification is allocated.
  Channel-backed threads must not be created through `create_chat`.
- `send_channel_message` requires an `idempotencyKey` and a
  `SendChannelMessageConversationSelector`; the server applies the same canonical
  conversation resolution rules as `read_channel_conversation`, then atomically
  resolves or creates the channel-backed `ChatThread` by
  `(workspaceId, channelId, channelConversationId)` and persists the
  `ThreadMessage`, its canonical `message_created` `ThreadActivity`, and the
  `threadKind: 'channel'` `chat_created` activity when this is the first send for
  that tuple in the same serialized unit. The `chat_created` and first
  `message_created` activities are exactly-once for that winning first-send
  mutation: only the writer that wins the unique `ChatThread` reservation for
  `(workspaceId, channelId, channelConversationId)` may emit the creation
  provenance, and retries or concurrent first sends that observe an existing
  `ChatThread` must not duplicate `chat_created` or the winning message's
  `message_created` activity. The idempotency result returns `threadId`,
  `channelConversationId`, and `messageId`, and retries return the same triple.
- `reply_to_chat` requires an `idempotencyKey`; the server assigns `messageId`
  in the idempotency result, and retries return that same `messageId`.
- `rename_channel_conversation_label` requires an `idempotencyKey`, `channelId`,
  server-issued `channelConversationId`, expected conversation/display-label
  revision, and the next user-entered label. It applies only to an existing
  `named_subconversation` thread the actor can administer, derives the next
  display label with the same display-safety validation used by creation, keeps
  `namedSubconversationKey`, `namedSubconversationKeyVersion`, and
  `channelConversationId` unchanged, verifies the expected
  `namedSubconversationLabelRevision` before mutation, advances that revision by
  exactly one, and appends `NamedSubconversationLabelRenamedThreadActivity` with
  previous/next labels and revisions in the same serialized unit. Retries replay
  the same activity, revision, and display label; callers must not recreate the
  conversation to rename it.
- `edit_chat_message` requires an `idempotencyKey`, `messageId`, and expected
  `bodyRevision`.
- `delete_chat_message` requires an `idempotencyKey`, `messageId`, and expected
  `bodyRevision`.
- `add_reaction` and `remove_reaction` require an `idempotencyKey`, `messageId`,
  and reaction key; idempotency and lookup are keyed only by the stable reaction
  identity `(workspaceId, threadId, messageId, actorId, reactionKey)` or the
  stable `reactionId`, not by the message body revision, reaction-set revision,
  or any equivalent edit state.
- `mark_thread_read` and `update_read_state` require an `idempotencyKey` or a
  server-derived stable read-state idempotency identity bound to actor, thread,
  and read cursor. Callers may pass the causal `ThreadReadState.readStateRevision`
  CAS token only for stale-write detection.
- `link_chat_to_work` requires an `idempotencyKey` plus the target link request
  fields. The handler derives `CanonicalThreadLinkKey` server-side from the
  authorized, policy-normalized target, grant, and visibility fields; callers
  must not supply or override the canonical key.
- `summarize_chat` requires an `idempotencyKey` or worker request id bound to
  thread, visible message range, summary target, model/config fingerprint, and
  authorization scope.

Before persisting or emitting side effects, each handler reserves the
workspace-scoped idempotency record for the same actor, operation, key, and
canonical operands atomically in the same transaction or serialized unit of work
as the thread/message/link/reaction/read-state/summary mutation. Worker-owned
mutations use the same rule with their server-derived request identity. That
reservation uses the server-derived `CanonicalThreadLinkKey` for
`link_chat_to_work` only after authorization, scope normalization, share-grant
resolution, and visibility degradation have produced the final canonical
operands.
The same unit also writes a durable outbox or replayable side-effect ledger for
notification fanout, search indexing, export/history fanout, projection
invalidation, summary fanout, read-state fanout, and any other derived work keyed
by the same workspace, thread, message, link, reaction, read-state, summary, and
idempotency identity. The idempotency record and side-effect ledger are persisted
before any fanout, projection invalidation, notification, search indexing, export
work, read-state materialization, or summary write is emitted. A matching retry
returns the existing result and replays, completes, or suppresses side effects
from the committed ledger without creating duplicate
messages, activities, notifications, links, reactions, read-state transitions,
summaries, projection invalidations, or fanout jobs. If the mutation commits but
a worker crashes, retry/recovery must be able to regenerate downstream work from
the durable mutation plus ledger; if the ledger cannot be committed with the
mutation, the handler must not acknowledge success. A key reused with different
operands fails closed with `replay_metadata_mismatch`.
Client-supplied `threadId` on create or `messageId` on reply is rejected; those
identifiers are server-owned outputs of the idempotency result. Chat idempotency
records must be retained for the workspace's configured mutation retry horizon
and no less than the maximum client/offline retry window or the longest
downstream worker recovery/durable ledger replay window, whichever is larger;
after expiry, late retries fail closed with an explicit idempotency-expired
response rather than creating duplicate side effects.
All chat API and worker mutation paths, including edits, deletes, reactions,
read-state updates, links, notifications, summaries, and projections, must also
respect user locks, folder/atom/file sharing boundaries, protected work, and
skill-turn/review gates before persisting or materializing derived state.

Renderer surfaces that load any workspace-scoped chat state asynchronously,
including channels, chats, linked work, summaries, search results, side-rail
state, presence, typing, read-state, and notification surfaces, must guard
responses with a workspace/request token and verify that token again at apply
time before mutating UI state. Abort signals are supplemental cancellation, not
the only guard. A slow response for workspace A must be ignored rather than
repainting workspace B after a workspace switch.

This does not violate the dohc file philosophy. Chats are social actions, not
plain file writes. Posting a message triggers activity, mentions, read state,
and notifications. It should be an action.

Agents should still get readable context projections:

That projection is primarily for reading/reference/export. It should not be the
canonical write path for posting. The native filesystem design owns the
canonical projection-path behavior, including reserved-namespace handling,
deterministic filename construction, root containment, and TOCTOU-safe projection
writes. This chat spec owns only the projection source data and policy contract:
before any chat text is projected, the projection pipeline must classify secret
content and apply the same policy-aware redaction rules used by chat rendering,
search, notifications, summaries, and export. Derived chat projections must never
persist plaintext secrets outside the authorized secret-backed read path, and
projection writers/readers must use the filesystem spec's projection writer and
projection scope rules instead of inventing local path algorithms.

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
Can we make conflict handling feel more like a collaborative doc editor?

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
body into the filesystem-owned projection writer output.

## Integration with files and versions

The first engine-backed chat links should target defined Phase 0 identities:

- files.
- folders.
- versions.
- history moments.
- agent runs.
- decisions.
- tasks.
- shares with explicit share grants.

Later substrate identities can add links to:

- apps/sites.
- databases/rows.

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
The first send for a channel conversation must be one atomic
`send_channel_message` mutation: the server resolves or creates the
channel-backed `ChatThread` by `(workspaceId, channelId, channelConversationId)`
and persists the initial `ThreadMessage` plus matching `message_created`
`ThreadActivity` and `chat_created` provenance in the same transaction or
serialized unit. Callers must not implement the fast path as `create_chat`
followed by `reply_to_chat`, because that creates a duplicate-thread window and
splits the durable chat identity proof from the first message proof. Concurrent
first sends for the same tuple must converge on one `ChatThread`, with distinct
`ThreadMessage` rows ordered by the canonical per-thread sequence. There is no
separate durable `ChannelMessage` entity outside the canonical
`ChatThread -> ThreadMessage` model.

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

Presence and typing are ephemeral signals, not durable message history:

```ts
type ChatPresenceState = 'online' | 'away' | 'offline'

type ChatPresenceSignal = {
  kind: 'presence_updated'
  workspaceId: string
  channelId?: string
  threadId?: string
  readonly actorId: string // server-derived
  readonly actorKind: 'human' | 'agent' | 'system'
  readonly actorDisplayLabel?: string // omitted when policy requires
  readonly actorDisplayLabelRedacted?: true
  sessionId: string // server-issued session/device/agent-run session
  presence: ChatPresenceState
  issuedAt: UnixMsDecimalString
  expiresAt: UnixMsDecimalString
}

type ChatTypingSignal = {
  kind: 'typing_started' | 'typing_refreshed' | 'typing_stopped'
  workspaceId: string
  threadId: string
  parentMessageId?: string
  readonly actorId: string // server-derived
  readonly actorKind: 'human' | 'agent' | 'system'
  readonly actorDisplayLabel?: string // omitted when policy requires
  readonly actorDisplayLabelRedacted?: true
  sessionId: string
  issuedAt: UnixMsDecimalString
  expiresAt: UnixMsDecimalString
}
```

The server owns `actorId`, `actorKind`, `actorDisplayLabel`,
`actorDisplayLabelRedacted`, `sessionId`, `issuedAt`, and `expiresAt`;
browser/client callers may request a state change but cannot assert identity,
timestamps, display labels, redaction state, or expiry. Presence signals expire
after at most 120 seconds and must refresh no less often than halfway through the TTL
while the session remains active. Typing signals expire after at most 8 seconds,
refresh while input continues, and stop immediately when the composer is sent,
cleared, hidden by policy, or the session disconnects. Expired signals are
dropped from live views and are not written to `ThreadActivity`, search, export,
history, notifications, or unread counts.

Presence/typing fanout re-authorizes each recipient against the current channel,
thread, linked-work, and share grant policy at delivery time. In shared channels,
the server may redact `actorDisplayLabel`, omit `parentMessageId`, or suppress the
signal entirely when a recipient can see the channel but not the actor, thread, or
reply parent. Typing against a `parentMessageId` must recheck the same
`ThreadMessage` visibility used by message reads; if the parent message is edited,
deleted, tombstoned, or hidden before delivery, the typing signal degrades to
thread-level typing or is suppressed without exposing deleted body metadata.
Lightweight reactions remain durable `ReactionThreadActivity` records, while
presence and typing remain best-effort live state.

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
- folders.
- versions.
- history moments.
- decisions.
- tasks.
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
results across chats, messages, files, folders, versions, history moments,
decisions, tasks, agent runs, apps/data, and source-context snippets. Search
snippets must never expose plaintext secrets that are not visible through the
same policy-aware read path.

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
Every message, thread title, participant list, inbox or side-rail entry, activity
feed item, unread badge, presence signal, typing indicator, read/seen state,
link, projected reference, and free-text mention inside a shared channel must be
re-authorized or redacted against normal workspace policy before rendering,
search, projection, notification materialization, or export. An external viewer
can see only the chat content and work artifacts explicitly shared with them;
non-shared files, atoms, versions, app views, agent runs, participants, thread
subjects, presence, typing state, read/seen state, unread state, activity, and
unshared links remain hidden even if they are mentioned inside an otherwise
shared thread. Explicitly shared links and work references remain visible only
when their server-side grant is still valid for that viewer and redaction scope.

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
3. Users can send fast messages in a channel; each send resolves the
   channel-conversation `ChatThread` through get-or-create and persists a
   `ThreadMessage`.
4. A burst of messages stays attached to that same durable chat thread without
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
