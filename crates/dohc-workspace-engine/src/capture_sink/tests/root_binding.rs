use super::*;

fn durable_row_counts(db: &Path) -> Vec<(&'static str, i64)> {
    const TABLES: &[&str] = &[
        "file_objects",
        "blobs",
        "path_aliases",
        "snapshots",
        "moments",
        "materialization_jobs",
        "ydoc_docs",
        "ydoc_updates",
        "collections",
        "collection_records",
        "collection_record_fields",
        "collection_field_history",
        "collection_relation_edges",
    ];
    let conn = Connection::open(db).expect("open durable state database");
    TABLES
        .iter()
        .map(|table| {
            let count = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("count durable rows");
            (*table, count)
        })
        .collect()
}

struct PausedRootGuard {
    root: CapturedRoot,
    pause_on_validation: usize,
    validations: std::sync::atomic::AtomicUsize,
    reached: (Mutex<bool>, Condvar),
    released: (Mutex<bool>, Condvar),
}

impl PausedRootGuard {
    fn new(root: &Path) -> Arc<Self> {
        Self::pausing_on(root, 1)
    }

    fn pausing_on(root: &Path, pause_on_validation: usize) -> Arc<Self> {
        Arc::new(Self {
            root: CapturedRoot::bind(root).expect("bind paused root guard"),
            pause_on_validation,
            validations: std::sync::atomic::AtomicUsize::new(0),
            reached: (Mutex::new(false), Condvar::new()),
            released: (Mutex::new(false), Condvar::new()),
        })
    }

    fn wait_until_reached(&self) {
        let reached = self.reached.0.lock().expect("lock reached state");
        let (reached, timeout) = self
            .reached
            .1
            .wait_timeout_while(reached, Duration::from_secs(10), |reached| !*reached)
            .expect("wait for actor root validation");
        assert!(*reached, "actor did not validate the queued root guard");
        assert!(!timeout.timed_out(), "actor root validation timed out");
    }

    fn release(&self) {
        let mut released = self.released.0.lock().expect("lock release state");
        *released = true;
        self.released.1.notify_all();
    }
}

impl WorkspaceRootGuard for PausedRootGuard {
    fn validate(&self, root_dir: &Path) -> Result<(), RuntimeError> {
        let validation = self
            .validations
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel)
            + 1;
        if validation != self.pause_on_validation {
            return self.root.validate(root_dir);
        }
        {
            let mut reached = self.reached.0.lock().expect("lock reached state");
            *reached = true;
            self.reached.1.notify_all();
        }
        let released = self.released.0.lock().expect("lock release state");
        let (released, timeout) = self
            .released
            .1
            .wait_timeout_while(released, Duration::from_secs(10), |released| !*released)
            .expect("wait for root replacement");
        if timeout.timed_out() || !*released {
            return Err(RuntimeError::Identity {
                reason: "test root guard release timed out",
                source: None,
            });
        }
        self.root.validate(root_dir)
    }
}

fn try_symlink_file(link: &Path, target: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(target, link).is_ok()
    }
}

fn try_symlink_dir(link: &Path, target: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link).is_ok()
    }
}

fn remove_dir_symlink(link: &Path) {
    #[cfg(unix)]
    std::fs::remove_file(link).expect("remove directory symlink");
    #[cfg(windows)]
    std::fs::remove_dir(link).expect("remove directory symlink");
}

#[test]
fn scanned_name_that_normalizes_to_a_different_key_is_refused() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "a/b.md", b"real");
    ingest(&mut sink, "a/b.md").expect("capture the real file");
    // A literal `a%2fb.md` on disk decodes to the same durable key as the
    // real `a/b.md`; capturing or retiring through it would clobber the
    // real file's head.
    write_file(scratch.path(), "a%2fb.md", b"evil");

    assert_eq!(
        ingest(&mut sink, "a%2fb.md").expect("refused, settled"),
        IngestOutcome::NotOwned
    );
    sink.retire("a%2fb.md").expect("refused retire is a no-op");

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        snapshot(&db, "a/b.md").expect("real head intact").text,
        "real"
    );
    assert_eq!(moment_count(&db, "a/b.md"), 1);
}

#[test]
fn symlink_leaf_swap_is_refused_and_retired() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    let outside_scratch = ScratchDir::new().expect("outside scratch");
    let outside = outside_scratch.path().join("outside-target.md");
    std::fs::write(&outside, b"outside secret").expect("outside fixture");
    write_file(scratch.path(), "swap.md", b"honest");
    ingest(&mut sink, "swap.md").expect("seed ingest");

    // Swap the regular file for a symlink pointing outside the workspace
    // (the TOCTOU the no-follow reopen defends against).
    std::fs::remove_file(scratch.path().join("swap.md")).expect("remove original");
    let made = try_symlink_file(&scratch.path().join("swap.md"), &outside);
    if !made {
        eprintln!("note: symlink creation unavailable on this host; asserting the absent path");
    }
    // Symlink leaf (or, without symlink privilege, the now-absent path):
    // either way the path stopped being engine-ownable and must be retired
    // without ever reading the target's bytes.
    assert_eq!(
        ingest(&mut sink, "swap.md").expect("refused"),
        IngestOutcome::NotOwned
    );

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert!(snapshot(&db, "swap.md").is_none());
}

#[test]
fn symlinked_directory_never_carries_the_read_off_root() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    let outside_scratch = ScratchDir::new().expect("outside scratch");
    let outside_dir = outside_scratch.path().join("outside-dir");
    std::fs::create_dir_all(&outside_dir).expect("outside dir");
    std::fs::write(outside_dir.join("leak.md"), b"outside bytes").expect("outside file");

    let made = try_symlink_dir(&scratch.path().join("linkdir"), &outside_dir);
    if made {
        // The parent resolves outside the root: refused as an escape, and
        // nothing is captured or retired through it.
        assert_eq!(ingest(&mut sink, "linkdir/leak.md"), Err(ESCAPES_ROOT));
    } else {
        eprintln!("note: dir symlink unavailable on this host; asserting the absent path");
        assert_eq!(
            ingest(&mut sink, "linkdir/leak.md").expect("absent"),
            IngestOutcome::NotOwned
        );
    }

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(moment_count(&db, "linkdir/leak.md"), 0);
}

#[test]
fn symlinked_directory_inside_the_root_is_refused_for_scanner_parity() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "real/x.md", b"real content");

    // An ancestor symlink that resolves inside the workspace still aliases
    // content under a path the scanner would never enumerate (the scanner
    // skips symlinked dirs), so the sink must refuse it — strict-equality
    // containment, not merely under-root.
    let made = try_symlink_dir(&scratch.path().join("alias"), &scratch.path().join("real"));
    if made {
        assert_eq!(ingest(&mut sink, "alias/x.md"), Err(ESCAPES_ROOT));
    } else {
        eprintln!("note: dir symlink unavailable on this host; asserting the absent path");
        assert_eq!(
            ingest(&mut sink, "alias/x.md").expect("absent"),
            IngestOutcome::NotOwned
        );
    }

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(moment_count(&db, "alias/x.md"), 0);
}

#[test]
fn cached_canonical_root_refuses_a_root_symlink_swap() {
    // The engine database lives elsewhere so Windows can rename the
    // capture root while its actor remains open.
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().to_path_buf();
    let moved_root = root.with_file_name(format!(
        "{}-moved",
        root.file_name().expect("root name").to_string_lossy()
    ));
    let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    write_file(&root, "first.md", b"first");
    write_file(&root, "second.md", b"second");
    let mut sink = StoreCaptureSink::new(sink_params(actor, &root, 10));

    // The first read fixes this reconcile generation's canonical root.
    ingest(&mut sink, "first.md").expect("seed canonical root");
    std::fs::rename(&root, &moved_root).expect("move capture root");
    if !try_symlink_dir(&root, &moved_root) {
        std::fs::rename(&moved_root, &root).expect("restore capture root");
        eprintln!("note: dir symlink unavailable on this host; root swap not exercised");
        drop(sink);
        supervisor.close(&db).expect("close actor");
        return;
    }

    // Re-canonicalizing the root per file would accept the symlink's new
    // target. Comparing the current parent with the cached location must
    // instead fail closed without reading or capturing the target.
    assert_eq!(ingest(&mut sink, "second.md"), Err(ESCAPES_ROOT));

    remove_dir_symlink(&root);
    std::fs::rename(&moved_root, &root).expect("restore capture root");
    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(moment_count(&db, "second.md"), 0);
}

#[test]
fn captured_root_refuses_a_different_directory_at_the_same_path() {
    // Keep the database outside the capture root so the root can move
    // while its workspace actor remains open.
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().to_path_buf();
    let moved_root = root.with_file_name(format!(
        "{}-moved",
        root.file_name().expect("root name").to_string_lossy()
    ));
    let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    write_file(&root, "first.md", b"first");
    let mut sink = StoreCaptureSink::new(sink_params(actor, &root, 10));

    // The first read binds this reconcile generation to the original
    // directory object, not merely to its canonical pathname.
    ingest(&mut sink, "first.md").expect("seed captured root");
    let original_root = sink.captured_root().expect("original root binding");
    std::fs::rename(&root, &moved_root).expect("move original capture root");
    std::fs::create_dir(&root).expect("recreate capture root at the same path");
    write_file(&root, "replacement.md", b"replacement workspace content");

    let candidates = [AddedTextCandidate {
        path: "replacement.md",
        media_type: "text/markdown",
    }];
    let parallel = prepare_added_text_prefix_parallel(&root, original_root, &candidates);
    let single = ingest(&mut sink, "replacement.md");
    let prepared = sink.prepared_text_capture(
        candidates[0],
        PreparedTextContent {
            text: "must not commit".to_owned(),
            size: 15,
            sha256: hex_sha256(b"must not commit"),
        },
    );
    let batch = sink.commit_added_text_batch(vec![prepared]);
    let policy_retire = sink.retire_policy_excluded("first.md");

    std::fs::remove_dir_all(&root).expect("remove replacement capture root");
    std::fs::rename(&moved_root, &root).expect("restore original capture root");
    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert!(matches!(
        parallel,
        PreparedTextPrefix::RootMismatch { attempted: 1 }
    ));
    assert_eq!(single, Err(ESCAPES_ROOT));
    assert_eq!(batch, BatchIngestResult::Uncertain { attempted: 1 });
    assert_eq!(policy_retire, Err(ESCAPES_ROOT));
    assert_eq!(moment_count(&db, "replacement.md"), 0);
    assert_eq!(
        snapshot(&db, "first.md").expect("head retained").text,
        "first"
    );
}

#[test]
fn collection_reconcile_refuses_replacement_root_before_dispatch() {
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().to_path_buf();
    let moved_root = root.with_file_name(format!(
        "{}-moved",
        root.file_name().expect("root name").to_string_lossy()
    ));
    let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    write_file(&root, "tasks/collection.yaml", b"name: Tasks\n");
    write_file(&root, "tasks/alpha.md", b"original task\n");
    let mut sink = StoreCaptureSink::new(sink_params(actor, &root, 10));
    ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
    ingest(&mut sink, "tasks/alpha.md").expect("capture record");
    seed_captured_richdoc_lineage(&sink, "tasks/alpha.md");
    assert!(collection_record(&db, "tasks/alpha.md").is_none());

    std::fs::rename(&root, &moved_root).expect("move original capture root");
    std::fs::create_dir(&root).expect("create replacement root");
    write_file(&root, "tasks/collection.yaml", b"name: Replacement\n");
    write_file(&root, "tasks/alpha.md", b"replacement task\n");
    let replacement_before =
        std::fs::read(root.join("tasks/alpha.md")).expect("read replacement record");
    let result = sink.reconcile_collections();
    let replacement_after =
        std::fs::read(root.join("tasks/alpha.md")).expect("reread replacement record");
    let binding_after = collection_record(&db, "tasks/alpha.md");

    std::fs::remove_dir_all(&root).expect("remove replacement capture root");
    std::fs::rename(&moved_root, &root).expect("restore original capture root");
    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert!(matches!(
        result,
        Err(RuntimeError::Identity {
            reason: "workspace root changed during capture",
            ..
        })
    ));
    assert_eq!(replacement_after, replacement_before);
    assert!(binding_after.is_none(), "adoption must not reach the actor");
}

#[test]
fn queued_collection_reconcile_refuses_replacement_root_before_db_changes() {
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().to_path_buf();
    let moved_root = root.with_file_name(format!(
        "{}-moved",
        root.file_name().expect("root name").to_string_lossy()
    ));
    let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    write_file(&root, "tasks/collection.yaml", b"name: Tasks\n");
    write_file(&root, "tasks/alpha.md", b"original task\n");
    let mut sink = StoreCaptureSink::new(sink_params(actor.clone(), &root, 10));
    ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
    ingest(&mut sink, "tasks/alpha.md").expect("capture record");
    seed_captured_richdoc_lineage(&sink, "tasks/alpha.md");
    assert!(collection_record(&db, "tasks/alpha.md").is_none());
    let durable_before = durable_row_counts(&db);

    let guard = PausedRootGuard::new(&root);
    let actor_guard: Arc<dyn WorkspaceRootGuard> = guard.clone();
    let command_actor = actor.clone();
    let command_leases = sink.leases.clone();
    let command_self_writes: Arc<dyn dohc_engine_runtime::SelfWriteRecorder> =
        Arc::new(sink.self_writes.clone());
    let command_root = root.clone();
    let command = std::thread::spawn(move || {
        command_actor.reconcile_collections_blocking_guarded(
            WORKSPACE_ID.to_owned(),
            VERSION_ID.to_owned(),
            command_root,
            command_leases,
            command_self_writes,
            10,
            Arc::new(NoFaults),
            actor_guard,
        )
    });

    guard.wait_until_reached();
    std::fs::rename(&root, &moved_root).expect("move original capture root");
    std::fs::create_dir(&root).expect("create replacement root");
    write_file(&root, "tasks/collection.yaml", b"name: Replacement\n");
    write_file(&root, "tasks/alpha.md", b"replacement task\n");
    let replacement_before =
        std::fs::read(root.join("tasks/alpha.md")).expect("read replacement record");
    guard.release();
    let result = command.join().expect("join reconcile command");
    let replacement_after =
        std::fs::read(root.join("tasks/alpha.md")).expect("reread replacement record");
    let binding_after = collection_record(&db, "tasks/alpha.md");
    let durable_after = durable_row_counts(&db);

    std::fs::remove_dir_all(&root).expect("remove replacement capture root");
    std::fs::rename(&moved_root, &root).expect("restore original capture root");
    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert!(matches!(
        result,
        Err(RuntimeError::Identity {
            reason: "workspace root changed during capture",
            ..
        })
    ));
    assert_eq!(replacement_after, replacement_before);
    assert_eq!(durable_after, durable_before);
    assert!(
        binding_after.is_none(),
        "queued reconciliation must not change collection bindings"
    );
}

#[test]
fn post_commit_root_refusal_leaves_no_self_write_suppression() {
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().to_path_buf();
    let moved_root = root.with_file_name(format!(
        "{}-moved",
        root.file_name().expect("root name").to_string_lossy()
    ));
    let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    write_file(&root, "tasks/collection.yaml", b"name: Tasks\n");
    write_file(&root, "tasks/alpha.md", b"original task\n");
    let mut sink = StoreCaptureSink::new(sink_params(actor.clone(), &root, 10));
    ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
    ingest(&mut sink, "tasks/alpha.md").expect("capture record");
    seed_captured_richdoc_lineage(&sink, "tasks/alpha.md");

    // Reconciliation validates once at actor entry and once before the
    // settlement. Pause the third check, after the settlement commit but
    // before its materialization boundary.
    let guard = PausedRootGuard::pausing_on(&root, 3);
    let actor_guard: Arc<dyn WorkspaceRootGuard> = guard.clone();
    let command_actor = actor.clone();
    let command_leases = sink.leases.clone();
    let command_self_writes: Arc<dyn dohc_engine_runtime::SelfWriteRecorder> =
        Arc::new(sink.self_writes.clone());
    let command_root = root.clone();
    let command = std::thread::spawn(move || {
        command_actor.reconcile_collections_blocking_guarded(
            WORKSPACE_ID.to_owned(),
            VERSION_ID.to_owned(),
            command_root,
            command_leases,
            command_self_writes,
            10,
            Arc::new(NoFaults),
            actor_guard,
        )
    });

    guard.wait_until_reached();
    std::fs::rename(&root, &moved_root).expect("move original capture root");
    std::fs::create_dir(&root).expect("create replacement root");
    write_file(&root, "tasks/alpha.md", b"replacement task\n");
    let replacement_before =
        std::fs::read(root.join("tasks/alpha.md")).expect("read replacement record");
    guard.release();
    let result = command.join().expect("join reconcile command");
    let replacement_after =
        std::fs::read(root.join("tasks/alpha.md")).expect("reread replacement record");
    let committed = snapshot(&db, "tasks/alpha.md").expect("settlement committed before refusal");
    let suppression_pending =
        sink.self_writes
            .has_pending(WORKSPACE_ID, "tasks/alpha.md", &committed.blob_sha256);

    std::fs::remove_dir_all(&root).expect("remove replacement capture root");
    std::fs::rename(&moved_root, &root).expect("restore original capture root");
    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert!(matches!(
        result,
        Err(RuntimeError::Identity {
            reason: "workspace root changed during capture",
            ..
        })
    ));
    assert_eq!(replacement_after, replacement_before);
    assert!(
        !suppression_pending,
        "a refused materialization must not suppress a later genuine capture"
    );
}

#[test]
fn queued_materialized_retire_refuses_replacement_root_before_db_changes() {
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().to_path_buf();
    let moved_root = root.with_file_name(format!(
        "{}-moved",
        root.file_name().expect("root name").to_string_lossy()
    ));
    let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    write_file(&root, "first.md", b"first");
    let mut sink = StoreCaptureSink::new(sink_params(actor.clone(), &root, 10));
    ingest(&mut sink, "first.md").expect("capture first head");
    let durable_before = durable_row_counts(&db);

    let guard = PausedRootGuard::new(&root);
    let actor_guard: Arc<dyn WorkspaceRootGuard> = guard.clone();
    let command_actor = actor.clone();
    let command_leases = sink.leases.clone();
    let command_self_writes: Arc<dyn dohc_engine_runtime::SelfWriteRecorder> =
        Arc::new(sink.self_writes.clone());
    let command_root = root.clone();
    let command = std::thread::spawn(move || {
        command_actor.capture_retire_materialized_blocking_guarded(
            CaptureRetire {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: VERSION_ID.to_owned(),
                path: "first.md".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 20,
                request_id: None,
                only_if_text_head: false,
                only_if_capture_origin: true,
                allow_ydoc_origin: true,
            },
            command_root,
            command_self_writes,
            command_leases,
            Arc::new(NoFaults),
            actor_guard,
        )
    });

    guard.wait_until_reached();
    std::fs::rename(&root, &moved_root).expect("move original capture root");
    std::fs::create_dir(&root).expect("create replacement root");
    write_file(&root, "first.md", b"replacement first");
    let replacement_before = std::fs::read(root.join("first.md")).expect("read replacement head");
    guard.release();
    let result = command.join().expect("join retire command");
    let replacement_after = std::fs::read(root.join("first.md")).expect("reread replacement head");
    let retained = snapshot(&db, "first.md").expect("head retained");
    let durable_after = durable_row_counts(&db);

    std::fs::remove_dir_all(&root).expect("remove replacement capture root");
    std::fs::rename(&moved_root, &root).expect("restore original capture root");
    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert!(matches!(
        result,
        Err(RuntimeError::Identity {
            reason: "workspace root changed during capture",
            ..
        })
    ));
    assert_eq!(retained.text, "first");
    assert_eq!(durable_after, durable_before);
    assert_eq!(replacement_after, replacement_before);
}

#[test]
fn present_root_binding_failure_cannot_adopt_a_later_replacement() {
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().join("workspace");
    let moved_root = capture_scratch.path().join("workspace-moved");
    std::fs::create_dir(&root).expect("create capture root");
    write_file(&root, "first.md", b"first");
    let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let mut seed = StoreCaptureSink::new(sink_params(actor.clone(), &root, 10));
    ingest(&mut seed, "first.md").expect("seed captured head");
    drop(seed);

    std::fs::rename(&root, &moved_root).expect("move original capture root");
    std::fs::write(&root, b"not a directory").expect("install refused root");
    let mut refused = StoreCaptureSink::new(sink_params(actor, &root, 20));
    std::fs::remove_file(&root).expect("remove refused root");
    std::fs::create_dir(&root).expect("install replacement directory");
    let retire = refused.retire_policy_excluded("first.md");

    std::fs::remove_dir_all(&root).expect("remove replacement capture root");
    std::fs::rename(&moved_root, &root).expect("restore original capture root");
    drop(refused);
    supervisor.close(&db).expect("close actor");
    assert_eq!(retire, Err(ESCAPES_ROOT));
    assert_eq!(
        snapshot(&db, "first.md").expect("head retained").text,
        "first"
    );
}

#[test]
fn initially_absent_root_rejects_generation_and_fresh_sink_reads_policy() {
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().join("workspace");
    let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let mut stale = StoreCaptureSink::new(sink_params(actor.clone(), &root, 10));

    std::fs::create_dir(&root).expect("create recovered root");
    write_file(
        &root,
        ".dohc/files.toml",
        b"[[rule]]\npath = \"private/**\"\ntracked = false\n",
    );
    write_file(&root, "private/journal.md", b"personal");
    write_file(&root, "public.md", b"shared");
    assert_eq!(ingest(&mut stale, "private/journal.md"), Err(ESCAPES_ROOT));
    drop(stale);

    let mut fresh = StoreCaptureSink::new(sink_params(actor, &root, 20));
    assert_eq!(
        ingest(&mut fresh, "private/journal.md").expect("fresh policy snapshot"),
        IngestOutcome::NotOwned
    );
    assert!(matches!(
        ingest(&mut fresh, "public.md").expect("fresh public capture"),
        IngestOutcome::Captured { .. }
    ));

    drop(fresh);
    supervisor.close(&db).expect("close actor");
    assert!(snapshot(&db, "private/journal.md").is_none());
    assert_eq!(
        snapshot(&db, "public.md")
            .expect("captured public head")
            .text,
        "shared"
    );
}

#[cfg(unix)]
#[test]
fn fifo_leaf_neither_blocks_nor_captures() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    let fifo_path = scratch.path().join("pipe.md");
    // The workspace forbids unsafe code, so shell out to coreutils
    // instead of calling libc::mkfifo directly.
    let made = std::process::Command::new("mkfifo")
        .arg(&fifo_path)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    assert!(made, "mkfifo unavailable on this unix host");

    // The advisory lstat rejects the at-rest FIFO; the O_NONBLOCK open is
    // what guarantees a FIFO swapped in after that check cannot hang the
    // worker — exercise it directly.
    assert!(matches!(
        open_no_follow(&fifo_path),
        NoFollowOpen::Opened(_) | NoFollowOpen::Failed
    ));
    assert_eq!(
        ingest(&mut sink, "pipe.md").expect("fifo is not ownable"),
        IngestOutcome::NotOwned
    );

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(moment_count(&db, "pipe.md"), 0);
}
