//! Attribute edits and publication for ordinary open owner documents.
use super::*;
use crate::CancellationToken;
use dohc_engine_collab::DocKey;
use dohc_engine_collab::{
    ContentKind, Marker, Ydoc, load_doc_in, read_marker_in, record_update_in_tx,
};
use dohc_engine_domain::{DomainError, WriteText, write_text_in_tx};
use dohc_engine_storage::{Preimage, TxnOutcome};
use rusqlite::params;

#[cfg(test)]
thread_local! { pub(super) static CRASH_AFTER_APPEND: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

pub type DocumentIsOpen = Arc<dyn Fn(&DocKey) -> bool + Send + Sync>;
pub type DocumentResync = Arc<dyn Fn(&DocKey) + Send + Sync>;

pub(super) struct Edit {
    marker: Marker,
    update: Vec<u8>,
}

pub(super) fn prepare(
    conn: &rusqlite::Connection,
    key: &DocKey,
    before: &str,
    after: &str,
) -> Result<Option<Edit>, RuntimeError> {
    let Some(marker) = read_marker_in(conn, key)? else {
        return Ok(None);
    };
    if marker.content_kind != ContentKind::Richdoc {
        return Ok(None);
    }
    let doc = load_doc_in(conn, key)?;
    if doc.has_pending_dependencies() {
        return Ok(None);
    }
    prepare_doc(&doc, marker, before, after)
}

pub(super) fn prepare_doc(
    doc: &Ydoc,
    marker: Marker,
    before: &str,
    after: &str,
) -> Result<Option<Edit>, RuntimeError> {
    let Some(old) = crate::links::rewrite::targets(before) else {
        return Ok(None);
    };
    let Some(new) = crate::links::rewrite::targets(after) else {
        return Ok(None);
    };
    if old.len() != new.len() {
        return Ok(None);
    }
    let Ok((projection, spans)) = doc.wikilink_spans() else {
        return Ok(None);
    };
    if projection != before && doc.preserved_markdown_source(&projection).as_deref() != Some(before)
    {
        return Ok(None);
    }
    let ranges: Vec<_> = spans.iter().map(|(r, _)| r.clone()).collect();
    let Some(mapped) = crate::links::rewrite::map_ranges(&projection, before, &ranges) else {
        return Ok(None);
    };
    let mut edits = Vec::new();
    for (old, new) in old.iter().zip(new) {
        if old.literal == new.literal {
            continue;
        }
        let matches: Vec<_> = mapped
            .iter()
            .zip(&spans)
            .filter(|(range, _)| range.as_ref() == Some(&old.range))
            .collect();
        let [(_, (_, ordinal))] = matches.as_slice() else {
            return Ok(None);
        };
        let mut target = String::new();
        let mut chars = new.literal.chars();
        while let Some(c) = chars.next() {
            target.push(if c == '\\' {
                chars.next().unwrap_or(c)
            } else {
                c
            });
        }
        edits.push((*ordinal, target));
    }
    if edits.is_empty() {
        return Ok(None);
    }
    let Ok(update) = doc.stage_wikilink_targets(after, &edits) else {
        return Ok(None);
    };
    Ok(Some(Edit { marker, update }))
}

pub(super) fn append(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    path: &str,
    edit: &Edit,
    author: Option<&str>,
    now: i64,
) -> Result<(), RuntimeError> {
    if read_marker_in(tx, key)?.as_ref() != Some(&edit.marker) {
        return Err(DomainError::UndoRefused {
            path: path.into(),
            reason: "source changed",
        }
        .into());
    }
    let (actor, attribution) = dohc_engine_domain::moment_author_attribution(author);
    let mut outcome = record_update_in_tx(
        tx,
        key,
        &edit.update,
        actor.as_deref(),
        attribution.as_ref(),
        now,
    )?;
    super::ydoc::journal_recovery_append_in_tx(
        tx,
        key,
        path,
        ContentKind::Richdoc,
        &edit.update,
        actor.as_deref(),
        attribution.as_ref(),
        &mut outcome,
        now,
    )?;
    Ok(())
}

pub(super) fn settled(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    moment: &dohc_engine_domain::MomentRecord,
    sha: &str,
    now: i64,
) -> Result<(), DomainError> {
    dohc_engine_collab::author_coverage::advance_in(tx, key, false)
        .map_err(StorageError::persist_public)?;
    tx.execute(
        "UPDATE ydoc_docs SET settle_seq=?4,last_settled_sha=?5,updated_at_ms=?6
        WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            moment.moment_order,
            sha,
            now
        ],
    )
    .map_err(StorageError::persist_public)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn baseline(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    root: &std::path::Path,
    key: &DocKey,
    path: &str,
    token: &CancellationToken,
    recorder: &dyn super::materialization::SelfWriteRecorder,
    relevant: impl FnOnce(&str) -> bool,
) -> Result<bool, RuntimeError> {
    let Some(marker) = store.read_with(|c| read_marker_in(c, key))? else {
        return Ok(false);
    };
    if marker.content_kind != ContentKind::Richdoc {
        return Ok(false);
    }
    let doc = store.read_with(|c| load_doc_in(c, key))?;
    if doc.has_pending_dependencies() {
        return Ok(false);
    }
    let Ok(projection) = doc.project(marker.content_kind) else {
        return Ok(false);
    };
    let text = doc
        .preserved_markdown_source(&projection.content)
        .unwrap_or(projection.content);
    if !relevant(&text) {
        return Ok(false);
    }
    store.read_with(|c| {
        super::history_operations::check_path_ownership(
            c,
            &key.workspace_id,
            &key.version_id,
            &key.object_id,
            path,
        )
    })?;
    let head = dohc_engine_domain::VersionedTextStore::new(store)
        .read_text(&key.workspace_id, &key.version_id, path)?
        .ok_or(DomainError::FileNotFound)?;
    let outcome = super::ydoc::ydoc_settle_on_store(
        store,
        cache,
        root,
        key,
        path,
        marker.content_kind,
        false,
        marker.lineage_claim_id.as_deref(),
        Some(head.blob_sha256),
        None,
        "link-rewrite-baseline",
        recorder,
        crate::links::now_ms(),
        &dohc_engine_storage::NoFaults,
        token,
        None,
        None,
        None,
        super::ydoc::SettlementKind::Document,
        false,
        None,
    );
    match outcome.and_then(super::ydoc::YdocSettleOutcome::into_settlement_for_internal_caller) {
        Ok(_) => {}
        Err(error) if error.code() == "file-locked" => return Err(StorageError::FileLocked.into()),
        Err(RuntimeError::Collab(_)) => return Ok(false),
        Err(RuntimeError::Domain(DomainError::InvalidInput {
            reason: "ydoc-remote-updates-pending",
        })) => return Ok(false),
        Err(error) => return Err(error),
    }
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn write(
    store: &mut EngineStore,
    input: &WriteText,
    root: &std::path::Path,
    key: &DocKey,
    edit: &Edit,
    expected: &str,
    hook: &dyn Fn(&rusqlite::Transaction<'_>) -> Result<(), RuntimeError>,
    faults: &dyn FaultInjector,
) -> Result<(), RuntimeError> {
    let disk = dohc_engine_files::materialize::write_precondition_sha256(root, &input.path)?;
    if disk.as_deref() != Some(expected) {
        return Err(DomainError::WritePreconditionFailed {
            current_sha256: disk,
        }
        .into());
    }
    match store.write_with(faults, |tx| {
        append(
            tx,
            key,
            &input.path,
            edit,
            input.author_json.as_deref(),
            input.now_ms,
        )?;
        #[cfg(test)]
        if CRASH_AFTER_APPEND.replace(false) {
            return Err(RuntimeError::OperationCrashed);
        }
        let result = write_text_in_tx(tx, input)?;
        dohc_engine_domain::enqueue_write(tx, &result, Preimage::Present(expected.into()), "ydoc")?;
        crate::search::upsert_file_search_index(
            tx,
            root,
            &input.workspace_id,
            &input.version_id,
            &input.object_id,
            &input.path,
            &input.text,
        )?;
        settled(
            tx,
            key,
            &result.moment,
            &result.snapshot.blob_sha256,
            input.now_ms,
        )?;
        hook(tx)?;
        Ok::<_, RuntimeError>(())
    })? {
        TxnOutcome::Committed(()) => Ok(()),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}
