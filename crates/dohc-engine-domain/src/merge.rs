//! Three-way text comparison, conservative markdown merge, and whole-version diff.

use crate::conflicts::{
    ConflictChoice, ConflictFileState, ConflictMetadata, ConflictStatus, TextConflict,
    enqueue_delete, enqueue_write, insert_text_conflict_if_absent,
};
use crate::error::DomainError;
use crate::records::{
    DeleteResult, DeleteTextFile, TextSnapshot, VersionKind, WriteResult, WriteText,
};
use crate::store::{
    VersionedTextStore, delete_text_in_tx, validate_delete_input, validate_path,
    validate_write_input, write_text_in_tx,
};
use dohc_engine_storage::{FaultInjector, Preimage, StorageError, TxnOutcome};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_MERGE_LINES: usize = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarkdownMergeResult {
    Merged(String),
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComparisonStatus {
    Same,
    IncomingChanged,
    CurrentChanged,
    Diverged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionedTextComparison {
    pub workspace_id: String,
    pub path: String,
    pub target_version_id: String,
    pub source_version_id: String,
    pub base: Option<TextSnapshot>,
    pub current: Option<TextSnapshot>,
    pub incoming: Option<TextSnapshot>,
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
    pub conflict_id: String,
    pub metadata_origin: String,
    pub author_json: Option<String>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeUnchangedReason {
    AlreadySame,
    SourceUnchanged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeTextFileResult {
    Unchanged {
        reason: MergeUnchangedReason,
        comparison: VersionedTextComparison,
    },
    Write {
        comparison: VersionedTextComparison,
        write: WriteResult,
    },
    Delete {
        comparison: VersionedTextComparison,
        delete: DeleteResult,
    },
    Conflict {
        comparison: VersionedTextComparison,
        conflict: Box<TextConflict>,
    },
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
    pub current_text: Option<String>,
    pub incoming_text: Option<String>,
    pub binary: bool,
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

pub fn comparison_status(
    base: &Option<TextSnapshot>,
    current: &Option<TextSnapshot>,
    incoming: &Option<TextSnapshot>,
) -> ComparisonStatus {
    if file_states_equal(current, incoming) {
        ComparisonStatus::Same
    } else if file_states_equal(current, base) {
        ComparisonStatus::IncomingChanged
    } else if file_states_equal(incoming, base) {
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
        // note: request-id replay is deferred until all four result variants can be reconstructed.
        validate_path(&input.path)?;
        let outcome = self.store.write_with(faults, |tx| {
            let compare_input = CompareTextFileVersions {
                workspace_id: input.workspace_id.clone(),
                target_version_id: input.target_version_id.clone(),
                source_version_id: input.source_version_id.clone(),
                path: input.path.clone(),
            };
            let comparison = compare_text_file_versions_in_db(tx, &compare_input)?;
            if file_states_equal(&comparison.current, &comparison.incoming) {
                return Ok(MergeTextFileResult::Unchanged {
                    reason: MergeUnchangedReason::AlreadySame,
                    comparison,
                });
            }
            if file_states_equal(&comparison.incoming, &comparison.base) {
                return Ok(MergeTextFileResult::Unchanged {
                    reason: MergeUnchangedReason::SourceUnchanged,
                    comparison,
                });
            }

            if file_states_equal(&comparison.current, &comparison.base) {
                if let Some(incoming) = &comparison.incoming {
                    let write_input = merge_write_input(input, &incoming.text);
                    validate_write_input(&write_input)?;
                    let write = write_text_in_tx(tx, &write_input)?;
                    let preimage = comparison
                        .current
                        .as_ref()
                        .map_or(Preimage::Absent, |snapshot| {
                            Preimage::Present(snapshot.blob_sha256.clone())
                        });
                    enqueue_write(tx, &write, preimage, "merge")?;
                    return Ok(MergeTextFileResult::Write { comparison, write });
                }
                let delete_input = merge_delete_input(input);
                validate_delete_input(&delete_input)?;
                let delete = delete_text_in_tx(tx, &delete_input)?;
                enqueue_delete(tx, &delete, "merge")?;
                return Ok(MergeTextFileResult::Delete { comparison, delete });
            }

            if let (Some(base), Some(current), Some(incoming)) =
                (&comparison.base, &comparison.current, &comparison.incoming)
                && let MarkdownMergeResult::Merged(text) =
                    merge_markdown(&base.text, &current.text, &incoming.text)
            {
                let write_input = merge_write_input(input, &text);
                validate_write_input(&write_input)?;
                let write = write_text_in_tx(tx, &write_input)?;
                enqueue_write(
                    tx,
                    &write,
                    Preimage::Present(current.blob_sha256.clone()),
                    "merge",
                )?;
                return Ok(MergeTextFileResult::Write { comparison, write });
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
            Ok(MergeTextFileResult::Conflict {
                comparison,
                conflict: Box::new(conflict),
            })
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
                (Some(current), Some(incoming)) if current.text != incoming.text => {
                    changes.push(VersionFileChange {
                        path,
                        status: VersionFileChangeStatus::Modified,
                        current_text: Some(current.text.clone()),
                        incoming_text: Some(incoming.text.clone()),
                        binary: false,
                    });
                }
                (None, Some(incoming)) => changes.push(VersionFileChange {
                    path,
                    status: VersionFileChangeStatus::Added,
                    current_text: None,
                    incoming_text: Some(incoming.text.clone()),
                    binary: false,
                }),
                (Some(current), None) => changes.push(VersionFileChange {
                    path,
                    status: VersionFileChangeStatus::Deleted,
                    current_text: Some(current.text.clone()),
                    incoming_text: None,
                    binary: false,
                }),
                _ => {}
            }
        }
        Ok(changes)
    }
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
    let base_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM fork_base_snapshots \
             WHERE workspace_id = ?1 AND version_id = ?2",
            params![input.workspace_id, input.source_version_id],
            |row| row.get(0),
        )
        .map_err(DomainError::sql_corrupt)?;
    if base_count == 0 {
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

fn select_snapshot(
    conn: &Connection,
    table: &str,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<Option<TextSnapshot>, DomainError> {
    let sql = format!(
        "SELECT s.object_id, s.path, b.text, s.blob_sha256, s.updated_at_ms, \
         s.latest_moment_id, s.metadata_origin FROM {table} s \
         JOIN blobs b ON b.sha256 = s.blob_sha256 \
         WHERE s.workspace_id = ?1 AND s.version_id = ?2 AND s.path = ?3"
    );
    conn.query_row(&sql, params![workspace_id, version_id, path], |row| {
        Ok(TextSnapshot {
            workspace_id: workspace_id.to_owned(),
            version_id: version_id.to_owned(),
            object_id: row.get(0)?,
            path: row.get(1)?,
            text: row.get(2)?,
            blob_sha256: row.get(3)?,
            updated_at_ms: row.get(4)?,
            latest_moment_id: row.get(5)?,
            metadata_origin: row.get(6)?,
        })
    })
    .optional()
    .map_err(DomainError::sql_corrupt)
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
        metadata_origin: input.metadata_origin.clone(),
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
        base: ConflictFileState::text(comparison.path.clone(), comparison.base.clone()),
        current: ConflictFileState::text(comparison.path.clone(), comparison.current.clone()),
        incoming: ConflictFileState::text(comparison.path.clone(), comparison.incoming.clone()),
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
