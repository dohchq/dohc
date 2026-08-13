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
}

#[derive(Default)]
struct WireStructure {
    unsafe_boundaries: BTreeSet<ID>,
    insertion_boundaries: Vec<ID>,
    deletion_boundaries: Vec<ID>,
    claimed_clocks: BTreeMap<ClientID, u32>,
    /// The structural identity every LIVE content block in this wire claims, by
    /// `(client, clock)`. Covers all live content kinds (string, JSON, binary,
    /// embed, format, type, doc, any) — the content-parity check compares these
    /// across wires at overlapping clocks so a candidate cannot redefine an
    /// already-known clock's kind or payload. `ContentDeleted` tombstones are
    /// NOT stored here: a single `ContentDeleted` item can span up to `u32::MAX`
    /// clocks in a few wire bytes, so materializing one identity per clock is an
    /// unbounded, attacker-controlled allocation on the untrusted decode path.
    /// They are tracked as O(1) ranges in [`WireStructure::tombstone_ranges`].
    identities: BTreeMap<ClientID, BTreeMap<u32, ClockIdentity>>,
    /// Half-open `[start, end)` clock ranges this wire tombstones via a
    /// `ContentDeleted` item, recorded as O(1) ranges (never one entry per
    /// clock). The content-parity check queries membership here — only for the
    /// bounded set of clocks the ESTABLISHED side already holds as live — rather
    /// than materializing every tombstoned clock, which a hostile peer could
    /// drive to `u32::MAX` in a handful of wire bytes. [`scan_v1`] normalizes
    /// each vector once ([`normalize_ranges`]: sorted, coalesced,
    /// non-overlapping, no empties) so membership is a binary search, not a
    /// linear scan over an attacker-controlled range count.
    tombstone_ranges: BTreeMap<ClientID, Vec<(u32, u32)>>,
    /// The wire's own delete-set as `(client, [start, end))` half-open clock
    /// ranges. A `ContentDeleted` item whose clock IS in this set is a
    /// legitimate delete/GC (the deletion the peer performed); a bare
    /// `ContentDeleted` NOT covered here is a hostile redefinition. Normalized
    /// by [`scan_v1`] like [`WireStructure::tombstone_ranges`] so membership is
    /// a binary search. Only the covers-queries read these vectors; the
    /// delete-set BOUNDARY endpoints consumed elsewhere are recorded separately
    /// (and unnormalized) in `deletion_boundaries`.
    deleted_ranges: BTreeMap<ClientID, Vec<(u32, u32)>>,
}

impl WireStructure {
    /// Whether this wire's own delete-set covers `(client, clock)` — i.e. the
    /// wire genuinely deletes that clock (a real delete/GC), as opposed to
    /// merely re-encoding it.
    fn delete_set_covers(&self, client: ClientID, clock: u32) -> bool {
        self.deleted_ranges
            .get(&client)
            .is_some_and(|ranges| normalized_ranges_cover(ranges, clock))
    }

    /// Whether this wire tombstones `(client, clock)` via a `ContentDeleted`
    /// item — the range-based replacement for a per-clock `Tombstone` identity
    /// lookup (see [`WireStructure::tombstone_ranges`]).
    fn tombstone_covers(&self, client: ClientID, clock: u32) -> bool {
        self.tombstone_ranges
            .get(&client)
            .is_some_and(|ranges| normalized_ranges_cover(ranges, clock))
    }
}

/// Sort and coalesce half-open `[start, end)` ranges in place: drop empty
/// ranges (they cover nothing), sort by start, and merge overlapping or
/// adjacent ranges. Membership ("does any range cover this clock") is EXACTLY
/// preserved; only the representation changes. Both range counts are
/// attacker-controlled (one wire varint plus a few bytes per range), and the
/// content-parity check queries membership once per established live clock —
/// with a linear `any()` scan that product is O(live_clocks x ranges), a
/// quadratic CPU-exhaustion DoS on the untrusted `apply_remote_update` path.
/// Normalizing once (O(R log R)) makes each query a binary search (O(log R)).
fn normalize_ranges(ranges: &mut Vec<(u32, u32)>) {
    ranges.retain(|&(start, end)| start < end);
    ranges.sort_unstable();
    let mut merged: Vec<(u32, u32)> = Vec::with_capacity(ranges.len());
    for &(start, end) in ranges.iter() {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    *ranges = merged;
}

/// Binary-search membership over ranges normalized by [`normalize_ranges`]
/// (sorted by start, non-overlapping, non-empty): find the last range starting
/// at or before `clock`; it covers `clock` iff its end is past it.
fn normalized_ranges_cover(ranges: &[(u32, u32)], clock: u32) -> bool {
    let idx = ranges.partition_point(|&(start, _)| start <= clock);
    idx > 0 && clock < ranges[idx - 1].1
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
        // Every identity the established side stores is LIVE content
        // (tombstones live in `tombstone_ranges`, not here), so each entry is a
        // clock a conflicting candidate could diverge.
        for (clock, established_identity) in known {
            // A candidate LIVE identity at the same clock must match exactly.
            if let Some(candidate_identity) =
                candidate.identities.get(client).and_then(|m| m.get(clock))
            {
                if candidate_identity == established_identity {
                    continue; // identical live content: a clean resend
                }
                return true; // a different live kind/payload: hostile redefinition
            }
            // No candidate LIVE identity here. If the candidate instead
            // TOMBSTONES this clock, that is a legitimate delete/GC only when
            // its own delete-set also covers it (the normal reconnect
            // full-state resend carries a deleted clock this way); a BARE
            // tombstone not in the delete-set is a hostile redefinition.
            if candidate.tombstone_covers(*client, *clock) {
                if candidate.delete_set_covers(*client, *clock) {
                    continue; // a genuine delete/GC of this clock, not a redefinition
                }
                return true;
            }
            // The candidate does not claim this clock at all: nothing to compare.
        }
    }
    false
}

/// A canonical, order-independent fingerprint of an `Any` value: the tagged,
/// length-delimited encoding ([`append_canonical_any`]) hashed. Map keys are
/// sorted (constraint 2), so two encodings of the same logical value fingerprint
/// identically even if yrs re-encoded a map's keys in a different order — a
/// legitimate full-state resend is never false-flagged.
///
/// NOT `any_to_json`: that projection is LOSSY for the content-parity check —
/// it collapses `Any::BigInt(1)`/`Any::Number(1.0)`, `Any::Null`/`Any::Undefined`,
/// and `Any::Buffer(b)`/`Any::Map({"__bytes__": b})` to the same JSON, so a
/// hostile re-encode swapping one of those variants at an already-known clock
/// would hash identically and slip past the parity check. The tagged encoding
/// gives every variant a distinct tag byte, so no two distinct `Any` wire values
/// share a fingerprint.
fn any_payload(value: &Any) -> String {
    let mut canonical = Vec::new();
    append_canonical_any(&mut canonical, value);
    crate::hex_sha256(&canonical)
}

/// Append a tagged, length-delimited, variant-preserving canonical encoding of
/// `value` to `out`. Every `Any` variant gets a distinct leading tag byte;
/// scalars carry their raw bits, byte/string fields a length prefix, and
/// collections a count prefix with map keys sorted for order-independence.
/// Recurses only over an `Any` tree already depth-bounded by [`safe_read_any`]
/// ([`MAX_ANY_DEPTH`]), so it cannot overflow the stack.
fn append_canonical_any(out: &mut Vec<u8>, value: &Any) {
    match value {
        Any::Undefined => out.push(0),
        Any::Null => out.push(1),
        Any::Bool(false) => out.push(2),
        Any::Bool(true) => out.push(3),
        Any::Number(n) => {
            out.push(4);
            out.extend_from_slice(&n.to_bits().to_be_bytes());
        }
        Any::BigInt(i) => {
            out.push(5);
            out.extend_from_slice(&i.to_be_bytes());
        }
        Any::String(s) => {
            out.push(6);
            out.extend_from_slice(&(s.len() as u64).to_be_bytes());
            out.extend_from_slice(s.as_bytes());
        }
        Any::Buffer(b) => {
            out.push(7);
            out.extend_from_slice(&(b.len() as u64).to_be_bytes());
            out.extend_from_slice(b);
        }
        Any::Array(items) => {
            out.push(8);
            out.extend_from_slice(&(items.len() as u64).to_be_bytes());
            for item in items.iter() {
                append_canonical_any(out, item);
            }
        }
        Any::Map(map) => {
            out.push(9);
            out.extend_from_slice(&(map.len() as u64).to_be_bytes());
            // Order-independent: sort by key so re-encoded key orders match.
            let mut sorted: Vec<(&String, &Any)> = map.iter().collect();
            sorted.sort_by(|a, b| a.0.cmp(b.0));
            for (k, v) in sorted {
                out.extend_from_slice(&(k.len() as u64).to_be_bytes());
                out.extend_from_slice(k.as_bytes());
                append_canonical_any(out, v);
            }
        }
    }
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

/// Pre-validate a v1 STATE VECTOR (the `Ydoc::diff` primitive's untrusted
/// remote input) before yrs' `StateVector::decode_v1`. A state vector carries
/// no strings, so the char-decode UB class does not apply — but yrs'
/// `StateVector::decode` constructs `ClientID` from the raw varint with the
/// same unchecked 53-bit behavior [`safe_read_client`] guards against (release:
/// silent high-bit aliasing of an honest client), and pre-allocates a
/// `HashMap` sized to the attacker-controlled `clients_len`. This walk applies
/// the 53-bit bound and reads every field with the ordinary bounds-checked
/// varint (no unsafe cast, no up-front allocation), rejecting a malformed or
/// out-of-range state vector fail-closed first.
pub(crate) fn prevalidate_state_vector_bytes(bytes: &[u8]) -> Result<(), CollabError> {
    let mut decoder = DecoderV1::from(bytes);
    let clients_len: u32 = decoder.read_var().map_err(parity_decode_error)?;
    for _ in 0..clients_len {
        // Bounds + 53-bit range checked; the clock is read but unconstrained.
        let _client = safe_read_client(&mut decoder)?;
        let _clock: u32 = decoder.read_var().map_err(parity_decode_error)?;
    }
    if !decoder
        .read_to_end()
        .map_err(parity_decode_error)?
        .is_empty()
    {
        return Err(CollabError::ReplayParityViolation {
            reason: "the state vector contains unconsumed bytes".to_owned(),
        });
    }
    Ok(())
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

/// Maximum `Any` container nesting the pre-validator (and, transitively, the
/// downstream `any_to_json` projection and yrs' own `Any::decode`) will accept.
/// Matches `serde_json`'s default recursion limit, so the embedded-JSON path
/// (`safe_read_json` → `Any::from_json`) and this manual path reject at the
/// same depth. An `Any::Array`/`Any::Map` chain is 2 bytes per level on the
/// wire (`[tag, len]`), so without this bound a hostile ~20 KB update nests
/// ~10k deep and OVERFLOWS THE STACK — an uncatchable process abort, the same
/// severity class this shard exists to close. No honest document nests remotely
/// this deep.
const MAX_ANY_DEPTH: usize = 128;

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
///
/// `depth` bounds recursion at [`MAX_ANY_DEPTH`]: an `Any::Array`/`Any::Map`
/// nest is attacker-controlled and cheap on the wire, so without this an
/// adversarial update overflows the stack (an uncatchable abort — a stack
/// overflow is not a Rust panic, so neither `catch_unwind` nor this module's
/// gate wrapper contains it). yrs' own `Any::decode` recurses unbounded too,
/// so bounding HERE — before the pre-validator accepts the update — is what
/// protects the downstream `decode_v1` as well.
fn safe_read_any(decoder: &mut DecoderV1<'_>, depth: usize) -> Result<Any, CollabError> {
    if depth >= MAX_ANY_DEPTH {
        return Err(CollabError::ReplayParityViolation {
            reason: "the update nests an Any value beyond the maximum depth".to_owned(),
        });
    }
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
                let value = safe_read_any(decoder, depth + 1)?;
                map.insert(key, value);
            }
            Any::Map(Arc::new(map))
        }
        117 => {
            let len: usize = decoder.read_var().map_err(parity_decode_error)?;
            let mut arr = Vec::new();
            for _ in 0..len {
                arr.push(safe_read_any(decoder, depth + 1)?);
            }
            Any::Array(Arc::from(arr))
        }
        116 => Any::Buffer(Arc::from(decoder.read_buf().map_err(parity_decode_error)?)),
        _ => {
            return Err(CollabError::ReplayParityViolation {
                reason: "the update contains an unsupported Any value tag".to_owned(),
            });
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
            });
        }
    }
    Ok(canonical)
}

/// A SAFE reimplementation of `Options::decode`'s wire shape (a guid string
/// plus an `Any` map of sub-document options). The subdocument's IDENTITY for
/// the content-parity check is its GUID alone; the options `Any` is consumed
/// and validated (so the wire position stays correct and a malformed options
/// payload is still rejected) but deliberately NOT folded into the fingerprint.
/// yrs fills option defaults (`gc`/`encoding`/`shouldLoad`, and drops fields it
/// ignores) when it re-encodes an integrated `ContentDoc`, so `encode_full_state`
/// presents a different options payload than an honest Yjs full-state resend of
/// the same subdocument — hashing the raw options would false-reject that honest
/// resend as a hostile redefinition. A genuine redefinition changes the GUID
/// (a different subdocument), which the fingerprint still catches. Reimplemented
/// rather than calling `Options::decode` because it reads the guid via yrs'
/// unsafe `read_string` (see [`safe_read_string`]).
fn safe_read_options_fingerprint(decoder: &mut DecoderV1<'_>) -> Result<Vec<u8>, CollabError> {
    let guid = safe_read_string(decoder)?;
    let mut canonical = (guid.len() as u64).to_be_bytes().to_vec();
    canonical.extend_from_slice(guid.as_bytes());
    // Consume + validate the options `Any` (wire position + well-formedness);
    // see the doc comment for why it is NOT part of the fingerprint.
    let _ = safe_read_any(decoder, 0)?;
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
///
/// The varint is read CANONICALLY rather than via `read_var::<u64>`: yrs'
/// `read_var` decodes with `wrapping_shl` and only errors past 70 bits, so an
/// OVERLONG encoding (e.g. `2^70 + n`) wraps down to `n` — a mask applied to
/// that already-decoded value would then see an in-range client and let the
/// out-of-range wire id through. Reading the LEB128 groups directly and failing
/// closed on a non-minimal terminator, more than 8 groups, or a value `> 2^53-1`
/// closes that: no honest yjs encoder produces any of those, so there are no
/// false positives; the gate is simply stricter than yrs here.
fn safe_read_client(decoder: &mut DecoderV1<'_>) -> Result<ClientID, CollabError> {
    let out_of_range = || CollabError::ReplayParityViolation {
        reason: "the update contains a client identifier outside the 53-bit yjs range".to_owned(),
    };
    let mut value: u64 = 0;
    let mut shift: u32 = 0;
    let mut groups: u32 = 0;
    loop {
        let byte = decoder.read_u8().map_err(parity_decode_error)?;
        groups += 1;
        value |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            // Terminating group. Reject a non-minimal encoding: a multi-byte
            // varint whose final group is empty (a canonical encoder never
            // emits trailing zero groups).
            if groups > 1 && byte == 0 {
                return Err(out_of_range());
            }
            break;
        }
        shift += 7;
        // 8 groups (shifts 0..=49) span the 53-bit range; a 9th continuation
        // group is out of range (and, being padding, non-canonical).
        if shift >= 56 {
            return Err(out_of_range());
        }
    }
    if value > MAX_CLIENT_ID {
        return Err(out_of_range());
    }
    Ok(ClientID::new(value))
}

/// Maximum yjs client identifier: JavaScript numbers, so 53 bits.
const MAX_CLIENT_ID: u64 = (1u64 << 53) - 1;

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
    // Normalize both covers-query range sets once, so every later membership
    // query is a binary search instead of a linear scan over an
    // attacker-controlled range count (see `normalize_ranges`).
    for ranges in structure.tombstone_ranges.values_mut() {
        normalize_ranges(ranges);
    }
    for ranges in structure.deleted_ranges.values_mut() {
        normalize_ranges(ranges);
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
            // `len` is an attacker-controlled wire varint up to `u32::MAX`, and
            // yrs stores the whole item as that single count (O(1)); recording
            // one `Tombstone` identity per clock here would be an unbounded
            // allocation a hostile peer could trigger with ~10 wire bytes (an
            // out-of-memory DoS on this untrusted pre-validator). Track the
            // half-open `[clock, clock + len)` range instead — the parity check
            // queries membership rather than materializing every clock.
            let len = decoder.read_len().map_err(parity_decode_error)?;
            let end = id
                .clock
                .checked_add(len)
                .ok_or_else(parity_clock_overflow)?;
            structure
                .tombstone_ranges
                .entry(id.client)
                .or_default()
                .push((id.clock, end));
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
            // Canonicalize (key, value) together: a length-prefixed key, then
            // the tagged, variant-preserving Any payload.
            let mut canonical = (key.len() as u64).to_be_bytes().to_vec();
            canonical.extend_from_slice(key.as_bytes());
            append_canonical_any(&mut canonical, &value);
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
                let value = safe_read_any(decoder, 0)?;
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

    /// A NON-MINIMAL (overlong) client varint must be rejected, even though it
    /// decodes (via yrs' wrapping `read_var`) to an in-range value. `[0x89,
    /// 0x00]` is client `9` with a redundant trailing all-zero group — no
    /// honest yjs encoder emits it, and it is exactly the shape that would let
    /// an out-of-range wire id wrap past a mask applied to the decoded value.
    #[test]
    fn rejects_overlong_client_varint_in_block_section() {
        let bytes: Vec<u8> = vec![
            0x01, // clients_len
            0x01, // blocks_len
            0x89, 0x00, // client 9, non-minimal (trailing zero group)
        ];
        let error = scan_err(&bytes);
        assert!(matches!(error, CollabError::ReplayParityViolation { .. }));
    }

    /// A 9-group client varint (padding continuation bytes past the 53-bit
    /// range) must be rejected before it can wrap to an in-range value.
    #[test]
    fn rejects_padded_9_group_client_varint() {
        let bytes: Vec<u8> = vec![
            0x01, // clients_len
            0x01, // blocks_len
            // client 9 padded to 9 groups: 8 continuation groups then a
            // terminating one -> exceeds the 8-group (53-bit) budget.
            0x89, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00,
        ];
        let error = scan_err(&bytes);
        assert!(matches!(error, CollabError::ReplayParityViolation { .. }));
    }

    /// A `ContentDoc` sub-document whose GUID matches but whose options `Any`
    /// differs (as happens when yrs fills option defaults on re-encode) must
    /// fingerprint IDENTICALLY — the guid is the identity, the options are not
    /// part of it — so an honest full-state resend is never false-rejected.
    #[test]
    fn sub_document_fingerprint_ignores_options_payload() {
        // Two ContentDoc blocks, same guid "g", different options maps.
        let with_opts = |opts: &[u8]| -> Vec<u8> {
            let mut b: Vec<u8> = vec![
                0x01, // clients_len
                0x01, // blocks_len
                0x09, // client
                0x00, // clock
                0x09, // info: BLOCK_ITEM_DOC_REF_NUMBER, no origins
                0x01, // parent_info: named root
                0x01, b'r', // root "r"
                0x01, b'g', // guid "g"
            ];
            b.extend_from_slice(opts);
            b.push(0x00); // empty delete set
            b
        };
        // Options A: empty map. Options B: a map with one bool entry.
        let a = scan_v1(&with_opts(&[0x76, 0x00])).expect("A valid");
        let b = scan_v1(&with_opts(&[0x76, 0x01, 0x02, b'g', b'c', 0x78])).expect("B valid");
        let ida = &a.identities[&ClientID::new(9)][&0];
        let idb = &b.identities[&ClientID::new(9)][&0];
        assert!(ida == idb, "same-guid subdocs must fingerprint identically");
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

    /// [`normalize_ranges`] + [`normalized_ranges_cover`] must answer
    /// membership EXACTLY like a linear scan over the raw, un-normalized
    /// ranges — including unsorted, overlapping, adjacent, duplicate, and
    /// empty ranges (all of which a hostile wire can encode).
    #[test]
    fn normalized_range_membership_matches_linear_scan() {
        let raw: Vec<(u32, u32)> = vec![
            (10, 15), // plain
            (8, 12),  // overlaps the above
            (15, 16), // adjacent (coalesces)
            (30, 30), // empty (covers nothing)
            (25, 27),
            (25, 27),       // duplicate
            (2, 3),         // out of order
            (40, u32::MAX), // huge tail
        ];
        let mut normalized = raw.clone();
        normalize_ranges(&mut normalized);
        // Normalized invariant: sorted, non-overlapping, non-empty.
        for pair in normalized.windows(2) {
            assert!(pair[0].1 < pair[1].0, "ranges must be disjoint and sorted");
        }
        assert!(normalized.iter().all(|&(s, e)| s < e));
        let linear = |clock: u32| raw.iter().any(|&(s, e)| s <= clock && clock < e);
        for clock in 0..64u32 {
            assert_eq!(
                normalized_ranges_cover(&normalized, clock),
                linear(clock),
                "membership diverged at clock {clock}"
            );
        }
        for clock in [u32::MAX - 1, u32::MAX] {
            assert_eq!(normalized_ranges_cover(&normalized, clock), linear(clock));
        }
    }

    /// End-to-end: a wire delete-set with overlapping/empty/unsorted ranges is
    /// normalized by `scan_v1`, and `delete_set_covers` answers are unchanged
    /// from the pre-normalization (linear-scan) semantics.
    #[test]
    fn scan_normalizes_hostile_delete_set_ranges_with_identical_membership() {
        let bytes: Vec<u8> = vec![
            0x00, // clients_len: no blocks
            0x01, // delete-set client sections
            0x09, // client
            0x03, // ranges_len
            0x0a, 0x05, // [10, 15)
            0x0c, 0x00, // [12, 12) -- empty
            0x08, 0x04, // [8, 12) -- overlaps the first
        ];
        let structure = scan_v1(&bytes).expect("a messy but well-formed delete-set must scan");
        let client = ClientID::new(9);
        assert_eq!(structure.deleted_ranges[&client], vec![(8, 15)]);
        for (clock, expected) in [(7, false), (8, true), (12, true), (14, true), (15, false)] {
            assert_eq!(structure.delete_set_covers(client, clock), expected);
        }
    }

    /// Anti-quadratic regression: `content_parity_conflict` with MANY
    /// established live clocks against MANY fragmented candidate tombstone and
    /// delete-set ranges must run in O(clocks x log ranges), not
    /// O(clocks x ranges). 100k x 100k linear range scans (~1e10 comparisons)
    /// would take minutes in a debug build; the binary-search version completes
    /// in milliseconds. Every established clock is tombstoned AND delete-set
    /// covered by the candidate, so the scan exercises BOTH covers-queries for
    /// every clock and legitimately accepts (returns false) at the end.
    #[test]
    fn fragmented_range_membership_scans_are_not_quadratic() {
        const N: u32 = 100_000;
        let client = ClientID::new(9);
        let mut established = WireStructure::default();
        let known = established.identities.entry(client).or_default();
        for i in 0..N {
            known.insert(2 * i, ClockIdentity::StringUnit(b'x' as u16));
        }
        let mut candidate = WireStructure::default();
        let fragmented: Vec<(u32, u32)> = (0..N).map(|i| (2 * i, 2 * i + 1)).collect();
        candidate
            .tombstone_ranges
            .insert(client, fragmented.clone());
        candidate.deleted_ranges.insert(client, fragmented);
        for ranges in candidate.tombstone_ranges.values_mut() {
            normalize_ranges(ranges);
        }
        for ranges in candidate.deleted_ranges.values_mut() {
            normalize_ranges(ranges);
        }
        let started = std::time::Instant::now();
        let conflict = content_parity_conflict(&candidate, &established.identities);
        assert!(
            !conflict,
            "delete-set-covered tombstones are a legit delete/GC"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(20),
            "membership scans regressed to quadratic time"
        );
    }

    /// A `ContentDeleted` block legitimately spans up to `u32::MAX` tombstone
    /// clocks in a handful of wire bytes (yrs stores the whole item as a single
    /// count, O(1)). The pre-validator MUST record it as one range, NOT one
    /// identity per clock: a hostile peer could otherwise set the length to
    /// `u32::MAX` in ~10 bytes and drive `scan_v1` into ~4.29 billion `BTreeMap`
    /// inserts — a multi-gigabyte out-of-memory blow-up on the untrusted decode
    /// path (the regression this hotfix closes). This scan must complete
    /// near-instantly, accept the structurally-valid block, and record exactly
    /// one tombstone range.
    #[test]
    fn deleted_content_with_huge_len_scans_in_constant_memory() {
        let bytes: Vec<u8> = vec![
            0x01, // clients_len
            0x01, // blocks_len
            0x09, // client
            0x00, // clock
            0x01, // info: BLOCK_ITEM_DELETED_REF_NUMBER, no origins
            0x01, // parent_info: named root follows
            0x01, b'r', // root name "r"
            0xff, 0xff, 0xff, 0xff, 0x0f, // ContentDeleted len = u32::MAX (varint)
            0x00, // empty delete set
        ];
        let structure =
            scan_v1(&bytes).expect("a huge ContentDeleted length must scan, not exhaust memory");
        let ranges = &structure.tombstone_ranges[&ClientID::new(9)];
        assert_eq!(ranges, &vec![(0u32, u32::MAX)]);
        // Recorded as a single range, never materialized per clock.
        assert!(structure.identities.is_empty());
    }

    /// A `ContentAny` block (content-ref 8) whose `Any` payload is a chain of
    /// `MAX_ANY_DEPTH`+ length-1 arrays must be rejected — NOT drive
    /// `safe_read_any` into a stack overflow (an uncatchable abort). Each level
    /// is the 2 bytes `[117, 0x01]`, so this is the cheap, attacker-controlled
    /// nesting a hostile ~20 KB update would carry. This scan must complete and
    /// return `Err` without the recursion ever reaching the stack limit.
    #[test]
    fn rejects_deeply_nested_any_without_overflow() {
        let mut bytes: Vec<u8> = vec![
            0x01, // clients_len
            0x01, // blocks_len
            0x09, // client
            0x00, // clock
            0x08, // info: BLOCK_ITEM_ANY_REF_NUMBER content, no origins
            0x01, // parent_info: named root follows
            0x04, b't', b'e', b's', b't', // root name
            0x01, // ContentAny len = 1 value
        ];
        // MAX_ANY_DEPTH + 100 nested length-1 arrays, then a terminal Null.
        for _ in 0..(MAX_ANY_DEPTH + 100) {
            bytes.push(117); // Any::Array
            bytes.push(0x01); // len = 1
        }
        bytes.push(126); // innermost: Any::Null
        bytes.push(0x00); // empty delete set
        let error = scan_err(&bytes);
        assert!(matches!(error, CollabError::ReplayParityViolation { .. }));
    }

    /// The depth bound must not reject honest, shallow nesting: an `Any` array
    /// nested a few levels deep is well within `MAX_ANY_DEPTH` and must pass.
    #[test]
    fn accepts_shallow_nested_any() {
        let mut bytes: Vec<u8> = vec![
            0x01, // clients_len
            0x01, // blocks_len
            0x09, // client
            0x00, // clock
            0x08, // info: BLOCK_ITEM_ANY_REF_NUMBER content, no origins
            0x01, // parent_info: named root follows
            0x04, b't', b'e', b's', b't', // root name
            0x01, // ContentAny len = 1 value
        ];
        for _ in 0..4 {
            bytes.push(117); // Any::Array
            bytes.push(0x01); // len = 1
        }
        bytes.push(120); // innermost: Any::Bool(true)
        bytes.push(0x00); // empty delete set
        let structure = scan_v1(&bytes).expect("4-deep Any nesting must be accepted");
        assert_eq!(structure.claimed_clocks.len(), 1);
    }

    /// The canonical `Any` fingerprint must preserve every variant distinction
    /// that `any_to_json` collapses — otherwise a hostile re-encode swapping,
    /// e.g., `BigInt(1)` for `Number(1.0)` at an already-known clock would hash
    /// identically and slip past the content-parity check. Each pair below is
    /// two DISTINCT wire values that `any_to_json` maps to the same JSON.
    #[test]
    fn canonical_any_distinguishes_variants_json_collapses() {
        use std::sync::Arc;
        let pairs: [(Any, Any); 3] = [
            // BigInt(1) vs Number(1.0): serde JSON is `1` for both.
            (Any::BigInt(1), Any::Number(1.0)),
            // Null vs Undefined: serde JSON is `null` for both.
            (Any::Null, Any::Undefined),
            // Buffer(b) vs a Map carrying a "__bytes__" key: `any_to_json`
            // renders Buffer AS that very map shape.
            (
                Any::Buffer(Arc::from(vec![1u8, 2, 3].into_boxed_slice())),
                Any::Map(Arc::new(HashMap::from([(
                    "__bytes__".to_owned(),
                    Any::String(Arc::from("AQID")),
                )]))),
            ),
        ];
        for (a, b) in pairs {
            assert_ne!(
                any_payload(&a),
                any_payload(&b),
                "distinct Any wire values must not share a fingerprint"
            );
        }
        // And the SAME value fingerprints stably (map key order independent).
        let m1 = Any::Map(Arc::new(HashMap::from([
            ("a".to_owned(), Any::BigInt(1)),
            ("b".to_owned(), Any::Bool(true)),
        ])));
        let m2 = Any::Map(Arc::new(HashMap::from([
            ("b".to_owned(), Any::Bool(true)),
            ("a".to_owned(), Any::BigInt(1)),
        ])));
        assert_eq!(any_payload(&m1), any_payload(&m2));
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
