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
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
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
    deferred: Mutex<HashMap<String, DeferredPass>>,
}

#[derive(Clone)]
struct RewriteRequest {
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
}

#[derive(Clone)]
struct DeferredPass {
    input: RewriteRequest,
    version: String,
    sources: HashMap<String, String>,
    captured: HashSet<String>,
    offered: bool,
    unchecked: Vec<String>,
    scanned: bool,
}

fn defer(plan: &Plan, request: &str, object: &str, path: &str, await_capture: bool) {
    plan.deferred_sources.lock().unwrap().insert(object.into());
    if let Some(pass) = plan.state.deferred.lock().unwrap().get_mut(request) {
        pass.sources.insert(object.into(), path.into());
        if await_capture {
            pass.captured.remove(object);
        }
    }
}

fn reoffer(state: &RewriteState, request: &str) {
    if let Some(pass) = state.deferred.lock().unwrap().get_mut(request) {
        pass.offered = true;
    }
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
    deferred_sources: Mutex<HashSet<String>>,
    paused: Arc<AtomicBool>,
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
        plan.paused.store(true, Ordering::Relaxed);
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
        self.rewrite_links(
            RewriteRequest {
                workspace,
                operation,
                request,
                author,
                root,
                leases,
                gates,
                faults,
                documents,
                recorder,
            },
            token,
            None,
        )
        .await
    }

    /// Offer only the paths whose outside text capture just committed.
    pub fn offer_captured_link_rewrites(&self, workspace: &str, paths: &[String]) {
        for pass in self.link_rewrites.deferred.lock().unwrap().values_mut() {
            if pass.input.workspace != workspace {
                continue;
            }
            let captured: Vec<_> = pass
                .sources
                .iter()
                .filter(|(_, path)| paths.contains(path))
                .map(|(object, _)| object.clone())
                .collect();
            pass.offered |= !captured.is_empty();
            pass.captured.extend(captured);
        }
    }

    /// A note may reopen between capture and retry. Its next lease release
    /// must offer it again even though capture has no new bytes to record.
    pub fn offer_released_link_rewrites(&self, workspace: &str) {
        for pass in self.link_rewrites.deferred.lock().unwrap().values_mut() {
            if pass.input.workspace == workspace {
                pass.offered |= !pass.captured.is_empty();
            }
        }
    }

    /// Run offered work outside fences that already hold the session gate.
    pub async fn retry_pending_link_rewrites(&self, workspace: &str) {
        let requests: Vec<_> = self
            .link_rewrites
            .deferred
            .lock()
            .unwrap()
            .values_mut()
            .filter(|pass| pass.input.workspace == workspace)
            .filter_map(|pass| {
                if !pass.offered
                    || self
                        .link_rewrites
                        .stops
                        .lock()
                        .unwrap()
                        .contains_key(&pass.input.operation)
                {
                    return None;
                }
                pass.offered = false;
                let selected: Vec<_> = pass
                    .sources
                    .iter()
                    .filter(|(object, _)| pass.captured.contains(*object))
                    .map(|(_, path)| path.clone())
                    .collect();
                (!selected.is_empty()).then(|| (pass.input.clone(), selected))
            })
            .collect();
        for (input, selected) in requests {
            let request = input.request.clone();
            match self
                .rewrite_links(input, CancellationToken::new(), Some(selected))
                .await
            {
                Ok(_) => {}
                Err(RuntimeError::Domain(DomainError::UndoRefused { .. })) => {
                    self.link_rewrites.deferred.lock().unwrap().remove(&request);
                }
                Err(error) => eprintln!("engine: link rewrite awaits another capture: {error}"),
            }
        }
    }

    async fn rewrite_links(
        &self,
        input: RewriteRequest,
        token: CancellationToken,
        selected_paths: Option<Vec<String>>,
    ) -> Result<Value, RuntimeError> {
        let retained = input.clone();
        let RewriteRequest {
            workspace,
            operation,
            request,
            author,
            root,
            leases,
            gates,
            faults,
            documents,
            recorder,
        } = input;
        let session_ops = gates[1].clone();
        let (is_open, resync) = documents;
        let _pass = if selected_paths.is_some() {
            match Arc::clone(&self.link_rewrites.gate).try_lock_owned() {
                Ok(guard) => guard,
                Err(_) => {
                    reoffer(&self.link_rewrites, &request);
                    return Ok(Value::Null);
                }
            }
        } else {
            tokio::select! {
                () = token.cancelled() => return Err(RuntimeError::Cancelled),
                guard = Arc::clone(&self.link_rewrites.gate).lock_owned() => guard,
            }
        };
        if selected_paths.is_some()
            && self
                .link_rewrites
                .stops
                .lock()
                .unwrap()
                .contains_key(&operation)
        {
            reoffer(&self.link_rewrites, &request);
            return Ok(Value::Null);
        }
        let mut retry = selected_paths.as_ref().and_then(|paths| {
            let mut pass = self
                .link_rewrites
                .deferred
                .lock()
                .unwrap()
                .get(&request)?
                .clone();
            pass.sources.retain(|object, path| {
                paths.contains(path)
                    && DocKey::new(&workspace, &pass.version, object)
                        .is_ok_and(|key| !leases.is_held(&key))
            });
            (!pass.sources.is_empty()).then_some(pass)
        });
        if selected_paths.is_some() && retry.is_none() {
            return Ok(Value::Null);
        }
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
        let selected = retry.clone();
        let paused = Arc::new(AtomicBool::new(false));
        let plan_paused = paused.clone();
        let planned = tokio::task::spawn_blocking(move || -> Result<_, RuntimeError> {
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
            if selected
                .as_ref()
                .is_some_and(|pass| pass.version != version)
            {
                return Err(DomainError::UndoRefused {
                    path: op.clone(),
                    reason: "version changed",
                }
                .into());
            }
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
                let mut candidates = if let Some(selected) = &selected {
                    incoming::Candidates {
                        sources: selected
                            .sources
                            .iter()
                            .map(|(object, path)| (object.clone(), path.clone()))
                            .collect(),
                        unchecked: Vec::new(),
                    }
                } else {
                    incoming::candidates(conn, &ws, &version, old, &["wikilink"])?
                };
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
                    deferred_sources: Mutex::default(),
                    paused: plan_paused,
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
        .map_err(|_| RuntimeError::ActorUnavailable)?;
        if selected_paths.is_some() && paused.load(Ordering::Relaxed) {
            reoffer(&self.link_rewrites, &receipt.key);
            return Ok(Value::Null);
        }
        let (plan, mut result) = planned?;
        let publication = Arc::new(Publication {
            workspace: workspace.clone(),
            operation: operation.clone(),
            root: root.clone(),
            gates,
            recorder: recorder.clone(),
        });
        self.publish_link_rewrites(publication.clone());
        let Some(plan) = plan else {
            self.link_rewrites
                .deferred
                .lock()
                .unwrap()
                .remove(&receipt.key);
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
        let mut unchecked = if let Some(selected) = &mut retry {
            let paths: HashSet<_> = selected.sources.values().collect();
            selected.unchecked.retain(|path| !paths.contains(path));
            selected.unchecked.clone()
        } else {
            self.link_rewrites.deferred.lock().unwrap().insert(
                receipt.key.clone(),
                DeferredPass {
                    input: retained,
                    version: plan.version.clone(),
                    sources: HashMap::new(),
                    captured: HashSet::new(),
                    offered: false,
                    unchecked: Vec::new(),
                    scanned: false,
                },
            );
            plan.candidates.unchecked.clone()
        };
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
            let read_request = receipt.key.clone();
            let read_leases = leases.clone();
            let targeted = retry.is_some();
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
                        if targeted {
                            let head =
                                VersionedTextStore::new(store).read_text(&ws, &p.version, &path)?;
                            if head.is_none_or(|head| head.object_id != object) {
                                skipped.push(path);
                                continue;
                            }
                            if read_leases.is_held(&key) {
                                defer(&p, &read_request, &object, &path, false);
                                skipped.push(path);
                                continue;
                            }
                        }
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
                                Err(RuntimeError::Domain(DomainError::ConflictStaleTarget)) => {
                                    defer(&p, &read_request, &object, &path, true);
                                    false
                                }
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
                    let mut outside_changed = false;
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
                                Err(RuntimeError::Domain(DomainError::WritePreconditionFailed {..})) => {
                                    outside_changed = true; Ok(false)
                                },
                                Err(RuntimeError::Domain(DomainError::UndoRefused {..})) => Ok(false),
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
                            Err(RuntimeError::Domain(DomainError::WritePreconditionFailed {..})) => {
                                outside_changed = true; Ok(false)
                            },
                            Err(RuntimeError::Sync(dohc_engine_sync::SyncError::InvalidInput {
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
                    if outside_changed { defer(&p, &r.key, &object, &source_path, true); }
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
        let scanned = retry.as_ref().map_or(!stopped, |pass| pass.scanned);
        let selected_sources = retry.as_ref().map(|pass| pass.sources.clone());
        let deferred_sources = plan.deferred_sources.lock().unwrap().clone();
        let deferred = self
            .link_rewrites
            .deferred
            .lock()
            .unwrap()
            .get(&receipt.key)
            .is_some_and(|pass| {
                pass.sources.keys().any(|object| {
                    stopped
                        || selected_sources
                            .as_ref()
                            .is_none_or(|selected| !selected.contains_key(object))
                        || deferred_sources.contains(object)
                })
            });
        result["uncheckedCount"] = json!(unchecked.len());
        result["complete"] = json!(scanned && unchecked.is_empty());
        result["unchecked"] = json!(unchecked.iter().take(50).collect::<Vec<_>>());
        let reply = result.clone();
        let mut reply_locked_since = None;
        loop {
            #[cfg(test)]
            let reply_ws = workspace.clone();
            let (receipt, result, faults) = (receipt.clone(), result.clone(), faults.clone());
            let state = self.link_rewrites.clone();
            let full_unchecked = unchecked.clone();
            let selected_sources = selected_sources.clone();
            let deferred_sources = deferred_sources.clone();
            let serial = tokio::select! {
                () = token.cancelled() => return Err(RuntimeError::Cancelled),
                guard = session_ops.clone().lock_owned() => guard,
            };
            let outcome = self
                .run(move |store, _| {
                    let _admission = serial;
                    #[cfg(test)]
                    let _turn = tests::Turn::start(&reply_ws, "reply");
                    save(
                        store,
                        &receipt,
                        !stopped && scanned && !deferred,
                        &result,
                        faults.as_ref(),
                    )?;
                    let mut waiting = state.deferred.lock().unwrap();
                    if !deferred {
                        waiting.remove(&receipt.key);
                    } else if let Some(pass) = waiting.get_mut(&receipt.key) {
                        if let Some(selected) = selected_sources.filter(|_| !stopped) {
                            pass.sources.retain(|object, _| {
                                !selected.contains_key(object) || deferred_sources.contains(object)
                            });
                        }
                        pass.captured
                            .retain(|object| pass.sources.contains_key(object));
                        pass.unchecked = full_unchecked;
                        pass.scanned = scanned;
                        pass.offered |= stopped;
                    }
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
