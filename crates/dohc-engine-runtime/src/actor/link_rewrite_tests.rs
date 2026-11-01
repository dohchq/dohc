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
const BODY: &str = "[[old#part|label]] [[./old.md]] [old](old.md)";
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
    fn new(sources: usize, files: usize) -> Self {
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
    async fn undo_with_busy_retry(
        &self,
    ) -> Result<super::super::history_operations::HistoryUndoResult, RuntimeError> {
        retry_undo(&self.ws, || self.undo()).await
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
    let f = Fixture::new(3, 3);
    let key = DocKey::new(&f.ws, "main", "source-0002").unwrap();
    let lease = f.leases.acquire(&key).unwrap();
    let result = f.pass("rewrite-request", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(
        result,
        json!({"documents":2,"links":4,"unchecked":["source-0002.md"],"uncheckedCount":1,"complete":false})
    );
    assert_eq!(
        f.text("source-0000.md").await,
        "[[new#part|label]] [[./new.md]] [old](old.md)"
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

#[tokio::test(flavor = "multi_thread")]
async fn a_session_opened_after_read_is_unchecked_and_never_written() {
    let f = Fixture::new(1, 1);
    let leases = f.leases.clone();
    let key = DocKey::new(&f.ws, "main", "source-0000").unwrap();
    let held = Arc::new(Mutex::new(None));
    let owned = held.clone();
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = Some(Arc::new(move |_, object| {
        if object == "source-0000" {
            *owned.lock().unwrap() = Some(leases.acquire(&key).unwrap());
        }
    }));
    let result = f.pass("new-session", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(result["uncheckedCount"], 1);
    assert_eq!(f.text("source-0000.md").await, BODY);
    drop(held.lock().unwrap().take());
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_alias_change_during_parse_stops_the_remaining_sources() {
    let f = Fixture::new(3, 3);
    let ws = f.ws.clone();
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = Some(Arc::new(move |conn, object| {
        if object == "source-0000" {
            conn.execute("INSERT INTO path_aliases(workspace_id,version_id,object_id,path) VALUES(?1,'main','source-0001','old.md')", [&ws]).unwrap();
        }
    }));
    let result = f.pass("alias-change", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(result["documents"], 0);
    assert_eq!(result["uncheckedCount"], 3);
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = None;
    let ws = f.ws.clone();
    f.actor
        .run(move |store, _| {
            store.write_with(&NoFaults, |tx| {
                tx.execute(
                    "DELETE FROM path_aliases WHERE workspace_id=?1 AND path='old.md'",
                    [ws],
                )
                .map_err(StorageError::persist_public)?;
                Ok::<_, RuntimeError>(())
            })?;
            Ok(())
        })
        .await
        .unwrap();
    let resumed = f.pass("alias-change", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(resumed["documents"], 3);
    assert_eq!(resumed["complete"], true);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn disk_mismatch_is_unchecked_and_the_reply_is_bounded() {
    let f = Fixture::new(55, 55);
    for i in 0..55 {
        std::fs::write(f.root.join(format!("source-{i:04}.md")), "external edit").unwrap();
    }
    let result = f.pass("disk-mismatch", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(result["documents"], 0);
    assert_eq!(result["uncheckedCount"], 55);
    assert_eq!(result["unchecked"].as_array().unwrap().len(), 50);
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

#[tokio::test(flavor = "multi_thread")]
async fn a_capture_hold_acquired_during_parse_makes_the_source_unchecked() {
    let f = Fixture::new(1, 1);
    let ws = f.ws.clone();
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = Some(Arc::new(move |conn, object| {
        conn.execute("INSERT INTO capture_file_holds(workspace_id,source_version_id,object_id,path,observed_sha256,observed_size,reason,observed_at_ms,attempt_count,retry_requested)
            VALUES(?1,'main',?2,'source-0000.md',?3,1,'ydoc-resolution-not-representable',1,1,0)",
            params![ws,object,hex_sha256(BODY.as_bytes())]).unwrap();
    }));
    let result = f.pass("held-source", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(result["documents"], 0);
    assert_eq!(result["unchecked"], json!(["source-0000.md"]));
    assert_eq!(f.text("source-0000.md").await, BODY);
    f.close().await;
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
    let f = Fixture::new(3, 3);
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
            "[[new#part|label]] [[./new.md]] [old](old.md)"
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
async fn an_unrelated_invalid_ydoc_input_still_stops_the_link_pass() {
    use yrs::{Map, ReadTxn, StateVector, Transact, updates::decoder::Decode};

    let f = Fixture::new(3, 3);
    seed_middle_lineage(&f, BODY).await;
    let ws = f.ws.clone();
    f.actor
        .run(move |store, _| {
            let key = DocKey::new(&ws, "main", "source-0001")?;
            let original = store.read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))?;
            let doc = yrs::Doc::new();
            doc.transact_mut()
                .apply_update(yrs::Update::decode_v1(&original.encode_full_state()).unwrap())
                .unwrap();
            doc.get_or_insert_map(dohc_engine_collab::ROOT_META)
                .insert(&mut doc.transact_mut(), "schemaVersion", 2);
            let bytes = doc.transact().encode_state_as_update_v1(&StateVector::default());
            // Simulate a stored document whose schema this engine cannot rewrite.
            store.write_with(&NoFaults, |tx| {
                let sha = dohc_engine_storage::put_binary_blob(tx, &bytes)?;
                tx.execute(
                    "UPDATE ydoc_updates SET update_blob_sha256=?2 WHERE workspace_id=?1 AND object_id='source-0001'",
                    params![ws, sha],
                ).map_err(StorageError::persist_public)?;
                Ok::<_, RuntimeError>(())
            })?;
            Ok(())
        })
        .await
        .unwrap();
    let result = f.pass("invalid-projection", Arc::new(NoFaults)).await;
    assert!(
        matches!(
            result,
            Err(RuntimeError::Sync(
                dohc_engine_sync::SyncError::InvalidInput {
                    reason: "Markdown conflict resolution fold failed"
                }
            ))
        ),
        "{result:?}"
    );
    assert_ne!(f.text("source-0000.md").await, BODY);
    assert_eq!(f.text("source-0001.md").await, BODY);
    assert_eq!(f.text("source-0002.md").await, BODY);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn inverse_keeps_later_typing_label_edits_and_new_matching_links() {
    let f = Fixture::new(1, 1);
    f.pass("rewrite", Arc::new(NoFaults)).await.unwrap();
    f.edit(
        "source-0000",
        "source-0000.md",
        &format!(
            "typing [[new#part|changed label]] [[./new.md]] [old](old.md) [[new]]\n\n{}",
            "Long paragraph. ".repeat(3000)
        ),
    )
    .await;
    let result = f.undo_with_busy_retry().await.unwrap();
    assert_eq!(result.moments.len(), 2);
    assert_eq!(
        f.text("source-0000.md").await,
        format!(
            "typing [[old#part|changed label]] [[./old.md]] [old](old.md) [[new]]\n\n{}",
            "Long paragraph. ".repeat(3000)
        )
    );
    let ws = f.ws.clone();
    f.actor
        .run(move |store, _| {
            store.read_with(|conn| {
                let plan: String = conn
                    .query_row(
                        "SELECT plan_json FROM history_undo_plans WHERE workspace_id=?1",
                        [ws],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert!(!plan.contains("Long paragraph"));
                assert!(!plan.contains("\"inverse\""));
                Ok::<_, RuntimeError>(())
            })?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(f.undo().await.unwrap().deduped);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn history_excluded_sources_and_received_mounts_are_never_written() {
    let f = Fixture::new(1, 1);
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
    let f = Fixture::new(1, 1);
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
async fn moved_sources_undo_at_the_current_path_and_removed_sources_refuse() {
    for removed in [false, true] {
        let f = Fixture::new(1, 1);
        f.pass("rewrite", Arc::new(NoFaults)).await.unwrap();
        f.publish().await;
        let ws = f.ws.clone();
        f.actor
            .run(move |store, _| {
                if removed {
                    VersionedTextStore::new(store).delete_text_file(
                        &dohc_engine_domain::DeleteTextFile {
                            workspace_id: ws,
                            version_id: "main".into(),
                            path: "source-0000.md".into(),
                            moment_id: "source-delete".into(),
                            request_id: None,
                            metadata_origin: "api".into(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: 4,
                        },
                        &NoFaults,
                    )?;
                } else {
                    VersionedTextStore::new(store).rename_text_file(
                        &RenameTextFile {
                            workspace_id: ws,
                            version_id: "main".into(),
                            from_path: "source-0000.md".into(),
                            to_path: "moved-source.md".into(),
                            moment_id: "source-move".into(),
                            request_id: None,
                            metadata_origin: "api".into(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: 4,
                        },
                        &NoFaults,
                    )?;
                }
                Ok(())
            })
            .await
            .unwrap();
        if removed {
            std::fs::remove_file(f.root.join("source-0000.md")).unwrap();
            assert!(matches!(
                f.undo().await,
                Err(RuntimeError::Domain(DomainError::UndoRefused {
                    reason: "linking document removed",
                    ..
                }))
            ));
            assert_eq!(f.text("new.md").await, "[[old]]");
        } else {
            std::fs::rename(
                f.root.join("source-0000.md"),
                f.root.join("moved-source.md"),
            )
            .unwrap();
            f.undo().await.unwrap();
            assert_eq!(f.text("moved-source.md").await, BODY);
        }
        f.close().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn pending_heads_byte_bounds_and_unfinished_seed_are_reported() {
    let f = Fixture::new(3, 3);
    let _hold = f.actor.hold_link_drain();
    f.edit(
        "source-0000",
        "source-0000.md",
        "[[old]] current pending head",
    )
    .await;
    let input = write(
        &f.ws,
        "source-0001",
        "source-0001.md",
        &"x".repeat(512 * 1024 + 1),
        "byte-bound",
    );
    f.actor
        .run(move |store, _| {
            VersionedTextStore::new(store).write_text(&input, &NoFaults)?;
            Ok(())
        })
        .await
        .unwrap();
    let ws = f.ws.clone();
    f.actor.run(move |store, _| {
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(?1,'main','source-0000',1),(?1,'main','source-0001',1) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1", [&ws]).map_err(StorageError::persist_public)?;
            tx.execute("DELETE FROM link_pending WHERE workspace_id=?1 AND object_id='source-0002'", [&ws]).map_err(StorageError::persist_public)?;
            tx.execute("DELETE FROM link_sources WHERE workspace_id=?1 AND object_id='source-0002'", [&ws]).map_err(StorageError::persist_public)?;
            tx.execute("INSERT INTO link_index_state(workspace_id,version_id,parser_generation,seed_phase) VALUES(?1,'main',?2,'aliases') ON CONFLICT(workspace_id,version_id) DO UPDATE SET seed_phase='aliases'", params![ws,crate::links::PARSER_GENERATION]).map_err(StorageError::persist_public)?;
            Ok::<_, RuntimeError>(())
        })?;
        Ok(())
    }).await.unwrap();
    let result = f.pass("pending", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(result["documents"], 1);
    assert_eq!(result["uncheckedCount"], 2);
    assert_eq!(
        f.text("source-0000.md").await,
        "[[new]] current pending head"
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn multi_rename_unknown_peer_and_undone_operations_refuse() {
    for scenario in ["folder", "peer", "undone", "unknown"] {
        let f = Fixture::new(1, 1);
        if scenario == "undone" {
            f.undo().await.unwrap();
        }
        if scenario == "folder" {
            let ws = f.ws.clone();
            f.actor
                .run(move |store, _| {
                    VersionedTextStore::new(store).rename_text_file(
                        &RenameTextFile {
                            workspace_id: ws,
                            version_id: "main".into(),
                            from_path: "source-0000.md".into(),
                            to_path: "other.md".into(),
                            moment_id: "folder-member".into(),
                            request_id: None,
                            metadata_origin: "api".into(),
                            metadata_summary: None,
                            metadata_correlation_id: Some(OP.into()),
                            author_json: None,
                            now_ms: 4,
                        },
                        &NoFaults,
                    )?;
                    Ok(())
                })
                .await
                .unwrap();
        }
        if scenario == "peer" {
            let ws = f.ws.clone();
            f.actor.run(move |store, _| {
                store.write_with(&NoFaults, |tx| {
                    tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES(?1,'peer',1,'moment.append',?2,5,1)",params![ws,json!({"momentId":"rename"}).to_string()]).map_err(StorageError::persist_public)?;
                    Ok::<_, RuntimeError>(())
                })?; Ok(())
            }).await.unwrap();
        }
        let op = if scenario == "unknown" {
            "dohc-operation:unknown"
        } else {
            OP
        };
        assert!(matches!(
            f.actor
                .history_rewrite_links(
                    f.ws.clone(),
                    op.into(),
                    format!("refuse-{scenario}"),
                    None,
                    f.root.to_path_buf(),
                    f.leases.clone(),
                    [f.capture.clone(), f.serial.clone()],
                    Arc::new(NoFaults),
                    (
                        {
                            let leases = f.leases.clone();
                            Arc::new(move |key| leases.is_held_by_session(key))
                        },
                        Arc::new(|_| {})
                    ),
                    Arc::new(()),
                    CancellationToken::new()
                )
                .await,
            Err(RuntimeError::Domain(DomainError::UndoRefused {
                reason: "operation cannot rewrite links",
                ..
            }))
        ));
        f.close().await;
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn crashes_keep_the_write_and_request_progress_atomic_and_resume_once() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let mut f = Fixture::new(3, 3);
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
async fn crash_after_k_commits_undoes_only_committed_members_and_replays_one_compensation() {
    crash_during_undo(2, std::time::Duration::MAX).await;
}
#[tokio::test(flavor = "multi_thread")]
async fn crash_after_one_write_inverse_resumes_the_remaining_write_members() {
    crash_during_undo(3, std::time::Duration::ZERO).await;
}
async fn crash_during_undo(nth: usize, budget: std::time::Duration) {
    let mut f = Fixture::new(3, 3);
    let fault = Arc::new(CrashAfterDocuments {
        store: Mutex::new(EngineStore::open_read_only(&engine_db_path(&f.root).unwrap()).unwrap()),
        request: "partial".into(),
        documents: 2,
        done: false,
        point: FaultPoint::StorageAfterCommitBeforeAck,
    });
    assert!(matches!(
        f.pass("partial", fault).await,
        Err(RuntimeError::OperationCrashed)
    ));
    f.restart().await;
    let committed = f
        .actor
        .history_operation(f.ws.clone(), OP.into())
        .await
        .unwrap();
    assert_eq!(committed.moments.len(), 3);
    undo_probe::set_turn_budget(&format!("{}-undo", f.ws), budget);
    let fault = Arc::new(CrashNth {
        point: FaultPoint::StorageAfterCommitBeforeAck,
        // Plan, rename inverse, then one write per turn under the zero budget.
        nth,
        seen: AtomicUsize::new(0),
    });
    assert!(matches!(
        f.actor
            .history_undo_in_turns(
                f.ws.clone(),
                OP.into(),
                format!("{}-undo", f.ws),
                None,
                f.root.to_path_buf(),
                fault,
                10,
                [Arc::default(), f.serial.clone()],
                Arc::new(()),
                None,
                CancellationToken::new(),
            )
            .await,
        Err(RuntimeError::OperationCrashed)
    ));
    f.restart().await;
    let request = format!("{}-undo", f.ws);
    f.actor
        .run(move |store, _| {
            store
                .read_with(|conn| {
                    let (cursor, kind): (i64, String) = conn.query_row(
                        "SELECT result_seq,kind FROM engine_requests WHERE request_id=?1",
                        [&request],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )?;
                    assert_eq!(
                        cursor,
                        i64::try_from(nth - 1).unwrap(),
                        "the selected member committed before the crash"
                    );
                    assert_eq!(kind, "history-undo-pending", "at least one write remains");
                    Ok::<_, rusqlite::Error>(())
                })
                .map_err(StorageError::corrupt_public)?;
            Ok(())
        })
        .await
        .unwrap();
    let replay = f.undo().await.unwrap();
    assert!(!replay.deduped);
    assert_eq!(replay.moments.len(), 3);
    for i in 0..3 {
        assert_eq!(f.text(&format!("source-{i:04}.md")).await, BODY);
    }
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lost_completed_reply_replays_the_exact_result_without_more_writes() {
    let mut f = Fixture::new(3, 3);
    let key = DocKey::new(&f.ws, "main", "source-0002").unwrap();
    let lease = f.leases.acquire(&key).unwrap();
    // Only the completed receipt identifies the lost reply across retries.
    let faults = Arc::new(CrashAfterDocuments {
        store: Mutex::new(EngineStore::open_read_only(&engine_db_path(&f.root).unwrap()).unwrap()),
        request: "lost-reply".into(),
        documents: 2,
        done: true,
        point: FaultPoint::StorageAfterCommitBeforeAck,
    });
    assert!(matches!(
        f.pass("lost-reply", faults).await,
        Err(RuntimeError::OperationCrashed)
    ));
    drop(lease);
    f.restart().await;
    let replay = f.pass("lost-reply", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(
        replay,
        json!({"documents":2,"links":4,"unchecked":["source-0002.md"],"uncheckedCount":1,"complete":false})
    );
    assert_eq!(f.text("source-0002.md").await, BODY);
    assert_eq!(
        f.actor
            .history_operation(f.ws.clone(), OP.into())
            .await
            .unwrap()
            .moments
            .len(),
        3
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn case_only_and_delete_only_operations_refuse() {
    for delete in [false, true] {
        let f = Fixture::new(1, 1);
        let ws = f.ws.clone();
        f.actor
            .run(move |store, _| {
                if delete {
                    VersionedTextStore::new(store).delete_text_file(
                        &dohc_engine_domain::DeleteTextFile {
                            workspace_id: ws,
                            version_id: "main".into(),
                            path: "new.md".into(),
                            moment_id: "delete".into(),
                            request_id: None,
                            metadata_origin: "api".into(),
                            metadata_summary: None,
                            metadata_correlation_id: Some("dohc-operation:refuse".into()),
                            author_json: None,
                            now_ms: 4,
                        },
                        &NoFaults,
                    )?;
                } else {
                    VersionedTextStore::new(store).rename_text_file(
                        &RenameTextFile {
                            workspace_id: ws,
                            version_id: "main".into(),
                            from_path: "new.md".into(),
                            to_path: "NEW.md".into(),
                            moment_id: "case".into(),
                            request_id: None,
                            metadata_origin: "api".into(),
                            metadata_summary: None,
                            metadata_correlation_id: Some("dohc-operation:refuse".into()),
                            author_json: None,
                            now_ms: 4,
                        },
                        &NoFaults,
                    )?;
                }
                Ok(())
            })
            .await
            .unwrap();
        assert!(matches!(
            f.actor
                .history_rewrite_links(
                    f.ws.clone(),
                    "dohc-operation:refuse".into(),
                    "refused".into(),
                    None,
                    f.root.to_path_buf(),
                    f.leases.clone(),
                    [f.capture.clone(), f.serial.clone()],
                    Arc::new(NoFaults),
                    (
                        {
                            let leases = f.leases.clone();
                            Arc::new(move |key| leases.is_held_by_session(key))
                        },
                        Arc::new(|_| {})
                    ),
                    Arc::new(()),
                    CancellationToken::new()
                )
                .await,
            Err(RuntimeError::Domain(DomainError::UndoRefused {
                reason: "operation cannot rewrite links",
                ..
            }))
        ));
        f.close().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn two_thousand_sources_resume_yield_and_undo_in_turns() {
    let mut f = Fixture::new(2000, 4999);
    // Measure forward and Undo turns here; publication has its own bulk proof.
    let _publication = f.capture.clone().lock_owned().await;
    let initial_hold = f.actor.hold_link_drain();
    f.actor
        .run(|store, _| {
            undo_probe::enable_work_probe(store);
            Ok(())
        })
        .await
        .unwrap();
    // The fixture's seed leaves a WAL the next write may wait on.
    f.admitted(|| {
        let ws = f.ws.clone();
        f.actor.run(move |store, _| {
            store.write_with(&NoFaults, |tx| tx.execute(
                "INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) SELECT workspace_id,version_id,object_id,1 FROM snapshots WHERE workspace_id=?1 AND version_id='main' ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1", [&ws]
            ).map_err(StorageError::persist_public))?;
            Ok(())
        })
    }).await.unwrap();

    let crash = Arc::new(CrashAfterDocuments {
        store: Mutex::new(EngineStore::open_read_only(&engine_db_path(&f.root).unwrap()).unwrap()),
        request: "performance".into(),
        documents: 1000,
        done: false,
        point: FaultPoint::StorageAfterCommitBeforeAck,
    });
    let result = f.pass("performance", crash).await;
    assert!(
        matches!(result, Err(RuntimeError::OperationCrashed)),
        "expected the injected crash, got {result:?}"
    );
    f.restart().await;
    drop(initial_hold);
    assert_eq!(
        f.actor
            .history_operation(f.ws.clone(), OP.into())
            .await
            .unwrap()
            .moments
            .len(),
        1001,
        "rename plus exactly 1,000 source commits survived the crash"
    );
    f.actor
        .run(|store, _| {
            undo_probe::enable_work_probe(store);
            Ok(())
        })
        .await
        .unwrap();
    let _index_hold = f.actor.hold_link_drain();
    f.admitted(|| {
        let ws = f.ws.clone();
        f.actor.run(move |store, _| {
            store.write_with(&NoFaults, |tx| {
                tx.execute("INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) SELECT workspace_id,version_id,object_id,1 FROM snapshots WHERE workspace_id=?1 AND version_id='main' ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1", [&ws]).map_err(StorageError::persist_public)?;
                Ok::<_, RuntimeError>(())
            })?;
            Ok(())
        })
    }).await.unwrap();
    let committed = Arc::new(tokio::sync::Notify::new());
    probes().lock().unwrap().get_mut(&f.ws).unwrap().committed = Some(committed.clone());
    let actor = f.actor.clone();
    let serial = f.serial.clone();
    let typing_ws = f.ws.clone();
    let typing = DocKey::new(&f.ws, "main", "source-4998").unwrap();
    let _lease = f.leases.acquire(&typing).unwrap();
    let payloads = {
        let doc = dohc_engine_collab::Ydoc::wire();
        (0..100)
            .map(|i| doc.plaintext_insert(i, "x"))
            .collect::<Vec<_>>()
    };
    let updates = tokio::spawn(async move {
        committed.notified().await;
        let mut waits = Vec::new();
        let mut positions = Vec::new();
        let mut claim = None;
        let mut gaps = Vec::new();
        let mut retry_evidence = Vec::new();
        for (i, payload) in payloads.into_iter().enumerate() {
            let (update, timing, _admission) = undo_probe::retry_ydoc_update(
                &serial,
                || undo_probe::turn_count(&typing_ws),
                || {
                    actor.ydoc_record_update(
                        typing.clone(),
                        "source-4998.md".into(),
                        dohc_engine_collab::ContentKind::Plaintext,
                        dohc_engine_collab::Regime::LocalOnly,
                        payload.clone(),
                        None,
                        None,
                        claim.clone(),
                        i == 0,
                        None,
                        Some(format!("typing-{i}")),
                        5,
                        Arc::new(NoFaults),
                        CancellationToken::new(),
                        None,
                    )
                },
            )
            .await;
            claim = update.lineage_claim_id;
            waits.push(timing.wait_ns);
            gaps.push(timing.turn_gap);
            retry_evidence.push(timing);
            positions.push(
                probes().lock().unwrap()[&typing_ws]
                    .turns
                    .iter()
                    .filter(|(phase, _)| *phase == "commit")
                    .count(),
            );
            tokio::task::yield_now().await;
        }
        (waits, positions, gaps, retry_evidence)
    });
    let start = Instant::now();
    let result = f.pass("performance", Arc::new(NoFaults)).await.unwrap();
    let pass_ns = start.elapsed().as_nanos();
    assert_eq!(result["documents"], 2000);
    assert_eq!(result["links"], 4000);
    assert_eq!(
        f.pass("performance", Arc::new(NoFaults)).await.unwrap(),
        result
    );
    let (waits, positions, gaps, retry_evidence) = updates.await.unwrap();
    assert!(
        retry_evidence.iter().all(|timing| timing.max_turn_gap <= 1),
        "at most one forward turn per attempt: {retry_evidence:?}"
    );
    assert!(
        positions.iter().any(|&n| n > 0 && n < 2000),
        "a Y.Doc update must commit between rewrite batches"
    );
    let forward_proof = undo_probe::proof(&f.ws, 0, true);
    let committed = Arc::new(tokio::sync::Notify::new());
    undo_probe::notify_inverse(&format!("{}-undo", f.ws), committed.clone());
    let actor = f.actor.clone();
    let serial = f.serial.clone();
    let typing_ws = format!("{}-undo", f.ws);
    let typing = DocKey::new(&f.ws, "main", "source-4997").unwrap();
    let _lease = f.leases.acquire(&typing).unwrap();
    let payloads = {
        let doc = dohc_engine_collab::Ydoc::wire();
        (0..100)
            .map(|i| doc.plaintext_insert(i, "x"))
            .collect::<Vec<_>>()
    };
    let updates = tokio::spawn(async move {
        committed.notified().await;
        let mut waits = Vec::new();
        let mut positions = Vec::new();
        let mut claim = None;
        let mut gaps = Vec::new();
        let mut retry_evidence = Vec::new();
        for (i, payload) in payloads.into_iter().enumerate() {
            let (update, timing, _admission) = undo_probe::retry_ydoc_update(
                &serial,
                || undo_probe::turn_count(&typing_ws),
                || {
                    actor.ydoc_record_update(
                        typing.clone(),
                        "source-4997.md".into(),
                        dohc_engine_collab::ContentKind::Plaintext,
                        dohc_engine_collab::Regime::LocalOnly,
                        payload.clone(),
                        None,
                        None,
                        claim.clone(),
                        i == 0,
                        None,
                        Some(format!("undo-typing-{i}")),
                        5,
                        Arc::new(NoFaults),
                        CancellationToken::new(),
                        None,
                    )
                },
            )
            .await;
            claim = update.lineage_claim_id;
            waits.push(timing.wait_ns);
            gaps.push(timing.turn_gap);
            retry_evidence.push(timing);
            positions.push(undo_probe::turn_count(&typing_ws));
            tokio::task::yield_now().await;
        }
        (waits, positions, gaps, retry_evidence)
    });
    let undo_start = Instant::now();
    let undo = f.admitted(|| f.undo_with_busy_retry()).await.unwrap();
    assert_eq!(undo.moments.len(), 2001);
    assert!(undo.not_restored.is_empty());
    let undo_ns = undo_start.elapsed().as_nanos();
    let (undo_waits, _, undo_gaps, undo_retry_evidence) = updates.await.unwrap();
    assert!(
        undo_retry_evidence
            .iter()
            .all(|timing| timing.max_turn_gap <= 1),
        "at most one Undo turn per attempt: {undo_retry_evidence:?}"
    );
    let undo_proof = undo_probe::proof(&format!("{}-undo", f.ws), 2001, false);
    let placed = f
        .actor
        .history_undo_place(
            f.ws.clone(),
            undo,
            f.root.to_path_buf(),
            Arc::new(()),
            11,
            |_| {},
        )
        .await;
    assert!(placed.materialized);
    assert!(f.root.join("old.md").is_file());
    assert!(!f.root.join("new.md").exists());
    for i in 0..2000 {
        assert_eq!(
            std::fs::read_to_string(f.root.join(format!("source-{i:04}.md"))).unwrap(),
            BODY
        );
    }

    eprintln!(
        "REWRITE forward={} undo={} update_max_gap={:?} update_max_wait_ns={:?}",
        forward_proof["p95Ns"],
        undo_proof["p95Ns"],
        gaps.iter().max(),
        waits.iter().max()
    );
    for i in 0..2000 {
        assert_eq!(f.text(&format!("source-{i:04}.md")).await, BODY);
    }
    let turns = probes().lock().unwrap().get(&f.ws).unwrap().turns.clone();
    if let Ok(directory) = std::env::var("DOHC_LINK_REWRITE_EVIDENCE_DIR") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(std::path::Path::new(&directory).join("actor-turns.json"), json!({"passNs":pass_ns,"turns":turns,"admissionProbeWaitNs":waits,"updateCommitPositions":positions,"undoNs":undo_ns,"forward":forward_proof,"undo":undo_proof,"updateTurnGaps":gaps,"undoUpdateTurnGaps":undo_gaps,"undoUpdateWaitNs":undo_waits,"updateRetries":retry_evidence,"undoUpdateRetries":undo_retry_evidence}).to_string()).unwrap();
    }
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn undo_stops_remaining_forward_turns_before_taking_its_snapshot() {
    let f = Fixture::new(20, 20);
    let reached = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(std::sync::Barrier::new(2));
    let (sent, wait) = (reached.clone(), release.clone());
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = Some(Arc::new(move |_, object| {
        if object == "source-0016" {
            sent.notify_one();
            wait.wait();
        }
    }));
    let (forward, undone) = tokio::join!(f.pass("stop-for-undo", Arc::new(NoFaults)), async {
        reached.notified().await;
        let undo = f.undo_with_busy_retry();
        tokio::pin!(undo);
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(undo.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        release.wait();
        undo.await
    });
    let forward = forward.unwrap();
    let documents = forward["documents"].as_u64().unwrap() as usize;
    assert!((1..=16).contains(&documents));
    assert_eq!(forward["uncheckedCount"], 20 - documents);
    assert_eq!(undone.unwrap().moments.len(), documents + 1);
    for i in 0..20 {
        assert_eq!(f.text(&format!("source-{i:04}.md")).await, BODY);
    }
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_competing_request_binding_cannot_be_overwritten_with_source_progress() {
    let f = Fixture::new(1, 1);
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = Some(Arc::new(|conn, _| {
        conn.execute("UPDATE engine_requests SET kind='another-method',payload_hash='another-binding' WHERE request_id='competing-request'", []).unwrap();
    }));
    assert!(matches!(
        f.pass("competing-request", Arc::new(NoFaults)).await,
        Err(RuntimeError::Domain(
            DomainError::IdempotencyKeyReuseMismatch
        ))
    ));
    assert_eq!(f.text("source-0000.md").await, BODY);
    let ws = f.ws.clone();
    f.actor.run(move |store, _| {
        store.read_with(|conn| {
            let receipt: (String, String) = conn.query_row(
                "SELECT kind,payload_hash FROM engine_requests WHERE request_id='competing-request'",
                [], |r| Ok((r.get(0)?,r.get(1)?))).map_err(StorageError::corrupt_public)?;
            assert_eq!(receipt, ("another-method".into(), "another-binding".into()));
            assert_eq!(operation_moments_in(conn, &ws, "main", OP)?.len(), 1,
                "the source moment and all publication roll back with the receipt conflict");
            Ok::<_, RuntimeError>(())
        })
    }).await.unwrap();
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn unrelated_undo_and_file_creation_do_not_stop_the_pass() {
    let f = Fixture::new(20, 21);
    let ws = f.ws.clone();
    f.actor
        .run(move |store, _| {
            VersionedTextStore::new(store).delete_text_file(
                &dohc_engine_domain::DeleteTextFile {
                    workspace_id: ws,
                    version_id: "main".into(),
                    path: "source-0020.md".into(),
                    moment_id: "unrelated-delete".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: Some("dohc-operation:unrelated".into()),
                    author_json: None,
                    now_ms: 4,
                },
                &NoFaults,
            )?;
            Ok(())
        })
        .await
        .unwrap();
    std::fs::remove_file(f.root.join("source-0020.md")).unwrap();
    let reached = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(std::sync::Barrier::new(2));
    let (sent, wait, ws) = (reached.clone(), release.clone(), f.ws.clone());
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = Some(Arc::new(move |conn, object| {
        if object == "source-0016" {
            let tx = conn.unchecked_transaction().unwrap();
            write_text_in_tx(
                &tx,
                &write(
                    &ws,
                    "unrelated",
                    "unrelated.md",
                    "created during the pass",
                    "unrelated-create",
                ),
            )
            .unwrap();
            tx.commit().unwrap();
            sent.notify_one();
            wait.wait();
        }
    }));
    let (forward, undone) = tokio::join!(f.pass("unrelated-undo", Arc::new(NoFaults)), async {
        reached.notified().await;
        let undo = f.actor.history_undo_in_turns(
            f.ws.clone(),
            "dohc-operation:unrelated".into(),
            "unrelated-undo-request".into(),
            None,
            f.root.to_path_buf(),
            Arc::new(NoFaults),
            10,
            [Arc::default(), f.serial.clone()],
            Arc::new(()),
            None,
            CancellationToken::new(),
        );
        tokio::pin!(undo);
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(undo.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        release.wait();
        undo.await
    });
    let forward = forward.unwrap();
    assert_eq!(forward["documents"], 20);
    assert_eq!(forward["complete"], true);
    assert_eq!(undone.unwrap().moments.len(), 1);
    assert_eq!(
        f.pass("unrelated-undo", Arc::new(NoFaults)).await.unwrap(),
        forward
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_peer_head_edit_after_read_is_unchecked_and_preserved() {
    let f = Fixture::new(1, 1);
    let ws = f.ws.clone();
    probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = Some(Arc::new(move |conn, object| {
        let tx = conn.unchecked_transaction().unwrap();
        let mut input = write(
            &ws,
            object,
            "source-0000.md",
            "[[old]] peer typing",
            "peer-edit",
        );
        input.metadata_origin = "sync".into();
        write_text_in_tx(&tx, &input).unwrap();
        tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES(?1,'peer',1,'moment.append',?2,5,1)", params![ws,json!({"momentId":input.moment_id}).to_string()]).unwrap();
        tx.commit().unwrap();
    }));
    let result = f.pass("peer-edit", Arc::new(NoFaults)).await.unwrap();
    assert_eq!(result["documents"], 0);
    assert_eq!(result["unchecked"], json!(["source-0000.md"]));
    assert_eq!(f.text("source-0000.md").await, "[[old]] peer typing");
    assert_eq!(
        std::fs::read_to_string(f.root.join("source-0000.md")).unwrap(),
        BODY
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn pending_rewrites_cancel_in_the_inverse_transaction_and_external_edits_still_refuse() {
    for external in [false, true] {
        let f = Fixture::new(2, 2);
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
async fn competing_alias_families_stop_and_resume_without_a_workspace_revision() {
    for name in ["secondary/OLD.markdown", "secondary/NEW.mdx"] {
        let f = Fixture::new(1, 1);
        let name = name.to_owned();
        probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = Some(Arc::new(move |conn, _| {
            conn.execute("INSERT INTO path_aliases(workspace_id,version_id,path,object_id) SELECT workspace_id,version_id,?1,object_id FROM path_aliases WHERE path='new.md'",[&name]).unwrap();
        }));
        let reply = f
            .pass("competing-family", Arc::new(NoFaults))
            .await
            .unwrap();
        assert_eq!(reply["documents"], 0);
        assert_eq!(reply["complete"], false);
        assert_eq!(reply["uncheckedCount"], 1);
        assert_eq!(f.text("source-0000.md").await, BODY);
        f.actor
            .run(|store, _| {
                store
                    .read_with(|conn| {
                        conn.execute("DELETE FROM path_aliases WHERE path LIKE 'secondary/%'", [])
                    })
                    .map_err(StorageError::persist_public)?;
                Ok(())
            })
            .await
            .unwrap();
        probes().lock().unwrap().get_mut(&f.ws).unwrap().hook = None;
        let reply = f
            .pass("competing-family", Arc::new(NoFaults))
            .await
            .unwrap();
        assert_eq!(reply["documents"], 1);
        assert_eq!(reply["complete"], true);
        f.close().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn unrelated_undo_waits_for_the_actor_turn_and_not_the_forward_pass_gate() {
    let f = Fixture::new(1, 1);
    let guard = f.actor.link_rewrites.gate.clone().lock_owned().await;
    let reply = tokio::time::timeout(
        Duration::from_secs(5),
        f.actor.history_undo_in_turns(
            f.ws.clone(),
            "unrelated-missing-operation".into(),
            "unrelated-gate".into(),
            None,
            f.root.to_path_buf(),
            Arc::new(NoFaults),
            10,
            [Arc::default(), f.serial.clone()],
            Arc::new(()),
            None,
            CancellationToken::new(),
        ),
    )
    .await
    .expect("Undo waited for a whole forward pass");
    assert!(matches!(reply, Err(RuntimeError::Domain(_))));
    drop(guard);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn same_millisecond_pending_edit_chain_cancels_without_false_conflicts() {
    let f = Fixture::new(1, 1);
    let _capture = f.capture.clone().lock_owned().await;
    f.pass("chain-forward", Arc::new(NoFaults)).await.unwrap();
    let edited = format!("{} typed after rename", f.text("source-0000.md").await);
    let (ws, body) = (f.ws.clone(), edited.clone());
    f.actor
        .run(move |store, _| {
            let mut input = write(&ws, "source-0000", "source-0000.md", &body, "later-edit");
            let (first_id, first_generation, same_ms): (String, i64, i64) = store.read_with(|conn| {
                conn.query_row("SELECT job_id,target_generation,created_at_ms FROM materialization_jobs WHERE target_path='source-0000.md' AND status='pending'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))
            }).map_err(StorageError::corrupt_public)?;
            input.now_ms = same_ms;
            store.write_with(&NoFaults, |tx| -> Result<(), DomainError> {
                let result = write_text_in_tx(tx, &input)?;
                let preimage = dohc_engine_storage::Preimage::Present(
                    result.moment.before_blob_sha256.clone().unwrap(),
                );
                // The later job sorts first lexically, but its generation is newer.
                assert!(format!("000-later-mat_{}", result.moment.moment_id) < first_id);
                assert!(result.moment.moment_order > first_generation);
                assert_eq!(result.moment.recorded_at_ms, same_ms);
                dohc_engine_domain::enqueue_write(tx, &result, preimage, "000-later")?;
                Ok(())
            })?;
            Ok(())
        })
        .await
        .unwrap();
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
    let result = f.undo().await.unwrap();
    assert!(result.not_restored.is_empty());
    assert_eq!(
        f.text("source-0000.md").await,
        format!("{BODY} typed after rename")
    );
    f.actor.run(|store,_| {
        store.read_with(|conn| {
            let statuses: Vec<String> = conn.prepare(
                "SELECT status FROM materialization_jobs WHERE target_path='source-0000.md' AND operation='write' AND status!='pending'"
            )?.query_map([],|r|r.get(0))?.collect::<Result<_,_>>()?;
            assert_eq!(statuses,vec!["cancelled";2],"both unpublished jobs cancel atomically");
            Ok::<_,rusqlite::Error>(())
        }).map_err(StorageError::corrupt_public)?;
        Ok(())
    }).await.unwrap();
    f.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn exhausted_diff_skips_only_that_member_and_records_the_refusal() {
    let f = Fixture::new(1, 1);
    let original = format!("{}{BODY}{}", "a".repeat(8192), "b".repeat(8192));
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
