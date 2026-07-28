# P1 replicated chat FTS repair

## What changed

Replicated chat thread and message mutations now maintain
`engine_search_chat_messages_fts` in the same SQLite transaction as the
canonical chat rows.

- `apply_thread` writes the thread header row with
  `CHAT_THREAD_HEADER_MESSAGE_ID`.
- `apply_message` writes the normalized author/body message row.
- A shared domain helper also updates an untitled thread's derived snippet
  header when its first replicated message arrives, matching the local
  `start_channel_thread` contract.
- Parked message promotion calls the same helper from `apply_pending_message`,
  so delayed cross-origin messages become searchable when their thread arrives.
- All writes reuse `upsert_chat_search_index_row`; no FTS SQL was duplicated.
  Its delete-then-insert behavior and the replication admission skip keep
  duplicate deliveries idempotent.

No schema change or migration was needed. `packages/workspace-engine` and
`docs/superpowers/plans/rust-engine/**` were not modified.

## Replicated writer enumeration

| Path | Indexed mutation | Before | After |
| --- | --- | --- | --- |
| `router::apply_replication_envelope` and general relay pull loops (`relay.rs:515,536`) | Dispatch `chat.*` envelopes to `apply_chat_envelope`/`apply_chat_tx` | Inherited the missing-index behavior below | Inherits transactional maintenance from the shared apply functions |
| `apply_chat_mutation` → `apply_thread` (`apply.rs:631,881`) | Inserts a file-linked or channel-owned `chat_threads` row, including `title` | No `__thread__` FTS row | Calls `upsert_chat_search_index_row` in the mutation transaction |
| `apply_chat_mutation` → `apply_message` (`apply.rs:631,1140`) | Inserts `chat_messages`; may resolve parent links and updates `chat_threads.updated_at_ms` | No message FTS row | Calls `index_replicated_chat_message_search_rows` in the mutation transaction |
| First message in an untitled replicated thread | Local `start_channel_thread` indexes the derived first-line snippet as the thread header | Imported thread kept an empty header forever | The shared helper replaces the empty header with `chat_thread_display_title("", body)` only when this is the deterministic first message |
| Missing-thread parking (`apply.rs:1182`) | Journals/acks `chat.message.append` in `chat_pending_replication`; no message is inserted yet | Correctly had no FTS row while parked | Unchanged until promotion |
| Parked promotion through `apply_chat_tx` → `replay_ready_pending_chat_coordinates` → domain `apply_pending_message` (`chats.rs:7053,7429`) | Later inserts the parked `chat_messages` row and updates parent/thread state | Inserted the message without FTS maintenance | Calls the same message/header helper in the promotion transaction |
| `apply_shared_envelope` (`share.rs:35`) | Enforces the shared-channel boundary, densifies the coordinate, then calls `apply_chat_tx` inside `apply_envelope_with` | Shared thread/message writes inherited the gap | Uses the same transactional thread/message/promotion maintenance |
| `RelaySyncClient::pull_shared_channel` (`relay.rs:860,916`) | Bulk loop over inbound shared-channel operations | Each admitted operation inherited the gap | Every admitted operation reaches `apply_shared_envelope`; tested through the real shared path |
| Redelivery in `apply_envelope_with_mutation_outcome` | Matching coordinates at/below the ack are skipped before mutation | Correctly avoided duplicate canonical rows, but could not heal a missing FTS row | New applications create one upserted row; redelivery remains skipped and leaves exactly one FTS result |
| Refusal/boundary rejection | Savepoint rollback or shared boundary failure | Correctly writes no indexed canonical entity | Unchanged; no orphan FTS row can escape the transaction |
| Channel create, decision, reaction, follow, feed-read, attachment, message-parent resolution, and thread `updated_at_ms` changes | Do not change title, author, or body text indexed by local writers | No FTS maintenance expected | No FTS maintenance added |
| Share-view pull (`relay.rs:1137`) | Validates path-scoped operations and does not apply chat mutations | Not a chat writer | Unchanged |

There is no replicated thread-title update operation: the only replicated title
mutation is `chat.thread.create`. The later `updated_at_ms` update does not alter
search text.

## Behavioral coverage

Sync-layer tests:

- `replicated_chat_writers_index_thread_title_message_and_redelivery_idempotently`
- `replicated_untitled_thread_indexes_its_first_message_snippet`
- `chat_message_before_thread_is_parked_and_replayed_after_thread_arrives`
- `shared_channel_correctly_scoped_ops_apply`

Real search-reader integration tests:

- `replicated_chat_apply_is_findable_through_the_real_search_reader`
- `parked_replicated_message_is_findable_after_thread_promotion`
- `shared_channel_replicated_chat_is_findable_through_the_real_search_reader`

The integration tests call
`dohc_engine_runtime::search::query_chat_messages_granular`, not raw FTS SQL.

## Mutation proof

All mutations below compiled and reached the assertion. Each index-maintenance
call was restored immediately after its failure.

### Replicated thread title

Mutation: comment out the new `upsert_chat_search_index_row` call in
`apply_thread`.

Command:

```text
cargo test -p dohc-engine-runtime --test search_r12 replicated_chat_apply_is_findable_through_the_real_search_reader -- --exact --nocapture
```

Failure:

```text
running 1 test
test replicated_chat_apply_is_findable_through_the_real_search_reader ... FAILED

thread 'replicated_chat_apply_is_findable_through_the_real_search_reader' panicked at crates\dohc-engine-runtime\tests\search_r12.rs:917:5:
assertion `left == right` failed
  left: 0
 right: 1

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 15 filtered out
```

Pass after restoration:

```text
running 1 test
test replicated_chat_apply_is_findable_through_the_real_search_reader ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 15 filtered out
```

### Replicated message, duplicate delivery, and shared-channel message

Mutation: comment out the new
`index_replicated_chat_message_search_rows` call in `apply_message`.

Direct/redelivery failure:

```text
running 1 test
test replicated_chat_apply_is_findable_through_the_real_search_reader ... FAILED

thread 'replicated_chat_apply_is_findable_through_the_real_search_reader' panicked at crates\dohc-engine-runtime\tests\search_r12.rs:924:5:
assertion `left == right` failed: duplicate delivery must not duplicate the FTS result
  left: 0
 right: 1

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 15 filtered out
```

Shared-channel failure under the same mutation:

```text
running 1 test
test shared_channel_replicated_chat_is_findable_through_the_real_search_reader ... FAILED

thread 'shared_channel_replicated_chat_is_findable_through_the_real_search_reader' panicked at crates\dohc-engine-runtime\tests\search_r12.rs:1040:5:
assertion `left == right` failed
  left: 0
 right: 1

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 15 filtered out
```

Passes after restoration:

```text
running 1 test
test replicated_chat_apply_is_findable_through_the_real_search_reader ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 15 filtered out

running 1 test
test shared_channel_replicated_chat_is_findable_through_the_real_search_reader ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 15 filtered out
```

### Parked-message promotion

Mutation: comment out the new
`index_replicated_chat_message_search_rows` call in domain
`apply_pending_message`.

Command:

```text
cargo test -p dohc-engine-runtime --test search_r12 parked_replicated_message_is_findable_after_thread_promotion -- --exact --nocapture
```

Failure:

```text
running 1 test
test parked_replicated_message_is_findable_after_thread_promotion ... FAILED

thread 'parked_replicated_message_is_findable_after_thread_promotion' panicked at crates\dohc-engine-runtime\tests\search_r12.rs:972:5:
assertion `left == right` failed
  left: 0
 right: 1

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 15 filtered out
```

Pass after restoration:

```text
running 1 test
test parked_replicated_message_is_findable_after_thread_promotion ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 15 filtered out
```

### Untitled thread's derived header

Mutation: comment out the header `upsert_chat_search_index_row` call inside
`index_replicated_chat_message_search_rows`.

Command:

```text
cargo test -p dohc-engine-sync replicated_untitled_thread_indexes_its_first_message_snippet -- --nocapture
```

Failure:

```text
running 1 test
test tests::replicated_untitled_thread_indexes_its_first_message_snippet ... FAILED

thread 'tests::replicated_untitled_thread_indexes_its_first_message_snippet' panicked at crates\dohc-engine-sync\src\tests.rs:3171:5:
assertion `left == right` failed
  left: ""
 right: "First replicated snippet"

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 234 filtered out
```

Pass after restoration:

```text
running 1 test
test tests::replicated_untitled_thread_indexes_its_first_message_snippet ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 234 filtered out
```

## Canonical gate

Prerequisite:

```text
pnpm install --frozen-lockfile
Lockfile is up to date, resolution step is skipped
Done in 16.2s using pnpm v10.24.0
```

The gate was run with:

```text
TEMP=C:/w/_targets/chatfts/tmp
TMP=C:/w/_targets/chatfts/tmp
CARGO_TARGET_DIR=C:/w/_targets/chatfts
node tools/rust-engine-program/run-rust-checks.mjs
```

Final summary:

```text
== summary ==
  PASS fixture drift
  PASS fmt --check
  PASS clippy -D warnings
  PASS build --workspace
  PASS test --workspace
  PASS cargo-deny
  PASS cargo-audit
```

Final verdict line:

```text
- 2026-07-28T05:41:41.551Z | run-rust-checks | win32/x64 | PASS | fixture drift=PASS fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS cargo-deny=PASS cargo-audit=PASS
```

`cargo-audit` reported the two repository-allowed unmaintained-crate warnings
for `paste 1.0.15` and `smallstr 0.3.1`; the canonical step still passed.

## Could not close

None.
