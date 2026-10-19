use super::{
    ActorHandle,
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
    collections::{HashSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub(super) struct RewriteStop(Arc<AtomicU64>);
impl Drop for RewriteStop {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct Plan {
    stops: Arc<AtomicU64>,
    version: String,
    operation: String,
    rename: OperationMoment,
    paths: Vec<String>,
    revision: i64,
    candidates: incoming::Candidates,
}

fn valid(conn: &Connection, ws: &str, plan: &Plan) -> Result<bool, RuntimeError> {
    if plan.stops.load(Ordering::SeqCst) > 0 {
        return Ok(false);
    }
    let revision: i64 = conn.query_row("SELECT coalesce((SELECT revision FROM link_rewrite_revisions WHERE workspace_id=?1 AND version_id=?2),0)",params![ws,plan.version],|r|r.get(0)).map_err(StorageError::corrupt_public)?;
    let undo: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM history_undo_plans WHERE workspace_id=?1 AND operation_id=?2)",params![ws,plan.operation],|r|r.get(0)).map_err(StorageError::corrupt_public)?;
    Ok(!undo && revision == plan.revision && conn.query_row(
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
        conn.execute(
            "INSERT INTO engine_requests(request_id,payload_hash,result_seq,committed_at,kind) VALUES(?1,?2,0,?3,'history-link-rewrites')
             ON CONFLICT(request_id) DO UPDATE SET payload_hash=excluded.payload_hash,committed_at=excluded.committed_at",
            params![self.key, json!([self.binding, done, result]).to_string(), crate::links::now_ms()],
        ).map_err(StorageError::persist_public)?;
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
    pub(super) fn stop_link_rewrites(&self) -> RewriteStop {
        self.link_rewrite_stops.fetch_add(1, Ordering::SeqCst);
        RewriteStop(self.link_rewrite_stops.clone())
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
        session_ops: Arc<tokio::sync::Mutex<()>>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<Value, RuntimeError> {
        let _pass = tokio::select! {
            () = token.cancelled() => return Err(RuntimeError::Cancelled),
            guard = Arc::clone(&self.link_rewrite_gate).lock_owned() => guard,
        };
        let receipt = Arc::new(Receipt {
            key: request,
            binding: hex_sha256(json!([workspace, operation, author]).to_string().as_bytes()),
        });
        let (ws, op, r) = (workspace.clone(), operation.clone(), receipt.clone());
        #[cfg(test)]
        let admission_ws = workspace.clone();
        let db = self
            .run(move |store, _| {
                #[cfg(test)]
                let _turn = tests::Turn::start(&admission_ws, "admission");
                if store.is_passive() {
                    return Err(DomainError::InvalidInput {
                        reason: "link rewrites need the owner",
                    }
                    .into());
                }
                Ok(store.database_path().to_path_buf())
            })
            .await?;
        let stops = self.link_rewrite_stops.clone();
        let (plan, mut result) = tokio::task::spawn_blocking(move || -> Result<_, RuntimeError> {
                let mut store = EngineStore::open_read_only(&db)?;
                store.read_with(|conn| conn.execute_batch("BEGIN")).map_err(StorageError::corrupt_public)?;
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
                    let renames: Vec<_> =
                        members.iter().filter(|m| m.operation == "rename").collect();
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
                            m != *rename
                                && (m.operation != "write" || m.object_id == rename.object_id)
                        })
                    {
                        return Err(refuse().into());
                    }
                    let mut paths = Resolver::paths_for_version(conn, &ws, &version)?;
                    paths.sort();
                    let mut candidates = incoming::candidates(conn, &ws, &version, old, &["wikilink"])?;
                    let written: HashSet<_> =
                        members.iter().map(|m| m.object_id.as_str()).collect();
                    candidates.sources.retain(|(object, path)| {
                        !written.contains(object.as_str()) && !path.starts_with("shared-with-me/")
                    });
                    candidates.unchecked.retain(|path| {
                        path != &rename.path && !path.starts_with("shared-with-me/")
                    });
                    let revision = conn.query_row("SELECT coalesce((SELECT revision FROM link_rewrite_revisions WHERE workspace_id=?1 AND version_id=?2),0)",params![ws,version],|r|r.get(0)).map_err(StorageError::corrupt_public)?;
                    let plan = Plan {
                        version, operation: op.clone(), revision, stops,
                        rename: (*rename).clone(),
                        paths,
                        candidates,
                    };
                    if !valid(conn, &ws, &plan)? {
                        return Err(refuse().into());
                    }
                    Ok(plan)
                })?;
                let result = prior.map_or(json!({"documents":0,"links":0}), |(_, result)| result);

                Ok((Some(plan), result))
            }).await.map_err(|_| RuntimeError::ActorUnavailable)??;
        let Some(plan) = plan else {
            return Ok(result);
        };
        let (r, f, initial) = (receipt.clone(), faults.clone(), result.clone());
        #[cfg(test)]
        let reserve_ws = workspace.clone();
        self.run(move |store, _| {
            #[cfg(test)]
            let _turn = tests::Turn::start(&reserve_ws, "reserve");
            save(store, &r, false, &initial, f.as_ref())
        })
        .await?;
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
        let initially_open: HashSet<_> = plan
            .candidates
            .sources
            .iter()
            .filter_map(|(object, _)| {
                let key = DocKey::new(&workspace, &plan.version, object).ok()?;
                leases.is_held(&key).then(|| object.clone())
            })
            .collect();
        let initially_open = Arc::new(initially_open);
        let mut unchecked = plan.candidates.unchecked.clone();
        let mut cursor = 0;
        while cursor < plan.candidates.sources.len() {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let (ws, p, open) = (workspace.clone(), plan.clone(), initially_open.clone());
            let (next_cursor, sources, skipped, admitted) = self
                .run(move |store, _| {
                    #[cfg(test)]
                    let _turn = tests::Turn::start(&ws, "read");
                    let started = Instant::now();
                    let mut sources = Vec::new();
                    let mut skipped = Vec::new();
                    let active = VersionedTextStore::new(store)
                        .get_active_version(&ws)?
                        .version_id;
                    if active != p.version || !store.read_with(|conn| valid(conn, &ws, &p))? {
                        return Ok((cursor, sources, skipped, false));
                    }
                    let mut next = cursor;
                    while next < p.candidates.sources.len() && next - cursor < 16 {
                        let (object, path) = &p.candidates.sources[next];
                        if open.contains(object) {
                            skipped.push(path.clone());
                        } else {
                            let source = store.read_with(|conn| {
                                let source = incoming::read_source(conn, &ws, &p.version, object)?;
                                #[cfg(test)]
                                tests::after_read(conn, &ws, object);
                                Ok::<_, StorageError>(source)
                            })?;
                            if let Some(source) = source {
                                sources.push((object.clone(), path.clone(), source));
                            } else {
                                skipped.push(path.clone());
                            }
                        }
                        next += 1;
                        if started.elapsed() >= Duration::from_millis(5) {
                            break;
                        }
                    }
                    Ok((next, sources, skipped, true))
                })
                .await?;
            unchecked.extend(skipped);
            if !admitted {
                unchecked.extend(
                    plan.candidates.sources[cursor..]
                        .iter()
                        .map(|(_, p)| p.clone()),
                );
                break;
            }
            cursor = next_cursor;
            let (p, before, after) = (plan.clone(), before.clone(), after.clone());
            let (mut prepared, skipped) = tokio::task::spawn_blocking(move || {
                let mut prepared = VecDeque::new();
                let mut skipped = Vec::new();
                for (object, path, source) in sources {
                    let text = source.text().unwrap_or("").to_owned();
                    let parsed = source.parse()?;
                    let edit = if parsed.reason.is_some() {
                        None
                    } else {
                        rewrite::forward(
                            &text,
                            &path,
                            p.rename.before_path.as_deref().unwrap_or(""),
                            &p.rename.path,
                            &before,
                            &after,
                        )
                    };
                    match (parsed.head, edit) {
                        (Some(head), Some((text, links))) if links > 0 => {
                            prepared.push_back((object, head, text, links))
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
                let (ws, op, author, root, p, r, token, f, leases, mut next_result) = (
                    workspace.clone(),
                    operation.clone(),
                    author.clone(),
                    root.clone(),
                    plan.clone(),
                    receipt.clone(),
                    token.clone(),
                    faults.clone(),
                    leases.clone(),
                    result.clone(),
                );
                let committed = self
                .run(move |store, cache| {
                    #[cfg(test)]
                    let _turn = tests::Turn::start(&ws, "commit");
                    let _admission = serial;
                    let started = Instant::now();
                    let mut skipped = Vec::new();
                    while let Some((object, head, text, links)) = prepared.pop_front() {
                    let source_path = head.path.clone();
                    let key = DocKey::new(&ws, &p.version, &object)?;
                    let lease = match leases.acquire_internal(&key) {
                        Ok(lease) => Some(lease),
                        Err(CollabError::LeaseHeld) => None,
                        Err(error) => return Err(error.into()),
                    };
                    let next = json!({"documents":next_result["documents"].as_u64().unwrap_or(0)+1,"links":next_result["links"].as_u64().unwrap_or(0)+links as u64});
                    let committed = (|| -> Result<bool, RuntimeError> {
                    if lease.is_none() { return Ok(false); }
                    if token.is_cancelled() {
                        return Err(RuntimeError::Cancelled);
                    }
                    let active = VersionedTextStore::new(store)
                        .get_active_version(&ws)?
                        .version_id;
                    if active != p.version || !store.read_with(|conn| valid(conn, &ws, &p))? {
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
                            &token,
                        ) {
                            Ok(_) => Ok(true),
                            Err(RuntimeError::Domain(DomainError::WritePreconditionFailed {
                                ..
                            })) => Ok(false),
                            Err(error) => Err(error),
                        }
                    })
                    })()?;
                    if committed { next_result = next; } else { skipped.push(source_path); }
                    if started.elapsed() >= Duration::from_millis(5) { break; }
                    }
                    Ok((prepared, next_result, skipped))
                }).await?;
                (prepared, result) = (committed.0, committed.1);
                unchecked.extend(committed.2);
            }
        }
        unchecked.sort();
        unchecked.dedup();
        result["uncheckedCount"] = json!(unchecked.len());
        result["complete"] = json!(unchecked.is_empty());
        result["unchecked"] = json!(unchecked.into_iter().take(50).collect::<Vec<_>>());
        let reply = result.clone();
        self.run(move |store, _| {
            #[cfg(test)]
            let _turn = tests::Turn::start(&workspace, "reply");
            save(store, &receipt, true, &result, faults.as_ref())?;
            Ok(())
        })
        .await?;
        Ok(reply)
    }
}

#[cfg(test)]
#[path = "link_rewrite_tests.rs"]
mod tests;
