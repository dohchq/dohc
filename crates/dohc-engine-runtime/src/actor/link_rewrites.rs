use super::{
    ActorHandle, HeldReader,
    versioned::{
        WriteConditions, versioned_text_write_with_publication_on_store,
        with_local_file_mutation_cache_reset,
    },
};
use crate::{
    RuntimeError,
    links::{incoming, resolver::Resolver, rewrite},
};
use dohc_engine_collab::{CollabError, DocKey, LeaseRegistry};
use dohc_engine_domain::{
    DomainError, OperationMoment, VersionedTextStore, WriteText, operation_moments_in,
};
use dohc_engine_storage::{EngineStore, FaultInjector, StorageError, TxnOutcome, hex_sha256};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[path = "link_publication.rs"]
mod publication;
use publication::Publication;

#[derive(Default)]
pub(super) struct RewriteState {
    pub gate: Arc<tokio::sync::Mutex<()>>,
    pub undo_gate: Arc<tokio::sync::Mutex<()>>,
    stops: Mutex<HashMap<String, usize>>,
    publishers: Mutex<HashSet<(String, String)>>,
    deferred_placements: Mutex<HashSet<String>>,
    placement_failures: Mutex<HashMap<String, usize>>,
}
pub(super) struct RewriteStop(Arc<RewriteState>, String);
impl Drop for RewriteStop {
    fn drop(&mut self) {
        let mut stops = self.0.stops.lock().unwrap();
        let count = stops.get_mut(&self.1).unwrap();
        *count -= 1;
        if *count == 0 {
            stops.remove(&self.1);
        }
    }
}

struct Plan {
    state: Arc<RewriteState>,
    version: String,
    operation: String,
    rename: OperationMoment,
    paths: Vec<String>,
    aliases: String,
    alias_revision: Mutex<Option<(i64, i64)>>,
    candidates: incoming::Candidates,
}

fn stem(path: &str) -> String {
    crate::links::resolver::without_extension(path)
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_lowercase()
}

fn track_alias_changes(conn: &Connection, ws: &str, operation: &str) -> Result<(), RuntimeError> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_temp_schema WHERE name='rewrite_alias_changes')",
            [],
            |r| r.get(0),
        )
        .map_err(StorageError::corrupt_public)?;
    if !exists {
        conn.create_scalar_function(
            "link_rewrite_stem",
            1,
            rusqlite::functions::FunctionFlags::SQLITE_UTF8
                | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
            |ctx| Ok(stem(&ctx.get::<String>(0)?)),
        )
        .map_err(StorageError::corrupt_public)?;
        conn.execute_batch("CREATE TEMP TABLE rewrite_alias_watch(workspace TEXT,version TEXT,stem TEXT,PRIMARY KEY(workspace,version,stem)) WITHOUT ROWID; CREATE TEMP TABLE rewrite_alias_changes(workspace TEXT,version TEXT,stem TEXT,path TEXT,PRIMARY KEY(workspace,version,stem,path)) WITHOUT ROWID;
            CREATE TEMP TRIGGER rewrite_alias_insert AFTER INSERT ON main.path_aliases WHEN EXISTS(SELECT 1 FROM rewrite_alias_watch WHERE workspace=NEW.workspace_id AND version=NEW.version_id AND stem=link_rewrite_stem(NEW.path)) BEGIN
                INSERT OR IGNORE INTO rewrite_alias_changes VALUES(NEW.workspace_id,NEW.version_id,link_rewrite_stem(NEW.path),NEW.path); END;
            CREATE TEMP TRIGGER rewrite_alias_delete AFTER DELETE ON main.path_aliases WHEN EXISTS(SELECT 1 FROM rewrite_alias_watch WHERE workspace=OLD.workspace_id AND version=OLD.version_id AND stem=link_rewrite_stem(OLD.path)) BEGIN
                INSERT OR IGNORE INTO rewrite_alias_changes VALUES(OLD.workspace_id,OLD.version_id,link_rewrite_stem(OLD.path),OLD.path); END;
            CREATE TEMP TRIGGER rewrite_alias_update AFTER UPDATE OF path,object_id ON main.path_aliases WHEN (OLD.path IS NOT NEW.path OR OLD.object_id IS NOT NEW.object_id) AND EXISTS(SELECT 1 FROM rewrite_alias_watch WHERE workspace=NEW.workspace_id AND version=NEW.version_id AND stem IN (link_rewrite_stem(OLD.path),link_rewrite_stem(NEW.path))) BEGIN
                INSERT OR IGNORE INTO rewrite_alias_changes VALUES(OLD.workspace_id,OLD.version_id,link_rewrite_stem(OLD.path),OLD.path);
                INSERT OR IGNORE INTO rewrite_alias_changes VALUES(NEW.workspace_id,NEW.version_id,link_rewrite_stem(NEW.path),NEW.path); END;"
        ).map_err(StorageError::corrupt_public)?;
    }
    conn.execute_batch("DELETE FROM rewrite_alias_watch; DELETE FROM rewrite_alias_changes;")
        .map_err(StorageError::corrupt_public)?;
    conn.execute("INSERT OR IGNORE INTO rewrite_alias_watch SELECT workspace_id,version_id,link_rewrite_stem(path) FROM moments WHERE workspace_id=?1 AND metadata_correlation_id=?2 AND operation='rename'
        UNION SELECT workspace_id,version_id,link_rewrite_stem(payload_before_path) FROM moments WHERE workspace_id=?1 AND metadata_correlation_id=?2 AND operation='rename' AND payload_before_path IS NOT NULL", params![ws,operation]).map_err(StorageError::corrupt_public)?;
    Ok(())
}

fn alias_names(conn: &Connection, ws: &str, plan: &Plan) -> Result<String, RuntimeError> {
    // Initial families come from the off-actor snapshot. Only changed families
    // need discovery here; both the journal and authoritative lookups are indexed.
    conn.query_row("SELECT json_group_array(path) FROM (
        SELECT a.path FROM (
            SELECT value AS path FROM json_each(?3)
            UNION SELECT path FROM rewrite_alias_changes WHERE workspace=?1 AND version=?2 AND stem IN (?4,?5)
        ) names JOIN path_aliases a ON a.workspace_id=?1 AND a.version_id=?2 AND a.path=names.path ORDER BY a.path)",
        params![ws,plan.version,plan.aliases,stem(plan.rename.before_path.as_deref().unwrap_or("")),stem(&plan.rename.path)],
        |r| r.get(0)).map_err(StorageError::corrupt_public).map_err(Into::into)
}

fn valid(conn: &Connection, ws: &str, plan: &Plan, actor: bool) -> Result<bool, RuntimeError> {
    if plan
        .state
        .stops
        .lock()
        .unwrap()
        .contains_key(&plan.operation)
    {
        return Ok(false);
    }
    let undo: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM history_undo_plans WHERE workspace_id=?1 AND operation_id=?2)",params![ws,plan.operation],|r|r.get(0)).map_err(StorageError::corrupt_public)?;
    if undo {
        return Ok(false);
    }
    if actor {
        let revision = crate::links::cache::revision(conn, ws, &plan.version)?;
        let mut prior = plan.alias_revision.lock().unwrap();
        if *prior != Some(revision) {
            // A foreign writer cannot run this connection's TEMP journal.
            if prior.is_some_and(|(_, external)| external != revision.1)
                || alias_names(conn, ws, plan)? != plan.aliases
            {
                return Ok(false);
            }
            *prior = Some(revision);
        }
    }
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND path=?4)
         AND NOT EXISTS(SELECT 1 FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 AND path=?5)
         AND NOT EXISTS(SELECT 1 FROM moments WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND moment_order>?6 AND operation IN ('rename','delete'))",
        params![ws, plan.version, plan.rename.object_id, plan.rename.path, plan.rename.before_path, plan.rename.moment_order], |r| r.get::<_, bool>(0),
    ).map_err(StorageError::corrupt_public)?)
}

struct Receipt {
    key: String,
    binding: String,
}
impl Receipt {
    fn read(&self, conn: &Connection) -> Result<Option<(bool, Value)>, RuntimeError> {
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT kind,payload_hash FROM engine_requests WHERE request_id=?1",
                [&self.key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(StorageError::corrupt_public)?;
        let Some((kind, body)) = row else {
            return Ok(None);
        };
        let envelope: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        if kind != "history-link-rewrites" || envelope[0].as_str() != Some(self.binding.as_str()) {
            return Err(DomainError::IdempotencyKeyReuseMismatch.into());
        }
        Ok(Some((
            envelope[1].as_bool().ok_or(DomainError::StateCorrupt {
                reason: "link rewrite receipt",
            })?,
            envelope[2].clone(),
        )))
    }
    // The discriminator owns this envelope; other request kinds still fail their fingerprint check.
    fn save(&self, conn: &Connection, done: bool, result: &Value) -> Result<(), RuntimeError> {
        let changed = conn.execute(
            "INSERT INTO engine_requests(request_id,payload_hash,result_seq,committed_at,kind) VALUES(?1,?2,0,?3,'history-link-rewrites')
             ON CONFLICT(request_id) DO UPDATE SET payload_hash=excluded.payload_hash,committed_at=excluded.committed_at
             WHERE engine_requests.kind='history-link-rewrites'
               AND CASE WHEN json_valid(engine_requests.payload_hash) THEN json_extract(engine_requests.payload_hash,'$[0]') END=?4",
            params![self.key, json!([self.binding, done, result]).to_string(), crate::links::now_ms(), self.binding],
        ).map_err(StorageError::persist_public)?;
        if changed != 1 {
            return Err(DomainError::IdempotencyKeyReuseMismatch.into());
        }
        Ok(())
    }
}

fn save(
    store: &mut EngineStore,
    receipt: &Receipt,
    done: bool,
    result: &Value,
    faults: &dyn FaultInjector,
) -> Result<(), RuntimeError> {
    match store.write_with(faults, |tx| receipt.save(tx, done, result))? {
        TxnOutcome::Committed(()) => Ok(()),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

impl ActorHandle {
    pub(super) fn stop_link_rewrites(&self, operation: &str) -> RewriteStop {
        *self
            .link_rewrites
            .stops
            .lock()
            .unwrap()
            .entry(operation.into())
            .or_default() += 1;
        RewriteStop(self.link_rewrites.clone(), operation.into())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn history_rewrite_links(
        &self,
        workspace: String,
        operation: String,
        request: String,
        author: Option<String>,
        root: PathBuf,
        leases: LeaseRegistry,
        gates: [Arc<tokio::sync::Mutex<()>>; 2],
        faults: Arc<dyn FaultInjector>,
        documents: (
            super::link_documents::DocumentIsOpen,
            super::link_documents::DocumentResync,
        ),
        recorder: Arc<dyn super::materialization::SelfWriteRecorder>,
        token: CancellationToken,
    ) -> Result<Value, RuntimeError> {
        let session_ops = gates[1].clone();
        let (is_open, resync) = documents;
        let _pass = tokio::select! {
            () = token.cancelled() => return Err(RuntimeError::Cancelled),
            guard = Arc::clone(&self.link_rewrites.gate).lock_owned() => guard,
        };
        let receipt = Arc::new(Receipt {
            key: request,
            binding: hex_sha256(json!([workspace, operation, author]).to_string().as_bytes()),
        });
        let (ws, op, r) = (workspace.clone(), operation.clone(), receipt.clone());
        #[cfg(test)]
        let admission_ws = workspace.clone();
        let serial = tokio::select! {
            () = token.cancelled() => return Err(RuntimeError::Cancelled),
            guard = session_ops.clone().lock_owned() => guard,
        };
        let (journal_ws, journal_op) = (workspace.clone(), operation.clone());
        let (external, checkpoint) = self
            .run(move |store, _| {
                let _admission = serial;
                #[cfg(test)]
                let _turn = tests::Turn::start(&admission_ws, "admission");
                if store.is_passive() {
                    return Err(DomainError::InvalidInput {
                        reason: "link rewrites need the owner",
                    }
                    .into());
                }
                let external = store.read_with(|conn| {
                    crate::links::cache::track_revisions(conn)?;
                    track_alias_changes(conn, &journal_ws, &journal_op)?;
                    Ok::<_, RuntimeError>(
                        conn.pragma_query_value(None, "data_version", |r| r.get::<_, i64>(0))
                            .map_err(StorageError::corrupt_public)?,
                    )
                })?;
                Ok((external, Arc::new(store.checkpoint_cycle())))
            })
            .await?;
        let state = self.link_rewrites.clone();
        let held = self.location();
        let (plan, mut result) = tokio::task::spawn_blocking(move || -> Result<_, RuntimeError> {
            let mut store = HeldReader::open(held)?;
            store
                .read_with(|conn| conn.execute_batch("BEGIN"))
                .map_err(StorageError::corrupt_public)?;
            #[cfg(test)]
            let _turn = tests::Turn::start(&ws, "plan");
            let prior = store.read_with(|conn| r.read(conn))?;
            if let Some((true, reply)) = prior {
                return Ok((None, reply));
            }
            let version = VersionedTextStore::new(&mut store)
                .get_active_version(&ws)?
                .version_id;
            let plan = store.read_with(|conn| -> Result<_, RuntimeError> {
                let members = operation_moments_in(conn, &ws, &version, &op)?;
                let renames: Vec<_> = members.iter().filter(|m| m.operation == "rename").collect();
                let refuse = || DomainError::UndoRefused {
                    path: op.clone(),
                    reason: "operation cannot rewrite links",
                };
                let [rename] = renames.as_slice() else {
                    return Err(refuse().into());
                };
                let old = rename.before_path.as_deref().ok_or_else(refuse)?;
                if old.to_lowercase() == rename.path.to_lowercase()
                    || members.iter().any(|m| {
                        m != *rename && (m.operation != "write" || m.object_id == rename.object_id)
                    })
                {
                    return Err(refuse().into());
                }
                let mut paths = Resolver::paths_for_version(conn, &ws, &version)?;
                paths.sort();
                let mut candidates = incoming::candidates(conn, &ws, &version, old, &["wikilink"])?;
                let written: HashSet<_> = members.iter().map(|m| m.object_id.as_str()).collect();
                candidates.sources.retain(|(object, path)| {
                    !written.contains(object.as_str()) && !path.starts_with("shared-with-me/")
                });
                candidates
                    .unchecked
                    .retain(|path| path != &rename.path && !path.starts_with("shared-with-me/"));
                let plan = Plan {
                    version: version.clone(),
                    operation: op.clone(),
                    state,
                    rename: (*rename).clone(),
                    aliases: serde_json::to_string(
                        &paths
                            .iter()
                            .filter(|path| {
                                stem(path) == stem(old) || stem(path) == stem(&rename.path)
                            })
                            .collect::<Vec<_>>(),
                    )
                    .expect("alias paths serialize"),
                    alias_revision: Mutex::new(Some((i64::MIN, external))),
                    paths,
                    candidates,
                };
                if !valid(conn, &ws, &plan, false)? {
                    return Err(refuse().into());
                }
                Ok(plan)
            })?;
            let result = prior.map_or(json!({"documents":0,"links":0}), |(_, result)| result);

            Ok((Some(plan), result))
        })
        .await
        .map_err(|_| RuntimeError::ActorUnavailable)??;
        let publication = Arc::new(Publication {
            workspace: workspace.clone(),
            operation: operation.clone(),
            root: root.clone(),
            gates,
            recorder: recorder.clone(),
        });
        self.publish_link_rewrites(publication.clone());
        let Some(plan) = plan else {
            return Ok(result);
        };
        let mut reserve_locked_since = None;
        loop {
            let (r, f, initial) = (receipt.clone(), faults.clone(), result.clone());
            #[cfg(test)]
            let reserve_ws = workspace.clone();
            let serial = tokio::select! {
                () = token.cancelled() => return Err(RuntimeError::Cancelled),
                guard = session_ops.clone().lock_owned() => guard,
            };
            let outcome = self
                .run(move |store, _| {
                    let _admission = serial;
                    #[cfg(test)]
                    let _turn = tests::Turn::start(&reserve_ws, "reserve");
                    save(store, &r, false, &initial, f.as_ref())
                })
                .await;
            match outcome {
                Ok(()) => break,
                Err(error) if error.code() == "file-locked" => {
                    Self::wait_undo_checkpoint(
                        &token,
                        &mut reserve_locked_since,
                        checkpoint.clone(),
                    )
                    .await?;
                }
                Err(error) => return Err(error),
            }
        }
        let (plan, before, after) = tokio::task::spawn_blocking(move || {
            let old = plan.rename.before_path.as_deref().unwrap_or("");
            let before = Resolver::new(
                plan.paths
                    .iter()
                    .filter(|p| **p != plan.rename.path)
                    .cloned()
                    .chain([old.to_owned()]),
            );
            let after = Resolver::new(plan.paths.clone());
            (Arc::new(plan), Arc::new(before), Arc::new(after))
        })
        .await
        .map_err(|_| RuntimeError::ActorUnavailable)?;
        let mut unchecked = plan.candidates.unchecked.clone();
        let mut pending: VecDeque<_> = plan.candidates.sources.clone().into();
        let mut stopped = false;
        let mut locked_since = None;
        let mut commit_locked_since = None;
        'sources: while !pending.is_empty() {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let serial = tokio::select! {
                () = token.cancelled() => return Err(RuntimeError::Cancelled),
                guard = session_ops.clone().lock_owned() => guard,
            };
            let (ws, p, open, read_root, read_token, read_recorder, check_before, check_after) = (
                workspace.clone(),
                plan.clone(),
                is_open.clone(),
                root.clone(),
                token.clone(),
                recorder.clone(),
                before.clone(),
                after.clone(),
            );
            let (remaining, sources, skipped, admitted, locked) = self
                .run(move |store, cache| {
                    #[cfg(test)]
                    let _turn = tests::Turn::start(&ws, "read");
                    let _admission = serial;
                    let started = Instant::now();
                    let mut sources = Vec::new();
                    let mut skipped = Vec::new();
                    let active = VersionedTextStore::new(store)
                        .get_active_version(&ws)?
                        .version_id;
                    if active != p.version || !store.read_with(|conn| valid(conn, &ws, &p, true))? {
                        return Ok((pending, sources, skipped, false, false));
                    }
                    let mut read_count = 0;
                    let mut locked = false;
                    while read_count < 16
                        && (read_count == 0 || started.elapsed() < Duration::from_millis(5))
                    {
                        let Some((object, path)) = pending.pop_front() else {
                            break;
                        };
                        read_count += 1;
                        #[cfg(test)]
                        tests::source();
                        let key = DocKey::new(&ws, &p.version, &object)?;
                        let mut irrelevant = false;
                        let usable = if open(&key) {
                            match super::link_documents::baseline(
                                store,
                                cache,
                                &read_root,
                                &key,
                                &path,
                                &read_token,
                                read_recorder.as_ref(),
                                |text| {
                                    irrelevant = rewrite::forward(
                                        text,
                                        &path,
                                        p.rename.before_path.as_deref().unwrap_or(""),
                                        &p.rename.path,
                                        &check_before,
                                        &check_after,
                                    )
                                    .is_some_and(|(_, links)| links == 0);
                                    !irrelevant
                                },
                            ) {
                                Ok(value) => value,
                                Err(
                                    RuntimeError::Domain(DomainError::UndoRefused { .. })
                                    | RuntimeError::Sync(
                                        dohc_engine_sync::SyncError::LiveDocumentBindingActive,
                                    ),
                                ) => false,
                                Err(error) if error.code() == "file-locked" => {
                                    pending.push_front((object, path));
                                    locked = true;
                                    break;
                                }
                                Err(error) => return Err(error),
                            }
                        } else {
                            true
                        };
                        if irrelevant {
                            continue;
                        }
                        if usable {
                            let source = store.read_with(|conn| {
                                let source = incoming::read_source(conn, &ws, &p.version, &object)?;
                                #[cfg(test)]
                                tests::after_read(conn, &ws, &object);
                                let live = if open(&key) {
                                    dohc_engine_collab::read_marker_in(conn, &key)?
                                        .map(|marker| {
                                            dohc_engine_collab::load_doc_in(conn, &key)
                                                .map(|doc| (doc, marker))
                                        })
                                        .transpose()?
                                } else {
                                    None
                                };
                                Ok::<_, RuntimeError>((source, live))
                            })?;
                            if let (Some(source), live) = source {
                                sources.push((object.clone(), path.clone(), source, live));
                            } else {
                                skipped.push(path.clone());
                            }
                        } else {
                            skipped.push(path.clone());
                        }
                    }
                    Ok((pending, sources, skipped, true, locked))
                })
                .await?;
            pending = remaining;
            if locked {
                #[cfg(test)]
                super::history_operations::turns::tests::checkpoint_wait(&workspace).await;
                Self::wait_undo_checkpoint(&token, &mut locked_since, checkpoint.clone()).await?;
            } else {
                locked_since = None;
            }
            unchecked.extend(skipped);
            if !admitted {
                stopped = true;
                unchecked.extend(pending.iter().map(|(_, p)| p.clone()));
                break;
            }
            let (p, parse_before, parse_after) = (plan.clone(), before.clone(), after.clone());
            let (mut prepared, skipped) = tokio::task::spawn_blocking(move || {
                let mut prepared = VecDeque::new();
                let mut skipped = Vec::new();
                for (object, path, source, live) in sources {
                    let original_text = source.text().unwrap_or("").to_owned();
                    let text = original_text.clone();
                    let parsed = source.parse()?;
                    let edit = if parsed.reason.is_some() {
                        None
                    } else {
                        rewrite::forward(
                            &text,
                            &path,
                            p.rename.before_path.as_deref().unwrap_or(""),
                            &p.rename.path,
                            &parse_before,
                            &parse_after,
                        )
                    };
                    match (parsed.head, edit) {
                        (Some(head), Some((text, links))) if links > 0 => {
                            let was_open = live.is_some();
                            let live = live
                                .map(|(doc, marker)| {
                                    super::link_documents::prepare_doc(
                                        &doc,
                                        marker,
                                        &original_text,
                                        &text,
                                    )
                                })
                                .transpose()?
                                .flatten();
                            if was_open && live.is_none() {
                                skipped.push(path);
                            } else {
                                prepared.push_back((object, head, text, links, live));
                            }
                        }
                        (Some(_), Some(_)) => {}
                        _ => skipped.push(path),
                    }
                }
                Ok::<_, RuntimeError>((prepared, skipped))
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)??;
            unchecked.extend(skipped);
            while !prepared.is_empty() {
                let serial = tokio::select! {
                    () = token.cancelled() => return Err(RuntimeError::Cancelled),
                    guard = Arc::clone(&session_ops).lock_owned() => guard,
                };
                let (ws, op, author, root, p, r, turn_token, f, leases, resync, mut next_result) = (
                    workspace.clone(),
                    operation.clone(),
                    author.clone(),
                    root.clone(),
                    plan.clone(),
                    receipt.clone(),
                    token.clone(),
                    faults.clone(),
                    leases.clone(),
                    resync.clone(),
                    result.clone(),
                );
                let turn_open = is_open.clone();
                let committed = self
                .run(move |store, cache| {
                    #[cfg(test)]
                    let _turn = tests::Turn::start(&ws, "commit");
                    let _admission = serial;
                    let started = Instant::now();
                    let mut skipped = Vec::new();
                    let mut refresh = Vec::new();
                    let mut locked = false;
                    while let Some((object, head, text, links, live)) = prepared.pop_front() {
                    #[cfg(test)]
                    tests::source();
                    let source_path = head.path.clone();
                    let key = DocKey::new(&ws, &p.version, &object)?;
                    let lease = match leases.acquire_internal(&key) {
                        Ok(lease) => Some(lease),
                        Err(CollabError::LeaseHeld) => None,
                        Err(error) => return Err(error.into()),
                    };
                    if lease.is_none() && !turn_open(&key) {
                        skipped.push(source_path); continue;
                    }
                    if lease.is_none() && live.is_none() {
                        refresh.push((object, source_path)); continue;
                    }
                    let next = json!({"documents":next_result["documents"].as_u64().unwrap_or(0)+1,"links":next_result["links"].as_u64().unwrap_or(0)+links as u64});
                    let outcome = (|| -> Result<bool, RuntimeError> {
                    if turn_token.is_cancelled() {
                        return Err(RuntimeError::Cancelled);
                    }
                    let active = VersionedTextStore::new(store)
                        .get_active_version(&ws)?
                        .version_id;
                    if active != p.version || !store.read_with(|conn| valid(conn, &ws, &p, true))? {
                        stopped = true;
                        return Ok(false);
                    }
                    let current =
                        VersionedTextStore::new(store).read_text(&ws, &p.version, &head.path)?;
                    if current
                        .as_ref()
                        .is_none_or(|h| h.object_id != object || h.blob_sha256 != head.hash)
                        || head.path.starts_with("shared-with-me/")
                    {
                        return Ok(false);
                    }
                    match store.read_with(|conn| {
                        super::history_operations::check_path_ownership(
                            conn, &ws, &p.version, &object, &head.path,
                        )
                    }) {
                        Ok(()) => {}
                        Err(
                            RuntimeError::Domain(DomainError::UndoRefused { .. })
                            | RuntimeError::Sync(
                                dohc_engine_sync::SyncError::LiveDocumentBindingActive,
                            ),
                        ) => return Ok(false),
                        Err(error) => return Err(error),
                    }
                    let policy = crate::search::read_engine_search_policy(&root);
                    if policy.holds_file_capture()
                        || !dohc_engine_files::search_policy::resolve_effective_policy(
                            &head.path,
                            policy.files_policy.as_deref(),
                            None,
                        )
                        .tracked
                    {
                        return Ok(false);
                    }
                    let live = if lease.is_none() {
                        match live { Some(edit) => Some(edit), None => return Ok(false) }
                    } else { None };
                    let input = WriteText {
                        workspace_id: ws.clone(),
                        version_id: p.version.clone(),
                        object_id: object.clone(),
                        path: head.path,
                        text,
                        moment_id: format!(
                            "link-rewrite-{}",
                            hex_sha256(json!([op, object]).to_string().as_bytes())
                        ),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: Some(format!(
                            "Updated links to {}",
                            p.rename.path.rsplit('/').next().unwrap_or(&p.rename.path)
                        )),
                        metadata_correlation_id: Some(op.clone()),
                        author_json: author.clone(),
                        now_ms: crate::links::now_ms(),
                    };
                    with_local_file_mutation_cache_reset(cache, || {
                        if let Some(edit) = &live {
                            return match super::link_documents::write(store, &input, &root, &key, edit,
                                &head.hash, &|tx| r.save(tx, false, &next), f.as_ref()) {
                                Ok(()) => { resync(&key); Ok(true) },
                                Err(RuntimeError::Domain(DomainError::WritePreconditionFailed {..} |
                                    DomainError::UndoRefused {..})) => Ok(false),
                                Err(error) => Err(error),
                            };
                        }
                        match versioned_text_write_with_publication_on_store(
                            store,
                            &input,
                            Some(&root),
                            None,
                            Some(&WriteConditions {
                                create_only: false,
                                expected_sha256: Some(head.hash),
                            }),
                            Some(&|tx| r.save(tx, false, &next)),
                            f.as_ref(),
                            &turn_token,
                        ) {
                            Ok(_) => Ok(true),
                            Err(RuntimeError::Domain(DomainError::WritePreconditionFailed {
                                ..
                            }) | RuntimeError::Sync(dohc_engine_sync::SyncError::InvalidInput {
                                reason: dohc_engine_storage::capture_file_holds::NOT_REPRESENTABLE,
                            })) => Ok(false),
                            Err(error) => Err(error),
                        }
                    })
                    })();
                    let committed = match outcome {
                        Ok(value) => value,
                        Err(error) if error.code() == "file-locked" => {
                            refresh.push((object, source_path));
                            locked = true;
                            break;
                        }
                        Err(error) => return Err(error),
                    };
                    if committed { next_result = next; } else { skipped.push(source_path); }
                    if stopped || started.elapsed() >= Duration::from_millis(5) { break; }
                    }
                    Ok((prepared, next_result, skipped, stopped, refresh, locked))
                }).await;
                self.publish_link_rewrites(publication.clone());
                let committed = committed?;
                (prepared, result) = (committed.0, committed.1);
                unchecked.extend(committed.2);
                stopped = committed.3;
                pending.extend(committed.4);
                if committed.5 {
                    #[cfg(test)]
                    super::history_operations::turns::tests::checkpoint_wait(&workspace).await;
                    Self::wait_undo_checkpoint(
                        &token,
                        &mut commit_locked_since,
                        checkpoint.clone(),
                    )
                    .await?;
                } else {
                    commit_locked_since = None;
                }
                if stopped {
                    unchecked.extend(prepared.drain(..).map(|(_, head, _, _, _)| head.path));
                    unchecked.extend(pending.iter().map(|(_, path)| path.clone()));
                    break 'sources;
                }
            }
        }
        unchecked.sort();
        unchecked.dedup();
        result["uncheckedCount"] = json!(unchecked.len());
        result["complete"] = json!(unchecked.is_empty());
        result["unchecked"] = json!(unchecked.into_iter().take(50).collect::<Vec<_>>());
        let reply = result.clone();
        let mut reply_locked_since = None;
        loop {
            #[cfg(test)]
            let reply_ws = workspace.clone();
            let (receipt, result, faults) = (receipt.clone(), result.clone(), faults.clone());
            let serial = tokio::select! {
                () = token.cancelled() => return Err(RuntimeError::Cancelled),
                guard = session_ops.clone().lock_owned() => guard,
            };
            let outcome = self
                .run(move |store, _| {
                    let _admission = serial;
                    #[cfg(test)]
                    let _turn = tests::Turn::start(&reply_ws, "reply");
                    save(store, &receipt, !stopped, &result, faults.as_ref())?;
                    store
                        .read_with(|conn| {
                            conn.execute_batch(
                        "DELETE FROM rewrite_alias_watch; DELETE FROM rewrite_alias_changes;",
                    )
                        })
                        .map_err(StorageError::corrupt_public)?;
                    Ok(())
                })
                .await;
            match outcome {
                Ok(()) => break,
                Err(error) if error.code() == "file-locked" => {
                    Self::wait_undo_checkpoint(&token, &mut reply_locked_since, checkpoint.clone())
                        .await?;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(reply)
    }
}

#[cfg(test)]
#[path = "link_rewrite_tests.rs"]
mod tests;
