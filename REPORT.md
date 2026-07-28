# P1 relay transport routing fix

## Result

Rooted desktop workspaces no longer inspect `.dohc/engine/SHADOW_CLONE` to
choose a relay implementation. Every rooted stateful relay push/pull surface,
including share mounts, binds the Rust daemon client. The remaining TypeScript
HTTP surface is the transient rootless join probe plus share metadata reads;
those reads open no store and perform no writes.

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

After ROUND 2:

- `relayTransportModeForRoot` has been deleted; there are zero callers.
- All nine rooted stateful sites call the non-null daemon binder: the seven
  listed above plus mount bootstrap and bulk mount refresh.
- `probeWorkspaceRelay` is the only production `mode: "typescript"` guard
  bind and uses the synthetic root `relay-probe:<workspaceId>`.
- Direct TypeScript HTTP remains for `fetchShareViewInfo` and
  `fetchSharedChannelInfo`. These are metadata-only reads with no daemon
  method, local store access, or write.

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

---

# ROUND 2

## Result

Both requested P1 fixes are implemented.

Share mounts now take the daemon path, not the sanctioned-TypeScript-enclave
alternative. A mount has all information required by the existing daemon
binder:

- root: `shared-with-me/<label>`;
- store workspace ID: `share-mount-<shareId>`;
- relay origin and bearer token.

`relayTargetForShareMount` derives that nested target. Mount bootstrap and bulk
refresh bind it with `relayClientForWorkspace`, then pass
`daemonRelay.pullShareView` into the now-required `refreshShareMountOnce.pull`
operation. The daemon therefore opens and serves the mount's own nested
`engine.db`. Rollback, ended-share cleanup, and unmount close that nested daemon
session before deleting its folder, which also avoids deleting an open SQLite
store on Windows.

The daemon's `SHARE_UNAVAILABLE` refusal is now accepted by the TypeScript wire
decoder and translated to `ShareUnavailableError`. Shared-view and
shared-channel consumers can consequently downgrade revoked shares to `ended`
instead of logging/retrying them as transient failures.

## Latent fallback removal

The following operation seams are now required at compile time:

- `refreshSharedViewOnce.pull`;
- `refreshShareMountOnce.pull`;
- `syncJoinedSharedChannels.pull` and `.push`;
- `createRelaySyncEngine.operations`.

The legacy TypeScript implementations remain only as type references in these
modules. There is no runtime default expression that can select them.

## Remaining TypeScript relay HTTP surface

Known remaining direct TypeScript HTTP calls are:

1. rootless join preflight through `probeWorkspaceRelay`;
2. `fetchShareViewInfo` for shared-view open and mount bootstrap;
3. `fetchSharedChannelInfo` for manual channel join and received-DM auto-join.

The metadata calls have no daemon method on this branch. They do not open or
write a local engine store. The rootless probe remains explicitly bound
`typescript` and is released in `finally`.

## Regression tests

- `opens a share mount's nested store and pulls it through the daemon` runs
  `refreshShareMountOnce` with a bound daemon client and asserts
  `workspace.open` targets the nested mount root/store ID before
  `share.view.pull`.
- `translates a revoked daemon share and lets the shared-view consumer report
  ended` throws the daemon's actual wire shape (`SHARE_UNAVAILABLE`,
  `workspace operation failed`, retry `no`) through `EngineRequestError` and
  the real daemon refusal decoder. It first asserts `ShareUnavailableError`,
  then asserts the shared-view consumer returns `{ status: "ended" }` and the
  shared-channel consumer records the revoked channel in `endedShareIds`.
- `allows a rooted daemon bind after a rootless probe route is released` now
  executes the production `probeWorkspaceRelay` helper. Its probe is held
  in-flight while a newer daemon route is installed; the mode-conditional
  `finally` cleanup must preserve that daemon route.

Focused final state:

```text
Test Files  5 passed (5)
Tests       61 passed (61)
```

## Required mutation proof

Mutation: removed only the new
`SHARE_UNAVAILABLE -> ShareUnavailableError` branch.

```text
FAIL EngineRelayClient >
translates a revoked daemon share and lets the shared-view consumer report ended

expected DaemonRefusalError: workspace operation failed
to be an instance of ShareUnavailableError

Test Files  1 failed (1)
Tests       1 failed | 11 skipped (12)
```

After restoring the mapping:

```text
Test Files  1 passed (1)
Tests       1 passed | 11 skipped (12)
```

## Requested validation

```text
pnpm -r --if-present typecheck
Scope: 22 of 23 workspace projects
apps/desktop typecheck: Done
services/sync-relay typecheck: Done
Exit code: 0
```

```text
pnpm --filter @dohc/desktop test
Test Files  179 passed | 1 skipped (180)
Tests       2263 passed | 4 skipped (2267)
Exit code: 0
```

The exact parallel command completed green once. A final rerun after expanding
the same daemon regression test to cover the shared-channel consumer hit one
unrelated, already-known `FileInspector` 5-second timeout:

```text
Test Files  1 failed | 178 passed | 1 skipped (180)
Tests       1 failed | 2262 passed | 4 skipped (2267)
```

The timed-out test passed immediately in isolation:

```text
Test Files  1 passed (1)
Tests       1 passed | 52 skipped (53)
```

The final `engineRelayClient.test.ts` passed 12/12, and the final desktop
typecheck passed.

No Cargo command was run.
