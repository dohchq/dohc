use super::chunks::{ChunkReader, ChunkWriter, Manifest};
use super::*;
use dohc_engine_collab::live_update_application::{
    ApplicationHostCoordinate, LiveUpdateStructRange, RelayAcceptedLiveUpdate,
};
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
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
    content_coordinate: BaseCoordinate,
}

struct ParsedRecord {
    header: Header,
    accepted: RelayAcceptedLiveUpdate,
    suffix: Suffix,
    canonical_digest: String,
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

fn previous_evidence(conn: &Connection, p: [&str; 5], count: i64) -> Result<String, SyncError> {
    if count == 1 {
        let json: Option<String> = conn.query_row(
            &format!("SELECT record_json FROM live_audit_bases WHERE {SCOPE} UNION ALL SELECT record_json FROM live_audit_base_publications WHERE {SCOPE} LIMIT 1"),p,|r|r.get(0),
        ).optional().map_err(SyncError::corrupt)?;
        let base: BaseRecord = serde_json::from_str(&json.ok_or(SyncError::RetryableState {
            reason: "live audit event zero is unavailable",
        })?)
        .map_err(SyncError::corrupt)?;
        base.validate(p[1])?;
        return Ok(base.checkpoint.evidence_digest);
    }
    conn.query_row(
        &format!("SELECT evidence_digest FROM live_audit_events WHERE {SCOPE} AND event_count=?6"),
        params![p[0], p[1], p[2], p[3], p[4], count - 1],
        |r| r.get(0),
    )
    .optional()
    .map_err(SyncError::corrupt)?
    .ok_or(SyncError::RetryableState {
        reason: "preceding live audit event is unavailable",
    })
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
        let accepted = map.next_value_seed(MetadataSeed {
            conn: self.conn,
            workspace: self.workspace,
            header: &header,
            canonical: &mut canonical,
        })?;
        let suffix = Suffix {
            source_application: next_field(&mut map, "sourceApplication")?,
            source_restore: next_field(&mut map, "sourceRestore")?,
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
                .map_err(serde::de::Error::custom)?;
        }
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
        })
    }
}

struct MetadataSeed<'a> {
    conn: &'a Connection,
    workspace: &'a str,
    header: &'a Header,
    canonical: &'a mut Sha256,
}
impl<'de> DeserializeSeed<'de> for MetadataSeed<'_> {
    type Value = RelayAcceptedLiveUpdate;
    fn deserialize<D: serde::Deserializer<'de>>(self, decoder: D) -> Result<Self::Value, D::Error> {
        decoder.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for MetadataSeed<'_> {
    type Value = RelayAcceptedLiveUpdate;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("accepted metadata and ordered first-seen ranges")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let accepted: RelayAcceptedLiveUpdate = next_field(&mut map, "accepted")?;
        accepted.validate().map_err(serde::de::Error::custom)?;
        if accepted.binding.workspace_id != self.workspace {
            return Err(serde::de::Error::custom("live audit workspace differs"));
        }
        let previous = previous_evidence(
            self.conn,
            scope(&self.header.relay_database_namespace, &accepted.binding),
            self.header.event_count,
        )
        .map_err(serde::de::Error::custom)?;
        if self.header.event_count > 1 {
            let p = scope(&self.header.relay_database_namespace, &accepted.binding);
            let cursor:i64=self.conn.query_row(&format!("SELECT journal_cursor FROM live_audit_events WHERE {SCOPE} AND event_count=?6"),params![p[0],p[1],p[2],p[3],p[4],self.header.event_count-1],|r|r.get(0)).map_err(serde::de::Error::custom)?;
            if accepted.receipt.journal_cursor <= cursor {
                return Err(serde::de::Error::custom(
                    "live audit cursor did not advance",
                ));
            }
        }
        let mut chain = Sha256::new();
        let mut lead =
            serde_json::to_vec(&("accepted-event-v1", previous, self.header.event_count))
                .map_err(serde::de::Error::custom)?;
        lead.pop();
        lead.push(b',');
        chain.update(lead);
        let mut metadata = b"{\"accepted\":".to_vec();
        serde_json::to_writer(&mut metadata, &accepted).map_err(serde::de::Error::custom)?;
        metadata.extend_from_slice(b",\"firstSeen\":[");
        self.canonical.update(&metadata);
        chain.update(&metadata);
        if map.next_key::<String>()?.as_deref() != Some("firstSeen") {
            return Err(serde::de::Error::custom("missing firstSeen"));
        }
        map.next_value_seed(RangesSeed {
            canonical: self.canonical,
            chain: &mut chain,
        })?;
        end_fields(&mut map)?;
        self.canonical.update(b"]}");
        chain.update(b"]}]");
        if dohc_engine_storage::hex(&chain.finalize()) != self.header.evidence_digest {
            return Err(serde::de::Error::custom(
                "live audit evidence chain differs",
            ));
        }
        Ok(accepted)
    }
}

struct RangesSeed<'a> {
    canonical: &'a mut Sha256,
    chain: &'a mut Sha256,
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
        let mut bytes = Vec::with_capacity(128);
        while let Some(range) = sequence.next_element::<LiveUpdateStructRange>()? {
            range
                .validate_after(previous.as_ref())
                .map_err(serde::de::Error::custom)?;
            if previous.is_some() {
                self.canonical.update(b",");
                self.chain.update(b",");
            }
            bytes.clear();
            serde_json::to_writer(&mut bytes, &range).map_err(serde::de::Error::custom)?;
            self.canonical.update(&bytes);
            self.chain.update(&bytes);
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
    let mut reader = BufReader::with_capacity(65_536, ChunkReader::new(conn, manifest)?);
    let mut decoder = serde_json::Deserializer::from_reader(&mut reader);
    let record =
        serde::Deserializer::deserialize_map(&mut decoder, RecordVisitor { conn, workspace })
            .map_err(parse_error)?;
    decoder.end().map_err(parse_error)?;
    reader.into_inner().finish()?;
    if record.canonical_digest != manifest.record_digest {
        return Err(invalid("noncanonical historical live application"));
    }
    require_content(conn, &record)?;
    Ok(record)
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
    let lengths: Option<(i64, i64)> = conn
        .query_row(
            "SELECT byte_length,length(bytes) FROM binary_blobs WHERE sha256=?1",
            [&record.accepted.receipt.update_digest],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    if lengths
        != Some((
            record.header.update_byte_length as i64,
            record.header.update_byte_length as i64,
        ))
    {
        return Err(SyncError::BlobInvalid);
    }
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
) -> Result<bool, SyncError> {
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
    tx.execute("INSERT INTO live_audit_events(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,event_count,record_digest,evidence_digest,journal_cursor,delivery_id,accepting_host_epoch,restore_operation_id,restore_markdown_digest) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![p[0],p[1],p[2],p[3],p[4],record.header.event_count,manifest.record_digest,record.header.evidence_digest,record.accepted.receipt.journal_cursor,record.accepted.receipt.delivery_id,record.accepted.receipt.accepting_host_epoch,record.suffix.source_restore.as_ref().map(|s|&s.operation_id),record.suffix.source_restore.as_ref().map(|s|&s.point.markdown_digest)]).map_err(SyncError::persist)?;
    Ok(true)
}

pub(super) fn apply_event_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<()>, SyncError> {
    apply_envelope_with_mutation_outcome(store, envelope, faults, |tx, op| {
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
        previous_evidence(tx, routing, payload.event_count)?;
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
        if !insert_event(tx, &record, &payload.manifest)? {
            tx.execute("INSERT INTO live_audit_event_conflicts(workspace_id,origin_id,origin_seq,record_digest) VALUES (?1,?2,?3,?4)",params![op.workspace_id,op.origin_id,op.origin_seq,payload.manifest.record_digest]).map_err(SyncError::persist)?;
            return Ok(MutationOutcome::RefusedRetainingMutation {
                reason: "live audit event identity contains different evidence".into(),
            });
        }
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
    journal_live_base_in_tx(tx, namespace, binding, now_ms)?;
    let p = scope(namespace, binding);
    previous_evidence(tx, scope(namespace, binding), count)?;
    let published:Option<i64>=tx.query_row(&format!("SELECT origin_seq FROM live_audit_event_publications WHERE {SCOPE} AND event_count=?6"),params![p[0],p[1],p[2],p[3],p[4],count],|r|r.get(0)).optional().map_err(SyncError::corrupt)?;
    let (delivery,update,evidence,metadata_length):(String,String,String,i64)=tx.query_row(&format!("SELECT delivery_id,update_sha256,evidence_digest,length(CAST(metadata_json AS BLOB)) FROM live_accepted_updates WHERE {SCOPE} AND event_count=?6"),params![p[0],p[1],p[2],p[3],p[4],count],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(SyncError::corrupt)?;
    let update_byte_length: i64 = tx
        .query_row(
            "SELECT byte_length FROM binary_blobs WHERE sha256=?1",
            [&update],
            |r| r.get(0),
        )
        .map_err(SyncError::corrupt)?;
    // The canonical accepted header is at most214,820 bytes under the existing
    // binding and authority bounds. Do not ask SQLite to parse the range array.
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
    if !insert_event(tx, &record, &manifest)? {
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
