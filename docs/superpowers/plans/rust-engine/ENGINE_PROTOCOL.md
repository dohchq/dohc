# Engine protocol — R03 spike report and recommendation

> Shard: R03 (Wave 0). Status: spike complete; recommendation awaiting Ice's
> approval (open decision 1). The skeleton lives in
> `crates/dohc-engine-protocol` (dormant, standalone, unreachable from
> product code).

## Recommendation

**Length-framed JSON control frames + raw binary blob-chunk frames, with the
serde-annotated Rust wire structs as the single schema source** (ts-rs emits
the TypeScript types; schemars emits JSON Schema for runtime validation).
CBOR/MessagePack and Protobuf are rejected for v1 — with the framing layer
deliberately codec-agnostic (a one-byte frame-type header and
capability-negotiated encodings) so a binary envelope codec remains a
non-breaking upgrade if envelope encoding ever shows up in a real profile.

### Why, in one paragraph

The codec choice only governs **control envelopes and metadata payloads** —
blobs ride raw binary chunk frames in every candidate design, which is where
the real bytes are (raw chunk framing moves a 4 MiB blob at 4.7–6.6 GB/s vs
0.4–0.5 GB/s for base64-in-JSON; that 10–20× gap is the design decision that
matters, and it is codec-independent). On the worst realistic metadata
payload we measured — a 10,000-entry scan manifest — the total Rust-side
spread between JSON and the fastest binary codec is **under 1.5 ms per
operation** against a 1,500 ms workspace-open budget, and the *JavaScript*
peer (the desktop client that must decode every response) parses that same
manifest fastest as JSON, because `JSON.parse` is V8-native while JS
CBOR/MessagePack decoders are userland. Meanwhile JSON is the only candidate
that strongly satisfies the requirements Protobuf is structurally weak on:
runtime validation (proto3 makes every field optional-with-default; JSON
Schema + serde reject malformed input outright), deterministic
**human-readable** fixtures consumable by both test suites, redaction-safe
loggable diagnostics, and — decisive for portability guardrail 3 — one set of
typed Rust structs that serve as both domain currency and wire schema, so the
in-process direct-call transport passes them without a prost-type mapping
layer. We pay ~0.8 ms per 10k-file manifest decode for a protocol agents can
read in a text editor.

## Candidates evaluated

| | A: framed JSON + binary chunks | B: CBOR / MessagePack | C: Protobuf |
| --- | --- | --- | --- |
| Envelope encoding | JSON (serde_json) | CBOR (ciborium) / MessagePack (rmp-serde) | proto3 (prost) |
| Schema source | Rust structs (serde derive) | Rust structs (serde derive) | `.proto` files |
| TS types | ts-rs (generated, committed) | ts-rs (same) | ts-proto / protobuf-es |
| TS runtime validation | generated JSON Schema (ajv-class) | hand-rolled (no mature CDDL toolchain) | decoder only; fields optional by design |
| Blob bytes | raw chunk frames | raw chunk frames (native `bytes` possible but unbounded-frame hazard) | raw chunk frames (embedded `bytes` same hazard) |

All three candidates share the same frame header, session model, error
taxonomy, and bounds — those were designed once and are codec-independent.
The decision reduces to: *what encodes the control envelope, and what
generates/validates the TypeScript side?*

## Requirement-by-requirement scorecard

Every bullet from the plan's "Engine protocol" section. ✓ = satisfied
cleanly, ~ = workable with real effort, ✗ = structurally weak.

| # | Requirement | A: JSON | B: CBOR/MsgPack | C: Protobuf | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | Language-neutral schema, generated TS bindings | ✓ | ~ | ✓ | A: serde structs → ts-rs types + schemars JSON Schema, both committed under `generated/`; proven in this spike. B: same types, but no standard schema artifact for a binary encoding (CDDL tooling is immature). C: `.proto` is the gold standard for this one requirement. |
| 2 | Runtime validation both sides | ✓ | ~ | ✗ | A: Rust rejects unknown envelope types/wrong shapes via serde + explicit `validate()` bounds; TS validates against the generated JSON Schema (spike ships a subset validator; production uses ajv). C: proto3 cannot distinguish absent from default, all fields optional — validation must be an entirely separate hand-written layer on both sides. |
| 3 | Explicit protocol/storage compatibility versions | ✓ | ✓ | ✓ | `PROTOCOL_VERSION` in `hello`/`helloAck`; storage `schema_version = 2` is deliberately a separate axis (R04). Codec-independent. |
| 4 | Authenticated parent-child session | ✓ | ✓ | ✓ | Parent-issued token via env, echoed in `hello`; anything before a valid `hello` → `AUTH_FAILED` + close. Same design as the kernel seed, hardened to session scope. |
| 5 | Opaque workspace handles | ✓ | ✓ | ✓ | `WorkspaceHandle` is a server-issued opaque string, invalid across session generations; client-supplied paths/IDs are never authority. |
| 6 | Request IDs, deadlines, cancellation, idempotency keys | ✓ | ✓ | ✓ | All four are first-class `Request`/`Cancel` fields; the supervisor skeleton enforces deadlines (clamped to a max) and cooperative cancellation, with tests. |
| 7 | Ordered event sequence numbers + session generations | ✓ | ✓ | ✓ | `Event { seq, session_generation }`; gap ⇒ client resynchronizes; generation dies with the sidecar. |
| 8 | Bounded frame/string/collection/blob/batch sizes | ✓ | ✓ | ~ | `WireLimits` enforced by encoder *and* decoder, advertised in `helloAck`; limit−1/limit/limit+1 tests for every bound. C: prost enforces no bounds during decode; each limit becomes post-decode manual checking (and `bytes` fields allocate before you can check). |
| 9 | Blob streaming without base64 | ✓ | ✓ | ✓ | Codec-independent by design: `blobStart` envelope + raw `BlobChunk` frames with FIN flag. Measured 10–20× over base64-in-JSON. |
| 10 | Backpressure with explicit overload errors | ✓ | ✓ | ✓ | Bounded submit queue; overflow → typed `OVERLOADED` (`afterBackoff`), tested. Event-direction flow control is an open design item for the freeze (see gaps). |
| 11 | Retryability classification | ✓ | ✓ | ✓ | `Retryability` enum on every wire error, with per-code defaults (`no` / `immediate` / `afterBackoff` / `afterReconnect`). |
| 12 | Stable machine error codes | ✓ | ✓ | ✓ | `ErrorCode` SCREAMING_SNAKE strings, append-only after freeze. |
| 13 | Capability negotiation | ✓ | ✓ | ✓ | `hello.capabilities` ∩ engine → `helloAck.capabilities`; new features (including a future binary envelope codec) gate on a capability, never on sniffing. |
| 14 | Restart/reconnect | ✓ | ✓ | ✓ | `hello.lastSessionGeneration` lets the engine distinguish resume-after-restart; a fresh generation always invalidates old handles/seqs; retryable mutations replay by idempotency key. |
| 15 | Redaction-safe diagnostics | ✓ | ~ | ~ | A: `WireError.message` is contractually redaction-free-text (constructor-documented), decode errors carry positions/bounds — never input content — and a JSON control stream is directly loggable/inspectable. B/C: same error types, but every diagnostic/log/fixture needs a decoder tool in the loop, which in practice means ad-hoc hex dumps. |
| 16 | Deterministic fixtures readable by both suites | ✓ | ✗ | ✗ | A: `fixtures/envelopes.json` + sorted-key canonical encoding; the identical file is asserted byte-for-byte by `cargo test` (tests/fixtures.rs) and `node --test` (ts/roundtrip.test.mts) — proven in this spike. B/C: fixtures are binary blobs; "readable" requires companion tooling and they do not diff in review. |
| 17 | Named fault points as first-class testkit feature | ✓ | ✓ | ✓ | Protocol-level answer: a reserved `testkit.` method namespace behind a `testkit` capability that only test builds advertise (`testkit.fault.arm {name, action}` etc.). Fault points ride ordinary requests, so one recorded trace drives both engines. Full catalog is R01-ORACLE's `TEST_ORACLE.md`. |
| 18 | In-process direct-call transport (no serialization for same-process callers) | ✓ | ✓ | ✗ | A/B: the serde structs are the transport currency; `InProcessTransport` forwards them with zero encode (proven by test). C: prost-generated types would either become the domain types (defaulted/optional fields everywhere — fights the "typed state" goal) or require a second struct set + mapping layer that the in-process path must skip — i.e., the schema stops describing the actual in-process contract. |

**Totals: A 18✓ / 0~ / 0✗ · B 14✓ / 3~ / 1✗ · C 13✓ / 2~ / 3✗.**

## Measurements

Windows x64, `cargo run --release --example codec_bench`
(rustc 1.96.1, best of 5 runs; reproduce anytime). MB/s is relative to the
logical payload size.

### Small request envelope (~140 B logical)

| codec | bytes | encode µs/op | decode µs/op | enc MB/s | dec MB/s |
| --- | --- | --- | --- | --- | --- |
| JSON (serde_json) | 128 | 0.10 | 0.28 | 1242 | 450 |
| CBOR (ciborium) | 100 | 0.24 | 0.50 | 529 | 257 |
| MessagePack (rmp, named) | 99 | 0.21 | 0.18 | 609 | 703 |
| Protobuf (prost) | 46 | 0.05 | 0.13 | 2600 | 966 |

Sub-microsecond for every candidate: the common case is free everywhere.

### 10,000-entry file manifest (scan/reconcile result shape — the metadata-heavy worst case)

| codec | bytes | encode µs/op | decode µs/op | enc MB/s | dec MB/s |
| --- | --- | --- | --- | --- | --- |
| JSON (serde_json) | 1,690,715 | 1,223 | 2,837 | 1382 | 596 |
| CBOR (ciborium) | 1,535,568 | 875 | 4,522 | 1933 | 374 |
| MessagePack (rmp, named) | 1,535,568 | 842 | 2,219 | 2008 | 762 |
| Protobuf (prost) | 1,276,151 | 498 | 2,039 | 3396 | 829 |

Worst-case JSON penalty vs the fastest candidate: ~0.7 ms encode + ~0.8 ms
decode **per 10k-file response**, against a 1,500 ms workspace-open budget
(and the hashing/scanning that produces this manifest costs orders of
magnitude more). CBOR *decode* is actually the slowest of all four.

### 4 MiB blob

| encoding | bytes | encode µs/op | decode µs/op | enc MB/s | dec MB/s |
| --- | --- | --- | --- | --- | --- |
| **raw chunk frames (the design)** | 4,194,624 | 632 | 895 | 6639 | 4685 |
| base64 in JSON (anti-pattern) | 5,592,419 | 7,962 | 10,667 | 527 | 393 |
| CBOR native bytes | 4,194,315 | 451 | 1,047 | 9292 | 4007 |
| MessagePack native bytes | 4,194,315 | 452 | 448 | 9270 | 9371 |
| Protobuf bytes field | 4,194,309 | 458 | 956 | 9162 | 4387 |

Raw chunk frames are within ~1.3× of the best embedded-binary encoding while
keeping blobs bounded, streamable, and outside the envelope codec entirely —
an embedded `bytes` field requires decoding (and bounding) the whole message
as one frame, which conflicts with requirement 8. Base64-in-JSON is 10–20×
worse and 33% larger; the chunk-frame design, not the codec, is the decision
that matters.

### The JS peer (desktop client, V8 — node v24.16.0, `node ts/jsonPeerBench.mts`)

| operation | µs/op | MB/s |
| --- | --- | --- |
| JSON.stringify small envelope | 0.21 | 607 |
| JSON.parse small envelope | 0.34 | 373 |
| JSON.stringify 10k manifest | 2,224 | 760 |
| JSON.parse 10k manifest | 2,032 | 832 |

V8's native `JSON.parse` decodes the manifest at 832 MB/s — faster than
Rust-side ciborium decodes CBOR. A binary envelope codec would move the JS
peer from a V8-native parser to a userland decoder library *plus* still
require a validation pass; JSON gives the desktop client its fastest path
for free.

### Codegen quality (qualitative, artifacts committed)

- **ts-rs** (`generated/ts/*.ts`): discriminated union
  `type Envelope = { type: "hello" } & Hello | …` with doc comments carried
  over from Rust — idiomatic, review-friendly TS. One footgun found and
  fixed: ts-rs maps `u64` to `bigint`, which is wrong for values arriving
  via `JSON.parse`; the protocol bounds all wire integers to
  `Number.MAX_SAFE_INTEGER` (2^53−1, enforced in `validate()` at
  limit±1-tested precision) and overrides the emitted type to `number`.
- **schemars** (`generated/engine-protocol.schema.json`): draft 2020-12,
  `oneOf` discriminated by `type` const, `$defs` per struct — directly
  consumable by ajv. The spike ships a dependency-free subset validator
  (`ts/schemaValidator.mts`) with non-vacuousness tests (corrupted envelopes
  must fail).
- **prost** (bench-only): hand-derived messages are representative of
  prost-build output; fine as codecs, poor as domain types (everything
  `Option`/defaulted, no exhaustive enums).

## The v1 wire design (as implemented in `crates/dohc-engine-protocol`)

### Frame layer (codec-agnostic)

```text
[0..4)  magic  b"DOP1"
[4]     type   1 = Control, 2 = BlobChunk
[5]     flags  Control: 0. BlobChunk: bit0 = FIN.
[6..8)  reserved (0)
[8..12) payload length, u32 LE
payload: Control → encoded envelope (JSON in v1)
         BlobChunk → stream_id u64 LE + raw bytes
```

Header-only bound checks (an adversarial length never allocates), typed
`FrameDecodeError` for every malformed shape, decoder poisons on first error
(no resync points → tear down the connection). Fuzz-smoke tests cover random
garbage, every truncation point, and header mutations; this decoder is the
future cargo-fuzz target (cutover-blocking family: IPC framing).

### Envelope layer

Tagged union (`type` field): `hello`, `helloAck`, `request`, `response`,
`error`, `event`, `cancel`, `blobStart`, `batch` (bounded, non-nesting).
Unknown *fields* are ignored (append-only evolution); unknown *envelope
types or enum values* are rejected — new message kinds and codes must gate
on a negotiated capability.

Key decisions baked in:

- **All wire integers ≤ 2^53−1** (`MAX_WIRE_INTEGER`), validated on both
  sides, so TS uses plain `number`. 64-bit identifiers that need more range
  must be strings (like `WorkspaceHandle`).
- **Bounds are session state**: `helloAck.limits` advertises the engine's
  `WireLimits`; both encoder and decoder enforce them; every bound has
  limit−1/limit/limit+1 tests.
- **Canonical encoding** for fixtures/traces: sorted-key compact JSON,
  byte-identical from Rust (`serde_json::Value`'s BTreeMap ordering) and TS
  (`canonicalJson()` in `ts/schemaValidator.mts`). ASCII keys only in
  protocol-defined fields keeps the two sort orders identical.
- **Error taxonomy**: 13 stable codes with default retryability;
  `OVERLOADED → afterBackoff`, `SESSION_EXPIRED → afterReconnect`,
  `DEADLINE_EXCEEDED → afterBackoff` (safe only because retryable mutations
  carry idempotency keys).

### Supervisor skeleton (replaces thread-per-request)

`supervisor::Supervisor` (feature `supervisor`, tokio): bounded mpsc queue →
semaphore-bounded in-flight spawn, per-request `CancelSignal` (a std-only
waker primitive, so core crates stay tokio-free per portability guardrail 2),
deadline clamped to a configured max and enforced by `select!` even against
uncooperative handlers, typed `OVERLOADED` on a full queue, duplicate
in-flight ids rejected. Tested: peak-concurrency bound, overload
backpressure + drain, cooperative cancel of in-flight requests, deadline
expiry, deadline clamping (deterministic paused-time tests).

### Transports

`EngineService` / `EngineTransport` traits take the typed structs;
`InProcessTransport` forwards them directly (no serde in the path — the
embedded-host requirement), and the framed IPC host implements the same
trait over frames. Serialization is a transport property, not a protocol
property.

## How the desktop client consumes this later

R03's SHARDS.tsv row reserves `packages/workspace-engine-client/**`. At
protocol freeze the integrator owns a single `regenerate-bindings` command
that runs, from the crate:

1. `TS_RS_EXPORT_DIR=generated/ts cargo test --features bindings export_bindings`
2. `cargo run --example generate_bindings --features bindings`
3. `cargo run --example update_fixtures`

and copies `generated/` + `fixtures/` into the client package, which wraps
them with: an ajv validator compiled from the schema, the framed-transport
client (request correlation, event sequence tracking, reconnect + handle
invalidation), and the retry policy driven by `Retryability`. Generated
files are never hand-edited (CI-checked, integrator-owned). The R11b Y.Doc
live adapter and R13b desktop adapter build on that package. Until then the
generated output lives only inside the crate — nothing under `packages/` or
`apps/` changes (this shard touched neither).

## What remains for the real protocol freeze (post-approval, pre-Gate-1)

1. **Per-method schemas.** `request.params` / `response.result` /
   `event.payload` are bounded-but-untyped JSON in the spike. The freeze
   must generate method-level types the same way (serde structs per method,
   ts-rs + schemars), or requirement 2 is only shallowly satisfied — this is
   the largest remaining piece.
2. **Event-direction flow control.** Client→engine backpressure is solved
   (bounded queue + `OVERLOADED`); engine→client event flow control is not:
   a slow client must translate into a bounded engine-side event buffer with
   a defined overflow behavior (coalesce + `seq` gap forcing resync is the
   likely shape, mirroring the watcher-overflow rule). Design work, not
   codec work — no candidate helps.
3. **Blob stream lifecycle**: chunk-credit or windowing for multi-stream
   fairness, cancellation of in-flight streams, and hash-mismatch semantics.
4. **Capability + method + event name registries** (append-only tables in
   this doc's successor), and the versioning policy for each.
5. **Handshake hardening**: pre-`hello` timeout, exactly-one-`hello` state
   machine, max connections.
6. **ajv integration** in the client package (replacing the spike's subset
   validator) plus a `tsc --noEmit` typecheck gate over generated bindings —
   the spike validates at runtime from node but does not yet typecheck in
   CI (needs the client package's toolchain).
7. **cargo-fuzz target** wired around `FrameDecoder`/`decode_control`
   (cutover-blocking), seeded from the fuzz-smoke corpus.
8. **Final limit values** (spike defaults are placeholders) and the
   `testkit.fault.*` catalog with R01-ORACLE.

## Requirements with no clean single-candidate answer (flagged, not papered over)

- **Runtime validation both sides** is inherently *two* validator
  implementations that can drift, whatever the codec. Mitigation is
  structural: both are generated from one Rust source, and the shared
  fixtures + non-vacuousness (mutation) tests catch drift — but until
  per-method schemas land (freeze item 1), payload validation is
  bounds-only. This is a scheduling risk, not a codec gap.
- **Backpressure** (requirement 10) is only half-specified by any wire
  format: the overload *error* is trivial; the event-direction flow-control
  *policy* (freeze item 2) is a real design decision that needs its own
  review at freeze time.

Both are called out for Gate-0 review rather than silently narrowed.
