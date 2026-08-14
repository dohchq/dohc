# File-share access levels — View, Comment, Edit

Design record for issue #646, shard S7 of the sync program
(`docs/superpowers/plans/2026-08-09-dohc-sync-program.md:105-112`).

Written for the agent that implements it. Every claim about current behaviour
carries a `file:line` anchor. Anchors are against `main` at commit `29e7c473`.

## Context

A file share grants paths and nothing else. `ShareSelector`
(`services/sync-relay/src/shareFilter.ts:33-40`) carries `paths` and
`versionId`. There is no level, role, or per-actor permission on it. The one
level that exists anywhere is binary and belongs to a different selector kind:
`ChatShareAccess = "read-write" | "read-only"` on chat-channel shares
(`shareFilter.ts:48-58`).

The consequences are visible at both ends. The recipient's MCP server gets a
flat `--read-only` (`apps/desktop/src/main.ts:1727`, flag applied at
`packages/mcp/src/server.ts:100-102`). Chat is not read-only in a share view,
it is absent: a share view opens with `capture = null`
(`apps/desktop/src/workspaces/workspaceActivity.ts:88-100`) and every chat IPC
handler throws at `requireEngineCapture` (`apps/desktop/src/main.ts:5751-5765`),
a fact pinned deliberately by `main.chatSecurity.test.ts:616-642`.

Ice decided on 2026-08-05 that file shares get three levels shaped like Google
Docs, and on 2026-08-07 that they build with the sync program rather than
before it. S1–S6 have landed. This is S7.

| Level | Document | Chat on that document |
| --- | --- | --- |
| View | read | read |
| Comment | read | read and write |
| Edit | read and write | read and write |

## Decisions

### Locked before this document

These came from the orchestrator. They are not reopened here.

**A. One field, one shape.** `access: "view" | "comment" | "edit"` on the
file/path share selector — relay `ShareSelector`, desktop `ShareViewSelector`,
share summary rows, bridge contract. The chat-channel selector's binary
`access` is untouched and out of scope.

**B. ~~Default at create is `view`~~ — REVERSED during PR1 review. The level
is required at create; there is no default.**

The original decision defaulted to `view` when a caller sent nothing, on the
reasoning that the UI always states the level anyway. CodeRabbit's review of
PR1 surfaced the inconsistency that argument hides: decision G already says the
field is required where it lives, and `parseShareSelectorJson` already refuses
a stored row that omits it. A default at create meant one boundary minted a
level nobody asked for while the neighbouring boundary refused the same shape.

Create is the MINTING boundary, so it is the one place the rule matters most. A
caller that sends nothing has not chosen `view`; it has failed to say what the
share grants, and the relay must not choose on its behalf. Because the UI
always sends the level, the default defended nothing — it only widened what a
non-UI caller could get by accident.

`validateShareSelector` therefore refuses a missing `access` with
`invalid_access`, the same code and shape as any other unrecognized value.

**C. Reuse the read-only refusal vocabulary end to end.** Relay
`share_read_only` (403, `services/sync-relay/src/errorCodes.ts:26`), the same
code whatever the reason, preserving the anti-fingerprinting property at
`server.ts:411-412`. The RelayError → wire → `SharedChannelReadOnlyError`
translation chain stays as it is. So do the anti-enumeration invariants: the
generic 404 collapse in `shareForRecipient` (`server.ts:176-190`) and the
identical email-invite responses.

**D. Comment means chat writes on the shared file's file-linked threads.** No
annotation primitive, no new op vocabulary beyond what chat already has.

**E. Thread visibility follows the selector** by resolving the thread's object
to its CURRENT path and testing that path against the selector paths.
`pathHint` is never trusted for authorization.

**F. Levels thread through both sides** — the TS relay and the Rust recipient
engine's pinned `ShareGrant`/`ShareBoundary` (trust on first use,
`crates/dohc-engine-sync/src/share.rs:78-97`), kept in lockstep by
`crates/dohc-engine-sync/tests/security_contract.rs`.

**G. No backward compatibility.** The field is required where it lives. Old
contracts are replaced, all callers and fixtures updated in the same change, a
selector missing the field fails loud. No migration shims.

**H. Three PRs.** PR1 is the level concept end to end. PR2 is chat following
the share. PR3 is Edit's document writes, last.

**I. Tests drive the real refusal boundary.** A test that fakes the read
resolving proves nothing — that is how the capability deleted in #627 died
unnoticed.

### Decided in this document

**1. File-linked chat already replicates. The granter needs no new push.**

> **Corrected by PR2.** The heading said "PR2 adds no push plumbing", which was
> true of the granter and false of the recipient. There was no share-view push
> lane at all. See "Recipient writes back".

`create_thread` journals a replication op unconditionally
(`crates/dohc-engine-domain/src/chats.rs:2572-2591`), payload
`{threadId, title, createdAtMs, linkedObjectId, linkedAtMs, linkedPathHint?}`.
`send_message` journals `chat.message.append` whenever the author carries a
user id (`chats.rs:3009`, `chats.rs:3030`) — the gate is a signed-in author,
not the thread's kind. A lazy backfill,
`ensure_thread_structure_exported` (`chats.rs:8361-8452`), exports a thread's
structure op the first time a message on it replicates, so the create always
precedes its messages in the log.

These ops land in `replication_log`
(`crates/dohc-engine-storage/src/migration.rs:973-984`) as
`ReplicationEnvelope { workspace_id, origin_id, origin_seq, op_kind, payload,
recorded_at_ms }` (`crates/dohc-engine-sync/src/model.rs:19-26`), drain to the
relay, and sit in `sync_relay_log`
(`services/sync-relay/src/storage.ts:295-307`), which stores the workspace's
whole log, not a per-share slice.

Independent proof they arrive: the relay's own thread resolver branches on
`record.linkedObjectId === undefined` and classifies a file-linked create as
"no shareable binding" (`storage.ts:1467-1476`). That branch exists because
those ops are in the log.

So the granter side is done. `filterOpForShare` simply never serves them: a
path selector admits only `workspace.init`, `moment.append` and
`version.create` (`shareFilter.ts:589-687`), and the chat-channel branch
refuses a `chat.thread.create` that carries `linkedObjectId` outright
(`shareFilter.ts:487`). A file-linked thread is therefore unservable through
any share today — which is the gap, not a guard to work around.

The recipient side is not done, and this document originally missed that. Only
MU-C4's `push_shared_channel` existed: no share-view push, no actor operation,
no RPC, no desktop client method. PR2 built the mirror rather than copying it —
one push body parameterized by a `SharePushScope` (`Channel` | `View`), so
both surfaces run the same scan, the same dense per-share origin sequence, and
the same batched POST.

**2. The relay resolves the current path from its own log.**

A stored `moment.append` payload carries both `objectId` and `path`
(built at `crates/dohc-engine-sync/src/outbound.rs:128-160`; fixture at
`services/sync-relay/src/shareFilter.test.ts:21-36`). A rename carries both
ends at once — `path` and `payloadAfterPath` are the destination, `beforePath`
and `payloadBeforePath` the source, and `objectId` is unchanged across it
(`crates/dohc-engine-domain/src/store.rs:357-395`). There is no separate move
op: a move is a rename, because the path changed
(`store.rs:805-811`; the three operations are `write`, `delete`, `rename`,
`crates/dohc-engine-domain/src/records.rs:41-60`). The relay already reads
well-known path fields from moment payloads by design
(`shareFilter.ts:20-25`).

So the relay can answer "where is this object now?" from data it already
holds. It does not need a new op kind, a new push, or a client's word.

**3. Across the share boundary a thread's link travels as a path, not an
object id.**

This is the one place the locked decisions meet a wall in the code. Decision E
is right about the *authorization* question — resolve the object to its current
path, test that path. It cannot describe the *wire*, because the served
`moment.append` deliberately drops the granter's `objectId`
(`shareFilter.ts:616-620`), so the recipient's share-view store mints its own
object ids. A granter object id means nothing on the recipient's side.

Therefore a chat thread served to a path share carries `linkedPath` — the
relay-resolved, selector-tested current path — and never `linkedObjectId` or
`linkedPathHint`. The recipient re-tests `linkedPath` against its pinned grant
and binds the thread to its own local object for that path
(`object_id_for_path`, `crates/dohc-engine-domain/src/store.rs:926`).

`linkedPath` is a new name for a new thing, and the naming carries the trust
rule: `linkedPathHint` means "a hint, captured once, do not trust";
`linkedPath` means "resolved by the relay from the owner's log and proven
inside the selector". Serving the path leaks nothing: the selector authorized
that path by name.

**4. A share view gets chat without getting a capture.**

A capture is a recorder. It records settled local file batches into the engine
(`workspaceActivity.ts:88-100`). A share view must never record local file
writes, so giving it a capture to unlock chat would be the wrong mechanism
wearing the right name.

The share view already has an engine store — `pull_share_view` writes into it
(`crates/dohc-engine-sync/src/relay.rs:1290-1420`). PR2 adds a second, narrower
resolver beside `requireEngineCapture`, not a widening of it. See
"Chat in a share view" below.

**5. A share view answers per-file chat only. It has no workspace-wide chat
listing.**

`listChatChannels` (`main.ts:6723-6782`) is the workspace-wide surface: every
channel and every file thread in one response. A share view must never expose
the workspace's channel list (#627). Rather than filter that surface for share
views, PR2 does not route it to them at all. A share view answers
`listFileChats` and `listChatMessages` for a file the viewer already has open —
a file whose path the selector authorized before the file was ever served.

This removes the whole class of leak instead of filtering it, and it makes
"no listing surface is left unfiltered" true by construction rather than by
audit.

**6. Chat lands in the share VIEW in PR2. Share mounts get no chat.**

A share view's paths are the granter's paths. A mount's are not: a mount
materializes under `shared-with-me/<label>/`
(`apps/desktop/src/workspaces/shareMounts.ts:19-27`). The wire carries the
GRANTED path in both cases, so a mount can gain chat later without a contract
change. It does not gain it in PR2.

**7. In PR1 every level still refuses every write, with one code.**

If PR1 let a comment-level share past the append route's level gate, every op
would then fail `filterOpForShare` and return `share_op_rejected` — a different
code from `share_read_only`, which would tell a probing recipient that the
selector is comment-or-edit rather than view. That breaks decision C's
anti-fingerprinting property.

So PR1 keeps the append route refusing every path selector with
`shareNotAppendable()` whatever its level. PR2 opens comment and edit. The PR1
UI states this plainly rather than offering a level that does nothing extra.

**8. Agent-authored chat messages do not cross a share, and PR2 does not change
that.**

`chat.message.append` replicates only when the author carries a user id
(`chats.rs:3009`), and the sibling ops carry the same gate:
`chat.reaction.set` needs `replication_author_id` plus an authored message in
the log (`chats.rs:3163-3168`), and `chat.decision.set` needs the same
(`chats.rs:8282`). An agent-authored message never reaches `replication_log`,
so it can never reach a share recipient.

This collides with dohc's own posture — agents are participants, and a
discussion about a shared file will often contain their words. It is not a
share bug: the gate is upstream, in what replicates at all, and it applies to
the owner's second machine exactly as it applies to a share recipient. PR2
inherits it, states it in the PR body, and does not widen replication to fix
it. Widening it is its own decision about agent identity on the wire, and it
belongs with the identity model, not with access levels.

**9. The receiver-private chat ops are never served.**

`chat.follow.set` and `chat.feed.read.set` (`router.rs:78-79`) are the reader's
own state. The channel branch already excludes them by falling through to its
terminal deny, with the reason written at `share.rs:222-226`. The new file-chat
branch excludes them the same way: an allowlist of five kinds, and everything
else denied.

## What each level does, per PR

The table at the top is the destination. This is the truth at each stop, and
the UI must not run ahead of it.

| | PR1 | PR2 | PR3 |
| --- | --- | --- | --- |
| View | read files | read files, read chat | unchanged |
| Comment | read files | read files, read and write chat | unchanged |
| Edit | read files | read files, read and write chat | write files too |

In PR1 all three levels grant exactly what a share grants today. The level is
carried, validated, stored, served, pinned, twin-tested, and shown on both
sides — and the create dialog offers only View, with Comment and Edit visible
and disabled. A relay client may still create a comment or edit share; the
route accepts it and the gates key on it. That is what makes PR1's level
plumbing testable before its rights exist.

## Chat follows paths, and only paths

> **Corrected by PR2**, after review. This document assumed every file share
> names paths. A VERSION share does not, and the containment rule reads an
> empty path list as "every tracked path" — bounded for files by the version
> check, unbounded for chat, which has no version to check. A version share
> would have carried the live discussion about every file on main, including
> files created long after the version and never in it.
>
> So: a selector with no paths carries NO chat, in either direction, at any
> level. The relay refuses it, the recipient's boundary refuses it, and the
> append lane refuses it. A version share is a snapshot of files; the
> conversation is not in the snapshot.

## The chat-over-share mechanism (PR2)

### Pipeline, end to end

1. **Granter's daemon → relay.** Already works. `chat.thread.create` with
   `linkedObjectId` (`chats.rs:2572-2591`) and `chat.message.append`
   (`chats.rs:3009-3040`) drain into `sync_relay_log`.
2. **Relay serve.** `filterOpForShare` gains a file-linked chat branch for path
   selectors. It resolves thread → object → current path, tests the path
   against the selector, and rewrites the served payload.
3. **Recipient pull.** `pull_share_view` (`relay.rs:1290`) routes chat ops
   through a new transactional branch of the ShareView boundary, then applies
   them with `apply_chat_tx`.
4. **Recipient read.** Main resolves a share chat scope instead of a capture,
   and answers `listFileChats`/`listChatMessages` from the share view's own
   store.
5. **Recipient write → relay.** POST `share-log`, mirroring MU-C4 exactly:
   same authorship check, same per-op filter, same share-namespaced origin,
   same transactional revoke guard.
6. **Relay → granter.** Accepted ops sit in the owner's bucket under
   `share:<shareId>:<originId>` and reach the granter over the owner lane —
   the lane MU-C4 already uses (`server.ts:452-455`).

### The relay's two new resolvers

> **Corrected by PR2.** The first resolver's shape was wrong. It could not
> describe a thread the RECIPIENT created, and that thread then died after its
> first batch — see the note under the signature.

Both mirror `findThreadCreateChannelWireId` (`storage.ts:1437-1477`): the same
tri-state, the same earliest-wins rule, the same per-request memoization in
`chatResolverFor` (`server.ts:199-216`).

```
threadFileBinding(workspaceId, threadId): ThreadFileBinding | null | undefined
  // From the EARLIEST chat.thread.create for threadId:
  //   {kind:"object", objectId}  -> the granter's own op
  //   {kind:"path", path}        -> a recipient's op, pushed back
  //   null       -> an authoritative create exists with no file link
  //   undefined  -> no create in the log

objectCurrentPath(workspaceId, objectId): string | null | undefined
  //   string    -> path of the LATEST moment.append for objectId
  //   null      -> the latest moment's operation is "delete"
  //   undefined -> the relay has never seen this object
```

A thread create carries its file one of two ways, and one resolver has to
answer for both. A recipient's create names the granted PATH, because its own
object ids mean nothing to the relay, and that is the payload the relay stores.
A resolver that returned only an object id would answer `null` for such a
thread, and every later message on it would be denied — so a recipient could
open a thread, post one message in the same batch, and be refused from then on.

The `delete` case denies. Hiding the discussion about a deleted file is the
fail-closed answer and the simple one to state.

Earliest-wins on the thread binding mirrors the engine's insert-if-absent apply
and is what stops a forged re-create from re-binding an existing thread into a
share — the same reasoning already written at `storage.ts:1467-1471`.

Latest-wins on the object path is correct for the opposite reason: a rename is
a later fact about the same object, and the share must follow the file, not its
history.

**Storage shape.** Do not implement `objectCurrentPath` as a `LIKE` scan.
`chat.thread.create` rows are a tiny slice of a log; `moment.append` rows are
most of it, and the partial-index trick at `storage.ts:310-320` would confine
nothing. Take the upgrade path that comment already names and build the table
at insert time:

```sql
CREATE TABLE IF NOT EXISTS sync_relay_object_paths (
  workspace_id TEXT NOT NULL,
  object_id    TEXT NOT NULL,
  path         TEXT,          -- NULL when the latest moment deletes it
  relay_seq    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, object_id),
  FOREIGN KEY (workspace_id)
    REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
);
```

`appendLogBatch` (`storage.ts:1135`) upserts a row for every inserted
`moment.append` that carries an `objectId`, guarded by `relay_seq` so an
out-of-order insert cannot move a path backwards. The lookup is then a primary
key read.

Fail closed everywhere: `undefined` or `null` from either resolver denies.

### The relay's chat branch for path selectors

New function beside `filterChatOpForChannelShare`, called from
`filterOpForShare` before the `moment.append` branch when `opKind` starts with
`chat.`:

```
filterFileChatOpForPathShare(selector, opKind, payload, chat):
  path = null
  if opKind == "chat.thread.create":
      objectId = payload.linkedObjectId            // absent -> deny
      path = chat.objectCurrentPath(objectId)      // null/undefined -> deny
  else if opKind in {chat.message.append, chat.reaction.set,
                     chat.decision.set, chat.attachment.add}:
      threadId = payload.threadId                  // absent -> deny
      objectId = chat.threadLinkedObjectId(threadId) // null/undefined -> deny
      path = chat.objectCurrentPath(objectId)      // null/undefined -> deny
  else: deny
  if not pathVisibleThroughShare(selector, path): deny
  serve the allowlisted payload
```

`pathVisibleThroughShare` (`shareFilter.ts:298-307`) is reused unchanged. It
already re-classifies the path and refuses anything not engine-tracked, so
secret gate #2 covers the chat lane for free.

Served payloads, by the same `pickServed` allowlist posture the channel branch
uses (`shareFilter.ts:431-440`):

| Op | Served fields |
| --- | --- |
| `chat.thread.create` | `threadId`, `title`, `createdAtMs`, `linkedAtMs`, plus `linkedPath` set to the resolved path |
| `chat.message.append` | `messageId`, `threadId`, `authorKind`, `authorDisplayName`, `authorUserId`, `parentMessageId`, `body`, `createdAtMs` |
| `chat.reaction.set` | `reactionId`, `messageId`, `threadId`, `emoji`, `authorId`, `authorKind`, `authorDisplayName`, `state`, `atMs` |
| `chat.decision.set` | `threadId`, `messageId`, `state`, `resolvedByMessageId`, `atMs` |
| `chat.attachment.add` | `attachmentId`, `threadId`, `messageId`, `targetKind`, `createdAtMs` |

Every decision returns `blobSha256s: []`. The share-blob route relies on that —
its comment states chat ops are blob-free (`server.ts:491`) — so a file-chat
branch that exposed a hash would silently widen blob access.

`linkedObjectId` and `linkedPathHint` are never served. The attachment row is
the opaque chip the channel branch already serves
(`shareFilter.ts:545-557`) — its `objectId`/`pathHint` could name a file
outside the share, so they stay dropped and the recipient renders a chip it
cannot follow.

**Decided: recipients of overlapping shares see each other's comments.**
Two people independently granted overlapping paths read the same discussion
about the same file, including each other's display names and user ids. This
matches what a commenter on a shared document already expects — the people
commenting on a document see who else commented — and it is what makes the
discussion a discussion rather than a set of private notes. It is recorded
here because it is a disclosure between recipients who were never told about
each other, and a reader deserves to find it stated rather than infer it.

**Two residuals the rename rule leaves, both accepted.**

A thread the RECIPIENT created is bound by path, and the relay re-proves that
path against its log on every serve. That closes the rename, but leaves this:
a NEW file later created at the same path re-attaches the old discussion to
it. The path is inside the selector either way, so this is mis-association,
not disclosure — the recipient sees a conversation about a file that is no
longer the file it was about.

And the recipient's own copy goes stale. A rename that crosses the share
boundary is not served at all (the moment rule refuses it in both directions),
so the recipient's store keeps the old path and its local boundary keeps
admitting ops for it. The relay's denial is the authority: nothing further is
served or accepted, and the stale local copy simply stops receiving.

**Known limitation, stated on purpose.** A file renamed out of the selector
stops serving its threads at the moment of the rename, and the recipient keeps
what it already replayed. This matches the existing moment rule and its
recorded limitation (`shareFilter.ts:607-612`). A file renamed INTO the
selector starts serving its threads, including ones created before the rename,
because `objectCurrentPath` is a present-tense answer. Say this in the PR.

### The recipient's boundary (Rust)

`enforce_share_view_boundary` (`share.rs:265-330`) today refuses every chat op
by kind: a chat op is an owned kind, so it returns `ShareBoundaryViolation`
(`share.rs:296-303`). PR2 replaces that blanket refusal with a branch, and the
branch cannot stay where it is.

`apply_shared_envelope` validates a ShareView **before** the transaction and
then returns `Applied` without touching the store (`share.rs:112-116`), because
file ops need no store state. Chat ops do: `chat.message.append` carries no
path, only a `threadId`. This is precisely the situation the SharedChannel path
already documents and solves — "these carry no channel field: resolve the
binding in-store" (`share.rs:208-224`).

So:

- `chat.thread.create` is validated **before** the transaction: require
  `linkedPath`, require it to classify `Tracked` and sit inside the pinned
  grant, and refuse the op outright if it carries `linkedObjectId` or
  `linkedPathHint` — shapes a share never carries, and a relay offering one is
  offering something this boundary must not place.
- the four thread-scoped ops are validated **inside** the transaction:
  `threadId` → local `chat_threads.linked_object_id` → that object's current
  local path → inside the pinned grant. Unresolved denies. Write this as a
  sibling of `thread_bound_to_wire` (`share.rs:230-256`), not a generalization
  of it.
- application uses `apply_chat_tx`, the call the SharedChannel path already
  makes (`share.rs:140`).

The `debug_assert!` at `relay.rs:1364-1367` asserts share-view application
never mutates chat dependencies. It becomes false. Replace it, do not delete
it: assert instead that a share-view chat op produced no *replay* refusals of
the file kind, so the assertion still guards something.

An op whose thread or file is not yet local is refused and recorded through the
existing `ShareViewRefusal` lane (`relay.rs:1385-1399`), which already exists to
make a skip visible rather than silent. No new failure surface.

### Chat in a share view (main process)

Today `requireEngineCapture(workspaceId, "Chats")` (`main.ts:5751-5765`) is the
only barrier, and it throws for every share view. Replace the *call site*
pattern, not the gate:

```ts
type ChatScope =
  | { kind: "workspace"; workspace: Workspace; capture: WorkspaceEngineCapture }
  | { kind: "share"; workspace: Workspace; store: LinkedChatStore;
      access: ShareAccess; selector: ShareViewSelector };

async function requireChatScope(workspaceId: string): Promise<ChatScope>
function assertChatWritable(scope: ChatScope): void  // share: access must be comment|edit
```

`requireChatScope` returns today's capture scope for a local workspace by
calling `requireEngineCapture` unchanged, and the share scope for a share view.
`assertChatWritable` throws the file-share sibling of the existing read-only
error (see "Refusals" below) unless the scope names `comment` or `edit`.

> **Corrected by PR2.** This said "when a share scope is View", and a share
> scope can name no level at all: a damaged share record keeps its restrictive
> marker and loses its level. Refusing only `view` would then read an
> unreadable grant as one that allows writes. Every level test in PR2 asks
> instead whether the level IS `comment` or `edit`, and main validates the
> stored value with `isShareAccessValue` rather than trusting the record's
> type. The renderer's per-file panel takes the decision as a boolean, not the
> level, because the level is the part that can go missing.

A share scope also carries the account the recipient writes chat under. A share
view is not an enrolled workspace: it has no `remote`, so the workspace rule
resolves no author id, and a chat op replicates only when its author carries
one. Without this the write would look sent and never leave the machine, so
`assertChatWritable` refuses when no identity resolves.

Handlers reachable from a share view in PR2, and no others:

| Handler | Anchor | Share view |
| --- | --- | --- |
| `listFileChats` | `main.ts:6284` | all levels |
| `listChatMessages` | `main.ts:6484` | all levels |
| `markChatThreadRead` | `main.ts:7098` | all levels — writes local read state only, never replicated |
| `createFileChat` | `main.ts:6460` | comment, edit |
| `sendChatMessage` | `main.ts:6500` | comment, edit |
| `setChatReaction` | `main.ts:7173` | comment, edit |
| `resolveChatDecision` | `main.ts:6587` | comment, edit |

Everything else — `listChatChannels`, `startChannelThread`, `createChatChannel`,
`shareChatChannel`, `startDm`, `listChatChannelShares`, `listPersonalChatFeed`,
`syncDms`, agent dispatch — keeps `requireEngineCapture` and stays refused in a
share view.

`listFileChats` resolves the file's object through the SHARE VIEW's own store,
and the file it names is one the share already served. There is no superset to
filter: an out-of-selector thread was never served by the relay
(decision 2 above) and never applied by the Rust boundary. The client is not
the authority here and must not be written as though it were.

### Recipient writes back

Relax the append gate at `server.ts:411-412` to:

```ts
const appendable =
  (isChatChannelSelector(share.selector) && share.selector.access === "read-write") ||
  (!isChatChannelSelector(share.selector) &&
    (share.selector.access === "comment" || share.selector.access === "edit"));
if (!appendable) throw shareNotAppendable();
```

One code for every refusal, as today. Everything downstream is unchanged in
shape: `assertChatAuthorship` (`server.ts:419`), the per-op
`filterOpForShare` with whole-batch atomic rejection (`server.ts:434-450`), the
share-namespaced origin (`server.ts:452-455`), and the transactional guard that
re-runs the full gauntlet inside `BEGIN IMMEDIATE` (`server.ts:464-469`) — the
guard's re-check gains the same level test.

The batch-aware binding map (`server.ts:424-432`) gets a path sibling: a
`chat.thread.create` earlier in the batch establishes `threadId → linkedPath`
for later ops in the same batch, and the log's earliest binding always wins
over the batch.

A recipient-created thread pushes `chat.thread.create` carrying `linkedPath`,
not `linkedObjectId` — the recipient's object id is local and meaningless to
the granter. The relay validates that path against the selector directly, with
no resolver hop. On the granter's side, applying that op means binding the
thread to the granter's own object for that path.

> **Corrected by PR2.** Two things this section assumed did not exist.
>
> There was no lane to push through. PR2 adds `push_share_view`, a
> `PushShareView` actor operation, a `share.view.push` RPC, and a
> `pushShareView` client method, all sharing MU-C4's body through
> `SharePushScope`.
>
> And the granter could not apply the op. MU-C4 needed no granter-side branch
> because `apply_thread` already resolves a channel thread's wire shape
> through `resolve_or_create_placeholder`. `linkedPath` had no such rule, so
> PR2 adds its file sibling, `linked_object_for_apply`, in the same function.
> One rule serves both directions: the recipient replaying the granter's thread
> and the granter applying the recipient's.

## Enforcement table

Server-side means the surface decides and a lying client cannot win. UX mirror
means the surface only reflects a decision made elsewhere; it may be wrong
without being a vulnerability.

| Surface | View | Comment | Edit | Class | Anchor |
| --- | --- | --- | --- | --- | --- |
| Share-log GET (which ops are served) | files only in PR1; files + in-selector file chat in PR2 | same | same | server-side | `shareFilter.ts:572` |
| Share-log POST (recipient append) | refuse | refuse in PR1, chat ops in PR2 | refuse in PR1, chat ops in PR2, moments in PR3 | server-side | `server.ts:408-412` |
| Recipient pull boundary | pinned grant + level | pinned grant + level | pinned grant + level | server-side (defence in depth) | `share.rs:265` |
| Presence topics | in-selector paths | same | same | server-side | `shareFilter.ts:355` |
| Blob fetch | only hashes an admitted op exposed | same | same | server-side | `server.ts:481-509` |
| Chat scope in main | read | read + write | read + write | server-side (main is the trust boundary) | `main.ts:5751` |
| `assertWritableWorkspace` on document writes | refuse | refuse | allow in PR3 | server-side | `main.ts:677-683` |
| MCP `--read-only` | set | PR2 splits: document-write tools off, chat-write tools on | PR3: both on | server-side (the tool is never registered) | `mcp/src/server.ts:100-102` |
| Editor `readOnly` prop | true | true | false in PR3 | UX mirror | `DesktopWorkspaceShell.tsx:4536` |
| Native Explorer menu reduction | reduced | reduced | full in PR3 | UX mirror of a main-owned menu | `main.ts:3776-3800` |
| Recipient banner copy | read-only in PR1, unchanged after | read-only in PR1, states chat from PR2 | read-only until PR3, then states edit | UX mirror, phased with the rights | `DesktopWorkspaceShell.tsx:4056-4120` |
| Level badge on share rows | shows level | shows level | shows level | UX mirror — a level name is a fact, not a promise, so it ships in PR1 | `SharedByMeList.tsx`, `SharedWithMeList.tsx` |

The MCP row is the one that needs care. `--read-only` today suppresses eleven
tools in one list (`packages/mcp/src/server.test.ts:7-20`), and two of them are
chat writes: `dohc_start_channel_chat` and `dohc_reply_to_chat`. PR2 splits the
list into document-write and chat-write tiers. Note that MCP chat tools reach
the desktop through the CLI (`packages/mcp/src/tools.ts:2717`), so main's gate
is the authority either way — the flag decides what an agent is offered, not
what it is allowed.

## Refusals

Decision C says reuse the vocabulary. The chain, unchanged in shape:

1. Relay throws `shareNotAppendable()` → `share_read_only`, HTTP 403
   (`server.ts:1442-1449`, `errorCodes.ts:26`).
2. Rust HTTP client maps the code to `RelayError::ShareReadOnly`
   (`crates/dohc-engine-sync-http/src/lib.rs:731`).
3. The engine maps it to the wire error `share-read-only`
   (`crates/dohc-workspace-engine/src/lib.rs:11340-11342`).
4. `translateRelayError` (`apps/desktop/src/workspaces/engineRelayClient.ts:471-500`)
   picks the error class by method. It gains a branch for the file-share chat
   push beside the existing `share.channel.push` branch.

PR2 adds one class beside `SharedChannelReadOnlyError`
(`packages/workspace-contracts/src/relay.ts:166-171`):

```ts
export class SharedFileReadOnlyError extends Error {
  message = "This shared file is read-only for you.";
  name = "SharedFileReadOnlyError";
}
```

Same words, same family, the noun the UI already uses for the thing. The
main-process pre-flight check (`assertChatWritable`) throws the same class
before any durable write, mirroring `assertSharedChannelWritable`
(`apps/desktop/src/workspaces/sharedChannels.ts:205-215`).

## UI

Copy follows `docs/brand/copy.md`: sentence case, no terminal period on labels,
one instruction per sentence, the noun the UI already uses.

### Create dialog — `apps/desktop/src/renderer/RelayShareDialog.tsx`

The dialog today hardcodes "as a read-only live view" (`RelayShareDialog.tsx:91-98`).
Replace with a level picker above the email field.

Label: `Access`

Options and their helper lines (PR1):

| Option | State in PR1 | Helper line |
| --- | --- | --- |
| `View` | selected, enabled | `They can read what you selected.` |
| `Comment` | disabled | — |
| `Edit` | disabled | — |

One line under the picker while any option is disabled:

> `Comment and Edit are not ready yet.`

PR2 enables Comment and sets its helper to
`They can read what you selected and chat about it.`
PR3 enables Edit: `They can read, chat, and edit what you selected.`

The sentence after the picker keeps its current job and drops the level claim:

> `They see what you selected — nothing else — and your later edits arrive when
> they refresh.`

### Granter's list — `apps/desktop/src/renderer/settings/SharedByMeList.tsx`

Each row shows the level, using the pattern chat shares already use for their
badge (a small subtle span, `ChatsView.tsx:5294-5296`). Unlike the chat badge,
show it for every row — a level that is only sometimes displayed teaches the
reader nothing when it is absent.

Badge text: `View`, `Comment`, `Edit`.

### Recipient's list — `apps/desktop/src/renderer/settings/SharedWithMeList.tsx`

Same badge on received rows. The level is the recipient's own right and belongs
on the recipient's surface; the relay already serves received rows without the
granter's workspace id (`server.ts:256-258`), and the level does not widen that.

### Recipient banner — `DesktopWorkspaceShell.tsx:4056-4120`

The banner phases with the RIGHTS, not with the level field. Each sentence
ships in the PR that makes it true.

**PR1 — one string, every level:**

> `Shared view from {granter} — read-only. Ask {granter} for changes.`

This is the existing line, unchanged. It is true at all three levels in PR1,
because all three grant exactly read there. A per-level banner in PR1 would
promise chat that the append route still refuses at every level — the UI
running ahead of the truth table, which the table at the top of this document
exists to stop. The level is still visible to the recipient in PR1: the BADGE
on the received row states it, because a level name is a fact about the grant
while the banner sentence is a promise about rights.

**PR2 — Comment gains its sentence, with its rights:**

| Level | Banner |
| --- | --- |
| View | unchanged from PR1 |
| Comment | `Shared view from {granter}. You can chat about these files, not edit them.` |
| Edit | unchanged from PR1 until PR3 |

**PR3 — Edit gains its sentence, with its rights:**

> `Shared view from {granter}. You can edit these files and chat about them.`

The ended-share line is unchanged in every phase: `This share was ended by
{granter}. Your copy stays readable but won't update anymore.`

A share whose stored grant cannot be read states that instead, and offers the
one step that fixes it: `dohc can't read what this share grants. Open the
share again to restore it.` It shows no level, and skips the refresh it has no
grant to run.

### Open flow — `apps/desktop/src/renderer/OpenSharedView.tsx`

Both mode descriptions promise read-only today (lines 154-155), which becomes a
lie at Edit. The level is not known until the share info loads, so remove the
claim from the mode descriptions and let the banner state the right after open.

| Mode | Copy |
| --- | --- |
| mount | `The shared files appear in this workspace under shared-with-me/.` |
| separate | `You get a separate view of the shared files.` |

### Share-view chat surface (PR2)

`DesktopWorkspaceShell.tsx:4457-4469` renders a terminal placeholder for Chats
in a share view: `A shared view has no chats. Close this tab to go back to the
shared files.` PR2 does not turn the Chats tab on — decision 5 gives a share
view no workspace-wide chat listing. Chat appears on the open file.

> **Corrected by PR2.** There was no per-file chat surface to appear on. One
> flag, `engineSurfacesExist = engineEnabled && !isShareView`, gated the Chats
> sidebar, the titlebar button, `Ctrl+Alt+B`, and the palette command, and
> `#615` pinned all four as absent. PR2 derives `chatsSurfaceExists` and opens
> them for a share view, restricted to the file tab, and evolves those pins
> rather than deleting them: the property they protected — a share view never
> reaches the workspace-wide listing — is asserted directly now.
>
> The placeholder's words also stopped being true, so PR2 rewrites them. A
> shared view has chat; what it has no listing of is every conversation in the
> workspace.

At View level, the composer on a shared file is disabled with the refusal
words: `This shared file is read-only for you.`

## Shard specs

### PR1 — the level, end to end

**Relay.**

1. `services/sync-relay/src/shareFilter.ts`: add
   `SHARE_ACCESS_VALUES = ["view", "comment", "edit"] as const` and
   `type ShareAccess`, beside the chat constants at line 48. Add
   `access: ShareAccess` to `ShareSelector` (line 33-40), required.
2. `validateShareSelector` (line 168): accept `access?: unknown` and require a
   member of `SHARE_ACCESS_VALUES`; refuse anything else — a missing level
   included — with `RELAY_ERRORS.invalid_access`. Return it on the selector.
   (Amended: see decision B. There is no create-time default.)
3. `parseShareSelectorJson` (line 255): require `access` to be a member of
   `SHARE_ACCESS_VALUES`; return `null` otherwise — the same rule create
   applies, so no boundary invents a level for a row that never named one.
   Every stored path-share row without the field fails closed to the generic
   404. That is intended (decision G) and must be said in the PR body.
4. `services/sync-relay/src/server.ts`: the create route (line 616-726) reads
   `input.access` and passes it to `validateShareSelector`. `shareSummary`
   (line 229-264) returns `access` on granted and received rows.
5. `server.ts:411-412`: keep refusing every path selector, now expressed as
   "path selectors do not accept appends yet" rather than "this is not a chat
   selector". Behaviour and code unchanged (decision 7).

**Rust.**

6. `crates/dohc-engine-sync/src/share.rs`: add
   `enum ShareAccess { View, Comment, Edit }` and `access: ShareAccess` to
   `ShareGrant` (line 85-97). NEITHER type derives `Default`. A default level
   is a level nobody granted, and "never a grant source" written in a comment
   is a rule asking to be believed; with no derive the compiler enforces it,
   and every construction — tests included — states its level.
7. Parse the level where the recipient pins the selector, and refuse an
   unparseable one — a grant whose level cannot be read is not a narrower
   grant, it is an unreadable one.
8. `crates/dohc-engine-sync/tests/security_contract.rs`: add a level vector
   list to the generated TS oracle fixture. Both sides must accept exactly
   `view`, `comment`, `edit`, and refuse everything else including case
   variants and padded values.

**Desktop.**

9. `apps/desktop/src/workspaces/shareViewInfo.ts`: `ShareViewSelector` gains
   `access`; `parseSelector` (line 68-106) requires it and throws
   `ShareSelectorInvalidError` when it is missing or unknown. This parser
   already refuses to widen on anything unreadable; keep that posture.
10. `apps/desktop/src/ipc/bridgeContract.ts`: `RelayShareSelector` (line
    2438-2443) gains `access: z.enum(["view","comment","edit"])`;
    `CreateRelaySharePayload` (line 2481-2487) gains a required `access`;
    `WorkspaceSummary.shareView` (line 163-178) gains `access`.
11. UI: the picker, the two badges, the PR1 banner string, and the
    OpenSharedView rewrite — all as specified above. The banner keeps its
    single read-only line at every level; the Comment and Edit sentences ship
    with their rights in PR2 and PR3 (see the banner section).

**Not in PR1**: any change to `mcpConfigFor`, the editor `readOnly` prop, the
native menu, or any chat handler.

### PR2 — chat follows the share

**Relay.**

1. `storage.ts`: the `sync_relay_object_paths` table, its upsert inside
   `appendLogBatch` (line 1135), and `objectCurrentPath`.
2. `storage.ts`: `threadLinkedObjectId`, built like
   `findThreadCreateChannelWireId` (line 1437-1477).
3. `server.ts:199-216`: `chatResolverFor` gains both methods, memoized per
   request like the existing two.
4. `shareFilter.ts`: `filterFileChatOpForPathShare`, wired into
   `filterOpForShare` (line 572) for path selectors.
5. `server.ts:408-450`: the append gate accepts comment and edit path selectors;
   the batch binding map gains its path sibling; the transactional guard
   (line 464-469) re-checks the level.

**Rust.**

6. `share.rs`: the chat branch of `enforce_share_view_boundary`, split into a
   pre-transaction check for `chat.thread.create` and an in-transaction check
   for the four thread-scoped kinds; `apply_chat_tx` on the ShareView path.
7. `relay.rs:1364-1367`: replace the `debug_assert!`.

**Desktop.**

8. `requireChatScope` / `assertChatWritable` in `main.ts`, and the seven
   handlers from the table above.
9. `SharedFileReadOnlyError` in `packages/workspace-contracts/src/relay.ts`,
   and its branch in `translateRelayError`
   (`engineRelayClient.ts:471-500`).
10. Consolidate the objectId→path resolution (below).
11. MCP: split `registerWrite` into document and chat tiers
    (`packages/mcp/src/server.ts:100-102`); `mcpConfigFor`
    (`main.ts:1669-1715`) takes the level instead of a boolean.

**objectId→path consolidation.** There are three implementations
(`workspaceEngineCapture.ts:5579`, `main.ts:6752-6766`, and the mentions path
at `main.ts:6318`), but a shared helper already exists:
`activeEngineFileIndex` (`main.ts:2041-2054`), used by the mentions path and by
`main.ts:4117`.

- Collapse `main.ts:6752-6766` into `activeEngineFileIndex`. It builds the same
  map from the same source for no reason.
- Leave `workspaceEngineCapture.ts:5579` alone. It is a capture-scoped single
  lookup on a different layer, with one caller (`cli/cliServer.ts:1598`), and
  rewriting it is scope creep this PR does not need.
- Do **not** put the selector check inside any path resolver. The relay and the
  Rust boundary are the authority; the client filters nothing because it
  receives nothing out of selector.

### PR3 — Edit, sketched

Not designed here. See the sketch below.

## Test plan

Every refusal below is driven through the real boundary. For each new gate, run
the inverse mutation — delete the gate line, confirm a named test fails — and
record the result in the PR body. A gate with no failing mutation is not
covered.

**Relay HTTP (`services/sync-relay/src/`).**

- `shareFilter.test.ts`: level validation and round trip; a stored row missing
  `access` parses to `null`; unknown levels refused.
- `shares.test.ts`: create at each level; the summary rows carry it; a comment
  share's POST is refused in PR1 with `share_read_only`, and a view share's is
  refused with the same code and body in PR2 — assert the bodies are identical,
  which is the anti-fingerprinting property itself.
- `shareFilter.test.ts` (PR2): a thread on an in-selector file is served; a
  thread on an out-of-selector file is not; a message whose thread resolves
  outside is not; a `chat.thread.create` carrying `linkedObjectId` is served
  with `linkedPath` and without `linkedObjectId` or `linkedPathHint`.
- `shareFilter.test.ts` (PR2): `chat.follow.set` and `chat.feed.read.set` are
  refused for a path selector at every level. These are the reader's own state
  and the allowlist must not grow to fit them.
- `crossUserIsolation.test.ts`: the leak shape this file already uses — put a
  `SENTINEL-OUT-OF-SELECTOR` title on a thread linked to a file outside the
  selector, drive the real share-log GET, and assert the sentinel appears in no
  response body. Add a rename case: append a real rename moment that moves a
  file out of the selector, then re-fetch and assert its threads stop.
- `server.test.ts` (PR2): a comment recipient's POST is accepted; the same POST
  after revocation loses the transactional guard race and returns the generic
  404; an op naming an out-of-selector thread rejects the whole batch.

**Rust (`crates/dohc-engine-sync/`).**

- `tests/security_contract.rs`: the level twin vectors.
- `src/tests.rs`, beside the existing ShareView cases at 5044-5470: a chat op
  for a file outside the pinned grant is refused with `ShareBoundaryViolation`;
  a `chat.message.append` whose thread is unknown locally is refused; a
  `chat.thread.create` carrying `linkedObjectId` or `linkedPathHint` is
  refused; an in-grant chat op applies and is readable from the store
  afterwards.

**Main process (`apps/desktop/src/`).**

- `main.chatSecurity.test.ts` evolves. Its `#627` pin at line 616-642 asserts
  that `requireEngineCapture` precedes every store and sync seam. That property
  must survive under a new name: assert `requireChatScope` precedes every seam,
  for the same handler list plus the seven share-reachable handlers. Add a pin
  that every mutation handler calls `assertChatWritable` before any store call.
  Do not delete the file's existing assertions about
  `assertWritableWorkspace` — a share view is still not a writable workspace
  for documents.
- Source-scan pins prove position, never behaviour. Pair each with a
  behavioural test in `mainChatIpcHandlers.test.ts`, which the security test
  itself defers to for exactly this reason (`main.chatSecurity.test.ts:600-602`).

**MCP (`packages/mcp/src/server.test.ts`).**

- Split `WRITE_TOOLS` (line 7-20) into `DOCUMENT_WRITE_TOOLS` and
  `CHAT_WRITE_TOOLS`. Assert a comment profile registers the chat tier and not
  the document tier, and that a view profile registers neither.

**End to end.**

- One desktop e2e in PR2: a recipient opens a Comment share, posts a message on
  a shared file, and the granter's app shows it. Stage
  `dohc-workspace-engine.exe` into `apps/desktop/target/debug` first, and do not
  run it concurrently with another e2e lane — they collide on the Electron
  user-data dir.

## PR3 — Edit, honest sketch

Edit is the only level that needs a recipient to write into someone else's
workspace. S1 built the outbound drain that turns a local write into a
`moment.append` envelope with blobs, and MU-C4 built the lane a non-owner
writes through. Neither is sufficient on its own.

What PR3 must still solve:

1. **Blob upload by a non-owner.** The relay's blob PUT is an owner surface. A
   recipient's moment references a blob the relay does not have. Accepting it
   means letting a recipient consume the granter's storage — a bounded,
   quota-shaped decision, not a plumbing one.
2. **Accepting `moment.append` from a recipient.** The read branch tests paths
   against the selector and can be reused for that half. The author half
   cannot: the relay drops the author on serve (`shareFilter.ts:616-620`) and
   would have to stamp the member's server-derived identity on accept, the way
   `assertChatAuthorship` does for chat.
3. **Applying a foreign moment on the granter's side.** Ops land in the owner's
   bucket under `share:<id>:<origin>` and reach the granter over the owner
   lane. A file moment then touches the file tree and possibly a live Y.Doc
   session, which the product invariants make canonical while it is open. Two
   accounts editing one file with no shared session is the S4 base-arbitration
   problem again, across a trust boundary.
4. **Whether a recipient's write should land at all, or land as a proposal.**
   Agent writes must respect user locks, path access, sharing boundaries, and
   review gates. A foreign account's silent write into a workspace is a product
   decision above this shard's pay grade.

Recommendation: PR3 opens with its own one-page design gate for Ice, exactly as
S4 did, and does not start until the write-back model is chosen. The levels
work does not need PR3 to be useful — View and Comment are the two levels a
person reaches for when they send someone a document.

## Rejected alternatives

- **A separate `role` field beside `access` on chat-channel shares** — two
  names for one concept, and term drift is dohc's most expensive failure.
- **Reusing `ChatShareAccess` for files** — its two values mean channel rights;
  a shared enum would make "read-only" mean two different things.
- **A new comment/annotation op kind** — decision D; chat threads already are
  the discussion about a file, and a second primitive would need its own
  filter, its own boundary, and its own UI.
- **Trusting `pathHint` for authorization** — it is a display snapshot captured
  at link time and never re-resolved (`engine.ts:1190-1194`).
- **Serving the granter's `objectId` to bind threads** — the recipient's store
  mints its own object ids, and widening the moment payload to carry the
  granter's would undo a deliberate redaction.
- **A `LIKE` scan for `objectCurrentPath`** — `moment.append` is most of the
  log; the partial-index trick that works for thread creates confines nothing
  here.
- **Filtering `listChatChannels` for share views** — filtering a workspace-wide
  listing is the shape that produced #627; not routing it is smaller and
  safer.
- **Giving a share view a real capture to unlock chat** — a capture is a
  recorder of local file writes, which is exactly what a share view must never
  have.
- **Letting comment and edit shares past the PR1 append gate** — the second
  error code would fingerprint the selector's level.
- **Shipping the level picker only in PR2** — then PR1's level is invisible to
  the granter, and "both sides can see the level" waits a whole PR for no
  benefit.
- **Chat on share mounts in PR2** — a mount's paths are rewritten under
  `shared-with-me/<label>/`; the wire already carries the granted path, so the
  mount can gain chat later without a contract change.
