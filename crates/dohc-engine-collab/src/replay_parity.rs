//! Structural Yjs-v1 replay-parity gate.
//!
//! yrs stores Rust `String`s but addresses text in Yjs-compatible UTF-16 clock
//! units. Its UTF-16 splitter rounds an index inside an astral scalar to the
//! scalar's UTF-8 boundary; Yjs instead exposes the two surrogate units. A
//! candidate whose insertion/deletion boundary names that interior clock can
//! therefore replay to different content despite being a valid update. Beyond
//! that boundary class, a HOSTILE peer can re-encode a `(client, clock)` pair
//! the base (or a still-parked update) already owns with DIFFERENT content:
//! yrs keeps its own first-seen item for that id and silently ignores the
//! redefinition, while a from-scratch Yjs peer integrating the same lineage
//! can resolve the conflicting redefinition differently — a divergence with
//! no clock shortfall and no interior-scalar boundary named on the wire.
//!
//! The public `Update` API does not expose item origins in yrs 0.27.3, so this
//! gate walks the v1 wire with yrs' own public `DecoderV1` primitives. It:
//!  - rejects any structural block of length zero (a degenerate wire claim; no
//!    honest edit ever encodes one, and it is the wire-visible precondition of
//!    at least one internal yrs unwind this gate must never trigger);
//!  - compares the candidate's string content against whatever the base (or a
//!    still-parked update) already claims at the SAME clocks — a content-parity
//!    check that catches a hostile re-encode BEFORE any doc is touched;
//!  - checks candidate delete endpoints, AND any still-parked delete endpoints
//!    (whose target scalar may only just now be forming from THIS candidate's
//!    content), against the base ∪ candidate ∪ pending scalar structure —
//!    computed BEFORE any delete removes it, since a post-delete scan no
//!    longer contains the scalar;
//!  - checks every candidate insertion boundary, AND any still-parked
//!    insertion boundary, against that same pre-delete scalar structure — so a
//!    parked insert is caught at the moment its dependency integrates;
//!  - requires dependency-complete replay to either integrate or park every
//!    clock the candidate claims (a clock covered by neither is wire data yrs
//!    silently discarded).
//!
//! All of the above is computed by scanning the base/candidate/pending WIRE
//! BYTES directly — never by asking yrs to diff a state vector captured on one
//! `Doc` against a different `Doc` instance, which is what `store.rs`'s
//! `write_blocks_from` can panic on (a state-vector clock that does not align
//! with the diffed doc's own block layout). The gate still applies
//! base+pending+candidate to an isolated scratch doc (needed because only a
//! real integration can tell whether a claimed clock was silently discarded,
//! e.g. an overlap-slice), but it only ever reads that scratch doc's state
//! vector and pending-update bytes — both O(pending), never a full diff.
//!
//! The live/durable document is never mutated. Because this runs inside
//! `store.write_with`, the whole computation is wrapped in `catch_unwind` so any
//! internal library unwind that the checks above did not already prevent
//! becomes a fail-closed rejection instead of poisoning the caller's
//! transaction (mirrors the hash worker's containment) — a backstop, not the
//! primary mechanism.
//!
//! ## Abort safety (the pre-validator)
//!
//! `catch_unwind` is a backstop, not a cure: yrs 0.27.3's `Update::decode_v1`
//! can HARD-ABORT the whole process (uncatchable UB — see
//! [`safe_read_string`]'s doc comment for the root cause), which no unwind
//! boundary can contain. [`scan_v1`] — the wire walk this module already
//! performs for replay parity — doubles as the pre-validator that closes this:
//! it never calls `decode_v1` and never uses yrs' own unsafe string decode, so
//! it can safely reject a malformed/adversarial update BEFORE any decode that
//! could abort ever sees the bytes. [`prevalidate_update_bytes`] is the public
//! entry point [`crate::durable::validate_update_bytes`] calls FIRST — the
//! shared choke point for both the local edit path and the remote replication
//! path (`crates/dohc-engine-collab/src/durable.rs`,
//! `crates/dohc-engine-collab/src/replication.rs`) — and this module's own
//! `validate_replay_parity_inner` runs it before its own `Ydoc::validate_update`
//! call for the same reason.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use yrs::block::{
    BLOCK_GC_REF_NUMBER, BLOCK_ITEM_ANY_REF_NUMBER, BLOCK_ITEM_BINARY_REF_NUMBER,
    BLOCK_ITEM_DELETED_REF_NUMBER, BLOCK_ITEM_DOC_REF_NUMBER, BLOCK_ITEM_EMBED_REF_NUMBER,
    BLOCK_ITEM_FORMAT_REF_NUMBER, BLOCK_ITEM_JSON_REF_NUMBER, BLOCK_ITEM_STRING_REF_NUMBER,
    BLOCK_ITEM_TYPE_REF_NUMBER, BLOCK_SKIP_REF_NUMBER, HAS_ORIGIN, HAS_PARENT_SUB,
    HAS_RIGHT_ORIGIN, ID,
};
use yrs::encoding::read::Read;
use yrs::types::{
    TYPE_REFS_ARRAY, TYPE_REFS_DOC, TYPE_REFS_MAP, TYPE_REFS_TEXT, TYPE_REFS_UNDEFINED,
    TYPE_REFS_XML_ELEMENT, TYPE_REFS_XML_FRAGMENT, TYPE_REFS_XML_HOOK, TYPE_REFS_XML_TEXT,
};
use yrs::updates::decoder::{Decoder, DecoderV1};
use yrs::{Any, ClientID};

use crate::{CollabError, Ydoc};

/// The structural identity of one clock's content, for the content-parity
/// check. Two wires that both hold LIVE (rendering) content at the same
/// `(client, clock)` must present the identical identity; a hostile re-encode
/// that changes the KIND or the PAYLOAD at an already-known clock is rejected.
/// No honest peer ever redefines a clock it (or its dependency) has already
/// used, so a mismatch can only be hostile/corrupt input.
#[derive(Clone, PartialEq, Eq)]
enum ClockIdentity {
    /// A single UTF-16 code unit of a live `String` content block — the
    /// original surrogate/FFFD-adjacent risk class, kept as the string case of
    /// the general check.
    StringUnit(u16),
    /// A live non-string content item, by structural kind tag (the content-ref
    /// number) plus a canonical, order-independent payload fingerprint (hex
    /// sha-256). A different kind never compares equal (the tag differs); a
    /// same-kind different-payload item never compares equal (the fingerprint
    /// differs). Covers JSON, binary, embed, format, type, doc, and any.
    Typed { kind: u8, payload: String },
    /// A `ContentDeleted` tombstone item — renders nothing. NOT a live
    /// identity: a clock that is a tombstone on the ESTABLISHED side "renders
    /// neither way," so a resend that references it must not be false-rejected
    /// (the reviewer's compacted/GC'd-tombstone note).
    Tombstone,
}

impl ClockIdentity {
    /// Whether this identity is live, rendering content (not a tombstone).
    fn is_live(&self) -> bool {
        !matches!(self, ClockIdentity::Tombstone)
    }
}

#[derive(Default)]
struct WireStructure {
    unsafe_boundaries: BTreeSet<ID>,
    insertion_boundaries: Vec<ID>,
    deletion_boundaries: Vec<ID>,
    claimed_clocks: BTreeMap<ClientID, u32>,
    /// The structural identity every content block in this wire claims, by
    /// `(client, clock)`. Covers ALL content kinds (string, JSON, binary,
    /// embed, format, type, doc, any) plus `ContentDeleted` tombstones — the
    /// content-parity check compares these across wires at overlapping clocks
    /// so a candidate cannot redefine an already-known clock's kind or payload.
    identities: BTreeMap<ClientID, BTreeMap<u32, ClockIdentity>>,
    /// The wire's own delete-set as `(client, [start, end))` half-open clock
    /// ranges. A `ContentDeleted` item whose clock IS in this set is a
    /// legitimate delete/GC (the deletion the peer performed); a bare
    /// `ContentDeleted` NOT covered here is a hostile redefinition.
    deleted_ranges: BTreeMap<ClientID, Vec<(u32, u32)>>,
}

impl WireStructure {
    /// Whether this wire's own delete-set covers `(client, clock)` — i.e. the
    /// wire genuinely deletes that clock (a real delete/GC), as opposed to
    /// merely re-encoding it.
    fn delete_set_covers(&self, client: ClientID, clock: u32) -> bool {
        self.deleted_ranges.get(&client).is_some_and(|ranges| {
            ranges
                .iter()
                .any(|&(start, end)| start <= clock && clock < end)
        })
    }
}

#[cfg(test)]
thread_local! {
    /// Test-only seam: forces the gate's wrapped computation to unwind so the
    /// `catch_unwind` fail-closed containment can be exercised deterministically.
    static PANIC_INJECT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Reject a valid v1 update whose structural edit boundaries cannot replay
/// identically between Yjs' UTF-16 strings and yrs' Rust strings, or whose
/// content redefines a clock the base/pending lineage already claims.
///
/// The whole computation is contained by `catch_unwind`: yrs can unwind on some
/// malformed inputs, and this gate runs inside `store.write_with`, so an escaping
/// unwind would poison the caller's transaction/mutex and take the workspace
/// actor down. A contained unwind is mapped to a fail-closed rejection. The
/// scratch doc is local and dropped on unwind; `base`/`candidate` are read-only
/// and the durable store is untouched here, so returning `Err` rolls the caller's
/// transaction back cleanly.
pub fn validate_replay_parity(base: &Ydoc, candidate: &[u8]) -> Result<(), CollabError> {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        validate_replay_parity_inner(base, candidate)
    }));
    match outcome {
        Ok(result) => result,
        Err(_) => Err(CollabError::ReplayParityViolation {
            reason: "replay validation failed to complete; rejected fail-closed".to_owned(),
        }),
    }
}

fn validate_replay_parity_inner(base: &Ydoc, candidate: &[u8]) -> Result<(), CollabError> {
    #[cfg(test)]
    if PANIC_INJECT.with(std::cell::Cell::get) {
        panic!("injected replay-gate unwind for fail-closed test");
    }
    // `scan_v1` MUST run before anything that can reach yrs' own uncatchable
    // `Update::decode_v1` hard-abort (`Ydoc::validate_update` below, and the
    // scratch-doc `apply`s further down) — it never calls `decode_v1` and
    // never uses yrs' unsafe string decode (see `safe_read_string`'s doc
    // comment), so malformed/adversarial `candidate` bytes are rejected here,
    // fail-closed, before anything unsafe ever sees them.
    let candidate_structure = scan_v1(candidate)?;
    Ydoc::validate_update(candidate)?;
    let base_full = base.encode_full_state();
    let base_structure = scan_v1(&base_full)?;
    let pending_bytes = base.pending_update_v1();
    let pending_structure = match &pending_bytes {
        Some(bytes) => scan_v1(bytes)?,
        None => WireStructure::default(),
    };

    // (1) Content parity (ALL content kinds, not just strings): a candidate
    // that re-encodes a clock the base or a still-parked update already holds
    // as LIVE content MUST present the identical structural identity — same
    // KIND and same canonical PAYLOAD — UNLESS it is genuinely deleting that
    // clock. yrs dedups a re-encoded id by silently keeping its first-seen
    // item; a from-scratch Yjs peer replaying the same lineage can resolve a
    // conflicting LIVE redefinition differently, whether it changes a string's
    // units OR swaps the content kind entirely (string -> JSON / binary /
    // embed / format / type). A candidate that instead tombstones a base-live
    // clock (`ContentDeleted`) is a legitimate delete/GC when it carries that
    // clock in its OWN delete-set — the normal reconnect/resync full-state
    // resend does exactly this — and only a BARE `ContentDeleted` (not in the
    // candidate's delete-set) is a hostile redefinition. No honest peer ever
    // redefines a `(client, clock)` it has already used as LIVE content, so
    // this can only reject a hostile/corrupt input.
    if content_parity_conflict(&candidate_structure, &base_structure.identities)
        || content_parity_conflict(&candidate_structure, &pending_structure.identities)
    {
        return Err(CollabError::ReplayParityViolation {
            reason: "a candidate re-encodes an already-known clock with different content"
                .to_owned(),
        });
    }

    // Every scalar interior clock any of the three wires (base, candidate,
    // pending) currently claims, computed BEFORE any delete removes it —
    // deleting a unit drops the whole scalar from a post-delete scan, so this
    // union must be taken from each wire's own isolated content, not from the
    // integrated (and possibly already-deleted) result.
    let mut pre_delete_unsafe = base_structure.unsafe_boundaries.clone();
    pre_delete_unsafe.extend(candidate_structure.unsafe_boundaries.iter().copied());
    pre_delete_unsafe.extend(pending_structure.unsafe_boundaries.iter().copied());

    // (2) DELETE boundaries: the candidate's own claims, base's FULL current
    // delete-set (Yjs/yrs always (re-)encode the whole delete-set on a
    // full-state/diff write, including a "dangling" entry whose target item
    // is not yet known — yrs tracks that as a pending delete set, NOT as a
    // pending update, so it is invisible to `pending_update_v1()`; it only
    // surfaces by re-scanning `base`'s own current delete-set), AND any
    // still-parked delete claims bundled with a not-yet-integrated insert. A
    // dangling delete's target may only now be forming a multi-unit scalar
    // because THIS candidate delivers the dependency that completes it,
    // which was invisible when the delete was first accepted in isolation.
    if base_structure
        .deletion_boundaries
        .iter()
        .chain(candidate_structure.deletion_boundaries.iter())
        .chain(pending_structure.deletion_boundaries.iter())
        .any(|boundary| pre_delete_unsafe.contains(boundary))
    {
        return Err(CollabError::ReplayParityViolation {
            reason: "a delete endpoint lands inside a multi-unit Unicode scalar".to_owned(),
        });
    }

    // (3) INSERT boundaries: symmetric to (2) — the candidate's own claims,
    // AND any still-parked insertion claims, against the same pre-delete
    // union. Catches an immediately-integrated insert AND a previously-parked
    // insert at the moment its dependency integrates.
    if candidate_structure
        .insertion_boundaries
        .iter()
        .chain(pending_structure.insertion_boundaries.iter())
        .any(|boundary| pre_delete_unsafe.contains(boundary))
    {
        return Err(CollabError::ReplayParityViolation {
            reason: "an insert boundary lands inside a multi-unit Unicode scalar".to_owned(),
        });
    }

    // (4) Union-coverage (discard) check: apply base + pending + candidate to
    // an isolated scratch doc — only a real integration can tell whether a
    // claimed clock was silently discarded (e.g. an overlap-slice). Every
    // clock the candidate claims must come out integrated OR parked pending;
    // a clock covered by neither is wire data yrs silently discarded. This
    // reads only the scratch doc's state vector and re-encoded pending bytes
    // (both O(pending), never a full diff against a foreign state vector).
    let scratch = Ydoc::wire();
    scratch.apply(&base_full)?;
    if let Some(pending) = &pending_bytes {
        scratch.apply(pending)?;
    }
    scratch.apply(candidate)?;

    let pending_ends = match scratch.pending_update_v1() {
        Some(bytes) => scan_v1(&bytes)?.claimed_clocks,
        None => BTreeMap::new(),
    };
    let scratch_sv = scratch.state_vector();
    for (client, claimed_end) in candidate_structure.claimed_clocks {
        let integrated = scratch_sv.get(&client);
        let pending = pending_ends.get(&client).copied().unwrap_or(0);
        if integrated < claimed_end && pending < claimed_end {
            return Err(CollabError::ReplayParityViolation {
                reason: "a candidate clock was neither integrated nor parked \
                         (yrs discarded wire data)"
                    .to_owned(),
            });
        }
    }
    Ok(())
}

/// True when `candidate` redefines a clock the ESTABLISHED side (`base` or a
/// still-parked update) already holds as LIVE content, in a way that would
/// diverge yjs<->yrs. Asymmetric on purpose: only a clock that is LIVE on the
/// established side is compared. A clock the established side holds as a
/// tombstone (`ContentDeleted`) "renders neither way," so a resend that
/// references or re-encodes it is never false-rejected; a clock the established
/// side never claims is new and untouched here.
///
/// At a base-live clock the candidate also claims, three cases:
///   - the candidate presents the IDENTICAL identity — a clean resend, fine;
///   - the candidate tombstones the clock (`ContentDeleted`) AND covers it in
///     its OWN delete-set — a legitimate delete/GC (the normal reconnect
///     full-state resend carries a deleted clock this way), fine;
///   - otherwise the candidate presents a DIFFERENT LIVE identity (string
///     units or a different kind/payload) OR a BARE `ContentDeleted` not in
///     its delete-set — a hostile redefinition, rejected. No honest peer ever
///     redefines an already-used clock's live content without deleting it.
fn content_parity_conflict(
    candidate: &WireStructure,
    established: &BTreeMap<ClientID, BTreeMap<u32, ClockIdentity>>,
) -> bool {
    for (client, known) in established {
        let Some(claimed) = candidate.identities.get(client) else {
            continue;
        };
        for (clock, established_identity) in known {
            if !established_identity.is_live() {
                continue; // tombstone on the established side: renders neither way
            }
            let Some(candidate_identity) = claimed.get(clock) else {
                continue;
            };
            if candidate_identity == established_identity {
                continue; // identical live content: a clean resend
            }
            if matches!(candidate_identity, ClockIdentity::Tombstone)
                && candidate.delete_set_covers(*client, *clock)
            {
                continue; // a genuine delete/GC of this clock, not a redefinition
            }
            return true;
        }
    }
    false
}

/// A canonical, order-independent fingerprint of a JSON-ish `Any` value: the
/// sorted-key serde projection (`any_to_json` sorts every nested map via
/// `BTreeMap` — constraint 2) serialized and hashed. Two encodings of the same
/// logical value fingerprint identically even if yrs re-encoded a map's keys in
/// a different order, so a legitimate full-state resend is never false-flagged.
fn any_payload(value: &Any) -> String {
    let canonical = serde_json::to_vec(&crate::ydoc::any_to_json(value)).unwrap_or_default();
    crate::hex_sha256(&canonical)
}

fn record_identity(
    structure: &mut WireStructure,
    client: ClientID,
    clock: u32,
    identity: ClockIdentity,
) {
    structure
        .identities
        .entry(client)
        .or_default()
        .insert(clock, identity);
}

/// The pre-validator [`crate::durable::validate_update_bytes`] (the shared
/// choke point for BOTH the local edit path — `record_local_update` /
/// `record_local_update_creating_marker` — and the remote replication path —
/// `apply_remote_update` / `apply_remote_update_in_transaction`) runs BEFORE
/// any call that can reach yrs 0.27.3's uncatchable `Update::decode_v1`
/// hard-abort. See [`safe_read_string`]'s doc comment for the root cause and
/// why `scan_v1`'s manual wire walk is safe to run on fully untrusted bytes.
pub(crate) fn prevalidate_update_bytes(bytes: &[u8]) -> Result<(), CollabError> {
    scan_v1(bytes).map(|_| ())
}

/// yrs 0.27.3's `Read::read_string` (the default impl `DecoderV1` uses, and
/// therefore every string-bearing v1 decode — `Any::decode`'s String/Map-key
/// cases, `Decoder::read_key`, `Decoder::read_json`, `TypeRef::decode`'s XML
/// element tag, `Options::decode`'s guid) casts the raw length-prefixed bytes
/// straight to `&str` via `std::str::from_utf8_unchecked`, WITHOUT checking
/// they are valid UTF-8:
///
/// ```ignore
/// fn read_string(&mut self) -> Result<&str, Error> {
///     let buf = self.read_buf()?;
///     Ok(unsafe { std::str::from_utf8_unchecked(buf) })
/// }
/// ```
///
/// Malformed bytes therefore produce a `&str` that violates Rust's UTF-8
/// invariant. The moment anything iterates `.chars()` over that fake `str`
/// (yrs's own integration code inside `Update::decode_v1`, or this module's
/// own structural walk if it naively reused yrs's decode helpers), the char
/// decoder can synthesize an out-of-range/surrogate `u32` and hand it to an
/// unchecked `char` construction — a debug-mode precondition check catches it
/// as an UNCATCHABLE process abort (`std::panic::catch_unwind` cannot
/// intercept it); in a release build the check compiles out and the same
/// input is silent undefined behavior instead. This is the root cause of the
/// `known_crash_witness_yrs_char_decode_ub` hard-abort.
///
/// Every string-bearing field this module reads therefore goes through this
/// function instead of yrs's own `read_string`/`read_key`/`read_json`/
/// `read_any`/`TypeRef::decode`/`Options::decode`. It reads the raw bytes
/// with the ordinary bounds-checked `read_buf` (safe: yrs' `Read` trait only
/// makes the STRING CAST unsafe, not the length-prefixed byte read) and
/// validates them with the CHECKED `std::str::from_utf8`, rejecting anything
/// that is not well-formed UTF-8 — which by construction can never encode a
/// surrogate (0xD800..=0xDFFF) or an out-of-range scalar (> 0x10FFFF) — BEFORE
/// it is ever treated as a `str`. Once bytes have passed through here, no
/// later `.chars()` iteration over them (by this module, or by yrs's own real
/// `Update::decode_v1` once the pre-validator has accepted the update) can
/// hit the UB, because they are now provably valid UTF-8.
fn safe_read_string<'b>(decoder: &'b mut DecoderV1<'_>) -> Result<&'b str, CollabError> {
    let raw = decoder.read_buf().map_err(parity_decode_error)?;
    std::str::from_utf8(raw).map_err(|_| CollabError::ReplayParityViolation {
        reason: "the update contains a string field with invalid UTF-8 bytes".to_owned(),
    })
}

/// [`safe_read_string`] plus JSON parsing, replacing `Decoder::read_json`
/// (which bottoms out in the unsafe `read_string`). `Any::from_json` itself
/// (a `serde_json` parse) is safe once handed a genuine, validated `&str`.
fn safe_read_json(decoder: &mut DecoderV1<'_>) -> Result<Any, CollabError> {
    let src = safe_read_string(decoder)?;
    Any::from_json(src).map_err(|error| CollabError::ReplayParityViolation {
        reason: format!("the update contains malformed embedded JSON: {error}"),
    })
}

/// A from-scratch, SAFE reimplementation of yrs' `Any::decode` for
/// `DecoderV1`. Cannot reuse `decoder.read_any()` / `Any::decode` directly:
/// both bottom out in yrs' unsafe `Read::read_string` for the String and
/// Map-key cases (see [`safe_read_string`]). Every primitive used here
/// (`read_u8`, `read_var`, `read_f32`/`read_f64`/`read_i64`, `read_buf`) is
/// bounds-checked with no unsafe casts, so this can never reach the UB
/// regardless of input. Collections grow incrementally rather than
/// pre-allocating an attacker-controlled `len` (bounded-everything: a huge
/// claimed length fails fast on the next out-of-bounds read instead of
/// driving a large up-front allocation).
fn safe_read_any(decoder: &mut DecoderV1<'_>) -> Result<Any, CollabError> {
    let tag = decoder.read_u8().map_err(parity_decode_error)?;
    Ok(match tag {
        127 => Any::Undefined,
        126 => Any::Null,
        125 => Any::Number(decoder.read_var::<i64>().map_err(parity_decode_error)? as f64),
        124 => Any::Number(decoder.read_f32().map_err(parity_decode_error)? as f64),
        123 => Any::Number(decoder.read_f64().map_err(parity_decode_error)?),
        122 => Any::BigInt(decoder.read_i64().map_err(parity_decode_error)?),
        121 => Any::Bool(false),
        120 => Any::Bool(true),
        119 => Any::String(Arc::from(safe_read_string(decoder)?)),
        118 => {
            let len: usize = decoder.read_var().map_err(parity_decode_error)?;
            let mut map = HashMap::new();
            for _ in 0..len {
                let key = safe_read_string(decoder)?.to_owned();
                let value = safe_read_any(decoder)?;
                map.insert(key, value);
            }
            Any::Map(Arc::new(map))
        }
        117 => {
            let len: usize = decoder.read_var().map_err(parity_decode_error)?;
            let mut arr = Vec::new();
            for _ in 0..len {
                arr.push(safe_read_any(decoder)?);
            }
            Any::Array(Arc::from(arr))
        }
        116 => Any::Buffer(Arc::from(decoder.read_buf().map_err(parity_decode_error)?)),
        _ => {
            return Err(CollabError::ReplayParityViolation {
                reason: "the update contains an unsupported Any value tag".to_owned(),
            })
        }
    })
}

/// A SAFE reimplementation of `TypeRef::decode`'s wire shape, sufficient for a
/// content-identity fingerprint (this module only ever needs KIND identity
/// for the content-parity check, never the constructed `TypeRef` value
/// itself). Reimplemented rather than calling `TypeRef::decode` because its
/// `TYPE_REFS_XML_ELEMENT` arm reads a tag name via `decoder.read_key()`,
/// which bottoms out in yrs' unsafe `read_string` (see [`safe_read_string`]).
fn safe_read_type_ref_fingerprint(decoder: &mut DecoderV1<'_>) -> Result<Vec<u8>, CollabError> {
    let type_ref = decoder.read_type_ref().map_err(parity_decode_error)?;
    let mut canonical = vec![type_ref];
    match type_ref {
        TYPE_REFS_XML_ELEMENT => {
            canonical.extend_from_slice(safe_read_string(decoder)?.as_bytes());
        }
        TYPE_REFS_ARRAY
        | TYPE_REFS_MAP
        | TYPE_REFS_TEXT
        | TYPE_REFS_XML_FRAGMENT
        | TYPE_REFS_XML_HOOK
        | TYPE_REFS_XML_TEXT
        | TYPE_REFS_DOC
        | TYPE_REFS_UNDEFINED => {}
        _ => {
            return Err(CollabError::ReplayParityViolation {
                reason: "the update contains an unsupported type reference".to_owned(),
            })
        }
    }
    Ok(canonical)
}

/// A SAFE reimplementation of `Options::decode`'s wire shape (a guid string
/// plus an `Any` map of sub-document options), sufficient for a
/// content-identity fingerprint. Reimplemented rather than calling
/// `Options::decode` because it reads the guid via yrs' unsafe `read_string`
/// (see [`safe_read_string`]).
fn safe_read_options_fingerprint(decoder: &mut DecoderV1<'_>) -> Result<Vec<u8>, CollabError> {
    let guid = safe_read_string(decoder)?;
    let mut canonical = guid.as_bytes().to_vec();
    canonical.push(0);
    let opts = safe_read_any(decoder)?;
    canonical.extend_from_slice(
        serde_json::to_vec(&crate::ydoc::any_to_json(&opts))
            .unwrap_or_default()
            .as_slice(),
    );
    Ok(canonical)
}

/// yjs client identifiers are JavaScript numbers, so they must fit in 53 bits
/// — an invariant yrs' `ClientID::new` only `debug_assert!`s: an unwinding
/// panic in debug builds, and in RELEASE builds the check compiles out and the
/// high bits are silently masked off, so a hostile wire client id of
/// `2^53 + n` would alias honest client `n` and let a forged update claim
/// another peer's blocks. No honest yjs/yrs encoder can produce one (JS
/// numbers cannot represent it), so reject it here, before any `ClientID` is
/// ever constructed from the wire value. Replaces `Decoder::read_client`,
/// which performs no range check.
fn safe_read_client(decoder: &mut DecoderV1<'_>) -> Result<ClientID, CollabError> {
    const CLIENT_53_BIT_OVERFLOW: u64 = u64::MAX << 53;
    let raw: u64 = decoder.read_var().map_err(parity_decode_error)?;
    if raw & CLIENT_53_BIT_OVERFLOW != 0 {
        return Err(CollabError::ReplayParityViolation {
            reason: "the update contains a client identifier outside the 53-bit yjs range"
                .to_owned(),
        });
    }
    Ok(ClientID::new(raw))
}

/// [`safe_read_client`] plus a clock — replaces `Decoder::read_left_id` /
/// `read_right_id`, which construct `ClientID` from the raw wire value with
/// no range check (see [`safe_read_client`]).
fn safe_read_id(decoder: &mut DecoderV1<'_>) -> Result<ID, CollabError> {
    let client = safe_read_client(decoder)?;
    let clock: u32 = decoder.read_var().map_err(parity_decode_error)?;
    Ok(ID::new(client, clock))
}

/// Walk the v1 wire structure with yrs' own public `DecoderV1` PRIMITIVES —
/// never yrs' own `Update::decode_v1`, and never yrs' own unsafe string decode
/// (every string-bearing field goes through [`safe_read_string`] and its
/// derivatives above) — so this function is safe to run on fully untrusted,
/// adversarial bytes. This IS the pre-validator: [`prevalidate_update_bytes`]
/// is a thin public wrapper around it, and every caller in this module that
/// used to call `Update::decode_v1`/`Ydoc::validate_update` on untrusted bytes
/// now calls this (or the wrapper) FIRST.
fn scan_v1(bytes: &[u8]) -> Result<WireStructure, CollabError> {
    let mut decoder = DecoderV1::from(bytes);
    let mut structure = WireStructure::default();
    let clients_len: u32 = decoder.read_var().map_err(parity_decode_error)?;
    for _ in 0..clients_len {
        let blocks_len: u32 = decoder.read_var().map_err(parity_decode_error)?;
        let client = safe_read_client(&mut decoder)?;
        let mut clock: u32 = decoder.read_var().map_err(parity_decode_error)?;
        for _ in 0..blocks_len {
            let info = decoder.read_info().map_err(parity_decode_error)?;
            let len = match info {
                BLOCK_SKIP_REF_NUMBER => decoder.read_var().map_err(parity_decode_error)?,
                BLOCK_GC_REF_NUMBER => decoder.read_len().map_err(parity_decode_error)?,
                item_info => scan_item(
                    &mut decoder,
                    item_info,
                    ID::new(client, clock),
                    &mut structure,
                )?,
            };
            // A zero-length structural block is a degenerate wire claim no
            // honest encoder ever produces, and is the wire-visible
            // precondition of at least one internal yrs unwind (a
            // zero-length item slice) — reject it here, before this update
            // ever reaches an `apply`.
            if len == 0 {
                return Err(CollabError::ReplayParityViolation {
                    reason: "the update contains a zero-length structural block".to_owned(),
                });
            }
            clock = clock.checked_add(len).ok_or_else(parity_clock_overflow)?;
        }
        structure
            .claimed_clocks
            .entry(client)
            .and_modify(|claimed| *claimed = (*claimed).max(clock))
            .or_insert(clock);
    }
    // The delete-set. Replaces `IdSet::decode`, which constructs `ClientID`
    // from the raw wire value with no range check (see [`safe_read_client`])
    // and computes each range's `clock + len` UNCHECKED (an overflow panic in
    // debug builds, a silent wrap in release). yrs' decode also silently keeps
    // only the LAST section when a client appears twice — a duplicate section
    // is a wire claim no honest encoder produces, and mirroring that discard
    // here would let a hostile update smuggle delete claims this scan sees but
    // yrs drops (or vice versa), so it is rejected outright instead.
    let ds_clients: u32 = decoder.read_var().map_err(parity_decode_error)?;
    for _ in 0..ds_clients {
        let client = safe_read_client(&mut decoder)?;
        if structure.deleted_ranges.contains_key(&client) {
            return Err(CollabError::ReplayParityViolation {
                reason: "the update delete-set repeats a client section".to_owned(),
            });
        }
        let ranges_len: u32 = decoder.read_var().map_err(parity_decode_error)?;
        let coverage = structure.deleted_ranges.entry(client).or_default();
        for _ in 0..ranges_len {
            let start: u32 = decoder.read_var().map_err(parity_decode_error)?;
            let len: u32 = decoder.read_var().map_err(parity_decode_error)?;
            // yrs delete-set ranges are half-open `start..end` (Rust `Range`).
            let end = start.checked_add(len).ok_or_else(parity_clock_overflow)?;
            structure.deletion_boundaries.push(ID::new(client, start));
            structure.deletion_boundaries.push(ID::new(client, end));
            coverage.push((start, end));
        }
    }
    if !decoder
        .read_to_end()
        .map_err(parity_decode_error)?
        .is_empty()
    {
        return Err(CollabError::ReplayParityViolation {
            reason: "the update contains unconsumed structural bytes".to_owned(),
        });
    }
    Ok(structure)
}

fn scan_item(
    decoder: &mut DecoderV1<'_>,
    info: u8,
    id: ID,
    structure: &mut WireStructure,
) -> Result<u32, CollabError> {
    let has_origin = info & HAS_ORIGIN != 0;
    let has_right_origin = info & HAS_RIGHT_ORIGIN != 0;
    if has_origin {
        let origin = safe_read_id(decoder)?;
        let boundary_clock = origin
            .clock
            .checked_add(1)
            .ok_or_else(parity_clock_overflow)?;
        structure
            .insertion_boundaries
            .push(ID::new(origin.client, boundary_clock));
    }
    if has_right_origin {
        structure.insertion_boundaries.push(safe_read_id(decoder)?);
    }
    if !has_origin && !has_right_origin {
        if decoder.read_parent_info().map_err(parity_decode_error)? {
            let _ = safe_read_string(decoder)?;
        } else {
            let _ = safe_read_id(decoder)?;
        }
        if info & HAS_PARENT_SUB != 0 {
            let _ = safe_read_string(decoder)?;
        }
    }
    scan_content(decoder, info & 0b0000_1111, id, structure)
}

fn scan_content(
    decoder: &mut DecoderV1<'_>,
    content_ref: u8,
    id: ID,
    structure: &mut WireStructure,
) -> Result<u32, CollabError> {
    match content_ref {
        BLOCK_ITEM_DELETED_REF_NUMBER => {
            // A deleted-content item: `len` tombstone clocks (render nothing).
            let len = decoder.read_len().map_err(parity_decode_error)?;
            for i in 0..len {
                let clock = id.clock.checked_add(i).ok_or_else(parity_clock_overflow)?;
                record_identity(structure, id.client, clock, ClockIdentity::Tombstone);
            }
            Ok(len)
        }
        BLOCK_ITEM_JSON_REF_NUMBER => {
            // `ContentJson` decodes `read_len() + 1` pre-serialized JSON strings
            // (yrs loops `while remaining >= 0`), one clock each; the item
            // length is that string count. The stored string IS the canonical
            // form (yjs stores ContentJSON serialized).
            let count = decoder.read_len().map_err(parity_decode_error)?;
            let strings = count.checked_add(1).ok_or_else(parity_clock_overflow)?;
            for i in 0..strings {
                let text = safe_read_string(decoder)?;
                let clock = id.clock.checked_add(i).ok_or_else(parity_clock_overflow)?;
                record_identity(
                    structure,
                    id.client,
                    clock,
                    ClockIdentity::Typed {
                        kind: content_ref,
                        payload: crate::hex_sha256(text.as_bytes()),
                    },
                );
            }
            Ok(strings)
        }
        BLOCK_ITEM_BINARY_REF_NUMBER => {
            let bytes = decoder.read_buf().map_err(parity_decode_error)?;
            record_identity(
                structure,
                id.client,
                id.clock,
                ClockIdentity::Typed {
                    kind: content_ref,
                    payload: crate::hex_sha256(bytes),
                },
            );
            Ok(1)
        }
        BLOCK_ITEM_STRING_REF_NUMBER => {
            let text = safe_read_string(decoder)?;
            let mut offset = 0u32;
            for scalar in text.chars() {
                let mut buf = [0u16; 2];
                let units = scalar.encode_utf16(&mut buf);
                for (interior, unit) in units.iter().enumerate() {
                    let clock = id
                        .clock
                        .checked_add(offset)
                        .and_then(|value| value.checked_add(interior as u32))
                        .ok_or_else(parity_clock_overflow)?;
                    record_identity(
                        structure,
                        id.client,
                        clock,
                        ClockIdentity::StringUnit(*unit),
                    );
                    if interior > 0 {
                        structure
                            .unsafe_boundaries
                            .insert(ID::new(id.client, clock));
                    }
                }
                offset = offset
                    .checked_add(units.len() as u32)
                    .ok_or_else(parity_clock_overflow)?;
            }
            Ok(offset)
        }
        BLOCK_ITEM_EMBED_REF_NUMBER => {
            let value = safe_read_json(decoder)?;
            record_identity(
                structure,
                id.client,
                id.clock,
                ClockIdentity::Typed {
                    kind: content_ref,
                    payload: any_payload(&value),
                },
            );
            Ok(1)
        }
        BLOCK_ITEM_FORMAT_REF_NUMBER => {
            let key = safe_read_string(decoder)?.to_owned();
            let value = safe_read_json(decoder)?;
            // Canonicalize (key, value) together: key bytes, a NUL separator
            // (keys cannot contain NUL), then the order-independent Any payload.
            let mut canonical = key.as_bytes().to_vec();
            canonical.push(0);
            canonical.extend_from_slice(
                serde_json::to_vec(&crate::ydoc::any_to_json(&value))
                    .unwrap_or_default()
                    .as_slice(),
            );
            record_identity(
                structure,
                id.client,
                id.clock,
                ClockIdentity::Typed {
                    kind: content_ref,
                    payload: crate::hex_sha256(&canonical),
                },
            );
            Ok(1)
        }
        BLOCK_ITEM_TYPE_REF_NUMBER => {
            let fingerprint = safe_read_type_ref_fingerprint(decoder)?;
            record_identity(
                structure,
                id.client,
                id.clock,
                ClockIdentity::Typed {
                    kind: content_ref,
                    payload: crate::hex_sha256(&fingerprint),
                },
            );
            Ok(1)
        }
        BLOCK_ITEM_ANY_REF_NUMBER => {
            let len = decoder.read_len().map_err(parity_decode_error)?;
            for i in 0..len {
                let value = safe_read_any(decoder)?;
                let clock = id.clock.checked_add(i).ok_or_else(parity_clock_overflow)?;
                record_identity(
                    structure,
                    id.client,
                    clock,
                    ClockIdentity::Typed {
                        kind: content_ref,
                        payload: any_payload(&value),
                    },
                );
            }
            Ok(len)
        }
        BLOCK_ITEM_DOC_REF_NUMBER => {
            let fingerprint = safe_read_options_fingerprint(decoder)?;
            record_identity(
                structure,
                id.client,
                id.clock,
                ClockIdentity::Typed {
                    kind: content_ref,
                    payload: crate::hex_sha256(&fingerprint),
                },
            );
            Ok(1)
        }
        _ => Err(CollabError::ReplayParityViolation {
            reason: "the update uses an unsupported structural content type".to_owned(),
        }),
    }
}

fn parity_decode_error(error: yrs::encoding::read::Error) -> CollabError {
    CollabError::ReplayParityViolation {
        reason: format!("structural update inspection failed: {error}"),
    }
}

fn parity_clock_overflow() -> CollabError {
    CollabError::ReplayParityViolation {
        reason: "a structural update clock overflowed".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An internal unwind during replay validation (which can originate inside
    /// yrs on some malformed inputs) must be contained and mapped to a
    /// fail-closed rejection — never allowed to escape into the caller's
    /// write transaction. Verified deterministically via the test-only inject
    /// seam so the containment holds regardless of which yrs path unwinds.
    #[test]
    fn contains_internal_unwind_as_fail_closed_rejection() {
        let base = Ydoc::wire();
        let producer = Ydoc::wire();
        let candidate = producer.plaintext_insert(0, "hello");

        // Sanity: without injection the gate returns normally (accepts).
        assert!(validate_replay_parity(&base, &candidate).is_ok());

        PANIC_INJECT.with(|cell| cell.set(true));
        let escaped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            validate_replay_parity(&base, &candidate)
        }));
        PANIC_INJECT.with(|cell| cell.set(false));

        let inner = escaped.expect("the gate must contain the unwind, not let it escape");
        assert!(
            matches!(inner, Err(CollabError::ReplayParityViolation { .. })),
            "a contained unwind must become a fail-closed rejection"
        );
    }

    /// Content-parity: a candidate that re-encodes an id the base already
    /// owns with DIFFERENT text content must be rejected even though the
    /// clock is fully covered (no shortfall) and the redefinition itself is
    /// not a multi-unit-scalar interior split.
    #[test]
    fn rejects_content_redefinition_of_an_already_known_clock() {
        let base = Ydoc::wire();
        let base_update = base.plaintext_insert(0, "a");

        // A hostile candidate claims the SAME (client, clock) as `base_update`
        // but with different content ("b" instead of "a"). Built by corrupting
        // the original bytes' single-byte string payload directly (locating it
        // by the fixed `plainText` root-name marker, since the preceding
        // client-id varint's byte length varies with the doc's random client
        // id): `...plainText<len=1><char>` — the content byte immediately
        // follows the 1-byte string-length prefix after the marker.
        let marker = b"plainText";
        let marker_at = base_update
            .windows(marker.len())
            .position(|w| w == marker)
            .expect("plainText root marker present");
        let content_at = marker_at + marker.len() + 1; // skip marker + 1-byte len prefix
        let mut hostile = base_update.clone();
        assert_eq!(hostile[content_at], b'a');
        hostile[content_at] = b'b';

        let seeded = Ydoc::wire();
        seeded.apply(&base_update).expect("seed base");
        let error = validate_replay_parity(&seeded, &hostile)
            .expect_err("content redefinition must be rejected");
        assert!(matches!(error, CollabError::ReplayParityViolation { .. }));
    }

    /// A zero-length structural block (degenerate wire claim) is rejected
    /// before any doc is touched, regardless of content.
    #[test]
    fn rejects_zero_length_structural_block() {
        // A JSON content block (ref 4) with an explicit len of 0: one client,
        // one block, info byte selects JSON content with no origin/right-origin
        // (info low nibble = BLOCK_ITEM_JSON_REF_NUMBER = 4), no parent-sub,
        // left-origin id, then a var len of 0.
        // clients_len=1, blocks_len=1, client=9, clock=0, info=0x04,
        // parent_info(false)=0, left_id(client=9,clock=0), len=0, deletes=empty.
        let bytes: Vec<u8> = vec![
            0x01, // clients_len
            0x01, // blocks_len
            0x09, // client
            0x00, // clock
            0x04, // info: JSON content, no origin/right-origin
            0x00, // parent_info: false (left id follows)
            0x09, // left id client
            0x00, // left id clock
            0x00, // len = 0
            0x00, // empty delete set
        ];
        let base = Ydoc::wire();
        let error =
            validate_replay_parity(&base, &bytes).expect_err("zero-length block must be rejected");
        assert!(matches!(error, CollabError::ReplayParityViolation { .. }));
    }

    /// No-false-positive coverage for [`safe_read_type_ref_fingerprint`]'s
    /// `TYPE_REFS_XML_ELEMENT` arm specifically (the one arm that reads a
    /// string field — the honest-corpus fixtures exercise `TypeRef` content
    /// via non-string variants like `TYPE_REFS_MAP`, so this pins the
    /// string-bearing arm directly): a well-formed `ContentType` item naming
    /// an XML element tag ("paragraph") must be accepted, not rejected.
    #[test]
    fn accepts_well_formed_xml_element_type_ref_content() {
        let bytes: Vec<u8> = vec![
            0x01, // clients_len
            0x01, // blocks_len
            0x09, // client
            0x00, // clock
            0x07, // info: BLOCK_ITEM_TYPE_REF_NUMBER content, no origin/right-origin
            0x01, // parent_info: true (named root follows)
            0x04, b't', b'e', b's', b't', // root name "test" (len=4)
            0x03, // TypeRef tag = TYPE_REFS_XML_ELEMENT
            0x09, b'p', b'a', b'r', b'a', b'g', b'r', b'a', b'p', b'h', // tag "paragraph"
            0x00, // empty delete set
        ];
        let structure = scan_v1(&bytes).expect("well-formed XmlElement type ref must be accepted");
        assert_eq!(structure.claimed_clocks.len(), 1);
    }

    /// No-false-positive coverage for [`safe_read_options_fingerprint`]
    /// (`BLOCK_ITEM_DOC_REF_NUMBER` — a sub-document reference): a
    /// well-formed guid string plus a nested `Any::Map` options payload must
    /// be accepted, not rejected. Not exercised by the honest-corpus fixtures
    /// (this schema never embeds sub-documents), so this is the direct
    /// evidence for that code path.
    #[test]
    fn accepts_well_formed_sub_document_content() {
        let bytes: Vec<u8> = vec![
            0x01, // clients_len
            0x01, // blocks_len
            0x09, // client
            0x00, // clock
            0x09, // info: BLOCK_ITEM_DOC_REF_NUMBER content, no origin/right-origin
            0x01, // parent_info: true (named root follows)
            0x04, b't', b'e', b's', b't', // root name "test" (len=4)
            0x04, b'g', b'u', b'i', b'd', // guid string (len=4) "guid"
            0x76, // Any tag 118: Map
            0x01, // map len = 1
            0x02, b'g', b'c', // key "gc" (len=2)
            0x78, // value: Any tag 120 = Bool(true)
            0x00, // empty delete set
        ];
        let structure = scan_v1(&bytes).expect("well-formed sub-document content must be accepted");
        assert_eq!(structure.claimed_clocks.len(), 1);
    }

    /// `scan_v1` whose `Ok` payload (`WireStructure`, deliberately not
    /// `Debug`) is discarded — asserting only that it rejects.
    fn scan_err(bytes: &[u8]) -> CollabError {
        match scan_v1(bytes) {
            Ok(_) => panic!("expected scan_v1 to reject these bytes"),
            Err(error) => error,
        }
    }

    /// varint encoding of `2^53` — the smallest client identifier OUTSIDE the
    /// 53-bit yjs range (yrs `ClientID::new` debug-asserts on it; in release
    /// it would silently alias client `0`).
    const CLIENT_2_POW_53: [u8; 8] = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10];
    /// varint encoding of `2^53 - 1` — the LARGEST honest client identifier.
    const CLIENT_MAX_HONEST: [u8; 8] = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f];

    #[test]
    fn rejects_53_bit_overflow_client_in_block_section() {
        let mut bytes: Vec<u8> = vec![0x01, 0x01]; // clients_len, blocks_len
        bytes.extend_from_slice(&CLIENT_2_POW_53);
        // Nothing after the client id should even be read — the reject fires
        // at the client read itself (this is also byte-for-byte the shrunken
        // proptest regression seed that used to panic inside yrs).
        let error = scan_err(&bytes);
        assert!(matches!(error, CollabError::ReplayParityViolation { .. }));
    }

    #[test]
    fn rejects_53_bit_overflow_client_in_origin_id() {
        let mut bytes: Vec<u8> = vec![
            0x01, // clients_len
            0x01, // blocks_len
            0x09, // client
            0x00, // clock
            0x84, // info: string content (4) | HAS_ORIGIN
        ];
        bytes.extend_from_slice(&CLIENT_2_POW_53); // origin id client
        let error = scan_err(&bytes);
        assert!(matches!(error, CollabError::ReplayParityViolation { .. }));
    }

    #[test]
    fn rejects_53_bit_overflow_client_in_delete_set() {
        let mut bytes: Vec<u8> = vec![
            0x00, // clients_len: no blocks
            0x01, // delete-set client sections
        ];
        bytes.extend_from_slice(&CLIENT_2_POW_53);
        let error = scan_err(&bytes);
        assert!(matches!(error, CollabError::ReplayParityViolation { .. }));
    }

    #[test]
    fn rejects_delete_set_range_end_clock_overflow() {
        let bytes: Vec<u8> = vec![
            0x00, // clients_len: no blocks
            0x01, // delete-set client sections
            0x09, // client
            0x01, // ranges_len
            0xff, 0xff, 0xff, 0xff, 0x0f, // start = u32::MAX
            0x01, // len = 1 -> end overflows u32 (yrs computes this UNCHECKED)
        ];
        let error = scan_err(&bytes);
        assert!(matches!(error, CollabError::ReplayParityViolation { .. }));
    }

    #[test]
    fn rejects_duplicate_delete_set_client_section() {
        let bytes: Vec<u8> = vec![
            0x00, // clients_len: no blocks
            0x02, // delete-set client sections
            0x09, // client
            0x01, // ranges_len
            0x00, // start
            0x01, // len
            0x09, // the SAME client again (yrs would silently drop the first)
            0x01, // ranges_len
            0x05, // start
            0x01, // len
        ];
        let error = scan_err(&bytes);
        assert!(matches!(error, CollabError::ReplayParityViolation { .. }));
    }

    /// The 53-bit bound is exact: the LARGEST honest client identifier
    /// (`2^53 - 1`, producible by real yjs) must still be accepted end-to-end.
    #[test]
    fn accepts_max_honest_53_bit_client() {
        let mut bytes: Vec<u8> = vec![0x01, 0x01]; // clients_len, blocks_len
        bytes.extend_from_slice(&CLIENT_MAX_HONEST);
        bytes.extend_from_slice(&[
            0x00, // clock
            0x04, // info: string content, no origins
            0x01, // parent_info: named root follows
            0x04, b't', b'e', b's', b't', // root name
            0x02, b'h', b'i', // string content "hi"
            0x00, // empty delete set
        ]);
        let structure = scan_v1(&bytes).expect("max honest 53-bit client must be accepted");
        assert_eq!(structure.claimed_clocks.len(), 1);
    }
}
