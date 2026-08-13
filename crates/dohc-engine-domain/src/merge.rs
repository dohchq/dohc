//! Three-way text comparison, conservative markdown merge, and whole-version diff.

use crate::conflicts::{
    ConflictChoice, ConflictFileState, ConflictMetadata, ConflictStatus, TextConflict,
    WriteBinaryFile, enqueue_delete, enqueue_write, insert_text_conflict_if_absent,
    load_text_conflict_in_tx, write_binary_file_in_tx,
};
use crate::error::DomainError;
use crate::records::{
    DeleteResult, DeleteTextFile, FileObjectRecord, MomentOp, MomentRecord, SnapshotContent,
    TextSnapshot, VersionKind, WriteResult, WriteText,
};
use crate::store::{
    VersionedTextStore, delete_result_from_moment, delete_text_in_tx, get_file_object, get_moment,
    hash_fields, lookup_request, record_merge_request, validate_delete_input, validate_path,
    validate_write_input, write_result_from_moment, write_text_in_tx,
};
use dohc_engine_storage::{FaultInjector, Preimage, StorageError, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_MERGE_LINES: usize = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarkdownMergeResult {
    Merged(String),
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComparisonStatus {
    Same,
    IncomingChanged,
    CurrentChanged,
    Diverged,
}

/// One present side of a version comparison.
///
/// A binary head keeps the store's text-view convention (`snapshot_text_view`):
/// empty text, with `blob_sha256` holding its BINARY content address. The byte
/// length that view has no place for rides alongside, because the conflict a
/// binary side opens must report it.
///
/// Every field is required. A merge ledger record written before sides carried
/// a content kind does not decode as this shape, and must not: a defaulted
/// `binary` would let an old record replay as text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComparisonSide {
    pub snapshot: TextSnapshot,
    pub binary: bool,
    pub byte_length: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionedTextComparison {
    pub workspace_id: String,
    pub path: String,
    pub target_version_id: String,
    pub source_version_id: String,
    pub base: Option<ComparisonSide>,
    pub current: Option<ComparisonSide>,
    pub incoming: Option<ComparisonSide>,
    pub status: ComparisonStatus,
}

#[derive(Debug, Clone)]
pub struct CompareTextFileVersions {
    pub workspace_id: String,
    pub target_version_id: String,
    pub source_version_id: String,
    pub path: String,
}

#[derive(Debug, Clone)]
pub struct MergeTextFileFromVersion {
    pub workspace_id: String,
    pub target_version_id: String,
    pub source_version_id: String,
    pub path: String,
    pub object_id: String,
    pub moment_id: String,
    pub request_id: Option<String>,
    pub conflict_id: String,
    pub metadata_origin: String,
    pub metadata_summary: Option<String>,
    pub metadata_correlation_id: Option<String>,
    pub author_json: Option<String>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeUnchangedReason {
    AlreadySame,
    SourceUnchanged,
}

/// The binary head a WS-G1 fast-forward left in the target version.
///
/// `head` keeps the store's text-view convention, exactly as a comparison side
/// does: empty text, with `blob_sha256` holding the BINARY content address and
/// the byte length beside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryMergeWrite {
    pub object: FileObjectRecord,
    pub head: ComparisonSide,
    pub moment: MomentRecord,
    pub deduped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeTextFileResult {
    Unchanged {
        reason: MergeUnchangedReason,
        comparison: VersionedTextComparison,
        deduped: bool,
    },
    Write {
        comparison: VersionedTextComparison,
        write: WriteResult,
    },
    BinaryWrite {
        comparison: VersionedTextComparison,
        write: BinaryMergeWrite,
    },
    Delete {
        comparison: VersionedTextComparison,
        delete: DeleteResult,
    },
    Conflict {
        comparison: VersionedTextComparison,
        conflict: Box<TextConflict>,
        deduped: bool,
    },
}

#[derive(Debug, Serialize, Deserialize)]
struct MergeLedgerRecord {
    payload_hash: String,
    outcome: MergeLedgerOutcome,
    #[serde(default)]
    comparison: Option<VersionedTextComparison>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum MergeLedgerOutcome {
    Write { moment_id: String },
    BinaryWrite { moment_id: String },
    Delete { moment_id: String },
    Conflict { conflict_id: String },
    Unchanged { reason: MergeLedgerUnchangedReason },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum MergeLedgerUnchangedReason {
    AlreadySame,
    SourceUnchanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionFileChangeStatus {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionFileChange {
    pub path: String,
    pub status: VersionFileChangeStatus,
    pub current: Option<SnapshotContent>,
    pub incoming: Option<SnapshotContent>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionFileChangeEntry {
    pub path: String,
    pub status: VersionFileChangeStatus,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionFileChangePage {
    pub entries: Vec<VersionFileChangeEntry>,
    pub next_after_path: Option<String>,
}

/// Port of `mergeMarkdown.ts`: LCS-aligned line hunks with conservative
/// overlap detection and the exact 2,000-line quadratic-work guard.
pub fn merge_markdown(base: &str, local: &str, remote: &str) -> MarkdownMergeResult {
    if local == remote {
        return MarkdownMergeResult::Merged(local.to_owned());
    }
    if local == base {
        return MarkdownMergeResult::Merged(remote.to_owned());
    }
    if remote == base {
        return MarkdownMergeResult::Merged(local.to_owned());
    }

    let base_lines: Vec<&str> = base.split('\n').collect();
    let local_lines: Vec<&str> = local.split('\n').collect();
    let remote_lines: Vec<&str> = remote.split('\n').collect();
    if [base_lines.len(), local_lines.len(), remote_lines.len()]
        .into_iter()
        .any(|line_count| line_count > MAX_MERGE_LINES)
    {
        return MarkdownMergeResult::Conflict;
    }

    let local_hunks = diff_hunks(&base_lines, &local_lines);
    let remote_hunks = diff_hunks(&base_lines, &remote_lines);
    for local_hunk in &local_hunks {
        for remote_hunk in &remote_hunks {
            let both_insert_at_same_offset = local_hunk.base_start == local_hunk.base_end
                && remote_hunk.base_start == remote_hunk.base_end
                && local_hunk.base_start == remote_hunk.base_start;
            let same_start_with_insertion = local_hunk.base_start == remote_hunk.base_start
                && ((local_hunk.base_start == local_hunk.base_end)
                    != (remote_hunk.base_start == remote_hunk.base_end));
            let overlapping = local_hunk.base_start < remote_hunk.base_end
                && remote_hunk.base_start < local_hunk.base_end;
            if both_insert_at_same_offset || same_start_with_insertion || overlapping {
                return MarkdownMergeResult::Conflict;
            }
        }
    }

    let mut all = Vec::with_capacity(local_hunks.len() + remote_hunks.len());
    all.extend(local_hunks);
    all.extend(remote_hunks);
    all.sort_by_key(|hunk| hunk.base_start);
    let mut output = Vec::new();
    let mut cursor = 0;
    for hunk in all {
        output.extend(
            base_lines[cursor..hunk.base_start]
                .iter()
                .map(|line| (*line).to_owned()),
        );
        output.extend(hunk.replacement);
        cursor = hunk.base_end;
    }
    output.extend(base_lines[cursor..].iter().map(|line| (*line).to_owned()));
    MarkdownMergeResult::Merged(output.join("\n"))
}

pub fn file_states_equal(left: &Option<TextSnapshot>, right: &Option<TextSnapshot>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left.text == right.text,
        _ => false,
    }
}

/// Content equality for two comparison sides. A binary side compares by its
/// content address, never by the empty text its view carries — two different
/// binary heads both read as `""` and would otherwise compare EQUAL.
pub fn comparison_sides_equal(
    left: &Option<ComparisonSide>,
    right: &Option<ComparisonSide>,
) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) if left.binary != right.binary => false,
        (Some(left), Some(right)) if left.binary => {
            left.snapshot.blob_sha256 == right.snapshot.blob_sha256
        }
        (Some(left), Some(right)) => left.snapshot.text == right.snapshot.text,
        _ => false,
    }
}

pub fn comparison_status(
    base: &Option<ComparisonSide>,
    current: &Option<ComparisonSide>,
    incoming: &Option<ComparisonSide>,
) -> ComparisonStatus {
    if comparison_sides_equal(current, incoming) {
        ComparisonStatus::Same
    } else if comparison_sides_equal(current, base) {
        ComparisonStatus::IncomingChanged
    } else if comparison_sides_equal(incoming, base) {
        ComparisonStatus::CurrentChanged
    } else {
        ComparisonStatus::Diverged
    }
}

impl VersionedTextStore<'_> {
    pub fn compare_text_file_versions(
        &self,
        input: &CompareTextFileVersions,
    ) -> Result<VersionedTextComparison, DomainError> {
        validate_path(&input.path)?;
        self.store
            .read_with(|conn| compare_text_file_versions_in_db(conn, input))
    }

    pub fn merge_text_file_from_version(
        &mut self,
        input: &MergeTextFileFromVersion,
        faults: &dyn FaultInjector,
    ) -> Result<MergeTextFileResult, DomainError> {
        self.merge_text_file_from_version_with(input, faults, |_, _| Ok(()))
    }

    /// Merge with a caller-supplied same-transaction side effect (used by the
    /// runtime to keep FTS synchronized with a merged write/delete).
    pub fn merge_text_file_from_version_with<F>(
        &mut self,
        input: &MergeTextFileFromVersion,
        faults: &dyn FaultInjector,
        after: F,
    ) -> Result<MergeTextFileResult, DomainError>
    where
        F: Fn(&Transaction<'_>, &MergeTextFileResult) -> Result<(), DomainError>,
    {
        validate_path(&input.path)?;
        let (author_kind, author_json) = match input.author_json.as_deref() {
            Some(author_json) => (b"some".as_slice(), author_json.as_bytes()),
            None => (b"none".as_slice(), b"".as_slice()),
        };
        let payload_hash = hash_fields(&[
            input.workspace_id.as_bytes(),
            input.target_version_id.as_bytes(),
            input.source_version_id.as_bytes(),
            input.path.as_bytes(),
            input.moment_id.as_bytes(),
            input.object_id.as_bytes(),
            input.conflict_id.as_bytes(),
            input.metadata_origin.as_bytes(),
            author_kind,
            author_json,
        ]);
        let outcome = self.store.write_with(faults, |tx| {
            if let Some(request_id) = &input.request_id
                && let Some(recorded) = lookup_request(tx, request_id)?
            {
                // A request id recorded by a DIFFERENT operation kind stores a
                // raw hash, not merge-ledger JSON: that is key reuse, not
                // engine corruption.
                let Ok(recorded) = decode_merge_ledger(&recorded.payload_hash) else {
                    return Err(DomainError::IdempotencyKeyReuseMismatch);
                };
                if recorded.payload_hash != payload_hash {
                    return Err(DomainError::IdempotencyKeyReuseMismatch);
                }
                return reconstruct_merge(tx, input, &recorded);
            }
            let compare_input = CompareTextFileVersions {
                workspace_id: input.workspace_id.clone(),
                target_version_id: input.target_version_id.clone(),
                source_version_id: input.source_version_id.clone(),
                path: input.path.clone(),
            };
            let comparison = compare_text_file_versions_in_db(tx, &compare_input)?;
            if comparison_sides_equal(&comparison.current, &comparison.incoming) {
                let result = MergeTextFileResult::Unchanged {
                    reason: MergeUnchangedReason::AlreadySame,
                    comparison,
                    deduped: false,
                };
                return finish_merge(tx, input, &payload_hash, result, &after);
            }
            if comparison_sides_equal(&comparison.incoming, &comparison.base) {
                let result = MergeTextFileResult::Unchanged {
                    reason: MergeUnchangedReason::SourceUnchanged,
                    comparison,
                    deduped: false,
                };
                return finish_merge(tx, input, &payload_hash, result, &after);
            }
            // WS-G1. Equal bytes are already uncontested above. What remains is
            // decided by which side each branch READS.
            //
            // The fast-forward writes the incoming side through the TEXT write
            // and delete seams, so it needs both LIVE sides to be text. The base
            // does not gate it: a binary base can never compare equal to a text
            // current anyway, because the kinds differ.
            let live_sides_binary = [&comparison.current, &comparison.incoming]
                .into_iter()
                .flatten()
                .any(|side| side.binary);

            if !live_sides_binary && comparison_sides_equal(&comparison.current, &comparison.base) {
                if let Some(incoming) = &comparison.incoming {
                    let write_input = merge_write_input(input, &incoming.snapshot.text);
                    validate_write_input(&write_input)?;
                    let write = write_text_in_tx(tx, &write_input)?;
                    let preimage = comparison
                        .current
                        .as_ref()
                        .map_or(Preimage::Absent, |side| {
                            Preimage::Present(side.snapshot.blob_sha256.clone())
                        });
                    enqueue_write(tx, &write, preimage, "merge")?;
                    let result = MergeTextFileResult::Write { comparison, write };
                    return finish_merge(tx, input, &payload_hash, result, &after);
                }
                let delete_input = merge_delete_input(input);
                validate_delete_input(&delete_input)?;
                let delete = delete_text_in_tx(tx, &delete_input)?;
                enqueue_delete(tx, &delete, "merge")?;
                let result = MergeTextFileResult::Delete { comparison, delete };
                return finish_merge(tx, input, &payload_hash, result, &after);
            }

            // The same fast-forward for BYTES, through the binary write seam.
            // `comparison_sides_equal` proves current and base equal by CONTENT
            // ADDRESS, and a side that holds bytes never compares equal to one
            // that holds text — so an emptied text current over a binary base
            // stays a conflict here, as it must.
            //
            // A REMOVED binary asset keeps its conflict: that seam is the text
            // delete, whose merged record reports its preimage as text. So does
            // TEXT replacing an untouched binary head — this seam writes bytes,
            // and the text fast-forward above refuses a binary current.
            if let Some(incoming) = &comparison.incoming
                && incoming.binary
                && comparison_sides_equal(&comparison.current, &comparison.base)
            {
                let preimage = comparison
                    .current
                    .as_ref()
                    .map_or(Preimage::Absent, |side| {
                        Preimage::Present(side.snapshot.blob_sha256.clone())
                    });
                write_binary_file_in_tx(
                    tx,
                    &WriteBinaryFile {
                        workspace_id: input.workspace_id.clone(),
                        version_id: input.target_version_id.clone(),
                        // A path the target already holds keeps its object
                        // identity; this id binds only a NEW target path.
                        object_id: input.object_id.clone(),
                        path: input.path.clone(),
                        binary_sha256: incoming.snapshot.blob_sha256.clone(),
                        moment_id: input.moment_id.clone(),
                        metadata_origin: input.metadata_origin.clone(),
                        metadata_summary: input.metadata_summary.clone(),
                        metadata_correlation_id: input.metadata_correlation_id.clone(),
                        author_json: input.author_json.clone(),
                        materialize: Some(preimage),
                        now_ms: input.now_ms,
                    },
                )?;
                let moment = get_moment(tx, &input.workspace_id, &input.moment_id)?.ok_or(
                    DomainError::StateCorrupt {
                        reason: "binary merge moment vanished within its transaction",
                    },
                )?;
                let write = binary_merge_write_from_moment(tx, &input.workspace_id, moment, false)?;
                let result = MergeTextFileResult::BinaryWrite { comparison, write };
                return finish_merge(tx, input, &payload_hash, result, &after);
            }

            // The line merge is the one branch that READS the base, so all three
            // sides must be text. A binary head's text view is EMPTY, and an
            // ancestor that reads as "" would let an emptied text head compare
            // equal to it and fast-forward the incoming text over content it
            // never shared a line with.
            if let (Some(base), Some(current), Some(incoming)) =
                (&comparison.base, &comparison.current, &comparison.incoming)
                && !base.binary
                && !current.binary
                && !incoming.binary
                && let MarkdownMergeResult::Merged(text) = merge_markdown(
                    &base.snapshot.text,
                    &current.snapshot.text,
                    &incoming.snapshot.text,
                )
            {
                let write_input = merge_write_input(input, &text);
                validate_write_input(&write_input)?;
                let write = write_text_in_tx(tx, &write_input)?;
                enqueue_write(
                    tx,
                    &write,
                    Preimage::Present(current.snapshot.blob_sha256.clone()),
                    "merge",
                )?;
                let result = MergeTextFileResult::Write { comparison, write };
                return finish_merge(tx, input, &payload_hash, result, &after);
            }

            if input.conflict_id.is_empty() {
                return Err(DomainError::InvalidInput {
                    reason: "conflict_id must not be empty",
                });
            }
            let conflict = conflict_from_comparison(input, &comparison);
            if !insert_text_conflict_if_absent(tx, &conflict)? {
                return Err(DomainError::InvalidInput {
                    reason: "conflict_id already exists",
                });
            }
            tx.execute(
                "INSERT INTO replication_journal (doc_id, op_kind, created_at_ms) \
                 VALUES (?1, 'conflict.open', ?2)",
                params![conflict.conflict_id, conflict.created_at_ms],
            )
            .map_err(DomainError::sql_persist)?;
            let result = MergeTextFileResult::Conflict {
                comparison,
                conflict: Box::new(conflict),
                deduped: false,
            };
            finish_merge(tx, input, &payload_hash, result, &after)
        })?;
        committed(outcome)
    }

    pub fn compare_version_files(
        &self,
        workspace_id: &str,
        source_version_id: &str,
        target_version_id: &str,
    ) -> Result<Vec<VersionFileChange>, DomainError> {
        self.store.read_with(|conn| {
            validate_compare_versions(conn, workspace_id, source_version_id, target_version_id)
        })?;
        let target = self.list_snapshots(workspace_id, target_version_id)?;
        let source = self.list_snapshots(workspace_id, source_version_id)?;
        let target_by_path: BTreeMap<_, _> = target
            .into_iter()
            .map(|snapshot| (snapshot.path.clone(), snapshot))
            .collect();
        let source_by_path: BTreeMap<_, _> = source
            .into_iter()
            .map(|snapshot| (snapshot.path.clone(), snapshot))
            .collect();
        let paths: BTreeSet<_> = target_by_path
            .keys()
            .chain(source_by_path.keys())
            .cloned()
            .collect();
        let mut changes = Vec::new();
        for path in paths {
            match (target_by_path.get(&path), source_by_path.get(&path)) {
                (Some(current), Some(incoming)) if current.content != incoming.content => {
                    changes.push(VersionFileChange {
                        path,
                        status: VersionFileChangeStatus::Modified,
                        current: Some(current.content.clone()),
                        incoming: Some(incoming.content.clone()),
                    });
                }
                (None, Some(incoming)) => changes.push(VersionFileChange {
                    path,
                    status: VersionFileChangeStatus::Added,
                    current: None,
                    incoming: Some(incoming.content.clone()),
                }),
                (Some(current), None) => changes.push(VersionFileChange {
                    path,
                    status: VersionFileChangeStatus::Deleted,
                    current: Some(current.content.clone()),
                    incoming: None,
                }),
                _ => {}
            }
        }
        Ok(changes)
    }

    /// Metadata-only keyset page for the compareFiles RPC. Content equality is
    /// decided from the kind-specific stored digest, never hydrated bodies.
    pub fn compare_version_files_page(
        &self,
        workspace_id: &str,
        source_version_id: &str,
        target_version_id: &str,
        after_path: Option<&str>,
        limit: usize,
    ) -> Result<VersionFileChangePage, DomainError> {
        if limit == 0 {
            return Err(DomainError::InvalidInput {
                reason: "limit must be positive",
            });
        }
        // `usize as i64` wraps on overflow and SQLite treats a negative LIMIT
        // as unbounded — refuse instead of full-scanning.
        let limit_i64 = i64::try_from(limit).map_err(|_| DomainError::InvalidInput {
            reason: "limit must be positive",
        })?;
        self.store.read_with(|conn| {
            validate_compare_versions(conn, workspace_id, source_version_id, target_version_id)?;
            let mut stmt = conn
                .prepare_cached(
                    "SELECT t.path, t.content_kind, t.blob_sha256, t.binary_sha256, \
                            s.path, s.content_kind, s.blob_sha256, s.binary_sha256 \
                     FROM (SELECT path, content_kind, blob_sha256, binary_sha256 FROM snapshots \
                           WHERE workspace_id = ?1 AND version_id = ?2) AS t \
                     FULL OUTER JOIN \
                          (SELECT path, content_kind, blob_sha256, binary_sha256 FROM snapshots \
                           WHERE workspace_id = ?1 AND version_id = ?3) AS s \
                       ON t.path = s.path \
                     WHERE COALESCE(t.path, s.path) > ?4 \
                     ORDER BY COALESCE(t.path, s.path) LIMIT ?5",
                )
                .map_err(DomainError::sql_corrupt)?;
            let rows = stmt
                .query_map(
                    params![
                        workspace_id,
                        target_version_id,
                        source_version_id,
                        after_path.unwrap_or(""),
                        limit_i64
                    ],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                            row.get::<_, Option<String>>(5)?,
                            row.get::<_, Option<String>>(6)?,
                            row.get::<_, Option<String>>(7)?,
                        ))
                    },
                )
                .map_err(DomainError::sql_corrupt)?;
            let mut entries = Vec::new();
            let mut rows_fetched = 0usize;
            let mut last_scanned_path = None;
            for row in rows {
                let (t_path, t_kind, t_blob, t_bin, s_path, s_kind, s_blob, s_bin) =
                    row.map_err(DomainError::sql_corrupt)?;
                rows_fetched += 1;
                let path =
                    t_path
                        .as_ref()
                        .or(s_path.as_ref())
                        .ok_or(DomainError::StateCorrupt {
                            reason: "version comparison row has no path",
                        })?;
                last_scanned_path = Some(path.clone());
                let entry = match (&t_path, &s_path) {
                    (None, Some(_)) => Some(VersionFileChangeEntry {
                        path: path.clone(),
                        status: VersionFileChangeStatus::Added,
                        binary: s_kind.as_deref() == Some("binary"),
                    }),
                    (Some(_), None) => Some(VersionFileChangeEntry {
                        path: path.clone(),
                        status: VersionFileChangeStatus::Deleted,
                        binary: t_kind.as_deref() == Some("binary"),
                    }),
                    (Some(_), Some(_)) => {
                        let same = t_kind == s_kind
                            && match t_kind.as_deref() {
                                Some("text") => t_blob == s_blob,
                                Some("binary") => t_bin == s_bin,
                                _ => {
                                    return Err(DomainError::StateCorrupt {
                                        reason: "snapshot has an invalid content kind",
                                    });
                                }
                            };
                        (!same).then(|| VersionFileChangeEntry {
                            path: path.clone(),
                            status: VersionFileChangeStatus::Modified,
                            binary: t_kind.as_deref() == Some("binary")
                                || s_kind.as_deref() == Some("binary"),
                        })
                    }
                    (None, None) => unreachable!(),
                };
                if let Some(entry) = entry {
                    entries.push(entry);
                }
            }
            Ok(VersionFileChangePage {
                entries,
                next_after_path: (rows_fetched == limit)
                    .then_some(last_scanned_path)
                    .flatten(),
            })
        })
    }
}

fn validate_compare_versions(
    conn: &Connection,
    workspace_id: &str,
    source_version_id: &str,
    target_version_id: &str,
) -> Result<(), DomainError> {
    for version_id in [source_version_id, target_version_id] {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM versions WHERE workspace_id = ?1 AND version_id = ?2",
                params![workspace_id, version_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(DomainError::sql_corrupt)?;
        if exists.is_none() {
            return Err(DomainError::VersionNotFound);
        }
    }
    Ok(())
}

fn finish_merge<F>(
    tx: &Transaction<'_>,
    input: &MergeTextFileFromVersion,
    payload_hash: &str,
    result: MergeTextFileResult,
    after: &F,
) -> Result<MergeTextFileResult, DomainError>
where
    F: Fn(&Transaction<'_>, &MergeTextFileResult) -> Result<(), DomainError>,
{
    after(tx, &result)?;
    let result_seq = match &result {
        MergeTextFileResult::Write { write, .. } => write.moment.moment_order,
        MergeTextFileResult::BinaryWrite { write, .. } => write.moment.moment_order,
        MergeTextFileResult::Delete { delete, .. } => delete.moment.moment_order,
        MergeTextFileResult::Unchanged { .. } | MergeTextFileResult::Conflict { .. } => 0,
    };
    let comparison = match &result {
        MergeTextFileResult::Write { comparison, .. }
        | MergeTextFileResult::BinaryWrite { comparison, .. }
        | MergeTextFileResult::Delete { comparison, .. }
        | MergeTextFileResult::Unchanged { comparison, .. }
        | MergeTextFileResult::Conflict { comparison, .. } => comparison.clone(),
    };
    let ledger = MergeLedgerRecord {
        payload_hash: payload_hash.to_owned(),
        outcome: merge_ledger_outcome(&result),
        comparison: Some(comparison),
    };
    let ledger_json = serde_json::to_string(&ledger).map_err(|_| DomainError::StateCorrupt {
        reason: "merge ledger outcome could not be encoded",
    })?;
    record_merge_request(
        tx,
        input.request_id.as_deref(),
        &ledger_json,
        result_seq,
        input.now_ms,
    )?;
    Ok(result)
}

fn reconstruct_merge(
    conn: &Connection,
    input: &MergeTextFileFromVersion,
    recorded: &MergeLedgerRecord,
) -> Result<MergeTextFileResult, DomainError> {
    // Exact retries reconstruct the comparison that was part of the committed
    // result. Re-reading live heads here would let a later binary replacement
    // turn an acknowledged merge into `binary-head-not-text`. The fallback is
    // only for ledgers written before comparison snapshots were recorded.
    let comparison = match &recorded.comparison {
        Some(comparison) => comparison.clone(),
        None => compare_text_file_versions_in_db(
            conn,
            &CompareTextFileVersions {
                workspace_id: input.workspace_id.clone(),
                target_version_id: input.target_version_id.clone(),
                source_version_id: input.source_version_id.clone(),
                path: input.path.clone(),
            },
        )?,
    };
    if let MergeLedgerOutcome::Write { moment_id }
    | MergeLedgerOutcome::BinaryWrite { moment_id }
    | MergeLedgerOutcome::Delete { moment_id } = &recorded.outcome
    {
        let moment =
            get_moment(conn, &input.workspace_id, moment_id)?.ok_or(DomainError::StateCorrupt {
                reason: "deduped merge moment is missing",
            })?;
        if moment.version_id != input.target_version_id || moment.path != input.path {
            return Err(DomainError::StateCorrupt {
                reason: "deduped merge moment does not match its request",
            });
        }
        return match (&recorded.outcome, moment.operation) {
            (MergeLedgerOutcome::Write { .. }, crate::records::MomentOp::Write) => {
                Ok(MergeTextFileResult::Write {
                    comparison,
                    write: write_result_from_moment(conn, &input.workspace_id, moment, true)?,
                })
            }
            (MergeLedgerOutcome::BinaryWrite { .. }, crate::records::MomentOp::Write) => {
                Ok(MergeTextFileResult::BinaryWrite {
                    comparison,
                    write: binary_merge_write_from_moment(conn, &input.workspace_id, moment, true)?,
                })
            }
            (MergeLedgerOutcome::Delete { .. }, crate::records::MomentOp::Delete) => {
                Ok(MergeTextFileResult::Delete {
                    comparison,
                    delete: delete_result_from_moment(conn, &input.workspace_id, moment, true)?,
                })
            }
            _ => Err(DomainError::StateCorrupt {
                reason: "deduped merge moment kind does not match its recorded outcome",
            }),
        };
    }
    match &recorded.outcome {
        MergeLedgerOutcome::Unchanged { reason } => Ok(MergeTextFileResult::Unchanged {
            reason: match reason {
                MergeLedgerUnchangedReason::AlreadySame => MergeUnchangedReason::AlreadySame,
                MergeLedgerUnchangedReason::SourceUnchanged => {
                    MergeUnchangedReason::SourceUnchanged
                }
            },
            comparison,
            deduped: true,
        }),
        MergeLedgerOutcome::Conflict { conflict_id } => {
            let conflict = load_text_conflict_in_tx(conn, &input.workspace_id, conflict_id)?
                .ok_or(DomainError::StateCorrupt {
                    reason: "deduped merge conflict is missing",
                })?;
            Ok(MergeTextFileResult::Conflict {
                comparison,
                conflict: Box::new(conflict),
                deduped: true,
            })
        }
        MergeLedgerOutcome::Write { .. }
        | MergeLedgerOutcome::BinaryWrite { .. }
        | MergeLedgerOutcome::Delete { .. } => unreachable!(),
    }
}

/// The binary head a merge left, read back from its own moment. Both the fresh
/// fast-forward and its ledger replay build the result here, so a replay can
/// never describe a head the merge did not write.
fn binary_merge_write_from_moment(
    conn: &Connection,
    workspace_id: &str,
    moment: MomentRecord,
    deduped: bool,
) -> Result<BinaryMergeWrite, DomainError> {
    if moment.operation != MomentOp::Write || moment.after_content_kind != "binary" {
        return Err(DomainError::StateCorrupt {
            reason: "binary merge moment does not describe a binary write",
        });
    }
    let blob_sha256 = moment
        .after_binary_sha256
        .clone()
        .ok_or(DomainError::StateCorrupt {
            reason: "binary merge moment has no binary blob",
        })?;
    let byte_length = moment.after_byte_length.ok_or(DomainError::StateCorrupt {
        reason: "binary merge moment has no byte length",
    })?;
    let object = get_file_object(conn, workspace_id, &moment.object_id)?.ok_or(
        DomainError::StateCorrupt {
            reason: "binary merge moment object missing",
        },
    )?;
    Ok(BinaryMergeWrite {
        object,
        head: ComparisonSide {
            snapshot: TextSnapshot {
                workspace_id: workspace_id.to_owned(),
                version_id: moment.version_id.clone(),
                object_id: moment.object_id.clone(),
                path: moment.path.clone(),
                text: String::new(),
                blob_sha256,
                updated_at_ms: moment.recorded_at_ms,
                latest_moment_id: moment.moment_id.clone(),
                metadata_origin: moment.metadata_origin.clone(),
                metadata_summary: moment.metadata_summary.clone(),
                metadata_correlation_id: moment.metadata_correlation_id.clone(),
            },
            binary: true,
            byte_length,
        },
        moment,
        deduped,
    })
}

fn merge_ledger_outcome(result: &MergeTextFileResult) -> MergeLedgerOutcome {
    match result {
        MergeTextFileResult::Write { write, .. } => MergeLedgerOutcome::Write {
            moment_id: write.moment.moment_id.clone(),
        },
        MergeTextFileResult::BinaryWrite { write, .. } => MergeLedgerOutcome::BinaryWrite {
            moment_id: write.moment.moment_id.clone(),
        },
        MergeTextFileResult::Delete { delete, .. } => MergeLedgerOutcome::Delete {
            moment_id: delete.moment.moment_id.clone(),
        },
        MergeTextFileResult::Conflict { conflict, .. } => MergeLedgerOutcome::Conflict {
            conflict_id: conflict.conflict_id.clone(),
        },
        MergeTextFileResult::Unchanged { reason, .. } => MergeLedgerOutcome::Unchanged {
            reason: match reason {
                MergeUnchangedReason::AlreadySame => MergeLedgerUnchangedReason::AlreadySame,
                MergeUnchangedReason::SourceUnchanged => {
                    MergeLedgerUnchangedReason::SourceUnchanged
                }
            },
        },
    }
}

fn decode_merge_ledger(raw: &str) -> Result<MergeLedgerRecord, DomainError> {
    serde_json::from_str(raw).map_err(|_| DomainError::StateCorrupt {
        reason: "merge request ledger outcome is invalid",
    })
}

fn compare_text_file_versions_in_db(
    conn: &Connection,
    input: &CompareTextFileVersions,
) -> Result<VersionedTextComparison, DomainError> {
    let target_exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM versions WHERE workspace_id = ?1 AND version_id = ?2",
            params![input.workspace_id, input.target_version_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    if target_exists.is_none() {
        return Err(DomainError::VersionNotFound);
    }
    let source: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT kind, fork_version_id FROM versions \
             WHERE workspace_id = ?1 AND version_id = ?2",
            params![input.workspace_id, input.source_version_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    let Some((kind, fork_version_id)) = source else {
        return Err(DomainError::VersionNotFound);
    };
    if VersionKind::from_db(&kind)? != VersionKind::Named
        || fork_version_id.as_deref() != Some(input.target_version_id.as_str())
    {
        return Err(DomainError::ForkBaseNotFound);
    }
    let base = select_snapshot(
        conn,
        "fork_base_snapshots",
        &input.workspace_id,
        &input.source_version_id,
        &input.path,
    )?;
    let current = select_snapshot(
        conn,
        "snapshots",
        &input.workspace_id,
        &input.target_version_id,
        &input.path,
    )?;
    let incoming = select_snapshot(
        conn,
        "snapshots",
        &input.workspace_id,
        &input.source_version_id,
        &input.path,
    )?;
    let status = comparison_status(&base, &current, &incoming);
    Ok(VersionedTextComparison {
        workspace_id: input.workspace_id.clone(),
        path: input.path.clone(),
        target_version_id: input.target_version_id.clone(),
        source_version_id: input.source_version_id.clone(),
        base,
        current,
        incoming,
        status,
    })
}

/// Read the head at `path` in `table` as a comparison side. Both joins are
/// LEFT joins: an inner `JOIN blobs` drops a binary head (`blob_sha256 = NULL`)
/// and would report an occupied path as ABSENT, which is what let a text merge
/// fast-forward over binary bytes.
fn select_snapshot(
    conn: &Connection,
    table: &str,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<Option<ComparisonSide>, DomainError> {
    type SideRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        Option<i64>,
    );
    let sql = format!(
        "SELECT s.object_id, s.path, b.text, s.blob_sha256, s.updated_at_ms, \
         s.latest_moment_id, s.metadata_origin, s.metadata_summary, \
         s.metadata_correlation_id, COALESCE(s.content_kind, 'text'), \
         s.binary_sha256, bb.byte_length FROM {table} s \
         LEFT JOIN blobs b ON b.sha256 = s.blob_sha256 \
         LEFT JOIN binary_blobs bb ON bb.sha256 = s.binary_sha256 \
         WHERE s.workspace_id = ?1 AND s.version_id = ?2 AND s.path = ?3"
    );
    let row: Option<SideRow> = conn
        .query_row(&sql, params![workspace_id, version_id, path], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
            ))
        })
        .optional()
        .map_err(DomainError::sql_corrupt)?;
    let Some((
        object_id,
        snapshot_path,
        text,
        blob_sha256,
        updated_at_ms,
        latest_moment_id,
        metadata_origin,
        metadata_summary,
        metadata_correlation_id,
        content_kind,
        binary_sha256,
        binary_byte_length,
    )) = row
    else {
        return Ok(None);
    };
    let (binary, text, content_sha256, byte_length) = match content_kind.as_str() {
        "text" => {
            let text = text.ok_or(DomainError::StateCorrupt {
                reason: "text snapshot is missing its blob",
            })?;
            let sha256 = blob_sha256.ok_or(DomainError::StateCorrupt {
                reason: "text snapshot is missing its hash",
            })?;
            let byte_length = text.len() as i64;
            (false, text, sha256, byte_length)
        }
        "binary" => {
            let sha256 = binary_sha256.ok_or(DomainError::StateCorrupt {
                reason: "binary snapshot is missing its blob",
            })?;
            let byte_length = binary_byte_length.ok_or(DomainError::StateCorrupt {
                reason: "binary snapshot is missing its byte length",
            })?;
            if byte_length < 0 {
                return Err(DomainError::StateCorrupt {
                    reason: "binary snapshot has an invalid byte length",
                });
            }
            (true, String::new(), sha256, byte_length)
        }
        _ => {
            return Err(DomainError::StateCorrupt {
                reason: "snapshot has an unknown content kind",
            });
        }
    };
    Ok(Some(ComparisonSide {
        snapshot: TextSnapshot {
            workspace_id: workspace_id.to_owned(),
            version_id: version_id.to_owned(),
            object_id,
            path: snapshot_path,
            text,
            blob_sha256: content_sha256,
            updated_at_ms,
            latest_moment_id,
            metadata_origin,
            metadata_summary,
            metadata_correlation_id,
        },
        binary,
        byte_length,
    }))
}

fn merge_write_input(input: &MergeTextFileFromVersion, text: &str) -> WriteText {
    WriteText {
        workspace_id: input.workspace_id.clone(),
        version_id: input.target_version_id.clone(),
        object_id: input.object_id.clone(),
        path: input.path.clone(),
        text: text.to_owned(),
        moment_id: input.moment_id.clone(),
        metadata_origin: input.metadata_origin.clone(),
        metadata_summary: input.metadata_summary.clone(),
        metadata_correlation_id: input.metadata_correlation_id.clone(),
        author_json: input.author_json.clone(),
        now_ms: input.now_ms,
        request_id: None,
    }
}

fn merge_delete_input(input: &MergeTextFileFromVersion) -> DeleteTextFile {
    DeleteTextFile {
        workspace_id: input.workspace_id.clone(),
        version_id: input.target_version_id.clone(),
        path: input.path.clone(),
        moment_id: input.moment_id.clone(),
        request_id: None,
        metadata_origin: input.metadata_origin.clone(),
        metadata_summary: input.metadata_summary.clone(),
        metadata_correlation_id: input.metadata_correlation_id.clone(),
        author_json: input.author_json.clone(),
        now_ms: input.now_ms,
    }
}

fn conflict_from_comparison(
    input: &MergeTextFileFromVersion,
    comparison: &VersionedTextComparison,
) -> TextConflict {
    TextConflict {
        conflict_id: input.conflict_id.clone(),
        workspace_id: comparison.workspace_id.clone(),
        path: comparison.path.clone(),
        target_version_id: comparison.target_version_id.clone(),
        source_version_id: comparison.source_version_id.clone(),
        created_at_ms: input.now_ms,
        updated_at_ms: input.now_ms,
        status: ConflictStatus::Open,
        chosen_from: ConflictChoice::Current,
        resolution: None,
        metadata: ConflictMetadata::origin(input.metadata_origin.clone()),
        base: conflict_side(&comparison.path, &comparison.base),
        current: conflict_side(&comparison.path, &comparison.current),
        incoming: conflict_side(&comparison.path, &comparison.incoming),
    }
}

/// A comparison side as a conflict side. A binary side carries its full head
/// identity (object + latest moment), so the exact-head gate on resolve is as
/// strict for bytes as it is for text.
fn conflict_side(path: &str, side: &Option<ComparisonSide>) -> ConflictFileState {
    match side {
        Some(side) if side.binary => ConflictFileState::binary_head(
            path.to_owned(),
            side.snapshot.blob_sha256.clone(),
            side.byte_length,
            side.snapshot.object_id.clone(),
            side.snapshot.latest_moment_id.clone(),
            side.snapshot.updated_at_ms,
        ),
        Some(side) => ConflictFileState::text(path.to_owned(), Some(side.snapshot.clone())),
        None => ConflictFileState::text(path.to_owned(), None),
    }
}

fn committed<T>(outcome: TxnOutcome<T>) -> Result<T, DomainError> {
    match outcome {
        TxnOutcome::Committed(value) => Ok(value),
        TxnOutcome::Crashed { .. } => Err(DomainError::Storage(StorageError::persist_public(
            std::io::Error::other("merge transaction crashed before acknowledgement"),
        ))),
    }
}

#[derive(Debug)]
struct Hunk {
    base_start: usize,
    base_end: usize,
    replacement: Vec<String>,
}

fn diff_hunks(base: &[&str], side: &[&str]) -> Vec<Hunk> {
    let n = base.len();
    let m = side.len();
    let mut lcs = vec![vec![0_usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if base[i] == side[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    let mut hunks = Vec::new();
    let mut i = 0;
    let mut j = 0;
    let mut pending_start = None;
    let mut pending_replacement = Vec::new();
    while i < n && j < m {
        if base[i] == side[j] {
            flush_hunk(&mut hunks, &mut pending_start, &mut pending_replacement, i);
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            pending_start.get_or_insert(i);
            i += 1;
        } else {
            pending_start.get_or_insert(i);
            pending_replacement.push(side[j].to_owned());
            j += 1;
        }
    }
    if i < n || j < m {
        let start = *pending_start.get_or_insert(i);
        pending_replacement.extend(side[j..].iter().map(|line| (*line).to_owned()));
        hunks.push(Hunk {
            base_start: start,
            base_end: n,
            replacement: pending_replacement,
        });
    } else {
        flush_hunk(&mut hunks, &mut pending_start, &mut pending_replacement, i);
    }
    hunks
}

fn flush_hunk(
    hunks: &mut Vec<Hunk>,
    pending_start: &mut Option<usize>,
    pending_replacement: &mut Vec<String>,
    base_end: usize,
) {
    if let Some(base_start) = pending_start.take() {
        hunks.push(Hunk {
            base_start,
            base_end,
            replacement: std::mem::take(pending_replacement),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn local_equals_remote_is_merged() {
        assert_eq!(
            merge_markdown("base", "same", "same"),
            MarkdownMergeResult::Merged("same".to_owned())
        );
    }

    #[test]
    fn local_equals_base_fast_forwards_remote() {
        assert_eq!(
            merge_markdown("base", "base", "remote"),
            MarkdownMergeResult::Merged("remote".to_owned())
        );
    }

    #[test]
    fn remote_equals_base_fast_forwards_local() {
        assert_eq!(
            merge_markdown("base", "local", "base"),
            MarkdownMergeResult::Merged("local".to_owned())
        );
    }

    #[test]
    fn non_overlapping_hunks_splice_in_base_order() {
        assert_eq!(
            merge_markdown("a\nb\nc", "A\nb\nc", "a\nb\nC"),
            MarkdownMergeResult::Merged("A\nb\nC".to_owned())
        );
    }

    #[test]
    fn overlapping_hunk_ranges_conflict() {
        assert_eq!(
            merge_markdown("a\nb", "local\nb", "remote\nb"),
            MarkdownMergeResult::Conflict
        );
    }

    #[test]
    fn both_insert_at_same_offset_conflict() {
        assert_eq!(
            merge_markdown("a\nb", "local\na\nb", "remote\na\nb"),
            MarkdownMergeResult::Conflict
        );
    }

    #[test]
    fn replacement_and_insertion_at_same_offset_conflict() {
        assert_eq!(
            merge_markdown("a\nb", "replacement\nb", "inserted\na\nb"),
            MarkdownMergeResult::Conflict
        );
    }

    #[test]
    fn over_line_cap_conflicts_before_quadratic_alignment() {
        let base = std::iter::repeat_n("base", MAX_MERGE_LINES + 1)
            .collect::<Vec<_>>()
            .join("\n");
        let started = Instant::now();
        assert_eq!(
            merge_markdown(&base, "local", "remote"),
            MarkdownMergeResult::Conflict
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "line cap must return before allocating the O(n*m) LCS table"
        );
    }
}
