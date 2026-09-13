use super::rollback::binary_rollback_job_version_prefix;
use super::{
    MAX_TEXT_BYTES, MOMENT_TEXT_HYDRATION_CAP_BYTES, VersionedTextStore, alias_object_id,
    bounded_identifier, committed, delete_result_from_moment, delete_text_in_tx, get_file_object,
    get_moment, get_snapshot, hash_author_fields, hash_fields, hash_optional_text_fields,
    lookup_request, moment_by_order, moment_exists, next_moment_order, object_has_live_alias,
    record_request, reject_reserved_capture_origin, text_blob_sha256,
    validate_addressable_plaintext_path, validate_identifier, validate_moment_id,
    validate_moment_metadata, validate_plaintext_storable_path, version_exists,
    write_result_from_moment,
};
use crate::error::DomainError;
use crate::records::{
    CaptureIngest, CaptureIngestBinary, CaptureIngestBinaryResult, CaptureRetire,
    CaptureRetireResult, DeleteResult, DeleteTextFile, FileObjectRecord, MomentOp, MomentRecord,
    SnapshotRecord, TextSnapshot, WriteResult, WriteText,
};
use dohc_engine_storage::{
    EngineStore, FaultInjector, MaterializationJobSpec, Preimage, put_binary_blob,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use std::borrow::Cow;

impl<'a> VersionedTextStore<'a> {
    // --------------------------------------------------------------------- writes

    /// Write text and its history in one storage transaction.
    ///
    /// Creates an object for a new path or updates the existing path's object.
    /// Rejects the reserved capture origin. A matching request replays its recorded
    /// write; reusing a request id with a different payload is refused. Matching
    /// existing write moments can also return a deduped result.
    ///
    /// Use [`write_text_in_tx`] to compose a write with other transaction effects.
    pub fn write_text(
        &mut self,
        input: &WriteText,
        faults: &dyn FaultInjector,
    ) -> Result<WriteResult, DomainError> {
        // Capture passes its prepared state directly to the normalized writer.
        // Keep reserved-origin refusal in this public method.
        reject_reserved_capture_origin(&input.metadata_origin)?;
        let outcome = self
            .store
            .write_with(faults, |tx| write_text_in_tx(tx, input))?;
        committed(outcome)
    }

    /// Record observed text in one storage transaction, deriving object and moment ids.
    ///
    /// Uses the ownership and replay rules of [`capture_ingest_with_admission_in_tx`]
    /// with no admission callback. The caller supplies the observed disk content.
    ///
    /// An existing path keeps its object. A new path derives an object id from the
    /// workspace, version, and path. Capture reuses that id when it has no live alias;
    /// otherwise the next global moment order disambiguates it. Moment ids also bind
    /// the producer, workspace, object, order, operation, and mutation identity.
    /// Every hashed field uses a `u64-LE byte length || bytes` frame.
    pub fn capture_ingest(
        &mut self,
        input: &CaptureIngest,
        faults: &dyn FaultInjector,
    ) -> Result<WriteResult, DomainError> {
        let outcome = self
            .store
            .write_with(faults, |tx| capture_ingest_in_tx(tx, input))?;
        committed(outcome)
    }

    /// Record observed binary content in one storage transaction.
    ///
    /// Uses [`capture_ingest_binary_with_admission_in_tx`] with no admission callback.
    /// New heads and equal-content observations record completed materialization
    /// evidence because the caller observed these bytes on disk. They enqueue no
    /// pending disk write. Equal-content observations retain the existing moment;
    /// request replay returns its recorded result without repeating the observation.
    pub fn capture_ingest_binary(
        &mut self,
        input: &CaptureIngestBinary,
        faults: &dyn FaultInjector,
    ) -> Result<CaptureIngestBinaryResult, DomainError> {
        let outcome = self
            .store
            .write_with(faults, |tx| capture_ingest_binary_in_tx(tx, input))?;
        committed(outcome)
    }

    /// Record a captured path's absence in one storage transaction.
    ///
    /// Uses [`capture_retire_in_tx`] and its head filters. A missing or excluded path
    /// returns `retired: None`.
    pub fn capture_retire(
        &mut self,
        input: &CaptureRetire,
        faults: &dyn FaultInjector,
    ) -> Result<CaptureRetireResult, DomainError> {
        let outcome = self
            .store
            .write_with(faults, |tx| capture_retire_in_tx(tx, input))?;
        committed(outcome)
    }
}

// ============================================================================
// Free helpers (SQL over a borrowed connection/transaction).
// ============================================================================

/// Input for text persistence with borrowed identifiers and metadata.
///
/// Path and text can be borrowed or owned. Path normalization may allocate.
/// For a new write, owned text moves into the returned snapshot; borrowed text
/// is copied for that snapshot. Replay returns the recorded result instead.
///
/// [`write_projected_text_in_tx`] accepts this input or a borrowed [`WriteText`].
pub struct ProjectedWriteText<'a> {
    pub workspace_id: &'a str,
    pub version_id: &'a str,
    pub object_id: &'a str,
    pub path: Cow<'a, str>,
    pub text: Cow<'a, str>,
    pub moment_id: &'a str,
    pub metadata_origin: &'a str,
    pub metadata_summary: Option<&'a str>,
    pub metadata_correlation_id: Option<&'a str>,
    pub author_json: Option<&'a str>,
    pub now_ms: i64,
    pub request_id: Option<&'a str>,
}

/// State the caller has already proved for one text mutation. Keeping this
/// private makes the domain write the only persistence implementation while
/// letting autonomous capture reuse the object binding, preimage, and moment
/// order it had to resolve before deriving its collision-resistant moment id.
struct PreparedTextWrite {
    object_id: String,
    before: Option<SnapshotRecord>,
    moment_order: i64,
    content_sha256: String,
    bind_object: bool,
    bind_alias: bool,
    known_object: Option<FileObjectRecord>,
}

struct ResolvedCaptureObject {
    object_id: String,
    reserved_moment_order: Option<i64>,
    known_object: Option<FileObjectRecord>,
}

/// Transaction-local producer and moment-order state for one capture batch attempt.
///
/// Use one context for one workspace and version. Ingest proposes an order;
/// [`Self::commit_result`] advances it after the caller accepts the item's effects.
/// Request replay and content dedupe consume no order. Producer and order reads
/// stay lazy until needed.
///
/// The caller owns SQLite savepoints and the transaction. An all-or-none batch
/// advances each successful item inside its outer savepoint and discards the
/// context if that scope rolls back. A partial-success batch releases each
/// successful item savepoint before advancing. Failed items do not advance.
pub struct CaptureIngestBatchContext {
    workspace_id: String,
    version_id: String,
    producer_id: Option<String>,
    moment_order_cursor: CaptureMomentOrderCursor,
}

#[derive(Clone, Copy)]
enum CaptureMomentOrderCursor {
    Uninitialized,
    Ready(i64),
    Exhausted,
}

impl CaptureIngestBatchContext {
    /// Check the version and establish the batch's workspace and version.
    ///
    /// Producer identity and global moment order are read only when ingest needs
    /// them, so replay does not require those reads.
    pub fn new(
        tx: &Transaction<'_>,
        workspace_id: &str,
        version_id: &str,
    ) -> Result<Self, DomainError> {
        if !version_exists(tx, workspace_id, version_id)? {
            return Err(DomainError::VersionNotFound);
        }
        Ok(Self {
            workspace_id: workspace_id.to_owned(),
            version_id: version_id.to_owned(),
            producer_id: None,
            moment_order_cursor: CaptureMomentOrderCursor::Uninitialized,
        })
    }

    /// Accept a successful item's reserved order. This does not commit SQLite.
    ///
    /// Call after all effects in the item's rollback scope succeed. An all-or-none batch
    /// calls this inside its outer savepoint; a partial-success batch first releases
    /// the successful item's savepoint. Do not call for a failed item. Discard this
    /// context if an enclosing rollback undoes previously accepted items.
    ///
    /// A deduped result leaves the cursor unchanged. A new result must match the
    /// context's reserved order.
    pub fn commit_result(&mut self, result: &WriteResult) -> Result<(), DomainError> {
        if result.deduped {
            return Ok(());
        }
        let next_moment_order = match self.moment_order_cursor {
            CaptureMomentOrderCursor::Ready(next_moment_order) => next_moment_order,
            CaptureMomentOrderCursor::Uninitialized => {
                return Err(DomainError::StateCorrupt {
                    reason: "capture batch committed a moment without reserving an order",
                });
            }
            CaptureMomentOrderCursor::Exhausted => {
                return Err(DomainError::StateCorrupt {
                    reason: "capture batch committed a moment after order exhaustion",
                });
            }
        };
        if result.moment.moment_order != next_moment_order {
            return Err(DomainError::StateCorrupt {
                reason: "capture batch moment order diverged from its cursor",
            });
        }
        self.moment_order_cursor = match next_moment_order.checked_add(1) {
            Some(next_moment_order) => CaptureMomentOrderCursor::Ready(next_moment_order),
            None => CaptureMomentOrderCursor::Exhausted,
        };
        Ok(())
    }

    fn validates(&self, input: &CaptureIngest) -> bool {
        input.workspace_id == self.workspace_id && input.version_id == self.version_id
    }

    fn proposed_moment_order(&mut self, tx: &Transaction<'_>) -> Result<i64, DomainError> {
        match self.moment_order_cursor {
            CaptureMomentOrderCursor::Ready(next_moment_order) => Ok(next_moment_order),
            CaptureMomentOrderCursor::Uninitialized => {
                let next_moment_order = next_moment_order(tx)?;
                self.moment_order_cursor = CaptureMomentOrderCursor::Ready(next_moment_order);
                Ok(next_moment_order)
            }
            CaptureMomentOrderCursor::Exhausted => Err(DomainError::StateCorrupt {
                reason: "capture batch moment order overflowed",
            }),
        }
    }

    fn producer_id(&mut self, tx: &Transaction<'_>) -> Result<&str, DomainError> {
        if self.producer_id.is_none() {
            self.producer_id = Some(capture_producer_id(tx, &self.workspace_id)?);
        }
        Ok(self
            .producer_id
            .as_deref()
            .expect("capture producer was initialized"))
    }
}

impl<'a> From<&'a WriteText> for ProjectedWriteText<'a> {
    fn from(input: &'a WriteText) -> Self {
        Self {
            workspace_id: &input.workspace_id,
            version_id: &input.version_id,
            object_id: &input.object_id,
            path: Cow::Borrowed(&input.path),
            text: Cow::Borrowed(&input.text),
            moment_id: &input.moment_id,
            metadata_origin: &input.metadata_origin,
            metadata_summary: input.metadata_summary.as_deref(),
            metadata_correlation_id: input.metadata_correlation_id.as_deref(),
            author_json: input.author_json.as_deref(),
            now_ms: input.now_ms,
            request_id: input.request_id.as_deref(),
        }
    }
}

/// Validate a write and normalize only its path through the R07
/// plaintext-storable path floor. The document body stays borrowed or owned as
/// supplied, so validation never copies it.
fn normalized_write_input<'a>(
    mut input: ProjectedWriteText<'a>,
) -> Result<ProjectedWriteText<'a>, DomainError> {
    validate_identifier(input.workspace_id, "workspace_id")?;
    validate_identifier(input.version_id, "version_id")?;
    bounded_identifier(input.object_id, "object_id")?;
    validate_moment_id(input.moment_id)?;
    validate_moment_metadata(
        input.metadata_origin,
        input.metadata_summary,
        input.metadata_correlation_id,
        input.author_json,
    )?;
    input.path = Cow::Owned(validate_plaintext_storable_path(&input.path)?);
    validate_text(&input.text)?;
    Ok(input)
}

/// Validate caller-supplied text, identifiers, metadata, and the storable path.
///
/// Rejects [`CAPTURE_ORIGIN`] without accessing storage or changing the input.
/// Version existence and stored-state checks happen during the write. Trusted
/// transaction callers use this check before accepting ordinary user writes.
pub fn validate_write_input(input: &WriteText) -> Result<(), DomainError> {
    reject_reserved_capture_origin(&input.metadata_origin)?;
    normalized_write_input(input.into()).map(|_| ())
}

fn normalized_capture_ingest(input: &CaptureIngest) -> Result<CaptureIngest, DomainError> {
    validate_identifier(&input.workspace_id, "workspace_id")?;
    validate_identifier(&input.version_id, "version_id")?;
    validate_moment_metadata(
        input.metadata_origin.as_str(),
        input.metadata_summary.as_deref(),
        input.metadata_correlation_id.as_deref(),
        input.author_json.as_deref(),
    )?;
    let mut normalized = input.clone();
    normalized.path = validate_plaintext_storable_path(&input.path)?;
    validate_text(&normalized.text)?;
    Ok(normalized)
}

fn normalized_capture_retire(input: &CaptureRetire) -> Result<CaptureRetire, DomainError> {
    validate_identifier(&input.workspace_id, "workspace_id")?;
    validate_identifier(&input.version_id, "version_id")?;
    validate_moment_metadata(
        CAPTURE_ORIGIN,
        input.metadata_summary.as_deref(),
        input.metadata_correlation_id.as_deref(),
        None,
    )?;
    let mut normalized = input.clone();
    normalized.path = validate_addressable_plaintext_path(&input.path)?;
    Ok(normalized)
}

/// Record observed text in the caller's transaction without an admission check.
///
/// Uses [`capture_ingest_with_admission_in_tx`] with an accepting callback.
/// The caller owns lease checks, related effects, and transaction completion.
/// Roll back the enclosing transaction or savepoint on error.
pub fn capture_ingest_in_tx(
    tx: &Transaction<'_>,
    input: &CaptureIngest,
) -> Result<WriteResult, DomainError> {
    capture_ingest_with_admission_in_tx(tx, input, |_, _, _| Ok::<(), DomainError>(()))
}

/// Record observed text after caller-supplied admission, in the caller's transaction.
///
/// Validation and matching request replay precede admission. Replay returns the
/// recorded result without calling `admit`. Otherwise `admit` receives workspace,
/// version, and the existing alias's object id or the path's stable capture id.
/// It runs before object resolution, allocation, and any needed disambiguation.
/// Admission returns `E` directly; domain errors convert through `E: From<DomainError>`.
///
/// A head with a different `metadata_origin` is refused unless
/// `claim_foreign_head` is set. Equal text returns the existing head; a claimed
/// equal-text head can still update its stored origin. The caller supplies the
/// disk observation and owns lease policy and related transaction effects.
/// Roll back the enclosing transaction or savepoint on error.
pub fn capture_ingest_with_admission_in_tx<E>(
    tx: &Transaction<'_>,
    input: &CaptureIngest,
    admit: impl FnOnce(&str, &str, &str) -> Result<(), E>,
) -> Result<WriteResult, E>
where
    E: From<DomainError>,
{
    capture_ingest_with_context_and_admission_in_tx(tx, input, None, admit)
}

/// Record one text observation using this batch's producer and proposed order.
///
/// Uses the admission, ownership, and replay rules of
/// [`capture_ingest_with_admission_in_tx`]. The input must match the batch's
/// workspace and version. This function does not advance the batch cursor.
///
/// The caller owns rollback scopes and calls [`CaptureIngestBatchContext::commit_result`]
/// after accepting the item. Follow that method's distinct all-or-none and
/// partial-success orders. Roll back the enclosing transaction or savepoint on error.
pub fn capture_ingest_in_batch_with_admission_in_tx<E>(
    tx: &Transaction<'_>,
    input: &CaptureIngest,
    batch: &mut CaptureIngestBatchContext,
    admit: impl FnOnce(&str, &str, &str) -> Result<(), E>,
) -> Result<WriteResult, E>
where
    E: From<DomainError>,
{
    capture_ingest_with_context_and_admission_in_tx(tx, input, Some(batch), admit)
}

fn capture_ingest_with_context_and_admission_in_tx<E>(
    tx: &Transaction<'_>,
    input: &CaptureIngest,
    mut batch: Option<&mut CaptureIngestBatchContext>,
    admit: impl FnOnce(&str, &str, &str) -> Result<(), E>,
) -> Result<WriteResult, E>
where
    E: From<DomainError>,
{
    let input = normalized_capture_ingest(input)?;
    if batch
        .as_deref()
        .is_some_and(|batch| !batch.validates(&input))
    {
        return Err(DomainError::InvalidInput {
            reason: "capture batch coordinates do not match",
        }
        .into());
    }
    if batch.is_none() && !version_exists(tx, &input.workspace_id, &input.version_id)? {
        return Err(DomainError::VersionNotFound.into());
    }
    let (author_kind, author_json) = match input.author_json.as_deref() {
        Some(author_json) => (b"some".as_slice(), author_json.as_bytes()),
        None => (b"none".as_slice(), b"".as_slice()),
    };
    // Frame extended with the summary/correlation provenance fields: the
    // capture sink passes request_id: None, so no store holds recorded
    // capture-ingest requests and no legacy-hash compatibility shim is owed
    // (same reasoning as the capture-retire frame below).
    let (summary_kind, summary) = hash_optional_text_fields(input.metadata_summary.as_deref());
    let (correlation_kind, correlation) =
        hash_optional_text_fields(input.metadata_correlation_id.as_deref());
    let payload_hash = hash_request_fields(
        input.request_id.as_deref(),
        &[
            b"capture-ingest",
            input.workspace_id.as_bytes(),
            input.version_id.as_bytes(),
            input.path.as_bytes(),
            input.text.as_bytes(),
            input.metadata_origin.as_bytes(),
            summary_kind,
            summary,
            correlation_kind,
            correlation,
            author_kind,
            author_json,
            if input.claim_foreign_head {
                b"claim-foreign".as_slice()
            } else {
                b"own-only".as_slice()
            },
        ],
    );
    if let Some(request_id) = &input.request_id
        && let Some(recorded) = lookup_request(tx, request_id)?
    {
        if recorded.payload_hash != payload_hash {
            return Err(DomainError::IdempotencyKeyReuseMismatch.into());
        }
        return reconstruct_capture_write(tx, &input.workspace_id, recorded.result_seq)
            .map_err(E::from);
    }

    let existing_alias = alias_object_id(tx, &input.workspace_id, &input.version_id, &input.path)?;
    let target_object_id = existing_alias.clone().unwrap_or_else(|| {
        derive_capture_object_id(&input.workspace_id, &input.version_id, &input.path)
    });
    admit(&input.workspace_id, &input.version_id, &target_object_id)?;

    let resolved = resolve_capture_object(
        tx,
        &input.workspace_id,
        &input.version_id,
        &input.path,
        input.now_ms,
        existing_alias,
        batch.as_deref_mut(),
    )?;
    let before = if resolved.known_object.is_some() {
        None
    } else {
        get_snapshot(
            tx,
            &input.workspace_id,
            &input.version_id,
            &resolved.object_id,
        )?
    };
    // OWNERSHIP: capture only overwrites heads written with its own origin.
    // A head that arrived by another route (RPC, replication) may have no
    // disk counterpart at all, so letting disk bytes overwrite it would
    // silently revert that write.
    if let Some(existing) = &before
        && existing.metadata_origin != input.metadata_origin
        && !input.claim_foreign_head
    {
        return Err(DomainError::CaptureNotOwned.into());
    }
    let content_sha256 = text_blob_sha256(&input.text);
    if let Some(before) = &before
        && before.content_kind == "text"
        && before.blob_sha256.as_deref() == Some(content_sha256.as_str())
    {
        // A claimed dedupe transfers ownership: capture observed the disk
        // transition and the content already matches, so the head becomes
        // capture-owned. Without this the head would stay foreign forever
        // and later disk-driven retires would be refused.
        if input.claim_foreign_head && before.metadata_origin != input.metadata_origin {
            tx.execute(
                "UPDATE snapshots SET metadata_origin = ?1, \
                 metadata_summary = NULL, metadata_correlation_id = NULL \
                 WHERE workspace_id = ?2 AND version_id = ?3 AND object_id = ?4",
                params![
                    input.metadata_origin,
                    input.workspace_id,
                    input.version_id,
                    resolved.object_id
                ],
            )
            .map_err(DomainError::sql_persist)?;
        }
        let result = write_result_for_existing_head(tx, before)?;
        record_request(
            tx,
            input.request_id.as_deref(),
            &payload_hash,
            result.moment.moment_order,
            input.now_ms,
        )?;
        return Ok(result);
    }

    // TS `writeIfChanged` parity: an explicit pass summary (a reconcile)
    // always wins; otherwise a binary-tracked path whose bytes round-trip as
    // UTF-8 again gets the honest transition label, and a plain live text
    // update carries NO summary (the renderer's copy for null is
    // "Edited <basename>").
    let metadata_summary = match &input.metadata_summary {
        Some(summary) => Some(summary.clone()),
        None => before
            .as_ref()
            .is_some_and(|head| head.content_kind == "binary")
            .then(|| "Became a text file".to_owned()),
    };
    let now_ms = input.now_ms.to_string();
    let (actual_summary_kind, actual_summary) =
        hash_optional_text_fields(metadata_summary.as_deref());
    let mutation_identity = hash_fields(&[
        input.path.as_bytes(),
        content_sha256.as_bytes(),
        input.metadata_origin.as_bytes(),
        actual_summary_kind,
        actual_summary,
        correlation_kind,
        correlation,
        author_kind,
        author_json,
        now_ms.as_bytes(),
    ]);
    let next_order = match resolved.reserved_moment_order {
        Some(next_order) => next_order,
        None => match batch.as_deref_mut() {
            Some(batch) => batch.proposed_moment_order(tx)?,
            None => next_moment_order(tx)?,
        },
    };
    let producer_id = match batch {
        Some(batch) => Cow::Borrowed(batch.producer_id(tx)?),
        None => Cow::Owned(capture_producer_id(tx, &input.workspace_id)?),
    };
    let moment_id = derive_capture_moment_id(
        producer_id.as_ref(),
        &input.workspace_id,
        &resolved.object_id,
        next_order,
        "write",
        &mutation_identity,
    );
    let write = normalized_write_input(ProjectedWriteText {
        workspace_id: &input.workspace_id,
        version_id: &input.version_id,
        object_id: &resolved.object_id,
        path: Cow::Borrowed(&input.path),
        text: Cow::Borrowed(&input.text),
        moment_id: &moment_id,
        metadata_origin: &input.metadata_origin,
        metadata_summary: metadata_summary.as_deref(),
        metadata_correlation_id: input.metadata_correlation_id.as_deref(),
        author_json: input.author_json.as_deref(),
        now_ms: input.now_ms,
        request_id: None,
    })?;
    let result = write_normalized_text_in_tx(
        tx,
        write,
        false,
        None,
        Some(PreparedTextWrite {
            object_id: resolved.object_id.clone(),
            before,
            moment_order: next_order,
            content_sha256,
            bind_object: false,
            bind_alias: false,
            known_object: resolved.known_object,
        }),
    )?;
    if result.moment.moment_order != next_order {
        return Err(DomainError::StateCorrupt {
            reason: "capture moment order diverged from reserved order",
        }
        .into());
    }
    record_request(
        tx,
        input.request_id.as_deref(),
        &payload_hash,
        result.moment.moment_order,
        input.now_ms,
    )?;
    Ok(result)
}

/// Record a path's absence in the caller's transaction, deriving a delete moment.
///
/// Matching request replay returns the recorded deletion or recorded no-op.
/// A missing path returns `retired: None`. `only_if_text_head` excludes binary
/// heads. With `only_if_capture_origin`, only capture heads qualify unless
/// `allow_ydoc_origin` also permits Y.Doc heads. Excluded heads return the same
/// no-op shape. The caller chooses these filters for the observed absence.
///
/// The deletion uses the existing domain delete path. The caller owns related
/// effects and transaction completion. Roll back the transaction or savepoint on error.
pub fn capture_retire_in_tx(
    tx: &Transaction<'_>,
    input: &CaptureRetire,
) -> Result<CaptureRetireResult, DomainError> {
    let input = normalized_capture_retire(input)?;
    if !version_exists(tx, &input.workspace_id, &input.version_id)? {
        return Err(DomainError::VersionNotFound);
    }
    // Frame extended (head-scope discriminator, then the summary/correlation
    // provenance fields): no store outside tests has recorded capture-retire
    // requests (the sink passes request_id: None), so no legacy-hash
    // compatibility shim is owed.
    let (summary_kind, summary) = hash_optional_text_fields(input.metadata_summary.as_deref());
    let (correlation_kind, correlation) =
        hash_optional_text_fields(input.metadata_correlation_id.as_deref());
    let payload_hash = hash_fields(&[
        b"capture-retire",
        input.workspace_id.as_bytes(),
        input.version_id.as_bytes(),
        input.path.as_bytes(),
        b"capture",
        summary_kind,
        summary,
        correlation_kind,
        correlation,
        b"none",
        b"",
        if input.only_if_text_head {
            b"text-only".as_slice()
        } else {
            b"any-head".as_slice()
        },
        if input.only_if_capture_origin {
            b"capture-origin-only".as_slice()
        } else {
            b"any-origin".as_slice()
        },
    ]);
    if let Some(request_id) = &input.request_id
        && let Some(recorded) = lookup_request(tx, request_id)?
    {
        if recorded.payload_hash != payload_hash {
            return Err(DomainError::IdempotencyKeyReuseMismatch);
        }
        let retired = if recorded.result_seq == 0 {
            None
        } else {
            Some(reconstruct_capture_delete(
                tx,
                &input.workspace_id,
                recorded.result_seq,
            )?)
        };
        return Ok(CaptureRetireResult {
            retired,
            deduped: true,
        });
    }

    let Some(object_id) = alias_object_id(tx, &input.workspace_id, &input.version_id, &input.path)?
    else {
        record_request(
            tx,
            input.request_id.as_deref(),
            &payload_hash,
            0,
            input.now_ms,
        )?;
        return Ok(CaptureRetireResult {
            retired: None,
            deduped: false,
        });
    };
    if input.only_if_text_head || input.only_if_capture_origin {
        let head = get_snapshot(tx, &input.workspace_id, &input.version_id, &object_id)?.ok_or(
            DomainError::StateCorrupt {
                reason: "path alias points at a missing snapshot",
            },
        )?;
        // A head this caller does not own (written by RPC/replication) is
        // never destroyed by a disk-driven retire. DISK-OWNED origins pass:
        // capture heads, and materialized Y.Doc heads — the manifest seeds
        // 'ydoc' rows precisely so the baseline scanner tracks their files,
        // and a file deleted while the daemon was down must retire the head
        // rather than leave a stale snapshot readable forever.
        if input.only_if_capture_origin
            && head.metadata_origin != CAPTURE_ORIGIN
            && !(input.allow_ydoc_origin && head.metadata_origin == YDOC_ORIGIN)
        {
            record_request(
                tx,
                input.request_id.as_deref(),
                &payload_hash,
                0,
                input.now_ms,
            )?;
            return Ok(CaptureRetireResult {
                retired: None,
                deduped: false,
            });
        }
        if input.only_if_text_head && head.content_kind != "text" {
            // A live non-text head is not the caller's to retire; settle as a
            // no-op exactly like an absent path.
            record_request(
                tx,
                input.request_id.as_deref(),
                &payload_hash,
                0,
                input.now_ms,
            )?;
            return Ok(CaptureRetireResult {
                retired: None,
                deduped: false,
            });
        }
    }
    let next_order = next_moment_order(tx)?;
    let producer_id = capture_producer_id(tx, &input.workspace_id)?;
    let now_ms = input.now_ms.to_string();
    let mutation_identity = hash_fields(&[
        input.path.as_bytes(),
        summary_kind,
        summary,
        correlation_kind,
        correlation,
        now_ms.as_bytes(),
    ]);
    let moment_id = derive_capture_retire_moment_id(
        &producer_id,
        &input.workspace_id,
        &object_id,
        next_order,
        "delete",
        &mutation_identity,
    );
    let delete = DeleteTextFile {
        workspace_id: input.workspace_id.clone(),
        version_id: input.version_id.clone(),
        path: input.path,
        moment_id,
        request_id: None,
        metadata_origin: "capture".to_owned(),
        metadata_summary: input.metadata_summary.clone(),
        metadata_correlation_id: input.metadata_correlation_id.clone(),
        author_json: None,
        now_ms: input.now_ms,
    };
    let result = delete_text_in_tx(tx, &delete)?;
    if result.moment.moment_order != next_order {
        return Err(DomainError::StateCorrupt {
            reason: "capture moment order diverged from reserved order",
        });
    }
    record_request(
        tx,
        input.request_id.as_deref(),
        &payload_hash,
        result.moment.moment_order,
        input.now_ms,
    )?;
    Ok(CaptureRetireResult {
        retired: Some(result),
        deduped: false,
    })
}

/// The origin used to identify capture-owned heads.
///
/// [`VersionedTextStore::write_text`] and [`validate_write_input`] reject this
/// origin for ordinary caller-supplied writes. The transaction write functions
/// accept trusted origins and do not enforce that reservation themselves.
///
/// Capture ingest compares the input's origin with the existing head, with
/// `claim_foreign_head` controlling mismatches. Retirement applies its own
/// capture and Y.Doc origin filters.
pub const CAPTURE_ORIGIN: &str = "capture";

/// The metadata origin stamped by Y.Doc settles. Materialized Y.Doc heads are
/// DISK-OWNED like capture heads: the manifest seeds them into the baseline
/// scanner, and disk-driven retires may destroy them.
pub const YDOC_ORIGIN: &str = "ydoc";

/// Maximum binary payload a capture ingest may persist. Mirrors
/// `MAX_VERSIONED_BINARY_FILE_BYTES` (`versionedTextStore.ts`) and the files
/// crate's `MAX_CAPTURE_BINARY_BYTES`. Replication applies it too: blob ingest
/// and share replay both refuse a binary above this ceiling. The storage blob
/// cap (64 MiB) is what remains for writers neither path covers.
pub const MAX_CAPTURE_BINARY_FILE_BYTES: usize = 5 * 1024 * 1024;

/// Record observed binary content without admission, in the caller's transaction.
///
/// Uses [`capture_ingest_binary_with_admission_in_tx`] with an accepting callback,
/// including its completed materialization evidence. The caller owns lease checks
/// and related effects. Roll back the transaction or savepoint on error.
pub fn capture_ingest_binary_in_tx(
    tx: &Transaction<'_>,
    input: &CaptureIngestBinary,
) -> Result<CaptureIngestBinaryResult, DomainError> {
    capture_ingest_binary_with_admission_in_tx(tx, input, |_, _, _| Ok::<(), DomainError>(()))
}

/// Record observed binary content after admission, in the caller's transaction.
///
/// Validates the coordinate, path, binary size cap, and version before replay.
/// Matching request replay returns the recorded result without calling `admit`.
/// Otherwise admission receives workspace, version, and the existing alias's
/// object id or stable capture id, before object resolution and disambiguation.
/// Admission returns `E` directly; domain errors convert through `E: From<DomainError>`.
///
/// A differing head origin is refused unless `claim_foreign_head` is set.
/// Equal binary content retains the existing head and origin. Both an equal-content
/// observation and a new binary head record a completed materialization job for
/// the observed generation. This evidence lets older pending jobs be superseded;
/// capture enqueues no pending disk write. Request replay skips this work.
///
/// The caller supplies the disk observation and owns lease policy and related
/// effects. Roll back the enclosing transaction or savepoint on error.
pub fn capture_ingest_binary_with_admission_in_tx<E>(
    tx: &Transaction<'_>,
    input: &CaptureIngestBinary,
    admit: impl FnOnce(&str, &str, &str) -> Result<(), E>,
) -> Result<CaptureIngestBinaryResult, E>
where
    E: From<DomainError>,
{
    use crate::conflicts::{PersistBinaryHead, persist_binary_head_in_tx};

    validate_identifier(&input.workspace_id, "workspace_id")?;
    validate_identifier(&input.version_id, "version_id")?;
    let path = validate_plaintext_storable_path(&input.path)?;
    if input.bytes.len() > MAX_CAPTURE_BINARY_FILE_BYTES {
        return Err(DomainError::InvalidInput {
            reason: "binary bytes exceed the capture cap",
        }
        .into());
    }
    if !version_exists(tx, &input.workspace_id, &input.version_id)? {
        return Err(DomainError::VersionNotFound.into());
    }
    let binary_sha256 = dohc_engine_storage::hex_sha256(&input.bytes);
    let (author_kind, author_json) = match input.author_json.as_deref() {
        Some(author_json) => (b"some".as_slice(), author_json.as_bytes()),
        None => (b"none".as_slice(), b"".as_slice()),
    };
    // Frame extended with summary/correlation; see `capture_ingest_in_tx`.
    let (summary_kind, summary) = hash_optional_text_fields(input.metadata_summary.as_deref());
    let (correlation_kind, correlation) =
        hash_optional_text_fields(input.metadata_correlation_id.as_deref());
    let payload_hash = hash_fields(&[
        b"capture-ingest-binary",
        input.workspace_id.as_bytes(),
        input.version_id.as_bytes(),
        path.as_bytes(),
        binary_sha256.as_bytes(),
        input.metadata_origin.as_bytes(),
        summary_kind,
        summary,
        correlation_kind,
        correlation,
        author_kind,
        author_json,
        if input.claim_foreign_head {
            b"claim-foreign".as_slice()
        } else {
            b"own-only".as_slice()
        },
    ]);
    if let Some(request_id) = &input.request_id
        && let Some(recorded) = lookup_request(tx, request_id)?
    {
        if recorded.payload_hash != payload_hash {
            return Err(DomainError::IdempotencyKeyReuseMismatch.into());
        }
        return reconstruct_capture_binary(tx, &input.workspace_id, recorded.result_seq)
            .map_err(E::from);
    }

    let existing_alias = alias_object_id(tx, &input.workspace_id, &input.version_id, &path)?;
    let target_object_id = existing_alias
        .clone()
        .unwrap_or_else(|| derive_capture_object_id(&input.workspace_id, &input.version_id, &path));
    admit(&input.workspace_id, &input.version_id, &target_object_id)?;

    let ResolvedCaptureObject {
        object_id,
        reserved_moment_order,
        ..
    } = resolve_capture_object(
        tx,
        &input.workspace_id,
        &input.version_id,
        &path,
        input.now_ms,
        existing_alias,
        None,
    )?;
    let before = get_snapshot(tx, &input.workspace_id, &input.version_id, &object_id)?;
    if let Some(existing) = &before
        && existing.metadata_origin != input.metadata_origin
        && !input.claim_foreign_head
    {
        return Err(DomainError::CaptureNotOwned.into());
    }
    if let Some(before) = &before {
        // Fail closed on partial head identity, mirroring the binary writer.
        match before.content_kind.as_str() {
            "text" if before.blob_sha256.is_some() => {}
            "binary" if before.binary_sha256.is_some() => {}
            "text" => {
                return Err(DomainError::StateCorrupt {
                    reason: "text snapshot is missing its blob",
                }
                .into());
            }
            "binary" => {
                return Err(DomainError::StateCorrupt {
                    reason: "binary snapshot is missing its blob",
                }
                .into());
            }
            _ => {
                return Err(DomainError::StateCorrupt {
                    reason: "snapshot has an unknown content kind",
                }
                .into());
            }
        }
        if before.content_kind == "binary"
            && before.binary_sha256.as_deref() == Some(binary_sha256.as_str())
        {
            // Content-equality no-op: the interleave-safety guarantee.
            let result_sha = binary_sha256.clone();
            let moment = get_moment(tx, &input.workspace_id, &before.latest_moment_id)?.ok_or(
                DomainError::StateCorrupt {
                    reason: "snapshot points at a missing moment",
                },
            )?;
            // The head's bytes are verified on disk right now, so record the
            // head generation as materialized (upsert: the creating write's
            // own job may still be pending — its content is this same sha —
            // and flipping it complete both records reality and lets the
            // staleness gate supersede any older pending job that could
            // otherwise regress disk behind the confirmed head).
            dohc_engine_storage::record_completed_job(
                tx,
                &MaterializationJobSpec {
                    job_id: moment.moment_id.clone(),
                    workspace_id: input.workspace_id.clone(),
                    target_path: path.clone(),
                    content_sha256: result_sha.clone(),
                    preimage: Preimage::Present(result_sha.clone()),
                    target_generation: moment.moment_order,
                    now_ms: input.now_ms,
                },
            )
            .map_err(DomainError::from)?;
            let result = CaptureIngestBinaryResult {
                object_id: object_id.clone(),
                moment_id: moment.moment_id.clone(),
                moment_order: moment.moment_order,
                binary_sha256: result_sha,
                deduped: true,
            };
            record_request(
                tx,
                input.request_id.as_deref(),
                &payload_hash,
                result.moment_order,
                input.now_ms,
            )?;
            return Ok(result);
        }
    }

    put_binary_blob(tx, &input.bytes).map_err(DomainError::from)?;
    let next_order = match reserved_moment_order {
        Some(next_order) => next_order,
        None => next_moment_order(tx)?,
    };
    // TS `writeIfChanged` parity: pass summary wins; a text-tracked path
    // whose bytes stop round-tripping as UTF-8 keeps its object identity and
    // the moment says so honestly; a plain binary update is labeled per file.
    let metadata_summary = input.metadata_summary.clone().unwrap_or_else(|| {
        if before
            .as_ref()
            .is_some_and(|head| head.content_kind != "binary")
        {
            "Became a binary file".to_owned()
        } else {
            format!("Updated {}", path_basename(&path))
        }
    });
    let now_ms = input.now_ms.to_string();
    let mutation_identity = hash_fields(&[
        path.as_bytes(),
        binary_sha256.as_bytes(),
        input.metadata_origin.as_bytes(),
        metadata_summary.as_bytes(),
        correlation_kind,
        correlation,
        author_kind,
        author_json,
        now_ms.as_bytes(),
    ]);
    let producer_id = capture_producer_id(tx, &input.workspace_id)?;
    let moment_id = derive_capture_moment_id(
        &producer_id,
        &input.workspace_id,
        &object_id,
        next_order,
        "write-binary",
        &mutation_identity,
    );
    if moment_exists(tx, &input.workspace_id, &moment_id)? {
        return Err(DomainError::DuplicateMomentId.into());
    }
    let before_head = before.map(|before| {
        (
            before.content_kind,
            before.blob_sha256,
            before.binary_sha256,
            before.latest_moment_id,
        )
    });
    let moment_order = persist_binary_head_in_tx(
        tx,
        &PersistBinaryHead {
            workspace_id: &input.workspace_id,
            version_id: &input.version_id,
            object_id: &object_id,
            path: &path,
            binary_sha256: &binary_sha256,
            moment_id: &moment_id,
            metadata_origin: &input.metadata_origin,
            metadata_summary: Some(metadata_summary.as_str()),
            metadata_correlation_id: input.metadata_correlation_id.as_deref(),
            author_json: input.author_json.as_deref(),
            now_ms: input.now_ms,
        },
        before_head,
    )?;
    if moment_order != next_order {
        return Err(DomainError::StateCorrupt {
            reason: "capture moment order diverged from reserved order",
        }
        .into());
    }
    // Disk already holds these bytes, so record the materialization as a
    // completed job (never runnable). The marker is what the materializer's
    // staleness gate reads: an older still-pending job for this path — whose
    // preimage may match the very bytes just captured — is superseded instead
    // of later running and regressing disk behind this head.
    dohc_engine_storage::record_completed_job(
        tx,
        &MaterializationJobSpec {
            job_id: moment_id.clone(),
            workspace_id: input.workspace_id.clone(),
            target_path: path.clone(),
            content_sha256: binary_sha256.clone(),
            preimage: Preimage::Present(binary_sha256.clone()),
            target_generation: moment_order,
            now_ms: input.now_ms,
        },
    )
    .map_err(DomainError::from)?;
    record_request(
        tx,
        input.request_id.as_deref(),
        &payload_hash,
        moment_order,
        input.now_ms,
    )?;
    Ok(CaptureIngestBinaryResult {
        object_id,
        moment_id,
        moment_order,
        binary_sha256,
        deduped: false,
    })
}

/// One rehydration-seed entry for the files-layer scan manifest: the path,
/// the captured content's byte size, and its lowercase-hex sha256 in the
/// scanner's own terms (text = the blob bytes, binary = the binary blob).
/// Secrets carry a sentinel sha (plaintext hashes are deliberately never
/// stored), so a reopened workspace re-offers each secret once and the
/// encrypted store's content-equality dedupe settles it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureManifestSeedEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// The sentinel recorded for secret seeds (never a valid hex digest, so the
/// first scan always re-offers the path).
pub const SECRET_SEED_SENTINEL_SHA: &str = "rehydrated-secret";

/// Read the initial scan manifest for one workspace and version.
///
/// Includes capture heads, eligible Y.Doc heads, and capture-owned secret tips.
/// Other origins are excluded because their content may never have reached disk.
/// A Y.Doc head is excluded while its matching producer write remains pending.
/// Matching pending rollback restores also exclude their destination heads.
///
/// Pending rollback deletes contribute transient last-known-disk entries when
/// their target has no alias in this version. These entries keep that path out
/// of capture until the compensating job becomes terminal; they create no head.
/// Secret entries use [`SECRET_SEED_SENTINEL_SHA`] so the next scan re-offers them.
///
/// This reads stored state through `EngineStore::read_with`; it does not scan disk.
pub fn capture_manifest_seed(
    store: &EngineStore,
    workspace_id: &str,
    version_id: &str,
) -> Result<Vec<CaptureManifestSeedEntry>, DomainError> {
    let ws = workspace_id.to_owned();
    let version = version_id.to_owned();
    let rollback_version_prefix = binary_rollback_job_version_prefix(&ws, &version);
    store.read_with(move |conn| {
        let mut entries = Vec::new();
        let mut stmt = conn
            .prepare(
                "SELECT a.path, COALESCE(s.content_kind, 'text'), \
                        s.blob_sha256, tb.byte_length, \
                        s.binary_sha256, bb.byte_length \
                 FROM path_aliases a \
                 JOIN snapshots s ON s.workspace_id = a.workspace_id \
                   AND s.version_id = a.version_id AND s.object_id = a.object_id \
                 LEFT JOIN blobs tb ON tb.sha256 = s.blob_sha256 \
                 LEFT JOIN binary_blobs bb ON bb.sha256 = s.binary_sha256 \
                 WHERE a.workspace_id = ?1 AND a.version_id = ?2 \
                   AND (s.metadata_origin = 'capture' \
                        OR (s.metadata_origin = 'ydoc' \
                            AND NOT EXISTS ( \
                                SELECT 1 FROM materialization_jobs j \
                                JOIN moments producer \
                                  ON producer.workspace_id = a.workspace_id \
                                 AND producer.version_id = a.version_id \
                                 AND producer.object_id = a.object_id \
                                 AND producer.moment_id = s.latest_moment_id \
                                 AND producer.moment_order = j.target_generation \
                                 AND producer.operation = 'write' \
                                WHERE j.status = 'pending' \
                                  AND j.operation = 'write' \
                                  AND (j.workspace_id = ?1 \
                                       OR j.workspace_id = '') \
                                  AND j.target_path = a.path \
                                  AND j.content_sha256 = \
                                      CASE COALESCE(s.content_kind, 'text') \
                                      WHEN 'binary' THEN s.binary_sha256 \
                                      ELSE s.blob_sha256 END))) \
                   AND NOT EXISTS ( \
                       SELECT 1 FROM materialization_jobs j \
                        WHERE j.status = 'pending' AND j.operation = 'write' \
                          AND (j.workspace_id = ?1 OR j.workspace_id = '') \
                          AND j.target_path = a.path \
                         AND j.content_sha256 = CASE COALESCE(s.content_kind, 'text') \
                             WHEN 'binary' THEN s.binary_sha256 ELSE s.blob_sha256 END \
                         AND (substr(j.job_id, 1, length(?3)) = ?3 \
                              OR substr(j.job_id, \
                                    length('binary-rename-0-write-mat_') + 1, \
                                    length(?3)) = ?3)) \
                 UNION ALL \
                 SELECT j.target_path, 'binary', NULL, NULL, \
                        j.content_sha256, bb.byte_length \
                 FROM materialization_jobs j \
                 JOIN binary_blobs bb ON bb.sha256 = j.content_sha256 \
                  WHERE j.status = 'pending' AND j.operation = 'delete' \
                    AND (j.workspace_id = ?1 OR j.workspace_id = '') \
                     AND (substr(j.job_id, 1, length(?3)) = ?3 \
                         OR substr(j.job_id, \
                               length('binary-rename-1-delete-mat_') + 1, \
                               length(?3)) = ?3) \
                    AND NOT EXISTS ( \
                        SELECT 1 FROM path_aliases a \
                        WHERE a.workspace_id = ?1 AND a.version_id = ?2 \
                         AND a.path = j.target_path) \
                 ORDER BY 1",
            )
            .map_err(DomainError::sql_corrupt)?;
        let rows = stmt
            .query_map(params![ws, version, rollback_version_prefix], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            })
            .map_err(DomainError::sql_corrupt)?;
        for row in rows {
            let (path, kind, text_sha, text_len, binary_sha, binary_len) =
                row.map_err(DomainError::sql_corrupt)?;
            let (sha256, size) = match kind.as_str() {
                "binary" => match (binary_sha, binary_len) {
                    (Some(sha), Some(len)) => (sha, len.max(0) as u64),
                    _ => continue,
                },
                _ => match (text_sha, text_len) {
                    (Some(sha), Some(len)) => (sha, len.max(0) as u64),
                    _ => continue,
                },
            };
            entries.push(CaptureManifestSeedEntry { path, size, sha256 });
        }
        // Same capture-ownership rule for the encrypted store: a tip written
        // by the API or replication may legitimately have no plaintext on
        // disk, and seeding it would make the baseline diff retire it. Keyed
        // on the engine-stamped `capture_owned` column, never on the
        // caller-supplied origin string.
        let mut secrets = conn
            .prepare(
                "SELECT f.path, f.byte_length FROM secret_files f \
                 JOIN secret_moments m ON m.workspace_id = f.workspace_id \
                   AND m.moment_id = f.latest_moment_id \
                 WHERE f.workspace_id = ?1 AND f.version_id = ?2 \
                   AND m.capture_owned = 1",
            )
            .map_err(DomainError::sql_corrupt)?;
        let rows = secrets
            .query_map(params![ws, version], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(DomainError::sql_corrupt)?;
        for row in rows {
            let (path, len) = row.map_err(DomainError::sql_corrupt)?;
            entries.push(CaptureManifestSeedEntry {
                path,
                size: len.max(0) as u64,
                sha256: SECRET_SEED_SENTINEL_SHA.to_owned(),
            });
        }
        Ok(entries)
    })
}

fn reconstruct_capture_binary(
    conn: &Connection,
    workspace_id: &str,
    moment_order: i64,
) -> Result<CaptureIngestBinaryResult, DomainError> {
    let moment =
        moment_by_order(conn, workspace_id, moment_order)?.ok_or(DomainError::StateCorrupt {
            reason: "deduped capture has no moment",
        })?;
    if moment.after_content_kind != "binary" {
        return Err(DomainError::StateCorrupt {
            reason: "deduped binary capture points at non-binary content",
        });
    }
    let binary_sha256 = moment
        .after_binary_sha256
        .clone()
        .ok_or(DomainError::StateCorrupt {
            reason: "deduped binary capture moment has no binary blob",
        })?;
    Ok(CaptureIngestBinaryResult {
        object_id: moment.object_id,
        moment_id: moment.moment_id,
        moment_order: moment.moment_order,
        binary_sha256,
        deduped: true,
    })
}

/// Persist text and history inside a caller-owned compound transaction.
///
/// Validates and normalizes the input, then handles request replay, matching
/// existing moments, and persistence. A new path requires an object id not already
/// present in the workspace.
/// The returned snapshot owns its text even when the input borrows it.
///
/// This is a trusted composition entry point: it accepts the supplied origin.
/// Use [`validate_write_input`] when accepting ordinary caller-supplied writes.
/// The caller owns related conflict, search indexing, journal, and materialization work.
/// Roll back the enclosing transaction or savepoint on error.
pub fn write_text_in_tx(
    tx: &Transaction<'_>,
    input: &WriteText,
) -> Result<WriteResult, DomainError> {
    let input = normalized_write_input(input.into())?;
    write_normalized_text_in_tx(tx, input, false, None, None)
}

/// Copy a stored text preimage forward without changing its object identity.
pub fn write_history_text_in_tx(
    tx: &Transaction<'_>,
    input: &WriteText,
    restore_before_moment_id: &str,
) -> Result<WriteResult, DomainError> {
    validate_moment_id(restore_before_moment_id)?;
    let source = get_moment(tx, &input.workspace_id, restore_before_moment_id)?.ok_or(
        DomainError::InvalidInput {
            reason: "history moment is unavailable",
        },
    )?;
    let normalized = normalized_write_input(input.into())?;
    if source.version_id != input.version_id
        || source.path != normalized.path
        || source.operation == MomentOp::Rename
        || source.sync_record_only
        || !source.before_present
        || source.before_content_kind != "text"
        || source.before_blob_sha256.as_deref() != Some(text_blob_sha256(&input.text).as_str())
        || input.metadata_origin != "restore"
    {
        return Err(DomainError::InvalidInput {
            reason: "history restore does not match its preimage",
        });
    }
    let mut normalized = normalized;
    normalized.object_id = &source.object_id;
    write_normalized_text_in_tx(tx, normalized, false, Some(&source), None)
}

/// Persist a text projection inside the caller's transaction.
///
/// Accepts [`ProjectedWriteText`] or a borrowed [`WriteText`]. For a new path,
/// an existing object row is allowed only when no alias or snapshot binds it in
/// the workspace. This supports the object preallocated for a live Y.Doc seed.
///
/// Uses the same validation, replay, hydration, and persistence as ordinary text
/// writes. For a new write, an owned document body moves into the result.
/// Runtime and sync own Y.Doc persistence, related effects, and disk work.
/// This trusted entry point accepts the supplied origin, as [`write_text_in_tx`] does.
/// Roll back the enclosing transaction or savepoint on error.
pub fn write_projected_text_in_tx<'a>(
    tx: &Transaction<'_>,
    input: impl Into<ProjectedWriteText<'a>>,
) -> Result<WriteResult, DomainError> {
    // allow_preallocated_object: the live Y.Doc seed pre-creates the
    // file_objects row (FK parent for the marker) before any snapshot or
    // alias exists — the settle that follows is binding its own object,
    // not colliding with another.
    let input = normalized_write_input(input.into())?;
    write_normalized_text_in_tx(tx, input, true, None, None)
}

fn write_normalized_text_in_tx(
    tx: &Transaction<'_>,
    input: ProjectedWriteText<'_>,
    allow_preallocated_object: bool,
    history_source: Option<&MomentRecord>,
    prepared: Option<PreparedTextWrite>,
) -> Result<WriteResult, DomainError> {
    let ws = input.workspace_id;
    if prepared.is_none() && !version_exists(tx, ws, input.version_id)? {
        return Err(DomainError::VersionNotFound);
    }

    let blob = prepared
        .as_ref()
        .map(|prepared| prepared.content_sha256.clone())
        .unwrap_or_else(|| text_blob_sha256(&input.text));
    let (author_kind, author_json) = hash_author_fields(input.author_json);
    let (summary_kind, summary) = hash_optional_text_fields(input.metadata_summary);
    let (correlation_kind, correlation_id) =
        hash_optional_text_fields(input.metadata_correlation_id);
    let payload_hash = hash_request_fields(
        input.request_id,
        &[
            input.version_id.as_bytes(),
            input.path.as_bytes(),
            input.text.as_bytes(),
            input.moment_id.as_bytes(),
            input.object_id.as_bytes(),
            input.metadata_origin.as_bytes(),
            summary_kind,
            summary,
            correlation_kind,
            correlation_id,
            author_kind,
            author_json,
        ],
    );
    let payload_hash = history_source.map_or(payload_hash.clone(), |source| {
        hash_request_fields(
            input.request_id,
            &[payload_hash.as_bytes(), source.moment_id.as_bytes()],
        )
    });
    if let Some(request_id) = input.request_id
        && let Some(recorded) = lookup_request(tx, request_id)?
    {
        if recorded.payload_hash != payload_hash {
            return Err(DomainError::IdempotencyKeyReuseMismatch);
        }
        return reconstruct_write(tx, input.workspace_id, input.moment_id);
    }
    if moment_exists(tx, ws, input.moment_id)? {
        let Some(existing) = get_moment(tx, ws, input.moment_id)? else {
            // Text and protected history share one workspace-wide moment-id
            // namespace, while `get_moment` resolves only plaintext history.
            return Err(DomainError::DuplicateMomentId);
        };
        let exact = existing.version_id == input.version_id
            && existing.path == input.path.as_ref()
            && existing.operation == MomentOp::Write
            && existing.after_content_kind == "text"
            && existing.after_blob_sha256.as_deref() == Some(blob.as_str())
            && existing.metadata_origin == input.metadata_origin
            && existing.metadata_summary.as_deref() == input.metadata_summary
            && existing.metadata_correlation_id.as_deref() == input.metadata_correlation_id
            && existing.author_json.as_deref() == input.author_json;
        if exact {
            return write_result_from_moment(tx, ws, existing, true);
        }
        // The oracle's contract: a caller-supplied moment id reused with
        // different content is duplicate-moment-id (the exact-match arm above
        // is the idempotent replay; only requestId reuse maps to mismatch).
        return Err(DomainError::DuplicateMomentId);
    }

    let prepared = match prepared {
        Some(prepared) => prepared,
        None => {
            let existing_object = alias_object_id(tx, ws, input.version_id, &input.path)?;
            if history_source.is_some()
                && existing_object
                    .as_deref()
                    .is_some_and(|id| id != input.object_id)
            {
                return Err(DomainError::InvalidInput {
                    reason: "history restore path belongs to another object",
                });
            }
            let before = match &existing_object {
                Some(object_id) => get_snapshot(tx, ws, input.version_id, object_id)?,
                None => {
                    if input.object_id.is_empty() {
                        return Err(DomainError::InvalidInput {
                            reason: "object_id must not be empty for a new path",
                        });
                    }
                    if object_exists(tx, ws, input.object_id)? {
                        let bare_preallocation = allow_preallocated_object
                            && !object_has_any_binding(tx, ws, input.object_id)?;
                        let dormant_history_object = history_source.is_some()
                            && !tx.query_row(
                                "SELECT EXISTS (SELECT 1 FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3) OR EXISTS (SELECT 1 FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",
                                params![ws, input.version_id, input.object_id], |row| row.get::<_, bool>(0),
                            ).map_err(DomainError::sql_corrupt)?;
                        if !bare_preallocation && !dormant_history_object {
                            return Err(DomainError::InvalidInput {
                                reason: "object_id is already bound to another object",
                            });
                        }
                    }
                    None
                }
            };
            let is_new_object = existing_object.is_none();
            PreparedTextWrite {
                object_id: existing_object.unwrap_or_else(|| input.object_id.to_owned()),
                before,
                moment_order: next_moment_order(tx)?,
                content_sha256: blob.clone(),
                bind_object: is_new_object,
                bind_alias: true,
                known_object: None,
            }
        }
    };
    let PreparedTextWrite {
        object_id,
        before,
        moment_order,
        content_sha256: _,
        bind_object,
        bind_alias,
        known_object,
    } = prepared;
    let before_blob = before.as_ref().and_then(|s| s.blob_sha256.clone());
    let before_content_kind = before
        .as_ref()
        .map_or_else(|| "text".to_owned(), |s| s.content_kind.clone());
    let before_binary_sha256 = before.as_ref().and_then(|s| s.binary_sha256.clone());
    let before_latest_moment_id = before.as_ref().map(|s| s.latest_moment_id.clone());

    if bind_object {
        // OR IGNORE: the preallocated-object path (live Y.Doc seed) already
        // holds this row; every other new-object path inserts fresh.
        tx.execute(
            "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms)              VALUES (?1, ?2, ?3)",
            params![input.workspace_id, object_id, input.now_ms],
        )
        .map_err(DomainError::sql_persist)?;
    }
    let blob_inserted = tx
        .execute(
            "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3)",
            params![blob, input.text.len() as i64, input.text.as_ref()],
        )
        .map_err(DomainError::sql_persist)?
        != 0;
    if bind_alias {
        tx.execute(
            "INSERT OR IGNORE INTO path_aliases (workspace_id, version_id, path, object_id) \
             VALUES (?1, ?2, ?3, ?4)",
            params![
                input.workspace_id,
                input.version_id,
                input.path.as_ref(),
                object_id
            ],
        )
        .map_err(DomainError::sql_persist)?;
    }
    tx.execute(
        "INSERT INTO moments \
         (workspace_id, moment_order, moment_id, version_id, object_id, path, recorded_at_ms, \
           operation, after_blob_sha256, before_present, before_blob_sha256, \
           before_latest_moment_id, metadata_origin, metadata_summary, \
           metadata_correlation_id, author_json, sync_record_only, \
           after_content_kind, after_binary_sha256, before_content_kind, before_binary_sha256, \
           payload_before_path, payload_before_content_kind, payload_before_blob_sha256, \
           payload_after_path, payload_after_content_kind, \
           payload_after_blob_sha256) \
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'write', ?8, ?9, ?10, ?11, ?12, \
                  ?13, ?14, ?15, NULL, 'text', NULL, ?16, ?17, \
                  CASE WHEN ?9 = 2 THEN ?6 END, CASE WHEN ?9 = 2 THEN ?16 END, \
                  CASE ?16 WHEN 'binary' THEN ?17 ELSE ?10 END, ?6, 'text', ?8)",
        params![
            input.workspace_id,
            moment_order,
            input.moment_id,
            input.version_id,
            object_id,
            input.path.as_ref(),
            input.now_ms,
            blob,
            if before.is_some() { 2 } else { 1 },
            before_blob,
            before_latest_moment_id,
            input.metadata_origin,
            input.metadata_summary,
            input.metadata_correlation_id,
            input.author_json,
            before_content_kind,
            before_binary_sha256,
        ],
    )
    .map_err(DomainError::sql_persist)?;
    crate::collections::index_historical_record_owner_moment_in_tx(tx, ws, moment_order)?;
    tx.execute(
        "INSERT INTO snapshots \
         (workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms, \
           latest_moment_id, metadata_origin, metadata_summary, \
           metadata_correlation_id, content_kind, binary_sha256) \
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'text', NULL) \
         ON CONFLICT(workspace_id, version_id, object_id) DO UPDATE SET \
           path = excluded.path, blob_sha256 = excluded.blob_sha256, \
           updated_at_ms = excluded.updated_at_ms, latest_moment_id = excluded.latest_moment_id, \
           metadata_origin = excluded.metadata_origin, \
           metadata_summary = excluded.metadata_summary, \
           metadata_correlation_id = excluded.metadata_correlation_id, \
           content_kind = excluded.content_kind, \
           binary_sha256 = excluded.binary_sha256",
        params![
            input.workspace_id,
            input.version_id,
            object_id,
            input.path.as_ref(),
            blob,
            input.now_ms,
            input.moment_id,
            input.metadata_origin,
            input.metadata_summary,
            input.metadata_correlation_id,
        ],
    )
    .map_err(DomainError::sql_persist)?;
    record_request(
        tx,
        input.request_id,
        &payload_hash,
        moment_order,
        input.now_ms,
    )?;

    // A reused content-addressed row may be corrupt. Preserve the hydration
    // check that the prepared fast path replaces unless this write inserted
    // the blob and therefore established its text and recorded byte length.
    let read_back = !blob_inserted || known_object.is_none();

    let result_path = input.path.into_owned();
    let result_text = input.text.into_owned();
    let (object, moment) = if read_back {
        let object = get_file_object(tx, input.workspace_id, &object_id)?.ok_or(
            DomainError::StateCorrupt {
                reason: "written snapshot points at a missing object",
            },
        )?;
        let moment = get_moment(tx, input.workspace_id, input.moment_id)?.ok_or(
            DomainError::StateCorrupt {
                reason: "moment vanished within its own write transaction",
            },
        )?;
        (object, moment)
    } else {
        let object = known_object.ok_or(DomainError::StateCorrupt {
            reason: "prepared capture result is missing its known object",
        })?;
        let byte_length = result_text.len() as i64;
        let after_text =
            (result_text.len() <= MOMENT_TEXT_HYDRATION_CAP_BYTES).then(|| result_text.clone());
        let moment = MomentRecord {
            moment_order,
            moment_id: input.moment_id.to_owned(),
            version_id: input.version_id.to_owned(),
            object_id: object_id.clone(),
            path: result_path.clone(),
            recorded_at_ms: input.now_ms,
            operation: MomentOp::Write,
            after_content_kind: "text".to_owned(),
            after_blob_sha256: Some(blob.clone()),
            after_binary_sha256: None,
            before_present: false,
            before_blob_sha256: None,
            before_content_kind: "text".to_owned(),
            before_binary_sha256: None,
            before_latest_moment_id: None,
            metadata_origin: input.metadata_origin.to_owned(),
            metadata_summary: input.metadata_summary.map(str::to_owned),
            metadata_correlation_id: input.metadata_correlation_id.map(str::to_owned),
            author_json: input.author_json.map(str::to_owned),
            sync_record_only: false,
            after_text,
            after_byte_length: Some(byte_length),
            before_text: None,
            before_byte_length: None,
            before_path: None,
        };
        (object, moment)
    };
    Ok(WriteResult {
        object,
        snapshot: TextSnapshot {
            workspace_id: input.workspace_id.to_owned(),
            version_id: input.version_id.to_owned(),
            object_id: object_id.clone(),
            path: result_path,
            text: result_text,
            blob_sha256: blob.clone(),
            updated_at_ms: input.now_ms,
            latest_moment_id: input.moment_id.to_owned(),
            metadata_origin: input.metadata_origin.to_owned(),
            metadata_summary: input.metadata_summary.map(str::to_owned),
            metadata_correlation_id: input.metadata_correlation_id.map(str::to_owned),
        },
        moment,
        deduped: false,
    })
}

fn reconstruct_write(
    conn: &Connection,
    workspace_id: &str,
    moment_id: &str,
) -> Result<WriteResult, DomainError> {
    let moment = get_moment(conn, workspace_id, moment_id)?.ok_or(DomainError::StateCorrupt {
        reason: "deduped write has no moment",
    })?;
    write_result_from_moment(conn, workspace_id, moment, true)
}

/// The one locked implementation of autonomous capture's object/alias
/// resolution, shared by the text and binary primitives so the length-framed,
/// security-sensitive id scheme can never silently diverge between them:
/// reuse a live alias; else derive the framed object id and reuse it only when
/// it has no live alias anywhere; else mint an order-disambiguated id, with
/// that reserved order returned so the caller can pin it against the moment
/// the write actually persists. A freshly inserted object record is returned
/// too, so capture does not have to read back state it just established.
fn resolve_capture_object(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    path: &str,
    now_ms: i64,
    existing_alias: Option<String>,
    batch: Option<&mut CaptureIngestBatchContext>,
) -> Result<ResolvedCaptureObject, DomainError> {
    let mut reserved_moment_order = None;
    let mut known_object = None;
    let object_id = match existing_alias {
        Some(object_id) => object_id,
        None => {
            let derived_object_id = derive_capture_object_id(workspace_id, version_id, path);
            let inserted = tx
                .execute(
                    "INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                     VALUES (?1, ?2, ?3) \
                     ON CONFLICT (workspace_id, object_id) DO NOTHING",
                    params![workspace_id, derived_object_id, now_ms],
                )
                .map_err(DomainError::sql_persist)?
                != 0;
            let object_id = if inserted {
                known_object = Some(FileObjectRecord {
                    workspace_id: workspace_id.to_owned(),
                    object_id: derived_object_id.clone(),
                    created_at_ms: now_ms,
                });
                derived_object_id
            } else if !object_has_live_alias(tx, workspace_id, &derived_object_id)? {
                derived_object_id
            } else {
                let next_order = match batch {
                    Some(batch) => batch.proposed_moment_order(tx)?,
                    None => next_moment_order(tx)?,
                };
                let disambiguated_object_id = derive_disambiguated_capture_object_id(
                    workspace_id,
                    version_id,
                    path,
                    next_order,
                );
                tx.execute(
                    "INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                     VALUES (?1, ?2, ?3)",
                    params![workspace_id, disambiguated_object_id, now_ms],
                )
                .map_err(DomainError::sql_persist)?;
                known_object = Some(FileObjectRecord {
                    workspace_id: workspace_id.to_owned(),
                    object_id: disambiguated_object_id.clone(),
                    created_at_ms: now_ms,
                });
                reserved_moment_order = Some(next_order);
                disambiguated_object_id
            };
            tx.execute(
                "INSERT INTO path_aliases (workspace_id, version_id, path, object_id) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![workspace_id, version_id, path, object_id],
            )
            .map_err(DomainError::sql_persist)?;
            object_id
        }
    };
    Ok(ResolvedCaptureObject {
        object_id,
        reserved_moment_order,
        known_object,
    })
}

fn reconstruct_capture_write(
    conn: &Connection,
    workspace_id: &str,
    moment_order: i64,
) -> Result<WriteResult, DomainError> {
    let moment =
        moment_by_order(conn, workspace_id, moment_order)?.ok_or(DomainError::StateCorrupt {
            reason: "deduped capture has no moment",
        })?;
    write_result_from_moment(conn, workspace_id, moment, true)
}

fn write_result_for_existing_head(
    conn: &Connection,
    snapshot: &SnapshotRecord,
) -> Result<WriteResult, DomainError> {
    let moment = get_moment(conn, &snapshot.workspace_id, &snapshot.latest_moment_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "snapshot points at a missing moment",
        },
    )?;
    write_result_from_moment(conn, &snapshot.workspace_id, moment, true)
}

fn reconstruct_capture_delete(
    conn: &Connection,
    workspace_id: &str,
    moment_order: i64,
) -> Result<DeleteResult, DomainError> {
    let moment =
        moment_by_order(conn, workspace_id, moment_order)?.ok_or(DomainError::StateCorrupt {
            reason: "deduped capture retire has no moment",
        })?;
    delete_result_from_moment(conn, workspace_id, moment, true)
}

fn validate_text(text: &str) -> Result<(), DomainError> {
    if text.len() > MAX_TEXT_BYTES {
        // Name the cap, not just the fact of it. "text exceeds the
        // size cap" told a caller nothing it could act on: which cap, how
        // large, in what unit, and by how much it overshot were all missing.
        // The sync side already reports this same limit as
        // ("MAX_TEXT_BYTES", MAX_TEXT_BYTES) with observed bytes at its
        // ingest boundary; the store's own write path was the outlier.
        return Err(DomainError::PayloadTooLarge {
            constraint: "MAX_TEXT_BYTES",
            limit_bytes: MAX_TEXT_BYTES,
            observed_bytes: text.len(),
        });
    }
    Ok(())
}

/// Whether an object owns any binding (a path alias in any version or a
/// snapshot row). A bare row with none is a Y.Doc seed preallocation.
fn object_has_any_binding(
    tx: &Transaction<'_>,
    workspace_id: &str,
    object_id: &str,
) -> Result<bool, DomainError> {
    let bound: Option<i64> = tx
        .query_row(
            "SELECT 1 WHERE EXISTS (SELECT 1 FROM path_aliases WHERE workspace_id = ?1 AND object_id = ?2)              OR EXISTS (SELECT 1 FROM snapshots WHERE workspace_id = ?1 AND object_id = ?2)",
            params![workspace_id, object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(bound.is_some())
}

fn object_exists(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<bool, DomainError> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM file_objects WHERE workspace_id = ?1 AND object_id = ?2",
            params![workspace_id, object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    Ok(found.is_some())
}

/// Derive the stable workspace-scoped object id for a captured version-local
/// path: `object-` plus lowercase-hex SHA-256 over length-prefixed
/// `workspace_id`, `version_id`, and `path` fields.
pub fn derive_capture_object_id(workspace_id: &str, version_id: &str, path: &str) -> String {
    format!(
        "object-{}",
        hash_fields(&[
            workspace_id.as_bytes(),
            version_id.as_bytes(),
            path.as_bytes(),
        ])
    )
}

fn derive_disambiguated_capture_object_id(
    workspace_id: &str,
    version_id: &str,
    path: &str,
    next_moment_order: i64,
) -> String {
    let next_moment_order = next_moment_order.to_string();
    format!(
        "object-{}",
        hash_fields(&[
            workspace_id.as_bytes(),
            version_id.as_bytes(),
            path.as_bytes(),
            next_moment_order.as_bytes(),
        ])
    )
}

fn capture_producer_id(tx: &Transaction<'_>, workspace_id: &str) -> Result<String, DomainError> {
    tx.query_row(
        "SELECT COALESCE(\
             (SELECT origin_id FROM sync_identity WHERE workspace_id = ?1), \
             (SELECT engine_uuid FROM engine_ownership WHERE rowid_guard = 1))",
        [workspace_id],
        |row| row.get(0),
    )
    .map_err(DomainError::sql_corrupt)
}

/// Derive a capture moment id from its producer, coordinate, operation, and
/// mutation identity. The producer is the replica origin when the workspace
/// has one and the durable engine id before that. The operation and content
/// fields keep two divergent writes from cloned engines distinct even before
/// one clone recovers its origin.
pub fn derive_capture_moment_id(
    producer_id: &str,
    workspace_id: &str,
    object_id: &str,
    next_moment_order: i64,
    operation: &str,
    mutation_identity: &str,
) -> String {
    let next_moment_order = next_moment_order.to_string();
    format!(
        "moment-{}",
        hash_fields(&[
            producer_id.as_bytes(),
            workspace_id.as_bytes(),
            object_id.as_bytes(),
            next_moment_order.as_bytes(),
            operation.as_bytes(),
            mutation_identity.as_bytes(),
        ])
    )
}

/// Derive a capture delete moment id with the same order-based scheme as a
/// capture write.
pub fn derive_capture_retire_moment_id(
    producer_id: &str,
    workspace_id: &str,
    object_id: &str,
    next_moment_order: i64,
    operation: &str,
    mutation_identity: &str,
) -> String {
    derive_capture_moment_id(
        producer_id,
        workspace_id,
        object_id,
        next_moment_order,
        operation,
        mutation_identity,
    )
}

fn hash_request_fields(request_id: Option<&str>, fields: &[&[u8]]) -> String {
    request_id.map_or_else(String::new, |_| hash_fields(fields))
}

/// The path's final segment, for per-file capture summaries (TS
/// `pathBasename` parity — paths are stored with `/` separators).
fn path_basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::{
        CaptureIngestBatchContext, MOMENT_TEXT_HYDRATION_CAP_BYTES, ProjectedWriteText,
        VersionedTextStore, capture_ingest_in_batch_with_admission_in_tx, derive_capture_moment_id,
        derive_capture_object_id, derive_disambiguated_capture_object_id, hash_fields,
        hash_optional_text_fields, next_moment_order, text_blob_sha256, write_projected_text_in_tx,
        write_text_in_tx,
    };
    use crate::{
        CaptureIngest, CaptureRetire, DomainError, RenameTextFile, WriteResult, WriteText,
    };
    use dohc_engine_storage::{
        EngineStore, MaterializationJobSpec, NoFaults, Preimage, TxnOutcome, put_binary_blob,
        record_completed_job,
    };
    use dohc_engine_testkit::ScratchDir;
    use rusqlite::params;
    use std::borrow::Cow;

    fn capture_input(path: &str, text: String, now_ms: i64) -> CaptureIngest {
        CaptureIngest {
            workspace_id: "ws".to_owned(),
            version_id: "main".to_owned(),
            path: path.to_owned(),
            text,
            metadata_origin: "capture".to_owned(),
            metadata_summary: Some("Captured test file".to_owned()),
            metadata_correlation_id: Some("capture-pass-1".to_owned()),
            author_json: Some(r#"{"kind":"capture-test"}"#.to_owned()),
            now_ms,
            request_id: None,
            claim_foreign_head: false,
        }
    }

    fn capture_text(store: &mut EngineStore, path: &str, text: String, now_ms: i64) -> WriteResult {
        VersionedTextStore::new(store)
            .capture_ingest(&capture_input(path, text, now_ms), &NoFaults)
            .expect("capture text")
    }

    fn assert_capture_matches_hydrated(store: &mut EngineStore, captured: &WriteResult) {
        let versioned = VersionedTextStore::new(store);
        let hydrated_moment = versioned
            .get_moment("ws", &captured.moment.moment_id)
            .expect("read captured moment")
            .expect("captured moment exists");
        let hydrated_snapshot = versioned
            .read_text("ws", "main", &captured.snapshot.path)
            .expect("read captured snapshot")
            .expect("captured snapshot exists");

        assert_eq!(captured.moment, hydrated_moment);
        assert_eq!(captured.snapshot, hydrated_snapshot);
    }

    #[test]
    fn capture_batch_preserves_producer_and_global_high_water_parity() {
        fn initialized_store(db: &std::path::Path) -> EngineStore {
            let mut store = EngineStore::open(db, 1).expect("open store");
            VersionedTextStore::new(&mut store)
                .ensure_main_version("ws", "main", 1, &NoFaults)
                .expect("ensure main version");
            let outcome = store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "INSERT INTO sync_identity \
                         (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
                         VALUES ('ws', 'origin-capture-parity', 'epoch', 'stream', 1)",
                        [],
                    )
                    .map_err(DomainError::sql_persist)?;
                    let content_sha256 =
                        put_binary_blob(tx, b"capture high-water fixture")
                            .map_err(DomainError::from)?;
                    record_completed_job(
                        tx,
                        &MaterializationJobSpec {
                            job_id: "mutation-mat_capture-high-water".to_owned(),
                            workspace_id: "ws".to_owned(),
                            target_path: "notes/high-water.md".to_owned(),
                            content_sha256,
                            preimage: Preimage::Absent,
                            target_generation: 40,
                            now_ms: 1,
                        },
                    )
                    .map_err(DomainError::from)?;
                    Ok::<_, DomainError>(())
                })
                .expect("seed producer and high water");
            super::committed(outcome).expect("commit producer and high water");
            store
        }

        let sequential_scratch = ScratchDir::new().expect("sequential scratch");
        let batch_scratch = ScratchDir::new().expect("batch scratch");
        let mut sequential = initialized_store(
            &dohc_engine_testkit::engine_db_path(&sequential_scratch).expect("sequential db"),
        );
        let mut batched = initialized_store(
            &dohc_engine_testkit::engine_db_path(&batch_scratch).expect("batch db"),
        );
        let inputs = vec![
            capture_input("notes/a.md", "alpha".to_owned(), 10),
            capture_input("notes/b.md", "bravo".to_owned(), 11),
            capture_input("notes/c.md", "charlie".to_owned(), 12),
        ];

        let expected = inputs
            .iter()
            .map(|input| {
                VersionedTextStore::new(&mut sequential)
                    .capture_ingest(input, &NoFaults)
                    .expect("sequential capture")
            })
            .collect::<Vec<_>>();

        let outcome = batched
            .write_with(&NoFaults, |tx| {
                let mut context = CaptureIngestBatchContext::new(tx, "ws", "main")?;
                let mut results = Vec::with_capacity(inputs.len());
                for input in &inputs {
                    tx.execute_batch("SAVEPOINT capture_batch_parity")
                        .map_err(DomainError::sql_persist)?;
                    let result = capture_ingest_in_batch_with_admission_in_tx(
                        tx,
                        input,
                        &mut context,
                        |_, _, _| Ok::<_, DomainError>(()),
                    )?;
                    tx.execute_batch("RELEASE capture_batch_parity")
                        .map_err(DomainError::sql_persist)?;
                    context.commit_result(&result)?;
                    results.push(result);
                }
                Ok::<_, DomainError>(results)
            })
            .expect("capture batch");
        let actual = super::committed(outcome).expect("commit capture batch");

        assert_eq!(actual, expected);
        assert_eq!(
            actual
                .iter()
                .map(|result| result.moment.moment_order)
                .collect::<Vec<_>>(),
            vec![41, 42, 43],
            "the materialization-job high-water must seed the shared cursor"
        );
    }

    #[test]
    fn capture_batch_reuses_candidate_after_item_savepoint_rollback() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");

        let outcome = store
            .write_with(&NoFaults, |tx| {
                let mut context = CaptureIngestBatchContext::new(tx, "ws", "main")?;
                tx.execute_batch("SAVEPOINT capture_batch_failed_item")
                    .map_err(DomainError::sql_persist)?;
                let rolled_back = capture_ingest_in_batch_with_admission_in_tx(
                    tx,
                    &capture_input("notes/rolled-back.md", "first".to_owned(), 10),
                    &mut context,
                    |_, _, _| Ok::<_, DomainError>(()),
                )?;
                let candidate = rolled_back.moment.moment_order;
                tx.execute_batch(
                    "ROLLBACK TO capture_batch_failed_item; \
                     RELEASE capture_batch_failed_item",
                )
                .map_err(DomainError::sql_persist)?;

                tx.execute_batch("SAVEPOINT capture_batch_retry_candidate")
                    .map_err(DomainError::sql_persist)?;
                let captured = capture_ingest_in_batch_with_admission_in_tx(
                    tx,
                    &capture_input("notes/committed.md", "second".to_owned(), 11),
                    &mut context,
                    |_, _, _| Ok::<_, DomainError>(()),
                )?;
                tx.execute_batch("RELEASE capture_batch_retry_candidate")
                    .map_err(DomainError::sql_persist)?;
                context.commit_result(&captured)?;
                Ok::<_, DomainError>((candidate, captured))
            })
            .expect("capture around rolled-back item");
        let (candidate, captured) =
            super::committed(outcome).expect("commit surviving capture item");

        assert_eq!(captured.moment.moment_order, candidate);
        assert_eq!(captured.snapshot.path, "notes/committed.md");
        assert!(
            VersionedTextStore::new(&mut store)
                .read_text("ws", "main", "notes/rolled-back.md")
                .expect("read rolled-back path")
                .is_none(),
            "the failed item's savepoint must leave no state behind"
        );
    }

    #[test]
    fn capture_batch_accepts_a_final_maximum_moment_order() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");
        let outcome = store
            .write_with(&NoFaults, |tx| {
                let content_sha256 = put_binary_blob(tx, b"moment-order exhaustion fixture")
                    .map_err(DomainError::from)?;
                record_completed_job(
                    tx,
                    &MaterializationJobSpec {
                        job_id: "mutation-mat_before-order-exhaustion".to_owned(),
                        workspace_id: "ws".to_owned(),
                        target_path: "notes/before-order-exhaustion.md".to_owned(),
                        content_sha256,
                        preimage: Preimage::Absent,
                        target_generation: i64::MAX - 1,
                        now_ms: 1,
                    },
                )
                .map_err(DomainError::from)?;
                Ok::<_, DomainError>(())
            })
            .expect("seed maximum high-water");
        super::committed(outcome).expect("commit maximum high-water");

        let outcome = store
            .write_with(&NoFaults, |tx| {
                let mut context = CaptureIngestBatchContext::new(tx, "ws", "main")?;
                tx.execute_batch("SAVEPOINT capture_maximum_order")
                    .map_err(DomainError::sql_persist)?;
                let captured = capture_ingest_in_batch_with_admission_in_tx(
                    tx,
                    &capture_input("notes/final.md", "final".to_owned(), 2),
                    &mut context,
                    |_, _, _| Ok::<_, DomainError>(()),
                )?;
                tx.execute_batch("RELEASE capture_maximum_order")
                    .map_err(DomainError::sql_persist)?;
                context.commit_result(&captured)?;
                assert!(
                    matches!(
                        context.proposed_moment_order(tx),
                        Err(DomainError::StateCorrupt {
                            reason: "capture batch moment order overflowed"
                        })
                    ),
                    "only a later mutation should observe cursor exhaustion"
                );
                Ok::<_, DomainError>(captured)
            })
            .expect("capture final maximum-order item");
        let captured = super::committed(outcome).expect("commit final maximum-order item");
        assert_eq!(captured.moment.moment_order, i64::MAX);
    }

    #[test]
    fn direct_write_borrows_text_and_projected_write_moves_owned_text() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");

        let direct = WriteText {
            workspace_id: "ws".to_owned(),
            version_id: "main".to_owned(),
            object_id: "direct-object".to_owned(),
            path: "direct.md".to_owned(),
            text: "direct body".to_owned(),
            moment_id: "direct-moment".to_owned(),
            metadata_origin: "test".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 2,
            request_id: None,
        };
        let direct_outcome = store
            .write_with(&NoFaults, |tx| write_text_in_tx(tx, &direct))
            .expect("direct write");
        assert!(matches!(direct_outcome, TxnOutcome::Committed(_)));

        let projected_text = "projected body".repeat(4_096);
        let projected_allocation = projected_text.as_ptr();
        let projected_outcome = store
            .write_with(&NoFaults, |tx| {
                write_projected_text_in_tx(
                    tx,
                    ProjectedWriteText {
                        workspace_id: "ws",
                        version_id: "main",
                        object_id: "projected-object",
                        path: Cow::Borrowed("projected.md"),
                        text: Cow::Owned(projected_text),
                        moment_id: "projected-moment",
                        metadata_origin: "ydoc",
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 3,
                        request_id: None,
                    },
                )
            })
            .expect("projected write");
        let projected = match projected_outcome {
            TxnOutcome::Committed(projected) => projected,
            TxnOutcome::Crashed { .. } => panic!("projected write crashed"),
        };

        assert_eq!(
            projected.snapshot.text.as_ptr(),
            projected_allocation,
            "the projected body allocation must move into the returned snapshot"
        );
    }

    #[test]
    fn fresh_capture_result_matches_persisted_moment_and_snapshot() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");

        let text = "prepared capture body";
        let captured = VersionedTextStore::new(&mut store)
            .capture_ingest(
                &CaptureIngest {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    path: "notes/fresh.md".to_owned(),
                    text: text.to_owned(),
                    metadata_origin: "capture".to_owned(),
                    metadata_summary: Some("Captured fresh file".to_owned()),
                    metadata_correlation_id: Some("capture-pass-1".to_owned()),
                    author_json: Some(r#"{"kind":"capture-test"}"#.to_owned()),
                    now_ms: 2,
                    request_id: None,
                    claim_foreign_head: false,
                },
                &NoFaults,
            )
            .expect("capture fresh text");

        let expected_blob_sha256 = text_blob_sha256(text);
        assert_eq!(captured.snapshot.blob_sha256, expected_blob_sha256);
        assert_eq!(
            captured.moment.after_blob_sha256.as_deref(),
            Some(expected_blob_sha256.as_str())
        );
        let versioned = VersionedTextStore::new(&mut store);
        let hydrated_moment = versioned
            .get_moment("ws", &captured.moment.moment_id)
            .expect("read captured moment")
            .expect("captured moment exists");
        let hydrated_snapshot = versioned
            .read_text("ws", "main", "notes/fresh.md")
            .expect("read captured snapshot")
            .expect("captured snapshot exists");

        assert_eq!(captured.moment, hydrated_moment);
        assert_eq!(captured.snapshot, hydrated_snapshot);
    }

    #[test]
    fn fresh_capture_reused_corrupt_blob_fails_closed_and_rolls_back() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");

        let text = "prepared capture body";
        let blob_sha256 = text_blob_sha256(text);
        let seed = store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3)",
                    params![blob_sha256, text.len() as i64, "corrupt"],
                )
                .map_err(DomainError::sql_persist)?;
                Ok::<_, DomainError>(())
            })
            .expect("seed corrupt blob");
        assert!(matches!(seed, TxnOutcome::Committed(())));

        let error = VersionedTextStore::new(&mut store)
            .capture_ingest(
                &capture_input("notes/corrupt.md", text.to_owned(), 2),
                &NoFaults,
            )
            .expect_err("capture must reject the corrupt reused blob");

        assert!(matches!(
            error,
            DomainError::StateCorrupt {
                reason: "moment blob length does not match its content"
            }
        ));

        let durable_rows = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT \
                       (SELECT COUNT(*) FROM file_objects WHERE workspace_id = 'ws'), \
                       (SELECT COUNT(*) FROM path_aliases WHERE workspace_id = 'ws'), \
                       (SELECT COUNT(*) FROM snapshots WHERE workspace_id = 'ws'), \
                       (SELECT COUNT(*) FROM moments WHERE workspace_id = 'ws')",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )
            })
            .expect("inspect rolled-back capture");
        assert_eq!(
            durable_rows,
            (0, 0, 0, 0),
            "the integrity failure must roll back every capture row"
        );
        let corrupt_blob = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT byte_length, text FROM blobs WHERE sha256 = ?1",
                    [&blob_sha256],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
            })
            .expect("read corrupt seed after rollback");
        assert_eq!(corrupt_blob, (text.len() as i64, "corrupt".to_owned()));
    }

    #[test]
    fn fresh_capture_result_matches_hydration_at_history_text_cap() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");

        for (index, byte_length) in [
            MOMENT_TEXT_HYDRATION_CAP_BYTES,
            MOMENT_TEXT_HYDRATION_CAP_BYTES + 1,
        ]
        .into_iter()
        .enumerate()
        {
            let captured = capture_text(
                &mut store,
                &format!("notes/history-cap-{index}.md"),
                "x".repeat(byte_length),
                index as i64 + 2,
            );

            assert_eq!(
                captured.moment.after_text.is_some(),
                byte_length == MOMENT_TEXT_HYDRATION_CAP_BYTES
            );
            assert_capture_matches_hydrated(&mut store, &captured);
        }
    }

    #[test]
    fn renamed_capture_path_uses_disambiguated_object() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");

        let original_path = "notes/renamed.md";
        let first = capture_text(&mut store, original_path, "first body".to_owned(), 2);
        assert_eq!(
            first.object.object_id,
            derive_capture_object_id("ws", "main", original_path)
        );
        VersionedTextStore::new(&mut store)
            .rename_text_file(
                &RenameTextFile {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    from_path: original_path.to_owned(),
                    to_path: "notes/archive.md".to_owned(),
                    moment_id: "rename-captured-file".to_owned(),
                    request_id: None,
                    metadata_origin: "test".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 3,
                },
                &NoFaults,
            )
            .expect("rename captured file");

        let replacement = capture_input(original_path, "replacement body".to_owned(), 4);
        let outcome = store
            .write_with(&NoFaults, |tx| {
                let proposed_order = next_moment_order(tx)?;
                let mut context = CaptureIngestBatchContext::new(tx, "ws", "main")?;
                tx.execute_batch("SAVEPOINT capture_disambiguation")
                    .map_err(DomainError::sql_persist)?;
                let captured = capture_ingest_in_batch_with_admission_in_tx(
                    tx,
                    &replacement,
                    &mut context,
                    |_, _, _| Ok::<_, DomainError>(()),
                )?;
                tx.execute_batch("RELEASE capture_disambiguation")
                    .map_err(DomainError::sql_persist)?;
                context.commit_result(&captured)?;
                Ok::<_, DomainError>((proposed_order, captured))
            })
            .expect("capture disambiguated path");
        let (proposed_order, captured) =
            super::committed(outcome).expect("commit disambiguated capture");

        assert_ne!(captured.object.object_id, first.object.object_id);
        assert_eq!(captured.moment.moment_order, proposed_order);
        assert_eq!(
            captured.object.object_id,
            derive_disambiguated_capture_object_id("ws", "main", original_path, proposed_order),
            "object disambiguation and the persisted moment must share one order candidate"
        );
        let producer_id = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT engine_uuid FROM engine_ownership WHERE rowid_guard=1",
                    [],
                    |row| row.get::<_, String>(0),
                )
            })
            .expect("read capture producer");
        let (summary_kind, summary) = hash_optional_text_fields(Some("Captured test file"));
        let (correlation_kind, correlation) = hash_optional_text_fields(Some("capture-pass-1"));
        let mutation_identity = hash_fields(&[
            original_path.as_bytes(),
            text_blob_sha256("replacement body").as_bytes(),
            b"capture",
            summary_kind,
            summary,
            correlation_kind,
            correlation,
            b"some",
            br#"{"kind":"capture-test"}"#,
            b"4",
        ]);
        assert_eq!(
            captured.moment.moment_id,
            derive_capture_moment_id(
                &producer_id,
                "ws",
                &captured.object.object_id,
                proposed_order,
                "write",
                &mutation_identity,
            ),
            "moment derivation must use the same order candidate as object disambiguation"
        );

        assert_capture_matches_hydrated(&mut store, &captured);
    }

    #[test]
    fn retired_capture_reuses_unaliased_object() {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("db"),
            1,
        )
        .expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .expect("ensure main version");

        let path = "notes/recreated.md";
        let first = capture_text(&mut store, path, "first body".to_owned(), 2);
        VersionedTextStore::new(&mut store)
            .capture_retire(
                &CaptureRetire {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    path: path.to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 3,
                    request_id: None,
                    only_if_text_head: true,
                    only_if_capture_origin: true,
                    allow_ydoc_origin: false,
                },
                &NoFaults,
            )
            .expect("retire captured file");

        let captured = capture_text(&mut store, path, "recreated body".to_owned(), 4);

        assert_eq!(captured.object.object_id, first.object.object_id);

        assert_capture_matches_hydrated(&mut store, &captured);
    }
}
