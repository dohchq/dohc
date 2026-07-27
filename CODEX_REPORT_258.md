# PR #258 review closure report

## P1 — daemon-only CLI reads ran workspace startup maintenance

**Disposition:** Fixed.

`workspace.open` now accepts `skipStartupMaintenance`. The daemon-only CLI read
path sets it together with `recoverRunningDispatches: false`. In that mode the
engine opens the store actor but does not run mention backfill, pending
materialization replay, dispatch reclaim, capture-driver spawn, or baseline
capture. Normal workspace opens and smoke opens retain the existing startup
barriers.

**Named proving tests:**

- `workspace_open_without_startup_maintenance_does_not_capture_disk`
- `Rust engine daemon lifecycle > opens, binds, and closes a workspace around an injected CLI read`

**Mutation result:** Replacing the maintenance gate with
`false && params.skip_startup_maintenance` compiled and failed the Rust test on
its assertion: the supposedly read-only open returned
`Some("typescript-owned")` instead of `None`. Removing
`skipStartupMaintenance: true` from the TypeScript request compiled and failed
the lifecycle test on its request-parameter equality assertion. Both mutations
were restored, and both tests pass.

## P1 — granular chat search bounded only after full materialization

**Disposition:** Fixed.

The daemon-facing runtime query now selects SQLite byte lengths ahead of the
text columns and checks the 256 KiB materialization budget before copying a
matching row into owned Rust strings. The bounded batch crosses the actor
boundary with a `saturated_by_bytes` signal; the RPC preserves the exact
serialized-response cut and reports saturation so the CLI takes its exhaustive
fallback.

The unbounded helper remains only for the separate in-process workspace-search
composition path; the 50,000-row daemon RPC goes through the bounded helper.

**Named proving test:**

- `granular_chat_query_bounds_owned_rows_before_actor_delivery`

**Mutation result:** Disabling the pre-copy byte check with a compile-valid
`false && ...` mutation failed the test on the assertion that the broad query
must report remaining matches after the byte cut. The mutation was restored and
the test passes.

## P2 — unread file-thread RPC returned an unbounded array

**Disposition:** Fixed.

`chats.readState.listUnreadFileThreads` now accepts a bounded `pageLimit`
(default 200, maximum 500) and an `afterThreadId` keyset coordinate. The domain
query filters unread rows, orders by thread id, and applies the SQL limit before
collecting. It still surfaces corrupt read-state rows instead of filtering them
away. The CLI requests 500-row pages until exhaustion, rejects a non-advancing
page, and deduplicates the aggregate.

At the maximum page size, normal validated thread ids keep both the collection
count and serialized response comfortably below DOP1's limits.

**Named proving tests:**

- `unread_file_threads_are_keyset_paginated`
- `CLI socket server > paginates the daemon unread-file aggregate for the human inbox`

**Mutation result:** Replacing the SQL limit bind with `i64::MAX` compiled and
failed the Rust test's first-page assertion with three rows instead of two.
Changing the CLI exhaustion check so a full 500-row page terminated iteration
compiled and failed the CLI test's assertion that the second-page thread was
present. Both mutations were restored, and both tests pass.

## P2 — Rust query trimming diverged from ECMAScript

**Disposition:** Fixed.

`classify_query` now uses the shared `is_js_trim_ws` predicate. This fixes both
granular chat search and the sibling workspace-search path because both build
their MATCH phrase through the same classifier. U+0085 is preserved, while
U+FEFF is trimmed, matching JavaScript.

**Named proving test:**

- `search::query::tests::query_trim_matches_ecmascript_whitespace`

**Mutation result:** Restoring `str::trim()` compiled and failed the test on the
U+0085 MATCH-classification assertion. The mutation was restored and the test
passes.

## Sibling-path audit

- Normal and smoke workspace opens still run all startup maintenance; only the
  daemon-only request path opts out.
- Both search entry points share the corrected ECMAScript classifier. The
  high-cardinality granular daemon path alone crosses the new bounded actor
  batch.
- Unread pagination preserves the prior corrupt-state fail-closed behavior and
  the CLI drains exact-full pages by issuing the necessary final request.
- No database migration was added.

## Verification

- `cargo fmt --all`
- `cargo test -p dohc-engine-domain`
- `cargo test -p dohc-engine-runtime`
- `cargo test -p dohc-workspace-engine`
- `pnpm --filter @dohc/desktop typecheck`
- `pnpm --filter @dohc/desktop test` — 170 files, 2,149 passed, 3 skipped

The first full runtime sweep encountered a scratch-directory `AlreadyExists`
collision before one test body ran. The isolated test passed immediately, and a
second full runtime sweep passed.

No file under `packages/` was modified in this work (`git diff HEAD --stat --
packages/` is empty), and `packages/workspace-engine` remains untouched.
The branch already contained five `packages/workspace-engine-client` changes
relative to `origin/main` before this task, so the broader
`git diff origin/main --stat -- packages/` is not empty even though this work
added no package diff.
