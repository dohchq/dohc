const claim = "json_extract(payload_json,'$.lineageClaimId')";
/**
 * Matches a `sync_relay_log` Y.Doc update that names a well-formed lineage other than the bound one.
 * Native acknowledges another lineage's base and deltas without applying them. A missing or malformed
 * claim never matches. The byte length check refuses a claim with an embedded NUL, which SQLite's text
 * length() and GLOB stop at.
 */
export const OTHER_LINEAGE_UPDATE = `op_kind='ydoc.update' AND json_type(payload_json,'$.lineageClaimId') IS 'text' AND ${claim} IS NOT ?
  AND length(${claim})=64 AND length(CAST(${claim} AS BLOB))=64 AND ${claim} NOT GLOB '*[^0-9a-f]*'`;
