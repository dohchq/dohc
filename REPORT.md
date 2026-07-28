# Rust-engine Y.Doc loss containment

## Design summary

The TypeScript live adapter now treats a refused `ydoc.recordUpdate` as a
recoverable divergence instead of permanently rejecting its journal chain.
Recovery:

1. calls `ydoc.resync` for the daemon's full durable Yjs state;
2. validates that state in a separate Y.Doc and merges it into the canonical
   adapter document;
3. computes the canonical-minus-daemon state delta;
4. journals that replay with a fresh idempotency key; and
5. resumes the contained record chain only after the replay is accepted.

If the original request committed but its response was lost, the resync already
contains the edit and no replay is needed. If resync or replay is refused, the
operation rejects, the provider/capture error channels surface it, and the
session becomes loudly unusable rather than accepting more silent-loss edits.
Recovery reconstructs only the refused transaction against the durable state;
updates queued while resync is in flight remain behind it and keep their own
actor provenance.

Both adapter and provider close paths contain rejected journal/settle drains.
They always reach `ydoc.close`; only a close-RPC failure can keep the adapter
lease live. A provider pre-close settle error is remembered until after the
close RPC succeeds, so a retry observes `closeComplete` and the capture
`failing-close` guard converges.

The desktop restart-safe wrapper no longer applies a renderer update to the
adapter's own Y.Doc before calling `applyLocalUpdate` (which made the provider's
second apply idempotent and therefore unjournaled). It applies through the
provider first and then updates the stable canonical doc. On a failed apply it
preserves the renderer-accepted update in that canonical doc and rebinds/replays:

- transport/restart error: open the replacement first, then retire the dead
  generation;
- live non-reconnect refusal: close the failed generation first to release its
  daemon lease, then open and replay into the replacement.

Replacement replay failures close the replacement lease, surface through
capture `onError`, and leave no silently divergent live generation.

## Mutation proof

Each mutation was applied alone, the named test was run, then the fix was
restored and the same test passed.

### Adapter chain and close containment

Mutation: restored a rejected `recordChain` and bare `await this.recordChain` in
`close()`.

```text
FAIL YdocLiveAdapter > always sends ydoc.close after an unrecoverable poisoned record chain
AssertionError: promise rejected "Error: injected resync refusal" instead of resolving
Test Files  1 failed (1)
Tests       1 failed | 24 skipped (25)
```

Restored:

```text
Test Files  1 passed (1)
Tests       1 passed | 24 skipped (25)
```

### Provider drain containment

Mutation: restored bare `await journalChain; await settleChain;`.

```text
FAIL YdocLiveAdapter > surfaces an unrecoverable journal update and still closes the provider
AssertionError: promise rejected "Error: injected record failure" instead of resolving
Test Files  1 failed (1)
Tests       1 failed | 24 skipped (25)
```

Restored:

```text
Test Files  1 passed (1)
Tests       1 passed | 24 skipped (25)
```

### Refused-update resync and replay

Mutation: rethrew the first `recordUpdate` refusal instead of invoking canonical
resync/replay.

```text
FAIL YdocLiveAdapter > resyncs and replays a refused update, then journals subsequent edits
Error: injected one-shot record refusal
Test Files  1 failed (1)
Tests       1 failed | 24 skipped (25)
```

Restored:

```text
Test Files  1 passed (1)
Tests       1 passed | 24 skipped (25)
```

### Desktop non-reconnect recovery

Mutation: restored the non-reconnect rethrow before rebind/replay.

```text
FAIL recovers a non-reconnect local refusal by releasing, rebinding, and replaying
AssertionError: expected 'seed' to be 'seed survives'
Expected: "seed survives"
Received: "seed"
Test Files  1 failed (1)
Tests       1 failed | 2 skipped (3)
```

Restored:

```text
Test Files  1 passed (1)
Tests       1 passed | 2 skipped (3)
```

### Loud unrecoverable failure

Mutation: swallowed the terminal local-update rejection instead of forwarding
it to capture `onError`.

```text
FAIL surfaces an unrecoverable local refusal and releases every opened lease
AssertionError: expected "spy" to be called with arguments
Number of calls: 0
Test Files  1 failed (1)
Tests       1 failed | 2 skipped (3)
```

Restored:

```text
Test Files  1 passed (1)
Tests       1 passed | 2 skipped (3)
```

The restored test also enforces lease convergence: both failed generations are
closed, the public close succeeds, and generation 3 reopens without
`ydoc-session-busy`.

## Validation

### Workspace-engine client

Command: `pnpm --filter @dohc/workspace-engine-client test`

```text
Test Files  6 passed (6)
Tests       182 passed (182)
Duration    1.57s
```

### Desktop suite

Command: `pnpm --filter @dohc/desktop test`

```text
Test Files  179 passed | 1 skipped (180)
Tests       2262 passed | 4 skipped (2266)
Duration    41.50s
```

The skips are pre-existing/configured suite skips. The new
`workspaceEngineYDocRestart.test.ts` cases all ran and passed.

An intermediate full-suite rerun hit two unrelated `FileInspector.test.tsx`
timing flakes (the async editor was still loading and one test reached its 5s
timeout). The file passed immediately in isolation (53/53), and the final full
desktop command above passed cleanly.

### Real daemon e2e

The existing binary was present at
`target/debug/dohc-workspace-engine.exe`. No Cargo command was run.

Command:
`pnpm --filter @dohc/desktop test -- src/workspaces/workspaceEngineCaptureRust.e2e.test.ts`

```text
Test Files  1 passed (1)
Tests       1 passed (1)
drives watcher-batch capture, readback, and version-switch materialization through the real daemon
```

The daemon does not expose the unit-test refusal fault seam, so the refused
record/resync cases remain covered by transport mocks and their mutation proof.

### Recursive typecheck

Command: `pnpm -r --if-present typecheck`

```text
Scope: 22 of 23 workspace projects
packages/workspace-engine-client typecheck: Done
apps/desktop typecheck: Done
services/sync-relay typecheck: Done
Exit code: 0
```

## Anything not closed

No known product-path issue remains open for these two bugs. No Rust source,
legacy `packages/workspace-engine`, or integrator-owned plan was modified.
