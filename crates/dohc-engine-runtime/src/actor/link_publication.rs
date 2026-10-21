//! Publish committed link rewrites without holding the actor for the whole pass.
use super::super::materialization::{MaterializationReplayScope, replay_pending_materializations};
use super::*;

pub(super) struct Publication {
    pub workspace: String,
    pub operation: String,
    pub root: PathBuf,
    pub gates: [Arc<tokio::sync::Mutex<()>>; 2],
    pub recorder: Arc<dyn super::super::materialization::SelfWriteRecorder>,
}

impl ActorHandle {
    pub(super) fn publish_link_rewrites(&self, publication: Arc<Publication>) {
        let key = (publication.workspace.clone(), publication.operation.clone());
        if !self
            .link_rewrites
            .publishers
            .lock()
            .unwrap()
            .insert(key.clone())
        {
            return;
        }
        let actor = self.clone();
        tokio::spawn(async move {
            let mut cursor = 0;
            let mut backoff = Duration::from_millis(25);
            while actor.lifecycle() == super::super::LifecycleState::Ready {
                // Close may hold a gate while it drains the actor.
                let gates = tokio::time::timeout(Duration::from_secs(1), async {
                    let capture = publication.gates[0].clone().lock_owned().await;
                    let sessions = publication.gates[1].clone().lock_owned().await;
                    (capture, sessions)
                })
                .await;
                let Ok(gates) = gates else { continue };
                let p = publication.clone();
                let state = actor.link_rewrites.clone();
                let turn_key = key.clone();
                let outcome = actor.run(move |store, _| {
                    let _gates = gates;
                    #[cfg(test)]
                    let mut turn = tests::publication::Turn::start(&p.workspace);
                    let stopped = store.read_with(|conn| conn.query_row(
                            "SELECT EXISTS(SELECT 1 FROM history_undo_plans WHERE workspace_id=?1 AND operation_id=?2)",
                            params![p.workspace, p.operation], |r| r.get::<_, bool>(0))
                            .map_err(StorageError::corrupt_public))?;
                    if !stopped && state.stops.lock().unwrap().contains_key(&p.operation) {
                        return Ok(Some((0, false)));
                    }
                    let version = VersionedTextStore::new(store).get_active_version(&p.workspace)?.version_id;
                    let job: Option<(i64, String)> = if stopped { None } else {
                        store.read_with(|conn| {
                            let mut stmt = conn.prepare_cached(
                            "SELECT m.moment_order,j.job_id FROM moments m JOIN materialization_jobs j
                             ON j.job_id IN ('authored-mat_'||m.moment_id,'ydoc-mat_'||m.moment_id)
                             WHERE m.workspace_id=?1 AND m.metadata_correlation_id=?2 AND m.version_id=?3
                             AND m.operation='write' AND m.moment_order>?4 AND j.workspace_id=?1 AND j.status='pending'
                             AND j.job_id NOT IN (SELECT value FROM json_each(?5))
                             ORDER BY m.moment_order LIMIT 1").map_err(StorageError::corrupt_public)?;
                            stmt.query_row(params![p.workspace,p.operation,version,cursor,
                                serde_json::to_string(&*state.deferred_placements.lock().unwrap()).unwrap()],
                                |r| Ok((r.get(0)?,r.get(1)?)))
                            .optional().map_err(StorageError::corrupt_public)
                        })?
                    };
                    let Some((order, id)) = job else {
                        if !stopped && cursor != 0 { return Ok(Some((0, false))); }
                        // Remove admission in this actor turn, before another commit can land.
                        state.publishers.lock().unwrap().remove(&turn_key);
                        return Ok(None);
                    };
                    #[cfg(test)]
                    { turn.jobs = 1; turn.ready(); }
                    #[cfg(not(test))]
                    let faults: Arc<dyn FaultInjector> = Arc::new(dohc_engine_storage::NoFaults);
                    #[cfg(test)]
                    let faults = tests::publication::faults(&p.workspace);
                    let selected: HashSet<String> = store.read_with(|conn| {
                        let mut stmt = conn.prepare(
                            "SELECT j.job_id FROM moments m JOIN materialization_jobs j
                             ON j.job_id IN ('authored-mat_'||m.moment_id,'ydoc-mat_'||m.moment_id)
                             WHERE m.workspace_id=?1 AND m.metadata_correlation_id=?2 AND m.version_id=?3
                             AND m.operation='write' AND j.workspace_id=?1 AND j.status='pending'
                             ORDER BY m.moment_order LIMIT 2000"
                        ).map_err(StorageError::corrupt_public)?;
                        stmt.query_map(params![p.workspace,p.operation,version], |r| r.get(0))
                            .map_err(StorageError::corrupt_public)?.collect::<Result<HashSet<_>,_>>()
                            .map_err(StorageError::corrupt_public)
                    })?;
                    #[cfg(test)]
                    { turn.jobs = selected.len(); }
                    let summary = store.with_materialization_status_batch(|store| {
                        replay_pending_materializations(
                            store, &p.root,
                            MaterializationReplayScope {
                                holds: None, workspace_id: &p.workspace,
                                self_writes: Some(p.recorder.as_ref()), progress: None,
                                file_outcomes_settled: false, released_hold_paths: None,
                                planned_against_active_heads: false,
                            },
                            crate::links::now_ms(), faults.as_ref(), Some(&selected), false,
                        )
                    })?;
                    state.deferred_placements.lock().unwrap().extend(summary.deferred);
                    let completed = store.load_materialization_job(&id)?
                        .is_none_or(|job| job.status != dohc_engine_storage::JobStatus::Pending);
                    Ok(Some((order, completed)))
                }).await;
                match outcome {
                    Ok(None) => return,
                    Ok(Some((next, completed))) => {
                        cursor = next;
                        if completed {
                            backoff = Duration::from_millis(25);
                        } else if next == 0 {
                            tokio::time::sleep(backoff).await;
                            backoff = (backoff * 2).min(Duration::from_secs(1));
                        }
                    }
                    Err(_) if actor.lifecycle() != super::super::LifecycleState::Ready => break,
                    Err(error) => {
                        eprintln!("engine: link rewrites committed; placement will retry: {error}");
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(Duration::from_secs(1));
                    }
                }
                tokio::task::yield_now().await;
            }
            actor.link_rewrites.publishers.lock().unwrap().remove(&key);
        });
    }
}
