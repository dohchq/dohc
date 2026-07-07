# Think Bigger Multi-User Chat: Presence, Reactions, DMs, Shared Channels

Status: design accepted for lane cutting (no product code in this doc's PR)
Date: 2026-07-07
Arc: WS-G (collaboration surface), lane Multi-User Chat (MU-C), riding G2-C
Basis: the collaboration surface and ephemeral awareness channel from the
[Y.Doc engine driver / G2-C design](./2026-07-07-think-bigger-ydoc-engine-driver-design.md),
the coexistence + flag posture from the
[WS-G2 collab design](./2026-07-06-think-bigger-wsg2-collab-design.md),
the multi-origin op log + thin relay from the
[0P sync design](./2026-07-06-think-bigger-0p-sync-design.md),
and the shipped Chats surface from the
[Chats design](../specs/2026-06-23-dohc-chats-design.md).
All claims about current code are verified against this worktree
(branch base main `1ae8f46f`).

## Why this document

dohc is individual-first and local-first. Chat already works for one person
across their own machines: three op kinds ride the multi-origin log and
replicate through the same relay as files. What does NOT exist is chat between
DIFFERENT people — presence, reactions, DMs, and channels shared across
users/workspaces. The 0P-C chat replication carries a display-name string, not
an authenticated author; the PR-18 share filter deliberately EXCLUDES every
`chat.*` op; and there is no presence/typing channel anywhere. This note
designs multi-user chat FULLY (all four features) on the collaboration surface
G2-C is already establishing, so the same opt-in, the same relay, and the same
Better Auth identity power co-editing AND chat, with zero new bloat for solo
users.

The frame is binding: multi-user chat is OFF by default, behind the SINGLE
collaboration flag that also gates co-editing (sign in + connect a relay). A
solo user sees none of it. Everything is fully self-hostable — presence rides
G2-C's ephemeral awareness channel on the relay; reactions, DMs, and shared
channels are chat data over the same relay. "dohc cloud" is just a hosted
instance of that relay; nothing here is cloud-locked.

## Goals

- One collaboration surface: the same opt-in flag, relay connection, and
  Better Auth identity gate BOTH co-editing (G2-C) and multi-user chat. A
  solo, signed-out user gets exactly today's local Chats and nothing more.
- Authenticated authorship: a multi-user message is provably from a relay
  user id, server-derived, never client-asserted — closing the gap that
  `authorDisplayName` is a free string today.
- Reactions as durable, commutative chat data over the relay: a set-membership
  op where add/remove commute and re-apply is a no-op, riding the existing 0P
  chat replication with no new transport.
- DMs and shared channels reusing the PR-18 grant/recipient model and its
  proven fail-closed filter posture — never the retired members/invites
  routes.
- Fully self-hostable end to end: the existing relay + Better Auth + Postgres
  is the entire server footprint. No new service.
- Cross-user isolation as a BLOCKING invariant, adversarially tested exactly
  like PR-18: a non-participant must never see a DM, a revoked member's
  channel view must close cleanly, and no chat op crosses a boundary the
  server did not derive.

## Non-goals

- No product code in this lane. Design note only.
- No group-video/voice, no threading redesign, no rich message editing beyond
  the reserved `chat.thread.update` slot. Message bodies stay append-only.
- No presence persistence: presence/typing are ephemeral and MUST NOT enter
  `replication_log` (0P Risk 2, the same rule G2-C awareness holds).
- No new identity system. Membership is Better Auth users the relay already
  authenticates; we do not resurrect `workspace-api` members/invites.

## What the code proves today (verified)

1. **Chat is three op kinds on the generic log — no chat-specific
   transport.** The linked-chat store journals ops in the same txn as the
   state write via `journalLocalReplicationOp` (`syncReplication.ts:92`):
   `createChannel` -> `chat.channel.create` (`linkedChatStore.ts:931`),
   `startChannelThread` -> `chat.thread.create` + `chat.message.append`
   (`linkedChatStore.ts:1119`, `:1131`), `sendMessage` -> `chat.message.append`
   (`linkedChatStore.ts:1300`). Inbound ops apply through one entry point,
   `applyReplicationOp` (`linkedChatStore.ts:1327`), dispatched by
   `syncApply.ts:343-352`. The relay treats chat payloads as opaque JSON
   (`server.ts:436` log append; `storage.ts:972` marks `chat.*` blob-free).
2. **The owner's own bucket already replicates chat cross-machine.**
   `pushWorkspaceToRelay` (`syncRelay.ts:369`) drains ALL unpushed
   `replication_log` rows (including `chat.*`) to the caller's workspace
   bucket; `pullWorkspaceFromRelay` (`syncRelay.ts:781`) fetches and applies
   them. This is why one person's chat already syncs between their laptops.
3. **Cross-origin ordering is deterministic, not CRDT.** `popNextMergedOp`
   (`syncApply.ts:152`) orders by `recordedAtMs`, tie-break `originId`
   lexicographic, then `originSeq`. Message inserts are idempotent
   insert-if-absent by `message_id` (`linkedChatStore.ts:1480`); append order
   is `MAX(message_order)+1` (`linkedChatStore.ts:778`). Re-apply never
   overwrites a body.
4. **Author identity on the wire is a display string, not an account.**
   `ChatMessageAppendPayload` (`engine.ts:378`) carries `authorKind`
   (`"human"|"agent"`) + `authorDisplayName` — no stable user id. `ChatActor`
   (`engine.ts:906`) is the same shape. Multi-user attribution needs a new
   authenticated field; this is the central authorship gap.
5. **Read cursors and unread are LOCAL-ONLY and never replicate.**
   `ChatThreadReadState.revision` (`engine.ts:941`) is a store-owned optimistic
   counter used by `advanceReadCursor` (`linkedChatStore.ts:650`); no read op
   is ever journaled. A shared/multi-user read model does not exist today.
6. **`ChatChannelKind` already reserves `"dm"`; participants do not exist.**
   `engine.ts:887` defines `"channel" | "dm"`, with the note (`engine.ts:886`)
   that it is a "kind enum only — no participant sets, presence, or DM UI
   yet." `chat.thread.update` is reserved but unimplemented (stores reject it,
   `linkedChatStore.ts:1528`).
7. **The relay identity + PR-18 share model is the substrate we reuse.**
   Identity is server-derived: `resolveActor` (`server.ts:143`) ->
   `createSessionActorResolver` (`session.ts:20`) -> Better Auth session ->
   `actorFromSession` (`betterAuth.ts:106`); a client cannot assert `userId`.
   Grants live in `sync_relay_shares` (`storage.ts:256-274`): `granter_user_id`,
   `recipient_user_id` (NULL for a pending email invite), `recipient_email`,
   `selector_json`, `revoked_at_ms`. Create-by-id and create-by-email (with the
   anti-enumeration identical response) are at `server.ts:283-338`; pending
   invites are claimed on first authenticated touch by
   `claimPendingSharesForEmail` (`storage.ts:838`), keyed on the server-derived
   session email.
8. **The share filter is fail-closed and today excludes chat.**
   `filterOpForShare` (`shareFilter.ts:181-282`) is a strict allowlist ending
   in `return { allowed: false }`; it recognizes only `workspace.init`,
   `moment.append`, `version.create`, and its test asserts all four `chat.*`
   kinds are excluded (`shareFilter.test.ts:231-234`). Revocation stamps
   `revoked_at_ms` (`storage.ts:888`), only the granter may revoke
   (`server.ts:184`), and in-flight reads re-check revocation before returning
   a body (`server.ts:218-222`, `:248-251`).
9. **The recipient side is a read-only replay, never a push-back.**
   `syncShareView.ts:13-23`: a filtered stream has per-origin gaps by
   construction, so a shared view is NOT a sync replica — the recipient
   REPLAYS allowed ops as ordinary local writes and "never pushes anything
   back." Shared CHANNELS need bidirectional flow, so they are a NEW share
   kind, not a reuse of the read-only file-view path.
10. **Presence has no home yet.** The relay is a stateless pull/push log
    (no websocket). The only presence primitive is hocuspocus awareness
    (`hooks.ts:566`, `:657`), bound to Y.Docs and retiring with that service.
    G2-C designs the replacement — an ephemeral awareness channel over the
    relay transport. Chat presence REUSES it, not a channel of its own.

Consequence: reactions are a new commutative op on the existing pipeline; DMs
and shared channels are a new bidirectional grant kind extending PR-18;
presence is a subscriber on G2-C's awareness channel; authorship is one new
payload field the relay stamps. No new service, no new transport.

## The collaboration flag / surface

There is ONE collaboration surface, shared with co-editing. It has two gates,
both already required by G2-C:

1. **Signed in to a relay** (Better Auth device flow — the same login that
   mints the bearer token `resolveActor` validates, `betterAuth.ts:84-86`).
2. **A connected relay** (`SyncRelayConnection`, the 0P-B relay the desktop
   already pushes/pulls through).

`collaborationEnabled = signedIn && relayConnected`. This is the SAME boolean
G2-C flips co-editing on. Multi-user chat surfaces (DMs, shared channels, the
member picker, presence, reactions-from-others) are gated behind it.

**What a solo user sees: nothing new.** With `collaborationEnabled === false`
the Chats view is exactly today's: local channels/threads, single-writer,
`authorDisplayName` from the local profile, no presence, no member UI, no DM
composer. Reactions render as a purely local affordance if we ship them solo
(you can react to an agent's message in your own workspace), but no reaction
ever leaves the machine. The multi-user code paths are dynamically gated the
same way `useCollabDoc` gates Y.Doc construction (`useCollabDoc.ts:181-184`):
if collaboration is off, they are never constructed.

**Opting in (settings/UX).** The desktop Settings collaboration section (the
one G2-C adds for sign-in + relay) grows a single "Collaboration" toggle
description that names BOTH capabilities: "co-edit documents and use shared
channels, DMs, presence, and reactions." One consent, one surface. Turning it
off disconnects the relay, drops all presence, and closes any open shared /
DM channel view (see revocation semantics); local channels stay untouched.

**Offline degradation.** Multi-user chat degrades exactly like co-editing:
presence goes dark (never a crash, mirroring G2-C's "awareness-channel-down
still allows editing"); reactions and messages you send while offline journal
locally and push on reconnect; a shared/DM view whose grant you cannot re-read
shows "reconnecting," not an error, and resumes on the next `share-log` fetch.
Local-first is preserved: your own channels are always writable offline; only
OTHER users' content needs the relay.

## Member model (reuse PR-18, never the retired routes)

A "member" of a shared channel or DM is a Better Auth **user id** the relay
authenticates — the exact identity `actor.userId` already carries
(`server.ts:143`). We do NOT build a members table, invite tokens, or roles:
membership is expressed as PR-18 grants, one grant per (channel, recipient).

**A channel grant is a share row with a chat selector.** We extend the
existing `sync_relay_shares` model rather than add a table. The selector today
is `{ paths, versionId }` (`shareFilter.ts:28-35`); we widen the stored
`selector_json` to also express a **chat selector**:

```
ChatShareSelector {
  kind: "chat-channel",
  channelWireId: string,     // the cross-machine channel identity
  access: "read-write" | "read-only"
}
```

The row keeps the same columns (`granter_user_id`, `recipient_user_id` /
`recipient_email`, `revoked_at_ms`), so create-by-id, create-by-email, the
anti-enumeration identical response, pending-invite claiming, and revocation
ALL work unchanged (`server.ts:283-338`, `storage.ts:838`, `:888`). One
channel shared with three people is three rows, exactly like three file
shares.

**Joining.** The channel owner creates a chat share addressed to a user id or
email. A known account is live immediately; an unknown email is a pending
invite claimed on the recipient's first authenticated relay touch
(`claimPendingSharesForEmail`, keyed on the server-derived session email — a
client cannot claim someone else's invite, `server.ts:92-96`). The channel
then appears in the recipient's "Shared" section on their next `share-log`
fetch.

**Leaving.** Two honest paths, mirroring PR-18: the owner **revokes** the
member's grant (`server.ts:180-187`), or the member **leaves** by revoking
their own recipient grant (a small, explicitly-scoped addition to
`share-revoke` gated on `share.recipientUserId === actor.userId`). Either way
the row is stamped `revoked_at_ms` and the member's view closes cleanly.

**Authorization is server-derived, always.** Who may read a channel's ops is
decided by the relay from the grant row + `actor.userId`, never from anything
the client sends. The client cannot name a channel it has no grant for and
receive its ops: `share-log` loads the grant via `shareForRecipient`
(`server.ts:80-90`), which fails closed (generic 404) on no-grant, revoked,
wrong-recipient, or granter-lost-workspace.

## Authenticated authorship (the provenance gap)

Multi-user chat requires knowing WHO sent a message, server-verifiably.
`ChatMessageAppendPayload` (`engine.ts:378`) gains one optional field:

```
authorUserId?: string   // the relay user id, stamped/verified by the relay
```

Rules:
- **Solo/local messages** omit `authorUserId` (today's exact shape;
  `authorDisplayName` still renders). No behavior change offline.
- **Multi-user messages** carry `authorUserId`. The relay, when accepting a
  chat op onto a SHARED channel's replication path (below), verifies
  `authorUserId === actor.userId` and rejects the batch otherwise. This is the
  one place the relay stops treating a chat payload as fully opaque — the same
  single, tested relaxation PR-18 already makes for share filtering
  (`shareFilter.ts:16-20`). Display names remain a convenience; the durable
  provenance is the verified id.
- Re-apply stays idempotent: the field is inside the insert-if-absent message
  row keyed by `message_id`, so it never mutates.

This makes "who said this" a first-class, spoofing-resistant fact without a
new identity system.

> **✅ Implemented (MU-C0).** `ChatMessageAppendPayload.authorUserId` (optional)
> and `ChatMessage.authorUserId` now exist; a signed-in desktop send stamps the
> OPAQUE Better Auth user id (`relayAuthorUserId()` in desktop main), solo omits
> it (byte-identical to today). Verification landed at the relay's `POST
> /sync/:ws/log` append path — NOT only the shared-channel route — so EVERY push
> is checked (`assertChatAuthorship`): a chat op whose author ≠ the authenticated
> pusher fails the whole batch atomically with `403 authorship_mismatch`. The
> shared-channel member-append route (MU-C4) reuses the same gate. The engine's
> replicated apply persists `author_user_id` (a lazy-additive nullable column)
> and trusts it ONLY because the relay verified it.

## Presence / typing (ephemeral — reuse G2-C awareness)

Presence, typing, and "viewing this channel" are ephemeral and MUST NOT enter
`replication_log`. They reuse G2-C's ephemeral awareness channel verbatim —
the pub/sub/broadcast endpoint over the relay transport that G2-C specifies
("Awareness (ephemeral, never an op)" in the G2-C design). Chat presence is a
second SUBSCRIBER on that channel, keyed by a chat topic rather than a doc.

**Awareness topic.** Where G2-C keys awareness by `(workspaceId, objectId)`
for a doc, chat keys by `(shareId | channelWireId)` for a shared channel or
DM. The relay fans out awareness updates only to origins that hold a live,
non-revoked grant for that topic — the SAME `shareForRecipient` gate the
durable `share-log` uses, so presence cannot leak to a non-member.

**Awareness state shape** (ephemeral, dropped on disconnect):

```
{ userId, displayName, state: "viewing" | "typing", channelWireId, atMs }
```

- Online/viewing: a client publishes `viewing` while a shared channel/DM is
  open; peers render "N here."
- Typing: a client publishes `typing` (debounced, self-expiring) while the
  composer is non-empty; peers render "X is typing…" It clears on send, on
  blur, or on a short TTL if the publisher vanishes.
- `userId` is echoed by the relay from the authenticated session, not trusted
  from the client (presence cannot impersonate).

**Self-hosting story for awareness.** The awareness channel is part of the
relay a self-hoster already runs (G2-C adds it to the SAME service). No extra
service, no cloud dependency. If a self-hoster runs the relay without the
awareness endpoint reachable (e.g. a proxy that blocks the websocket), chat
still works fully — only presence/typing degrade, exactly the G2-C contract.
Presence is never durable, so nothing is lost.

## Reactions (durable, commutative)

A reaction is durable chat data replicated over the relay as a NEW commutative
op kind, `chat.reaction.set`, added to `SyncReplicationOpKind`
(`engine.ts:212-227`) and its discriminated envelope (`engine.ts:405-418`).

**Data model — a set-membership CRDT.** A reaction is the tuple
`(messageId, emoji, userId)`. The relation "user U reacted with emoji E to
message M" is a member of a set. The op:

```
ChatReactionSetPayload {
  reactionId: string,     // stable per (messageId, emoji, userId)
  messageId: ChatMessageId,
  threadId: ChatThreadId,
  emoji: string,          // normalized unicode / shortcode allowlist
  userId: string,         // the reactor (relay id in multi-user; local id solo)
  op: "add" | "remove",
  atMs: number
}
```

**Conflict / idempotency — additions and removals commute.** State is an
observed set of `(messageId, emoji, userId)` rows in a new
`chat_reactions` table. Apply is:
- `add`: `INSERT OR IGNORE` the row (idempotent; re-apply is a no-op).
- `remove`: delete the row if present (idempotent; re-apply is a no-op).
Concurrent add+remove by the SAME user for the SAME `(message, emoji)` resolve
by the deterministic op order the log already imposes
(`recordedAtMs`/`originId`/`originSeq`, `syncApply.ts:152`) — a last-writer
tie-break that is deterministic across machines, not a merge. Different users
never conflict (distinct rows). This is the same "convergence by op semantics,
not by head check" property G2-C relies on for `ydoc.update`: no conflict row,
no `before` guard. The per-origin contiguity + `acked_seq` dedup
(`linkedChatStore.ts:1341-1346`) is the backstop against re-apply.

**Riding 0P chat replication.** `chat.reaction.set` journals through
`journalLocalReplicationOp` and replicates through the SAME
push/pull/apply pipeline as the other three chat kinds — a new branch in
`applyReplicationOp` (`linkedChatStore.ts:1327`) and a new `case` in the
`syncApply.ts:343` dispatch. No new transport, no blobs (it is blob-free like
the other chat ops, `storage.ts:972`).

**Authorization.** On a shared channel, the relay stamps/verifies
`userId === actor.userId` for reaction ops exactly as for message ops (a
reaction is an authored act). A reaction on a message you can see, you can
make; you can only remove your OWN reactions (enforced by `reactionId` /
`userId` identity).

> **✅ Security — reaction authorship VERIFIED at the relay (closed by MU-C0).**
> The verification above is now IN FORCE. MU-C0 added a server-side authorship
> gate to the relay's log-append path (`services/sync-relay/src/server.ts`,
> `assertChatAuthorship`): before any batch is admitted to `replication_log`,
> every chat op that names an author is checked against the authenticated pusher
> (`actor.userId`, server-derived from the Better Auth session). A
> `chat.reaction.set` whose `authorId`, or a `chat.message.append` whose
> `authorUserId`, does not equal the pusher — or a reaction op with no `authorId`
> at all — fails the WHOLE batch atomically with `403 authorship_mismatch`
> (nothing is admitted). So `authorId`/`authorUserId` remain part of the CRDT
> cell key and are trusted verbatim on the engine's replicated apply ONLY because
> the relay verified them first; the engine has no origin→user map and cannot
> check it itself. A relay collaborator can no longer forge a reaction/message as
> a VICTIM. The identity is the OPAQUE Better Auth user id (never a raw email —
> PII must not enter the replicated CRDT). The LOCAL react/send path is safe
> (desktop main derives the id from the signed-in user, never the renderer), and
> the no-relay/solo path is a single trusted user. Shared reactions across relay
> members are therefore safe to enable.

## DMs

A DM is a channel with `kind: "dm"` (`engine.ts:887`, already reserved) whose
membership is a fixed **recipient set** of relay user ids, expressed as PR-18
grants.

**Data model.** A DM is a channel row (`chat_channels`, kind `"dm"`) plus one
chat share grant per participant. There is no separate DM table: the
participant set IS the set of non-revoked chat-channel grants for that channel
whose `access` is `read-write`. A 1:1 DM is two grants (each participant is a
recipient of the other's… — see the ownership note below); a group DM of N is
N grants.

**Ownership.** The exactly-one-owner XOR in the store
(`linkedChatStore.ts:372-374`: a thread owns EITHER a linked file OR a channel)
is unchanged — DM threads are channel-owned. The creator's workspace is the
canonical bucket the DM's ops replicate through, and every participant holds a
bidirectional grant to it, addressed by `channelWireId`.

**Replication.** DM messages are `chat.message.append` ops (with
`authorUserId`) on the DM channel, replicated over the shared-channel
bidirectional path (below). Reactions and presence work identically, scoped to
the DM's `channelWireId`.

**Anti-forum composer semantics.** DMs keep the Chats view's chat-not-forum
feel (`ChatsView.tsx:17-19`: "channel composer sends on Enter"). A DM is a
single running conversation: the composer sends on Enter into ONE implicit
thread per DM channel (not the multi-thread channel model), so a DM reads like
a message thread, not a forum of topics. Titles are suppressed; the first
message is the snippet, reusing the untitled-thread path
(`normalizeOptionalThreadTitle`, `linkedChatStore.ts:210`).

**Surfacing in the Chats UI.** DMs appear in a "Direct messages" section,
listing peers by display name (resolved from grant ids via the relay's
display-only lookup, never used for authz, `server.ts:28-29`). Selecting a peer
opens the running DM thread. New DMs start from a member picker addressing a
user id or email — the exact create-share affordance PR-18 uses.

**Authorization: only participants see a DM.** A DM channel's ops are served
ONLY through `share-log` gated by `shareForRecipient` (`server.ts:80-90`).
A user with no grant for that `channelWireId` gets the generic 404 — they
cannot enumerate, read, or even confirm the DM exists. This is the blocking
isolation invariant.

## Shared channels

A shared channel is a normal `kind: "channel"` channel plus its threads and
messages, shared across users/workspaces via a chat-channel grant — like a
PR-18 share but for a WHOLE channel and everything under it, and **read-write**
rather than read-only.

**The grant model.** The channel owner creates a `chat-channel` grant
(selector `{ kind: "chat-channel", channelWireId, access }`) addressed to each
member by id/email. This reuses the entire PR-18 create/claim/revoke surface
(`server.ts:269-338`, `storage.ts:838`, `:888`).

**Read/write vs read-only.** Both are first-class via the selector's `access`:
- `read-only`: the member replays incoming channel ops but the relay REJECTS
  any inbound message/reaction op from them for that channel (an
  announcements-style channel). This is the natural extension of PR-18's
  read-only file view to chat.
- `read-write`: the member may append messages and reactions; the relay
  verifies `authorUserId === actor.userId` on their inbound ops.
The default is `read-write` for a collaborative channel; `read-only` is the
opt-in for broadcast channels.

**How messages replicate to all members (the bidirectional path).** This is
the one genuinely new mechanism, because PR-18's recipient replay is
one-directional (`syncShareView.ts:19-23`, "never pushes anything back"). A
shared channel needs every member's messages to reach every other member. The
design keeps the relay a dumb log and avoids server-side merge:

- Each member's client PUSHES its own channel ops to the SHARE, not to a
  foreign workspace bucket. We add a member-scoped append route,
  `POST /sync/shares/:shareId/log`, that:
  1. loads the grant fail-closed (`shareForRecipient`),
  2. requires `access === "read-write"`,
  3. runs each op through a chat-aware `filterOpForShare` branch (below) to
     confirm it targets the granted `channelWireId` and carries
     `authorUserId === actor.userId`,
  4. appends it into the OWNER's workspace bucket log under the member's own
     `originId` (per-origin contiguity preserved — the relay still assigns no
     cross-origin order).
- Every member reads the channel via `GET /sync/shares/:shareId/log`, whose
  filter now allows `chat.*` ops scoped to the granted channel. Because all
  members read the SAME underlying owner-bucket log, they converge on the same
  message set by the same deterministic order (`syncApply.ts:152`).
- The owner reads its own channel through its normal owner-bucket pull; members
  read through the share. One log, many authenticated readers/writers, one
  fail-closed filter.

**Extending the share filter (fail-closed).** `filterOpForShare`
(`shareFilter.ts:181-282`) gains a chat branch that allows a `chat.*` op ONLY
when: the selector is a `chat-channel` selector; the op's channel identity
(`channelWireId` for channel/thread create, or the thread's channel for
message/reaction) equals the granted `channelWireId`; and, for write
acceptance, `authorUserId` matches the pushing actor. Everything else — other
channels, DMs the reader is not in, file ops, secrets, unknown kinds — stays
excluded by the terminal `return { allowed: false }`. Chat ops are blob-free,
so no blob-reachability surface is added (`storage.ts:972`).

**Revocation (honest end-of-share).** A member loses access exactly as in
PR-18: the owner (or the member themselves) stamps `revoked_at_ms`
(`storage.ts:888`). The next `share-log` fetch throws the generic 404
(`server.ts:84`), the in-flight re-check aborts any racing read
(`server.ts:218-222`), and the member's Chats view CLOSES the channel cleanly
— it disappears from their "Shared" section (`listSharesReceivedBy` filters
`revoked_at_ms IS NULL`, `storage.ts:881`), mirroring PR-18's honest
end-of-share. Messages the member already replayed into their local store
remain locally (they legitimately saw them), but no new ops arrive and they
can no longer post. Presence for them drops immediately (the awareness gate is
the same grant check).

## Self-hosting

The entire server footprint for all four features is the stack a self-hoster
ALREADY runs for 0P-B + G2-C. From `docker-compose.self-host.yml`:

- **postgres** (`docker-compose.self-host.yml:4-18`) — the shared DB; Better
  Auth users/sessions live here.
- **workspace-api** (`:50-70`) — hosts Better Auth on `/api/auth`; mints the
  bearer tokens the relay validates. `BETTER_AUTH_SECRET` + `POSTGRES_URL`.
- **sync-relay** (`:72-95`) — the log/blob/share relay, SQLite-backed
  (`SYNC_RELAY_DB_PATH`), sharing `BETTER_AUTH_SECRET` + `POSTGRES_URL` with
  workspace-api so tokens validate and email lookups resolve.

What this design ADDS to that stack: nothing structural. Reactions are a new
op kind on the existing log. DMs and shared channels are new rows in the
existing `sync_relay_shares` table and a new member-scoped append route on the
existing relay. Presence is G2-C's awareness endpoint on the same relay
process. Authorship is one payload field the relay verifies.

**Explicit statement: dohc cloud == a hosted relay.** There is no
cloud-exclusive server for chat. "dohc cloud" is a hosted instance of the SAME
`services/sync-relay` + Better Auth a self-hoster runs from
`docker-compose.self-host.yml`. Nothing in presence, reactions, DMs, or shared
channels is cloud-locked; a self-hoster who runs the relay gets every
multi-user chat feature.

## Security invariants (the gate's focus)

These MUST hold; the milestones' adversarial tests exist to prove them.

1. **Identity is server-derived.** Every membership, authorship, and presence
   decision keys on `actor.userId` from the validated Better Auth session
   (`session.ts:20`), never a client-supplied id. `authorUserId` on a shared
   op is VERIFIED against `actor.userId` at the relay; a mismatch rejects the
   batch.
2. **Fail-closed filters everywhere.** The chat branch of `filterOpForShare`
   is an allowlist under the existing terminal deny (`shareFilter.ts:281`). An
   unrecognized op, a wrong `channelWireId`, or a missing grant yields no
   data. No chat op crosses a boundary the filter did not positively allow.
3. **No plaintext leaks across boundaries.** A non-member never receives a
   DM/channel op, a presence update, or a reaction for a channel they lack a
   grant for — the same generic 404 the PR-18 recipient path returns
   (`server.ts:84`), indistinguishable from "never existed."
4. **Secret channels are never shared.** A DM/channel grant carries only a
   `channelWireId`; it can never widen to file/secret ops. The path-based
   secret gates (`shareFilter.ts:55-121`, `:141-150`) remain the guard for
   file shares; chat grants have no path selector at all.
5. **Revocation is immediate and honest.** Revoke stamps `revoked_at_ms`; the
   entry check AND the in-flight re-check both fail closed
   (`server.ts:84`, `:218-222`); the member's view closes cleanly. Only the
   granter or the recipient-of-their-own-grant may revoke (`server.ts:184`).
6. **Ephemeral stays ephemeral.** Presence/typing NEVER enter
   `replication_log` or any bundle; they exist only on the awareness channel
   and drop on disconnect (0P Risk 2, the G2-C awareness rule).
7. **Solo isolation.** With `collaborationEnabled === false`, no multi-user
   code path is constructed and nothing chat-related leaves the machine.

## Milestones

Cut into implementable lanes, each with a test gate and BLOCKING adversarial
cross-user isolation tests (the PR-18 posture). MU-C1 depends on G2-C landing
the awareness channel; the durable lanes depend only on 0P-B (the relay) and
can proceed in parallel with G2-B/C.

### MU-C0 — Authenticated authorship + the collaboration gate

Depends on 0P-B + the G2-C sign-in/relay surface. No presence yet.

- Add optional `authorUserId` to `ChatMessageAppendPayload` (`engine.ts:378`);
  solo omits it, multi-user stamps it. Wire the single `collaborationEnabled`
  gate shared with co-editing; multi-user Chats surfaces are constructed only
  when true.
- Test gate: a solo workspace produces byte-identical chat ops to today (no
  `authorUserId`); a signed-in send stamps `authorUserId`; the relay REJECTS
  a chat op whose `authorUserId !== actor.userId`. Isolation: a forged
  author id never persists on a shared channel.

### MU-C1 — Presence / typing on the G2-C awareness channel

Depends on **G2-C landing the ephemeral awareness channel** (this is the hard
dependency). Reuses it; adds no transport.

- Subscribe chat to the awareness channel keyed by `(shareId | channelWireId)`;
  publish `viewing`/`typing`; render "N here" and "X is typing…"; relay echoes
  `userId` from the session and gates fan-out by the grant check.
- Test gate: presence appears and clears on disconnect; typing self-expires;
  awareness is provably ABSENT from `replication_log` and bundles;
  awareness-channel-down still allows chat. Isolation: a non-member receives
  NO presence for a channel/DM they lack a grant for.

### MU-C2 — Reactions (durable, commutative)

Depends on 0P-B only. Independent of G2-C.

- Add `chat.reaction.set` op kind + `chat_reactions` table; `add`/`remove`
  apply as idempotent set membership; new `applyReplicationOp` branch and
  `syncApply.ts` dispatch case; renderer reaction affordance.
- Test gate: add/remove converge under any op interleaving (property/fuzz over
  random orders, like G2-C1's convergence fuzz); re-apply is a no-op;
  concurrent add+remove by one user resolves deterministically across two
  engines; a user can only remove their own reactions. Isolation: reactions on
  a shared channel verify `userId === actor.userId`.

### MU-C3 — DMs

Depends on MU-C0 (authorship) + the shared-channel bidirectional path (MU-C4's
relay route can land with or before this; DMs are the first consumer).

- `kind: "dm"` channels with a fixed recipient set as chat grants; the
  single-running-thread anti-forum composer; the "Direct messages" section and
  member picker; DM messages/reactions/presence scoped to `channelWireId`.
- Test gate: a 1:1 and a group DM round-trip messages between two engines via
  the share path; presence and reactions work in a DM. Isolation (BLOCKING): a
  non-participant gets the generic 404 for the DM's `share-log`, awareness, and
  blob surfaces — cannot read, enumerate, or confirm existence.

### MU-C4 — Shared channels (bidirectional share)

Depends on MU-C0. The largest lane: the new member-scoped append route and the
chat branch of the fail-closed filter.

- Extend `sync_relay_shares` selector to `chat-channel` with `access`;
  `filterOpForShare` chat branch (channel-scoped allowlist, author
  verification, fail-closed); `POST /sync/shares/:shareId/log` member append;
  read-only vs read-write enforcement; the "Shared" section in Chats;
  member-initiated leave.
- Test gate: three members converge on one channel's messages via the share
  log; a `read-only` member's inbound message/reaction op is REJECTED; a
  revoked member's next fetch 404s and the view closes cleanly; the in-flight
  revoke re-check aborts a racing read. Isolation (BLOCKING): every op a
  non-member requests fails closed; the chat filter admits ONLY ops for the
  granted `channelWireId`; no other channel, DM, file, or secret op leaks
  through the chat branch (adversarial filter test mirroring
  `shareFilter.test.ts:231-234`).

### MU-C5 — Arc gate: cross-user isolation sweep + self-host proof

- A consolidated adversarial suite: forged author ids, wrong-channel ops,
  revoked-mid-read, non-member enumeration, presence leakage, and a
  self-hosted `docker-compose.self-host.yml` run proving all four features
  work with only relay + Better Auth + Postgres (no cloud).
- Test gate: the full isolation matrix green on a self-hosted relay; ephemeral
  state provably absent from durable storage; solo workspace unchanged.

## Risks

1. **Bidirectional share is a new write surface on the relay.** PR-18's
   recipient path is read-only by design (`syncShareView.ts:19-23`); the
   member append route is the first place a non-owner writes into an owner's
   bucket. Mitigation: it reuses `shareForRecipient` + the fail-closed filter
   unchanged for authorization, adds only author verification, and keeps the
   relay merge-free (per-origin contiguity is preserved). MU-C4's isolation
   suite is the gate.
2. **Author verification relaxes relay opacity a second time.** The relay must
   read `authorUserId` from chat payloads to verify it — a second controlled
   exception to "payloads are opaque," after PR-18's filter read. Mitigation:
   it is the SAME kind of narrow, tested relaxation (`shareFilter.ts:16-20`),
   scoped to one field, fail-closed on mismatch.
3. **Presence depends on G2-C shipping the awareness channel.** MU-C1 cannot
   land until G2-C's ephemeral channel exists. Mitigation: MU-C0/C2/C4 are
   independent of it and can proceed; presence is the one lane sequenced
   behind G2-C, and it degrades gracefully if the channel is down.
4. **Shared read cursors / unread are out of scope but wanted.** Read state is
   local-only today (`engine.ts:941`); a shared channel has no per-user unread
   across users. Mitigation: unread stays local per user (correct default —
   your unread is yours); a shared read-receipt model is a named follow-up,
   not this lane.
5. **Message volume on the append-only log.** Shared channels multiply chat
   ops in the owner bucket. Mitigation: this is the same 0P Risk 2 growth
   bounded by the same GC-before-GA framing; chat ops are small and blob-free.

## Open questions for the user

1. **Do DMs and shared channels live in the creator's existing workspace
   bucket, or in a dedicated "shared" bucket?** Reusing the creator's bucket
   is simplest (one log, the filter scopes visibility) but couples a shared
   channel's durability to the owner's workspace — if the owner deletes that
   workspace, the channel dies. A dedicated shared-channel bucket is cleaner
   for group ownership but adds a bucket-ownership model. Recommendation:
   creator's bucket for alpha (matches PR-18's "granter's workspace" framing),
   with dedicated shared buckets as a named follow-up if group-owned channels
   are needed.

2. **Should reactions ship for solo users at all, or only under
   collaboration?** A solo user reacting to their agent's message is a nice
   local affordance and costs little, but it adds a durable op kind and a
   table to the solo path. Recommendation: ship reactions solo (they are
   cheap, commutative, and useful for marking agent messages), with
   cross-user reactions gated behind collaboration.

3. **Read-only vs read-write default for a shared channel — which is the
   obvious default?** Read-write matches "a channel is a shared conversation";
   read-only matches "sharing is showing." Recommendation: read-write default
   (a shared channel is collaborative by nature), with read-only the explicit
   opt-in for broadcast/announcement channels — but confirm this matches the
   product's mental model before MU-C4.
</content>
</invoke>
