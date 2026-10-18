use super::*;
use dohc_engine_domain::{
    undo_compensation_moments_in, undo_member_in_tx, undo_progress_key, undo_request_fingerprint,
};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::time::Instant;

type StoredMember = (
    String,
    String,
    String,
    String,
    Option<String>,
    i64,
    String,
    Option<String>,
);
#[derive(Clone, Serialize, Deserialize)]
#[serde(from = "StoredMember", into = "StoredMember")]
struct Member {
    effect: OperationMoment,
    head: String,
    sha: Option<String>,
}
impl From<Member> for StoredMember {
    fn from(member: Member) -> Self {
        let effect = member.effect;
        (
            effect.moment_id,
            effect.object_id,
            effect.operation,
            effect.path,
            effect.before_path,
            effect.moment_order,
            member.head,
            member.sha,
        )
    }
}
impl From<StoredMember> for Member {
    fn from(value: StoredMember) -> Self {
        Self {
            effect: OperationMoment {
                moment_id: value.0,
                object_id: value.1,
                operation: value.2,
                path: value.3,
                before_path: value.4,
                moment_order: value.5,
            },
            head: value.6,
            sha: value.7,
        }
    }
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
    let body: String = conn.query_row("SELECT payload_hash FROM engine_requests WHERE request_id=?1 AND kind='history-undo-plan'", [undo_progress_key(request)], |r| r.get(0)).map_err(StorageError::corrupt_public)?;
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
    let mut stmt = conn.prepare_cached("SELECT payload_hash FROM engine_requests WHERE kind='history-undo-skipped' AND substr(request_id,1,length(?1))=?1 ORDER BY result_seq").map_err(StorageError::corrupt_public)?;
    stmt.query_map([format!("{}:", undo_progress_key(request))], |r| r.get(0))
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
                let mut stmt = conn.prepare_cached("SELECT json_extract(CASE WHEN p.kind='history-undo-plan' THEN p.payload_hash ELSE '{}' END,'$.operation'),json_extract(CASE WHEN p.kind='history-undo-plan' THEN p.payload_hash ELSE '{}' END,'$.request'),json_extract(CASE WHEN p.kind='history-undo-plan' THEN p.payload_hash ELSE '{}' END,'$.author') FROM engine_requests p JOIN engine_requests r ON r.request_id=json_extract(CASE WHEN p.kind='history-undo-plan' THEN p.payload_hash ELSE '{}' END,'$.request') WHERE p.kind='history-undo-plan' AND r.kind='history-undo-pending' AND json_extract(CASE WHEN p.kind='history-undo-plan' THEN p.payload_hash ELSE '{}' END,'$.workspace')=?1").map_err(StorageError::corrupt_public)?;
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
        let plan = if let Some((plan, _, _)) = prior {
            plan
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
                for member in &prepared.members {
                    disk_check(&disk_root, member)?;
                }
                let body = serde_json::to_string(&prepared).map_err(|_| corrupt())?;
                Ok::<_, RuntimeError>((prepared, body))
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)??;
            let p = prepared.clone();
            let f = faults.clone();
            self.run(move |store,_| {
                #[cfg(test)]
                let started = Instant::now();
                if let Some((plan,_,_)) = store.read_with(|conn| load(conn,&p.workspace,&p.operation,&p.request,p.author.as_deref()))? { return Ok(plan); }
                let outcome = store.write_with(f.as_ref(),|tx| -> Result<(),RuntimeError> {
                    let busy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_requests p JOIN engine_requests r ON r.request_id=json_extract(CASE WHEN p.kind='history-undo-plan' THEN p.payload_hash ELSE '{}' END,'$.request') WHERE p.kind='history-undo-plan' AND r.kind='history-undo-pending' AND json_extract(CASE WHEN p.kind='history-undo-plan' THEN p.payload_hash ELSE '{}' END,'$.workspace')=?1 AND json_extract(CASE WHEN p.kind='history-undo-plan' THEN p.payload_hash ELSE '{}' END,'$.operation')=?2)",params![p.workspace,p.operation],|r|r.get(0)).map_err(StorageError::corrupt_public)?;
                    if busy { return Err(DomainError::UndoRefused {path:p.operation.clone(),reason:"Undo in progress"}.into()); }
                    tx.execute("INSERT INTO engine_requests(request_id,payload_hash,result_seq,committed_at,kind) VALUES(?1,?2,0,?3,'history-undo-pending')",params![p.request,undo_request_fingerprint(&p.workspace,&p.operation,p.author.as_deref()),now]).map_err(StorageError::persist_public)?;
                    tx.execute("INSERT INTO engine_requests(request_id,payload_hash,result_seq,committed_at,kind) VALUES(?1,?2,0,?3,'history-undo-plan')",params![undo_progress_key(&p.request),body,now]).map_err(StorageError::persist_public)?;
                    Ok(())
                });
                #[cfg(test)]
                tests::record_phase(&p.request,"persist-plan",None,started.elapsed(),true);
                match outcome? { TxnOutcome::Committed(()) => Ok(p), TxnOutcome::Crashed {..} => Err(RuntimeError::OperationCrashed) }
            }).await?
        };
        let plan = Arc::new(plan);
        loop {
            let p = plan.clone();
            let (prepared_cursor, complete): (i64, bool) = self.run(move |store, _| {
                #[cfg(test)]
                let started = Instant::now();
                let outcome = store.read_with(|conn| conn.query_row("SELECT result_seq,kind='history-undo-complete' FROM engine_requests WHERE request_id=?1",[&p.request],|r| Ok((r.get(0)?,r.get(1)?)))).map_err(StorageError::corrupt_public).map_err(Into::into)
                ;
                #[cfg(test)]
                tests::record_phase(&p.request,"read-progress",None,started.elapsed(),true);
                outcome
            }).await?;
            if complete {
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
            let index = usize::try_from(prepared_cursor).map_err(|_| corrupt())?;
            let member = plan.members.get(index).ok_or_else(corrupt)?.clone();
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
            self.run(move |store,cache| {
                let _guards = (_capture,_sessions);
                #[cfg(test)]
                let started = Instant::now();
                #[cfg(test)]
                let mut check_time = std::time::Duration::ZERO;
                let outcome = with_local_file_mutation_cache_reset(cache, || {
                    let (cursor,complete): (i64,bool) = store.read_with(|conn| conn.query_row("SELECT result_seq,kind='history-undo-complete' FROM engine_requests WHERE request_id=?1",[&p.request],|r| Ok((r.get(0)?,r.get(1)?)))).map_err(StorageError::corrupt_public)?;
                    if complete || cursor != prepared_cursor { return Ok(()); }
                    let index = usize::try_from(cursor).map_err(|_| corrupt())?;
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
                    match store.write_with(f.as_ref(),|tx| -> Result<(),RuntimeError> {
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
                    Ok(())
                });
                #[cfg(test)]
                tests::record(&p.request, prepared_cursor as usize, &p.members[prepared_cursor as usize].effect.operation, prepared_cursor as usize + 1 == p.members.len(), started.elapsed(), check_time);
                outcome
            }).await?;
            tokio::task::yield_now().await;
        }
    }
}

#[cfg(test)]
#[path = "history_undo_turn_tests.rs"]
mod tests;
