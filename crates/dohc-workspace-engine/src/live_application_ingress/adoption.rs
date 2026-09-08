use super::*;
use dohc_engine_collab::live_update_application::{LiveUpdateReceipt, OwnerAdoptionCut};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CutHeader {
    relay_database_namespace: String,
    adoption_id: String,
    source_moment_id: String,
    source_digest: String,
    source_byte_length: i64,
    baseline_moment_relay_sequence: i64,
    baseline_registered_at_ms: i64,
    expected_local_sequence: i64,
    terminal_receipt: Option<LiveUpdateReceipt>,
    event_count: usize,
}

fn field<'a>(bytes: &mut &'a [u8]) -> Result<&'a [u8], WireError> {
    let prefix = bytes
        .get(..4)
        .ok_or_else(|| invalid("truncated-owner-adoption"))?;
    let size = u32::from_le_bytes(prefix.try_into().expect("four bytes")) as usize;
    let end = 4usize
        .checked_add(size)
        .ok_or_else(|| invalid("invalid-owner-adoption-length"))?;
    let value = bytes
        .get(4..end)
        .ok_or_else(|| invalid("truncated-owner-adoption"))?;
    *bytes = &bytes[end..];
    Ok(value)
}

/// Length-delimited metadata, original baseline, and ordered metadata/update pairs.
pub(super) fn decode(
    mut bytes: &[u8],
    max_events: usize,
    outbox_limits: dohc_engine_collab::OwnerOutboxLimits,
) -> Result<OwnerAdoptionCut, WireError> {
    let header = field(&mut bytes)?;
    if header.len() > MAX_HEADER_BYTES {
        return Err(invalid("owner-adoption-header-too-large"));
    }
    let header: CutHeader =
        serde_json::from_slice(header).map_err(|_| invalid("invalid-owner-adoption-header"))?;
    if header.event_count > max_events {
        return Err(invalid("owner-adoption-event-limit"));
    }
    let baseline = field(&mut bytes)?;
    if baseline.is_empty() || baseline.len() > MAX_YDOC_UPDATE_BYTES {
        return Err(invalid("owner-adoption-baseline-limit"));
    }
    let mut cut = OwnerAdoptionCut {
        relay_database_namespace: header.relay_database_namespace,
        adoption_id: header.adoption_id,
        source_moment_id: header.source_moment_id,
        source_digest: header.source_digest,
        source_byte_length: header.source_byte_length,
        baseline_moment_relay_sequence: header.baseline_moment_relay_sequence,
        baseline_registered_at_ms: header.baseline_registered_at_ms,
        baseline_bytes: baseline.to_vec(),
        expected_local_sequence: header.expected_local_sequence,
        terminal_receipt: header.terminal_receipt,
        events: Vec::new(),
        outbox_limits,
    };
    for _ in 0..header.event_count {
        let metadata = field(&mut bytes)?;
        let metadata = parse_admitted_metadata(
            serde_json::from_slice(metadata)
                .map_err(|_| invalid("invalid-owner-adoption-event"))?,
        )
        .map_err(|_| invalid("invalid-owner-adoption-event"))?;
        let update = field(&mut bytes)?;
        if update.len() > MAX_YDOC_UPDATE_BYTES {
            return Err(invalid("owner-adoption-update-limit"));
        }
        cut.events.push(AdmittedLiveUpdate {
            metadata,
            update_bytes: update.to_vec(),
        });
    }
    if !bytes.is_empty() {
        return Err(invalid("owner-adoption-trailing-bytes"));
    }
    Ok(cut)
}
