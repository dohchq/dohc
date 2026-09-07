use super::{
    VersionedTextStore, alias_object_id, bounded_identifier, committed, get_file_object,
    get_moment, get_snapshot, hash_author_fields, hash_fields, hash_optional_text_fields,
    lookup_request, moment_by_order, record_request, reject_reserved_capture_origin,
    validate_identifier, validate_moment_id, validate_plaintext_storable_path, version_exists,
    version_is_active,
};
use crate::conflicts::{WriteBinaryFile, write_binary_file_in_tx};
use crate::error::DomainError;
use crate::records::{BinaryWriteResult, WriteBinary};
use dohc_engine_storage::{FaultInjector, Preimage, put_binary_blob};
use rusqlite::{Connection, OptionalExtension, Transaction};

impl<'a> VersionedTextStore<'a> {
    /// Write a binary head and enqueue its materialization intent in the same
    /// transaction. Equal binary content is an idempotent no-op.
    pub fn write_binary(
        &mut self,
        input: &WriteBinary,
        faults: &dyn FaultInjector,
    ) -> Result<BinaryWriteResult, DomainError> {
        let outcome = self
            .store
            .write_with(faults, |tx| write_binary_in_tx(tx, input))?;
        committed(outcome)
    }
}

/// Apply a caller-originated binary write inside a caller-owned transaction.
/// The runtime uses this seam to keep the binary FTS deletion atomic with the
/// head/moment/materialization intent.
#[doc(hidden)]
pub fn write_binary_in_tx(
    tx: &Transaction<'_>,
    input: &WriteBinary,
) -> Result<BinaryWriteResult, DomainError> {
    // RESERVED ORIGIN at the door, like the text write: capture's binary
    // primitive never routes through this fn, so the reservation cannot be
    // forged while capture keeps stamping its own origin.
    reject_reserved_capture_origin(&input.metadata_origin)?;
    validate_identifier(&input.workspace_id, "workspace_id")?;
    validate_identifier(&input.version_id, "version_id")?;
    bounded_identifier(&input.object_id, "object_id")?;
    validate_moment_id(&input.moment_id)?;
    let path = validate_plaintext_storable_path(&input.path)?;
    if !version_exists(tx, &input.workspace_id, &input.version_id)? {
        return Err(DomainError::VersionNotFound);
    }
    let sha256 = dohc_engine_storage::hex_sha256(&input.bytes);
    let (author_kind, author_json) = hash_author_fields(input.author_json.as_deref());
    let (summary_kind, summary) = hash_optional_text_fields(input.metadata_summary.as_deref());
    let (correlation_kind, correlation_id) =
        hash_optional_text_fields(input.metadata_correlation_id.as_deref());
    let payload_hash = hash_fields(&[
        b"versioned-binary-write",
        input.workspace_id.as_bytes(),
        input.version_id.as_bytes(),
        path.as_bytes(),
        sha256.as_bytes(),
        input.moment_id.as_bytes(),
        input.object_id.as_bytes(),
        input.metadata_origin.as_bytes(),
        summary_kind,
        summary,
        correlation_kind,
        correlation_id,
        author_kind,
        author_json,
    ]);
    if let Some(request_id) = &input.request_id
        && let Some(recorded) = lookup_request(tx, request_id)?
    {
        if recorded.payload_hash != payload_hash {
            return Err(DomainError::IdempotencyKeyReuseMismatch);
        }
        return reconstruct_binary_write(tx, &input.workspace_id, recorded.result_seq);
    }
    put_binary_blob(tx, &input.bytes).map_err(DomainError::from)?;
    let existing_object = alias_object_id(tx, &input.workspace_id, &input.version_id, &path)?;
    let before = existing_object
        .as_deref()
        .map(|object_id| get_snapshot(tx, &input.workspace_id, &input.version_id, object_id))
        .transpose()?
        .flatten();

    if let Some(before) = &before
        && before.content_kind == "binary"
        && before.binary_sha256.as_deref() == Some(sha256.as_str())
    {
        let moment = get_moment(tx, &input.workspace_id, &before.latest_moment_id)?.ok_or(
            DomainError::StateCorrupt {
                reason: "deduped binary write points at a missing moment",
            },
        )?;
        let object = get_file_object(tx, &input.workspace_id, &before.object_id)?.ok_or(
            DomainError::StateCorrupt {
                reason: "deduped binary write points at a missing object",
            },
        )?;
        record_request(
            tx,
            input.request_id.as_deref(),
            &payload_hash,
            moment.moment_order,
            input.now_ms,
        )?;
        return Ok(BinaryWriteResult {
            object,
            object_id: before.object_id.clone(),
            path,
            sha256,
            byte_length: input.bytes.len() as i64,
            updated_at_ms: before.updated_at_ms,
            moment,
            deduped: true,
            materialize_enqueued: false,
        });
    }

    let object_id = existing_object.unwrap_or_else(|| input.object_id.clone());
    let preimage = before.as_ref().map_or(Preimage::Absent, |snapshot| {
        if snapshot.content_kind == "binary" {
            Preimage::Present(snapshot.binary_sha256.clone().unwrap_or_default())
        } else {
            Preimage::Present(snapshot.blob_sha256.clone().unwrap_or_default())
        }
    });
    let version_is_active = version_is_active(tx, &input.workspace_id, &input.version_id)?;
    write_binary_file_in_tx(
        tx,
        &WriteBinaryFile {
            workspace_id: input.workspace_id.clone(),
            version_id: input.version_id.clone(),
            object_id: object_id.clone(),
            path: path.clone(),
            binary_sha256: sha256.clone(),
            moment_id: input.moment_id.clone(),
            metadata_origin: input.metadata_origin.clone(),
            metadata_summary: input.metadata_summary.clone(),
            metadata_correlation_id: input.metadata_correlation_id.clone(),
            author_json: input.author_json.clone(),
            // Active version only: disk mirrors the active version, so a
            // non-active write must not enqueue a job — the open-time replay
            // would land another version's bytes for the capture baseline to
            // ingest into the active head.
            materialize: version_is_active.then_some(preimage),
            now_ms: input.now_ms,
        },
    )?;
    let moment = get_moment(tx, &input.workspace_id, &input.moment_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "binary write moment vanished within its transaction",
        },
    )?;
    let object =
        get_file_object(tx, &input.workspace_id, &object_id)?.ok_or(DomainError::StateCorrupt {
            reason: "binary write snapshot points at a missing object",
        })?;
    record_request(
        tx,
        input.request_id.as_deref(),
        &payload_hash,
        moment.moment_order,
        input.now_ms,
    )?;
    Ok(BinaryWriteResult {
        object,
        object_id,
        path,
        sha256,
        byte_length: input.bytes.len() as i64,
        updated_at_ms: input.now_ms,
        moment,
        deduped: false,
        materialize_enqueued: version_is_active,
    })
}

fn reconstruct_binary_write(
    conn: &Connection,
    workspace_id: &str,
    moment_order: i64,
) -> Result<BinaryWriteResult, DomainError> {
    let moment =
        moment_by_order(conn, workspace_id, moment_order)?.ok_or(DomainError::StateCorrupt {
            reason: "deduped binary write has no recorded moment",
        })?;
    if moment.after_content_kind != "binary" {
        return Err(DomainError::StateCorrupt {
            reason: "deduped binary write points at non-binary content",
        });
    }
    let sha256 = moment
        .after_binary_sha256
        .clone()
        .ok_or(DomainError::StateCorrupt {
            reason: "deduped binary write moment has no binary blob",
        })?;
    let byte_length: i64 = conn
        .query_row(
            "SELECT byte_length FROM binary_blobs WHERE sha256 = ?1",
            [&sha256],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?
        .ok_or(DomainError::StateCorrupt {
            reason: "deduped binary write moment blob missing",
        })?;
    let object = get_file_object(conn, workspace_id, &moment.object_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "deduped binary write moment object missing",
        },
    )?;
    Ok(BinaryWriteResult {
        object,
        object_id: moment.object_id.clone(),
        path: moment.path.clone(),
        sha256,
        byte_length,
        updated_at_ms: moment.recorded_at_ms,
        moment,
        deduped: true,
        materialize_enqueued: false,
    })
}
