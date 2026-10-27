use super::*;
use crate::CancellationToken;
use dohc_engine_collab::DocKey;
use dohc_engine_domain::{
    undo_compensation_moments_in, undo_member_in_tx, undo_progress_key, undo_request_fingerprint,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
struct Member {
    effect: OperationMoment,
    head: String,
    sha: Option<String>,
    #[serde(default)]
    settle_error: Option<String>,
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
struct Inverse {
    text: String,
    live: Option<super::super::link_documents::Edit>,
}
struct Prepared {
    inverse: Result<Option<Inverse>, RuntimeError>,
    disk: Result<DiskProof, RuntimeError>,
}
fn inverse_input(
    conn: &rusqlite::Connection,
    ws: &str,
    version: &str,
    operation: &str,
    member: &Member,
) -> Result<Option<Inverse>, RuntimeError> {
    if member.effect.operation == "write"
        && !dohc_engine_domain::is_duplicate_in(conn, ws, operation, member.effect.moment_order)?
    {
        let text = link_inverse_input(conn, ws, version, &member.effect)?;
        Ok(Some(Inverse { text, live: None }))
    } else {
        Ok(None)
    }
}
fn inverse_live_edit(
    conn: &rusqlite::Connection,
    ws: &str,
    version: &str,
    member: &Member,
    text: &str,
    open: Option<&(
        super::super::link_documents::DocumentIsOpen,
        super::super::link_documents::DocumentResync,
    )>,
) -> Result<Option<super::super::link_documents::Edit>, RuntimeError> {
    let key = DocKey::new(ws, version, &member.effect.object_id)?;
    let live = if open.is_some_and(|(is_open, _)| is_open(&key)) {
        let head: String = conn.query_row("SELECT blob_sha256 FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![ws,version,member.effect.object_id], |r| r.get(0)).map_err(StorageError::corrupt_public)?;
        let before =
            dohc_engine_storage::text::read(conn, &head).map_err(StorageError::corrupt_public)?;
        Some(
            super::super::link_documents::prepare(conn, &key, &before, text)?.ok_or(
                DomainError::UndoRefused {
                    path: member.effect.path.clone(),
                    reason: "wikilink element unavailable",
                },
            )?,
        )
    } else {
        None
    };
    Ok(live)
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
        (SELECT json_array(head_update_seq,head_snapshot_seq,lineage_claim_id) FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3),
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
    if hash != undo_request_fingerprint(conn, ws, operation, author)? {
        return Err(DomainError::IdempotencyKeyReuseMismatch.into());
    }
    if !matches!(
        kind.as_str(),
        "history-undo-pending" | "history-undo-complete"
    ) {
        return Ok(None);
    }
    let body: String = conn
        .query_row(
            "SELECT plan_json FROM history_undo_plans WHERE request_id=?1",
            [request],
            |r| r.get(0),
        )
        .map_err(StorageError::corrupt_public)?;
    let plan: Plan = serde_json::from_str(&body).map_err(|_| corrupt())?;
    let cursor = usize::try_from(cursor).map_err(|_| corrupt())?;
    if plan.workspace != ws
        || plan.operation != operation
        || plan.request != request
        || hash != undo_request_fingerprint(conn, ws, operation, plan.author.as_deref())?
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
    stmt.query_map(
        [
            format!("{}:", undo_progress_key(request)),
            format!("{};", undo_progress_key(request)),
        ],
        |r| r.get(0),
    )
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
    #[cfg(test)]
    tests::observe_disk_probe(root);
    let probe =
        dohc_engine_files::ProjectionProbe::new(root).map_err(StorageError::persist_public)?;
    let m = &member.effect;
    let refuse = |path: &str, reason| DomainError::UndoRefused {
        path: path.to_owned(),
        reason,
    };
    let target = m.before_path.as_deref().unwrap_or(&m.path);
    if m.operation != "write"
        && probe.stamp(target) != dohc_engine_files::ProjectionTargetStamp::Absent
    {
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
    } else if m.operation == "write" {
        if probe.stamp(&m.path) != dohc_engine_files::ProjectionTargetStamp::Absent {
            return Err(refuse(&m.path, "source changed on disk").into());
        }
        source = Some(dohc_engine_files::ProjectionTargetStamp::Absent);
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
type PendingPublication = (
    std::collections::HashMap<String, Option<String>>,
    Vec<String>,
);
fn pending_publication(
    conn: &rusqlite::Connection,
    ws: &str,
    operation: &str,
    root: &Path,
    token: &CancellationToken,
) -> Result<PendingPublication, RuntimeError> {
    let version = dohc_engine_domain::get_active_version_in(conn, ws)?.version_id;
    let mut stmt = conn.prepare_cached("WITH paths(path) AS (
        SELECT path FROM moments WHERE workspace_id=?1 AND metadata_correlation_id=?2 AND version_id=?3
        UNION SELECT payload_before_path FROM moments WHERE workspace_id=?1 AND metadata_correlation_id=?2 AND version_id=?3
        UNION SELECT s.path FROM moments m JOIN snapshots s
          ON s.workspace_id=m.workspace_id AND s.version_id=m.version_id AND s.object_id=m.object_id
          WHERE m.workspace_id=?1 AND m.metadata_correlation_id=?2 AND m.version_id=?3)
        SELECT j.job_id,j.target_path,j.operation,j.preimage_present,j.preimage_sha256
        FROM materialization_jobs j WHERE j.workspace_id=?1 AND j.status='pending'
          AND j.target_path IN (SELECT path FROM paths)
        ORDER BY j.target_generation,j.job_id").map_err(StorageError::corrupt_public)?;
    let jobs = stmt
        .query_map(params![ws, operation, version], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, bool>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(StorageError::corrupt_public)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::corrupt_public)?;
    let probe =
        dohc_engine_files::ProjectionProbe::new(root).map_err(StorageError::persist_public)?;
    let mut paths = std::collections::HashMap::new();
    let mut unpublished = std::collections::HashMap::new();
    // Ordinary jobs carry their moment_order as target_generation.
    // The oldest preimage describes disk before the entire pending chain.
    for (_, path, kind, present, sha) in &jobs {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if let std::collections::hash_map::Entry::Vacant(entry) = paths.entry(path.clone()) {
            let unchanged = match probe_undo_source(&probe, path) {
                dohc_engine_files::ProjectionTargetState::Text { sha256 }
                | dohc_engine_files::ProjectionTargetState::Binary { sha256 } => {
                    *present && sha.as_deref() == Some(&sha256)
                }
                dohc_engine_files::ProjectionTargetState::Absent => !present,
                _ => false,
            };
            entry.insert(unchanged);
            if unchanged {
                unpublished.insert(path.clone(), sha.clone());
            }
        }
        if kind != "write" {
            paths.insert(path.clone(), false);
            unpublished.remove(path);
        }
    }
    let replay = jobs
        .into_iter()
        .filter_map(|(job, path, _, _, _)| (!paths[&path]).then_some(job))
        .collect();
    Ok((unpublished, replay))
}

impl ActorHandle {
    /// Partition whole pending path chains before the Undo fence reconciles disk.
    pub async fn history_undo_pending_publication(
        &self,
        ws: String,
        operation: String,
        root: PathBuf,
        token: CancellationToken,
    ) -> Result<PendingPublication, RuntimeError> {
        // Read after the actor's earlier work.
        self.run(|_, _| Ok(())).await?;
        let held = self.location();
        tokio::task::spawn_blocking(move || {
            let store = HeldReader::open(held)?;
            store.read_with(|conn| pending_publication(conn, &ws, &operation, &root, &token))
        })
        .await
        .map_err(|_| RuntimeError::ActorUnavailable)?
    }

    async fn run_undo_turn<R: Send + 'static>(
        &self,
        request: String,
        phase: &'static str,
        member: Option<usize>,
        work: impl FnOnce(
            &mut EngineStore,
            &mut dohc_engine_collab::WriterDocCache,
        ) -> Result<R, RuntimeError>
        + Send
        + 'static,
    ) -> Result<R, RuntimeError> {
        self.run(move |store, cache| {
            #[cfg(test)]
            let probe = tests::TurnProbe::new(&request, phase, member);
            #[cfg(not(test))]
            let _ = (request, phase, member);
            let outcome = work(store, cache);
            #[cfg(test)]
            probe.finish();
            outcome
        })
        .await
    }
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
    pub(in crate::actor) async fn wait_undo_checkpoint(
        token: &crate::CancellationToken,
        since: &mut Option<std::time::Instant>,
        wait: Arc<impl Fn() -> dohc_engine_storage::CheckpointWait + Send + Sync + 'static>,
    ) -> Result<(), RuntimeError> {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        let locked_since = *since.get_or_insert_with(std::time::Instant::now);
        let checkpoint = tokio::task::spawn_blocking(move || wait())
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if checkpoint == dohc_engine_storage::CheckpointWait::Running {
            // A PASSIVE checkpoint can still be copying or syncing pages.
            // Only an idle or completed cycle can establish persistent contention.
            *since = None;
        } else if locked_since.elapsed() >= std::time::Duration::from_secs(1) {
            return Err(StorageError::FileLocked.into());
        }
        tokio::select! {
            () = token.cancelled() => return Err(RuntimeError::Cancelled),
            () = tokio::time::sleep(std::time::Duration::from_millis(50)) => {}
        }
        Ok(())
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
        recorder: Arc<dyn SelfWriteRecorder>,
        open_documents: Option<(
            super::super::link_documents::DocumentIsOpen,
            super::super::link_documents::DocumentResync,
        )>,
        token: crate::CancellationToken,
    ) -> Result<HistoryUndoResult, RuntimeError> {
        let _stop = self.stop_link_rewrites(&operation);
        let _undo = tokio::select! {
            () = token.cancelled() => return Err(RuntimeError::Cancelled),
            guard = Arc::clone(&self.link_rewrites.undo_gate).lock_owned() => guard,
        };
        dohc_engine_domain::validate_moment_metadata(
            "restore",
            Some("Undo"),
            Some(&operation),
            author.as_deref(),
        )?;
        let (w, o, r, a) = (
            ws.clone(),
            operation.clone(),
            request.clone(),
            author.clone(),
        );
        let checkpoint = self
            .run_undo_turn(request.clone(), "admission", None, move |store, _| {
                if store.is_passive() {
                    return Err(DomainError::InvalidInput {
                        reason: "Undo needs the owner",
                    }
                    .into());
                }
                Ok(Arc::new(store.checkpoint_cycle()))
            })
            .await?;
        let held = self.location();
        let pending_root = root.clone();
        let pending_token = token.clone();
        let (mut inverse_store, prior, pending) = tokio::task::spawn_blocking(move || {
            let store = HeldReader::open(held)?;
            let (prior, pending) = store.read_with(|conn| -> Result<_, RuntimeError> {
                let prior = load(conn, &w, &o, &r, a.as_deref())?;
                let jobs = if prior.is_none() {
                    pending_publication(conn, &w, &o, &pending_root, &pending_token)?
                } else {
                    Default::default()
                };
                Ok((prior, jobs))
            })?;
            Ok::<_, RuntimeError>((store, prior, pending))
        })
        .await
        .map_err(|_| RuntimeError::ActorUnavailable)??;
        let mut deduped = true;
        let mut locked_since = None;
        let mut inputs = std::collections::VecDeque::new();
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
            // Keep unchanged preimage chains pending until compensation commits.
            let (unpublished, pending) = pending;
            for jobs in pending.chunks(16) {
                if token.is_cancelled() {
                    return Err(RuntimeError::Cancelled);
                }
                let jobs: HashSet<_> = jobs.iter().cloned().collect();
                let (w, root, recorder) = (ws.clone(), root.clone(), recorder.clone());
                let capture = gates[0].clone().lock_owned().await;
                let sessions = gates[1].clone().lock_owned().await;
                self.run_undo_turn(
                    request.clone(),
                    "write-publication",
                    None,
                    move |store, _| {
                        let _guards = (capture, sessions);
                        store.with_materialization_status_batch(|store| {
                            replay_pending_materializations(
                                store,
                                &root,
                                MaterializationReplayScope {
                                    holds: None,
                                    workspace_id: &w,
                                    self_writes: Some(recorder.as_ref()),
                                    progress: None,
                                    file_outcomes_settled: false,
                                    released_hold_paths: None,
                                    planned_against_active_heads: false,
                                },
                                now,
                                &dohc_engine_storage::NoFaults,
                                Some(&jobs),
                                false,
                            )
                        })?;
                        Ok(())
                    },
                )
                .await?;
            }
            let (w, o, r, a) = (
                ws.clone(),
                operation.clone(),
                request.clone(),
                author.clone(),
            );
            let held = self.location();
            let mut prepared = tokio::task::spawn_blocking(move || {
                let mut store = HeldReader::open(held)?;
                store
                    .read_with(|conn| conn.execute_batch("BEGIN"))
                    .map_err(StorageError::corrupt_public)?;
                // A prior attempt may have persisted before losing its reply.
                if let Some((plan, _, _)) =
                    store.read_with(|conn| load(conn, &w, &o, &r, a.as_deref()))?
                {
                    return Ok::<_, RuntimeError>(plan);
                }
                let version = VersionedTextStore::new(&mut store)
                    .get_active_version(&w)?
                    .version_id;
                let members = store.read_with(|conn| -> Result<_, RuntimeError> {
                    // Capture holds take precedence over History and disk refusals.
                    for effect in operation_moments_in(conn, &w, &version, &o)? {
                        check_undo_ownership(conn, &w, &version, &o, &effect)?;
                    }
                    let mut originals = preflight_undo_operation_in(conn, &w, &version, &o)?;
                    originals.sort_by_key(|m| m.operation != "rename");
                    originals
                        .into_iter()
                        .map(|mut effect| {
                            let head = signature(conn, &w, &version, &effect.object_id)?;
                            if effect.operation == "write" && !dohc_engine_domain::is_duplicate_in(conn, &w, &o, effect.moment_order)? {
                                effect.path = conn.query_row("SELECT path FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![w,version,effect.object_id],|r|r.get(0)).map_err(StorageError::corrupt_public)?;
                                effect.before_path=None;
                            }
                            let sha = if effect.operation == "rename" || effect.operation == "write" {
                                Some(rename_head_sha(conn, &w, &version, &effect.object_id)?)
                            } else {
                                None
                            };
                            let sha = unpublished.get(&effect.path).cloned().unwrap_or(sha);
                            Ok(Member { effect, head, sha, settle_error: None })
                        })
                        .collect::<Result<Vec<_>, RuntimeError>>()
                })?;
                let prepared = Plan {
                    workspace: w,
                    version,
                    operation: o,
                    request: r,
                    author: a,
                    members,
                };
                Ok::<_, RuntimeError>(prepared)
            }).await.map_err(|_| RuntimeError::ActorUnavailable)??;
            for member in &mut prepared.members {
                if token.is_cancelled() {
                    return Err(RuntimeError::Cancelled);
                }
                let key = DocKey::new(
                    &prepared.workspace,
                    &prepared.version,
                    &member.effect.object_id,
                )?;
                let duplicate = inverse_store.read_with(|conn| {
                    dohc_engine_domain::is_duplicate_in(
                        conn,
                        &prepared.workspace,
                        &prepared.operation,
                        member.effect.moment_order,
                    )
                })?;
                let guards = loop {
                    let guards = if member.effect.operation == "write" {
                        let capture = tokio::select! {
                            () = token.cancelled() => return Err(RuntimeError::Cancelled),
                            guard = gates[0].clone().lock_owned() => guard,
                        };
                        let sessions = tokio::select! {
                            () = token.cancelled() => return Err(RuntimeError::Cancelled),
                            guard = gates[1].clone().lock_owned() => guard,
                        };
                        Some((capture, sessions))
                    } else {
                        None
                    };
                    let live = member.effect.operation == "write"
                        && !duplicate
                        && open_documents
                            .as_ref()
                            .is_some_and(|(is_open, _)| is_open(&key));
                    if !live {
                        break guards;
                    }
                    let key = key.clone();
                    let (path, root2, recorder2, token2) = (
                        member.effect.path.clone(),
                        root.clone(),
                        recorder.clone(),
                        token.clone(),
                    );
                    let outcome = self
                        .run_with_reader_retry(move |store, cache| {
                            let usable = super::super::link_documents::baseline(
                                store,
                                cache,
                                &root2,
                                &key,
                                &path,
                                &token2,
                                recorder2.as_ref(),
                                |_| true,
                            )?;
                            let head = store.read_with(|c| {
                                signature(c, &key.workspace_id, &key.version_id, &key.object_id)
                            })?;
                            let sha = store.read_with(|c| {
                                rename_head_sha(
                                    c,
                                    &key.workspace_id,
                                    &key.version_id,
                                    &key.object_id,
                                )
                            })?;
                            Ok((usable, head, sha))
                        })
                        .await;
                    match outcome {
                        Ok((usable, head, sha)) => {
                            member.head = head;
                            member.sha = Some(sha);
                            locked_since = None;
                            if !usable {
                                member.settle_error =
                                    Some("document projection unavailable".into());
                            }
                            break guards;
                        }
                        Err(error) if error.code() == "file-locked" => {
                            drop(guards);
                            #[cfg(test)]
                            tests::checkpoint_wait(&request).await;
                            Self::wait_undo_checkpoint(
                                &token,
                                &mut locked_since,
                                checkpoint.clone(),
                            )
                            .await?;
                        }
                        Err(RuntimeError::Cancelled) => return Err(RuntimeError::Cancelled),
                        Err(error) => {
                            member.settle_error = Some(error.to_string());
                            break guards;
                        }
                    }
                };
                let (w, v, o, member) = (
                    prepared.workspace.clone(),
                    prepared.version.clone(),
                    prepared.operation.clone(),
                    member.clone(),
                );
                let disk_root = root.clone();
                let reader = inverse_store;
                let (input, reader) = tokio::task::spawn_blocking(move || {
                    let _guards = guards;
                    let inverse = reader.read_with(|c| inverse_input(c, &w, &v, &o, &member));
                    let inverse = match inverse {
                        value @ (Ok(_)
                        | Err(RuntimeError::Domain(DomainError::UndoRefused {
                            reason:
                                "link diff budget exceeded"
                                | "wikilink element unavailable"
                                | "document projection unavailable",
                            ..
                        }))) => value,
                        value if member.settle_error.is_some() => value,
                        Err(error) => return Err(error),
                    };
                    Ok((
                        Prepared {
                            inverse,
                            disk: Ok(disk_check(&disk_root, &member)?),
                        },
                        reader,
                    ))
                })
                .await
                .map_err(|_| RuntimeError::ActorUnavailable)??;
                inverse_store = reader;
                inputs.push_back(input);
            }
            let body = serde_json::to_string(&prepared).map_err(|_| corrupt())?;
            let prepared = Arc::new(prepared);
            let body = Arc::new(body);
            loop {
                let (p, body, f) = (prepared.clone(), body.clone(), faults.clone());
                let outcome = self.run_undo_turn(request.clone(), "persist-plan", None, move |store,_| {
                let existing = store.read_with(|conn| -> Result<_,RuntimeError> {
                    let row: Option<(String,i64)> = conn.query_row("SELECT payload_hash,result_seq FROM engine_requests WHERE request_id=?1",[&p.request],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(StorageError::corrupt_public)?;
                    if let Some((hash,cursor))=row {
                        if hash!=undo_request_fingerprint(conn,&p.workspace,&p.operation,p.author.as_deref())? { return Err(DomainError::IdempotencyKeyReuseMismatch.into()); }
                        return Ok(Some(usize::try_from(cursor).map_err(|_| corrupt())?));
                    }
                    Ok(None)
                })?;
                if let Some(cursor)=existing { return Ok(cursor); }
                let outcome = store.write_background_with(f.as_ref(),|tx| -> Result<(),RuntimeError> {
                    let active = dohc_engine_domain::get_active_version_in(tx, &p.workspace)?.version_id;
                    if active!=p.version { return Err(DomainError::UndoRefused {path:p.operation.clone(),reason:"active version changed"}.into()); }
                    let prior: Option<String> = tx.query_row("SELECT r.kind FROM history_undo_plans p JOIN engine_requests r ON r.request_id=p.request_id WHERE p.workspace_id=?1 AND p.operation_id=?2",params![p.workspace,p.operation],|r|r.get(0)).optional().map_err(StorageError::corrupt_public)?;
                    if let Some(kind) = prior { return Err(DomainError::UndoRefused {path:p.operation.clone(),reason:if kind=="history-undo-complete" {"Operation already undone"} else {"Undo in progress"}}.into()); }
                    tx.execute("INSERT INTO engine_requests(request_id,payload_hash,result_seq,committed_at,kind) VALUES(?1,?2,0,?3,'history-undo-pending')",params![p.request,undo_request_fingerprint(tx,&p.workspace,&p.operation,p.author.as_deref())?,now]).map_err(StorageError::persist_public)?;
                    tx.execute("INSERT INTO history_undo_plans(request_id,workspace_id,version_id,operation_id,author_json,plan_json) VALUES(?1,?2,?3,?4,?5,?6)",params![p.request,p.workspace,p.version,p.operation,p.author,body.as_str()]).map_err(StorageError::persist_public)?;
                    Ok(())
                });
                match outcome? { TxnOutcome::Committed(()) => Ok(0), TxnOutcome::Crashed {..} => Err(RuntimeError::OperationCrashed) }
            }).await;
                match outcome {
                    Ok(_) => {
                        locked_since = None;
                        break;
                    }
                    Err(RuntimeError::Storage(StorageError::FileLocked)) => {
                        Self::wait_undo_checkpoint(&token, &mut locked_since, checkpoint.clone())
                            .await?;
                    }
                    Err(error) => return Err(error),
                }
            }
            let held = self.location();
            tokio::task::spawn_blocking(move || {
                let store = HeldReader::open(held)?;
                let (plan, cursor, _) = store
                    .read_with(|conn| {
                        load(
                            conn,
                            &prepared.workspace,
                            &prepared.operation,
                            &prepared.request,
                            prepared.author.as_deref(),
                        )
                    })?
                    .ok_or_else(corrupt)?;
                Ok::<_, RuntimeError>((Arc::new(plan), cursor))
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)??
        };
        // Completed replays leave any parked file jobs to the placement continuation.
        let mut placement_cursor = if prepared_cursor == plan.members.len() {
            prepared_cursor
        } else {
            0
        };
        'turns: loop {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            for member in plan.members[placement_cursor..prepared_cursor]
                .iter()
                .filter(|m| m.effect.operation == "rename")
            {
                let (p, mut inverse, root, recorder) = (
                    plan.clone(),
                    member.effect.clone(),
                    root.clone(),
                    recorder.clone(),
                );
                inverse.moment_id = dohc_engine_domain::undo_member_moment_id(
                    &undo_correlation_id(&p.workspace, &p.operation, &p.request),
                    &inverse.moment_id,
                );
                inverse.before_path = Some(std::mem::replace(
                    &mut inverse.path,
                    inverse.before_path.take().ok_or_else(corrupt)?,
                ));
                let capture = gates[0].clone().lock_owned().await;
                let sessions = gates[1].clone().lock_owned().await;
                let placed = self.run_undo_turn(request.clone(), "rename-placement", Some(placement_cursor), move |store,_| {
                    let _guards=(capture,sessions);
                    let exists: bool = store.read_with(|conn| conn.query_row("SELECT EXISTS(SELECT 1 FROM moments WHERE workspace_id=?1 AND moment_id=?2)",params![p.workspace,inverse.moment_id],|r|r.get(0))).map_err(StorageError::corrupt_public)?;
                    if exists {
                        // Parked jobs remain available to final placement or Retry held.
                        place_undo_members(store,&p.workspace,&p.version,&[inverse],&root,recorder.as_ref(),&dohc_engine_storage::NoFaults,now)?;
                    }
                    Ok(())
                }).await;
                match placed {
                    Ok(()) => {
                        locked_since = None;
                    }
                    Err(RuntimeError::Storage(StorageError::FileLocked)) => {
                        Self::wait_undo_checkpoint(&token, &mut locked_since, checkpoint.clone())
                            .await?;
                        continue 'turns;
                    }
                    Err(error) => return Err(error),
                }
            }
            placement_cursor = prepared_cursor;
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            if prepared_cursor == plan.members.len() {
                let (p, held) = (plan.clone(), self.location());
                return tokio::task::spawn_blocking(move || {
                    let store = HeldReader::open(held)?;
                    result(&store, &p, deduped)
                })
                .await
                .map_err(|_| RuntimeError::ActorUnavailable)?;
            }
            let end = (prepared_cursor
                + if plan.members[prepared_cursor].effect.operation == "rename" {
                    1
                } else {
                    16
                })
            .min(plan.members.len());
            let count = end - prepared_cursor;
            let cached: Vec<_> = (0..count).map(|_| inputs.pop_front()).collect();
            let disk_root = root.clone();
            let p = plan.clone();
            let (batch, policy, reader) = tokio::task::spawn_blocking(move || {
                let batch = cached
                    .into_iter()
                    .enumerate()
                    .map(|(offset, cached)| {
                        cached.unwrap_or_else(|| {
                            let member = &p.members[prepared_cursor + offset];
                            Prepared {
                                inverse: inverse_store.read_with(|conn| {
                                    inverse_input(
                                        conn,
                                        &p.workspace,
                                        &p.version,
                                        &p.operation,
                                        member,
                                    )
                                }),
                                disk: disk_check(&disk_root, member),
                            }
                        })
                    })
                    .collect::<std::collections::VecDeque<_>>();
                (
                    batch,
                    crate::search::read_engine_search_policy(&disk_root),
                    inverse_store,
                )
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
            inverse_store = reader;
            let _capture = gates[0].clone().lock_owned().await;
            let _sessions = gates[1].clone().lock_owned().await;
            let (p, f) = (plan.clone(), faults.clone());
            let phase = if plan.members[prepared_cursor].effect.operation == "rename" {
                "rename-inverse"
            } else if prepared_cursor + 1 == plan.members.len() {
                "member-inverse+complete-ledger"
            } else {
                "member-inverse"
            };
            let turn_token = token.clone();
            let turn_budget = std::time::Duration::from_millis(5);
            #[cfg(test)]
            let turn_budget = tests::turn_budget(&request).unwrap_or(turn_budget);
            let turn_open = open_documents.clone();
            let next = self.run_undo_turn(request.clone(),phase,Some(prepared_cursor),move |store,cache| {
                let _guards = (_capture,_sessions);
                if turn_token.is_cancelled() { return Err(RuntimeError::Cancelled); }
                with_local_file_mutation_cache_reset(cache, || {
                    let (cursor,complete): (i64,bool) = store.read_with(|conn| conn.query_row("SELECT result_seq,kind='history-undo-complete' FROM engine_requests WHERE request_id=?1",[&p.request],|r| Ok((r.get(0)?,r.get(1)?)))).map_err(StorageError::corrupt_public)?;
                    let mut index = usize::try_from(cursor).map_err(|_| corrupt())?;
                    let mut batch = batch;
                    if complete { return Ok((p.members.len(),false,batch)); }
                    // undo_gate keeps the prepared inputs aligned with the durable cursor.
                    debug_assert_eq!(index, prepared_cursor);
                    let active = VersionedTextStore::new(store).get_active_version(&p.workspace)?.version_id;
                    if active != p.version { return Err(DomainError::InvalidInput {reason:"An Undo is still running. Switch versions when it finishes."}.into()); }
                    let started = std::time::Instant::now();
                    let mut retry_error = None;
                    let mut committed = false;
                    let mut resyncs = Vec::new();
                    match store.write_background_with(f.as_ref(),|tx| -> Result<(),RuntimeError> {
                        while let Some(Prepared { inverse, disk }) = batch.pop_front() {
                            let member = &p.members[index];
                            let cursor = index as i64;
                            let checks = (|| -> Result<(),RuntimeError> {
                                let unchanged = signature(tx,&p.workspace,&p.version,&member.effect.object_id)? == member.head;
                                let target = member.effect.before_path.as_deref().unwrap_or(&member.effect.path);
                                let vacant: bool = member.effect.operation == "write" || tx.query_row("SELECT NOT EXISTS(SELECT 1 FROM path_aliases WHERE workspace_id=?1 AND version_id=?2 AND path=?3)",params![p.workspace,p.version,target],|r|r.get(0)).map_err(StorageError::corrupt_public)?;
                                check_undo_ownership(tx,&p.workspace,&p.version,&p.operation,&member.effect)?;
                                let (probe, source) = disk?;
                                let disk_changed = (member.effect.operation != "write" && probe.stamp(target) != dohc_engine_files::ProjectionTargetStamp::Absent) || source.as_ref().is_some_and(|stamp| probe.stamp(&member.effect.path) != *stamp);
                                if !unchanged || !vacant || disk_changed { return Err(DomainError::UndoRefused {path:member.effect.path.clone(),reason:"source changed"}.into()); }
                                Ok(())
                            })();
                            tx.execute_batch("SAVEPOINT undo_member").map_err(StorageError::persist_public)?;
                            let settle_error = member.settle_error.as_ref().filter(|_| turn_open.as_ref().is_some_and(|(is_open,_)| DocKey::new(&p.workspace,&p.version,&member.effect.object_id).is_ok_and(|key| is_open(&key))));
                            let outcome = checks.and_then(|()| {
                                if settle_error.is_some() {
                                    return Err(DomainError::UndoRefused {path:member.effect.path.clone(),reason:"document settlement failed"}.into());
                                }
                                let objects = serde_json::to_string(&[&member.effect.object_id]).map_err(|_| corrupt())?;
                                crate::search::index::begin_file_search_index_batch(tx,&policy,&p.workspace,&p.version,&objects).map_err(super::super::search::search_domain)?;
                                let mut inverse = inverse?;
                                if let Some(inverse) = inverse.as_mut() {
                                    inverse.live = inverse_live_edit(tx,&p.workspace,&p.version,member,&inverse.text,turn_open.as_ref())?;
                                }
                                let live = inverse.as_ref().and_then(|i| i.live.as_ref());
                                let key = DocKey::new(&p.workspace,&p.version,&member.effect.object_id)?;
                                if let Some(edit) = live {
                                    super::super::link_documents::append(tx,&key,&member.effect.path,edit,p.author.as_deref(),now)?;
                                }
                                undo_member_in_tx(tx,&p.workspace,&p.version,&undo_correlation_id(&p.workspace,&p.operation,&p.request),p.author.as_deref(),now,member.effect.clone(),inverse.as_ref().map(|i| i.text.as_str()),|tx,m| {
                                    if member.effect.operation == "write" {
                                        dohc_engine_storage::cancel_pending_jobs_for_path(tx,&p.workspace,&member.effect.path,now)?;
                                    }
                                    publish_undo_member(tx,&p.workspace,&p.version,&policy,m,now,live.is_some())?;
                                    if live.is_some() {
                                        let sha = tx.query_row("SELECT blob_sha256 FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![p.workspace,p.version,m.object_id],|r|r.get::<_,String>(0)).map_err(StorageError::persist_public)?;
                                        super::super::link_documents::settled(tx,&key,m,&sha,now)?;
                                    }
                                    if member.effect.operation == "write" {
                                        tx.execute("UPDATE materialization_jobs SET preimage_present=?2,preimage_sha256=?3 WHERE job_id=?1",params![binary_rollback_job_identity(&p.workspace,&p.version,&m.moment_id),i64::from(member.sha.is_some()),member.sha]).map_err(StorageError::persist_public)?;
                                    }
                                    Ok(())
                                }).map_err(Into::into)
                            });
                            match outcome {
                                Ok(_) => {
                                    tx.execute_batch("RELEASE undo_member").map_err(StorageError::persist_public)?;
                                    if turn_open.as_ref().is_some_and(|(is_open,_)| DocKey::new(&p.workspace,&p.version,&member.effect.object_id).is_ok_and(|key| is_open(&key))) {
                                        resyncs.push(DocKey::new(&p.workspace,&p.version,&member.effect.object_id)?);
                                    }
                                },
                                Err(error) => {
                                    tx.execute_batch("ROLLBACK TO undo_member; RELEASE undo_member").map_err(StorageError::persist_public)?;
                                    if matches!(&error,RuntimeError::Storage(StorageError::FileLocked)) { return Err(error); }
                                    let refusal = matches!(&error,RuntimeError::Domain(DomainError::UndoRefused {..}) | RuntimeError::Sync(dohc_engine_sync::SyncError::LiveDocumentBindingActive));
                                    if refusal {
                                        tx.execute("UPDATE history_undo_plans SET errors_json=json_set(errors_json,?2,?3) WHERE request_id=?1",params![p.request,format!("$.\"{cursor}\""),settle_error.cloned().unwrap_or_else(|| error.to_string())]).map_err(StorageError::persist_public)?;
                                    }
                                    if !refusal {
                                        tx.execute("UPDATE history_undo_plans SET attempts=attempts+1,last_error=?2 WHERE request_id=?1",params![p.request,error.to_string()]).map_err(StorageError::persist_public)?;
                                        let attempts: i64 = tx.query_row("SELECT attempts FROM history_undo_plans WHERE request_id=?1",[&p.request],|r|r.get(0)).map_err(StorageError::corrupt_public)?;
                                        if attempts<3 { retry_error = Some(error); break; }
                                        tx.execute("UPDATE history_undo_plans SET errors_json=json_set(errors_json,?2,?3) WHERE request_id=?1",params![p.request,format!("$.\"{cursor}\""),settle_error.cloned().unwrap_or_else(|| error.to_string())]).map_err(StorageError::persist_public)?;
                                    }
                                    let path = tx.query_row("SELECT path FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![p.workspace,p.version,member.effect.object_id],|r| r.get::<_,String>(0)).optional().map_err(StorageError::corrupt_public)?.unwrap_or_else(|| member.effect.path.clone());
                                    tx.execute("INSERT INTO engine_requests(request_id,payload_hash,result_seq,committed_at,kind) VALUES(?1,?2,?3,?4,'history-undo-skipped')",params![format!("{}:{cursor}",undo_progress_key(&p.request)),path,cursor,now]).map_err(StorageError::persist_public)?;
                                }
                            }
                            tx.execute("UPDATE history_undo_plans SET attempts=0,last_error=NULL WHERE request_id=?1",[&p.request]).map_err(StorageError::persist_public)?;
                            index += 1;
                            committed = true;
                            tx.execute("UPDATE engine_requests SET result_seq=?2,kind=?3,committed_at=?4 WHERE request_id=?1",params![p.request,index as i64,if index==p.members.len() {"history-undo-complete"} else {"history-undo-pending"},now]).map_err(StorageError::persist_public)?;
                            if turn_token.is_cancelled() || started.elapsed() >= turn_budget { break; }
                        }
                        Ok(())
                    })? { TxnOutcome::Committed(()) => {}, TxnOutcome::Crashed {..} => return Err(RuntimeError::OperationCrashed) };
                    if let Some((_, notify)) = &turn_open {
                        for key in resyncs { notify(&key); }
                    }
                    if let Some(error) = retry_error { return Err(error); }
                    Ok((index,committed,batch))
                })
            }).await;
            match next {
                Ok((cursor, committed, remaining)) => {
                    if committed {
                        for input in remaining.into_iter().rev() {
                            inputs.push_front(input);
                        }
                    } else {
                        inputs.clear();
                    }
                    if committed {
                        deduped = false;
                    }
                    prepared_cursor = cursor;
                    locked_since = None;
                }
                Err(RuntimeError::Storage(StorageError::FileLocked)) => {
                    inputs.clear();
                    Self::wait_undo_checkpoint(&token, &mut locked_since, checkpoint.clone())
                        .await?;
                }
                Err(error) => return Err(error),
            }
            tokio::task::yield_now().await;
        }
    }
}

#[cfg(test)]
#[path = "history_undo_turn_tests.rs"]
pub(in crate::actor) mod tests;
