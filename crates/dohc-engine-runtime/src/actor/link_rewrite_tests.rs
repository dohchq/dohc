use super::super::history_operations::turns::tests as undo_probe;
use super::*;
use dohc_engine_domain::{RenameTextFile, write_text_in_tx};
use dohc_engine_storage::{FaultAction, FaultPoint, NoFaults};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::{
    collections::HashMap,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};

type ReadHook = Arc<dyn Fn(&Connection, &str) + Send + Sync>;
#[derive(Default)]
struct Probe {
    turns: Vec<(&'static str, u128)>,
    hook: Option<ReadHook>,
    committed: Option<Arc<tokio::sync::Notify>>,
}
static PROBES: OnceLock<Mutex<HashMap<String, Probe>>> = OnceLock::new();
fn probes() -> &'static Mutex<HashMap<String, Probe>> {
    PROBES.get_or_init(Mutex::default)
}
pub(super) struct Turn {
    ws: String,
    phase: &'static str,
    start: Instant,
}
impl Turn {
    pub(super) fn start(ws: &str, phase: &'static str) -> Self {
        if phase != "plan" {
            undo_probe::begin_turn(ws);
        }
        Self {
            ws: ws.into(),
            phase,
            start: Instant::now(),
        }
    }
}
impl Drop for Turn {
    fn drop(&mut self) {
        if self.phase != "plan" {
            undo_probe::record_phase(&self.ws, self.phase, None, self.start.elapsed(), true);
        }
        if let Some(probe) = probes().lock().unwrap().get_mut(&self.ws) {
            probe
                .turns
                .push((self.phase, self.start.elapsed().as_nanos()));
            if self.phase == "commit"
                && let Some(committed) = &probe.committed
            {
                committed.notify_one();
            }
        }
    }
}
pub(super) fn after_read(conn: &Connection, ws: &str, object: &str) {
    let hook = probes()
        .lock()
        .unwrap()
        .get(ws)
        .and_then(|p| p.hook.clone());
    if let Some(hook) = hook {
        hook(conn, object);
    }
}
pub(super) fn source() {
    undo_probe::source();
}
struct Fixture {
    actor: ActorHandle,
    supervisor: Arc<crate::WorkspaceSupervisor>,
    root: ScratchDir,
    ws: String,
    leases: LeaseRegistry,
    serial: Arc<tokio::sync::Mutex<()>>,
    capture: Arc<tokio::sync::Mutex<()>>,
}
const OP: &str = "dohc-operation:rename";
const BODY: &str = "[[old#part|label]] [[./old.md]] [old](old.md)\n";
async fn retry_undo<T, F>(ws: &str, mut operation: impl FnMut() -> F) -> Result<T, RuntimeError>
where
    F: std::future::Future<Output = Result<T, RuntimeError>>,
{
    let policy: Value = serde_json::from_str(include_str!(
        "../../../../packages/workspace-engine-client/src/daemon/storeBusyRetry.json"
    ))
    .unwrap();
    let budget = Duration::from_millis(policy["engineStoreBusyRetryMs"].as_u64().unwrap());
    let mut deadline = None;
    let mut backoff = Duration::from_millis(5);
    let mut attempts = Vec::new();
    loop {
        let start = Instant::now();
        let result = operation().await;
        attempts.push(start.elapsed().as_nanos());
        let retries = attempts.len() - 1;
        eprintln!("LINK_UNDO_RETRIES request={ws}-undo retries={retries} attempt_ns={attempts:?}");
        match result {
            Err(error) if error.is_file_locked() => {
                let deadline = *deadline.get_or_insert_with(|| Instant::now() + budget);
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(error);
                }
                tokio::time::sleep(backoff.min(remaining)).await;
                if Instant::now() >= deadline {
                    return Err(error);
                }
                backoff = (backoff * 2).min(Duration::from_millis(200));
            }
            result => return result,
        }
    }
}
fn write(ws: &str, object: &str, path: &str, body: &str, moment: &str) -> WriteText {
    WriteText {
        workspace_id: ws.into(),
        version_id: "main".into(),
        object_id: object.into(),
        path: path.into(),
        text: body.into(),
        moment_id: moment.into(),
        request_id: None,
        metadata_origin: "api".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 1,
    }
}
impl Fixture {
    /// Returns once the link index covers every file the fixture wrote. The
    /// index seeds in the background, and a pass that starts before it
    /// finishes reports the unindexed sources as unchecked.
    async fn new(sources: usize, files: usize) -> Self {
        let f = Self::open(sources, files);
        tokio::time::timeout(Duration::from_secs(120), async {
            // Ticks leave the actor's turns to the seeding worker.
            let mut tick = tokio::time::interval(Duration::from_millis(2));
            loop {
                let ws = f.ws.clone();
                let indexed = f.actor.run(move |store, _| {
                    Ok(store.read_with(|conn| conn.query_row(
                        "SELECT coalesce((SELECT seed_phase='ready' AND parser_generation=?2 FROM link_index_state WHERE workspace_id=?1 AND version_id='main'),0)
                         AND NOT EXISTS(SELECT 1 FROM link_pending WHERE workspace_id=?1)
                         AND NOT EXISTS(SELECT 1 FROM link_sources WHERE workspace_id=?1 AND (status='unindexed' OR parser_generation<>?2))",
                        params![ws, crate::links::PARSER_GENERATION],
                        |r| r.get::<_, bool>(0),
                    )).map_err(StorageError::corrupt_public)?)
                });
                if indexed.await.unwrap() {
                    break;
                }
                tick.tick().await;
            }
        })
        .await
        .expect("the link index did not finish seeding the fixture");
        f
    }
    fn open(sources: usize, files: usize) -> Self {
        let root = ScratchDir::new().unwrap();
        let ws = format!("rewrite-{}", hex_sha256(root.to_string_lossy().as_bytes()));
        let mut store = EngineStore::open(&engine_db_path(&root).unwrap(), 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version(&ws, "main", 1, &NoFaults)
            .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                for i in 0..files {
                    let path = format!("source-{i:04}.md");
                    let body = if i < sources { BODY } else { "no links" };
                    write_text_in_tx(
                        tx,
                        &write(
                            &ws,
                            &format!("source-{i:04}"),
                            &path,
                            body,
                            &format!("seed-{i}"),
                        ),
                    )?;
                    std::fs::write(root.join(&path), body).unwrap();
                }
                write_text_in_tx(
                    tx,
                    &write(&ws, "target", "old.md", "[[old]]", "seed-target"),
                )?;
                Ok::<_, DomainError>(())
            })
            .unwrap();
        std::fs::write(root.join("old.md"), "[[old]]").unwrap();
        VersionedTextStore::new(&mut store)
            .rename_text_file(
                &RenameTextFile {
                    workspace_id: ws.clone(),
                    version_id: "main".into(),
                    from_path: "old.md".into(),
                    to_path: "new.md".into(),
                    moment_id: "rename".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: Some(OP.into()),
                    author_json: None,
                    now_ms: 2,
                },
                &NoFaults,
            )
            .unwrap();
        std::fs::rename(root.join("old.md"), root.join("new.md")).unwrap();
        drop(store);
        let supervisor = Arc::new(crate::WorkspaceSupervisor::new());
        let actor = supervisor
            .open(&engine_db_path(&root).unwrap(), 3)
            .unwrap()
            .actor;
        probes()
            .lock()
            .unwrap()
            .insert(ws.clone(), Probe::default());
        let leases = LeaseRegistry::new().scoped(&root);
        Self {
            actor,
            supervisor,
            root,
            ws,
            leases,
            serial: Arc::default(),
            capture: Arc::default(),
        }
    }
    /// `operation`, retried as a client retries a busy store: each time
    /// write admission refuses it, once the store's background checkpoint,
    /// which admission waited on, has finished again.
    async fn admitted<T, F>(&self, mut operation: impl FnMut() -> F) -> Result<T, RuntimeError>
    where
        F: std::future::Future<Output = Result<T, RuntimeError>>,
    {
        loop {
            let completed = self.actor.checkpoints_completed_for_test().await?;
            match operation().await {
                Err(
                    RuntimeError::Storage(StorageError::FileLocked)
                    | RuntimeError::Domain(DomainError::Storage(StorageError::FileLocked))
                    | RuntimeError::Collab(dohc_engine_collab::CollabError::Storage(
                        StorageError::FileLocked,
                    )),
                ) => {
                    self.actor
                        .wait_for_checkpoint_completion_for_test(completed)
                        .await?;
                }
                result => return result,
            }
        }
    }
    async fn pass(
        &self,
        request: &str,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<Value, RuntimeError> {
        // A pass can still return FileLocked after its one-second checkpoint cap.
        self.admitted(|| {
            self.actor.history_rewrite_links(
                self.ws.clone(),
                OP.into(),
                request.into(),
                None,
                self.root.to_path_buf(),
                self.leases.clone(),
                [self.capture.clone(), self.serial.clone()],
                faults.clone(),
                (
                    {
                        let leases = self.leases.clone();
                        Arc::new(move |key| leases.is_held_by_session(key))
                    },
                    Arc::new(|_| {}),
                ),
                Arc::new(()),
                CancellationToken::new(),
            )
        })
        .await
    }
    async fn text(&self, path: &str) -> String {
        let (ws, path) = (self.ws.clone(), path.to_owned());
        self.actor
            .run(move |store, _| {
                Ok(VersionedTextStore::new(store)
                    .read_text(&ws, "main", &path)?
                    .unwrap()
                    .text)
            })
            .await
            .unwrap()
    }
    async fn edit(&self, object: &str, path: &str, body: &str) {
        let input = write(&self.ws, object, path, body, "later-edit");
        self.actor
            .run(move |store, _| {
                VersionedTextStore::new(store).write_text(&input, &NoFaults)?;
                Ok(())
            })
            .await
            .unwrap();
        std::fs::write(self.root.join(path), body).unwrap();
    }
    async fn undo(
        &self,
    ) -> Result<super::super::history_operations::HistoryUndoResult, RuntimeError> {
        self.actor
            .history_undo_in_turns(
                self.ws.clone(),
                OP.into(),
                format!("{}-undo", self.ws),
                None,
                self.root.to_path_buf(),
                Arc::new(NoFaults),
                10,
                [Arc::default(), self.serial.clone()],
                Arc::new(()),
                None,
                CancellationToken::new(),
            )
            .await
    }
    async fn publish(&self) {
        let _capture = self.capture.clone().lock_owned().await;
        let jobs = self
            .actor
            .history_operation_pending_jobs(self.ws.clone(), OP.into())
            .await
            .unwrap();
        for job in jobs {
            self.actor
                .materialize_replay_selected_for_fence(
                    self.root.to_path_buf(),
                    self.ws.clone(),
                    Arc::new(()),
                    vec![job],
                    9,
                )
                .await
                .unwrap();
        }
    }
    async fn restart(&mut self) {
        let supervisor = self.supervisor.clone();
        tokio::task::spawn_blocking(move || supervisor.close_all())
            .await
            .unwrap()
            .unwrap();
        self.actor = self
            .supervisor
            .open(&engine_db_path(&self.root).unwrap(), 4)
            .unwrap()
            .actor;
    }
    async fn close(self) {
        let supervisor = self.supervisor.clone();
        tokio::task::spawn_blocking(move || supervisor.close_all())
            .await
            .unwrap()
            .unwrap();
        probes().lock().unwrap().remove(&self.ws);
        publication::remove(&self.ws);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn closed_rewrites_skip_open_and_replay_the_bound_payload() {
    let f = Fixture::new(3, 3).await;
    let key = DocKey::new(&f.ws, "main", "source-0002").unwrap();
    let lease = f.leases.acquire(&key).unwrap();
    let result = f.pass("rewrite-request", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(
        result,
        json!({"documents":2,"links":4,"unchecked":["source-0002.md"],"uncheckedCount":1,"complete":false})
    );
    assert_eq!(
        f.text("source-0000.md").await,
        "[[new#part|label]] [[./new.md]] [old](old.md)\n"
    );
    assert_eq!(f.text("new.md").await, "[[old]]", "self link stays");
    drop(lease);
    assert_eq!(
        f.pass("rewrite-request", Arc::new(NoFaults)).await.unwrap(),
        result
    );
    let mismatch = f
        .actor
        .history_rewrite_links(
            f.ws.clone(),
            OP.into(),
            "rewrite-request".into(),
            Some("{\"kind\":\"human\",\"humanId\":\"other\"}".into()),
            f.root.to_path_buf(),
            f.leases.clone(),
            [f.capture.clone(), f.serial.clone()],
            Arc::new(NoFaults),
            (
                {
                    let leases = f.leases.clone();
                    Arc::new(move |key| leases.is_held_by_session(key))
                },
                Arc::new(|_| {}),
            ),
            Arc::new(()),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(
        mismatch,
        Err(RuntimeError::Domain(
            DomainError::IdempotencyKeyReuseMismatch
        ))
    ));
    let retry = f
        .pass("different-request", Arc::new(NoFaults))
        .await
        .unwrap();
    assert_eq!(retry["documents"], 1);
    let operation = f
        .actor
        .history_operation(f.ws.clone(), OP.into())
        .await
        .unwrap();
    assert_eq!(operation.moments.len(), 4);
    f.close().await;
}

#[tokio::test]
async fn a_passive_handle_cannot_originate_link_rewrites() {
    let root = ScratchDir::new().unwrap();
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor
        .open_passive_root_bound(&engine_db_path(&root).unwrap(), 1, "passive-root", None)
        .unwrap()
        .actor;
    let result = actor
        .history_rewrite_links(
            "passive".into(),
            OP.into(),
            "refused".into(),
            None,
            root.to_path_buf(),
            LeaseRegistry::new().scoped(&root),
            [Arc::default(), Arc::default()],
            Arc::new(NoFaults),
            (Arc::new(|_| false), Arc::new(|_| {})),
            Arc::new(()),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(
        result,
        Err(RuntimeError::Domain(DomainError::InvalidInput {
            reason: "link rewrites need the owner"
        }))
    ));
    supervisor.close_all().unwrap();
}

async fn seed_middle_lineage(f: &Fixture, body: &str) {
    f.edit("source-0001", "source-0001.md", body).await;
    let ws = f.ws.clone();
    let body = body.to_owned();
    f.actor
        .run(move |store, cache| {
            let key = DocKey::new(&ws, "main", "source-0001")?;
            let snapshot = VersionedTextStore::new(store)
                .read_text(&ws, "main", "source-0001.md")?
                .unwrap();
            let doc = dohc_engine_collab::Ydoc::wire();
            doc.rewrite_content_to_markdown_preserving_source(
                dohc_engine_collab::ContentKind::Richdoc,
                &body,
            )?;
            dohc_engine_collab::record_local_update(
                store,
                cache,
                &key,
                &doc.encode_full_state(),
                dohc_engine_collab::LocalAppend {
                    marker: Some(dohc_engine_collab::MarkerCreation {
                        path: Some("source-0001.md"),
                        content_kind: dohc_engine_collab::ContentKind::Richdoc,
                        regime: dohc_engine_collab::Regime::LocalOnly,
                    }),
                    seed_source_sha256: Some(&snapshot.blob_sha256),
                    ..Default::default()
                },
                &NoFaults,
                4,
                |_tx, _outcome, _sha| Ok(()),
            )?;
            Ok(())
        })
        .await
        .unwrap();
}

async fn middle_source_state(f: &Fixture) -> (Vec<u8>, i64, i64, i64) {
    let ws = f.ws.clone();
    f.actor
        .run(move |store, _| {
            store.read_with(|conn| {
                let key = DocKey::new(&ws, "main", "source-0001")?;
                let state = dohc_engine_collab::load_doc_in(conn, &key)?.encode_full_state();
                let (moments, jobs, files, holds): (i64, i64, i64, i64) = conn.query_row(
                    "SELECT \
                     (SELECT count(*) FROM moments WHERE workspace_id=?1 AND object_id='source-0001'), \
                     (SELECT count(*) FROM materialization_jobs WHERE workspace_id=?1 AND target_path='source-0001.md'), \
                     (SELECT count(*) FROM snapshots WHERE workspace_id=?1 AND version_id='main' AND object_id='source-0001'), \
                     (SELECT count(*) FROM capture_file_holds WHERE workspace_id=?1 AND path='source-0001.md')",
                    [&ws],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                ).map_err(StorageError::corrupt_public)?;
                assert_eq!(holds, 0);
                Ok::<_, RuntimeError>((state, moments, jobs, files))
            })
        })
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unrepresentable_closed_source_does_not_stop_the_link_pass() {
    let f = Fixture::new(3, 3).await;
    let body = "- parent [[old]]\n  - child\n";
    seed_middle_lineage(&f, body).await;
    let before = middle_source_state(&f).await;
    let result = f.pass("unrepresentable", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(
        result,
        json!({"documents":2,"links":4,"unchecked":["source-0001.md"],"uncheckedCount":1,"complete":false})
    );
    for path in ["source-0000.md", "source-0002.md"] {
        assert_eq!(
            f.text(path).await,
            "[[new#part|label]] [[./new.md]] [old](old.md)\n"
        );
    }
    assert_eq!(f.text("source-0001.md").await, body);
    assert_eq!(middle_source_state(&f).await, before);
    assert_eq!(
        f.pass("unrepresentable", Arc::new(NoFaults)).await.unwrap(),
        result
    );
    assert_eq!(
        f.pass("unrepresentable-retry", Arc::new(NoFaults))
            .await
            .unwrap(),
        json!({"documents":0,"links":0,"unchecked":["source-0001.md"],"uncheckedCount":1,"complete":false})
    );
    assert_eq!(middle_source_state(&f).await, before);
    let operation = f
        .actor
        .history_operation(f.ws.clone(), OP.into())
        .await
        .unwrap();
    assert_eq!(operation.moments.len(), 3);
    assert!(
        operation
            .moments
            .iter()
            .all(|moment| moment.object_id != "source-0001")
    );
    f.publish().await;
    let undone = f.undo().await.unwrap();
    assert_eq!(undone.moments.len(), 3);
    assert!(
        undone
            .moments
            .iter()
            .all(|moment| moment.object_id != "source-0001")
    );
    let placed = f
        .actor
        .history_undo_place(
            f.ws.clone(),
            undone,
            f.root.to_path_buf(),
            Arc::new(()),
            11,
            |_| {},
        )
        .await;
    assert!(placed.materialized);
    for path in ["source-0000.md", "source-0002.md"] {
        assert_eq!(f.text(path).await, BODY);
        assert_eq!(std::fs::read_to_string(f.root.join(path)).unwrap(), BODY);
    }
    assert_eq!(f.text("source-0001.md").await, body);
    assert_eq!(
        std::fs::read_to_string(f.root.join("source-0001.md")).unwrap(),
        body
    );
    assert_eq!(middle_source_state(&f).await, before);
    let ws = f.ws.clone();
    f.actor
        .run(move |store, _| {
            store.read_with(|conn| {
                let plan: String = conn
                    .query_row(
                        "SELECT plan_json FROM history_undo_plans WHERE workspace_id=?1",
                        [ws],
                        |row| row.get(0),
                    )
                    .map_err(StorageError::corrupt_public)?;
                let plan: Value = serde_json::from_str(&plan).unwrap();
                assert_eq!(plan["members"].as_array().unwrap().len(), 3);
                assert!(
                    plan["members"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|member| member["effect"]["objectId"] != "source-0001")
                );
                Ok::<_, RuntimeError>(())
            })
        })
        .await
        .unwrap();
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn history_excluded_sources_and_received_mounts_are_never_written() {
    let f = Fixture::new(1, 1).await;
    std::fs::write(
        f.root.join(".dohc/files.toml"),
        "version = 1\n[[rule]]\npath = \"source-0000.md\"\ntracked = false\n",
    )
    .unwrap();
    let result = f.pass("excluded", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(result["unchecked"], json!(["source-0000.md"]));
    assert_eq!(f.text("source-0000.md").await, BODY);
    let ws = f.ws.clone();
    let refused = f
        .actor
        .run(move |store, _| {
            store.read_with(|conn| {
                super::super::history_operations::check_path_ownership(
                    conn,
                    &ws,
                    "main",
                    "source-0000",
                    "shared-with-me/note.md",
                )
            })
        })
        .await;
    assert!(matches!(
        refused,
        Err(RuntimeError::Domain(DomainError::UndoRefused {
            reason: "received share path",
            ..
        }))
    ));
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_target_edit_refuses_the_whole_undo_without_changes() {
    let f = Fixture::new(1, 1).await;
    f.pass("rewrite", Arc::new(NoFaults)).await.unwrap();
    f.edit(
        "source-0000",
        "source-0000.md",
        "[[different#part|label]] [[./new.md]]",
    )
    .await;
    let error = f.undo().await.unwrap_err();
    assert!(
        matches!(error, RuntimeError::Domain(DomainError::UndoRefused { path, reason: "link changed after rename" }) if path=="source-0000.md")
    );
    assert_eq!(f.text("new.md").await, "[[old]]");
    f.close().await;
}

struct CrashNth {
    point: FaultPoint,
    nth: usize,
    seen: AtomicUsize,
}
struct CrashAfterDocuments {
    store: Mutex<EngineStore>,
    request: String,
    documents: i64,
    done: bool,
    point: FaultPoint,
}
impl FaultInjector for CrashAfterDocuments {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point != self.point {
            return FaultAction::Continue;
        }
        // A retried pass reserves its receipt again. Before-persist faults
        // must wait for a source transaction, even if progress is already saved.
        if point == FaultPoint::StorageBeforePersist && undo_probe::sources_in_turn() == 0 {
            return FaultAction::Continue;
        }
        let progress: Option<(bool, i64)> = self.store.lock().unwrap().read_with(|conn| {
            conn.query_row(
                "SELECT json_extract(payload_hash,'$[1]'),json_extract(payload_hash,'$[2].documents') FROM engine_requests WHERE request_id=?1 AND kind='history-link-rewrites'",
                [&self.request],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional()
        }).unwrap();
        if progress == Some((self.done, self.documents)) {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}
impl FaultInjector for CrashNth {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == self.point && self.seen.fetch_add(1, Ordering::SeqCst) + 1 == self.nth {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn crashes_keep_the_write_and_request_progress_atomic_and_resume_once() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let mut f = Fixture::new(3, 3).await;
        let faults = Arc::new(CrashAfterDocuments {
            store: Mutex::new(
                EngineStore::open_read_only(&engine_db_path(&f.root).unwrap()).unwrap(),
            ),
            request: "crash-rewrite".into(),
            done: false,
            documents: if point == FaultPoint::StorageBeforePersist {
                1
            } else {
                2
            },
            point,
        });
        let result = f.pass("crash-rewrite", faults).await;
        assert!(
            matches!(result, Err(RuntimeError::OperationCrashed)),
            "{result:?}"
        );
        f.restart().await;
        assert_eq!(
            f.actor
                .history_operation(f.ws.clone(), OP.into())
                .await
                .unwrap()
                .moments
                .len(),
            if point == FaultPoint::StorageBeforePersist {
                2
            } else {
                3
            },
            "the second source and its receipt share the crash boundary"
        );
        let result = f.pass("crash-rewrite", Arc::new(NoFaults)).await.unwrap();
        assert_eq!(result["documents"], 3);
        assert_eq!(result["links"], 6);
        assert_eq!(
            f.pass("crash-rewrite", Arc::new(NoFaults)).await.unwrap(),
            result
        );
        assert_eq!(
            f.actor
                .history_operation(f.ws.clone(), OP.into())
                .await
                .unwrap()
                .moments
                .len(),
            4
        );
        f.close().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn pending_rewrites_cancel_in_the_inverse_transaction_and_external_edits_still_refuse() {
    for external in [false, true] {
        let f = Fixture::new(2, 2).await;
        let _capture = f.capture.clone().lock_owned().await;
        f.pass("pending", Arc::new(NoFaults)).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(f.root.join("source-0000.md")).unwrap(),
            BODY
        );
        assert_eq!(
            f.actor
                .history_operation_pending_jobs(f.ws.clone(), OP.into())
                .await
                .unwrap()
                .len(),
            2
        );
        if external {
            std::fs::write(f.root.join("source-0000.md"), "external edit").unwrap();
            assert!(
                matches!(f.undo().await, Err(RuntimeError::Domain(DomainError::UndoRefused {
                reason: "source changed on disk", path
            })) if path=="source-0000.md")
            );
            assert_eq!(
                std::fs::read_to_string(f.root.join("source-0000.md")).unwrap(),
                "external edit"
            );
            assert!(f.root.join("new.md").is_file());
        } else {
            let undone = f.undo().await.unwrap();
            assert_eq!(undone.moments.len(), 3);
            assert!(undone.not_restored.is_empty());
            f.actor.run(|store,_| {
                let statuses: Vec<String> = store.read_with(|conn| {
                    let mut stmt=conn.prepare("SELECT status FROM materialization_jobs WHERE job_id LIKE 'authored-mat_link-rewrite-%'").unwrap();
                    stmt.query_map([],|r|r.get(0)).unwrap().collect::<Result<_,_>>()
                }).map_err(StorageError::corrupt_public)?;
                assert_eq!(statuses, vec!["cancelled";2], "forward bytes must never be published");
                Ok(())
            }).await.unwrap();
            let placed = f
                .actor
                .history_undo_place(
                    f.ws.clone(),
                    undone,
                    f.root.to_path_buf(),
                    Arc::new(()),
                    11,
                    |_| {},
                )
                .await;
            assert!(placed.materialized);
            assert_eq!(
                std::fs::read_to_string(f.root.join("source-0000.md")).unwrap(),
                BODY
            );
        }
        f.close().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn exhausted_diff_skips_only_that_member_and_records_the_refusal() {
    let f = Fixture::new(1, 1).await;
    let original = format!(
        "{}{}{}",
        "a".repeat(8192),
        BODY.trim_end(),
        "b".repeat(8192)
    );
    let (ws, body) = (f.ws.clone(), original.clone());
    f.actor
        .run(move |store, _| {
            store.write_with(&NoFaults, |tx| {
                write_text_in_tx(
                    tx,
                    &write(&ws, "source-0000", "source-0000.md", &body, "large-seed"),
                )
            })?;
            Ok(())
        })
        .await
        .unwrap();
    std::fs::write(f.root.join("source-0000.md"), &original).unwrap();
    f.pass("budget-forward", Arc::new(NoFaults)).await.unwrap();
    f.publish().await;
    let rewritten = f.text("source-0000.md").await;
    let head = rewritten
        .replace(&"a".repeat(8192), &"c".repeat(8192))
        .replace(&"b".repeat(8192), &"d".repeat(8192));
    f.edit("source-0000", "source-0000.md", &head).await;
    let result = f.undo().await.unwrap();
    assert_eq!(result.not_restored, vec!["source-0000.md"]);
    assert_eq!(result.moments.len(), 1, "the target rename still restores");
    assert_eq!(f.text("source-0000.md").await, head);
    assert_eq!(
        f.undo().await.unwrap().not_restored,
        result.not_restored,
        "replay keeps the durable refusal"
    );
    f.close().await;
}

#[path = "link_rewrite_open_tests.rs"]
mod open_documents;

#[path = "link_publication_tests.rs"]
pub(super) mod publication;
