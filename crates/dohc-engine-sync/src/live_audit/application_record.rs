use super::chunks::{ChunkReader, ChunkWriter, Manifest};
use super::*;
use dohc_engine_collab::live_update_application::{
    AdmittedLiveUpdateMetadata, ApplicationHostCoordinate, LiveAuthorEntry,
    LiveCheckpointAuthorCoverage, LiveUpdateReceipt, LiveUpdateStructRange, MAX_CANCELLED_RESTORES,
    NativeRestoreCancellationReceipt, RelayAcceptedLiveUpdate, RetainedPrefixBody,
    validate_checkpoint_coverage,
};
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use std::cell::RefCell;
use std::fmt;
use std::io::{BufReader, Write};

pub(super) const EVENT_OP: &str = "live.audit.application";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    kind: String,
    relay_database_namespace: String,
    event_count: i64,
    evidence_digest: String,
    update_byte_length: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceApplication {
    #[serde(rename = "localYDocSequence")]
    local_ydoc_sequence: i64,
    host_coordinate: ApplicationHostCoordinate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Suffix {
    source_application: Option<SourceApplication>,
    source_restore: Option<restore_record::RestoreSource>,
    /// The restores cancelled after their fences that carried the lineage
    /// from the event before's generation to this event's, or to the
    /// generation its restore fenced from.
    cancelled_restores: Vec<CancelledRestore>,
    content_coordinate: BaseCoordinate,
}

/// A restore cancelled after its fence, and the origin adoption of the owner
/// activation that fenced it, when one did. A successor fences under its own
/// ID and host; the source checked them against that activation, current at
/// the generation it fenced from, before it exported this.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelledRestore {
    origin_adoption_id: Option<String>,
    cancellation: NativeRestoreCancellationReceipt,
}

/// The cancellations an event crosses, bounded while they parse.
struct CancelledRestores(Vec<CancelledRestore>);

impl<'de> Deserialize<'de> for CancelledRestores {
    fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        struct Bounded;
        impl<'de> Visitor<'de> for Bounded {
            type Value = CancelledRestores;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("the restore cancellations one event crosses")
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                let mut chain = Vec::new();
                while let Some(cancelled) = sequence.next_element()? {
                    if chain.len() == MAX_CANCELLED_RESTORES {
                        return Err(serde::de::Error::custom(
                            "live audit cancellations exceed one event's crossing",
                        ));
                    }
                    chain.push(cancelled);
                }
                Ok(CancelledRestores(chain))
            }
        }
        decoder.deserialize_seq(Bounded)
    }
}

struct ParsedRecord {
    header: Header,
    accepted: RelayAcceptedLiveUpdate,
    suffix: Suffix,
    canonical_digest: String,
    canonical_version: u8,
    authors: dohc_engine_collab::author_coverage::Authors,
}

struct ParsedMetadata {
    accepted: RelayAcceptedLiveUpdate,
    preceding: Preceding,
    canonical_version: u8,
    authors: dohc_engine_collab::author_coverage::Authors,
}

/// Where the lineage's audited history stood before an event: the endpoint
/// of the event before, and that event's restore generation.
struct Preceding {
    endpoint: RetainedPrefixBody,
    generation: i64,
}

fn accepted_header(head: &[u8]) -> Result<RelayAcceptedLiveUpdate, SyncError> {
    let bytes = head
        .strip_prefix(b"{\"accepted\":")
        .ok_or_else(|| invalid("noncanonical native metadata prefix"))?;
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    // Decode the accepted object, not its enclosing metadata map. The bounded
    // prefix may end inside firstSeen; the full record parser checks it later.
    RelayAcceptedLiveUpdate::deserialize(&mut decoder).map_err(SyncError::corrupt)
}

fn prefix(header: &Header) -> Result<Vec<u8>, SyncError> {
    let mut bytes = serde_json::to_vec(header).map_err(SyncError::corrupt)?;
    bytes.pop();
    bytes.extend_from_slice(b",\"metadata\":");
    Ok(bytes)
}

fn suffix_bytes(suffix: &Suffix) -> Result<Vec<u8>, SyncError> {
    let mut bytes = serde_json::to_vec(suffix).map_err(SyncError::corrupt)?;
    bytes[0] = b',';
    Ok(bytes)
}

fn base(conn: &Connection, p: [&str; 5]) -> Result<BaseRecord, SyncError> {
    let json: Option<String> = conn.query_row(
        &format!("SELECT record_json FROM live_audit_bases WHERE {SCOPE} UNION ALL SELECT record_json FROM live_audit_base_publications WHERE {SCOPE} LIMIT 1"),p,|r|r.get(0),
    ).optional().map_err(SyncError::corrupt)?;
    let base: BaseRecord = serde_json::from_str(&json.ok_or(SyncError::RetryableState {
        reason: "live audit event zero is unavailable",
    })?)
    .map_err(SyncError::corrupt)?;
    base.validate(p[1])?;
    Ok(base)
}

fn preceding(conn: &Connection, p: [&str; 5], count: i64) -> Result<Preceding, SyncError> {
    if count == 1 {
        let base = base(conn, p)?;
        return Ok(Preceding {
            generation: base.checkpoint.binding.restore_fence_generation,
            endpoint: RetainedPrefixBody {
                terminal_receipt: None,
                event_count: 0,
                history_evidence_digest: base.checkpoint.evidence_digest,
            },
        });
    }
    type Event = (String, i64, String, i64, Option<i64>, String);
    let event: Event = conn
        .query_row(
            &format!("SELECT evidence_digest,journal_cursor,delivery_id,accepting_host_epoch,restore_generation,update_sha256 FROM live_audit_events e JOIN live_audit_record_manifests m ON m.record_digest=e.record_digest WHERE {SCOPE} AND event_count=?6"),
            params![p[0], p[1], p[2], p[3], p[4], count - 1],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .ok_or(SyncError::RetryableState {
            reason: "preceding live audit event is unavailable",
        })?;
    let (evidence, journal_cursor, delivery_id, accepting_host_epoch, generation, update) = event;
    Ok(Preceding {
        generation: generation
            .ok_or_else(|| invalid("preceding live audit event keeps no generation"))?,
        endpoint: RetainedPrefixBody {
            terminal_receipt: Some(LiveUpdateReceipt {
                delivery_id,
                update_digest: update,
                journal_cursor,
                accepting_host_epoch,
            }),
            event_count: count - 1,
            history_evidence_digest: evidence,
        },
    })
}

/// The cancellations `chain` carried the lineage from the event before's
/// generation to `target`: one for each generation, each a restore of this
/// lineage in `namespace` fenced by its origin, ending at the event before.
/// The imported history holds no fence rows, so this checks the history it
/// has.
fn verify_cancelled(
    conn: &Connection,
    namespace: &str,
    binding: &LiveObjectBinding,
    preceding: &Preceding,
    chain: &[CancelledRestore],
    target: i64,
) -> Result<(), SyncError> {
    let mut generation = preceding.generation;
    if !chain.is_empty() {
        let origin = base(conn, scope(namespace, binding))?.origin;
        for CancelledRestore {
            origin_adoption_id,
            cancellation: cancelled,
        } in chain
        {
            let operation = &cancelled.fence.operation;
            cancelled
                .validate()
                .map_err(|_| invalid("invalid historical restore cancellation"))?;
            if operation.relay_database_namespace != namespace
                || scope(namespace, &cancelled.binding) != scope(namespace, binding)
                || operation.old_binding.restore_fence_generation != generation
                || cancelled.endpoint != preceding.endpoint
                || !origin.fenced(
                    origin_adoption_id.as_deref(),
                    &operation.origin,
                    &operation.host_id,
                )
            {
                return Err(invalid("historical restore cancellation differs"));
            }
            generation = cancelled.binding.restore_fence_generation;
        }
    }
    if generation != target {
        return Err(invalid("live audit generation step is unexplained"));
    }
    Ok(())
}

/// The origin adoption of the owner activation that fenced `cancelled`'s
/// restore, when one did: the activation it names, of this lineage, on its
/// host, and current at the generation it fenced from.
fn fencing_adoption(
    conn: &Connection,
    namespace: &str,
    cancelled: &NativeRestoreCancellationReceipt,
) -> Result<Option<String>, SyncError> {
    use dohc_engine_collab::live_update_application::RestoreDeliveryOrigin;
    let operation = &cancelled.fence.operation;
    let RestoreDeliveryOrigin::Owner { id } = &operation.origin else {
        return Ok(None);
    };
    let p = scope(namespace, &operation.old_binding);
    let activation: Option<(Option<String>, String, String, Option<i64>)> = conn
        .query_row(
            &format!("SELECT origin_adoption_id,host_coordinate_json,binding_json,released_restore_generation FROM live_owner_activations WHERE {SCOPE} AND activation_id=?6"),
            params![p[0], p[1], p[2], p[3], p[4], id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some((Some(adoption), host, binding, released)) = activation else {
        return Err(invalid("restore cancellation activation is unavailable"));
    };
    let host: ApplicationHostCoordinate =
        serde_json::from_str(&host).map_err(SyncError::corrupt)?;
    let binding: LiveObjectBinding = serde_json::from_str(&binding).map_err(SyncError::corrupt)?;
    let generation = operation.old_binding.restore_fence_generation;
    if host.host_id != operation.host_id
        || binding.restore_fence_generation > generation
        || released.is_some_and(|released| released < generation)
    {
        return Err(invalid("restore cancellation activation differs"));
    }
    Ok(Some(adoption))
}

fn next_field<'de, A: MapAccess<'de>, T: Deserialize<'de>>(
    map: &mut A,
    name: &str,
) -> Result<T, A::Error> {
    if map.next_key::<String>()?.as_deref() != Some(name) {
        return Err(serde::de::Error::custom(
            "noncanonical live audit field order",
        ));
    }
    map.next_value()
}

fn end_fields<'de, A: MapAccess<'de>>(map: &mut A) -> Result<(), A::Error> {
    if map.next_key::<String>()?.is_some() {
        return Err(serde::de::Error::custom("unexpected live audit field"));
    }
    Ok(())
}

struct RecordVisitor<'a> {
    storage_failure: &'a RefCell<Option<SyncError>>,
    conn: &'a Connection,
    workspace: &'a str,
}
impl<'de> Visitor<'de> for RecordVisitor<'_> {
    type Value = ParsedRecord;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a canonical historical live application")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let header = Header {
            kind: next_field(&mut map, "kind")?,
            relay_database_namespace: next_field(&mut map, "relayDatabaseNamespace")?,
            event_count: next_field(&mut map, "eventCount")?,
            evidence_digest: next_field(&mut map, "evidenceDigest")?,
            update_byte_length: next_field(&mut map, "updateByteLength")?,
        };
        if header.kind != "application"
            || header.relay_database_namespace.is_empty()
            || header.relay_database_namespace.len() > 1024
            || header
                .relay_database_namespace
                .bytes()
                .any(|b| b.is_ascii_control())
            || !(1..=crate::MAX_WIRE_INTEGER).contains(&header.event_count)
            || !digest(&header.evidence_digest)
            || !(1..=dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES)
                .contains(&header.update_byte_length)
        {
            return Err(serde::de::Error::custom("invalid live audit header"));
        }
        let mut canonical = Sha256::new();
        canonical.update(prefix(&header).map_err(serde::de::Error::custom)?);
        if map.next_key::<String>()?.as_deref() != Some("metadata") {
            return Err(serde::de::Error::custom("missing live audit metadata"));
        }
        let ParsedMetadata {
            accepted,
            preceding,
            canonical_version,
            authors,
        } = map.next_value_seed(MetadataSeed {
            storage_failure: self.storage_failure,
            conn: self.conn,
            workspace: self.workspace,
            header: &header,
            canonical: &mut canonical,
        })?;
        let source_application = next_field(&mut map, "sourceApplication")?;
        let source_restore = next_field(&mut map, "sourceRestore")?;
        let CancelledRestores(cancelled_restores) = next_field(&mut map, "cancelledRestores")?;
        let suffix = Suffix {
            source_application,
            source_restore,
            cancelled_restores,
            content_coordinate: next_field(&mut map, "contentCoordinate")?,
        };
        end_fields(&mut map)?;
        if let Some(source) = &suffix.source_application {
            if !(1..=crate::MAX_WIRE_INTEGER).contains(&source.local_ydoc_sequence) {
                return Err(serde::de::Error::custom("invalid native source sequence"));
            }
            source
                .host_coordinate
                .validate()
                .map_err(serde::de::Error::custom)?;
        }
        if let Some(restore) = &suffix.source_restore {
            let source = suffix
                .source_application
                .as_ref()
                .ok_or_else(|| serde::de::Error::custom("restore application source missing"))?;
            restore
                .verify(
                    self.conn,
                    &header.relay_database_namespace,
                    header.event_count,
                    &accepted,
                    source.local_ydoc_sequence,
                    &source.host_coordinate.host_id,
                )
                .map_err(|error| decode_failure(error, self.storage_failure))?;
        }
        verify_cancelled(
            self.conn,
            &header.relay_database_namespace,
            &accepted.binding,
            &preceding,
            &suffix.cancelled_restores,
            suffix
                .source_restore
                .as_ref()
                .map_or(accepted.binding.restore_fence_generation, |restore| {
                    restore.old_generation()
                }),
        )
        .map_err(|error| decode_failure(error, self.storage_failure))?;
        crate::model::bounded(
            &suffix.content_coordinate.origin_id,
            "invalid live audit content origin",
        )
        .map_err(serde::de::Error::custom)?;
        if suffix
            .content_coordinate
            .origin_id
            .bytes()
            .any(|b| b.is_ascii_control())
            || !(0..=crate::MAX_WIRE_INTEGER).contains(&suffix.content_coordinate.origin_seq)
        {
            return Err(serde::de::Error::custom(
                "invalid live audit content coordinate",
            ));
        }
        canonical.update(suffix_bytes(&suffix).map_err(serde::de::Error::custom)?);
        Ok(ParsedRecord {
            header,
            accepted,
            suffix,
            canonical_digest: dohc_engine_storage::hex(&canonical.finalize()),
            canonical_version,
            authors,
        })
    }
}

struct MetadataSeed<'a> {
    storage_failure: &'a RefCell<Option<SyncError>>,
    conn: &'a Connection,
    workspace: &'a str,
    header: &'a Header,
    canonical: &'a mut Sha256,
}
impl<'de> DeserializeSeed<'de> for MetadataSeed<'_> {
    type Value = ParsedMetadata;
    fn deserialize<D: serde::Deserializer<'de>>(self, decoder: D) -> Result<Self::Value, D::Error> {
        decoder.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for MetadataSeed<'_> {
    type Value = ParsedMetadata;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("accepted metadata and ordered first-seen ranges")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let accepted: RelayAcceptedLiveUpdate = next_field(&mut map, "accepted")?;
        accepted.validate().map_err(serde::de::Error::custom)?;
        if accepted.binding.workspace_id != self.workspace {
            return Err(serde::de::Error::custom("live audit workspace differs"));
        }
        let preceding = preceding(
            self.conn,
            scope(&self.header.relay_database_namespace, &accepted.binding),
            self.header.event_count,
        )
        .map_err(|error| decode_failure(error, self.storage_failure))?;
        let previous = &preceding.endpoint.history_evidence_digest;
        if let Some(terminal) = &preceding.endpoint.terminal_receipt {
            if accepted.receipt.journal_cursor <= terminal.journal_cursor {
                return Err(serde::de::Error::custom(
                    "live audit cursor did not advance",
                ));
            }
        }
        let mut chain = Sha256::new();
        let mut chain_v2 = Sha256::new();
        for (tag, hash) in [
            ("accepted-event-v1", &mut chain),
            ("accepted-event-v2", &mut chain_v2),
        ] {
            let mut lead = serde_json::to_vec(&(tag, &previous, self.header.event_count))
                .map_err(serde::de::Error::custom)?;
            lead.pop();
            lead.push(b',');
            hash.update(lead);
        }
        let mut metadata = b"{\"accepted\":".to_vec();
        serde_json::to_writer(&mut metadata, &accepted).map_err(serde::de::Error::custom)?;
        metadata.extend_from_slice(b",\"firstSeen\":[");
        self.canonical.update(&metadata);
        chain.update(&metadata);
        chain_v2.update(&metadata);
        if map.next_key::<String>()?.as_deref() != Some("firstSeen") {
            return Err(serde::de::Error::custom("missing firstSeen"));
        }
        map.next_value_seed(RangesSeed {
            canonical: self.canonical,
            chain: &mut chain,
            chain_v2: &mut chain_v2,
            max_ranges: self.header.update_byte_length.saturating_sub(2) / 5,
        })?;
        self.canonical.update(b"]");
        chain.update(b"]");
        chain_v2.update(b"]");
        let mut version = 1;
        let mut covered_authors = dohc_engine_collab::author_coverage::Authors::default();
        if let Some(key) = map.next_key::<String>()? {
            if key != "canonicalVersion" || map.next_value::<u8>()? != 2 {
                return Err(serde::de::Error::custom("invalid metadata version"));
            }
            version = 2;
            let authors: Vec<LiveAuthorEntry> = next_field(&mut map, "authorSnapshot")?;
            AdmittedLiveUpdateMetadata {
                accepted: accepted.clone(),
                first_seen: Vec::new(),
                canonical_version: Some(2),
                author_snapshot: Some(authors.clone()),
                first_seen_deletes: Some(Vec::new()),
                checkpoint_coverage: None,
            }
            .validate_extensions()
            .map_err(serde::de::Error::custom)?;
            let mut tail = b",\"canonicalVersion\":2,\"authorSnapshot\":".to_vec();
            serde_json::to_writer(&mut tail, &authors).map_err(serde::de::Error::custom)?;
            covered_authors
                .union_json(&serde_json::to_string(&authors).map_err(serde::de::Error::custom)?)
                .map_err(serde::de::Error::custom)?;
            tail.extend_from_slice(b",\"firstSeenDeletes\":[");
            self.canonical.update(&tail);
            chain_v2.update(&tail);
            if map.next_key::<String>()?.as_deref() != Some("firstSeenDeletes") {
                return Err(serde::de::Error::custom("missing deletions"));
            }
            map.next_value_seed(RangesSeed {
                canonical: self.canonical,
                chain: &mut chain,
                chain_v2: &mut chain_v2,
                max_ranges: self.header.update_byte_length,
            })?;
            self.canonical.update(b"]");
            chain_v2.update(b"]");
            if let Some(key) = map.next_key::<String>()? {
                if key != "checkpointCoverage" {
                    return Err(serde::de::Error::custom("unexpected metadata field"));
                }
                let coverage: Vec<LiveCheckpointAuthorCoverage> = map.next_value()?;
                validate_checkpoint_coverage(&coverage).map_err(serde::de::Error::custom)?;
                let checkpoint_authors: Vec<_> =
                    coverage.iter().map(|entry| &entry.author).collect();
                covered_authors
                    .union_json(
                        &serde_json::to_string(&checkpoint_authors)
                            .map_err(serde::de::Error::custom)?,
                    )
                    .map_err(serde::de::Error::custom)?;
                let mut tail = b",\"checkpointCoverage\":".to_vec();
                serde_json::to_writer(&mut tail, &coverage).map_err(serde::de::Error::custom)?;
                self.canonical.update(&tail);
                chain_v2.update(&tail);
                end_fields(&mut map)?;
            }
        }
        if self.header.event_count > 1 {
            let p = scope(&self.header.relay_database_namespace, &accepted.binding);
            let prior: u8 = self.conn.query_row(&format!("SELECT canonical_version FROM live_audit_events WHERE {SCOPE} AND event_count=?6"),
                params![p[0],p[1],p[2],p[3],p[4],self.header.event_count-1], |row|row.get(0)).map_err(SyncError::corrupt).map_err(|error| decode_failure(error, self.storage_failure))?;
            if prior == 2 && version == 1 {
                return Err(serde::de::Error::custom(
                    "accepted history version downgrade",
                ));
            }
        }
        self.canonical.update(b"}");
        chain.update(b"}]");
        chain_v2.update(b"}]");
        let evidence = if version == 2 {
            chain_v2.finalize()
        } else {
            chain.finalize()
        };
        if dohc_engine_storage::hex(&evidence) != self.header.evidence_digest {
            return Err(serde::de::Error::custom(
                "live audit evidence chain differs",
            ));
        }
        Ok(ParsedMetadata {
            accepted,
            preceding,
            canonical_version: version,
            authors: covered_authors,
        })
    }
}

struct RangesSeed<'a> {
    canonical: &'a mut Sha256,
    chain: &'a mut Sha256,
    chain_v2: &'a mut Sha256,
    max_ranges: usize,
}
impl<'de> DeserializeSeed<'de> for RangesSeed<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, decoder: D) -> Result<(), D::Error> {
        decoder.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for RangesSeed<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("canonical first-seen ranges")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<(), A::Error> {
        let mut previous: Option<LiveUpdateStructRange> = None;
        let mut count = 0usize;
        let mut bytes = Vec::with_capacity(128);
        while let Some(range) = sequence.next_element::<LiveUpdateStructRange>()? {
            count = count
                .checked_add(1)
                .ok_or_else(|| serde::de::Error::custom("live audit range count overflow"))?;
            if count > self.max_ranges {
                return Err(serde::de::Error::custom(
                    "live audit firstSeen range count exceeds update bound",
                ));
            }
            range
                .validate_after(previous.as_ref())
                .map_err(serde::de::Error::custom)?;
            if previous.is_some() {
                self.canonical.update(b",");
                self.chain.update(b",");
                self.chain_v2.update(b",");
            }
            bytes.clear();
            serde_json::to_writer(&mut bytes, &range).map_err(serde::de::Error::custom)?;
            self.canonical.update(&bytes);
            self.chain.update(&bytes);
            self.chain_v2.update(&bytes);
            previous = Some(range);
        }
        Ok(())
    }
}

fn parse(
    conn: &Connection,
    workspace: &str,
    manifest: &Manifest,
) -> Result<ParsedRecord, SyncError> {
    // Missing source order is retryable even though serde wraps visitor errors.
    // The small routing header is retained separately by the envelope and checked
    // before parsing at the import seam.
    let storage_failure = RefCell::new(None);
    let mut reader = BufReader::with_capacity(65_536, ChunkReader::new(conn, manifest)?);
    let mut decoder = serde_json::Deserializer::from_reader(&mut reader);
    let decoded = serde::Deserializer::deserialize_map(
        &mut decoder,
        RecordVisitor {
            conn,
            workspace,
            storage_failure: &storage_failure,
        },
    )
    .and_then(|record| {
        decoder.end()?;
        Ok(record)
    });
    drop(decoder);
    let mut chunks = reader.into_inner();
    if let Some(error) = storage_failure.into_inner() {
        return Err(error);
    }
    if let Some(error) = chunks.take_storage_failure() {
        return Err(error.into());
    }
    let record = decoded.map_err(parse_error)?;
    chunks
        .finish()
        .map_err(|_| invalid("invalid historical live application"))?;
    if record.canonical_digest != manifest.record_digest {
        return Err(invalid("noncanonical historical live application"));
    }
    require_content(conn, &record)?;
    Ok(record)
}

fn decode_failure<E: serde::de::Error>(
    error: SyncError,
    storage_failure: &RefCell<Option<SyncError>>,
) -> E {
    let message = E::custom(&error);
    if matches!(&error, SyncError::Storage(_)) {
        *storage_failure.borrow_mut() = Some(error);
    }
    message
}

fn parse_error(error: serde_json::Error) -> SyncError {
    if error.is_io() && error.io_error_kind() != Some(std::io::ErrorKind::InvalidData) {
        SyncError::BlobInvalid
    } else {
        invalid("invalid historical live application")
    }
}

fn require_content(conn: &Connection, record: &ParsedRecord) -> Result<(), SyncError> {
    let b = &record.accepted.binding;
    let json:Option<String>=conn.query_row("SELECT payload_json FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3 AND op_kind='ydoc.update'",
        params![b.workspace_id,record.suffix.content_coordinate.origin_id,record.suffix.content_coordinate.origin_seq],|r|r.get(0)).optional().map_err(SyncError::corrupt)?;
    let payload: serde_json::Value =
        serde_json::from_str(&json.ok_or(SyncError::RetryableState {
            reason: "live audit content coordinate is unavailable",
        })?)
        .map_err(SyncError::corrupt)?;
    if payload["versionId"] != b.main_version_id
        || payload["objectId"] != b.object_id
        || payload["lineageClaimId"] != b.lineage_claim_id
        || payload["path"] != b.current_path
        || payload["contentKind"] != "richdoc"
        || payload["updateBlobSha256"] != record.accepted.receipt.update_digest
    {
        return Err(invalid("live audit content coordinate differs"));
    }
    super::chunks::require_blob_length(
        conn,
        &record.accepted.receipt.update_digest,
        record.header.update_byte_length,
    )?;
    // The content operation already validated the Y.Doc. Recheck its address
    // without decoding it or materializing the full audit record.
    let mut hash = Sha256::new();
    for offset in (0..record.header.update_byte_length).step_by(65_536) {
        let size = (record.header.update_byte_length - offset).min(65_536);
        let bytes: Vec<u8> = conn
            .query_row(
                "SELECT substr(bytes,?2,?3) FROM binary_blobs WHERE sha256=?1",
                params![
                    record.accepted.receipt.update_digest,
                    offset as i64 + 1,
                    size as i64
                ],
                |r| r.get(0),
            )
            .map_err(SyncError::corrupt)?;
        if bytes.len() != size {
            return Err(SyncError::BlobInvalid);
        }
        hash.update(bytes);
    }
    if dohc_engine_storage::hex(&hash.finalize()) != record.accepted.receipt.update_digest {
        return Err(SyncError::BlobInvalid);
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventPayload {
    relay_database_namespace: String,
    main_version_id: String,
    object_id: String,
    lineage_claim_id: String,
    event_count: i64,
    manifest: Manifest,
    update_blob_sha256: String,
}

fn retain_manifest(
    tx: &Transaction<'_>,
    manifest: &Manifest,
    update: &str,
) -> Result<(), SyncError> {
    let json = serde_json::to_string(manifest).map_err(SyncError::corrupt)?;
    tx.execute("INSERT OR IGNORE INTO live_audit_record_manifests(record_digest,manifest_json,update_sha256) VALUES (?1,?2,?3)",params![manifest.record_digest,json,update]).map_err(SyncError::persist)?;
    let retained:(String,String)=tx.query_row("SELECT manifest_json,update_sha256 FROM live_audit_record_manifests WHERE record_digest=?1",[&manifest.record_digest],|r|Ok((r.get(0)?,r.get(1)?))).map_err(SyncError::corrupt)?;
    if retained != (json, update.to_owned()) {
        return Err(invalid("live audit manifest identity differs"));
    }
    for (ordinal, chunk) in manifest.chunks.iter().enumerate() {
        tx.execute("INSERT OR IGNORE INTO live_audit_record_chunks(record_digest,ordinal,chunk_sha256) VALUES (?1,?2,?3)",params![manifest.record_digest,ordinal as i64,chunk.sha256]).map_err(SyncError::persist)?;
        let saved:String=tx.query_row("SELECT chunk_sha256 FROM live_audit_record_chunks WHERE record_digest=?1 AND ordinal=?2",params![manifest.record_digest,ordinal as i64],|r|r.get(0)).map_err(SyncError::corrupt)?;
        if saved != chunk.sha256 {
            return Err(invalid("retained live audit chunk root differs"));
        }
    }
    Ok(())
}

fn insert_event(
    tx: &Transaction<'_>,
    record: &ParsedRecord,
    manifest: &Manifest,
    passive: bool,
) -> Result<bool, SyncError> {
    let receipt = &record.accepted.receipt;
    let replica: Option<(i64, i64, String, String)> = if passive {
        tx.query_row(
        "SELECT event_count,journal_cursor,evidence_digest,update_sha256 FROM live_accepted_updates WHERE relay_database_namespace=?1 AND delivery_id=?2",
        params![record.header.relay_database_namespace,receipt.delivery_id],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(SyncError::corrupt)?
    } else {
        None
    };
    if replica.is_some_and(|(count, cursor, evidence, update)| {
        count != record.header.event_count
            || cursor != receipt.journal_cursor
            || evidence != record.header.evidence_digest
            || update != receipt.update_digest
    }) {
        return Ok(false);
    }
    let p = scope(
        &record.header.relay_database_namespace,
        &record.accepted.binding,
    );
    let mut query = tx.prepare(&format!("SELECT record_digest FROM live_audit_events WHERE ({SCOPE} AND event_count=?6) OR (relay_database_namespace=?1 AND (delivery_id=?7 OR journal_cursor=?8))")).map_err(SyncError::corrupt)?;
    let existing = query
        .query_map(
            params![
                p[0],
                p[1],
                p[2],
                p[3],
                p[4],
                record.header.event_count,
                record.accepted.receipt.delivery_id,
                record.accepted.receipt.journal_cursor
            ],
            |r| r.get::<_, String>(0),
        )
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?;
    retain_manifest(tx, manifest, &record.accepted.receipt.update_digest)?;
    if !existing.is_empty() {
        return Ok(existing
            .iter()
            .all(|saved| saved == &manifest.record_digest));
    }
    tx.execute("INSERT INTO live_audit_events(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,event_count,record_digest,evidence_digest,journal_cursor,delivery_id,accepting_host_epoch,restore_operation_id,restore_markdown_digest,canonical_version,restore_generation) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",params![p[0],p[1],p[2],p[3],p[4],record.header.event_count,manifest.record_digest,record.header.evidence_digest,record.accepted.receipt.journal_cursor,record.accepted.receipt.delivery_id,record.accepted.receipt.accepting_host_epoch,record.suffix.source_restore.as_ref().map(|s|&s.operation_id),record.suffix.source_restore.as_ref().map(|s|&s.point.markdown_digest),record.canonical_version,record.accepted.binding.restore_fence_generation]).map_err(SyncError::persist)?;
    Ok(true)
}

fn retain_projection_authors(
    tx: &Transaction<'_>,
    record: &ParsedRecord,
    record_digest: &str,
    confirmed: bool,
) -> Result<(), SyncError> {
    if record.authors.is_empty() {
        return Ok(());
    }
    let binding = &record.accepted.binding;
    let coordinate = &record.suffix.content_coordinate;
    let imported_content: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 \
         AND origin_seq=?3 AND op_kind='ydoc.update' AND (?4 OR imported=1) AND apply_disposition='applied' \
         AND COALESCE(json_extract(payload_json,'$.isBaseState'),0)=0)",
        params![binding.workspace_id,coordinate.origin_id,coordinate.origin_seq,confirmed], |row| row.get(0),
    ).map_err(SyncError::corrupt)?;
    if !imported_content {
        return Ok(());
    }
    // Copies of one record differ only in relay confirmation, which never
    // regresses. Distinct records at one coordinate keep the conservative union.
    tx.execute(
        "INSERT INTO live_audit_projection_contributions(workspace_id,origin_id,origin_seq,record_digest,author_json) \
         VALUES (?1,?2,?3,?4,?5) ON CONFLICT(workspace_id,origin_id,origin_seq,record_digest) \
         DO UPDATE SET author_json=excluded.author_json WHERE ?6",
        params![
            binding.workspace_id,
            coordinate.origin_id,
            coordinate.origin_seq,
            record_digest,
            record.authors.json(),
            confirmed
        ],
    )
    .map_err(SyncError::persist)?;
    let contributions = tx
        .prepare(
            "SELECT author_json FROM live_audit_projection_contributions \
             WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
        )
        .map_err(SyncError::corrupt)?
        .query_map(
            params![
                binding.workspace_id,
                coordinate.origin_id,
                coordinate.origin_seq
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?;
    let mut authors = dohc_engine_collab::author_coverage::Authors::default();
    for contribution in &contributions {
        authors
            .union_json(contribution)
            .map_err(SyncError::corrupt)?;
    }
    let json = bounded_projection_authors(&authors)?;
    tx.execute(
        "INSERT INTO live_audit_projection_authors(workspace_id,origin_id,origin_seq,version_id,object_id,path,lineage_claim_id,author_json) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(workspace_id,origin_id,origin_seq) DO UPDATE SET author_json=excluded.author_json",
        params![binding.workspace_id,coordinate.origin_id,coordinate.origin_seq,binding.main_version_id,
            binding.object_id,binding.current_path,binding.lineage_claim_id,json],
    ).map_err(SyncError::persist)?;
    let key = DocKey::new(
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
    )
    .map_err(|_| invalid("invalid audited projection identity"))?;
    annotate_projected_moment_in_tx(
        tx,
        &key,
        &binding.current_path,
        &coordinate.origin_id,
        coordinate.origin_seq,
    )
}

fn bounded_projection_authors(
    authors: &dohc_engine_collab::author_coverage::Authors,
) -> Result<String, SyncError> {
    if authors.len() > dohc_engine_collab::author_coverage::MAX_INTERVAL_AUTHORS
        || authors.journal_bytes() > dohc_engine_collab::author_coverage::MAX_INTERVAL_AUTHOR_BYTES
    {
        return Err(invalid("audited projection authors exceed bound"));
    }
    Ok(authors.json())
}

pub(crate) fn annotate_projected_moment_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    path: &str,
    origin_id: &str,
    origin_seq: i64,
) -> Result<(), SyncError> {
    // Retained coordinate coverage also reaches a projection drained after its
    // audit. The primary-key lookup never scans the document's audit history.
    let moment_id = crate::ydoc_apply::ydoc_apply_moment_id(key, path, origin_id, origin_seq);
    let entries: Option<(Option<String>, String, Option<String>)> = tx.query_row(
        "SELECT m.author_json,a.author_json,a.moment_base_json \
         FROM live_audit_projection_authors a JOIN moments m \
         ON m.workspace_id=a.workspace_id AND m.version_id=a.version_id AND m.object_id=a.object_id \
           AND m.path=a.path AND m.moment_id=?6 AND m.metadata_origin='ydoc' AND m.operation='write' \
           AND COALESCE(m.sync_record_only,0)=0 \
         JOIN replication_log r ON r.workspace_id=a.workspace_id AND r.origin_id=a.origin_id \
           AND r.origin_seq=a.origin_seq AND r.op_kind='ydoc.update' AND r.apply_disposition='applied' \
           AND json_extract(r.payload_json,'$.lineageClaimId')=a.lineage_claim_id \
         WHERE a.workspace_id=?1 AND a.origin_id=?2 AND a.origin_seq=?3 AND a.version_id=?4 \
           AND a.object_id=?5 AND a.path=?7",
        params![key.workspace_id,origin_id,origin_seq,key.version_id,key.object_id,moment_id,path],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).optional().map_err(SyncError::corrupt)?;
    let Some((existing, verified, base)) = entries else {
        return Ok(());
    };
    // Only a marker introduced by this one coordinate can become verified.
    // A local gap or an aggregate drain's earlier gap remains unattributed.
    let provisional = tx.execute(
        "DELETE FROM engine_requests WHERE request_id='sync-ydoc-provisional-author:'||json_array(?1,?2,?3) \
         AND payload_hash=?4 AND kind='sync-ydoc-provisional-author'",
        params![key.workspace_id,key.version_id,key.object_id,moment_id],
    ).map_err(SyncError::persist)?;
    // The base holds every author this coordinate's audit did not supply, so a
    // recomputed row raises the moment's confirmation without erasing a gap.
    let base = match base {
        Some(base) => base,
        None => {
            let base = match existing {
                Some(existing) if provisional != 0 => {
                    let mut prior = dohc_engine_collab::author_coverage::Authors::default();
                    prior.union_json(&existing).map_err(SyncError::corrupt)?;
                    prior.remove_unattributed();
                    prior.json()
                }
                existing => existing.unwrap_or_else(|| "[]".to_owned()),
            };
            tx.execute(
                "UPDATE live_audit_projection_authors SET moment_base_json=?4 \
                 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                params![key.workspace_id, origin_id, origin_seq, base],
            )
            .map_err(SyncError::persist)?;
            base
        }
    };
    let mut authors = dohc_engine_collab::author_coverage::Authors::default();
    authors.union_json(&base).map_err(SyncError::corrupt)?;
    authors.union_json(&verified).map_err(SyncError::corrupt)?;
    tx.execute(
        "UPDATE moments SET author_json=?3 WHERE workspace_id=?1 AND moment_id=?2",
        params![
            key.workspace_id,
            moment_id,
            bounded_projection_authors(&authors)?
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

pub(crate) fn drained_coordinate_authors(
    conn: &rusqlite::Connection,
    key: &DocKey,
    path: &str,
    origin: &str,
    seq: i64,
) -> Result<dohc_engine_collab::author_coverage::Authors, SyncError> {
    let coverage: Option<(String, Option<String>)> = conn.query_row(
        "SELECT r.payload_json,a.author_json FROM replication_log r \
         LEFT JOIN live_audit_projection_authors a \
         ON r.workspace_id=a.workspace_id AND r.origin_id=a.origin_id AND r.origin_seq=a.origin_seq \
         AND json_extract(r.payload_json,'$.lineageClaimId')=a.lineage_claim_id \
         AND a.version_id=?4 AND a.object_id=?5 AND a.path=?6 \
         WHERE r.workspace_id=?1 AND r.origin_id=?2 AND r.origin_seq=?3 \
         AND r.op_kind='ydoc.update' AND r.apply_disposition='applied' \
         AND json_extract(r.payload_json,'$.versionId')=?4 \
         AND json_extract(r.payload_json,'$.objectId')=?5 \
         AND json_extract(r.payload_json,'$.path')=?6",
        params![key.workspace_id, origin, seq, key.version_id, key.object_id, path],
        |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional().map_err(SyncError::corrupt)?;
    let mut authors = dohc_engine_collab::author_coverage::Authors::default();
    if let Some((payload, verified)) = coverage {
        if let Some(verified) = verified {
            authors.union_json(&verified).map_err(SyncError::corrupt)?;
        } else if !dohc_engine_collab::author_coverage::accepted_only_in(conn, key)
            .map_err(SyncError::corrupt)?
        {
            // Use the single-coordinate projection's conversion and admission
            // boundary. Payload declarations cannot create verified authors.
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Attribution {
                actor_origin_id: Option<String>,
                attribution: Option<dohc_engine_domain::ChangeAttribution>,
            }
            let payload: Attribution =
                serde_json::from_str(&payload).map_err(SyncError::corrupt)?;
            if let Some(recorded) = dohc_engine_domain::moment_author_json(
                payload.actor_origin_id.as_deref(),
                payload.attribution.as_ref(),
            ) {
                authors.union_json(&recorded).map_err(SyncError::corrupt)?;
            }
        }
    }
    if authors.is_empty() {
        authors
            .union_json(r#"[{"kind":"unattributed"}]"#)
            .map_err(SyncError::corrupt)?;
    }
    Ok(authors)
}

pub(crate) fn annotate_drained_projection_in_tx(
    tx: &Transaction<'_>,
    key: &DocKey,
    path: &str,
    origin_id: &str,
    origin_seq: i64,
    coordinates: &[(String, i64)],
) -> Result<(), SyncError> {
    let moment_id = crate::ydoc_apply::ydoc_apply_moment_id(key, path, origin_id, origin_seq);
    let existing: Option<Option<String>> = tx
        .query_row(
            "SELECT author_json FROM moments WHERE workspace_id=?1 AND moment_id=?2 \
         AND metadata_origin='ydoc' AND operation='write' AND COALESCE(sync_record_only,0)=0",
            params![key.workspace_id, moment_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some(existing) = existing else {
        return Ok(());
    };
    // Only this moment's own audited coordinate is recomputed later. Other
    // coordinates' authors and coverage gaps join that coordinate's fixed base.
    let base: Option<Option<String>> = tx
        .query_row(
            "SELECT moment_base_json FROM live_audit_projection_authors \
             WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3 \
             AND version_id=?4 AND object_id=?5 AND path=?6",
            params![
                key.workspace_id,
                origin_id,
                origin_seq,
                key.version_id,
                key.object_id,
                path
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let mut base = match base {
        Some(base) => {
            let mut authors = dohc_engine_collab::author_coverage::Authors::default();
            authors
                .union_json(base.as_deref().or(existing.as_deref()).unwrap_or("[]"))
                .map_err(SyncError::corrupt)?;
            Some(authors)
        }
        None => None,
    };
    let mut authors = dohc_engine_collab::author_coverage::Authors::default();
    if let Some(existing) = existing {
        authors.union_json(&existing).map_err(SyncError::corrupt)?;
    }
    for (origin, seq) in coordinates {
        let coordinate_authors = drained_coordinate_authors(tx, key, path, origin, *seq)?;
        // A later audit can add authors, but cannot erase this coverage gap.
        authors
            .union_json(&coordinate_authors.json())
            .map_err(SyncError::corrupt)?;
        if origin != origin_id || *seq != origin_seq {
            if let Some(base) = base.as_mut() {
                base.union_json(&coordinate_authors.json())
                    .map_err(SyncError::corrupt)?;
            }
        }
    }
    tx.execute(
        "UPDATE moments SET author_json=?3 WHERE workspace_id=?1 AND moment_id=?2",
        params![
            key.workspace_id,
            moment_id,
            bounded_projection_authors(&authors)?,
        ],
    )
    .map_err(SyncError::persist)?;
    if let Some(base) = base {
        tx.execute(
            "UPDATE live_audit_projection_authors SET moment_base_json=?4 \
             WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
            params![
                key.workspace_id,
                origin_id,
                origin_seq,
                bounded_projection_authors(&base)?
            ],
        )
        .map_err(SyncError::persist)?;
    }
    Ok(())
}

fn parse_event_envelope(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
) -> Result<(EventPayload, ParsedRecord), SyncError> {
    let payload: EventPayload = serde_json::from_value(op.payload.clone())
        .map_err(|_| invalid("invalid live audit application payload"))?;
    if serde_json::to_value(&payload).map_err(SyncError::corrupt)? != op.payload {
        return Err(invalid("noncanonical live audit application payload"));
    }
    let routing = [
        payload.relay_database_namespace.as_str(),
        op.workspace_id.as_str(),
        payload.main_version_id.as_str(),
        payload.object_id.as_str(),
        payload.lineage_claim_id.as_str(),
    ];
    if !(1..=crate::MAX_WIRE_INTEGER).contains(&payload.event_count) {
        return Err(invalid("invalid live audit event count"));
    }
    preceding(tx, routing, payload.event_count)?;
    let record = parse(tx, &op.workspace_id, &payload.manifest)?;
    if scope(
        &record.header.relay_database_namespace,
        &record.accepted.binding,
    ) != routing
        || record.header.event_count != payload.event_count
        || record.accepted.receipt.update_digest != payload.update_blob_sha256
    {
        return Err(invalid("live audit routing differs"));
    }
    Ok((payload, record))
}

fn confirm_record_authors(
    record: &mut ParsedRecord,
    envelope: &ReplicationEnvelope,
) -> Result<bool, SyncError> {
    if envelope.relay_seq.is_none_or(|seq| seq <= 0) {
        return Ok(false);
    }
    let Some(snapshot) = &envelope.admitted_author_snapshot else {
        return Ok(false);
    };
    if snapshot.as_array().is_none_or(|authors| {
        authors.len() > dohc_engine_collab::author_coverage::MAX_INTERVAL_AUTHORS
    }) || serde_json::to_vec(snapshot)
        .map_err(SyncError::corrupt)?
        .len()
        > dohc_engine_collab::author_coverage::MAX_INTERVAL_AUTHOR_BYTES
    {
        return Ok(false);
    }
    let Ok(entries) = serde_json::from_value::<Vec<LiveAuthorEntry>>(snapshot.clone()) else {
        return Ok(false);
    };
    if entries.iter().any(|author| author.validate().is_err()) {
        return Ok(false);
    }
    let mut values = serde_json::to_value(entries).map_err(SyncError::corrupt)?;
    let mut authors = dohc_engine_collab::author_coverage::Authors::default();
    authors
        .union_json(&values.to_string())
        .map_err(SyncError::corrupt)?;
    if authors.is_empty() || authors.json() != record.authors.json() {
        return Ok(false);
    }
    for author in values.as_array_mut().expect("serialized author list") {
        if author["kind"] == "human" {
            author["relayConfirmed"] = serde_json::Value::Bool(true);
        }
    }
    let mut confirmed = dohc_engine_collab::author_coverage::Authors::default();
    confirmed
        .union_json(&values.to_string())
        .map_err(SyncError::corrupt)?;
    if confirmed.journal_bytes() > dohc_engine_collab::author_coverage::MAX_INTERVAL_AUTHOR_BYTES {
        return Ok(false);
    }
    record.authors = confirmed;
    Ok(true)
}

pub(crate) fn refresh_confirmed_application_in_tx(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    if envelope.op_kind != EVENT_OP
        || envelope.admitted_author_snapshot.is_none()
        || envelope.relay_seq.is_none_or(|seq| seq <= 0)
    {
        return Ok(());
    }
    let applied: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 \
         AND origin_seq=?3 AND op_kind='live.audit.application' AND apply_disposition='applied')",
            params![
                envelope.workspace_id,
                envelope.origin_id,
                envelope.origin_seq
            ],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !applied {
        return Ok(());
    }
    let payload = &envelope.payload;
    let (Some(namespace), Some(version), Some(object), Some(lineage), Some(count), Some(digest)) = (
        payload["relayDatabaseNamespace"].as_str(),
        payload["mainVersionId"].as_str(),
        payload["objectId"].as_str(),
        payload["lineageClaimId"].as_str(),
        payload["eventCount"].as_i64(),
        payload["manifest"]["recordDigest"].as_str(),
    ) else {
        return Ok(());
    };
    let retained: bool = tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM live_audit_events WHERE {SCOPE} AND event_count=?6 AND record_digest=?7)"),
        params![namespace,envelope.workspace_id,version,object,lineage,count,digest], |row|row.get(0)).map_err(SyncError::corrupt)?;
    if !retained {
        return Ok(());
    }
    // Refresh is optional proof enrichment. A damaged or refused audit must
    // never prevent subsequent content from passing an already-acked row.
    tx.execute_batch("SAVEPOINT dohc_audit_confirmation")
        .map_err(SyncError::persist)?;
    let refresh = (|| {
        let (event, mut record) = parse_event_envelope(tx, envelope)?;
        if confirm_record_authors(&mut record, envelope)? {
            retain_projection_authors(tx, &record, &event.manifest.record_digest, true)?;
        }
        Ok::<_, SyncError>(())
    })();
    if matches!(&refresh, Err(SyncError::Storage(_))) {
        return refresh;
    }
    if refresh.is_err() {
        tx.execute_batch("ROLLBACK TO dohc_audit_confirmation")
            .map_err(SyncError::persist)?;
    }
    tx.execute_batch("RELEASE dohc_audit_confirmation")
        .map_err(SyncError::persist)?;
    Ok(())
}

pub(super) fn apply_event_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<()>, SyncError> {
    let passive = store.is_passive();
    apply_envelope_with_mutation_outcome(store, envelope, faults, |tx, op| {
        let (payload, mut record) = parse_event_envelope(tx, op)?;
        if !insert_event(tx, &record, &payload.manifest, passive)? {
            tx.execute("INSERT INTO live_audit_event_conflicts(workspace_id,origin_id,origin_seq,record_digest) VALUES (?1,?2,?3,?4)",params![op.workspace_id,op.origin_id,op.origin_seq,payload.manifest.record_digest]).map_err(SyncError::persist)?;
            return Ok(MutationOutcome::RefusedRetainingMutation {
                reason: "live audit event identity contains different evidence".into(),
            });
        }
        let confirmed = confirm_record_authors(&mut record, op)?;
        retain_projection_authors(tx, &record, &payload.manifest.record_digest, confirmed)?;
        Ok(MutationOutcome::Applied(()))
    })
}

/// Publish one already-admitted native event inside its owning transaction.
/// Enrollment publishes predecessors first; an absent predecessor refuses.
pub fn journal_live_event_in_tx(
    tx: &Transaction<'_>,
    namespace: &str,
    binding: &LiveObjectBinding,
    count: i64,
    now_ms: i64,
) -> Result<Option<i64>, SyncError> {
    if !crate::workspace_replicates_with_relay_in_tx(tx, &binding.workspace_id)? {
        return Ok(None);
    }
    let p = scope(namespace, binding);
    // A local publication row records the base validation committed for this exact scope.
    let base_published: bool = tx
        .query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM live_audit_base_publications WHERE {SCOPE})"),
            p,
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !base_published {
        journal_live_base_in_tx(tx, namespace, binding, now_ms)?;
    }
    let preceding = preceding(tx, scope(namespace, binding), count)?;
    let published:Option<i64>=tx.query_row(&format!("SELECT origin_seq FROM live_audit_event_publications WHERE {SCOPE} AND event_count=?6"),params![p[0],p[1],p[2],p[3],p[4],count],|r|r.get(0)).optional().map_err(SyncError::corrupt)?;
    let (delivery,update,evidence,metadata_length):(String,String,String,i64)=tx.query_row(&format!("SELECT delivery_id,update_sha256,evidence_digest,length(CAST(metadata_json AS BLOB)) FROM live_accepted_updates WHERE {SCOPE} AND event_count=?6"),params![p[0],p[1],p[2],p[3],p[4],count],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(SyncError::corrupt)?;
    let update_byte_length: i64 = tx
        .query_row(
            "SELECT byte_length FROM binary_blobs WHERE sha256=?1",
            [&update],
            |r| r.get(0),
        )
        .map_err(SyncError::corrupt)?;
    // The canonical accepted header is at most 216,929 bytes under the existing
    // binding, authority, and declaration bounds. Do not ask SQLite to parse
    // the range array.
    let head:Vec<u8>=tx.query_row(&format!("SELECT substr(CAST(metadata_json AS BLOB),1,262144) FROM live_accepted_updates WHERE {SCOPE} AND event_count=?6"),params![p[0],p[1],p[2],p[3],p[4],count],|r|r.get(0)).map_err(SyncError::corrupt)?;
    let accepted = accepted_header(&head)?;
    accepted.validate().map_err(SyncError::corrupt)?;
    if scope(namespace, &accepted.binding) != p
        || accepted.receipt.delivery_id != delivery
        || accepted.receipt.update_digest != update
    {
        return Err(invalid("native audit source identity differs"));
    }
    let source_restore = restore_record::read(tx, namespace, &accepted)?;
    let target = source_restore
        .as_ref()
        .map_or(accepted.binding.restore_fence_generation, |restore| {
            restore.old_generation()
        });
    let cancelled_restores = dohc_engine_collab::live_update_application::cancelled_restores(
        tx,
        namespace,
        &accepted.binding,
        (preceding.generation, target),
        &preceding.endpoint,
    )
    .map_err(|error| match error {
        dohc_engine_collab::live_update_application::ApplicationError::Storage(error) => {
            SyncError::Storage(error)
        }
        _ => invalid("native restore cancellations differ"),
    })?
    .into_iter()
    .map(|cancellation| {
        Ok(CancelledRestore {
            origin_adoption_id: fencing_adoption(tx, namespace, &cancellation)?,
            cancellation,
        })
    })
    .collect::<Result<Vec<_>, SyncError>>()?;
    let path = accepted.binding.current_path;
    let header = Header {
        kind: "application".into(),
        relay_database_namespace: namespace.into(),
        event_count: count,
        evidence_digest: evidence,
        update_byte_length: usize::try_from(update_byte_length).map_err(SyncError::corrupt)?,
    };
    let existing:Option<BaseCoordinate>=tx.query_row("SELECT origin_id,origin_seq FROM replication_log WHERE workspace_id=?1 AND op_kind='ydoc.update' AND json_extract(payload_json,'$.versionId')=?2 AND json_extract(payload_json,'$.objectId')=?3 AND json_extract(payload_json,'$.lineageClaimId')=?4 AND json_extract(payload_json,'$.updateBlobSha256')=?5 AND json_extract(payload_json,'$.path')=?6 AND json_extract(payload_json,'$.contentKind')='richdoc' ORDER BY origin_id,origin_seq LIMIT 1",params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id,update,path],|r|Ok(BaseCoordinate{origin_id:r.get(0)?,origin_seq:r.get(1)?})).optional().map_err(SyncError::corrupt)?;
    let content_coordinate = if let Some(existing) = existing {
        existing
    } else {
        let key = DocKey::new(
            &binding.workspace_id,
            &binding.main_version_id,
            &binding.object_id,
        )
        .map_err(SyncError::corrupt)?;
        let seq = journal_local_op_in_tx(
            tx,
            &binding.workspace_id,
            "ydoc.update",
            &crate::ydoc_update_payload(
                &key,
                &path,
                ContentKind::Richdoc,
                &update,
                &binding.lineage_claim_id,
                None,
                None,
                false,
            ),
            now_ms,
        )?;
        let origin = tx
            .query_row(
                "SELECT origin_id FROM sync_identity WHERE workspace_id=?1",
                [&binding.workspace_id],
                |r| r.get(0),
            )
            .map_err(SyncError::corrupt)?;
        BaseCoordinate {
            origin_id: origin,
            origin_seq: seq,
        }
    };
    let source_application=tx.query_row("SELECT local_ydoc_sequence,applied_host_id,applied_host_epoch,applied_instance_id,applied_connection_id FROM live_device_update_applications WHERE relay_database_namespace=?1 AND delivery_id=?2",params![namespace,delivery],|r|Ok(SourceApplication{local_ydoc_sequence:r.get(0)?,host_coordinate:ApplicationHostCoordinate{host_id:r.get(1)?,host_epoch:r.get(2)?,instance_id:r.get(3)?,connection_id:r.get(4)?}})).optional().map_err(SyncError::corrupt)?;
    let suffix = Suffix {
        source_application,
        source_restore,
        cancelled_restores,
        content_coordinate,
    };
    let mut writer = ChunkWriter::new(tx);
    writer
        .write_all(&prefix(&header)?)
        .map_err(SyncError::corrupt)?;
    let metadata_length = usize::try_from(metadata_length).map_err(SyncError::corrupt)?;
    if metadata_length > u32::MAX as usize {
        return Err(invalid("native audit metadata exceeds ingress bound"));
    }
    for offset in (0..metadata_length).step_by(65_536) {
        let size = (metadata_length - offset).min(65_536);
        let bytes:Vec<u8>=tx.query_row(&format!("SELECT substr(CAST(metadata_json AS BLOB),?7,?8) FROM live_accepted_updates WHERE {SCOPE} AND event_count=?6"),params![p[0],p[1],p[2],p[3],p[4],count,offset as i64+1,size as i64],|r|r.get(0)).map_err(SyncError::corrupt)?;
        if bytes.len() != size {
            return Err(invalid("native metadata source changed"));
        }
        writer.write_all(&bytes).map_err(SyncError::corrupt)?;
    }
    writer
        .write_all(&suffix_bytes(&suffix)?)
        .map_err(SyncError::corrupt)?;
    let manifest = writer.finish()?;
    let record = parse(tx, &binding.workspace_id, &manifest)?;
    if !insert_event(tx, &record, &manifest, false)? {
        return Err(invalid(
            "native audit event conflicts with retained history",
        ));
    }
    let payload = EventPayload {
        relay_database_namespace: namespace.into(),
        main_version_id: binding.main_version_id.clone(),
        object_id: binding.object_id.clone(),
        lineage_claim_id: binding.lineage_claim_id.clone(),
        event_count: count,
        manifest,
        update_blob_sha256: update,
    };
    let payload = serde_json::to_value(payload).map_err(SyncError::corrupt)?;
    if let Some(seq) = published {
        let saved:String=tx.query_row("SELECT payload_json FROM replication_log WHERE workspace_id=?1 AND origin_id=(SELECT origin_id FROM sync_identity WHERE workspace_id=?1) AND origin_seq=?2 AND op_kind=?3",params![binding.workspace_id,seq,EVENT_OP],|r|r.get(0)).map_err(SyncError::corrupt)?;
        if serde_json::from_str::<serde_json::Value>(&saved).map_err(SyncError::corrupt)? != payload
        {
            return Err(invalid("published live audit source changed"));
        }
        return Ok(Some(seq));
    }
    let seq = journal_local_op_in_tx(tx, &binding.workspace_id, EVENT_OP, &payload, now_ms)?;
    tx.execute("INSERT INTO live_audit_event_publications(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,event_count,origin_id,origin_seq) VALUES (?1,?2,?3,?4,?5,?6,(SELECT origin_id FROM sync_identity WHERE workspace_id=?2),?7)",params![p[0],p[1],p[2],p[3],p[4],count,seq]).map_err(SyncError::persist)?;
    Ok(Some(seq))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_collab::live_update_application::{
        LiveUpdateReceipt, ServerDerivedLiveUpdateAuthority,
    };

    #[test]
    fn first_seen_count_cannot_exceed_the_update_struct_bound() {
        let ranges = r#"[{"clientId":1,"startClock":0,"endClock":1},{"clientId":2,"startClock":0,"endClock":1}]"#;
        for (max_ranges, expected) in [(1, false), (2, true)] {
            let mut canonical = Sha256::new();
            let mut chain = Sha256::new();
            let mut chain_v2 = Sha256::new();
            let mut decoder = serde_json::Deserializer::from_str(ranges);
            let result = RangesSeed {
                canonical: &mut canonical,
                chain: &mut chain,
                chain_v2: &mut chain_v2,
                max_ranges,
            }
            .deserialize(&mut decoder);
            assert_eq!(result.is_ok(), expected);
        }
        let mut canonical = Sha256::new();
        let mut chain = Sha256::new();
        let mut chain_v2 = Sha256::new();
        let mut decoder = serde_json::Deserializer::from_str("[]");
        RangesSeed {
            canonical: &mut canonical,
            chain: &mut chain,
            chain_v2: &mut chain_v2,
            max_ranges: 0,
        }
        .deserialize(&mut decoder)
        .unwrap();
    }

    #[test]
    fn accepted_header_refuses_parallel_declaration() {
        let accepted = accepted();
        let mut value = serde_json::to_value(accepted).unwrap();
        value["agentDeclaration"] =
            serde_json::json!({"agentId":"agent","onBehalfOf":null,"depth":0});
        assert!(accepted_header(format!("{{\"accepted\":{value}}}").as_bytes()).is_err());
    }

    fn accepted() -> RelayAcceptedLiveUpdate {
        RelayAcceptedLiveUpdate {
            receipt: LiveUpdateReceipt {
                delivery_id: "delivery".into(),
                update_digest: "a".repeat(64),
                journal_cursor: 1,
                accepting_host_epoch: 1,
            },
            binding: LiveObjectBinding {
                workspace_id: "workspace".into(),
                main_version_id: "main".into(),
                object_id: "object".into(),
                lineage_claim_id: "b".repeat(64),
                current_path: "note.md".into(),
                selector_paths: vec!["note.md".into()],
                restore_fence_generation: 0,
            },
            authority: ServerDerivedLiveUpdateAuthority::Owner {
                principal_id: "owner".into(),
            },
            received_at_ms: 1,
        }
    }

    #[test]
    fn accepted_header_does_not_require_the_metadata_map_to_end() {
        let accepted = RelayAcceptedLiveUpdate {
            receipt: LiveUpdateReceipt {
                delivery_id: "delivery".into(),
                update_digest: "a".repeat(64),
                journal_cursor: 1,
                accepting_host_epoch: 1,
            },
            binding: LiveObjectBinding {
                workspace_id: "workspace".into(),
                main_version_id: "main".into(),
                object_id: "object".into(),
                lineage_claim_id: "b".repeat(64),
                current_path: "note.md".into(),
                selector_paths: vec!["note.md".into()],
                restore_fence_generation: 0,
            },
            authority: ServerDerivedLiveUpdateAuthority::Owner {
                principal_id: "owner".into(),
            },
            received_at_ms: 1,
        };
        let json = serde_json::to_string(&accepted).unwrap();
        for tail in [
            ",\"firstSeen\":[]}",
            ",\"firstSeen\":[{",
            ",\"firstSeen\":[{\"clientId\":1",
        ] {
            let prefix = format!("{{\"accepted\":{json}{tail}");
            assert_eq!(accepted_header(prefix.as_bytes()).unwrap(), accepted);
        }
        assert!(accepted_header(b"{\"accepted\":{\"receipt\":").is_err());
        assert!(accepted_header(format!("{{\"unexpected\":{json}}}").as_bytes()).is_err());
    }
}
