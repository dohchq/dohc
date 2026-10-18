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
    time::{Duration, Instant},
};

type ReadHook = Arc<dyn Fn(&Connection, &str) + Send + Sync>;
#[derive(Default)]
struct Probe {
    turns: Vec<(&'static str, u128)>,
    hook: Option<ReadHook>,
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
        Self {
            ws: ws.into(),
            phase,
            start: Instant::now(),
        }
    }
}
impl Drop for Turn {
    fn drop(&mut self) {
        if let Some(probe) = probes().lock().unwrap().get_mut(&self.ws) {
            probe
                .turns
                .push((self.phase, self.start.elapsed().as_nanos()));
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
struct Fixture {
    actor: ActorHandle,
    supervisor: Arc<crate::WorkspaceSupervisor>,
    root: ScratchDir,
    ws: String,
    leases: LeaseRegistry,
    serial: Arc<tokio::sync::Mutex<()>>,
}
const OP: &str = "dohc-operation:rename";
const BODY: &str = "[[old#part|label]] [[./old.md]] [old](old.md)";
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
        }
    }
    async fn pass(
        &self,
        request: &str,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<Value, RuntimeError> {
        self.actor
            .history_rewrite_links(
                self.ws.clone(),
                OP.into(),
                request.into(),
                None,
                self.root.to_path_buf(),
                self.leases.clone(),
                self.serial.clone(),
                faults,
                CancellationToken::new(),
            )
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
            .history_undo_commit(
                self.ws.clone(),
                OP.into(),
                "undo-request".into(),
                None,
                self.root.to_path_buf(),
                Arc::new(NoFaults),
                10,
            )
            .await
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
            f.serial.clone(),
            Arc::new(NoFaults),
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
            Arc::default(),
            Arc::new(NoFaults),
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

#[tokio::test(flavor = "multi_thread")]
async fn inverse_keeps_later_typing_label_edits_and_new_matching_links() {
    let f = Fixture::new(1, 1);
    f.pass("rewrite", Arc::new(NoFaults)).await.unwrap();
    f.edit(
        "source-0000",
        "source-0000.md",
        "typing [[new#part|changed label]] [[./new.md]] [old](old.md) [[new]]",
    )
    .await;
    let result = f.undo().await.unwrap();
    assert_eq!(result.moments.len(), 2);
    assert_eq!(
        f.text("source-0000.md").await,
        "typing [[old#part|changed label]] [[./old.md]] [old](old.md) [[new]]"
    );
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
            std::fs::write(
                f.root.join("moved-source.md"),
                "[[new#part|label]] [[./new.md]] [old](old.md)",
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
        assert!(
            f.actor
                .history_rewrite_links(
                    f.ws.clone(),
                    op.into(),
                    format!("refuse-{scenario}"),
                    None,
                    f.root.to_path_buf(),
                    f.leases.clone(),
                    f.serial.clone(),
                    Arc::new(NoFaults),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
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
        let faults = Arc::new(CrashNth {
            point,
            nth: 3,
            seen: AtomicUsize::new(0),
        });
        assert!(matches!(
            f.pass("crash-rewrite", faults).await,
            Err(RuntimeError::OperationCrashed)
        ));
        f.restart().await;
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
    let mut f = Fixture::new(3, 3);
    let fault = Arc::new(CrashNth {
        point: FaultPoint::StorageAfterCommitBeforeAck,
        nth: 3,
        seen: AtomicUsize::new(0),
    });
    assert!(f.pass("partial", fault).await.is_err());
    f.restart().await;
    let committed = f
        .actor
        .history_operation(f.ws.clone(), OP.into())
        .await
        .unwrap();
    assert_eq!(committed.moments.len(), 3);
    for i in 0..2 {
        std::fs::write(
            f.root.join(format!("source-{i:04}.md")),
            "[[new#part|label]] [[./new.md]] [old](old.md)",
        )
        .unwrap();
    }
    let fault = Arc::new(CrashNth {
        point: FaultPoint::StorageAfterCommitBeforeAck,
        nth: 1,
        seen: AtomicUsize::new(0),
    });
    assert!(
        f.actor
            .history_undo_commit(
                f.ws.clone(),
                OP.into(),
                "undo-request".into(),
                None,
                f.root.to_path_buf(),
                fault,
                10
            )
            .await
            .is_err()
    );
    f.restart().await;
    let replay = f.undo().await.unwrap();
    assert!(replay.deduped);
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
    // Reservation, two document commits, then the final bounded reply.
    let faults = Arc::new(CrashNth {
        point: FaultPoint::StorageAfterCommitBeforeAck,
        nth: 4,
        seen: AtomicUsize::new(0),
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
        assert!(
            f.actor
                .history_rewrite_links(
                    f.ws.clone(),
                    "dohc-operation:refuse".into(),
                    "refused".into(),
                    None,
                    f.root.to_path_buf(),
                    f.leases.clone(),
                    f.serial.clone(),
                    Arc::new(NoFaults),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
        f.close().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn two_thousand_sources_yield_between_turns_and_measure_undo_hold() {
    let f = Fixture::new(2000, 4999);
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
        let mut waits = Vec::new();
        let mut positions = Vec::new();
        let mut claim = None;
        for (i, payload) in payloads.into_iter().enumerate() {
            let start = Instant::now();
            let _admission = serial.lock().await;
            let update = actor
                .ydoc_record_update(
                    typing.clone(),
                    "source-4998.md".into(),
                    dohc_engine_collab::ContentKind::Plaintext,
                    dohc_engine_collab::Regime::LocalOnly,
                    payload,
                    None,
                    None,
                    claim,
                    i == 0,
                    None,
                    Some(format!("typing-{i}")),
                    5,
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                    None,
                )
                .await
                .unwrap();
            claim = update.lineage_claim_id;
            waits.push(start.elapsed().as_nanos());
            positions.push(
                probes().lock().unwrap()[&typing_ws]
                    .turns
                    .iter()
                    .filter(|(phase, _)| *phase == "commit")
                    .count(),
            );
            tokio::task::yield_now().await;
        }
        (waits, positions)
    });
    let start = Instant::now();
    let result = f.pass("performance", Arc::new(NoFaults)).await.unwrap();
    let pass_ns = start.elapsed().as_nanos();
    assert_eq!(result["documents"], 2000);
    let (waits, positions) = updates.await.unwrap();
    assert!(
        positions.iter().any(|&n| n > 0 && n < 2000),
        "a Y.Doc update must commit between rewrite batches"
    );
    for i in 0..2000 {
        std::fs::write(
            f.root.join(format!("source-{i:04}.md")),
            "[[new#part|label]] [[./new.md]] [old](old.md)",
        )
        .unwrap();
    }
    let (ws, root) = (f.ws.clone(), f.root.to_path_buf());
    let undo_hold = f
        .actor
        .run(move |store, _| {
            let start = Instant::now();
            super::super::history_operations::commit_history_undo_on_store(
                store,
                &ws,
                OP,
                "undo-perf",
                None,
                &root,
                &NoFaults,
                10,
            )?;
            Ok(start.elapsed())
        })
        .await
        .unwrap();
    let turns = probes().lock().unwrap().get(&f.ws).unwrap().turns.clone();
    if let Ok(directory) = std::env::var("DOHC_LINK_REWRITE_EVIDENCE_DIR") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(std::path::Path::new(&directory).join("actor-turns.json"), json!({"passNs":pass_ns,"turns":turns,"admissionProbeWaitNs":waits,"updateCommitPositions":positions,"undoHoldNs":undo_hold.as_nanos()}).to_string()).unwrap();
    }
    f.close().await;
    assert!(
        undo_hold <= Duration::from_secs(1),
        "STOP: 2,000-source Undo held the actor for {undo_hold:?}"
    );
}
