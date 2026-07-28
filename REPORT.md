# AUDIT-KEYENV completion report

Date: 2026-07-28

Branch: `codex/rust-engine-keyenv-daemon`

Base: `edaeb5754fa8c8d51b612abc2211d50467b4786e`

## Outcome

Desktop enrollment no longer imports or invokes the identity-less TypeScript
key-envelope HTTP client. The existing desktop-side wrap, unwrap, and install
operations remain on the desktop side of the daemon RPC boundary. The daemon
client now transports only opaque `envelopeJson` values through `keys.upload`
and `keys.download`.

The legacy uploader's replacement behavior was preserved: create is attempted
without `ifMatch`; a `CONFLICT` causes a `keys.download` for the current ETag
and a bounded compare-and-swap retry, for at most three upload attempts.

## Daemon contract studied

Sources read without modification:

- `crates/dohc-workspace-engine/src/lib.rs`: dispatch at 597-601, handlers at
  1786-1829, parameter structs at 7651-7687, result serialization at
  9882-9901, relay error mapping at 10152-10192.
- `crates/dohc-engine-sync-http/src/lib.rs`: key HTTP transport at 390-451,
  HTTP/server-code mapping at 639-700, strict ETag parsing at 702-715.
- `crates/dohc-engine-protocol/src/error.rs`: wire codes and default retry
  dispositions.
- `packages/workspace-contracts` and `packages/workspace-engine-client`: before
  this change there were no key-envelope-specific request/result types. The
  requester accepted generic method strings and JSON, and its runtime refusal
  decoder recognized only the original protocol codes.

### `keys.upload`

The RPC requires a live daemon workspace handle whose open workspace identity
matches `params.workspaceId`, and that workspace must have relay configuration
from `workspace.open`.

Parameters are camel-case, unknown fields are rejected:

```ts
{
  workspaceId: string;
  envelopeJson: string;
  ifMatch?: string;
}
```

`ifMatch` defaults to absent. The daemon treats `envelopeJson` as opaque text;
it neither parses nor decrypts it. The daemon's workspace actor supplies the
replication epoch and stream identity internally, then issues the relay `PUT
/sync/:workspaceId/keys`. If present, `ifMatch` becomes a quoted `If-Match`
header.

Success:

```ts
{ etag: string }
```

The HTTP transport accepts only a lowercase 64-hex ETag. A missing, malformed,
or non-hex ETag is a relay-invalid-response error.

### `keys.download`

The same live, matching, relay-configured workspace handle is required.
Parameters are camel-case and unknown fields are rejected:

```ts
{ workspaceId: string }
```

The actor again supplies epoch and stream identity internally and issues the
relay `GET /sync/:workspaceId/keys`.

Success:

```ts
{
  envelopeJson: string;
  etag: string;
}
```

The response body is bounded to 16 KiB and must be UTF-8; the ETag has the same
strict 64-hex requirement.

### Error codes and dispositions

`WireError::new` assigns each code's default retryability. The TypeScript
requester exposes `retry: "no"` as disposition `"terminal"`.

| Condition | Wire code | Disposition |
| --- | --- | --- |
| Missing/unknown handle | `WORKSPACE_UNAVAILABLE` | `afterReconnect` |
| Workspace id does not match handle | `INVALID_PARAMS` (`invalid-workspace`) | terminal |
| Missing relay configuration | `INVALID_PARAMS` (`relay-not-configured`) | terminal |
| Missing/wrong/unknown params | `INVALID_PARAMS` (`invalid parameters`) | terminal |
| Relay 401 | `AUTH_FAILED` | terminal |
| Relay CAS 409 | `CONFLICT` | terminal |
| Download `key_envelope_not_found` | `KEY_ENVELOPE_MISSING` | terminal |
| Generic key-route 404 | `WORKSPACE_UNAVAILABLE` | `afterReconnect` |
| Identity/epoch refusal | `EPOCH_SUPERSEDED`, `IDENTITY_NOT_RECOGNIZED`, `IDENTITY_REQUIRED`, or `STREAM_IDENTITY_MISMATCH` | terminal |
| Relay 403 | `FORBIDDEN` | terminal |
| Payload/quota refusal | `PAYLOAD_TOO_LARGE` or `QUOTA_EXCEEDED` | terminal |
| Relay partition/transport I/O | `WORKSPACE_UNAVAILABLE` | `afterReconnect` |
| Bad relay URL/request | `INVALID_PARAMS` | terminal |
| Invalid response, unknown server code, or server/internal HTTP failure | `RELAY_INVALID_RESPONSE` or `INTERNAL` | terminal |
| Daemon deadline/overload while executing | `DEADLINE_EXCEEDED` or `OVERLOADED` | `afterBackoff` |
| Cancellation | `CANCELLED` | terminal |

Desktop translates the enrollment-relevant conditions back to the established
desktop error classes: auth, conflict, missing envelope, and unavailable
workspace. Other recognized daemon refusals retain `DaemonRefusalError` with
their wire code, retryability, and disposition.

The TypeScript client now has explicit key-envelope request/result contracts
owned by `@dohc/workspace-contracts`, a typed method/result decoder in
`@dohc/workspace-engine-client`, and runtime recognition of the daemon's full
relay error-code family. No generated file under
`packages/workspace-engine-client/src/ydoc/**` was touched.

## Call-site enumeration

### Before

Production desktop:

- `apps/desktop/src/main.ts`: imported both legacy functions.
- `apps/desktop/src/main.ts`: one `uploadKeyEnvelope(...)` call in the local-key
  enroll/re-wrap branch.
- `apps/desktop/src/main.ts`: one `downloadKeyEnvelope(...)` call in the
  missing-local-key join/unlock branch.

Other executable test callers found repo-wide and intentionally unchanged:

- `packages/workspace-engine/src/syncRelay.test.ts`: three legacy upload test
  calls.
- `services/sync-relay/src/main.integration.test.ts`: one legacy upload and one
  legacy download call testing the relay service directly.
- `crates/dohc-workspace-engine/tests/rpc_relay.rs`: direct Rust RPC coverage
  for both methods and their cross-workspace refusal.

Definitions/exports, not callers:

- `packages/workspace-engine/src/index.ts`
- `packages/workspace-engine/src/syncRelay.ts`
- Rust dispatch and handler definitions in
  `crates/dohc-workspace-engine/src/lib.rs`

### After

Production desktop:

- `apps/desktop/src/main.ts` invokes `enrollWorkspaceKeyEnvelope(...)` with the
  already-bound `EngineRelayWorkspaceClient`.
- `workspaceKeyEnvelopeEnrollment.ts` invokes the typed daemon methods. It has
  one upload call, one CAS-fingerprint download call, and one enrollment
  download call.
- `engineRelayClient.ts` maps those methods to the real daemon
  `keys.upload`/`keys.download` requests.
- Wrap, unwrap, zeroization, passphrase normalization, and
  `installWorkspaceDataKey` remain desktop-side.

The non-desktop service/package tests above remain legacy-client tests by
design. `packages/workspace-engine` was not modified.

Grep/test proof:

```text
key-envelope transport migration > has no desktop import of the legacy envelope transport
Test Files  1 passed (1)
Tests       1 passed (1)
```

The named guard recursively scans every TypeScript/TSX source under
`apps/desktop/src` for named imports of `uploadKeyEnvelope` or
`downloadKeyEnvelope` from `@dohc/workspace-engine`.

## Sentinel boundary acceptance test

Test:
`apps/desktop/src/workspaces/workspaceKeyEnvelopeEnrollment.test.ts`

Sentinel: the fixed 32 raw bytes represented by
`DOHC_RAW_KEY_SENTINEL_20260728!!`.

The test uses the real desktop crypto helpers and the real enrollment unit,
`EngineRelayClient`, `EngineWorkspaceSessions`,
`RelayConfiguredDaemonClientSource`, and `WorkspaceDaemonRequester`. Only the
daemon process/relay endpoint is mocked.

The boundary recorder captures:

- every outbound daemon `Request`, including decorated `workspace.open` and
  all `keys.*` frames;
- every inbound success `Response`;
- every inbound error frame;
- every mock-daemon event and every event observed by the real registered
  transport listener; the event payload is populated from the actual
  `keys.*` request/response content, including the opaque envelope;
- the mock-daemon stderr diagnostic channel, likewise populated from the
  actual `keys.*` request/response content;
- raw transport error objects, translated desktop error objects, and the
  final error rejected by the enrollment unit.

The RPC frames and error objects are live captures through the production
desktop client stack. Events and stderr are deliberately mock-authored
diagnostic surfaces carrying live boundary content; they are not captured
output from a real Rust daemon process.

Paths driven:

1. Local sentinel key -> real wrap -> successful real `keys.upload` request.
2. Opaque pre-wrapped sentinel envelope -> successful real `keys.download`
   response -> real unwrap -> desktop install callback. The installed bytes
   are proven equal to the sentinel without including that desktop-only
   callback argument in the RPC capture.
3. Upload refusal with `FORBIDDEN`, proven to become a terminal
   `DaemonRefusalError`.
4. Missing download with `KEY_ENVELOPE_MISSING`, proven to become
   `RelayKeyEnvelopeMissingError` and follow the real enrollment no-envelope
   path.

Every recorded surface is checked for:

- raw/ASCII bytes;
- base64;
- hex;
- JSON string encoding;
- per-byte `\u00xx` encoding;
- JSON numeric byte-array encoding.

Only the randomized wrapped envelope crosses the boundary.

Passing tail:

```text
✓ workspaceKeyEnvelopeEnrollment.test.ts (4 tests)
  > keeps the raw-key sentinel out of live RPC/error captures and mock diagnostics
Test Files  1 passed (1)
Tests       4 passed (4)
```

## Mutation proofs

### A. Leak the raw key in place of the envelope

Mutation applied temporarily:

```ts
await uploadReplacingCurrentEnvelope(
  input.transport,
  input.dataKey.toString("ascii"),
);
```

Behavioral failure:

```text
FAIL workspace key-envelope daemon custody boundary
AssertionError: MUTATION: raw workspace key sentinel leaked into upload boundary
as DOHC_RAW_KEY_SENTINEL_20260728!!: expected true to be false
- Expected false
+ Received true
Test Files  1 failed (1)
Tests       1 failed (1)
```

After restoring `envelopeJson`:

```text
Test Files  1 passed (1)
Tests       1 passed (1)
```

### B. Route a call through the legacy TypeScript relay client

Mutation applied temporarily: reintroduced the
`downloadKeyEnvelope` import in `main.ts` and invoked it with the enrollment
relay connection before the daemon enrollment call.

Named guard failure:

```text
FAIL key-envelope transport migration
  > has no desktop import of the legacy envelope transport
AssertionError: MUTATION: desktop key enrollment routed back through the
identity-less TypeScript relay client
+ { "name": "downloadKeyEnvelope", "path": "main.ts" }
Test Files  1 failed (1)
Tests       1 failed (1)
```

After restoring the daemon-only route:

```text
Test Files  1 passed (1)
Tests       1 passed (1)
```

## Validation

No `cargo` command was run.

`pnpm --filter @dohc/desktop test` final run:

```text
Test Files  181 passed | 1 skipped (182)
Tests       2262 passed | 4 skipped (2266)
Duration    36.52s
```

The first full run had two unrelated timing flakes
(`FileInspector.test.tsx` timeout and the daemon lifecycle restart timer).
Both passed together in isolation (68 passed, 1 skipped), and the unchanged
full suite then passed as shown above.

`pnpm -r --if-present typecheck` tail:

```text
packages/workspace-engine-client typecheck: Done
services/agent-sandbox typecheck: Done
packages/workspace-engine typecheck: Done
apps/desktop typecheck: Done
services/sync-relay typecheck: Done
```

`git diff --check`: clean.

## Unclosed items / daemon-surface gaps

For a daemon-routed workspace, no `keys.upload`/`keys.download` parameter,
result, or error-disposition gap remains.

One rollout dependency remains outside this shard's allowed routing scope:
the handlers require a daemon workspace handle, while
`relayClientForWorkspace` returns `null` for a root that is still selected for
TypeScript transport. Enrollment now fails closed before claiming the relay in
that case, with
`Rust engine relay transport is required to claim and enroll this workspace.`,
rather than mixing an identity-less envelope client with daemon sync or
bypassing the transport-mode authority. The in-flight transport-selection
shard must make production enrollment roots daemon-routed before the flip.
`relayClientForWorkspace` and `engineRelayClient.ts` transport-mode selection
were not changed.

The checked-in generated TypeScript `ErrorCode` union predates the relay codes.
Because `packages/workspace-engine-client/src/ydoc/**` is explicitly owned by
another shard, this change adds the current relay codes to the non-generated
daemon decoder/type. Regenerating those bindings remains a protocol-generation
follow-up; it is not a runtime blocker for this flow.

## ROUND2 — conflict retry coverage and review follow-ups

### Production-stack conflict coverage

`workspaceKeyEnvelopeEnrollment.test.ts` now drives the private
`uploadReplacingCurrentEnvelope` loop through the public
`enrollWorkspaceKeyEnvelope` entry point and the production
`EngineRelayClient` -> `EngineWorkspaceSessions` -> daemon-requester stack.
The recording daemon scripts and verifies three nontrivial sequences:

1. create upload -> `CONFLICT` -> `keys.download` returns a current etag ->
   second upload succeeds with that exact etag in `ifMatch`;
2. create upload -> `CONFLICT` -> `keys.download` returns
   `KEY_ENVELOPE_MISSING` -> second create-only upload succeeds without
   `ifMatch`;
3. three upload conflicts (with the intervening current-envelope downloads)
   -> terminal `RelayConflictError` with
   `Relay key envelope kept changing concurrently; upload did not complete.`;
   the recorder proves exactly three upload attempts.

The fail-closed guard now says the Rust relay transport is required to
`claim and enroll this workspace`, matching the fact that it gates both
operations.

### Mutation proof — retry loses `ifMatch`

Temporary mutation: removed the conditional `ifMatch` property from the
production retry upload:

```ts
await transport.uploadKeyEnvelope({
  envelopeJson,
});
```

Named behavioral failure:

```text
FAIL workspace key-envelope conflict retries
  > retries a create conflict with the downloaded etag as ifMatch
AssertionError: expected the second keys.upload params to match
{ ifMatch: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }
Received keys.upload params with only envelopeJson and workspaceId.
Test Files  1 failed (1)
Tests       1 failed | 3 skipped (4)
```

After restoring the conditional property:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

### Mutation proof — raw key leaks through the enrollment error

Temporary mutation: on an upload error, appended both `envelopeJson` and
`input.dataKey.toString("ascii")` to the propagated error message. The
sentinel test now records the final enrollment rejection as well as the raw
transport and translated errors.

Named behavioral failure:

```text
FAIL workspace key-envelope daemon custody boundary
  > keeps the raw-key sentinel out of live RPC/error captures and mock diagnostics
AssertionError: MUTATION: raw workspace key sentinel leaked into upload
refusal boundary as DOHC_RAW_KEY_SENTINEL_20260728!!
Test Files  1 failed (1)
Tests       1 failed | 3 skipped (4)
```

After restoring the error path:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

### ROUND2 validation

No `cargo` command was run.

`pnpm -r --if-present typecheck` passed across all 22 participating projects:

```text
packages/workspace-engine typecheck: Done
services/agent-sandbox typecheck: Done
packages/workspace-engine-client typecheck: Done
services/sync-relay typecheck: Done
apps/desktop typecheck: Done
```

`pnpm --filter @dohc/desktop test` final run:

```text
Test Files  181 passed | 1 skipped (182)
Tests       2265 passed | 4 skipped (2269)
Duration    40.58s
```

Two preceding full runs each hit one of the already-documented, unrelated
timing flakes under full-suite load:

- `FileInspector.test.tsx` remained on `Loading editor...` past the default
  query timeout; the unchanged file then passed in isolation (53/53).
- `engineDaemonLifecycle.test.ts` missed the third restart inside its
  `vi.waitFor` window; the unchanged file then passed in isolation
  (15 passed, 1 skipped).

The third unchanged exact full-suite run passed as shown above.

Protocol-generation follow-up: the hand-maintained `DaemonErrorCode` list
duplicates the Rust enum. Regenerating the ts-rs `ErrorCode.ts` mirror is the
right long-term fix and remains owned by the protocol-generation tooling.
