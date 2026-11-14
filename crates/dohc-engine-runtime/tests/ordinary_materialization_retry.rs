use dohc_engine_domain::{DeleteTextFile, RenameTextFile, VersionedTextStore, WriteText};
use dohc_engine_runtime::{CancellationToken, NoFaults, WorkspaceSupervisor};
use dohc_engine_storage::EngineStore;
use dohc_engine_sync::MomentMaterializationChange;
use dohc_engine_testkit::{ScratchDir, engine_db_path, try_make_dir_alias};
use std::sync::Arc;

fn write(text: &str, moment: &str, now_ms: i64) -> WriteText {
    WriteText {
        workspace_id: "workspace".into(),
        version_id: "main".into(),
        object_id: "object".into(),
        path: "file.md".into(),
        text: text.into(),
        moment_id: moment.into(),
        metadata_origin: "sync".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
    }
}

fn write_at(path: &str, object: &str, text: &str, moment: &str, now_ms: i64) -> WriteText {
    WriteText {
        path: path.into(),
        object_id: object.into(),
        ..write(text, moment, now_ms)
    }
}

fn delete_at(path: &str, moment: &str, now_ms: i64) -> DeleteTextFile {
    DeleteTextFile {
        workspace_id: "workspace".into(),
        version_id: "main".into(),
        path: path.into(),
        moment_id: moment.into(),
        request_id: None,
        metadata_origin: "sync".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
    }
}

fn change(path: &str, operation: &'static str) -> MomentMaterializationChange {
    MomentMaterializationChange {
        version_id: "main".into(),
        path: path.into(),
        operation,
        content_kind: "text",
    }
}

async fn materialize_page(
    moments: impl FnOnce(&mut VersionedTextStore<'_>),
    disk: impl FnOnce(&std::path::Path),
    page: Vec<MomentMaterializationChange>,
) -> ScratchDir {
    materialize_pages(moments, disk, vec![page]).await
}

async fn materialize_pages(
    moments: impl FnOnce(&mut VersionedTextStore<'_>),
    disk: impl FnOnce(&std::path::Path),
    pages: Vec<Vec<MomentMaterializationChange>>,
) -> ScratchDir {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        let mut domain = VersionedTextStore::new(&mut store);
        domain
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        moments(&mut domain);
        domain
            .set_active_version("workspace", "main", &NoFaults)
            .unwrap();
    }
    disk(scratch.path());
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 10).unwrap().actor;
    for page in pages {
        actor
            .materialize_relay_page(
                "workspace".into(),
                scratch.path().to_path_buf(),
                page,
                Arc::new(()),
                11,
                CancellationToken::new(),
            )
            .await
            .expect("the page materializes");
    }
    supervisor.close(&db).expect("close actor");
    assert!(
        EngineStore::open(&db, 12)
            .unwrap()
            .list_pending_materialization_jobs()
            .unwrap()
            .is_empty()
    );
    scratch
}

/// A delete means no tracked file at its path. A folder there already holds
/// none, even named before the files inside it. On a desktop replica the
/// folders a delete leaves empty stay, since the person may have made them,
/// unless the page writes a file at their name. A stopped page may have
/// removed the folders below that name already: the write still clears it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_delete_at_a_folder_is_done_and_its_folder_gives_way_only_to_a_write() {
    const GONE: [&str; 3] = ["x.md/child.md", "d/a/b.md", "w.md/sub/child.md"];
    let scratch = materialize_page(
        |domain| {
            for (step, path) in (1..).zip(GONE) {
                let object = format!("o-{step}");
                let (written, deleted) = (format!("w{step}"), format!("d{step}"));
                domain
                    .write_text(&write_at(path, &object, "left", &written, step), &NoFaults)
                    .unwrap();
                domain
                    .delete_text_file(&delete_at(path, &deleted, step), &NoFaults)
                    .unwrap();
            }
            domain
                .write_text(&write_at("w.md", "o-w", "file w", "w4", 4), &NoFaults)
                .unwrap();
        },
        |root| {
            for path in &GONE[..2] {
                std::fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
                std::fs::write(root.join(path), "left").unwrap();
            }
            std::fs::create_dir(root.join("w.md")).unwrap();
        },
        vec![
            change("x.md", "delete"),
            change("x.md/child.md", "delete"),
            change("d/a/b.md", "delete"),
            change("w.md/sub/child.md", "delete"),
            change("w.md", "write"),
        ],
    )
    .await;
    let root = scratch.path();
    assert!(!root.join("x.md/child.md").exists());
    assert!(!root.join("d/a/b.md").exists());
    for kept in ["x.md", "d/a"] {
        assert!(root.join(kept).is_dir(), "{kept}");
    }
    assert_eq!(
        std::fs::read_to_string(root.join("w.md")).unwrap(),
        "file w"
    );
}

/// A link to a folder at a path with no head is not a folder of the
/// workspace: the page refuses it rather than counting the delete as done.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_delete_at_a_link_to_a_folder_is_refused() {
    let scratch = ScratchDir::new().unwrap();
    let elsewhere = ScratchDir::new().unwrap();
    std::fs::write(elsewhere.path().join("outside.md"), "outside").unwrap();
    let db = engine_db_path(&scratch).unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        let mut domain = VersionedTextStore::new(&mut store);
        domain
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        domain
            .write_text(&write_at("x.md", "o-x", "x", "m1", 1), &NoFaults)
            .unwrap();
        domain
            .delete_text_file(&delete_at("x.md", "m2", 2), &NoFaults)
            .unwrap();
        domain
            .set_active_version("workspace", "main", &NoFaults)
            .unwrap();
    }
    assert!(
        try_make_dir_alias(elsewhere.path(), &scratch.path().join("x.md")).unwrap(),
        "host must create the folder link; this regression cannot skip"
    );
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    let refused = actor
        .materialize_relay_page(
            "workspace".into(),
            scratch.path().to_path_buf(),
            vec![change("x.md", "delete")],
            Arc::new(()),
            4,
            CancellationToken::new(),
        )
        .await;
    assert!(refused.is_err(), "{refused:?}");
    assert_eq!(
        std::fs::read_to_string(elsewhere.path().join("outside.md")).unwrap(),
        "outside"
    );
    supervisor.close(&db).unwrap();
    #[cfg(windows)]
    std::fs::remove_dir(scratch.path().join("x.md")).unwrap();
    #[cfg(not(windows))]
    std::fs::remove_file(scratch.path().join("x.md")).unwrap();
}

struct CancelOnFirstPlacement(CancellationToken);

impl dohc_engine_runtime::SelfWriteRecorder for CancelOnFirstPlacement {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {
        self.0.cancel();
    }
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

/// The page's first batch removes `notes`, so cancelling there must not
/// leave `notes/work.md` unwritten behind a cancelled answer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_cancelled_after_its_first_batch_lands_runs_to_its_end() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        let mut domain = VersionedTextStore::new(&mut store);
        domain
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        domain
            .write_text(&write_at("notes", "o-notes", "old", "m1", 1), &NoFaults)
            .unwrap();
        domain
            .delete_text_file(&delete_at("notes", "m2", 2), &NoFaults)
            .unwrap();
        domain
            .write_text(
                &write_at("notes/work.md", "o-work", "work", "m3", 3),
                &NoFaults,
            )
            .unwrap();
        domain
            .write_text(
                &write_at("other/a.md", "o-other", "other", "m4", 4),
                &NoFaults,
            )
            .unwrap();
        domain
            .set_active_version("workspace", "main", &NoFaults)
            .unwrap();
    }
    std::fs::write(scratch.path().join("notes"), "old").unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 10).unwrap().actor;
    let token = CancellationToken::new();
    // `other/a.md` sorts after `notes/work.md`, so it is planned after the
    // first batch lands.
    actor
        .materialize_relay_page(
            "workspace".into(),
            scratch.path().to_path_buf(),
            vec![
                change("notes/work.md", "write"),
                change("notes", "delete"),
                change("other/a.md", "write"),
            ],
            Arc::new(CancelOnFirstPlacement(token.clone())),
            11,
            token.clone(),
        )
        .await
        .expect("a page that changed files answers with its outcome");
    assert!(token.is_cancelled());
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes").join("work.md")).unwrap(),
        "work"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("other").join("a.md")).unwrap(),
        "other"
    );
    supervisor.close(&db).expect("close actor");
}

async fn descendant_aliases_precede_directory_replacement(same_case: bool, reverse: bool) {
    let mut page = vec![
        change(if same_case { "d/a.md" } else { "d/A.md" }, "write"),
        change("d/a.md", "delete"),
        change("d", "write"),
    ];
    if reverse {
        page.reverse();
    }
    let scratch = materialize_page(
        |domain| {
            domain
                .write_text(&write_at("d/a.md", "o-a", "a", "m1", 1), &NoFaults)
                .unwrap();
            domain
                .delete_text_file(&delete_at("d/a.md", "m2", 2), &NoFaults)
                .unwrap();
            domain
                .write_text(&write_at("d", "o-d", "file d", "m3", 3), &NoFaults)
                .unwrap();
        },
        |root| {
            std::fs::create_dir(root.join("d")).unwrap();
            std::fs::write(root.join("d/a.md"), "a").unwrap();
        },
        page,
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("d")).unwrap(),
        "file d"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn descendant_alias_delete_then_write_precedes_directory_replacement() {
    descendant_aliases_precede_directory_replacement(false, true).await;
}

/// A case-only rename's page keeps the renamed file in either order: on a
/// disk that ignores case the delete of the old name runs first, so it never
/// removes the file the write named.
async fn case_only_rename_keeps_its_file(text: &str, write_first: bool) {
    for (source, destination) in [("FILE.md", "file.md"), ("file.md", "FILE.md")] {
        let mut page = vec![change(source, "delete"), change(destination, "write")];
        if write_first {
            page.reverse();
        }
        let seed = |domain: &mut VersionedTextStore<'_>| {
            domain
                .write_text(&write_at(source, "o-file", "old", "m1", 1), &NoFaults)
                .unwrap();
            domain
                .rename_text_file(
                    &RenameTextFile {
                        workspace_id: "workspace".into(),
                        version_id: "main".into(),
                        from_path: source.into(),
                        to_path: destination.into(),
                        moment_id: "m2".into(),
                        request_id: None,
                        metadata_origin: "sync".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 2,
                    },
                    &NoFaults,
                )
                .unwrap();
            domain
                .write_text(&write_at(destination, "o-file", text, "m3", 3), &NoFaults)
                .unwrap();
        };
        let disk = |root: &std::path::Path| std::fs::write(root.join(source), "old").unwrap();
        let scratch = materialize_page(seed, disk, page).await;
        assert_eq!(
            files(scratch.path()),
            vec![(
                std::ffi::OsString::from(destination),
                text.as_bytes().to_vec()
            )],
            "{source} -> {destination}, write_first={write_first}"
        );
    }
}

fn files(root: &std::path::Path) -> Vec<(std::ffi::OsString, Vec<u8>)> {
    let mut files: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(Result::unwrap)
        .filter(|entry| entry.file_type().unwrap().is_file())
        .map(|entry| (entry.file_name(), std::fs::read(entry.path()).unwrap()))
        .collect();
    files.sort();
    files
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn case_only_rename_changed_bytes_write_first() {
    case_only_rename_keeps_its_file("new", true).await;
}

struct MarkdownRoot(std::path::PathBuf);
impl dohc_engine_runtime::WorkspaceRootGuard for MarkdownRoot {
    fn validate(&self, root: &std::path::Path) -> Result<(), dohc_engine_runtime::RuntimeError> {
        assert_eq!(root, self.0);
        assert!(root.is_dir());
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_refresh_survives_real_materialization_failure_and_clears_only_after_replay() {
    use dohc_engine_collab::markdown_write_obligations::{self as obligations, Kind};
    use dohc_engine_collab::markdown_write_safety::MarkdownConversionConsent;
    use dohc_engine_collab::{
        ContentKind, DocKey, LocalAppend, MarkerCreation, Regime, WriterDocCache, Ydoc,
    };
    use dohc_engine_storage::{FaultPoint, hex_sha256};
    use dohc_engine_testkit::ScriptedFaults;
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let source = "Imported source\n";
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
        .unwrap();
    doc.richdoc_append_paragraph("Accepted conversion");
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 1, &NoFaults)
            .unwrap();
        VersionedTextStore::new(&mut store)
            .write_text(&write(source, "source", 2), &NoFaults)
            .unwrap();
        dohc_engine_collab::record_local_update(
            &mut store,
            &mut WriterDocCache::new(),
            &key,
            &doc.encode_full_state(),
            LocalAppend {
                marker: Some(MarkerCreation {
                    path: Some("file.md"),
                    content_kind: ContentKind::Richdoc,
                    regime: Regime::LocalOnly,
                }),
                ..Default::default()
            },
            &NoFaults,
            3,
            |_, _, _| Ok(()),
        )
        .unwrap();
    }
    std::fs::write(scratch.path().join("file.md"), source).unwrap();
    let modified = std::fs::metadata(scratch.path().join("file.md"))
        .unwrap()
        .modified()
        .unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 4).unwrap().actor;
    actor
        .configure_reader_resolver(Arc::new(
            dohc_engine_collab::reader_resolver::ReaderResolver::new(Arc::new(
                dohc_engine_reader::Reader::new(Some(markdown_witness_reader(&scratch))),
            )),
        ))
        .await
        .unwrap();
    let consent = Arc::new(MarkdownConversionConsent::new(
        key.clone(),
        "owner".into(),
        None,
        None,
        hex_sha256(source.as_bytes()),
        Some(hex_sha256(source.as_bytes())),
    ));
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterTempWrite);
    assert!(matches!(
        actor
            .ydoc_settle(
                scratch.path().to_owned(),
                key.clone(),
                "file.md".into(),
                ContentKind::Richdoc,
                None,
                Some(hex_sha256(source.as_bytes())),
                "owner".into(),
                Arc::new(()),
                5,
                faults.clone(),
                CancellationToken::new(),
                None,
                Some(consent.clone())
            )
            .await,
        Err(dohc_engine_runtime::RuntimeError::OperationCrashed)
    ));
    assert!(faults.fired());
    assert!(consent.is_consumed());
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("file.md")).unwrap(),
        source
    );
    assert_eq!(
        std::fs::metadata(scratch.path().join("file.md"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    supervisor.close(&db).unwrap();
    let (owed, tail_sequence) = {
        let mut store = EngineStore::open(&db, 6).unwrap();
        let owed = store
            .read_with(|conn| obligations::pending_in(conn, "workspace"))
            .unwrap();
        assert_eq!(owed.len(), 1);
        assert_eq!(owed[0].kind, Kind::WitnessRefresh);
        let doc = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap()
            .doc;
        let update = doc.richdoc_append_paragraph("Private tail added after conversion committed");
        dohc_engine_collab::record_local_update(
            &mut store,
            &mut WriterDocCache::new(),
            &key,
            &update,
            LocalAppend::default(),
            &NoFaults,
            6,
            |_, _, _| Ok(()),
        )
        .unwrap();
        let sequence = dohc_engine_collab::read_marker(&store, &key)
            .unwrap()
            .unwrap()
            .head_update_seq;
        assert_eq!(store.table_row_count("moments").unwrap(), 2);
        assert_eq!(store.table_row_count("materialization_jobs").unwrap(), 1);
        (owed[0].clone(), sequence)
    };
    let actor = supervisor.open(&db, 7).unwrap().actor;
    let recover = |now| {
        actor.recover_markdown_write(
            owed.clone(),
            scratch.path().to_owned(),
            Arc::new(MarkdownRoot(scratch.path().to_owned())),
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(()),
            now,
            CancellationToken::new(),
        )
    };
    assert!(!recover(8).await.unwrap());
    {
        let store = EngineStore::open_read_only(&db).unwrap();
        assert!(
            dohc_engine_collab::load_persisted(&store, &key)
                .unwrap()
                .unwrap()
                .doc
                .has_markdown_witness()
        );
        assert_eq!(
            store
                .read_with(|conn| obligations::pending_in(conn, "workspace"))
                .unwrap()
                .len(),
            1
        );
    }
    actor
        .materialize_replay_pending(scratch.path().to_owned(), "workspace".into(), 9)
        .await
        .unwrap();
    assert!(recover(10).await.unwrap());
    assert!(recover(11).await.unwrap());
    let saved = std::fs::read_to_string(scratch.path().join("file.md")).unwrap();
    assert!(saved.contains("Accepted conversion"));
    assert!(!saved.contains("Private tail"));
    {
        let store = EngineStore::open_read_only(&db).unwrap();
        let doc = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap()
            .doc;
        assert!(!doc.has_markdown_witness());
        assert!(
            doc.project(ContentKind::Richdoc)
                .unwrap()
                .content
                .contains("Private tail added after conversion committed")
        );
        assert_eq!(
            dohc_engine_collab::read_marker(&store, &key)
                .unwrap()
                .unwrap()
                .head_update_seq,
            tail_sequence + 1
        );
        assert!(
            store
                .read_with(|conn| obligations::pending_in(conn, "workspace"))
                .unwrap()
                .is_empty()
        );
        assert_eq!(store.table_row_count("moments").unwrap(), 2);
        assert_eq!(store.table_row_count("materialization_jobs").unwrap(), 1);
    }
    supervisor.close(&db).unwrap();
}

fn markdown_witness_reader(scratch: &ScratchDir) -> dohc_engine_reader::Config {
    use dohc_engine_storage::hex_sha256;
    let node = std::env::var_os("DOHC_READER_TEST_NODE").unwrap_or_else(|| "node".into());
    let output = std::process::Command::new(node).args(["-p", "JSON.stringify({path:process.execPath,version:process.versions.node,platform:process.platform,arch:process.arch,unicode:process.versions.unicode,icu:process.versions.icu})"]).output().unwrap();
    assert!(output.status.success());
    let mut runtime: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let node = std::path::PathBuf::from(
        runtime
            .as_object_mut()
            .unwrap()
            .remove("path")
            .unwrap()
            .as_str()
            .unwrap(),
    );
    runtime["sha256"] = hex_sha256(&std::fs::read(&node).unwrap()).into();
    let mut manifest = serde_json::json!({"version":1,"runtime":runtime,"buildSha256":"test","parentCwd":std::env::current_dir().unwrap()});
    let script = include_str!("../../dohc-engine-reader/src/fake.cjs")
        .replace("MANIFEST", &manifest.to_string())
        .replace("MODE", "\"witness-unsafe\"");
    let bundle = scratch.path().join("reader.cjs");
    std::fs::write(&bundle, &script).unwrap();
    manifest["bundleSha256"] = hex_sha256(script.as_bytes()).into();
    manifest["sources"] = serde_json::json!([]);
    let path = scratch.path().join("reader-manifest.json");
    std::fs::write(&path, manifest.to_string()).unwrap();
    dohc_engine_reader::Config {
        node,
        bundle,
        manifest: path,
    }
}
