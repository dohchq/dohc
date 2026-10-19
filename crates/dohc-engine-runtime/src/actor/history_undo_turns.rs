use super::*;
use dohc_engine_domain::{
    undo_compensation_moments_in, undo_member_in_tx, undo_progress_key, undo_request_fingerprint,
};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::time::Instant;

#[derive(Clone, Serialize, Deserialize)]
struct Member {
    effect: OperationMoment,
    head: String,
    sha: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Plan {
    workspace: String,
    version: String,
    operation: String,
    request: String,
    author: Option<String>,
    members: Vec<Member>,
}
fn corrupt() -> RuntimeError {
    DomainError::StateCorrupt {
        reason: "Undo progress",
    }
    .into()
}
fn signature(
    conn: &rusqlite::Connection,
    ws: &str,
    version: &str,
    object: &str,
) -> Result<String, RuntimeError> {
    conn.query_row("SELECT json_array(
        (SELECT max(moment_order) FROM moments WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3),
        (SELECT json_array(path,blob_sha256,binary_sha256) FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3))", params![ws,version,object], |r| r.get(0)).map_err(StorageError::corrupt_public).map_err(Into::into)
}
fn load(
    conn: &rusqlite::Connection,
    ws: &str,
    operation: &str,
    request: &str,
    author: Option<&str>,
) -> Result<Option<(Plan, usize, bool)>, RuntimeError> {
    let row: Option<(String, i64, String)> = conn
        .query_row(
            "SELECT payload_hash,result_seq,kind FROM engine_requests WHERE request_id=?1",
            [request],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(StorageError::corrupt_public)?;
    let Some((hash, cursor, kind)) = row else {
        return Ok(None);
    };
    if hash != undo_request_fingerprint(ws, operation, author) {
        return Err(DomainError::IdempotencyKeyReuseMismatch.into());
    }
    if !matches!(
        kind.as_str(),
        "history-undo-pending" | "history-undo-complete"
    ) {
        return Ok(None);
    }
    let body: String = conn.query_row("SELECT plan_json FROM history_undo_plans WHERE request_id=?1", [request], |r| r.get(0)).map_err(StorageError::corrupt_public)?;
    let plan: Plan = serde_json::from_str(&body).map_err(|_| corrupt())?;
    let cursor = usize::try_from(cursor).map_err(|_| corrupt())?;
    if plan.workspace != ws
        || plan.operation != operation
        || plan.request != request
        || plan.author.as_deref() != author
        || cursor > plan.members.len()
    {
        return Err(corrupt());
    }
    Ok(Some((plan, cursor, kind == "history-undo-complete")))
}
pub(super) fn not_restored(
    conn: &rusqlite::Connection,
    request: &str,
) -> Result<Vec<String>, RuntimeError> {
    let mut stmt = conn.prepare_cached("SELECT payload_hash FROM engine_requests WHERE kind='history-undo-skipped' AND request_id>=?1 AND request_id<?2 ORDER BY result_seq").map_err(StorageError::corrupt_public)?;
    stmt.query_map([format!("{}:", undo_progress_key(request)), format!("{};", undo_progress_key(request))], |r| r.get(0))
        .map_err(StorageError::corrupt_public)?
        .collect::<Result<_, _>>()
        .map_err(StorageError::corrupt_public)
        .map_err(Into::into)
}
type DiskProof = (
    dohc_engine_files::ProjectionProbe,
    Option<dohc_engine_files::ProjectionTargetStamp>,
);
fn disk_check(root: &Path, member: &Member) -> Result<DiskProof, RuntimeError> {
    let probe =
        dohc_engine_files::ProjectionProbe::new(root).map_err(StorageError::persist_public)?;
    let m = &member.effect;
    let refuse = |path: &str, reason| DomainError::UndoRefused {
        path: path.to_owned(),
        reason,
    };
    let target = m.before_path.as_deref().unwrap_or(&m.path);
    if probe.stamp(target) != dohc_engine_files::ProjectionTargetStamp::Absent {
        return Err(refuse(target, "old path occupied on disk").into());
    }
    let mut source = None;
    if let Some(sha) = &member.sha {
        let stamp = probe.stamp(&m.path);
        if !matches!(stamp, dohc_engine_files::ProjectionTargetStamp::File { .. })
            || !matches!(probe_undo_source(&probe,&m.path),dohc_engine_files::ProjectionTargetState::Text {sha256} | dohc_engine_files::ProjectionTargetState::Binary {sha256} if &sha256 == sha)
            || probe.stamp(&m.path) != stamp
        {
            return Err(refuse(&m.path, "source changed on disk").into());
        }
        source = Some(stamp);
    }
    Ok((probe, source))
}
fn result(
    store: &EngineStore,
    plan: &Plan,
    deduped: bool,
) -> Result<HistoryUndoResult, RuntimeError> {
    store.read_with(|conn| {
        Ok(HistoryUndoResult {
            operation_id: plan.operation.clone(),
            version_id: plan.version.clone(),
            moments: undo_compensation_moments_in(
                conn,
                &plan.workspace,
                &plan.version,
                &plan.operation,
                &plan.request,
            )?,
            compensation_operation_id: undo_correlation_id(
                &plan.workspace,
                &plan.operation,
                &plan.request,
            ),
            deduped,
            materialized: false,
            not_restored: not_restored(conn, &plan.request)?,
        })
    })
}
impl ActorHandle {
    pub async fn pending_history_undos(
        &self,
        ws: String,
    ) -> Result<Vec<(String, String, Option<String>)>, RuntimeError> {
        self.run(move |store,_| {
            if store.is_passive() { return Ok(Vec::new()); }
            store.read_with(|conn| {
                let mut stmt = conn.prepare_cached("SELECT p.operation_id,r.request_id,p.author_json FROM engine_requests r INDEXED BY idx_engine_requests_kind JOIN history_undo_plans p ON p.request_id=r.request_id WHERE r.kind='history-undo-pending' AND p.workspace_id=?1").map_err(StorageError::corrupt_public)?;
                stmt.query_map([ws],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(StorageError::corrupt_public)?.collect::<Result<_,_>>().map_err(StorageError::corrupt_public).map_err(Into::into)
            })
        }).await
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn history_undo_in_turns(
        &self,
        ws: String,
        operation: String,
        request: String,
        author: Option<String>,
        root: PathBuf,
        faults: Arc<dyn FaultInjector>,
        now: i64,
        gates: [Arc<tokio::sync::Mutex<()>>; 2],
    ) -> Result<HistoryUndoResult, RuntimeError> {
        let (w, o, r, a) = (
            ws.clone(),
            operation.clone(),
            request.clone(),
            author.clone(),
        );
        #[cfg(test)]
        let probe_request = request.clone();
        let db = self
            .run(move |store, _| {
                #[cfg(test)]
                let started = Instant::now();
                #[cfg(test)]
                tests::begin_turn(&probe_request);
                if store.is_passive() {
                    return Err(DomainError::InvalidInput {
                        reason: "Undo needs the owner",
                    }
                    .into());
                }
                let path = store.database_path().to_path_buf();
                #[cfg(test)]
                tests::record_phase(&probe_request, "admission", None, started.elapsed(), true);
                Ok(path)
            })
            .await?;
        let read_db = db.clone();
        let prior = tokio::task::spawn_blocking(move || {
            let store = EngineStore::open_read_only(&read_db)?;
            store.read_with(|conn| load(conn, &w, &o, &r, a.as_deref()))
        })
        .await
        .map_err(|_| RuntimeError::ActorUnavailable)??;
        let deduped = prior.is_some();
        let (plan, mut prepared_cursor) = if let Some((plan, cursor, _)) = prior {
            (Arc::new(plan), cursor)
        } else {
            if let Some(replay) = self
                .preflight_history_undo(
                    ws.clone(),
                    operation.clone(),
                    request.clone(),
                    author.clone(),
                )
                .await?
            {
                return Ok(replay);
            }
            let (w, o, r, a) = (
                ws.clone(),
                operation.clone(),
                request.clone(),
                author.clone(),
            );
            let read_db = db.clone();
            let prepared = tokio::task::spawn_blocking(move || {
                #[cfg(test)]
                let started = Instant::now();
                let mut store = EngineStore::open_read_only(&read_db)?;
                store
                    .read_with(|conn| conn.execute_batch("BEGIN"))
                    .map_err(StorageError::corrupt_public)?;
                let version = VersionedTextStore::new(&mut store)
                    .get_active_version(&w)?
                    .version_id;
                let members = store.read_with(|conn| -> Result<_, RuntimeError> {
                    let mut originals = preflight_undo_operation_in(conn, &w, &version, &o)?;
                    originals.sort_by_key(|m| m.operation != "rename");
                    originals
                        .into_iter()
                        .map(|effect| {
                            check_undo_ownership(conn, &w, &version, &effect)?;
                            let head = signature(conn, &w, &version, &effect.object_id)?;
                            let sha = if effect.operation == "rename" {
                                Some(rename_head_sha(conn, &w, &version, &effect.object_id)?)
                            } else {
                                None
                            };
                            Ok(Member { effect, head, sha })
                        })
                        .collect::<Result<Vec<_>, RuntimeError>>()
                })?;
                #[cfg(test)]
                tests::record_phase(
                    &r,
                    "planning-check (worker)",
                    None,
                    started.elapsed(),
                    false,
                );
                Ok::<_, RuntimeError>(Plan {
                    workspace: w,
                    version,
                    operation: o,
                    request: r,
                    author: a,
                    members,
                })
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)??;
            let disk_root = root.clone();
            let (prepared, body) = tokio::task::spawn_blocking(move || {
                #[cfg(test)]
                let started = Instant::now();
                for member in &prepared.members {
                    disk_check(&disk_root, member)?;
                }
                let body = serde_json::to_string(&prepared).map_err(|_| corrupt())?;
                #[cfg(test)]
                tests::record_phase(
                    &prepared.request,
                    "all-member-disk-check (worker)",
                    None,
                    started.elapsed(),
                    false,
                );
                Ok::<_, RuntimeError>((prepared, body))
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)??;
            let prepared = Arc::new(prepared);
            let body = Arc::new(body);
            let plan = loop {
                let (p, body, f) = (prepared.clone(), body.clone(), faults.clone());
                let outcome = self.run(move |store,_| {
                #[cfg(test)]
                let started = Instant::now();
                #[cfg(test)]
                tests::begin_turn(&p.request);
                if let Some((plan,_,_)) = store.read_with(|conn| load(conn,&p.workspace,&p.operation,&p.request,p.author.as_deref()))? { return Ok(Arc::new(plan)); }
                let outcome = store.write_background_with(f.as_ref(),|tx| -> Result<(),RuntimeError> {
                    let prior: Option<String> = tx.query_row("SELECT r.kind FROM history_undo_plans p JOIN engine_requests r ON r.request_id=p.request_id WHERE p.workspace_id=?1 AND p.operation_id=?2",params![p.workspace,p.operation],|r|r.get(0)).optional().map_err(StorageError::corrupt_public)?;
                    if let Some(kind) = prior { return Err(DomainError::UndoRefused {path:p.operation.clone(),reason:if kind=="history-undo-complete" {"Operation already undone"} else {"Undo in progress"}}.into()); }
                    tx.execute("INSERT INTO engine_requests(request_id,payload_hash,result_seq,committed_at,kind) VALUES(?1,?2,0,?3,'history-undo-pending')",params![p.request,undo_request_fingerprint(&p.workspace,&p.operation,p.author.as_deref()),now]).map_err(StorageError::persist_public)?;
                    tx.execute("INSERT INTO history_undo_plans(request_id,workspace_id,version_id,operation_id,author_json,plan_json) VALUES(?1,?2,?3,?4,?5,?6)",params![p.request,p.workspace,p.version,p.operation,p.author,body.as_str()]).map_err(StorageError::persist_public)?;
                    Ok(())
                });
                #[cfg(test)]
                tests::record_phase(&p.request,"persist-plan",None,started.elapsed(),true);
                match outcome? { TxnOutcome::Committed(()) => Ok(p), TxnOutcome::Crashed {..} => Err(RuntimeError::OperationCrashed) }
            }).await;
                match outcome {
                    Ok(plan) => break plan,
                    Err(RuntimeError::Storage(StorageError::FileLocked)) => {
                        tokio::task::yield_now().await
                    }
                    Err(error) => return Err(error),
                }
            };
            (plan, 0)
        };
        loop {
            if prepared_cursor == plan.members.len() {
                let p = plan.clone();
                return tokio::task::spawn_blocking(move || {
                    #[cfg(test)]
                    let started = Instant::now();
                    let store = EngineStore::open_read_only(&db)?;
                    let outcome = result(&store, &p, deduped);
                    #[cfg(test)]
                    tests::record_phase(
                        &p.request,
                        "read-result (worker)",
                        None,
                        started.elapsed(),
                        false,
                    );
                    outcome
                })
                .await
                .map_err(|_| RuntimeError::ActorUnavailable)?;
            }
            let member = plan
                .members
                .get(prepared_cursor)
                .ok_or_else(corrupt)?
                .clone();
            let disk_root = root.clone();
            let (disk, policy) = tokio::task::spawn_blocking(move || {
                (
                    disk_check(&disk_root, &member),
                    crate::search::read_engine_search_policy(&disk_root),
                )
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
            let _capture = gates[0].clone().lock_owned().await;
            let _sessions = gates[1].clone().lock_owned().await;
            let (p, f) = (plan.clone(), faults.clone());
            let next = self.run(move |store,cache| {
                let _guards = (_capture,_sessions);
                #[cfg(test)]
                let started = Instant::now();
                #[cfg(test)]
                tests::begin_turn(&p.request);
                #[cfg(test)]
                let mut check_time = std::time::Duration::ZERO;
                let outcome = with_local_file_mutation_cache_reset(cache, || {
                    let (cursor,complete): (i64,bool) = store.read_with(|conn| conn.query_row("SELECT result_seq,kind='history-undo-complete' FROM engine_requests WHERE request_id=?1",[&p.request],|r| Ok((r.get(0)?,r.get(1)?)))).map_err(StorageError::corrupt_public)?;
                    let index = usize::try_from(cursor).map_err(|_| corrupt())?;
                    if complete { return Ok(p.members.len()); }
                    if index != prepared_cursor { return Ok(index); }
                    let member = p.members.get(index).ok_or_else(corrupt)?;
                    let active = VersionedTextStore::new(store).get_active_version(&p.workspace)?.version_id;
                    let unchanged = active == p.version && store.read_with(|conn| signature(conn,&p.workspace,&p.version,&member.effect.object_id))? == member.head;
                    let target = member.effect.before_path.as_deref().unwrap_or(&member.effect.path);
                    let vacant: bool = store.read_with(|conn| conn.query_row("SELECT NOT EXISTS(SELECT 1 FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 AND path=?3)",params![p.workspace,p.version,target],|r|r.get(0))).map_err(StorageError::corrupt_public)?;
                    let admitted = store.read_with(|conn| check_undo_ownership(conn,&p.workspace,&p.version,&member.effect));
                    let disk_changed = matches!(&disk,Err(RuntimeError::Domain(DomainError::UndoRefused {..}))) || disk.as_ref().is_ok_and(|(probe, source)| {
                        probe.stamp(target) != dohc_engine_files::ProjectionTargetStamp::Absent || source.as_ref().is_some_and(|stamp| probe.stamp(&member.effect.path) != *stamp)
                    });
                    let changed = !unchanged || !vacant || matches!(&admitted,Err(RuntimeError::Domain(DomainError::UndoRefused {..}) | RuntimeError::Sync(dohc_engine_sync::SyncError::LiveDocumentBindingActive))) || disk_changed;
                    if !changed { admitted?; disk?; }
                    #[cfg(test)]
                    { check_time = started.elapsed(); }
                    match store.write_background_with(f.as_ref(),|tx| -> Result<(),RuntimeError> {
                        if changed {
                            let path = tx.query_row("SELECT path FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![p.workspace,p.version,member.effect.object_id],|r| r.get::<_,String>(0)).optional().map_err(StorageError::corrupt_public)?.unwrap_or_else(|| member.effect.path.clone());
                            tx.execute("INSERT INTO engine_requests(request_id,payload_hash,result_seq,committed_at,kind) VALUES(?1,?2,?3,?4,'history-undo-skipped')",params![format!("{}:{cursor}",undo_progress_key(&p.request)),path,cursor,now]).map_err(StorageError::persist_public)?;
                        } else {
                            tx.execute_batch("SAVEPOINT undo_member").map_err(StorageError::persist_public)?;
                            let objects = serde_json::to_string(&[&member.effect.object_id]).map_err(|_| corrupt())?;
                            crate::search::index::begin_file_search_index_batch(tx,&policy,&p.workspace,&p.version,&objects).map_err(super::super::search::search_domain)?;
                            let inverse = undo_member_in_tx(tx,&p.workspace,&p.version,&undo_correlation_id(&p.workspace,&p.operation,&p.request),p.author.as_deref(),now,member.effect.clone(),|tx,m| publish_undo_member(tx,&p.workspace,&p.version,&policy,m,now));
                            match inverse {
                                Ok(_) => tx.execute_batch("RELEASE undo_member").map_err(StorageError::persist_public)?,
                                Err(DomainError::UndoRefused {path,..}) => {
                                    tx.execute_batch("ROLLBACK TO undo_member; RELEASE undo_member").map_err(StorageError::persist_public)?;
                                    tx.execute("INSERT INTO engine_requests(request_id,payload_hash,result_seq,committed_at,kind) VALUES(?1,?2,?3,?4,'history-undo-skipped')",params![format!("{}:{cursor}",undo_progress_key(&p.request)),path,cursor,now]).map_err(StorageError::persist_public)?;
                                },
                                Err(error) => return Err(error.into()),
                            }
                        }
                        tx.execute("UPDATE engine_requests SET result_seq=?2,kind=?3,committed_at=?4 WHERE request_id=?1",params![p.request,cursor+1,if index+1==p.members.len() {"history-undo-complete"} else {"history-undo-pending"},now]).map_err(StorageError::persist_public)?;
                        Ok(())
                    })? { TxnOutcome::Committed(()) => {}, TxnOutcome::Crashed {..} => return Err(RuntimeError::OperationCrashed) }
                    Ok(index + 1)
                });
                #[cfg(test)]
                tests::record(&p.request, prepared_cursor, &p.members[prepared_cursor].effect.operation, prepared_cursor + 1 == p.members.len(), started.elapsed(), check_time);
                outcome
            }).await;
            match next {
                Ok(cursor) => prepared_cursor = cursor,
                Err(RuntimeError::Storage(StorageError::FileLocked)) => {}
                Err(error) => return Err(error),
            }
            tokio::task::yield_now().await;
        }
    }
}

#[cfg(test)]
#[path = "history_undo_turn_tests.rs"]
mod tests;
