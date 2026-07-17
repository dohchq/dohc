# BEHAVIOR_DELTA.md — engine drift since the inventory baseline

Reconciliation record for the "integrate, not discard" freeze rule. This file
records engine behavior that landed on `main` after the rewrite inventory was
written, so the owning shards can absorb it when they port. It does NOT edit
BEHAVIOR_INVENTORY.tsv / ENGINE_SCOPE.tsv / STATE_OWNERSHIP.tsv / PORTING.md /
LANGUAGE_SEMANTICS_MATRIX.md — the shards that own those artifacts apply the
row updates described here.

## Baseline correction (read this first)

The program brief names `958cdfd3` as the shared baseline. That is only true
for half the Phase-0 branches. As of this pass, **`origin/main` HEAD IS
`958cdfd3`** ("Merge pull request #136 from dohc-ai/codex/agent-chat-layout-controls"),
so the range `958cdfd3..origin/main` is empty. The real drift window is:

```
5b6d2009..958cdfd3   == exactly the PR #136 merge ("Build native workspace chat")
```

Fork points, verified via `git merge-base`:

| branch | fork point | sees PR #136? |
| --- | --- | --- |
| codex/rust-engine-r01-inventory (BEHAVIOR_INVENTORY, ENGINE_SCOPE, TEST_CLASSIFICATION, DETERMINISM_AUDIT) | `5b6d2009` | **NO — drifted** |
| codex/rust-engine-r00, codex/rust-engine-r03, codex/rust-engine-yrs-spike | `5b6d2009` | NO (but their artifacts don't cite the changed files' behavior) |
| codex/rust-engine-r01-contracts (PORTING, STATE_OWNERSHIP, SEMANTICS_MATRIX) | `958cdfd3` | **YES — already current** |
| codex/rust-engine-r01-oracle | `958cdfd3` | YES — already current |

Evidence that the contracts artifacts already integrated the drift: the
semantics matrix cites the post-drift code directly (row 4.8 feed cursors at
`linkedChatStore.ts:886-911`, row 10.4 bookmark ids at `:1045`, row 4.1b
heading anchors at `workspaceHeadings.ts:53`), and STATE_OWNERSHIP.tsv row
`timer-bookmark-projection` cites the bookmark outbox CAS at
`engineDbSchema.ts:556-595`. **No STATE_OWNERSHIP / PORTING / matrix rows need
updating for this delta.** The reconciliation burden falls on the
R01-INVENTORY artifacts and on the port scope of the shards listed below.

## Summary

- **Commits:** 33 (32 + merge), all from PR #136 `codex/agent-chat-layout-controls`,
  `eb2c578b` ("Build native workspace chat") through merge `958cdfd3`.
- **Magnitude on engine-authority paths:** 36 files, +7,760 / −50 lines.
  `linkedChatStore.ts` +1,887; `engineDbSchema.ts` +190; contracts
  `engine.ts` +237; `workspaceEngineCapture.ts` +412; plus 10 new desktop
  modules and 6 new/expanded test suites.
- **NEW-BEHAVIOR: 26** port targets added (17 linked-chat store methods/ops,
  3 schema clusters, 2 desktop capture primitives, 1 relay policy, 2 protocol
  contract surfaces, 1 aggregate of 7 stay-in-TS desktop modules).
- **CHANGED-BEHAVIOR: 16** existing inventory rows need updated io_contracts
  and re-cited line spans.
- **Untouched high-risk surfaces:** secrets (`secretFileStore.ts`,
  `secretKeyEnvelope.ts`), Y.Doc (`ydocEngineDriver.ts`, ydoc replication
  apply), shared-channel pull/push, share views, sync bundle, watcher,
  policy/search. `ENGINE_SCHEMA_VERSION` is still `1` and
  `REQUIRED_ENGINE_TABLES` is unchanged — every new table is lazy-additive.
- **Shards whose port scope grew:** R03, R04, R09, R10, R10b, R13b (and the
  R16 deletion sweep list). R01-INVENTORY owes ~26 new rows plus line-span
  re-cites. SHARDS.tsv `behavior_ids` for R09/R10/R10b/R13b should be updated
  by the INTEGRATOR.

**Most consequential drift:** the replication wire format grew two op kinds
(`chat.follow.set`, `chat.feed.read.set`) that are receiver-private LWW
registers with relay-side authorship enforcement, and the engine gained its
**first real one-shot data migration** (`engine_migrations` table +
`deferred-chat-parent-repair-v1`) executed inside the schema gate WITHOUT a
`schema_version` bump. Both change what "schema bootstrap" and "apply op"
mean for the Rust port.

---

## 1. Schema drift — `packages/workspace-engine/src/engineDbSchema.ts` (+190)

The ~188-line growth is six new tables, ten new indexes, four new columns, one
new exported constant, and one real data migration. `ENGINE_SCHEMA_VERSION`
stays `1`; nothing was added to `REQUIRED_ENGINE_TABLES`; the fresh-create
path (`createEngineSchema`) and lazy-upgrade path (`initializeOrValidateEngineSchema`)
both gained the new DDL, preserving the existing dual-path idempotent design.

### 1.1 NEW-BEHAVIOR: first keyed one-shot data migration

- Commits: `adefd7f2` (introduced during parent-repair hardening; merged in `958cdfd3`).
- HEAD spans: `engineDbSchema.ts:20-24` (`ENGINE_MIGRATIONS_DDL`),
  `:779-837` (`repairDeferredChatParentsOnce`), executed at `:888`, inlined in
  fresh-create at `:937`.
- Observable behavior: a new `engine_migrations(migration_id PK)` table; on
  every open, a read-only fast-path checks for
  `deferred-chat-parent-repair-v1`; if absent, a `BEGIN IMMEDIATE` transaction
  re-checks, moves replicated `chat_messages.parent_message_id` values whose
  parent has not arrived into `chat_pending_message_parents`, NULLs
  cross-thread/self parent links, and commits the marker row atomically with
  the repair. Failure throws through the store's `corrupt()` (state-corrupt).
- Inventory impact: **new row** (suggested id
  `schema-migration-deferred-chat-parent-repair`, risk critical — it is the
  only data-rewriting startup path in the engine). Also CHANGED:
  `schema-open-bootstrap-or-validate` (its io_contract now includes "runs
  one-shot keyed migrations after column upgrades") and `schema-create-fresh`
  (fresh DBs get `engine_migrations` inside the atomic create).
- Shard: **R04** (storage-core owns the schema gate; the migration keying
  machinery is generic) with **R09** owning the chat-specific repair SQL.
- Porting note: the Rust storage crate must reproduce the exact migration id
  string and the exact repair semantics, or a database handed from TS to Rust
  mid-cutover would re-run/skip the repair inconsistently.

### 1.2 NEW-BEHAVIOR: feed tables (`CHAT_FEED_DDL`)

- HEAD span: `engineDbSchema.ts:522-556`; exec at `:864`, inline at `:1127`.
- New: index `idx_chat_messages_thread_created` (exported as
  `CHAT_MESSAGES_CANONICAL_ORDER_INDEX`, `:16-17` — the canonical chat
  ordering key `(workspace_id, thread_id, created_at_ms, message_id)`),
  tables `chat_follows` (LWW register per
  `(workspace,owner,target_kind,target_id)` with `unfollowed` tombstones and
  `(origin_id, origin_seq)` clock columns) and `chat_feed_read_state` (LWW,
  one row per `(workspace,owner)`), plus indexes `idx_chat_follows_active`,
  `idx_chat_channel_wire_ids_channel`, `idx_chat_attachments_file_object`,
  `idx_chat_attachments_file_path`.
- Inventory impact: new row (suggested `schema-upgrade-chat-feed`).
- Shard: **R09** (chat_tables) under **R04**'s schema-gate machinery.

### 1.3 NEW-BEHAVIOR: bookmark tables (`CHAT_BOOKMARK_DDL`)

- HEAD span: `engineDbSchema.ts:560-595`; exec at `:865`, inline at `:1128`.
- New: `chat_bookmarks` (unique per `(workspace,owner,target_kind,target_id)`,
  `mode IN ('live','snapshot')`, `state IN ('active','archived')`) and
  `chat_bookmark_outbox` (per-bookmark `generation` CAS token +
  `projection_state IN ('pending','ready','failed','stale')`) with two
  indexes. The file comment is contract: no filesystem IO happens in the
  engine; desktop materializes pending rows; a worker finishing generation N
  cannot mark N ready after N+1 was queued.
- Inventory impact: new row (suggested `schema-upgrade-chat-bookmarks`).
- Shard: **R09** tables; the consuming projection loop is desktop (§5).

### 1.4 CHANGED-BEHAVIOR: existing schema rows

| inventory row | what changed | HEAD span |
| --- | --- | --- |
| `schema-upgrade-chat-channels` | `CHAT_CHANNEL_TABLES_DDL` now also creates `chat_channel_placeholders(workspace_id,channel_id,wire_id)` (PK `(workspace,channel)`, UNIQUE `(workspace,wire)`) — provenance for threads that replicated before their channel-create op | `engineDbSchema.ts:405-418` |
| `schema-upgrade-chat-phase-one` | `CHAT_PHASE_ONE_DDL` now also creates `chat_pending_message_parents` (+ index) — durable absent-parent claims for replicated replies; header comment rewritten to document the deferred-parent contract | `engineDbSchema.ts:476-495` |
| `schema-upgrade-misc-nullable-columns` | four more `ensureNullableColumn` targets: `chat_bookmark_outbox.projection_object_id TEXT` (`:866`), `chat_attachments.heading_text TEXT` / `heading_anchor TEXT` / `heading_occurrence INTEGER` (`:889-891`) | `engineDbSchema.ts:866,889-891` |
| `schema-open-bootstrap-or-validate` | exec order now includes `CHAT_FEED_DDL`, `CHAT_BOOKMARK_DDL`, the migration call, and a new index `idx_chat_messages_author_feed` on `(workspace_id, author_user_id, author_kind, created_at_ms DESC, message_id DESC)` | `engineDbSchema.ts:839-896` |
| `schema-create-fresh` | atomic create now includes `ENGINE_MIGRATIONS_DDL`, `CHAT_FEED_DDL`, `CHAT_BOOKMARK_DDL` (table list in the row's tables_files column must grow by 7 tables) | `engineDbSchema.ts:929-1137` |

All five rows keep their txn/idempotency contracts (IF NOT EXISTS /
presence-re-check ALTERs); PURE-REFACTOR aside: the new
`CHAT_MESSAGES_CANONICAL_ORDER_INDEX` export is consumed by desktop CLI
tooling and belongs in ENGINE_SCOPE.tsv as a new exported symbol row.

---

## 2. Linked-chat store drift — `packages/workspace-engine/src/linkedChatStore.ts` (+1,887)

File grew from ~2,900 to 4,833 lines. Every pre-existing inventory citation
into this file past ~line 400 is stale at HEAD (shifted by up to ~1,900
lines); R01-INVENTORY must re-cite rows 58-89 (`chats-*`) wholesale.

### 2.1 NEW-BEHAVIOR: 15 new store methods (all at HEAD `958cdfd3`)

| suggested behavior_id | method | HEAD line | observable contract |
| --- | --- | --- | --- |
| `chats-list-file-mentions` | `listFileMentions` | `linkedChatStore.ts:2945` | file→chat mention lookup over `chat_attachments` by objectId/path, capped by new export `CHAT_FILE_MENTION_MAX_RESULTS = 2_000` (`:91`) |
| `chats-set-follow` | `setFollow` | `:3339` | validates owner/target, LWW-upserts `chat_follows` via `upsertFollowLww` (`:913`), journals `chat.follow.set` |
| `chats-list-follows` | `listFollows` | `:3433` | reads active follows for an owner |
| `chats-ensure-default-channel-follows` | `ensureDefaultChannelFollows` | `:3453` | idempotent seeding of default channel follows for an owner |
| `chats-list-personal-feed` | `listPersonalFeed` | `:3480` | cursor-paged cross-thread feed; cursor is unpadded base64url (`encodeFeedCursor`/`decodeFeedCursor` `:886-911`), decode failures fail closed as `LinkedChatStoreError("invalid-follow-target")` — new error-code usage; ordering via the canonical `(created_at_ms, message_id)` coordinate compare |
| `chats-mark-personal-feed-seen` | `markPersonalFeedSeen` | `:3770` | LWW-upserts `chat_feed_read_state` via `upsertFeedReadLww` (`:950`), journals `chat.feed.read.set` |
| `chats-save-bookmark` | `saveBookmark` | `:3846` | upsert keyed `(owner,target)`; queues outbox generation via `queueBookmarkGeneration` |
| `chats-list-bookmarks` | `listBookmarks` | `:3943` | owner-scoped listing |
| `chats-find-bookmark` | `findBookmark` | `:3966` | point lookup |
| `chats-archive-bookmark` | `archiveBookmark` | `:3983` | state flip + generation queue |
| `chats-list-pending-bookmarks` | `listPendingBookmarks` | `:4005` | outbox rows in `projection_state='pending'` |
| `chats-mark-bookmark-pending` | `markBookmarkPending` | `:4029` | requeues a generation |
| `chats-mark-bookmark-ready` | `markBookmarkReady` | `:4040` | **generation CAS**: only marks ready if the finished generation is still current (stale worker loses) |
| `chats-mark-bookmark-failed` | `markBookmarkFailed` | `:4127` | records `failure_reason` |
| `chats-mark-bookmark-stale` | `markBookmarkStale` | `:4153` | marks projection stale |

All follow the store's existing serialize()/withTransaction ack-on-COMMIT
discipline (STATE_OWNERSHIP `chain-chat-writes` already covers them). Shard:
**R09** (`crates/dohc-engine-domain/src/chats*`, `dohc-engine-storage/src/chat_tables*`).

### 2.2 NEW-BEHAVIOR: two replication apply arms

Inside `applyReplicationOp` (`linkedChatStore.ts:4182-4797`):

- `chat.follow.set` apply arm (`:4669-4691`): strict payload validation
  (ownerUserId/targetKind/targetId/state/atMs; throws corrupt-store on
  malformed) then `upsertFollowLww` keyed by `(origin_id, origin_seq)`
  tiebreak — commutative, head-check-free, mirrors `chat.reaction.set`.
- `chat.feed.read.set` apply arm (`:4692-4713`): same shape via
  `upsertFeedReadLww`.

Suggested rows `chats-replication-apply-follow-set`,
`chats-replication-apply-feed-read-set`. Shard: **R09** (apply logic) +
**R10** (envelope admission, §3).

### 2.3 CHANGED-BEHAVIOR: existing `chats-*` rows

| behavior_id (inventory row) | what changed | HEAD evidence |
| --- | --- | --- |
| `chats-replication-op-admission` | admission list grew by `chat.follow.set`, `chat.feed.read.set` | dispatch arms in `applyReplicationOp`; see also §3 |
| `chats-replication-apply-channel-create` | if the wire id maps to a **placeholder** channel, the authoritative create now replaces the guessed metadata in place (`replaceChannelPlaceholderMetadata` `linkedChatStore.ts` helper block `:1672-1746` region) and deletes the placeholder row; slug collision resolved via `nextFreeChannelSlug(..., excludingChannelId)` | apply arm at `:4249-4270`; commits `7fbc41c2`, `f7d18e32` |
| `chats-replication-apply-thread-create` | payload now hard-validated by `isValidReplicatedThreadCreatePayload` (`:289`) — malformed replicated payloads throw state-corrupt instead of being trusted; when a thread arrives before its channel, the synthesized channel row is recorded in `chat_channel_placeholders` (`recordChannelPlaceholder`) | `:4311-4415`; commits `f7d18e32`, `b4148724` |
| `chats-replication-apply-message-append` | deferred-parent convergence: a replicated reply whose parent hasn't arrived stores `parent_message_id = NULL` plus a durable claim in `chat_pending_message_parents` (`deferReplicatedMessageParent` `:1549`); every append then resolves claims naming it as parent and discards cross-thread claims (`resolveReplicatedMessageParentClaims` `:1570`); also bumps live bookmarks pending (`markLiveBookmarksPending` `:1142-1159`) | `:4459-4530`; commits `2dbec6c1`, `adefd7f2` |
| `chats-replication-apply-attachment-add` | payload may carry a heading triple (`headingText`/`headingAnchor`/`headingOccurrence`); all-or-none validation with length caps (`CHAT_HEADING_TEXT_MAX_LENGTH`/`CHAT_HEADING_ANCHOR_MAX_LENGTH`) and control-char rejection; attachment id derivation extended to `attachmentIdFor(messageId, objectId, headingAnchor, headingOccurrence)` — the legacy no-heading form `${messageId}file${objectId}` survives byte-exact (matrix row 10.4 already covers this); also bumps live bookmarks pending | `:4607-4664` |
| `chats-send-message` | reply parents are now validated: `parentMessageId` must already exist in the same thread or the call throws `LinkedChatStoreError("message-not-found", "Reply parent was not found in this chat thread.")`; local attachments accept the heading triple (normalized NFC, `normalizeHeadingField`); dedup key changed from objectId to `(objectId, headingAnchor, headingOccurrence)`; marks live bookmarks pending | `:2748-2866`; commit `271948fb` |
| `chats-start-channel-thread` | initial message insert now also marks live bookmarks pending | `:2496` |
| `chats-list-channels` | placeholder channels are **hidden** (`NOT EXISTS` against `chat_channel_placeholders`) — a replicated thread's guessed channel is invisible until the authoritative create arrives | `:2377-2382`; commit `f7d18e32` |
| `chats-find-channel-by-slug` | same placeholder exclusion | `:2402-2415` |

PURE-REFACTOR: `nextFreeChannelSlug` signature gained an optional
`excludingChannelId` (internal helper, no independent inventory row);
`normalizeAttachments` input type widened to `LocalAttachmentInput`.

---

## 3. Sync admission + wire format

### 3.1 CHANGED-BEHAVIOR: `sync-apply-merged-replication-queues`

- `packages/workspace-engine/src/syncApply.ts:350-358` (HEAD): the opKind
  dispatch that routes chat ops to `chats.applyReplicationOp` grew
  `chat.follow.set` and `chat.feed.read.set`. Two-line change, but it is the
  admission gate for the new wire ops. Shard: **R10** (dohc-engine-sync::apply).
- `syncReplication.ts:23-33` re-exports the two new payload types
  (type-only). Shard: R10, mechanical.
- **Deliberate exclusion:** `syncSharedChannel.ts` is untouched — the
  shared-channel allowlist intentionally does NOT admit follow/feed ops
  (receiver-private state never rides a channel share; see the `CHAT_FEED_DDL`
  header comment). The Rust port must preserve this asymmetry; suggest the
  inventory row `shared-channel-pull` gains a note rather than a change.

### 3.2 NEW-BEHAVIOR: contract/protocol surface — **R03 must absorb**

- `packages/workspace-contracts/src/engine.ts` (+237): `SyncReplicationOpKind`
  union grew `"chat.follow.set" | "chat.feed.read.set"` (`engine.ts:238-239`);
  new payloads `ChatFollowSetPayload` (`:488`), `ChatFeedReadSetPayload`
  (`:497`); envelope union extended (`:575-576`);
  `ChatAttachmentAddPayload` gained the optional heading triple (`:433`
  region); new store-facing types `ChatFileMention` (`:1192`), `ChatFollow`,
  `ChatFollowState`, `ChatFollowTargetKind`, `ChatFeedItem` (`:1280`),
  `ChatFeedPage` (`:1290`), `ChatFeedReadState`, `ChatBookmark` (`:1307`),
  `ChatBookmarkTransitionResult` (`:1331`) plus the bookmark enums; the
  `LinkedChatStore` interface type gained all §2.1 methods.
- New module `packages/workspace-contracts/src/chatIdentity.ts:1-40` (new
  subpath export `@dohc/workspace-contracts/chat-identity`): `PreferredName`
  zod schema (NFC-adjacent trim, 80-char cap, rejects control chars and
  Unicode formatting controls except ZWNJ/ZWJ — display-name anti-spoofing)
  and `agentDisplayLabel` (idempotent `'s agent` suffixing). Display-layer
  validation, but it is a published contract consumed by desktop + relay-side
  authorship surfaces.
- Shard: **R03** (protocol crate mirrors the envelope/payload unions;
  the dormant-adapter codegen must include the two op kinds), plus the
  R01-ORACLE trace format already covers them (branch forked post-drift).

### 3.3 NEW-BEHAVIOR: relay-side authorship policy — **R10b must absorb**

- `services/sync-relay/src/server.ts:988-989` (HEAD): `CHAT_OP_POLICY` grew
  two `authored` entries — `chat.follow.set` and `chat.feed.read.set` require
  `ownerUserId` to equal the authenticated pusher, `onMissing: "reject"` (no
  stamping, unlike `chat.message.append`). This is a server-side security
  contract: receiver-private rows can only be written by their owner.
  Covered by `services/sync-relay/src/server.test.ts` (+99).
- Inventory impact: sync-relay server rows were out of the R01 inventory's
  engine-package scope; R10b's relay fault-model suite must include
  owner-mismatch rejection for both op kinds.

---

## 4. Desktop engine-adapter drift — **R13b must absorb**

### 4.1 NEW-BEHAVIOR: generated-text capture primitives

- `apps/desktop/src/workspaces/workspaceEngineCapture.ts` (+412):
  - `writeGeneratedTextFile` — interface `workspaceEngineCapture.ts:339-354`,
    impl `:2358-2468`. Writes a generated Markdown artifact through the
    canonical VersionedTextStore and materializes to disk on the SAME
    serialized chain as capture work. `expectedObjectId` is the update
    authority; `createOnly` treats any existing object/disk file as a
    collision even on byte-equal content; `recoverExistingText` is a
    marker-validated recovery hook that fails closed on validator throw
    (`assertGeneratedTextRecoveryIdentity` `:468-483`). Paths gated by
    `assertGeneratedMarkdownPath` (`:454-464`): must pass
    `validateUserWritePath`, be already-normalized, and end in `.md`.
  - `archiveGeneratedTextFile` — interface `:355-363`, impl `:2469+`.
    Object-id-preserving move; repeating a completed archive is a repairing
    no-op.
- These are the engine-adjacent write primitives the bookmark projection
  rides. Suggested rows `desktop-capture-write-generated-text-file`,
  `desktop-capture-archive-generated-text-file`. R13b already owns
  `workspaceEngineCapture.ts`; its adapter-E2E scope grows. Covered by new
  `workspaceEngineGeneratedText.test.ts` (+521).

### 4.2 CHANGED-BEHAVIOR: `desktop-relay-sync-run-pass`

- `apps/desktop/src/workspaces/relaySyncEngine.ts:47-51` (new
  `afterSuccessfulPull` option) and `:197-204` (invocation): runs after a
  fully successful pull (through the capture gate incl. materialization and
  cursor commit); failures are logged and contained — they can never put
  relay sync into backoff. Bookmark projection is the consumer. Shard: R13b.

### 4.3 NEW-BEHAVIOR (aggregate): stay-in-TS desktop chat modules

Seven new modules in `apps/desktop/src/workspaces/` are product/adapter logic
around the engine, not engine authority; they are listed so the R16 deletion
sweep and ENGINE_SCOPE.tsv classification don't miss them:

| module | role |
| --- | --- |
| `chatBookmarkProjection.ts` (149) | renders bookmark projection Markdown + ownership marker (`isChatBookmarkProjectionFor`) |
| `chatBookmarkProjectionWrite.ts` (57) | drives capture `writeGeneratedTextFile`/`archiveGeneratedTextFile` for bookmarks |
| `chatBookmarkPullProjection.ts` (15) | post-pull projection gate; read-only (shared-view) trees never materialize personal bookmark files |
| `chatFileReferenceResolution.ts` (58) | resolves chat file mentions against tracked object ids / path hints (ambiguity handling, commit `604cf215`) |
| `chatFollowAccess.ts` (34) | read-only-safe wrappers: never seed default follows/channels into read-only workspaces (commit `8c720151`) |
| `chatMentionGraphOverlay.ts` (322) | overlays pre-authorized chat mentions onto the workspace graph (caller-side permission model documented in header) |
| `workspaceHeadings.ts` (291) | Markdown heading extraction/anchoring (NFC + `toLocaleLowerCase` anchors — already pinned by matrix row 4.1b as identity-bearing) |

Plus `dmChats.ts` (+52): new export `requireShareableChatChannel`
(`dmChats.ts:49`) — DM share-grant boundary guard (commits `f4727368`,
`7883a30f`). These stay TS through cutover; the only rewrite-relevant fact is
that `workspaceHeadings.ts` anchors and `chatBookmarkProjection` markers are
identity-bearing strings the Rust engine must never re-derive differently.

The desktop `main.ts` bookmark projection poll (3s unref interval) is already
recorded in STATE_OWNERSHIP as `timer-bookmark-projection`.

---

## 5. TEST-ONLY drift

New/expanded suites that become part of the TS-native oracle baseline
(TEST_CLASSIFICATION.tsv on R01-INVENTORY predates all of them):

- `packages/workspace-engine/src/linkedChatStore.feed.test.ts` (new, 1,351)
- `linkedChatStore.phase1.test.ts` (+621), `linkedChatStore.placeholder-provenance.test.ts` (new, 134), `linkedChatStore.replication-validation.test.ts` (new, 245)
- `packages/workspace-contracts/src/chatIdentity.test.ts` (new, 34)
- `services/sync-relay/src/server.test.ts` (+99)
- desktop: `workspaceEngineGeneratedText.test.ts` (521), `workspaceHeadings.test.ts` (205), `chatBookmarkProjection*.test.ts` (210 across three), `chatMentionGraphOverlay.test.ts` (288), `chatFileReferenceResolution.test.ts` (94), `chatFollowAccess.test.ts` (55), `dmChats.test.ts` (+112), `relaySyncEngine.test.ts` (+46)

TS-NATIVE-CI's baseline suite grows accordingly; no oracle format change is
needed (R01-ORACLE forked post-drift).

---

## 6. Integrator checklist (SHARDS.tsv updates)

| shard | scope growth |
| --- | --- |
| **R01-INVENTORY** | add ~26 rows (§1-§4 suggested ids); re-cite every `chats-*` and `schema-*` line span against `958cdfd3`; TEST_CLASSIFICATION + DETERMINISM_AUDIT rows for the new suites/modules (new code already follows the `nowMs`/`createId` retrofit pattern) |
| **R03** | protocol union +2 op kinds, +2 payloads, heading fields on attachment payload, chat-identity contract module |
| **R04** | `engine_migrations` machinery + the one-shot keyed migration pattern inside the schema gate |
| **R09** | 15 new store methods, 2 new apply arms, placeholder + deferred-parent convergence, 6 new chat tables + heading columns; largest single growth |
| **R10** | syncApply admission of the two op kinds; preserve shared-channel exclusion |
| **R10b** | relay `CHAT_OP_POLICY` authored/reject entries for follow + feed-read; fault-model tests for owner mismatch |
| **R13b** | capture generated-text write/archive primitives; relay-sync `afterSuccessfulPull` hook; bookmark projection loop stays TS but drives the adapter |
| **R16** | deletion sweep list grows by the §4.3 modules |

R01-CONTRACTS artifacts (PORTING / STATE_OWNERSHIP / SEMANTICS_MATRIX) and
R01-ORACLE need **no** delta updates — they were authored against `958cdfd3`.

---

## 7. CAL-3 (dohc-engine-files) — approved deltas

Two deliberate divergences introduced by the CAL-3 scan/hash/reconcile slice
(`crates/dohc-engine-files`, PR #153). Both are corrections/hardenings, not
faithful ports; recorded here as binding contracts for R07 (watcher/reconcile/
path-floor/materialization) to inherit.

### 7.1 Over-cap-but-present files are RETAINED, never retired

**TS/kernel behavior.** The reference accelerator scan simply omits over-cap
handling (the kernel does not cap file size); the TS capture path's
reconcile-into-version retires any engine-tracked path not seen in the scan
after a confirmed-absence `lstat`
(`workspaceEngineCapture.ts` reconcile, false-delete defense).

**Rust behavior (CAL-3).** With a finite `max_file_bytes` and the default
`OverCapPolicy::Skip`, a file that GROWS past the cap drops out of the tracked
listing into the `skipped` set. The diff consults BOTH `files` and `skipped`:
a previously-tracked path still present in `skipped` is classified
`retained_over_cap` (a distinct, no-op capture disposition), the reconcile
carries its **last-known-good** manifest entry forward, and it is **never**
`Retire`d. Only a path absent from BOTH files and skipped (truly gone from disk)
is `removed`. This closes a size-cap-grow false-delete (forgetting live user
data). R07 materialization must leave `retained_over_cap` paths untouched on
disk. Regression:
`tests/reconcile.rs::size_cap_grow_retains_never_retires_the_false_delete_regression`.

### 7.2 Path-floor segment normalization is platform-gated (POSIX correctness)

**TS/kernel behavior.** `workspace-kernel/src/main.rs:683-684`
(`normalize_ignored_segment`) strips trailing dots/spaces and lowercases every
segment on ALL platforms. On case-sensitive POSIX hosts this silently aliases a
real user directory `.DOHC` / `.Dohc` / `.dohc.` (distinct inodes) onto the
reserved `.dohc`, omitting that subtree from the scan — a data-omission bug.

**Rust behavior (CAL-3).** The trailing-dot/space strip AND the case-fold are
gated behind `cfg(windows)` (where Win32 open-time aliasing and NTFS
case-insensitivity make them correct). On POSIX, only the EXACT reserved name is
the floor. Per the plan's "Rust is right, TS is platform-buggy → approved delta,
don't reproduce the bug" rule. **The TS kernel is flagged for a matching fix**
(gate its `normalize_ignored_segment` to Windows, or accept the Rust behavior as
the contract). macOS case-insensitivity (row 7.5) remains a separate
NEEDS-DECISION and is intentionally NOT special-cased here. Tests:
`src/floor.rs::posix_case_and_trailing_variants_are_distinct_content` (POSIX),
`::win32_trailing_alias_still_excluded` (Windows).

## 8. R04 (durable storage core) — approved deltas & documented residuals

The R04 shard adds durability machinery the TS engine never had (migration
ledger, verified backups, materialization-job pipeline). Four items are recorded
here so downstream shards do not mistake a scoped limit for a closed guarantee.

### 8.1 NEW-BEHAVIOR: durable materialization pipeline replaces plain `writeFile`

**TS behavior.** `createDefaultDiskWriter` materializes with a plain buffered
`writeFile` — no temp file, no atomic replace, no fsync
(`STATE_OWNERSHIP.tsv` `job-materialization`); a crash mid-write can leave a
TORN file with no job record.

**Rust behavior (R04).** Canonical state + a durable materialization job commit
in one txn; a sibling temp is written (restrictive mode), flushed per the per-OS
policy, atomically replaced without following links (bounded retry for transient
sharing violations), then marked complete. Startup replays pending jobs
idempotently. Approved delta per `plan §Filesystem/database crash boundary`.

### 8.2 RESIDUAL (documented, NOT closed): preimage-revalidate → replace TOCTOU

The pipeline revalidates the target's preimage immediately before the atomic
replace, but the read and the rename are not one operation (no filesystem offers
content-compare-and-swap). An external write landing in the microsecond between
the revalidation read and the rename is clobbered. The common case — an editor
that wrote *before* the pipeline ran — IS detected and preserved-both. The
sub-op race is an inherent, narrow residual; it is documented in
`dohc-engine-files::materialize` module docs and is NOT claimed closed.

### 8.3 DECISION: preserve-both `.conflict` artifacts are floor-excluded

When materialization finds newer external content, it preserves both: the
external file is left untouched and the intended content is written to a visible
`<base>.<job-id>.conflict` sibling for the user/agent to resolve. That artifact
is added to the path floor (`is_conflict_artifact`), so the scanner does NOT
auto-capture it as a new tracked document (which would fork provenance on every
conflict). It stays VISIBLE on disk; it is simply not auto-tracked. Test:
`src/floor.rs::conflict_artifacts_excluded_from_capture`.

### 8.4 SCOPED LIMIT: Windows directory fsync is a no-op; same-stem backup window

- **Directory fsync.** `std` exposes no portable directory sync, so the
  post-rename parent-directory fsync (which makes a rename durable on POSIX) is a
  documented no-op on Windows. `DurabilityPolicy::per_os()` sets
  `fsync_parent_dir = false` off POSIX. Honestly-scoped per `plan §Crash tiers`
  (the last rename may be lost only on OS crash / power loss on Windows).
- **Same-stem backup republish.** Reusing a backup stem stages + verifies the
  new copy, then publishes by atomic rename and writes the manifest last; the
  prior manifest is cleared just before the rename. This leaves a narrow window
  where *that stem* has a db but no manifest — `load_valid_backup` correctly
  reports it invalid-by-absence and a retry self-heals. The guarantee is
  precisely "never destroy a valid restore point to make room for an unverified
  one" (the live source and any other-stem backup are never touched), not "the
  target stem is atomically valid at every instant."

## 9. R08 (secrets — dohc-engine-crypto) — approved deltas & documented residuals

### 9.1 DECISION: secret delete is a tombstone, not a crypto-shred

Deleting a secret file (`SecretFileStore::delete_secret_file`) removes the
`secret_files` tip but the prior WRITE moment in `secret_moments` RETAINS its
`after_ciphertext_base64` + `after_byte_length`. So a deleted secret's
ciphertext — and its exact plaintext SIZE — persist in history. This is the
deliberate, TS-matching behavior (`secretFileStore.ts`): the versioned model
preserves history, and restore-to-before-a-moment depends on the retained sealed
after-state. Ciphertext-only-at-rest still holds (plaintext is never persisted).
Residual: existence + size of a deleted secret remain visible to anyone with DB
access — acceptable because they already hold the ciphertext. A future
crypto-shred-on-delete (purge the retained after-state, or re-seal history under
a rotated key) is a possible enhancement for the sync/retention shard. Documented
in `crates/dohc-engine-domain/src/secrets.rs` module doc.

### 9.2 NEW-BEHAVIOR: secret materialization rides the R04 job pipeline

A secret write enqueues an R04 `materialization_jobs` row in the SAME
transaction as the secret state (`enqueue_job` in `write_with`), so the intent
to write the plaintext file is crash-safe. The job's `content_sha256` references
the CIPHERTEXT blob (the only leak-free content the FK can point at) as an
integrity anchor; the plaintext is produced only at execution time by the
secret-aware materializer (`materialize_secret_file`, the single authorized
plaintext accessor) and lives only on disk. The generic file-executor's
decrypt-before-write wiring for secret paths is a later capture/desktop
integration point; this shard owns the crypto + domain durable-intent path.

### 9.3 SCOPED: replication-op apply and the secret path floor are later shards

R08 ships the local write / read / fork / materialize / delete path plus the
compound-commit journal entries. The replication-op apply for
`secret.file.put` / `secret.file.delete` / `secret.version.fork` (with the
tip-rank comparator and fork-poison verification) is scoped to the sync shard
atop these crypto/blob/tip primitives. Path CLASSIFICATION (the `not-secret-path`
fail-closed gate) is the R07 path floor's job; the store validates
safe/workspace-relative paths and treats routed paths as secret.

### 9.4 SECURITY POSTURE: nonce discipline, zeroization, log-safety

- The public sealing entry is `aead::seal` ONLY — it draws a fresh CSPRNG nonce
  every call. The deterministic caller-supplied-IV `seal_with_iv` is gated behind
  the `test-util` feature (and `cfg(test)`) and is NOT re-exported at the crate
  root: reusing a 96-bit nonce under one key is catastrophic for AES-GCM.
- All raw key material lives only in zeroizing buffers (`SecretDataKey`,
  key-file decode, envelope KEK/data-key), and the sole plaintext carrier
  (`SecretPlaintext`) zeroizes on drop with no `Display`/`Serialize` and a
  redacted `Debug`. `SecretWrite` (the one secret-bearing input) hand-writes a
  redacted `Debug` so cleartext cannot spill through logs/panics.
- `base64::forgiving_decode` reproduces Node `Buffer`'s `=`-terminator semantics
  exactly (stops at the first `=`), so the key-file parser neither accepts a
  malformed file Node rejects nor rejects one it accepts.

## 10. R09 (chats domain) — approved deltas & documented divergences

### 10.1 DELIBERATE DIVERGENCE: `decode_feed_cursor` is stricter (fail-closed) on non-engine-minted cursors

`encode_feed_cursor` is byte-identical to the TS `encodeFeedCursor`
(`Buffer.from(JSON.stringify([createdAtMs, messageId]), "utf8").toString("base64url")`),
and every cursor this engine EMITS round-trips byte-exact on both sides (pinned
by `crates/dohc-engine-domain/tests/chats.rs::feed_cursor_encode_matches_ts_and_ts_cursor_decodes`).
`decode_feed_cursor` (matrix 4.8) deliberately tightens acceptance of
NON-engine-minted (adversarial client) cursors in two ways: (1) `createdAtMs`
must be an integral `i64` (TS accepts any finite JS number — but the feed only
ever emits integral coordinates, so a fractional/out-of-range value was never a
cursor this engine minted); (2) the message-id length cap counts Unicode scalar
values (`chars().count()`) rather than JS UTF-16 units, so an astral string near
the 256 boundary can be accepted on one engine and rejected on the other. Both
directions are Rust-stricter-fail-closed, which is the safe direction for
untrusted input; the store already fails closed as `invalid-follow-target` on any
decode/shape violation. **R10 / the differential harness must treat this as
intended, not a bug** — it is documented in `decode_feed_cursor`'s rustdoc.

### 10.2 PARITY (not a delta): `normalize_body` matches JS `String.prototype.trimEnd`

`normalize_body` trims the ECMAScript trimEnd whitespace set, NOT Rust's
`char::is_whitespace` (Unicode `White_Space`). The two differ at exactly two code
points: JS trims U+FEFF (ZWNBSP, not `White_Space`) and does NOT trim U+0085
(NEL, which IS `White_Space`). Using `char::is_whitespace` would store/project a
body ending in ZWNBSP differently from TS. `is_js_trim_ws` encodes the JS set so
normalized bodies are byte-identical across engines (regression:
`normalize_body_matches_js_trimend_including_zwnbsp`).

### 10.3 SCOPED LIMIT: durable dispatch is a single-writer state machine with a startup reclaim

R09 ships the LOCAL dispatch state machine (`enqueue`/`claim`/`complete`/`fail`
+ `reclaim_running_dispatches`), the single-writer replacement for the deleted
`desktopAgentDispatchStore` raw second connection. Liveness is guaranteed by:
`complete_dispatch`/`fail_dispatch` transition `running -> done/failed` (unblocking
the workspace claim guard), and `reclaim_running_dispatches` is the startup reaper
— any `running` row observed at call time belongs to a crashed process (the live
run would hold the writer), so it is marked ended-with-failure and its trigger
requeued to `pending` when `attempt_count < max_attempts` (bounded retry, TS
`requeueFailedTrigger` `< 2`), else left terminally `failed`. There is no
wall-clock heartbeat/lease (the single-writer invariant makes one unnecessary);
if a future multi-worker model lands, a lease column would replace the
"any-running-is-crashed" assumption.

## 11. R07 (dohc-engine-files watcher/reconcile/policy)

### 11.1 CORRECTION (2026-07-17): tolerant scan + confirmed-absence retire gate now matches the TS oracle

**TS behavior.** Desktop capture tolerates a per-file/per-directory readability
failure, reports the pass unsuccessful/degraded, and continues capturing every
independent readable path. A previously tracked path is retired only after a
direct `lstat` on that exact path confirms `ENOENT`/`ENOTDIR`; unreadable,
locked, ancestor-obscured, or unexpectedly reappeared paths retain their
last-known-good state. This is the false-delete defense for a default-on scan
that may be incomplete.

**Rust behavior (R07 correction toward parity).** `ScanListing::failed` now
records a bounded path + io-kind set while structural bounds and the workspace
root remain fail-closed. Diff retains a prior entry when its path or an ancestor
failed, and reconcile additionally runs one final no-follow
`symlink_metadata` probe before every apparent retire. Only confirmed absence
emits `CaptureOp::Retire`; every other result is `unconfirmed_removed`, carried
forward and surfaced through `ReconcilePlan::degraded`. This closes CAL-3's
stricter-but-worse whole-pass abort gap; it is a CORRECTION to TS parity, not a
new divergence. Regressions:
`tests/scan.rs::permission_denied_file_is_reported_degraded_without_aborting_other_files`,
`tests/reconcile.rs::unreadable_path_degrades_but_other_paths_capture_and_it_is_never_retired`,
and
`tests/reconcile.rs::retire_requires_final_lstat_confirm_and_toctou_reappearance_is_retained`.

## 12. R05 (versioning residual) — deliberate rollback divergence

### 12.1 DELIBERATE DIVERGENCE: `versions-rollback-text-file-mutation` fails closed on an unrecorded legacy preimage

For a legacy-unset (`before_present = 0`) write mutation with neither a
recoverable earlier snapshot nor `legacy_before_text`, TS removes the file as a
first write. Rust returns `invalid-input` instead: it never reconstructs or
deletes state whose preimage was not recorded, preserving the fail-closed
history contract.
