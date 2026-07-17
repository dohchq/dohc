//! Structural Yjs-v1 replay-parity gate.
//!
//! yrs stores Rust `String`s but addresses text in Yjs-compatible UTF-16 clock
//! units. Its UTF-16 splitter rounds an index inside an astral scalar to the
//! scalar's UTF-8 boundary; Yjs instead exposes the two surrogate units. A
//! candidate whose insertion/deletion boundary names that interior clock can
//! therefore replay to different content despite being a valid update.
//!
//! The public `Update` API does not expose item origins in yrs 0.27.3, so this
//! gate walks the v1 wire with yrs' own public `DecoderV1` primitives. It first
//! lets `Update::decode_v1` validate the whole update, then applies the candidate
//! to a scratch clone with the durable base's parked updates restored. Every
//! newly integrated edit boundary is checked against the full resulting scalar
//! structure. Finally, dependency-complete replay must either integrate or park
//! every clock claimed by the candidate. The live/durable document is never
//! mutated.

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
}

/// Reject a valid v1 update whose structural edit boundaries cannot replay
/// identically between Yjs' UTF-16 strings and yrs' Rust strings.
pub fn validate_replay_parity(base: &Ydoc, candidate: &[u8]) -> Result<(), CollabError> {
    Ydoc::validate_update(candidate)?;
    let base_full = base.encode_full_state();
    let base_integrated_sv = base.encode_state_vector();

    let scratch = Ydoc::wire();
    scratch.apply(&base_full)?;
    if let Some(pending) = base.pending_update_v1() {
        scratch.apply(&pending)?;
    }
    scratch.apply(candidate)?;

    let delta = scratch.diff(&base_integrated_sv)?;
    let delta_structure = scan_v1(&delta)?;
    let scratch_full = scratch.encode_full_state();
    let scratch_structure = scan_v1(&scratch_full)?;
    let unsafe_boundary = delta_structure
        .insertion_boundaries
        .iter()
        .chain(delta_structure.deletion_boundaries.iter())
        .any(|boundary| scratch_structure.unsafe_boundaries.contains(boundary));
    if unsafe_boundary {
        // Rejecting the dependency apply leaves the divergent parked edit quarantined.
        return Err(CollabError::ReplayParityViolation {
            reason: "an edit boundary lands inside a multi-unit Unicode scalar".to_owned(),
        });
    }

    let candidate_structure = scan_v1(candidate)?;
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
                let units = scalar.len_utf16() as u32;
                for interior in 1..units {
                    let clock = id
                        .clock
                        .checked_add(offset)
                        .and_then(|value| value.checked_add(interior))
                        .ok_or_else(parity_clock_overflow)?;
                    structure
                        .unsafe_boundaries
                        .insert(ID::new(id.client, clock));
                }
                offset = offset
                    .checked_add(units)
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
