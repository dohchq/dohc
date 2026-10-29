//! Publish committed link rewrites without holding the actor for the whole pass.
use super::super::materialization::replay_publication_materializations;
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
            let mut cursor_version = String::new();
            let mut retry = false;
            let mut hard_retry = false;
            let mut backoff = Duration::from_millis(25);
            let holds = Arc::new(Mutex::new(None::<(u64, dohc_engine_files::PlacementHolds)>));
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
                let holds = holds.clone();
                let prior_version = cursor_version.clone();
                let outcome = actor.run(move |store, _| {
                    let _gates = gates;
                    #[cfg(test)]
                    let mut turn = tests::publication::Turn::start(&p.workspace);
                    let stopped = store.read_with(|conn| conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM history_undo_plans WHERE workspace_id=?1 AND operation_id=?2)",
                        params![p.workspace, p.operation], |r| r.get::<_, bool>(0))
                        .map_err(StorageError::corrupt_public))?;
                    if !stopped && state.stops.lock().unwrap().contains_key(&p.operation) {
                        return Ok(Some((0, false, prior_version, false)));
                    }
                    let version = VersionedTextStore::new(store).get_active_version(&p.workspace)?.version_id;
                    let after = if version == prior_version { cursor } else { 0 };
                    let job: Option<(i64, String)> = if stopped { None } else {
                        store.read_with(|conn| {
                            let mut stmt = conn.prepare_cached(
                                "SELECT m.moment_order,j.job_id FROM moments m JOIN materialization_jobs j
                                 ON j.job_id IN ('authored-mat_'||m.moment_id,'ydoc-mat_'||m.moment_id)
                                 WHERE m.workspace_id=?1 AND m.metadata_correlation_id=?2 AND m.version_id=?3
                                 AND m.operation='write' AND m.moment_order>?4 AND j.workspace_id=?1 AND j.status='pending'
                                 ORDER BY m.moment_order LIMIT 1").map_err(StorageError::corrupt_public)?;
                            stmt.query_row(params![p.workspace,p.operation,version,after],
                                |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(StorageError::corrupt_public)
                        })?
                    };
                    let Some((order, id)) = job else {
                        if !stopped && after != 0 && retry { return Ok(Some((0, false, version, false))); }
                        state.publishers.lock().unwrap().remove(&turn_key);
                        return Ok(None);
                    };
                    if state.deferred_placements.lock().unwrap().contains(&id) {
                        return Ok(Some((order, true, version, false)));
                    }
                    #[cfg(test)]
                    { turn.jobs = 1; turn.ready(); }
                    #[cfg(not(test))]
                    let faults: Arc<dyn FaultInjector> = Arc::new(dohc_engine_storage::NoFaults);
                    #[cfg(test)]
                    let faults = tests::publication::faults(&p.workspace);
                    // Reuse blockers until capture changes a hold. Unrelated
                    // actor writes must not reload the workspace snapshot.
                    let changes = store.read_with(dohc_engine_storage::capture_file_holds::generation_in).map_err(StorageError::corrupt_public)?;
                    let mut cached = holds.lock().unwrap();
                    if cached.as_ref().is_none_or(|(before, _)| *before != changes) {
                        *cached = Some((changes, dohc_engine_files::PlacementHolds::from_holds(&p.workspace, &store.read_with(|conn| dohc_engine_storage::capture_file_holds::list_in(conn, &p.workspace))?)));
                    }
                    let selected = HashSet::from([id.clone()]);
                    let summary = replay_publication_materializations(
                        store, &p.root, &p.workspace, &cached.as_ref().unwrap().1,
                        p.recorder.as_ref(), crate::links::now_ms(), faults.as_ref(), &selected,
                    )?;
                    let hard_error = !summary.hard_errors.is_empty();
                    for (job, error) in summary.hard_errors {
                        let mut failures = state.placement_failures.lock().unwrap();
                        let attempts = failures.entry(job.clone()).or_default();
                        *attempts += 1;
                        if *attempts >= 3 && state.deferred_placements.lock().unwrap().insert(job) {
                            eprintln!("engine: placement deferred until next open after {attempts} attempts: {error}");
                        }
                    }
                    let completed = store.load_materialization_job(&id)?
                        .is_none_or(|job| job.status != dohc_engine_storage::JobStatus::Pending);
                    if completed { state.placement_failures.lock().unwrap().remove(&id); }
                    let done = completed || state.deferred_placements.lock().unwrap().contains(&id);
                    Ok(Some((order, done, version, hard_error)))
                }).await;
                match outcome {
                    Ok(None) => return,
                    Ok(Some((next, completed, version, hard_error))) => {
                        cursor = next;
                        cursor_version = version;
                        if next == 0 {
                            retry = false;
                            // Hard errors may be transient OS obstructions. Wait between
                            // passes, outside both gates, while other jobs can finish first.
                            let delay = if hard_retry {
                                Duration::from_secs(1)
                            } else {
                                backoff
                            };
                            hard_retry = false;
                            tokio::time::sleep(delay).await;
                            backoff = (backoff * 2).min(Duration::from_secs(1));
                        } else if completed {
                            backoff = Duration::from_millis(25);
                        } else {
                            retry = true;
                            hard_retry |= hard_error;
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
