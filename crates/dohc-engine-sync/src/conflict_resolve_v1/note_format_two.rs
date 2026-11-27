use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatTwoConversion {
    Converted,
    NothingToConvert,
    NotNow(&'static str),
    DoesNotFit,
}

pub fn convert_note_to_format_two_in_tx(
    _tx: &Transaction<'_>,
    _key: &DocKey,
    _leases: &dyn LeaseProbe,
    _now_ms: i64,
) -> Result<FormatTwoConversion, SyncError> {
    Ok(FormatTwoConversion::NotNow("not built"))
}
