//! Three-way text comparison, conservative markdown merge, and whole-version diff.

use crate::conflicts::{
    ConflictChoice, ConflictFileState, ConflictMetadata, ConflictStatus, TextConflict,
    WriteBinaryFile, check_or_supersede_open_merge_conflict, enqueue_delete, enqueue_write,
    insert_text_conflict_if_absent, load_text_conflict_in_tx, write_binary_file_in_tx,
};
use crate::error::DomainError;
use crate::records::{
    DeleteResult, DeleteTextFile, FileObjectRecord, MomentOp, MomentRecord, TextSnapshot,
    WriteResult, WriteText,
};
use crate::store::{
    VersionedTextStore, delete_result_from_moment, delete_text_in_tx, get_file_object, get_moment,
    hash_fields, lookup_request, record_merge_request, require_unarchived_version,
    validate_delete_input, validate_path, validate_write_input, write_result_from_moment,
    write_text_in_tx,
};
use dohc_engine_storage::text;
use dohc_engine_storage::{FaultInjector, Preimage, StorageError, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
/// empty text, with `blob_sha256` holding its binary content address. The byte
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
/// does: empty text, with `blob_sha256` holding the binary content address and
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

/// Three-way line merge. Each side lines up with the base by a longest common
/// subsequence, and the remote side keeps the copies of repeated lines the
/// local side kept, so both sides' changes to a run of repeated lines land on
/// the same copy. Changes that touch merge once when both sides made the same
/// change and conflict otherwise.
///
/// A clean result is checked before it is returned, and conflicts instead
/// when it fails either rule:
///
/// - A line that appears once in the base and each side appears once in the
///   merge. A line that isn't blank, appears at most once in the base and each
///   side, and that exactly one side added or removed, is added or removed in
///   the merge too. Blank lines, which hold only spaces and tabs, separate
///   blocks and may move.
/// - Between neighbouring lines of every longest chain of lines that appear
///   once in all four texts and keep their order, no line has fewer copies in
///   the merge than both sides kept or more than either side has. A check that
///   would read more than `CHECK_WORK` times the lines of the sides and the
///   merge conflicts.
///
/// Texts over [`MAX_MERGE_LINES`] lines conflict before the quadratic
/// alignment.
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

    let base_lines = lines(base);
    let local_lines = lines(local);
    let remote_lines = lines(remote);
    if [base_lines.len(), local_lines.len(), remote_lines.len()]
        .into_iter()
        .any(|line_count| line_count > MAX_MERGE_LINES)
    {
        return MarkdownMergeResult::Conflict;
    }

    let local_pairs = align(&base_lines, &local_lines, &vec![false; base_lines.len()]);
    let mut kept_by_local = vec![false; base_lines.len()];
    for &(base_index, _) in &local_pairs {
        kept_by_local[base_index] = true;
    }
    let remote_pairs = align(&base_lines, &remote_lines, &kept_by_local);
    let Some(merged) = combine(
        &base_lines,
        hunks(&base_lines, &local_lines, &local_pairs),
        hunks(&base_lines, &remote_lines, &remote_pairs),
    ) else {
        return MarkdownMergeResult::Conflict;
    };
    if !keeps_copies([&base_lines, &local_lines, &remote_lines, &merged]) {
        return MarkdownMergeResult::Conflict;
    }
    MarkdownMergeResult::Merged(merged.join("\n"))
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
                // A request id recorded by a different operation kind stores a
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
            require_unarchived_version(tx, &input.workspace_id, &input.target_version_id)?;
            require_unarchived_version(tx, &input.workspace_id, &input.source_version_id)?;
            let compare_input = CompareTextFileVersions {
                workspace_id: input.workspace_id.clone(),
                target_version_id: input.target_version_id.clone(),
                source_version_id: input.source_version_id.clone(),
                path: input.path.clone(),
            };
            let comparison = compare_text_file_versions_in_db(tx, &compare_input)?;
            fn head_of(side: &Option<ComparisonSide>) -> Option<(&'static str, &str, &str, &str)> {
                side.as_ref().map(|s| {
                    (
                        if s.binary { "binary" } else { "text" },
                        s.snapshot.blob_sha256.as_str(),
                        s.snapshot.object_id.as_str(),
                        s.snapshot.latest_moment_id.as_str(),
                    )
                })
            }
            if let Some(existing) = check_or_supersede_open_merge_conflict(
                tx,
                &input.workspace_id,
                &input.target_version_id,
                &input.source_version_id,
                &input.path,
                head_of(&comparison.current),
                head_of(&comparison.incoming),
                input.now_ms,
            )? {
                let result = MergeTextFileResult::Conflict {
                    comparison,
                    conflict: Box::new(existing),
                    deduped: true,
                };
                return finish_merge(tx, input, &payload_hash, result, &after);
            }
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
            // and delete seams, so it needs both live sides to be text. The base
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

            // The same fast-forward for bytes, through the binary write seam.
            // `comparison_sides_equal` proves current and base equal by content
            // ADDRESS, and a side that holds bytes never compares equal to one
            // that holds text — so an emptied text current over a binary base
            // stays a conflict here, as it must.
            //
            // A removed binary asset keeps its conflict: that seam is the text
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
                        // identity; this id binds only a new target path.
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

            // The line merge is the one branch that reads the base, so all three
            // sides must be text. A binary head's text view is empty, and an
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
                if text == current.snapshot.text {
                    let result = MergeTextFileResult::Unchanged {
                        reason: MergeUnchangedReason::AlreadySame,
                        comparison,
                        deduped: false,
                    };
                    return finish_merge(tx, input, &payload_hash, result, &after);
                }
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
            let result = MergeTextFileResult::Conflict {
                comparison,
                conflict: Box::new(conflict),
                deduped: false,
            };
            finish_merge(tx, input, &payload_hash, result, &after)
        })?;
        committed(outcome)
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
        self.compare_version_files_page_with_drift(
            workspace_id,
            source_version_id,
            target_version_id,
            after_path,
            limit,
            false,
        )
    }

    pub fn compare_version_files_page_with_drift(
        &self,
        workspace_id: &str,
        source_version_id: &str,
        target_version_id: &str,
        after_path: Option<&str>,
        limit: usize,
        include_base_drift: bool,
    ) -> Result<VersionFileChangePage, DomainError> {
        if limit == 0 {
            return Err(DomainError::InvalidInput {
                reason: "limit must be positive",
            });
        }
        let limit_i64 = i64::try_from(limit).map_err(|_| DomainError::InvalidInput {
            reason: "limit must be positive",
        })?;
        self.store.read_with(|conn| {
            validate_compare_versions(conn, workspace_id, source_version_id, target_version_id)?;
            let after_path = after_path.unwrap_or("");
            let pair = if include_base_drift {
                merge_pair(conn, workspace_id, source_version_id, target_version_id)?
            } else {
                None
            };
            let target =
                compare_side_page(conn, workspace_id, target_version_id, after_path, limit_i64)?;
            let source =
                compare_side_page(conn, workspace_id, source_version_id, after_path, limit_i64)?;
            let bases = match &pair {
                Some((named, _)) => {
                    compare_base_page(conn, workspace_id, named, after_path, limit_i64)?
                }
                None => Vec::new(),
            };
            let (mut target, mut source, mut bases) = (
                target.into_iter().peekable(),
                source.into_iter().peekable(),
                bases.into_iter().peekable(),
            );
            let mut entries = Vec::new();
            let mut rows_merged = 0usize;
            let mut last_scanned_path = None;
            while rows_merged < limit {
                let next_path = [
                    target.peek().map(|r| r.path.as_str()),
                    source.peek().map(|r| r.path.as_str()),
                    bases.peek().map(|r| r.path.as_str()),
                ]
                .into_iter()
                .flatten()
                .min()
                .map(str::to_owned);
                let Some(path) = next_path else { break };
                let t = target.next_if(|r| r.path == path);
                let s = source.next_if(|r| r.path == path);
                let b = bases.next_if(|r| r.path == path);
                rows_merged += 1;
                last_scanned_path = Some(path.clone());
                let entry = match (t, s) {
                    (None, Some(s)) => Some(VersionFileChangeEntry {
                        binary: s.kind == "binary",
                        path: s.path,
                        status: VersionFileChangeStatus::Added,
                    }),
                    (Some(t), None) => Some(VersionFileChangeEntry {
                        binary: t.kind == "binary",
                        path: t.path,
                        status: VersionFileChangeStatus::Deleted,
                    }),
                    (Some(t), Some(s)) => {
                        let same = t.kind == s.kind
                            && match t.kind.as_str() {
                                "text" => t.blob == s.blob,
                                "binary" => t.bin == s.bin,
                                _ => {
                                    return Err(DomainError::StateCorrupt {
                                        reason: "snapshot has an invalid content kind",
                                    });
                                }
                            };
                        let drifted = if same && let Some((named, _)) = &pair {
                            let tip_id = side_row_identity(&s)?;
                            base_differs_from_agreed_tip(
                                conn,
                                workspace_id,
                                named,
                                &s.path,
                                Some(tip_id),
                                b.as_ref(),
                            )?
                        } else {
                            false
                        };
                        (!same || drifted).then(|| VersionFileChangeEntry {
                            binary: t.kind == "binary" || s.kind == "binary",
                            path: t.path,
                            status: VersionFileChangeStatus::Modified,
                        })
                    }
                    (None, None) => {
                        let drifted = if let Some((named, _)) = &pair {
                            base_differs_from_agreed_tip(
                                conn,
                                workspace_id,
                                named,
                                &path,
                                None,
                                b.as_ref(),
                            )?
                        } else {
                            false
                        };
                        drifted.then_some(VersionFileChangeEntry {
                            binary: false,
                            path,
                            status: VersionFileChangeStatus::Modified,
                        })
                    }
                };
                if let Some(entry) = entry {
                    entries.push(entry);
                }
            }
            Ok(VersionFileChangePage {
                entries,
                next_after_path: (rows_merged == limit)
                    .then_some(last_scanned_path)
                    .flatten(),
            })
        })
    }
}

struct CompareBaseRow {
    path: String,
    fb_kind: Option<String>,
    fb_blob: Option<String>,
    fb_bin: Option<String>,
    has_merge_base: bool,
}

fn side_row_identity(row: &CompareSideRow) -> Result<(&'static str, &str), DomainError> {
    match row.kind.as_str() {
        "text" => Ok((
            "text",
            row.blob.as_deref().ok_or(DomainError::StateCorrupt {
                reason: "text snapshot lacks blob_sha256",
            })?,
        )),
        "binary" => Ok((
            "binary",
            row.bin.as_deref().ok_or(DomainError::StateCorrupt {
                reason: "binary snapshot lacks binary_sha256",
            })?,
        )),
        _ => Err(DomainError::StateCorrupt {
            reason: "snapshot has an invalid content kind",
        }),
    }
}

const COMPARE_BASE_PAGE_SQL: &str = "WITH page(path) AS ( \
        SELECT path FROM fork_base_snapshots WHERE workspace_id = ?1 AND version_id = ?2 AND path > ?3 \
        UNION SELECT path FROM merge_bases WHERE workspace_id = ?1 AND source_version_id = ?2 AND path > ?3 \
        ORDER BY 1 LIMIT ?4) \
     SELECT p.path, fb.content_kind, fb.blob_sha256, fb.binary_sha256, \
            EXISTS(SELECT 1 FROM merge_bases m WHERE m.workspace_id = ?1 AND m.source_version_id = ?2 AND m.path = p.path) \
     FROM page p \
     LEFT JOIN fork_base_snapshots fb \
       ON fb.workspace_id = ?1 AND fb.version_id = ?2 AND fb.path = p.path \
     ORDER BY p.path";

fn compare_base_page(
    conn: &Connection,
    workspace_id: &str,
    named_version_id: &str,
    after_path: &str,
    limit: i64,
) -> Result<Vec<CompareBaseRow>, DomainError> {
    let mut stmt = conn
        .prepare_cached(COMPARE_BASE_PAGE_SQL)
        .map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(
            params![workspace_id, named_version_id, after_path, limit],
            |row| {
                Ok(CompareBaseRow {
                    path: row.get(0)?,
                    fb_kind: row.get(1)?,
                    fb_blob: row.get(2)?,
                    fb_bin: row.get(3)?,
                    has_merge_base: row.get::<_, i64>(4)? != 0,
                })
            },
        )
        .map_err(DomainError::sql_corrupt)?;
    rows.collect::<Result<_, _>>()
        .map_err(DomainError::sql_corrupt)
}

fn base_differs_from_agreed_tip(
    conn: &Connection,
    workspace_id: &str,
    named_version_id: &str,
    path: &str,
    tip_id: ContentIdentity<'_>,
    base_row: Option<&CompareBaseRow>,
) -> Result<bool, DomainError> {
    fn key_of<'a>(
        kind: Option<&str>,
        blob: Option<&'a str>,
        bin: Option<&'a str>,
    ) -> ContentIdentity<'a> {
        match kind {
            Some("binary") => bin.map(|s| ("binary", s)),
            Some(_) => blob.map(|s| ("text", s)),
            None => None,
        }
    }
    if !base_row.is_some_and(|row| row.has_merge_base) {
        let fb = base_row.and_then(|r| {
            key_of(
                r.fb_kind.as_deref(),
                r.fb_blob.as_deref(),
                r.fb_bin.as_deref(),
            )
        });
        return Ok(fb != tip_id);
    }
    let mut stmt = conn
        .prepare_cached(
            "SELECT base_exists, prior_exists, target_before_kind, target_before_sha256, \
                    target_after_kind, target_after_sha256, \
                    base_content_kind, base_blob_sha256, base_binary_sha256, \
                    prior_content_kind, prior_blob_sha256, prior_binary_sha256 \
             FROM merge_bases \
             WHERE workspace_id = ?1 AND source_version_id = ?2 AND path = ?3 \
             ORDER BY merge_seq ASC",
        )
        .map_err(DomainError::sql_corrupt)?;
    type MergeBaseRow = (
        i64,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let rows: Vec<MergeBaseRow> = stmt
        .query_map(params![workspace_id, named_version_id, path], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10)?,
                r.get(11)?,
            ))
        })
        .map_err(DomainError::sql_corrupt)?
        .collect::<Result<_, _>>()
        .map_err(DomainError::sql_corrupt)?;
    let chosen = rows
        .iter()
        .find_map(|r| {
            let before = r.2.as_deref().zip(r.3.as_deref());
            let after = r.4.as_deref().zip(r.5.as_deref());
            (tip_id == before && tip_id != after).then_some((r.1, &r.9, &r.10, &r.11))
        })
        .unwrap_or_else(|| {
            let last = rows.last().expect("has_merge_base guaranteed row");
            (last.0, &last.6, &last.7, &last.8)
        });
    let base_id = (chosen.0 != 0)
        .then(|| {
            key_of(
                chosen.1.as_deref(),
                chosen.2.as_deref(),
                chosen.3.as_deref(),
            )
        })
        .flatten();
    Ok(base_id != tip_id)
}

struct CompareSideRow {
    path: String,
    kind: String,
    blob: Option<String>,
    bin: Option<String>,
}

/// The next `limit` files of one version after `after_path`, in path order.
/// `snapshots` has no path index, so the page walks the path key of
/// `path_aliases` and reads each file's head by its object. Reading the rest
/// of both versions and sorting it on every page took 33 s to compare two
/// 50,000-file versions in pages of 200.
fn compare_side_page(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    after_path: &str,
    limit: i64,
) -> Result<Vec<CompareSideRow>, DomainError> {
    let mut stmt = conn
        .prepare_cached(COMPARE_SIDE_PAGE_SQL)
        .map_err(DomainError::sql_corrupt)?;
    let rows = stmt
        .query_map(
            params![workspace_id, version_id, after_path, limit],
            |row| {
                Ok(CompareSideRow {
                    path: row.get(0)?,
                    kind: row.get(1)?,
                    blob: row.get(2)?,
                    bin: row.get(3)?,
                })
            },
        )
        .map_err(DomainError::sql_corrupt)?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(DomainError::sql_corrupt)
}

const COMPARE_SIDE_PAGE_SQL: &str = "SELECT a.path, s.content_kind, s.blob_sha256, s.binary_sha256 \
     FROM path_aliases a JOIN snapshots s \
       ON s.workspace_id = a.workspace_id AND s.version_id = a.version_id \
      AND s.object_id = a.object_id AND s.path = a.path \
     WHERE a.workspace_id = ?1 AND a.version_id = ?2 AND a.path > ?3 \
     ORDER BY a.path LIMIT ?4";

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
    // The version's side reached the target, so its next merge of this path
    // starts from here. Source unchanged and a conflict move nothing.
    let merged = match &result {
        MergeTextFileResult::Write { comparison, write } => Some((
            comparison,
            Some(("text", write.snapshot.blob_sha256.as_str())),
        )),
        MergeTextFileResult::BinaryWrite { comparison, write } => Some((
            comparison,
            Some(("binary", write.head.snapshot.blob_sha256.as_str())),
        )),
        MergeTextFileResult::Delete { comparison, .. } => Some((comparison, None)),
        // A version unchanged since its base brings nothing; recording it
        // would overwrite the row that detects an undo of the last merge.
        // Same for a line merge that reproduced the target while tips still differ.
        MergeTextFileResult::Unchanged {
            reason: MergeUnchangedReason::AlreadySame,
            comparison,
            ..
        } if comparison_sides_equal(&comparison.current, &comparison.incoming)
            && !comparison_sides_equal(&comparison.incoming, &comparison.base) =>
        {
            Some((comparison, content_identity(&comparison.current)))
        }
        MergeTextFileResult::Unchanged { .. } | MergeTextFileResult::Conflict { .. } => None,
    };
    if let Some((comparison, target_after)) = merged {
        record_merge_base(tx, comparison, target_after)?;
    }
    let result_seq = match &result {
        MergeTextFileResult::Write { write, .. } => write.moment.moment_order,
        MergeTextFileResult::BinaryWrite { write, .. } => write.moment.moment_order,
        MergeTextFileResult::Delete { delete, .. } => delete.moment.moment_order,
        MergeTextFileResult::Unchanged { .. } | MergeTextFileResult::Conflict { .. } => 0,
    };
    // The moment replays another version's change. Automations claimed that
    // change where it was made, so the records it adds or removes here claim
    // nothing (automations.rs).
    if result_seq > 0 {
        tx.execute(
            "INSERT OR IGNORE INTO merged_moments (workspace_id, moment_order) VALUES (?1, ?2)",
            params![input.workspace_id, result_seq],
        )
        .map_err(DomainError::sql_persist)?;
    }
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
    for version_id in [&input.target_version_id, &input.source_version_id] {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM versions WHERE workspace_id = ?1 AND version_id = ?2",
                params![input.workspace_id, version_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(DomainError::sql_corrupt)?;
        if exists.is_none() {
            return Err(DomainError::VersionNotFound);
        }
    }
    let Some((named_version_id, merged_into)) = merge_pair(
        conn,
        &input.workspace_id,
        &input.source_version_id,
        &input.target_version_id,
    )?
    else {
        return Err(DomainError::ForkBaseNotFound);
    };
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
    let (parent_side, named_side) = if merged_into == MERGED_INTO_PARENT {
        (&current, &incoming)
    } else {
        (&incoming, &current)
    };
    let base = select_merge_base(
        conn,
        &input.workspace_id,
        &named_version_id,
        &input.path,
        parent_side,
        named_side,
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
/// left joins: an inner `JOIN blobs` drops a binary head (`blob_sha256 = NULL`)
/// and would report an occupied path as absent, which is what let a text merge
/// fast-forward over binary bytes.
fn select_snapshot(
    conn: &Connection,
    table: &str,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<Option<ComparisonSide>, DomainError> {
    let sql = format!(
        "SELECT s.object_id, s.path, b.sha256, s.blob_sha256, s.updated_at_ms, \
         s.latest_moment_id, s.metadata_origin, s.metadata_summary, \
         s.metadata_correlation_id, COALESCE(s.content_kind, 'text'), \
         s.binary_sha256, bb.byte_length FROM {table} s \
         LEFT JOIN blobs b ON b.sha256 = s.blob_sha256 \
         LEFT JOIN binary_blobs bb ON bb.sha256 = s.binary_sha256 \
         WHERE s.workspace_id = ?1 AND s.version_id = ?2 AND s.path = ?3"
    );
    select_side(
        conn,
        &sql,
        params![workspace_id, version_id, path],
        workspace_id,
        version_id,
    )
}

/// What a side holds: its content kind and content address, or `None` when
/// the path holds no file.
pub(crate) type ContentIdentity<'a> = Option<(&'static str, &'a str)>;

fn content_identity(side: &Option<ComparisonSide>) -> ContentIdentity<'_> {
    side.as_ref().map(|side| {
        let kind = if side.binary { "binary" } else { "text" };
        (kind, side.snapshot.blob_sha256.as_str())
    })
}

pub(crate) const MERGED_INTO_PARENT: &str = "main";
pub(crate) const MERGED_INTO_NAMED: &str = "named";

/// The named version whose merge base a merge between `source` and `target`
/// reads and records, and which side the merge writes: the version's fork
/// parent (`MERGED_INTO_PARENT`) or the named version (`MERGED_INTO_NAMED`).
pub(crate) fn merge_pair(
    conn: &Connection,
    workspace_id: &str,
    source_version_id: &str,
    target_version_id: &str,
) -> Result<Option<(String, &'static str)>, DomainError> {
    let fork_of = |version_id: &str| -> Result<Option<String>, DomainError> {
        conn.query_row(
            "SELECT fork_version_id FROM versions \
             WHERE workspace_id = ?1 AND version_id = ?2 AND kind = 'named'",
            params![workspace_id, version_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(DomainError::sql_corrupt)
    };
    if fork_of(source_version_id)?.as_deref() == Some(target_version_id) {
        return Ok(Some((source_version_id.to_owned(), MERGED_INTO_PARENT)));
    }
    if fork_of(target_version_id)?.as_deref() == Some(source_version_id) {
        return Ok(Some((target_version_id.to_owned(), MERGED_INTO_NAMED)));
    }
    Ok(None)
}

/// The base a merge of `path` between a named version and its fork parent
/// compares against: what the last merge in either direction carried at that
/// path, or the fork point if none has. When the side that merge wrote holds
/// what it held just before, and not what the merge left, the merge was
/// undone there; the base is then the one that merge itself used, so merging
/// again applies the change again.
fn select_merge_base(
    conn: &Connection,
    workspace_id: &str,
    named_version_id: &str,
    path: &str,
    parent_side: &Option<ComparisonSide>,
    named_side: &Option<ComparisonSide>,
) -> Result<Option<ComparisonSide>, DomainError> {
    type MergeBaseRow = (
        i64,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
    );
    let mut stmt = conn
        .prepare(
            "SELECT base_exists, prior_exists, target_before_kind, target_before_sha256, \
             target_after_kind, target_after_sha256, merged_into FROM merge_bases \
             WHERE workspace_id = ?1 AND source_version_id = ?2 AND path = ?3 \
             ORDER BY merge_seq ASC",
        )
        .map_err(DomainError::sql_corrupt)?;
    let rows: Vec<MergeBaseRow> = stmt
        .query_map(params![workspace_id, named_version_id, path], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })
        .map_err(DomainError::sql_corrupt)?
        .collect::<Result<_, _>>()
        .map_err(DomainError::sql_corrupt)?;
    if rows.is_empty() {
        return select_snapshot(
            conn,
            "fork_base_snapshots",
            workspace_id,
            named_version_id,
            path,
        );
    }
    let (chosen_dir, side, exists) = rows
        .iter()
        .find_map(
            |(_, prior_exists, before_kind, before_sha, after_kind, after_sha, merged_into)| {
                let held = content_identity(if merged_into == MERGED_INTO_PARENT {
                    parent_side
                } else {
                    named_side
                });
                let before = before_kind.as_deref().zip(before_sha.as_deref());
                let after = after_kind.as_deref().zip(after_sha.as_deref());
                (held == before && held != after).then_some((
                    merged_into.as_str(),
                    "prior",
                    *prior_exists,
                ))
            },
        )
        .unwrap_or_else(|| {
            let latest = rows.last().expect("rows is non-empty");
            (latest.6.as_str(), "base", latest.0)
        });
    if exists == 0 {
        return Ok(None);
    }
    let sql = format!(
        "SELECT m.{side}_object_id, m.path, b.sha256, m.{side}_blob_sha256, \
         m.{side}_updated_at_ms, m.{side}_latest_moment_id, m.{side}_metadata_origin, \
         m.{side}_metadata_summary, m.{side}_metadata_correlation_id, \
         m.{side}_content_kind, m.{side}_binary_sha256, bb.byte_length FROM merge_bases m \
         LEFT JOIN blobs b ON b.sha256 = m.{side}_blob_sha256 \
         LEFT JOIN binary_blobs bb ON bb.sha256 = m.{side}_binary_sha256 \
         WHERE m.workspace_id = ?1 AND m.source_version_id = ?2 AND m.path = ?3 \
         AND m.merged_into = ?4"
    );
    select_side(
        conn,
        &sql,
        params![workspace_id, named_version_id, path, chosen_dir],
        workspace_id,
        named_version_id,
    )
}

/// Record that `comparison.path` crossed between a named version and its
/// fork parent: the incoming side becomes the path's merge base, the base the
/// comparison used becomes its prior, and the target's content before
/// (`current`) and after (`target_after`) tell a later merge whether this one
/// was undone.
fn record_merge_base(
    tx: &Transaction<'_>,
    comparison: &VersionedTextComparison,
    target_after: ContentIdentity<'_>,
) -> Result<(), DomainError> {
    use rusqlite::types::Value;
    fn text(value: &str) -> Value {
        Value::Text(value.to_owned())
    }
    fn optional(value: &Option<String>) -> Value {
        value.as_deref().map_or(Value::Null, text)
    }
    fn side(side: &Option<ComparisonSide>) -> [Value; 10] {
        let Some(side) = side else {
            return [
                Value::Integer(0),
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
            ];
        };
        let snapshot = &side.snapshot;
        let (kind, blob, binary) = if side.binary {
            ("binary", Value::Null, text(&snapshot.blob_sha256))
        } else {
            ("text", text(&snapshot.blob_sha256), Value::Null)
        };
        [
            Value::Integer(1),
            text(&snapshot.object_id),
            text(kind),
            blob,
            binary,
            Value::Integer(snapshot.updated_at_ms),
            text(&snapshot.latest_moment_id),
            text(&snapshot.metadata_origin),
            optional(&snapshot.metadata_summary),
            optional(&snapshot.metadata_correlation_id),
        ]
    }
    fn identity(identity: ContentIdentity<'_>) -> [Value; 2] {
        identity.map_or([Value::Null, Value::Null], |(kind, sha)| {
            [text(kind), text(sha)]
        })
    }
    let Some((named_version_id, merged_into)) = merge_pair(
        tx,
        &comparison.workspace_id,
        &comparison.source_version_id,
        &comparison.target_version_id,
    )?
    else {
        return Err(DomainError::ForkBaseNotFound);
    };
    let other_dir = if merged_into == MERGED_INTO_PARENT {
        MERGED_INTO_NAMED
    } else {
        MERGED_INTO_PARENT
    };
    let (in_kind, in_sha) = match content_identity(&comparison.incoming) {
        Some((k, s)) => (Some(k), Some(s)),
        None => (None, None),
    };
    tx.execute(
        "DELETE FROM merge_bases \
         WHERE workspace_id = ?1 AND source_version_id = ?2 AND path = ?3 AND merged_into = ?4 \
           AND (target_after_kind IS NOT ?5 OR target_after_sha256 IS NOT ?6)",
        params![
            comparison.workspace_id,
            named_version_id,
            comparison.path,
            other_dir,
            in_kind,
            in_sha
        ],
    )
    .map_err(DomainError::sql_persist)?;
    let mut values = vec![
        text(&comparison.workspace_id),
        text(&named_version_id),
        text(&comparison.path),
    ];
    values.extend(side(&comparison.incoming));
    values.extend(side(&comparison.base));
    values.extend(identity(content_identity(&comparison.current)));
    values.extend(identity(target_after));
    values.push(text(merged_into));
    tx.execute(
        "INSERT OR REPLACE INTO merge_bases (workspace_id, source_version_id, path, \
         base_exists, base_object_id, base_content_kind, base_blob_sha256, \
         base_binary_sha256, base_updated_at_ms, base_latest_moment_id, base_metadata_origin, \
         base_metadata_summary, base_metadata_correlation_id, \
         prior_exists, prior_object_id, prior_content_kind, prior_blob_sha256, \
         prior_binary_sha256, prior_updated_at_ms, prior_latest_moment_id, \
         prior_metadata_origin, prior_metadata_summary, prior_metadata_correlation_id, \
         target_before_kind, target_before_sha256, target_after_kind, target_after_sha256, \
         merged_into, merge_seq) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, \
         ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, \
         COALESCE((SELECT MAX(merge_seq) FROM merge_bases \
                   WHERE workspace_id = ?1 AND source_version_id = ?2 AND path = ?3), 0) + 1)",
        rusqlite::params_from_iter(values),
    )
    .map_err(DomainError::sql_persist)?;
    Ok(())
}

/// Record a resolved merge conflict as merged, whatever the resolution kept,
/// as Git does. A sync conflict, or a resolution that wrote another path,
/// records nothing.
pub(crate) fn record_resolved_merge_conflict(
    tx: &Transaction<'_>,
    conflict: &TextConflict,
    target_after: Option<ContentIdentity<'_>>,
) -> Result<(), DomainError> {
    let Some(target_after) = target_after else {
        return Ok(());
    };
    if merge_pair(
        tx,
        &conflict.workspace_id,
        &conflict.source_version_id,
        &conflict.target_version_id,
    )?
    .is_none()
    {
        return Ok(());
    }
    let side = |state: &ConflictFileState| conflict_state_side(conflict, state);
    let (Some(base), Some(current), Some(incoming)) = (
        side(&conflict.base),
        side(&conflict.current),
        side(&conflict.incoming),
    ) else {
        return Ok(());
    };
    let comparison = VersionedTextComparison {
        workspace_id: conflict.workspace_id.clone(),
        path: conflict.path.clone(),
        target_version_id: conflict.target_version_id.clone(),
        source_version_id: conflict.source_version_id.clone(),
        status: comparison_status(&base, &current, &incoming),
        base,
        current,
        incoming,
    };
    record_merge_base(tx, &comparison, target_after)
}

/// A conflict side as a comparison side; `None` when a binary side lacks
/// the head identity a merge conflict always records.
fn conflict_state_side(
    conflict: &TextConflict,
    state: &ConflictFileState,
) -> Option<Option<ComparisonSide>> {
    if let Some(snapshot) = &state.snapshot {
        return Some(Some(ComparisonSide {
            byte_length: snapshot.text.len() as i64,
            snapshot: snapshot.clone(),
            binary: false,
        }));
    }
    let Some(binary_sha256) = &state.binary_sha256 else {
        return Some(None);
    };
    Some(Some(ComparisonSide {
        snapshot: TextSnapshot {
            workspace_id: conflict.workspace_id.clone(),
            version_id: String::new(),
            object_id: state.binary_object_id.clone()?,
            path: state.path.clone(),
            text: String::new(),
            blob_sha256: binary_sha256.clone(),
            updated_at_ms: state.binary_updated_at_ms?,
            latest_moment_id: state.binary_latest_moment_id.clone()?,
            // A binary conflict side keeps no origin of its own.
            metadata_origin: conflict.metadata.origin.clone(),
            metadata_summary: state.metadata_summary.clone(),
            metadata_correlation_id: state.metadata_correlation_id.clone(),
        },
        binary: true,
        byte_length: state.binary_byte_length.unwrap_or(0),
    }))
}

/// Read one comparison side with `sql`, which selects `select_snapshot`'s
/// columns for `(workspace_id, version_id, path)`.
fn select_side(
    conn: &Connection,
    sql: &str,
    query_params: impl rusqlite::Params,
    workspace_id: &str,
    version_id: &str,
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
    let row: Option<SideRow> = conn
        .query_row(sql, query_params, |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                text::optional_from_row(conn, row, 2)?,
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

struct Hunk<'a> {
    base_start: usize,
    base_end: usize,
    replacement: &'a [&'a str],
}

const MATCH_SCORE: u32 = 1 << 16;
const CHECK_WORK: usize = 4;

fn align(base: &[&str], side: &[&str], prefer: &[bool]) -> Vec<(usize, usize)> {
    let (rows, columns) = (base.len(), side.len());
    let width = columns + 1;
    let mut score = vec![0_u32; (rows + 1) * width];
    let matched = |score: &[u32], row: usize, column: usize| {
        score[(row + 1) * width + column + 1] + MATCH_SCORE + u32::from(prefer[row])
    };
    for row in (0..rows).rev() {
        for column in (0..columns).rev() {
            let skipped = score[(row + 1) * width + column].max(score[row * width + column + 1]);
            score[row * width + column] = if base[row] == side[column] {
                skipped.max(matched(&score, row, column))
            } else {
                skipped
            };
        }
    }

    let mut pairs = Vec::new();
    let (mut row, mut column) = (0, 0);
    while row < rows && column < columns {
        if base[row] == side[column] && score[row * width + column] == matched(&score, row, column)
        {
            pairs.push((row, column));
            row += 1;
            column += 1;
        } else if score[(row + 1) * width + column] >= score[row * width + column + 1] {
            row += 1;
        } else {
            column += 1;
        }
    }
    pairs
}

fn hunks<'a>(base: &[&str], side: &'a [&'a str], pairs: &[(usize, usize)]) -> Vec<Hunk<'a>> {
    let mut hunks = Vec::new();
    let (mut base_start, mut side_start) = (0, 0);
    for &(base_end, side_end) in pairs.iter().chain([&(base.len(), side.len())]) {
        if base_end > base_start || side_end > side_start {
            hunks.push(Hunk {
                base_start,
                base_end,
                replacement: &side[side_start..side_end],
            });
        }
        base_start = base_end + 1;
        side_start = side_end + 1;
    }
    hunks
}

fn touches(left: &Hunk<'_>, right: &Hunk<'_>) -> bool {
    let left_inserts = left.base_start == left.base_end;
    let right_inserts = right.base_start == right.base_end;
    (left.base_start == right.base_start && (left_inserts || right_inserts))
        || (left.base_start < right.base_end && right.base_start < left.base_end)
}

fn combine<'a>(
    base: &[&'a str],
    local: Vec<Hunk<'a>>,
    remote: Vec<Hunk<'a>>,
) -> Option<Vec<&'a str>> {
    let mut all: Vec<(bool, Hunk<'a>)> = local
        .into_iter()
        .map(|hunk| (false, hunk))
        .chain(remote.into_iter().map(|hunk| (true, hunk)))
        .collect();
    all.sort_by_key(|(_, hunk)| (hunk.base_start, hunk.base_end));
    let mut output = Vec::new();
    let mut cursor = 0;
    let mut rest = all.into_iter().peekable();
    while let Some(first) = rest.next() {
        let mut group = vec![first];
        while let Some(next) = rest.next_if(|(next_side, next)| {
            group
                .iter()
                .any(|(side, hunk)| side != next_side && touches(hunk, next))
        }) {
            group.push(next);
        }
        let start = group.iter().map(|(_, hunk)| hunk.base_start).min()?;
        let end = group.iter().map(|(_, hunk)| hunk.base_end).max()?;
        let version = |remote: bool| {
            let mut lines = Vec::new();
            let mut at = start;
            for (_, hunk) in group.iter().filter(|(side, _)| *side == remote) {
                lines.extend_from_slice(&base[at..hunk.base_start]);
                lines.extend_from_slice(hunk.replacement);
                at = hunk.base_end;
            }
            lines.extend_from_slice(&base[at..end]);
            lines
        };
        let local_changed = group.iter().any(|(side, _)| !side);
        let remote_changed = group.iter().any(|(side, _)| *side);
        let lines = version(!local_changed);
        if local_changed && remote_changed && lines != version(true) {
            return None;
        }
        output.extend_from_slice(&base[cursor..start]);
        output.extend(lines);
        cursor = end;
    }
    output.extend_from_slice(&base[cursor..]);
    Some(output)
}

fn lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').collect()
    }
}

fn keeps_copies(texts: [&[&str]; 4]) -> bool {
    let mut counts: HashMap<&str, [usize; 4]> = HashMap::new();
    for (index, text) in texts.iter().enumerate() {
        for line in *text {
            counts.entry(line).or_default()[index] += 1;
        }
    }
    if counts.iter().any(|(line, &[base, local, remote, merged])| {
        base.max(local).max(remote) <= 1
            && (base, local, remote) != (0, 1, 1)
            && (!line.bytes().all(|byte| matches!(byte, b' ' | b'\t'))
                || (base, local, remote) == (1, 1, 1))
            && merged != if base == local { remote } else { local }
    }) {
        return false;
    }
    let mut positions: HashMap<&str, [usize; 4]> = HashMap::new();
    for (index, text) in texts.iter().enumerate() {
        for (position, line) in text.iter().enumerate() {
            if matches!(counts[line], [1, 1, 1, 1]) {
                positions.entry(line).or_default()[index] = position;
            }
        }
    }
    let anchors: Vec<[usize; 4]> = texts[0]
        .iter()
        .filter_map(|line| positions.get(line).copied())
        .collect();
    let before = |earlier: usize, later: usize| {
        (0..4).all(|index| anchors[earlier][index] < anchors[later][index])
    };
    let mut ending = vec![1_usize; anchors.len()];
    for later in 0..anchors.len() {
        for earlier in 0..later {
            if before(earlier, later) {
                ending[later] = ending[later].max(ending[earlier] + 1);
            }
        }
    }
    let mut starting = vec![1_usize; anchors.len()];
    for earlier in (0..anchors.len()).rev() {
        for later in earlier + 1..anchors.len() {
            if before(earlier, later) {
                starting[earlier] = starting[earlier].max(starting[later] + 1);
            }
        }
    }
    let longest = ending.iter().copied().max().unwrap_or(0);
    let on_chain: Vec<usize> = (0..anchors.len())
        .filter(|&index| ending[index] + starting[index] == longest + 1)
        .collect();
    let first = [0; 4];
    let last = texts.map(<[&str]>::len);
    let after = |index: usize| anchors[index].map(|position| position + 1);
    let mut budget = CHECK_WORK * (last[1] + last[2] + last[3]);
    let mut keeps = |starts: [usize; 4], ends: [usize; 4]| {
        let work: usize = (1..4).map(|side| ends[side] - starts[side]).sum();
        if work > budget {
            return false;
        }
        budget -= work;
        stretch_keeps_copies(&texts, starts, ends)
    };
    if on_chain.is_empty() {
        return keeps(first, last);
    }
    for &earlier in &on_chain {
        if ending[earlier] == 1 && !keeps(first, anchors[earlier]) {
            return false;
        }
        if starting[earlier] == 1 && !keeps(after(earlier), last) {
            return false;
        }
        for &later in &on_chain {
            if ending[later] == ending[earlier] + 1
                && before(earlier, later)
                && !keeps(after(earlier), anchors[later])
            {
                return false;
            }
        }
    }
    true
}

fn stretch_keeps_copies(texts: &[&[&str]; 4], starts: [usize; 4], ends: [usize; 4]) -> bool {
    let mut counts: HashMap<&str, [usize; 3]> = HashMap::new();
    for side in 1..4 {
        for line in &texts[side][starts[side]..ends[side]] {
            counts.entry(line).or_default()[side - 1] += 1;
        }
    }
    counts
        .values()
        .all(|&[local, remote, merged]| local.min(remote) <= merged && merged <= local.max(remote))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

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

    #[test]
    fn reordering_both_halves_hits_the_check_limit() {
        let half = MAX_MERGE_LINES / 2 - 1;
        let names: Vec<String> = (0..MAX_MERGE_LINES)
            .map(|line| format!("line {line}"))
            .collect();
        let mut local = names.clone();
        local[..half].reverse();
        local[half..2 * half].reverse();
        let mut remote = names.clone();
        remote[MAX_MERGE_LINES - 1] = "remote".to_owned();
        assert_eq!(
            merge_markdown(&names.join("\n"), &local.join("\n"), &remote.join("\n")),
            MarkdownMergeResult::Conflict
        );
    }
}
