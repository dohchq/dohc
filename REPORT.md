# P1 relay transport routing fix

## Result

Rooted desktop workspaces no longer inspect `.dohc/engine/SHADOW_CLONE` to
choose a relay implementation. Every rooted relay surface binds the Rust daemon
client. The only remaining TypeScript relay route is the rootless join probe,
which is a transient HTTP-only route and is released after the probe finishes.

If the Rust relay client is unavailable, rooted relay construction throws
`Rust engine relay client is unavailable.` No rooted call site can omit daemon
operations and silently enter the legacy TypeScript SQLite path.

## Design implemented

- Deleted `relayTransportModeForRoot`, including its synchronous filesystem
  imports and marker validation.
- Made `relayClientForWorkspace` return a non-null
  `EngineRelayWorkspaceClient`. It either binds `rustEngineRelayClient` or
  throws.
- Removed the rooted TypeScript fallbacks from:
  - workspace push, pull, and origin recovery;
  - relay workspace claim;
  - joined shared-channel push and pull;
  - manual shared-channel join;
  - received-DM auto-join;
  - shared-view bootstrap and refresh.
- Kept `RelayTransportRouteGuard`. Rooted binds still pass through
  `EngineRelayClient.bind`, which locks the route to `daemon`.
- Bound the synthetic `relay-probe:<workspaceId>` route explicitly to
  `typescript` and release it in `finally`. This is necessary so a successful
  preflight cannot poison the subsequent rooted daemon bind for the same
  workspace ID. Probe cleanup is mode-conditional, so a late cleanup cannot
  release a newer daemon route.

## Bind ordering audit

`EngineRelayClient.bind` does not read the filesystem, open `engine.db`, or
send `workspace.open`. At bind time it only:

1. records the daemon relay route and credentials;
2. captures the workspace identity and connection key;
3. returns RPC-backed operation closures.

The first operation enters `EngineWorkspaceSessions.run`. Its open path calls
`openWithClient`, which awaits `prepareWorkspace(rootPath)` before sending
`workspace.open`. `prepareWorkspace` creates or validates the shadow marker and
the engine directories. Therefore the existing session lifecycle already
provides the required ordering: preparation is awaited before daemon open, not
before relay bind.

Preparation, daemon availability, open, and RPC failures propagate through the
daemon operation. No code catches them to select the legacy relay.

## Rootless probe verification

I read `probeRelayWorkspace` in
`packages/workspace-engine/src/syncRelay.ts`. It calls `jsonRelay` exactly once
with:

```text
GET /sync/<workspaceId>/log?since=0&limit=1
```

It returns `hasContent: page.ops.length > 0`. The function accepts only a
workspace ID and relay connection: no root path, engine store, database, or
filesystem argument is constructed or accessed. It performs no HTTP write.
The four existing probe tests cover synced, owned-empty, unavailable, and
unauthorized workspaces.

## `relayTransportModeForRoot` callers

Before:

1. `main.ts` `relayClientForWorkspace(input.rootPath)` — rooted routing for
   seven desktop surfaces.
2. `main.ts` `probeWorkspaceRelay(null)` — rootless preflight routing.
3. `engineRelayClient.test.ts` — the old test called it four times to assert
   marker-less/forged roots were TypeScript and a valid marker selected daemon.

The seven rooted `relayClientForWorkspace` call sites were:

1. periodic joined shared-channel sync;
2. cloud relay engine construction;
3. enable-sync workspace claim;
4. manual shared-channel join;
5. initial shared-view pull;
6. shared-view refresh;
7. received-DM auto-join.

After:

- `relayTransportModeForRoot` has been deleted; there are zero callers.
- All seven rooted sites call the non-null daemon binder.
- `probeWorkspaceRelay` is the only production `mode: "typescript"` bind and
  uses the synthetic root `relay-probe:<workspaceId>`.

## Tests added or rewritten

- Replaced the marker-sniff behavior test with:
  `binds a marker-less rooted workspace to the daemon before session preparation`.
  It asserts the route is already `daemon` while no daemon request or session
  preparation has occurred.
- Added:
  `allows a rooted daemon bind after a rootless probe route is released`.
- Renamed and retained the mocked legacy-operation assertion as:
  `never invokes legacy TypeScript relay operations for a rooted daemon operation set`.
  Its mocks assert `pushWorkspaceToRelay`, `pullWorkspaceFromRelay`, and
  `recoverRelayOrigin` are never invoked.
- Re-ran the four rootless probe tests.

## Mutation proof

Mutation: changed the rooted route in `EngineRelayClient.bind` from
`mode: "daemon"` to `mode: "typescript"`.

Fail:

```text
FAIL src/workspaces/engineRelayClient.test.ts > EngineRelayClient >
binds a marker-less rooted workspace to the daemon before session preparation

AssertionError: MUTATION: a rooted workspace must never bind the legacy
TypeScript relay: expected 'typescript' to be 'daemon'

Expected: "daemon"
Received: "typescript"

Test Files  1 failed (1)
Tests       1 failed | 8 skipped (9)
```

After restoring `mode: "daemon"`:

```text
Test Files  1 passed (1)
Tests       1 passed | 8 skipped (9)
Duration    1.96s
```

## Verification output tails

Focused relay tests, final state:

```text
✓ src/workspaces/relaySyncEngine.test.ts (18 tests)
✓ src/workspaces/engineRelayClient.test.ts (10 tests)
Test Files  2 passed (2)
Tests       28 passed (28)
```

Rootless probe:

```text
✓ src/syncRelay.test.ts (26 tests | 22 skipped)
Test Files  1 passed (1)
Tests       4 passed | 22 skipped (26)
```

Recursive typecheck:

```text
Scope: 22 of 23 workspace projects
packages/workspace-engine typecheck: Done
apps/desktop typecheck: Done
services/sync-relay typecheck: Done
Exit code: 0
```

Complete desktop suite, final source, one worker:

```text
pnpm --filter @dohc/desktop exec vitest run --maxWorkers=1 --minWorkers=1
Test Files  179 passed | 1 skipped (180)
Tests       2260 passed | 4 skipped (2264)
Exit code: 0
```

## Anything not closed

The exact default parallel command `pnpm --filter @dohc/desktop test` did not
produce a green run on this machine despite repeated attempts. Failures changed
between attempts and were unrelated to this patch:

- `DocumentMenu` delayed export calls leaked into the next test; that file
  passed 8/8 in isolation.
- `FileInspector` lazy editor waits timed out under parallel load.
- `engineDaemonLifecycle` restart timing failed once.
- `workspaceFiles` oversized-zip timing exceeded its 5-second test timeout once.

The complete suite passed twice with one worker, including once against the
final source. Focused relay tests, probe tests, desktop typecheck, and the
recursive typecheck are green. No Cargo command was run.
