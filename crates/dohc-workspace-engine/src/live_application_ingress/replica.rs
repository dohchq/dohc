use super::*;
use dohc_engine_collab::live_update_application::passive::ReplicaJournalEntry;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Params {
    pub after: i64,
    pub epoch_log_floor: i64,
    pub stream_id: u64,
    pub byte_length: usize,
    pub digest: String,
}

fn field<'a>(bytes: &mut &'a [u8]) -> Result<&'a [u8], WireError> {
    let prefix = bytes
        .get(..4)
        .ok_or_else(|| invalid("truncated replica page"))?;
    let end = 4usize
        .checked_add(u32::from_le_bytes(prefix.try_into().expect("four bytes")) as usize)
        .ok_or_else(|| invalid("replica page length overflow"))?;
    let value = bytes
        .get(4..end)
        .ok_or_else(|| invalid("truncated replica page"))?;
    *bytes = &bytes[end..];
    Ok(value)
}

/// Metadata, then each delivery's update and optional checkpoint as binary
/// spans. A restore cancellation carries no bytes.
pub(super) fn decode(mut bytes: &[u8]) -> Result<Vec<ReplicaJournalEntry>, WireError> {
    let mut rows: Vec<ReplicaJournalEntry> = serde_json::from_slice(field(&mut bytes)?)
        .map_err(|_| invalid("invalid replica page metadata"))?;
    if rows.len() > 500 {
        return Err(invalid("replica page row limit"));
    }
    for row in &mut rows {
        let ReplicaJournalEntry::Update(row) = row else {
            continue;
        };
        if !row.admitted.update_bytes.is_empty()
            || row
                .restore
                .as_ref()
                .is_some_and(|r| !r.checkpoint_bytes.is_empty())
        {
            return Err(invalid("replica bytes must use binary spans"));
        }
        row.admitted.update_bytes = field(&mut bytes)?.to_vec();
        if let Some(restore) = &mut row.restore {
            restore.checkpoint_bytes = field(&mut bytes)?.to_vec();
        }
        row.admitted
            .validate()
            .map_err(|_| invalid("invalid replica admitted update"))?;
    }
    if !bytes.is_empty() {
        return Err(invalid("replica page trailing bytes"));
    }
    Ok(rows)
}
