# BEHAVIOR_DELTA — Wave 0 engine-change reconciliation

Authority: Gate 0 freeze decision (DECISIONS.md, 2026-07-16): in-flight
TS-engine changes on main are IMPORTANT FEATURES, integrated not discarded;
every engine commit since the inventory baseline is reconciled here and into
the inventory/contract artifacts before the affected shards port.

Produced by the DELTA shard, 2026-07-16. Evidence commands inline; all line
numbers cite the commit named next to them.

## 1. Baseline facts (verified 2026-07-16)

1. `origin/main` tip **is** `958cdfd3` ("Merge pull request #136"). The
   literal range `958cdfd3..origin/main` is **empty** — zero commits of any
   kind have landed on main since the declared baseline. The freeze is
   holding as of this audit. (`git ls-remote origin main`;
   `git log 958cdfd3..origin/main` → empty.)
2. The two Gate-0-approved security hotfixes (`validateWorkspacePath`
   ADS/device-name/8.3 bypasses; search-policy fail-open → fail-closed) have
   **not landed yet**. Standing obligation: when they merge, each MUST append
   a delta entry to this file (per DECISIONS.md they "land with
   BEHAVIOR_DELTA entries and become approved deltas the Rust port
   inherits").
3. **Baseline correction (the real Wave 0 delta).** The R01-INVENTORY
   artifacts were NOT extracted at the declared baseline `958cdfd3`. They
   were extracted from `5b6d2009` ("update AGENTS.md"), the branch's
   merge-base with main — **33 commits (PR #136, native workspace chat,
   91 files, +18,235/−969) behind the declared baseline**, and PR #136
   touches the engine heavily. Proof: BEHAVIOR_INVENTORY row
   `chats-replication-op-admission` cites `linkedChatStore.ts:2478-2502`;
   `applyReplicationOp` sits at line 2478 in the 3,000-line `5b6d2009` file
   and at line 4182 in the 4,833-line `958cdfd3` file. DETERMINISM_AUDIT
   spans (`linkedChatStore.ts:407`, `:1258`) match `5b6d2009` likewise.
4. R01-CONTRACTS **is** current: its branch forked at `958cdfd3` and its
   content demonstrably covers the post-merge tree (LANGUAGE_SEMANTICS_MATRIX
   4.8 feed cursors `linkedChatStore.ts:886-911`, 10.4 bookmark ids `:1045`;
   STATE_OWNERSHIP rows `timer-bookmark-projection` at `main.ts:6921` and
   `chain-chat-writes` at `linkedChatStore.ts:1976-1996`). **No contract
   delta is required for PR #136.**
5. Consequence: the un-reconciled engine delta is exactly
   `5b6d2009..958cdfd3` (PR #136), and the artifacts that must absorb it are
   the five R01-INVENTORY files plus the GATE0_PACKET headline counts.
   DECISIONS.md is append-only; the integrator should append a clarifying
   entry that "inventory baseline" means: inventory artifacts reflect
   `5b6d2009`, contract artifacts reflect `958cdfd3`, and this file closes
   the gap between them.

## 2. Delta register — PR #136 (`5b6d2009..958cdfd3`), engine-relevant paths

All entries below are APPROVED FEATURES per Gate 0. "Artifact updates" name
what R01-INVENTORY must absorb before the listed shards port.

### D1 — Sync wire surface grew: 2 new replication op kinds (critical)

- `chat.follow.set` and `chat.feed.read.set`: receiver-private personal-feed
  state riding the owner's ordinary workspace sync lane. Routed in
  `packages/workspace-engine/src/syncApply.ts:352-360`; payload types
  `ChatFollowSetPayload`/`ChatFeedReadSetPayload` re-exported through
  `syncReplication.ts`; applied by `linkedChatStore.applyReplicationOp`
  (now 8 op kinds, was 6).
- Relay enforcement: `services/sync-relay/src/server.ts:982-991`
  `CHAT_OP_POLICY` gained two `authored` rows keyed on `ownerUserId` with
  `onMissing: "reject"` (stricter than `chat.message.append`'s `stamp`).
  The authenticated pusher must equal the receiver named by the record.
- Shared-channel exclusion is enforced **by allowlist omission**:
  `syncSharedChannel.ts` is unchanged in the range, so the new kinds never
  appear in a channel share. The Rust port must replicate the allowlist
  exactly — adding kinds there is a security regression, not a completeness
  fix.
- Artifact updates: BEHAVIOR_INVENTORY needs 2 new `chats-apply-*` rows and
  a corrected `chats-replication-op-admission` row (span + op-kind list +
  the authorship-trust note now covering `ownerUserId`); the 2 `syncApply.ts`
  rows re-verified.
- Shards: R03 (protocol schema), R09 (apply), R10 (workspace-lane
  replication), R10b (relay policy).

### D2 — First real migration machinery exists now (invalidates an inventory note)

- `engine_migrations` ledger table + `repairDeferredChatParentsOnce`
  (`engineDbSchema.ts:779-838` @958cdfd3, migration id
  `deferred-chat-parent-repair-v1`): a one-shot, write-transactional data
  repair inside `initializeOrValidateEngineSchema` (read-only fast path,
  BEGIN IMMEDIATE + re-check, marker committed atomically with the repair).
- INVENTORY_NOTES "Cluster: schema" states migration machinery "does not
  exist yet anywhere in this file and would need to be designed fresh, not
  ported" — **now false**. Correct the note.
- Porting posture: under locked decision 2 (clean reset) the repair itself
  never runs in Rust; PORTING.md:514 already records `engine_migrations` as
  irrelevant under clean reset. The pattern (ledgered one-shot repairs) is
  still the in-TS precedent for the day-one Rust migration ledger.
- Shards: R04 (owns the schema port), R09 (deferred-parent semantics, D5).

### D3 — Engine schema delta (+186 net lines, 969 → 1,155)

- 7 new tables: `engine_migrations`, `chat_channel_placeholders`,
  `chat_pending_message_parents`, `chat_follows`, `chat_feed_read_state`,
  `chat_bookmarks`, `chat_bookmark_outbox` (new DDL blocks `CHAT_FEED_DDL`
  ~`engineDbSchema.ts:518-553` and `CHAT_BOOKMARK_DDL` ~`:555-596`
  @958cdfd3, both executed from `initializeOrValidateEngineSchema:863-864`
  — two more lazy-additive steps appended to the un-transactioned fixed
  sequence the inventory already flags as a structural risk).
- New columns via `ensureNullableColumn`: `chat_attachments.heading_text` /
  `heading_anchor` / `heading_occurrence`,
  `chat_bookmark_outbox.projection_object_id`.
- New indexes: `CHAT_MESSAGES_CANONICAL_ORDER_INDEX`
  (`idx_chat_messages_thread_created` — canonical message ordering),
  `idx_chat_messages_author_feed`, `idx_chat_follows_active`,
  `idx_chat_channel_wire_ids_channel`, `idx_chat_attachments_file_object`,
  `idx_chat_attachments_file_path`, bookmark owner/live-thread/outbox-pending
  indexes.
- `chat_bookmark_outbox.generation` is a CAS token (worker finishing
  generation N cannot mark ready after N+1 queued) — a concurrency contract,
  not just a column.
- Artifact updates: all 20 `engineDbSchema.ts` BEHAVIOR_INVENTORY rows
  re-spanned; new rows for the two DDL steps + the migration step; the
  INVENTORY_NOTES chat coverage-gap paragraph re-checked against the new
  tests (D7).
- Shards: R04 primarily; R09 (chat tables), R12 unaffected (no
  `searchIndex.ts`/`workspaceSearch.ts` changes in the range — verified).

### D4 — linkedChatStore public surface: 15 new methods + 14 new exports

- New store methods (linkedChatStore.ts @958cdfd3, +1,833 net lines):
  - Feed/follows: `setFollow`, `listFollows`, `ensureDefaultChannelFollows`,
    `listPersonalFeed` (cursor-paged), `markPersonalFeedSeen`.
  - Bookmarks: `saveBookmark`, `findBookmark`, `listBookmarks`,
    `archiveBookmark`, `listPendingBookmarks`, `markBookmarkPending`,
    `markBookmarkReady`, `markBookmarkFailed`, `markBookmarkStale`.
  - Mentions: `listFileMentions` (capped by new export
    `CHAT_FILE_MENTION_MAX_RESULTS = 2_000`).
- New package exports (`packages/workspace-engine/src/index.ts`, 283 → 297
  lines): `CHAT_FILE_MENTION_MAX_RESULTS` + 13 types (`ChatBookmark`,
  `ChatBookmarkMode`, `ChatBookmarkProjectionState`, `ChatBookmarkState`,
  `ChatBookmarkTargetKind`, `ChatBookmarkTransitionResult`, `ChatFeedItem`,
  `ChatFeedPage`, `ChatFeedReadState`, `ChatFileMention`, `ChatFollow`,
  `ChatFollowState`, `ChatFollowTargetKind`).
- Artifact updates: ENGINE_SCOPE.tsv (218 rows, 38 from linkedChatStore —
  effectively zero coverage of the above; add rows + classifications);
  BEHAVIOR_INVENTORY ~15 new `chats-*` rows. The bookmark outbox
  generation-CAS transitions and feed cursor paging are the risk-bearing
  contracts.
- Shards: R09 (owner), R03 (client-visible types), R13b (desktop consumers).

### D5 — Existing chat behaviors changed semantics (re-verify, don't just re-span)

All 32 `linkedChatStore.ts` BEHAVIOR_INVENTORY rows require re-verification
against `958cdfd3`, because PR #136 changed apply/read semantics, not only
line numbers:

- `chat.channel.create` apply is now **placeholder-aware**: a replicated
  thread arriving before its channel-create creates a synthetic channel with
  provenance in `chat_channel_placeholders`; the later authoritative create
  replaces guessed metadata **only** for placeholder rows (already-mapped
  channels stay immutable under conflicting creates).
- `chat.message.append` apply now **defers absent parents**: an absent
  `parent_message_id` claim is held durably in
  `chat_pending_message_parents` and activated only when the parent arrives
  in the same workspace/thread; cross-thread and self links are discarded
  (D2's repair backfills pre-existing rows).
- Message reads use the new canonical order index; messages carry
  `author_user_id`/`parent_message_id`/`origin` semantics exercised by new
  validation tests; decision reconciliation and read-state paths were made
  race-safe in the same PR series.
- Envelope admission (`chats-replication-op-admission`) span moves
  2478→4182; its trust note must now cover relay-verified `ownerUserId`.

### D6 — Determinism audit gaps

- DETERMINISM_AUDIT.tsv linkedChatStore spans are stale (e.g. `:407`
  defaultCreateId, `:1258` nowMs — both pre-merge numbering) and the +1,833
  new lines are unaudited. Known new sites: `updated_at_ms`/`created_at_ms`
  clocks on follow/feed-read/bookmark writes (via the injectable
  `options.nowMs`? — verify per site), base64url feed cursors
  `encodeFeedCursor`/`decodeFeedCursor` (`linkedChatStore.ts:886-911`,
  fail-closed `invalid-follow-target`, length-capped 512 — already pinned in
  LANGUAGE_SEMANTICS_MATRIX 4.8), sha256-derived bookmark ids (`:1045`) and
  extended attachment ids (`:1170-1175`, pinned in matrix 10.4).
- The GATE0_PACKET headline "117 determinism sites" is a `5b6d2009` count.

### D7 — Test surface delta

- 3 new engine test files are absent from TEST_CLASSIFICATION.tsv (46 rows):
  `linkedChatStore.feed.test.ts`,
  `linkedChatStore.placeholder-provenance.test.ts`,
  `linkedChatStore.replication-validation.test.ts`
  (`linkedChatStore.phase1.test.ts` predates the range but changed).
- `services/sync-relay/src/server.test.ts` gained 99 lines covering D1's
  relay policy; TEST_CLASSIFICATION covers neither `services/sync-relay` nor
  `packages/workspace-contracts` at all — a pre-existing scope choice that is
  now load-bearing for R10b's fault-model suite and R03's contract tests.
  Flag to the integrator rather than silently widening scope.
- New tests likely close INVENTORY_NOTES' chat coverage gaps
  (chat_channels/chat_reactions untested, etc.) — re-check that paragraph.
- The GATE0_PACKET headline "46 test files" is a `5b6d2009` count; so are
  "232 behaviors" and "218 exports".

### D8 — Shared contracts package grew a cross-boundary chat surface

- New module `packages/workspace-contracts/src/chatIdentity.ts`:
  `MAX_PREFERRED_NAME_LENGTH = 80`, `PreferredName` (zod), 
  `preferredNameFromInput`, `agentDisplayLabel` — consumed by desktop, CLI
  (`packages/cli/src/chatIdentity.ts`), and MCP.
- `packages/workspace-contracts/src/engine.ts` +237 lines: the
  follow/feed/bookmark/file-mention wire+store types (see D4 list, plus
  `ChatFollowSetPayload`/`ChatFeedReadSetPayload`).
- These are protocol-adjacent: R03's serde structs must mirror them; drift
  here is wire drift.

### D9 — Desktop adapter surfaces on R13b-owned paths changed

- `apps/desktop/src/workspaces/relaySyncEngine.ts` (+12): new
  `afterSuccessfulPull` hook — post-pull ancillary work (live bookmark
  projection) runs after materialization + cursor commit, failure-contained
  so it can never put relay sync into backoff.
- `apps/desktop/src/workspaces/workspaceEngineCapture.ts` (+412): new
  engine-generated-text write/archive path
  (`WorkspaceGeneratedTextWriteResult`, `WorkspaceGeneratedTextArchiveResult`,
  identity-validated recovery) used by bookmark projection materialization
  through the capture gate.
- New desktop modules consuming the engine chat surface (R13b/R09 scoping
  context, not engine behavior rows): `chatBookmarkProjection*`,
  `chatBookmarkPullProjection`, `chatFileReferenceResolution`,
  `chatFollowAccess`, `chatMentionGraphOverlay`, `dmChats`,
  `workspaceHeadings`; plus `packages/mcp/src/tools.ts` (+179) and CLI
  chat rendering — external writers per locked decision 4, but their engine
  calls define API coverage R09 must not miss.

## 3. Shard gating summary

| Shard | Impact | Gate |
| --- | --- | --- |
| R04 storage-core | D2, D3 (schema is its port source) | inventory schema rows re-verified against 958cdfd3 BEFORE port begins — R04 opens with Wave 1 now |
| R09 chats | D1, D3–D7 (largest: +1,833 lines, 15 methods, 2 op kinds) | chats cluster re-inventoried; do not port from the 5b6d2009 rows |
| R03 protocol | D1, D8 | serde structs cover new payloads/types |
| R10 replication / R10b relay | D1, D7 | relay CHAT_OP_POLICY + allowlist-omission semantics in the fault-model suite |
| R13b desktop adapter | D9 | adapter E2E includes afterSuccessfulPull + generated-text path |
| R12 search / R05 / R06 / R07 / R08 / R11a / R11b | none | no owned-path changes in the range (verified via diff file list) |

## 4. Recommended mechanics

Hand-patching ~56 stale rows (32 linkedChatStore + 20 engineDbSchema + 2
syncApply + 2 syncReplication) plus ~20 missing rows invites transcription
drift. Recommend rerunning the R01-INVENTORY extraction for the `chats` and
`schema` clusters (and the determinism sweep for `linkedChatStore.ts`)
against `958cdfd3`, with this register as the reviewer's checklist, then
refreshing the four GATE0_PACKET counts in the same commit.

## 5. Delta log (append-only from here)

| date | range | summary | reconciled into |
| --- | --- | --- | --- |
| 2026-07-16 | 5b6d2009..958cdfd3 (PR #136) | native workspace chat: feed/follows, bookmarks+outbox, placeholders, deferred parents, 2 sync op kinds, migration ledger | this file (D1–D9); inventory refresh pending |
| (pending) | validateWorkspacePath hotfix | approved Gate 0 security hotfix | entry required at merge |
| (pending) | search-policy fail-closed hotfix | approved Gate 0 security hotfix | entry required at merge |
