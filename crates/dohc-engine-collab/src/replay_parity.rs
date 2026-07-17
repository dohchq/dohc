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

use std::collections::{BTreeMap, BTreeSet};

use yrs::block::{
    BLOCK_GC_REF_NUMBER, BLOCK_ITEM_ANY_REF_NUMBER, BLOCK_ITEM_BINARY_REF_NUMBER,
    BLOCK_ITEM_DELETED_REF_NUMBER, BLOCK_ITEM_DOC_REF_NUMBER, BLOCK_ITEM_EMBED_REF_NUMBER,
    BLOCK_ITEM_FORMAT_REF_NUMBER, BLOCK_ITEM_JSON_REF_NUMBER, BLOCK_ITEM_STRING_REF_NUMBER,
    BLOCK_ITEM_TYPE_REF_NUMBER, BLOCK_SKIP_REF_NUMBER, HAS_ORIGIN, HAS_PARENT_SUB,
    HAS_RIGHT_ORIGIN, ID,
};
use yrs::encoding::read::Read;
use yrs::types::TypeRef;
use yrs::updates::decoder::{Decode, Decoder, DecoderV1};
use yrs::{ClientID, IdSet, Options, Update};

use crate::{CollabError, Ydoc};

#[derive(Default)]
struct WireStructure {
    unsafe_boundaries: BTreeSet<ID>,
    insertion_boundaries: Vec<ID>,
    deletion_boundaries: Vec<ID>,
    claimed_clocks: BTreeMap<ClientID, u32>,
    /// Every UTF-16 code unit a `String` content block in this wire claims, by
    /// `(client, clock)`. Populated only for text content (constraint 3's
    /// surrogate/FFFD-adjacent risk class) — the content-parity check compares
    /// these across wires at overlapping clocks.
    content_units: BTreeMap<ClientID, BTreeMap<u32, u16>>,
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
    Ydoc::validate_update(candidate)?;
    let base_full = base.encode_full_state();
    let base_structure = scan_v1(&base_full)?;
    let candidate_structure = scan_v1(candidate)?;
    let pending_bytes = base.pending_update_v1();
    let pending_structure = match &pending_bytes {
        Some(bytes) => scan_v1(bytes)?,
        None => WireStructure::default(),
    };

    // (1) Content parity: a candidate that re-encodes a clock the base or a
    // still-parked update already claims MUST carry identical content. yrs
    // dedups a re-encoded id by silently keeping its first-seen item; a
    // from-scratch Yjs peer replaying the same lineage can resolve the
    // conflicting redefinition differently. No honest peer ever redefines a
    // `(client, clock)` it (or its dependency) has already used, so this can
    // only reject a hostile/corrupt input.
    if content_parity_conflict(
        &candidate_structure.content_units,
        &base_structure.content_units,
    ) || content_parity_conflict(
        &candidate_structure.content_units,
        &pending_structure.content_units,
    ) {
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

/// True when `left` and `right` claim different UTF-16 units at the same
/// `(client, clock)` — a hostile/corrupt redefinition of an id one side
/// already owns.
fn content_parity_conflict(
    left: &BTreeMap<ClientID, BTreeMap<u32, u16>>,
    right: &BTreeMap<ClientID, BTreeMap<u32, u16>>,
) -> bool {
    for (client, units) in left {
        let Some(known) = right.get(client) else {
            continue;
        };
        for (clock, unit) in units {
            if let Some(existing) = known.get(clock) {
                if existing != unit {
                    return true;
                }
            }
        }
    }
    false
}

fn scan_v1(bytes: &[u8]) -> Result<WireStructure, CollabError> {
    Update::decode_v1(bytes).map_err(|error| CollabError::MalformedUpdate {
        reason: error.to_string(),
    })?;
    let mut decoder = DecoderV1::from(bytes);
    let mut structure = WireStructure::default();
    let clients_len: u32 = decoder.read_var().map_err(parity_decode_error)?;
    for _ in 0..clients_len {
        let blocks_len: u32 = decoder.read_var().map_err(parity_decode_error)?;
        let client = decoder.read_client().map_err(parity_decode_error)?;
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
    let deletes = IdSet::decode(&mut decoder).map_err(parity_decode_error)?;
    for (client, ranges) in deletes.iter() {
        for range in ranges {
            structure
                .deletion_boundaries
                .push(ID::new(*client, range.start));
            structure
                .deletion_boundaries
                .push(ID::new(*client, range.end));
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
        let origin = decoder.read_left_id().map_err(parity_decode_error)?;
        let boundary_clock = origin
            .clock
            .checked_add(1)
            .ok_or_else(parity_clock_overflow)?;
        structure
            .insertion_boundaries
            .push(ID::new(origin.client, boundary_clock));
    }
    if has_right_origin {
        structure
            .insertion_boundaries
            .push(decoder.read_right_id().map_err(parity_decode_error)?);
    }
    if !has_origin && !has_right_origin {
        if decoder.read_parent_info().map_err(parity_decode_error)? {
            let _ = decoder.read_string().map_err(parity_decode_error)?;
        } else {
            let _ = decoder.read_left_id().map_err(parity_decode_error)?;
        }
        if info & HAS_PARENT_SUB != 0 {
            let _ = decoder.read_string().map_err(parity_decode_error)?;
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
        BLOCK_ITEM_DELETED_REF_NUMBER => decoder.read_len().map_err(parity_decode_error),
        BLOCK_ITEM_JSON_REF_NUMBER => {
            let len = decoder.read_len().map_err(parity_decode_error)?;
            for _ in 0..len {
                let _ = decoder.read_string().map_err(parity_decode_error)?;
            }
            Ok(len)
        }
        BLOCK_ITEM_BINARY_REF_NUMBER => {
            let _ = decoder.read_buf().map_err(parity_decode_error)?;
            Ok(1)
        }
        BLOCK_ITEM_STRING_REF_NUMBER => {
            let text = decoder.read_string().map_err(parity_decode_error)?;
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
                    structure
                        .content_units
                        .entry(id.client)
                        .or_default()
                        .insert(clock, *unit);
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
            let _ = decoder.read_json().map_err(parity_decode_error)?;
            Ok(1)
        }
        BLOCK_ITEM_FORMAT_REF_NUMBER => {
            let _ = decoder.read_key().map_err(parity_decode_error)?;
            let _ = decoder.read_json().map_err(parity_decode_error)?;
            Ok(1)
        }
        BLOCK_ITEM_TYPE_REF_NUMBER => {
            let _ = TypeRef::decode(decoder).map_err(parity_decode_error)?;
            Ok(1)
        }
        BLOCK_ITEM_ANY_REF_NUMBER => {
            let len = decoder.read_len().map_err(parity_decode_error)?;
            for _ in 0..len {
                let _ = decoder.read_any().map_err(parity_decode_error)?;
            }
            Ok(len)
        }
        BLOCK_ITEM_DOC_REF_NUMBER => {
            let _ = Options::decode(decoder).map_err(parity_decode_error)?;
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
}
