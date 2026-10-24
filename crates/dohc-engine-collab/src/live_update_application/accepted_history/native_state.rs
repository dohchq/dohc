//! Internal state replay keeps accepted headers and one range, never a proof Vec.
use super::*;
use serde::de::{DeserializeSeed, Error as _, MapAccess, SeqAccess, Visitor};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

#[derive(Default)]
pub(super) struct HashWriter {
    hash: Sha256,
    size: usize,
}
impl HashWriter {
    pub(super) fn finish(self) -> String {
        dohc_engine_storage::hex(&self.hash.finalize())
    }
}
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.size = self
            .size
            .checked_add(bytes.len())
            .ok_or_else(|| std::io::Error::other("evidence length"))?;
        self.hash.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The output allocation is exact: geometric JSON growth is not a second span.
pub(super) fn json(value: &impl Serialize) -> Result<String, ApplicationError> {
    let mut counter = HashWriter::default();
    serde_json::to_writer(&mut counter, value).map_err(|_| ApplicationError::Corrupt)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(counter.size)
        .map_err(|_| ApplicationError::ConfiguredByteBudgetExceeded)?;
    serde_json::to_writer(&mut bytes, value).map_err(|_| ApplicationError::Corrupt)?;
    String::from_utf8(bytes).map_err(|_| ApplicationError::Corrupt)
}

// A corrupt JSON token must not grow Serde's scratch to the whole record size.
// Paths are at most 1024 bytes; six-byte escaping is the largest raw expansion.
const STRING_TOKEN_BYTES: usize = 6 * 1024;
const NUMBER_TOKEN_BYTES: usize = 16;
const CHUNK: usize = NativeHistoryReconstruction::CHUNK_BYTES;

struct SqlJson<R> {
    reader: R,
    length: usize,
    offset: usize,
    chunk: Vec<u8>,
    consumed: usize,
    string: bool,
    escape: bool,
    token: usize,
    number: bool,
}
impl<R: Read> SqlJson<R> {
    fn new(reader: R, length: usize) -> Self {
        Self {
            reader,
            length,
            offset: 0,
            chunk: Vec::new(),
            consumed: 0,
            string: false,
            escape: false,
            token: 0,
            number: false,
        }
    }
    fn check(&mut self, byte: u8) -> std::io::Result<()> {
        if self.string {
            if !self.escape && byte == b'"' {
                self.string = false;
                self.token = 0;
            } else {
                self.token += 1;
                if self.token > STRING_TOKEN_BYTES {
                    return Err(std::io::Error::other("retained JSON string limit"));
                }
                if self.escape {
                    self.escape = false;
                } else if byte == b'\\' {
                    self.escape = true;
                }
            }
        } else if byte == b'"' {
            self.string = true;
            self.number = false;
            self.token = 0;
        } else if byte.is_ascii_digit() || matches!(byte, b'-' | b'+' | b'.' | b'e' | b'E') {
            if !self.number {
                self.token = 0;
                self.number = true;
            }
            self.token += 1;
            if self.token > NUMBER_TOKEN_BYTES {
                return Err(std::io::Error::other("retained JSON number limit"));
            }
        } else {
            self.number = false;
            self.token = 0;
        }
        Ok(())
    }
}
impl<R: Read> Read for SqlJson<R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if self.consumed == self.chunk.len() {
            if self.offset == self.length {
                return Ok(0);
            }
            let expected = (self.length - self.offset).min(CHUNK);
            self.chunk.resize(expected, 0);
            self.reader.read_exact(&mut self.chunk)?;
            self.offset += expected;
            self.consumed = 0;
        }
        let count = output.len().min(self.chunk.len() - self.consumed);
        for (index, target) in output.iter_mut().enumerate().take(count) {
            let byte = self.chunk[self.consumed + index];
            self.check(byte)?;
            *target = byte;
        }
        self.consumed += count;
        Ok(count)
    }
}

struct Ranges<'a> {
    count: Option<usize>,
    writer: &'a mut HashWriter,
}
impl<'de> DeserializeSeed<'de> for Ranges<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for Ranges<'_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("canonical retained firstSeen")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let mut previous = None;
        let mut ordinal = 0;
        while let Some(range) = seq.next_element::<LiveUpdateStructRange>()? {
            if self.count.is_some_and(|count| ordinal >= count) {
                return Err(A::Error::custom("long range array"));
            }
            range
                .validate_after(previous.as_ref())
                .map_err(A::Error::custom)?;
            if ordinal > 0 {
                self.writer.write_all(b",").map_err(A::Error::custom)?;
            }
            serde_json::to_writer(&mut *self.writer, &range).map_err(A::Error::custom)?;
            previous = Some(range);
            ordinal += 1;
        }
        if self.count.is_some_and(|count| ordinal != count) {
            return Err(A::Error::custom("short range array"));
        }
        Ok(())
    }
}
struct Coverage<'a>(&'a mut HashWriter);
impl<'de> DeserializeSeed<'de> for Coverage<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<(), D::Error> {
        de.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for Coverage<'_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("checkpoint author coverage")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let mut count = 0;
        let mut bytes = 2;
        let mut identities = std::collections::BTreeSet::new();
        while let Some(author) = seq.next_element_seed(CoverageEntry {
            writer: &mut *self.0,
            comma: count > 0,
        })? {
            if count == 1024
                || !identities.insert((
                    author.identity().0.to_owned(),
                    author.identity().1.map(str::to_owned),
                    author.identity().2.to_owned(),
                ))
            {
                return Err(A::Error::custom("checkpoint author bound or duplicate"));
            }
            bytes += serde_json::to_vec(&author).map_err(A::Error::custom)?.len()
                + usize::from(count > 0);
            count += 1;
            if bytes > 128 * 1024 {
                return Err(A::Error::custom("checkpoint author byte bound"));
            }
        }
        Ok(())
    }
}
struct CoverageEntry<'a> {
    writer: &'a mut HashWriter,
    comma: bool,
}
impl<'de> DeserializeSeed<'de> for CoverageEntry<'_> {
    type Value = LiveAuthorEntry;
    fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<Self::Value, D::Error> {
        de.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for CoverageEntry<'_> {
    type Value = LiveAuthorEntry;
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("checkpoint author ranges")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        if self.comma {
            self.writer.write_all(b",").map_err(A::Error::custom)?;
        }
        if map.next_key::<String>()?.as_deref() != Some("author") {
            return Err(A::Error::custom("checkpoint author order"));
        }
        let author: LiveAuthorEntry = map.next_value()?;
        author.validate().map_err(A::Error::custom)?;
        self.writer
            .write_all(b"{\"author\":")
            .map_err(A::Error::custom)?;
        serde_json::to_writer(&mut *self.writer, &author).map_err(A::Error::custom)?;
        for field in ["structRanges", "deletionRanges"] {
            if map.next_key::<String>()?.as_deref() != Some(field) {
                return Err(A::Error::custom("checkpoint range order"));
            }
            self.writer
                .write_all(format!(",\"{field}\":[").as_bytes())
                .map_err(A::Error::custom)?;
            map.next_value_seed(Ranges {
                count: None,
                writer: &mut *self.writer,
            })?;
            self.writer.write_all(b"]").map_err(A::Error::custom)?;
        }
        if map.next_key::<String>()?.is_some() {
            return Err(A::Error::custom("unknown checkpoint field"));
        }
        self.writer.write_all(b"}").map_err(A::Error::custom)?;
        Ok(author)
    }
}
struct Snapshot;
impl<'de> DeserializeSeed<'de> for Snapshot {
    type Value = Vec<LiveAuthorEntry>;
    fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<Self::Value, D::Error> {
        de.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for Snapshot {
    type Value = Vec<LiveAuthorEntry>;
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("bounded author snapshot")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut authors = Vec::new();
        while let Some(author) = seq.next_element::<LiveAuthorEntry>()? {
            if authors.len() == 2 {
                return Err(A::Error::custom("snapshot author bound"));
            }
            author.validate().map_err(A::Error::custom)?;
            authors.push(author);
        }
        if authors.len() == 2
            && (matches!(
                authors[0],
                LiveAuthorEntry::Agent { .. } | LiveAuthorEntry::Automation { .. }
            ) || !matches!(authors[1], LiveAuthorEntry::Agent { .. }))
        {
            return Err(A::Error::custom("snapshot author order"));
        }
        Ok(authors)
    }
}

struct Metadata<'a> {
    accepted: &'a RelayAcceptedLiveUpdate,
    count: usize,
    previous: &'a str,
    ordinal: i64,
    canonical_version: Option<u8>,
}
impl<'de> DeserializeSeed<'de> for Metadata<'_> {
    type Value = String;
    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<String, D::Error> {
        deserializer.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for Metadata<'_> {
    type Value = String;
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("retained accepted metadata")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<String, A::Error> {
        let mut writer = HashWriter::default();
        writer
            .write_all(if self.canonical_version == Some(2) {
                b"[\"accepted-event-v2\","
            } else {
                b"[\"accepted-event-v1\","
            })
            .map_err(A::Error::custom)?;
        serde_json::to_writer(&mut writer, self.previous).map_err(A::Error::custom)?;
        writer.write_all(b",").map_err(A::Error::custom)?;
        serde_json::to_writer(&mut writer, &self.ordinal).map_err(A::Error::custom)?;
        writer
            .write_all(b",{\"accepted\":")
            .map_err(A::Error::custom)?;
        serde_json::to_writer(&mut writer, self.accepted).map_err(A::Error::custom)?;
        writer
            .write_all(b",\"firstSeen\":[")
            .map_err(A::Error::custom)?;
        let mut accepted = false;
        let mut ranges = false;
        let mut extension = 0;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "accepted" if !accepted => {
                    let parsed: RelayAcceptedLiveUpdate = map.next_value()?;
                    if parsed != *self.accepted {
                        return Err(A::Error::custom("changed accepted header"));
                    }
                    accepted = true;
                }
                "firstSeen" if !ranges => {
                    map.next_value_seed(Ranges {
                        count: Some(self.count),
                        writer: &mut writer,
                    })?;
                    ranges = true;
                }
                "canonicalVersion"
                    if ranges && self.canonical_version == Some(2) && extension == 0 =>
                {
                    if map.next_value::<u8>()? != 2 {
                        return Err(A::Error::custom("metadata version"));
                    }
                    writer
                        .write_all(b"],\"canonicalVersion\":2")
                        .map_err(A::Error::custom)?;
                    extension = 1;
                }
                "authorSnapshot" if extension == 1 => {
                    let authors = map.next_value_seed(Snapshot)?;
                    writer
                        .write_all(b",\"authorSnapshot\":")
                        .map_err(A::Error::custom)?;
                    serde_json::to_writer(&mut writer, &authors).map_err(A::Error::custom)?;
                    extension = 2;
                }
                "firstSeenDeletes" if extension == 2 => {
                    writer
                        .write_all(b",\"firstSeenDeletes\":[")
                        .map_err(A::Error::custom)?;
                    map.next_value_seed(Ranges {
                        count: None,
                        writer: &mut writer,
                    })?;
                    writer.write_all(b"]").map_err(A::Error::custom)?;
                    extension = 3;
                }
                "checkpointCoverage" if extension == 3 => {
                    writer
                        .write_all(b",\"checkpointCoverage\":[")
                        .map_err(A::Error::custom)?;
                    map.next_value_seed(Coverage(&mut writer))?;
                    writer.write_all(b"]").map_err(A::Error::custom)?;
                    extension = 4;
                }
                _ => return Err(A::Error::custom("unknown or duplicate metadata field")),
            }
        }
        if !accepted || !ranges {
            return Err(A::Error::custom("missing metadata field"));
        }
        if self.canonical_version == Some(2) {
            if extension < 3 {
                return Err(A::Error::custom("missing v2 metadata field"));
            }
            writer.write_all(b"}]").map_err(A::Error::custom)?;
        } else {
            writer.write_all(b"]}]").map_err(A::Error::custom)?;
        }
        Ok(writer.finish())
    }
}

struct RestoreApplication<'a>(Metadata<'a>);
impl<'de> DeserializeSeed<'de> for RestoreApplication<'_> {
    type Value = String;
    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<String, D::Error> {
        deserializer.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for RestoreApplication<'_> {
    type Value = String;
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("native restore application receipt")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<String, A::Error> {
        let mut seen = 0u8;
        let mut evidence = None;
        let mut metadata = Some(self.0);
        while let Some(key) = map.next_key::<String>()? {
            let bit = match key.as_str() {
                "fence" => 1,
                "candidateDigest" => 2,
                "nativeSourceManifestDigest" => 4,
                "admitted" => 8,
                "localHeadSequence" => 16,
                "hostCoordinate" => 32,
                "recordedAtMs" => 64,
                _ => return Err(A::Error::custom("unknown restore application field")),
            };
            if seen & bit != 0 {
                return Err(A::Error::custom("duplicate restore application field"));
            }
            seen |= bit;
            if bit == 8 {
                evidence = Some(
                    map.next_value_seed(
                        metadata
                            .take()
                            .ok_or_else(|| A::Error::custom("duplicate admitted field"))?,
                    )?,
                );
            } else {
                map.next_value::<serde::de::IgnoredAny>()?;
            }
        }
        if seen != 127 {
            return Err(A::Error::custom("missing restore application field"));
        }
        evidence.ok_or_else(|| A::Error::custom("missing admitted field"))
    }
}

pub(super) struct NativeMetadata {
    pub accepted: RelayAcceptedLiveUpdate,
    pub evidence_digest: String,
    pub canonical_version: Option<u8>,
    pub checkpoint_coverage: bool,
}
fn parse(
    conn: &Connection,
    table: &str,
    expression: &str,
    source: String,
    parameters: Vec<&dyn rusqlite::ToSql>,
    previous: &str,
    ordinal: i64,
) -> Result<NativeMetadata, ApplicationError> {
    let application = expression == "application_json";
    let prefix = if application { "$.admitted" } else { "$" };
    let facts = format!(
        "SELECT rowid,length(CAST({expression} AS BLOB)),json_array_length({expression},'{prefix}.firstSeen'),length(CAST(json_extract({expression},'{prefix}.accepted') AS BLOB)),json_extract({expression},'{prefix}.canonicalVersion'),json_type({expression},'{prefix}.checkpointCoverage'),coalesce(json_array_length({expression},'{prefix}.firstSeenDeletes'),0)+coalesce((SELECT sum(coalesce(json_array_length(value,'$.structRanges'),0)+coalesce(json_array_length(value,'$.deletionRanges'),0)) FROM json_each({expression},'{prefix}.checkpointCoverage')),0) {source}"
    );
    let (rowid, length, count, header, canonical_version, coverage, extra_ranges): (
        i64,
        i64,
        i64,
        i64,
        Option<u8>,
        Option<String>,
        i64,
    ) = conn
        .query_row(&facts, parameters.as_slice(), |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })
        .map_err(read_sql)?;
    let length = usize::try_from(length).map_err(|_| ApplicationError::Corrupt)?;
    let count = usize::try_from(count).map_err(|_| ApplicationError::Corrupt)?;
    // Adoption's separately admitted proof can have more ranges than ordinary
    // ingress. Stream them too: no universal smaller after-acceptance range cap.
    // The stored byte length bounds count and the canonical 76-byte range bound
    // bounds raw metadata; no range-count-sized allocation is made.
    let limit = count
        .checked_add(usize::try_from(extra_ranges).map_err(|_| ApplicationError::Corrupt)?)
        .and_then(|n| n.checked_mul(76))
        .and_then(|n| {
            n.checked_add(
                NativeHistoryReconstruction::HEADER_BYTES * (if application { 2 } else { 1 })
                    + 128 * 1024
                    + 32,
            )
        })
        .ok_or(ApplicationError::Corrupt)?;
    if (canonical_version.is_some() && canonical_version != Some(2))
        || coverage.as_ref().is_some_and(|kind| kind != "array")
        || length == 0
        || length > limit
        || count > length / 2
        || header < 0
        || header as usize > NativeHistoryReconstruction::HEADER_BYTES
    {
        return Err(ApplicationError::Corrupt);
    }
    let accepted: RelayAcceptedLiveUpdate = conn
        .query_row(
            &format!("SELECT json_extract({expression},'{prefix}.accepted') {source}"),
            parameters.as_slice(),
            |r| {
                let bytes = r.get_ref(0)?.as_str()?.as_bytes();
                Ok(if bytes.len() != header as usize {
                    Err(ApplicationError::Corrupt)
                } else {
                    serde_json::from_reader(SqlJson::new(bytes, bytes.len()))
                        .map_err(|_| ApplicationError::Corrupt)
                })
            },
        )
        .map_err(read_sql)??;
    accepted.validate().map_err(|_| ApplicationError::Corrupt)?;
    let evidence_digest = if application {
        // SQLite rejects incremental handles on tables with generated columns.
        // Borrow its value for one parse; never re-query the whole JSON per chunk.
        conn.query_row(
            &format!("SELECT {expression} {source}"),
            parameters.as_slice(),
            |r| {
                let bytes = r.get_ref(0)?.as_str()?.as_bytes();
                Ok(if bytes.len() != length {
                    Err(ApplicationError::Corrupt)
                } else {
                    parse_evidence(
                        SqlJson::new(bytes, length),
                        &accepted,
                        count,
                        previous,
                        ordinal,
                        true,
                        canonical_version,
                    )
                })
            },
        )
        .map_err(read_sql)??
    } else {
        // The incremental API accepts TEXT columns as raw bytes too.
        let blob = conn
            .blob_open("main", table, expression, rowid, true)
            .map_err(read_sql)?;
        if blob.len() != length {
            return Err(ApplicationError::Corrupt);
        }
        parse_evidence(
            SqlJson::new(blob, length),
            &accepted,
            count,
            previous,
            ordinal,
            false,
            canonical_version,
        )?
    };
    Ok(NativeMetadata {
        accepted,
        evidence_digest,
        canonical_version,
        checkpoint_coverage: coverage.is_some(),
    })
}

fn parse_evidence(
    reader: impl Read,
    accepted: &RelayAcceptedLiveUpdate,
    count: usize,
    previous: &str,
    ordinal: i64,
    application: bool,
    canonical_version: Option<u8>,
) -> Result<String, ApplicationError> {
    let mut de = serde_json::Deserializer::from_reader(reader);
    let metadata = Metadata {
        accepted,
        count,
        previous,
        ordinal,
        canonical_version,
    };
    let evidence_digest = if application {
        RestoreApplication(metadata).deserialize(&mut de)
    } else {
        metadata.deserialize(&mut de)
    }
    .map_err(|_| ApplicationError::Corrupt)?;
    de.end().map_err(|_| ApplicationError::Corrupt)?;
    Ok(evidence_digest)
}

pub(super) fn metadata(
    conn: &Connection,
    held: &Registration,
    count: i64,
) -> Result<NativeMetadata, ApplicationError> {
    let p = parameters(held);
    let previous = if count == 1 {
        initial_digest(&held.namespace, &held.binding)?
    } else {
        conn.query_row(&format!("SELECT evidence_digest FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6 AND length(CAST(evidence_digest AS BLOB))=64"),params![p[0],p[1],p[2],p[3],p[4],count-1],|r|r.get::<_,String>(0)).map_err(read_sql)?
    };
    digest(&previous)?;
    let result = parse(
        conn,
        "live_accepted_updates",
        "metadata_json",
        format!("FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6"),
        vec![&p[0], &p[1], &p[2], &p[3], &p[4], &count],
        &previous,
        count,
    )?;
    require_document(held, &result.accepted.binding)?;
    let (cursor,delivery,update,expected):(i64,String,String,String)=conn.query_row(
        &format!("SELECT journal_cursor,delivery_id,update_sha256,evidence_digest FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6 AND length(CAST(delivery_id AS BLOB))<=512 AND length(CAST(update_sha256 AS BLOB))=64 AND length(CAST(evidence_digest AS BLOB))=64"),
        params![p[0],p[1],p[2],p[3],p[4],count],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(read_sql)?;
    if result.accepted.receipt.journal_cursor != cursor
        || result.accepted.receipt.delivery_id != delivery
        || result.accepted.receipt.update_digest != update
        || result.evidence_digest != expected
    {
        return Err(ApplicationError::Corrupt);
    }
    // Cut/adoption history has no native application rows. When one exists,
    // require its retained document, receipt, generation and count association.
    let association:Option<bool>=conn.query_row(
        "SELECT workspace_id=?3 AND main_version_id=?4 AND object_id=?5 AND lineage_claim_id=?6 AND restore_fence_generation=?7 AND update_digest=?8 AND journal_cursor=?9 AND accepting_host_epoch=?10 AND first_seen_count=(SELECT json_array_length(metadata_json,'$.firstSeen') FROM live_accepted_updates WHERE relay_database_namespace=?1 AND delivery_id=?2) AND update_byte_length=(SELECT byte_length FROM binary_blobs WHERE sha256=?8) FROM live_device_update_applications WHERE relay_database_namespace=?1 AND delivery_id=?2",
        params![held.namespace,delivery,held.binding.workspace_id,held.binding.main_version_id,held.binding.object_id,held.binding.lineage_claim_id,result.accepted.binding.restore_fence_generation,update,cursor,result.accepted.receipt.accepting_host_epoch],|r|r.get(0)).optional().map_err(read_sql)?;
    if association == Some(false) {
        return Err(ApplicationError::Corrupt);
    }
    Ok(result)
}

pub(super) fn restore_association(
    conn: &Connection,
    held: &Registration,
    id: &str,
    next: &RelayAcceptedLiveUpdate,
    previous_generation: Option<i64>,
    state_digest: Option<&str>,
) -> Result<(), ApplicationError> {
    identifier(id, 512)?;
    let b = &next.binding;
    let (old, generation, accepted, candidate, content):(i64,i64,String,String,String)=conn.query_row(
        "SELECT old_generation,new_generation,json_extract(application_json,'$.admitted.accepted'),proposal_candidate_sha256,json_extract(proposal_json,'$.finalContentDigest') FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2 AND workspace_id=?3 AND main_version_id=?4 AND object_id=?5 AND application_delivery_id=?6 AND EXISTS(SELECT 1 FROM live_device_update_applications a WHERE a.relay_database_namespace=?1 AND a.delivery_id=?6) AND json_extract(input_json,'$.operationId')=?2 AND json_extract(input_json,'$.relayDatabaseNamespace')=?1 AND json_extract(input_json,'$.oldBinding')=json_extract(application_json,'$.fence.operation.oldBinding') AND json_extract(input_json,'$.newFence')=json_extract(application_json,'$.fence.operation.newFence') AND json_extract(application_json,'$.fence.operation.operationId')=?2 AND json_extract(application_json,'$.fence.operation.oldBinding.workspaceId')=?3 AND json_extract(application_json,'$.fence.operation.oldBinding.mainVersionId')=?4 AND json_extract(application_json,'$.fence.operation.oldBinding.objectId')=?5 AND json_extract(application_json,'$.fence.operation.oldBinding.lineageClaimId')=?7 AND json_extract(application_json,'$.fence.operation.oldBinding.restoreFenceGeneration')=old_generation AND json_extract(application_json,'$.fence.operation.newFence')=new_generation AND json_extract(application_json,'$.candidateDigest')=proposal_candidate_sha256 AND length(CAST(proposal_candidate_sha256 AS BLOB))=64 AND length(CAST(json_extract(proposal_json,'$.finalContentDigest') AS BLOB))=64 AND length(CAST(json_extract(application_json,'$.admitted.accepted') AS BLOB))<=?8",
        params![held.namespace,id,b.workspace_id,b.main_version_id,b.object_id,next.receipt.delivery_id,b.lineage_claim_id,NativeHistoryReconstruction::HEADER_BYTES as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(read_sql)?;
    let saved: RelayAcceptedLiveUpdate =
        serde_json::from_str(&accepted).map_err(|_| ApplicationError::Corrupt)?;
    digest(&candidate)?;
    digest(&content)?;
    if saved != *next
        || old < 0
        || old.checked_add(1) != Some(generation)
        || generation != b.restore_fence_generation
        || previous_generation.is_some_and(|previous| previous != old)
        || candidate != next.receipt.update_digest
        || !matches!(
            next.authority,
            ServerDerivedLiveUpdateAuthority::Owner { .. }
        )
    {
        return Err(ApplicationError::Corrupt);
    }
    // The same transaction committed this public checkpoint and the prepared
    // final content digest. Reopen only the checkpoint, not its old proof blobs.
    if let Some(state) = state_digest {
        let mut budget = restore_content::Budget {
            remaining: crate::limits::MAX_YDOC_UPDATE_BYTES,
        };
        let bytes = budget.blob(conn, state)?;
        let doc = Ydoc::wire();
        doc.apply(&bytes)?;
        doc.validate_public_baseline(&bytes)?;
        if doc.canonical_content_sha256() != content {
            return Err(ApplicationError::Corrupt);
        }
    }
    Ok(())
}

pub(super) fn restore_metadata(
    conn: &Connection,
    held: &Registration,
    id: &str,
    count: i64,
    evidence: &str,
) -> Result<(), ApplicationError> {
    let p = parameters(held);
    let previous = if count == 1 {
        initial_digest(&held.namespace, &held.binding)?
    } else {
        conn.query_row(&format!("SELECT evidence_digest FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6 AND length(CAST(evidence_digest AS BLOB))=64"),params![p[0],p[1],p[2],p[3],p[4],count-1],|r|r.get(0)).map_err(read_sql)?
    };
    let saved=parse(conn,"live_restore_fences","application_json","FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2 AND workspace_id=?3 AND main_version_id=?4 AND object_id=?5".into(),vec![&p[0],&id,&p[1],&p[2],&p[3]],&previous,count)?;
    if saved.evidence_digest != evidence {
        return Err(ApplicationError::Corrupt);
    }
    Ok(())
}

/// [`super::require_transition`] for native state: a restore's application,
/// after any restores cancelled at `tip`, or the first event after them.
pub(super) fn transition(
    conn: &Connection,
    held: &Registration,
    previous: &LiveObjectBinding,
    tip: &Tip<'_>,
    next: &RelayAcceptedLiveUpdate,
    evidence: &str,
) -> Result<(), ApplicationError> {
    let from = previous.restore_fence_generation;
    if from == next.binding.restore_fence_generation {
        return Ok(());
    }
    let fence:Option<(String,i64)>=conn.query_row("SELECT operation_id,old_generation FROM live_restore_fences WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND application_delivery_id=?5",params![held.namespace,held.binding.workspace_id,held.binding.main_version_id,held.binding.object_id,next.receipt.delivery_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(read_sql)?;
    let Some((id, fenced)) = fence else {
        return restore_fence::require_cancelled(
            conn,
            held,
            from,
            next.binding.restore_fence_generation,
            tip,
        );
    };
    if fenced != from {
        restore_fence::require_cancelled(conn, held, from, fenced, tip)?;
    }
    restore_association(conn, held, &id, next, Some(fenced), None)?;
    let p = parameters(held);
    let saved=parse(conn,"live_restore_fences","application_json","FROM live_restore_fences WHERE relay_database_namespace=?1 AND operation_id=?2 AND workspace_id=?3 AND main_version_id=?4 AND object_id=?5".into(),vec![&p[0],&id,&p[1],&p[2],&p[3]],tip.evidence,tip.count+1)?;
    if saved.accepted != *next || saved.evidence_digest != evidence {
        return Err(ApplicationError::Corrupt);
    }
    Ok(())
}

pub(super) fn validate_blob_hash(conn: &Connection, digest: &str) -> Result<(), ApplicationError> {
    let (rowid, declared, actual): (i64, i64, i64) = conn
        .query_row(
            "SELECT rowid,byte_length,length(bytes) FROM binary_blobs WHERE sha256=?1",
            [digest],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(read_sql)?;
    if declared != actual || !(1..=crate::limits::MAX_YDOC_UPDATE_BYTES as i64).contains(&actual) {
        return Err(ApplicationError::Corrupt);
    };
    let mut hash = Sha256::new();
    let mut blob = conn
        .blob_open("main", "binary_blobs", "bytes", rowid, true)
        .map_err(read_sql)?;
    if blob.len() != actual as usize {
        return Err(ApplicationError::Corrupt);
    }
    let mut chunk = vec![0; CHUNK];
    let mut offset = 0usize;
    while offset < actual as usize {
        let count = (actual as usize - offset).min(CHUNK);
        blob.read_exact(&mut chunk[..count])
            .map_err(|_| ApplicationError::Corrupt)?;
        hash.update(&chunk[..count]);
        offset += count;
    }
    if dohc_engine_storage::hex(&hash.finalize()) != digest {
        return Err(ApplicationError::Corrupt);
    };
    Ok(())
}

/// Accepted state through `through`. Each blob it replays is charged to
/// `budget` before it is read, on top of each record's own bound.
pub(super) fn read(
    conn: &Connection,
    held: &Registration,
    through: i64,
    policy: NativeHistoryReconstruction,
    budget: &mut restore_content::Budget,
) -> Result<Ydoc, ApplicationError> {
    if policy.working_reserve_bytes == 0 || policy.reservation_bytes().is_none() {
        return Err(ApplicationError::ConfiguredByteBudgetExceeded);
    }
    let c = checkpoint_in(
        conn,
        held,
        through,
        &mut restore_content::Budget {
            remaining: usize::MAX,
        },
        CheckpointRead::NativeState {
            verify_cadence: true,
        },
    )?;
    let doc = Ydoc::wire();
    {
        let baseline = budget.blob(conn, &c.state_digest)?;
        doc.apply(&baseline)?;
        validate_baseline(&doc, &baseline)?;
    }
    let p = parameters(held);
    let mut query=conn.prepare(&format!("SELECT event_count,journal_cursor,update_sha256,suffix_count,suffix_bytes FROM live_accepted_updates WHERE {DOCUMENT} AND event_count>?6 AND journal_cursor<=?7 AND length(CAST(update_sha256 AS BLOB))=64 ORDER BY event_count LIMIT 4096")).map_err(read_sql)?;
    let mut rows = query
        .query(params![
            p[0],
            p[1],
            p[2],
            p[3],
            p[4],
            c.event_count,
            through
        ])
        .map_err(read_sql)?;
    let mut count = c.event_count;
    let mut cursor = c.terminal.as_ref().map_or(0, |r| r.journal_cursor);
    let mut terminal = c.terminal;
    let mut evidence = c.evidence_digest;
    let mut binding = c.binding;
    let mut bytes = 0;
    let mut canonical_version = c.canonical_version;
    while let Some(row) = rows.next().map_err(read_sql)? {
        if count - c.event_count >= CHECKPOINT_EVENTS || bytes >= CHECKPOINT_BYTES {
            return Err(ApplicationError::Corrupt);
        }
        let ordinal: i64 = row.get(0).map_err(read_sql)?;
        let next_cursor: i64 = row.get(1).map_err(read_sql)?;
        let update: String = row.get(2).map_err(read_sql)?;
        if ordinal != count + 1 || next_cursor <= cursor {
            return Err(ApplicationError::Corrupt);
        }
        let metadata = metadata(conn, held, ordinal)?;
        if canonical_version == Some(2) && metadata.canonical_version != Some(2) {
            return Err(ApplicationError::Corrupt);
        }
        canonical_version = metadata.canonical_version;
        // metadata() also hashes against the preceding retained row. Bind it to
        // this replay's validated checkpoint/suffix chain explicitly.
        let previous: String = if ordinal == 1 {
            initial_digest(&held.namespace, &held.binding)?
        } else {
            conn.query_row(&format!("SELECT evidence_digest FROM live_accepted_updates WHERE {DOCUMENT} AND event_count=?6 AND length(CAST(evidence_digest AS BLOB))=64"),params![p[0],p[1],p[2],p[3],p[4],ordinal-1],|r|r.get(0)).map_err(read_sql)?
        };
        if previous != evidence
            || metadata.accepted.receipt.journal_cursor != next_cursor
            || metadata.accepted.receipt.update_digest != update
        {
            return Err(ApplicationError::Corrupt);
        }
        transition(
            conn,
            held,
            &binding,
            &Tip {
                terminal: terminal.as_ref(),
                count,
                evidence: &evidence,
            },
            &metadata.accepted,
            &metadata.evidence_digest,
        )?;
        {
            let update = budget.blob(conn, &update)?;
            if update.is_empty() {
                return Err(ApplicationError::Corrupt);
            }
            doc.apply(&update)?;
            bytes += update.len() as i64;
        }
        if row.get::<_, i64>(3).map_err(read_sql)? != ordinal - c.event_count
            || row.get::<_, i64>(4).map_err(read_sql)? != bytes
        {
            return Err(ApplicationError::Corrupt);
        }
        count = ordinal;
        cursor = next_cursor;
        evidence = metadata.evidence_digest;
        binding = metadata.accepted.binding;
        terminal = Some(metadata.accepted.receipt);
    }
    if cursor != through || doc.has_missing_updates() {
        return Err(ApplicationError::Conflict);
    }
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn count_reads(conn: &Connection) -> Arc<AtomicUsize> {
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        conn.authorizer(Some(move |context: AuthContext<'_>| {
            if matches!(context.action, AuthAction::Select) {
                observed.fetch_add(1, Ordering::Relaxed);
            }
            Authorization::Allow
        }))
        .unwrap();
        count
    }

    fn read_json(json: &str, previous: &str) -> Result<NativeMetadata, ApplicationError> {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE metadata(json TEXT)")
            .unwrap();
        conn.execute("INSERT INTO metadata VALUES (?1)", [json])
            .unwrap();
        let count = count_reads(&conn);
        let result = parse(
            &conn,
            "metadata",
            "json",
            "FROM metadata".into(),
            vec![],
            previous,
            1,
        );
        assert!(
            count.load(Ordering::Relaxed) <= 3,
            "queries must not grow with chunks"
        );
        result
    }

    #[test]
    fn streamed_metadata_matches_vectors_reordered_fields_and_chunk_boundaries() {
        let vectors:Value=serde_json::from_str(include_str!("../../../../../packages/live-session-contract/vectors/live-update-admission-vectors.json")).unwrap();
        for row in vectors["acceptedHistoryDigests"].as_array().unwrap() {
            let expected = parse_admitted_metadata(row["metadata"].clone()).unwrap();
            let previous = row["initialDigest"].as_str().unwrap();
            // Use a count-1 digest independent of each vector's ordinal.
            let digest = next_digest(previous, 1, &expected).unwrap();
            let canonical = serde_json::to_string(&expected).unwrap();
            assert_eq!(
                read_json(&canonical, previous).unwrap().evidence_digest,
                digest
            );
            if expected.canonical_version.is_none() {
                let reordered = format!(
                    "{{\"firstSeen\":{},\"accepted\":{}}}",
                    serde_json::to_string(&expected.first_seen).unwrap(),
                    serde_json::to_string(&expected.accepted).unwrap()
                );
                assert_eq!(
                    read_json(&reordered, previous).unwrap().evidence_digest,
                    digest
                );
            }
        }
        let mut accepted: RelayAcceptedLiveUpdate =
            serde_json::from_str(super::super::tests::ACCEPTED_COMPLETE).unwrap();
        accepted
            .binding
            .selector_paths
            .extend((0..99).map(|i| format!("z{i:02}{}", "é".repeat(500))));
        accepted.binding.selector_paths.sort();
        let first_seen = (0..60000)
            .map(|client_id| LiveUpdateStructRange {
                client_id,
                start_clock: 0,
                end_clock: 1,
            })
            .collect();
        let metadata = AdmittedLiveUpdateMetadata {
            accepted,
            first_seen,
            canonical_version: Some(2),
            author_snapshot: Some(vec![LiveAuthorEntry::Agent {
                agent_id: "旅行-agent".into(),
                agent_name: Some("Trip helper".into()),
                on_behalf_of: Some("owner".into()),
                depth: Some(1),
            }]),
            first_seen_deletes: Some(vec![LiveUpdateStructRange {
                client_id: 9,
                start_clock: 0,
                end_clock: 1,
            }]),
            checkpoint_coverage: Some(vec![LiveCheckpointAuthorCoverage {
                author: LiveAuthorEntry::Human {
                    human_id: "owner".into(),
                    human_name: "Owner".into(),
                },
                struct_ranges: vec![LiveUpdateStructRange {
                    client_id: 1,
                    start_clock: 0,
                    end_clock: 1,
                }],
                deletion_ranges: vec![],
            }]),
        };
        let json = serde_json::to_string(&metadata).unwrap();
        assert!(json.len() > 10 * CHUNK);
        assert_eq!(
            read_json(&json, &"0".repeat(64)).unwrap().evidence_digest,
            next_digest(&"0".repeat(64), 1, &metadata).unwrap()
        );
    }

    #[test]
    fn streamed_metadata_refuses_duplicates_unknown_fields_tokens_and_ranges() {
        let accepted = super::super::tests::ACCEPTED_COMPLETE;
        let previous = "0".repeat(64);
        for json in [
            format!("{{\"accepted\":{accepted},\"accepted\":{accepted},\"firstSeen\":[]}}"),
            format!("{{\"accepted\":{accepted},\"firstSeen\":[],\"other\":0}}"),
            format!("{{\"accepted\":{accepted},\"firstSeen\":[],\"firstSeen\":[]}}"),
            format!(
                "{{\"accepted\":{accepted},\"firstSeen\":[{{\"clientId\":1,\"startClock\":1,\"endClock\":1}}]}}"
            ),
            format!(
                "{{\"accepted\":{accepted},\"firstSeen\":[{{\"clientId\":2,\"startClock\":0,\"endClock\":1}},{{\"clientId\":1,\"startClock\":0,\"endClock\":1}}]}}"
            ),
            format!("{{\"accepted\":{accepted},\"firstSeen\":[]}} garbage"),
            format!(
                "{{\"accepted\":{},\"firstSeen\":[]}}",
                accepted.replace("delivery-1", &"x".repeat(STRING_TOKEN_BYTES + 1))
            ),
            format!(
                "{{\"accepted\":{},\"firstSeen\":[]}}",
                accepted.replace("receivedAtMs\":10", "receivedAtMs\":10000000000000000")
            ),
        ] {
            assert!(read_json(&json, &previous).is_err(), "{json}");
        }
    }

    #[test]
    fn retained_chunk_reader_refuses_short_reads_and_keeps_escape_state() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE metadata(json TEXT)")
            .unwrap();
        conn.execute("INSERT INTO metadata VALUES ('[]')", [])
            .unwrap();
        let blob = conn.blob_open("main", "metadata", "json", 1, true).unwrap();
        let mut reader = SqlJson::new(blob, 3);
        assert!(reader.read(&mut [0; 4]).is_err());
        drop(reader);
        let json = format!("[{}\"🦀\\\"é\"]", " ".repeat(CHUNK - 3));
        conn.execute("UPDATE metadata SET json=?1", [&json])
            .unwrap();
        let blob = conn.blob_open("main", "metadata", "json", 1, true).unwrap();
        let reader = SqlJson::new(blob, json.len());
        let parsed: Vec<String> = serde_json::from_reader(reader).unwrap();
        assert_eq!(parsed, vec!["🦀\"é"]);
    }

    #[test]
    fn restore_json_with_generated_columns_uses_constant_queries_and_bounded_tokens() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE restores(application_json TEXT, generation INTEGER GENERATED ALWAYS AS (json_extract(application_json,'$.fence.generation')) VIRTUAL)").unwrap();
        let accepted: RelayAcceptedLiveUpdate =
            serde_json::from_str(super::super::tests::ACCEPTED_COMPLETE).unwrap();
        let metadata = AdmittedLiveUpdateMetadata {
            accepted,
            first_seen: (0..60000)
                .map(|client_id| LiveUpdateStructRange {
                    client_id,
                    start_clock: 0,
                    end_clock: 1,
                })
                .collect(),

            canonical_version: None,

            author_snapshot: None,

            first_seen_deletes: None,

            checkpoint_coverage: None,
        };
        let application = serde_json::json!({
            "fence": {"generation": 1}, "candidateDigest": "0".repeat(64),
            "nativeSourceManifestDigest": "0".repeat(64), "admitted": metadata,
            "localHeadSequence": 1, "hostCoordinate": {}, "recordedAtMs": 1,
        });
        let json = serde_json::to_string(&application).unwrap();
        assert!(json.len() > 10 * CHUNK);
        conn.execute(
            "INSERT INTO restores(application_json) VALUES (?1)",
            [&json],
        )
        .unwrap();
        assert!(conn
            .blob_open("main", "restores", "application_json", 1, true)
            .is_err());
        let queries = count_reads(&conn);
        let previous = "0".repeat(64);
        let parsed = parse(
            &conn,
            "restores",
            "application_json",
            "FROM restores".into(),
            vec![],
            &previous,
            1,
        )
        .unwrap();
        assert_eq!(
            parsed.evidence_digest,
            next_digest(&previous, 1, &metadata).unwrap()
        );
        assert!(
            queries.load(Ordering::Relaxed) <= 4,
            "three statements plus the coverage subquery, independent of chunks"
        );
        for token in [
            serde_json::json!("x".repeat(STRING_TOKEN_BYTES + 1)),
            serde_json::json!(10000000000000000_u64),
        ] {
            let mut damaged = application.clone();
            // Ignored restore fields still pass through the token guard.
            damaged["hostCoordinate"] = token;
            conn.execute(
                "UPDATE restores SET application_json=?1",
                [damaged.to_string()],
            )
            .unwrap();
            assert!(parse(
                &conn,
                "restores",
                "application_json",
                "FROM restores".into(),
                vec![],
                &previous,
                1
            )
            .is_err());
        }
    }

    #[test]
    fn incremental_blob_hash_checks_length_and_content_without_chunk_queries() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE binary_blobs(sha256 TEXT PRIMARY KEY, byte_length INTEGER, bytes BLOB)",
        )
        .unwrap();
        let bytes = vec![42; 12 * CHUNK + 17];
        let digest = hex_sha256(&bytes);
        conn.execute(
            "INSERT INTO binary_blobs VALUES (?1,?2,?3)",
            params![digest, bytes.len() as i64, bytes],
        )
        .unwrap();
        let queries = count_reads(&conn);
        validate_blob_hash(&conn, &digest).unwrap();
        assert!(queries.load(Ordering::Relaxed) <= 2);
        conn.execute("UPDATE binary_blobs SET byte_length=byte_length+1", [])
            .unwrap();
        assert!(validate_blob_hash(&conn, &digest).is_err());
        conn.execute(
            "UPDATE binary_blobs SET byte_length=byte_length-1,bytes=zeroblob(length(bytes))",
            [],
        )
        .unwrap();
        assert!(validate_blob_hash(&conn, &digest).is_err());
    }
}
