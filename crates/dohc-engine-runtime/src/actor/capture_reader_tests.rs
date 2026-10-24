use super::*;
use dohc_engine_collab::{ContentKind, Regime, Ydoc};
use dohc_engine_reader::Reader;
use dohc_engine_storage::NoFaults;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

enum Change {
    Remote(DocKey),
    File(String),
}
type Hooks = Mutex<HashMap<PathBuf, VecDeque<Change>>>;
fn hooks() -> &'static Hooks {
    static HOOKS: OnceLock<Hooks> = OnceLock::new();
    HOOKS.get_or_init(Default::default)
}

pub(super) async fn after_prepare(
    actor: &ActorHandle,
    root: &std::path::Path,
) -> Result<(), RuntimeError> {
    let change = hooks()
        .lock()
        .unwrap()
        .get_mut(root)
        .and_then(VecDeque::pop_front);
    match change {
        Some(Change::Remote(key)) => {
            actor
                .run(move |store, _| {
                    let doc =
                        store.read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))?;
                    let delta = doc.richdoc_append_paragraph("Remote update");
                    store.write_with(&NoFaults, |tx| {
                        dohc_engine_collab::record_update_in_tx(tx, &key, &delta, None, None, 4)
                    })?;
                    Ok(())
                })
                .await?
        }
        Some(Change::File(text)) => std::fs::write(root.join("note.md"), text).unwrap(),
        None => {}
    }
    Ok(())
}

fn input(text: &str) -> CaptureIngest {
    CaptureIngest {
        workspace_id: "w".into(),
        version_id: "main".into(),
        path: "note.md".into(),
        text: text.into(),
        metadata_origin: "capture".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 5,
        request_id: None,
        claim_foreign_head: false,
    }
}

fn fixture(joined: bool) -> (ScratchDir, EngineStore, DocKey) {
    let scratch = ScratchDir::new().unwrap();
    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("w", "main", 1, &NoFaults)
        .unwrap();
    let source = "Before\n\n- parent\n  - child";
    let snapshot = VersionedTextStore::new(&mut store)
        .capture_ingest(&input(source), &NoFaults)
        .unwrap()
        .snapshot;
    let key = DocKey::new("w", "main", snapshot.object_id).unwrap();
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, source)
        .unwrap();
    let base = doc.encode_full_state();
    if joined {
        dohc_engine_collab::claim_base_at_relay(
            &mut store,
            &key,
            ContentKind::Richdoc,
            &base,
            &dohc_engine_collab::BaseRelayCoordinate {
                origin_id: "owner".into(),
                origin_seq: 1,
                relay_seq: 1,
            },
            &NoFaults,
            2,
        )
        .unwrap();
    } else {
        dohc_engine_collab::claim_base(&mut store, &key, ContentKind::Richdoc, &base, &NoFaults, 2)
            .unwrap();
    }
    store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE ydoc_docs SET path='note.md',last_settled_sha=?1,settled_update_seq=head_update_seq",
            [&snapshot.blob_sha256]).map_err(StorageError::corrupt_public)?;
        tx.execute_batch("INSERT INTO sync_identity(workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES('w','local','epoch','stream',1);
            INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) VALUES('w','local',0);").map_err(StorageError::corrupt_public)
    }).unwrap();
    std::fs::write(scratch.path().join("note.md"), source).unwrap();
    (scratch, store, key)
}

fn resolver() -> reader_resolver::ReaderResolver {
    reader_resolver::ReaderResolver::new(Arc::new(Reader::new(Some(
        serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap(),
    ))))
}

async fn fold(store: &EngineStore, key: &DocKey, source: &str) -> PreparedFold {
    let preparation = store
        .read_with(|conn| reader_resolver::prepare_fold(conn, key, "note.md", source))
        .unwrap()
        .unwrap();
    preparation
        .construct(&resolver())
        .await
        .expect("real reader constructs native fold")
}

fn commit(
    store: &mut EngineStore,
    root: &std::path::Path,
    source: &str,
    fold: PreparedFold,
) -> Result<WriteResult, RuntimeError> {
    let mut capture = input(source);
    capture.metadata_correlation_id = Some("dohc-operation:outside-fold".into());
    capture_ingest_on_store(
        store,
        &capture,
        &indexing(CaptureIndexing::Skip, root.to_owned(), Arc::new(vec![fold])),
        &LeaseRegistry::new(),
        &NoFaults,
        &CancellationToken::new(),
    )
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
async fn outside_reader_fold_owner_and_joined_keep_tree_marks_settle_and_history() {
    for joined in [false, true] {
        for source in [
            "Changed beside list\n\n- parent\n  - child",
            "A **bold** word, an *italic* word, and a [link](https://example.com).\n\n- parent\n  - child",
        ] {
            let (scratch, mut store, key) = fixture(joined);
            std::fs::write(scratch.path().join("note.md"), source).unwrap();
            let prepared = fold(&store, &key, source).await;
            let before = store
                .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
                .unwrap();
            let result = commit(&mut store, scratch.path(), source, prepared).unwrap();
            assert_eq!(result.snapshot.text, source);
            let doc = store
                .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
                .unwrap();
            assert!(!doc.has_reader_source());
            assert!(doc.markdown_source_reference().is_none());
            assert_eq!(
                store
                    .read_with(|conn| dohc_engine_sync::project_ydoc_with_store(
                        conn,
                        &key,
                        &doc,
                        ContentKind::Richdoc
                    ))
                    .unwrap()
                    .content,
                source
            );
            let body = doc.canonical_content()["body"].to_string();
            assert!(body.matches("bulletList").count() >= 2, "{body}");
            if source.contains("**bold**") {
                for mark in ["bold", "italic", "link"] {
                    assert!(body.contains(mark), "{body}");
                }
            }
            let history: (String, String) = store.read_with(|conn| conn.query_row(
                "SELECT b.text,a.text FROM moments m JOIN blobs b ON b.sha256=m.before_blob_sha256 JOIN blobs a ON a.sha256=m.after_blob_sha256 WHERE m.moment_id=?1",
                [&result.moment.moment_id], |row| Ok((row.get(0)?, row.get(1)?)))).unwrap();
            assert_eq!(
                history,
                ("Before\n\n- parent\n  - child".into(), source.into())
            );
            assert_ne!(before.encode_state_vector(), doc.encode_state_vector());
            let marker = dohc_engine_collab::read_marker(&store, &key)
                .unwrap()
                .unwrap();
            super::super::super::ydoc::ydoc_settle_on_store(
                &mut store,
                &mut dohc_engine_collab::WriterDocCache::new(),
                scratch.path(),
                &key,
                "note.md",
                ContentKind::Richdoc,
                true,
                marker.lineage_claim_id.as_deref(),
                Some(result.snapshot.blob_sha256.clone()),
                None,
                "test-session",
                &(),
                6,
                &NoFaults,
                &CancellationToken::new(),
                None,
                None,
                None,
                super::super::super::ydoc::SettlementKind::Document,
                false,
            )
            .unwrap();
            assert_eq!(
                std::fs::read(scratch.path().join("note.md")).unwrap(),
                source.as_bytes()
            );
        }
    }
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
async fn outside_reader_fold_noncanonical_and_native_match_existing_capture() {
    for source in [
        "Plain native paragraph",
        "* parent\n  * child",
        "- parent\n    - child",
        "__bold__",
        "- first\ncontinuation",
        "Changed\n\n- parent\n  - child\n",
        "Changed\r\n\r\n- parent\r\n  - child\r\n",
    ] {
        let mut outcomes = Vec::new();
        for configured in [false, true] {
            let (scratch, store, key) = fixture(false);
            std::fs::write(scratch.path().join("note.md"), source).unwrap();
            let db = store.database_path().to_owned();
            drop(store);
            let supervisor = crate::WorkspaceSupervisor::new();
            let actor = supervisor.open(&db, 3).unwrap().actor;
            if configured {
                actor
                    .configure_reader_resolver(Arc::new(resolver()))
                    .await
                    .unwrap();
            }
            let captured = actor
                .capture_ingest_indexed(
                    input(source),
                    scratch.path().to_owned(),
                    LeaseRegistry::new(),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await;
            let state = actor
                .run(move |store, _| {
                    let doc =
                        store.read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))?;
                    let head = VersionedTextStore::new(store)
                        .read_text("w", "main", "note.md")?
                        .unwrap();
                    let mut content = doc.canonical_content();
                    content["meta"]
                        .as_object_mut()
                        .unwrap()
                        .remove("dohcLineageEpoch");
                    Ok((content, head.text))
                })
                .await
                .unwrap();
            outcomes.push((captured.err().map(|e| e.code().to_owned()), state));
            assert_eq!(
                std::fs::read(scratch.path().join("note.md")).unwrap(),
                source.as_bytes()
            );
            supervisor.close(&db).unwrap();
        }
        assert_eq!(outcomes[0], outcomes[1], "{source:?}");
    }
}

async fn refuse_stale_preparation(change_file: bool) {
    let (scratch, mut store, key) = fixture(false);
    let source = "Changed\n\n- parent\n  - child";
    std::fs::write(scratch.path().join("note.md"), source).unwrap();
    let prepared = fold(&store, &key, source).await;
    if change_file {
        std::fs::write(scratch.path().join("note.md"), "second outside edit").unwrap();
    } else {
        let doc = store
            .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
            .unwrap();
        let delta = doc.richdoc_append_paragraph("Remote update");
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_collab::record_update_in_tx(tx, &key, &delta, None, None, 4)
            })
            .unwrap();
    }
    assert!(is_stale(&commit(
        &mut store,
        scratch.path(),
        source,
        prepared
    )));
    let snapshot = VersionedTextStore::new(&mut store)
        .read_text("w", "main", "note.md")
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.text, "Before\n\n- parent\n  - child");
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
async fn outside_reader_fold_refuses_remote_staleness() {
    refuse_stale_preparation(false).await;
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
async fn outside_reader_fold_refuses_file_staleness() {
    refuse_stale_preparation(true).await;
}

#[tokio::test]
async fn outside_reader_fold_unavailable_and_cap_preserve_strict_hold() {
    let (scratch, mut store, key) = fixture(false);
    let source = "Changed\n\n- parent\n  - child";
    let preparation = store
        .read_with(|conn| reader_resolver::prepare_fold(conn, &key, "note.md", source))
        .unwrap()
        .unwrap();
    let unavailable = reader_resolver::ReaderResolver::new(Arc::new(Reader::new(None)));
    assert!(preparation.construct(&unavailable).await.is_none());
    assert!(
        store
            .read_with(|conn| reader_resolver::prepare_fold(
                conn,
                &key,
                "note.md",
                &"x".repeat(reader_resolver::MAX_FOLD_SOURCE_BYTES + 1)
            ))
            .unwrap()
            .is_none()
    );
    std::fs::write(scratch.path().join("note.md"), source).unwrap();
    let result = capture_ingest_on_store(
        &mut store,
        &input(source),
        &CaptureIndexing::Skip,
        &LeaseRegistry::new(),
        &NoFaults,
        &CancellationToken::new(),
    );
    assert!(matches!(result, Err(RuntimeError::CaptureFileHeld { .. })));
    assert_eq!(
        dohc_engine_collab::read_marker(&store, &key)
            .unwrap()
            .unwrap()
            .regime,
        Regime::Replicated
    );
}

fn scripted_reader(
    scratch: &ScratchDir,
    edit: impl FnOnce(String) -> String,
) -> dohc_engine_reader::Config {
    let output = std::process::Command::new("node").args(["-p", "JSON.stringify({path:process.execPath,version:process.versions.node,platform:process.platform,arch:process.arch,unicode:process.versions.unicode,icu:process.versions.icu})"]).output().unwrap();
    assert!(output.status.success());
    let mut runtime: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let node = PathBuf::from(
        runtime
            .as_object_mut()
            .unwrap()
            .remove("path")
            .unwrap()
            .as_str()
            .unwrap(),
    );
    runtime["sha256"] = dohc_engine_storage::hex_sha256(&std::fs::read(&node).unwrap()).into();
    let mut manifest = serde_json::json!({"version":1,"runtime":runtime,"buildSha256":"test","parentCwd":std::env::current_dir().unwrap()});
    let script = edit(
        include_str!("../../../dohc-engine-reader/src/fake.cjs")
            .replace("MANIFEST", &manifest.to_string())
            .replace("MODE", "\"normal\""),
    );
    let bundle = scratch.path().join("failing-reader.cjs");
    std::fs::write(&bundle, &script).unwrap();
    manifest["bundleSha256"] = dohc_engine_storage::hex_sha256(script.as_bytes()).into();
    manifest["sources"] = serde_json::json!([]);
    let path = scratch.path().join("failing-manifest.json");
    std::fs::write(&path, manifest.to_string()).unwrap();
    dohc_engine_reader::Config {
        node,
        bundle,
        manifest: path,
    }
}

fn failing_reader(scratch: &ScratchDir, crash: bool) -> dohc_engine_reader::Config {
    scripted_reader(scratch, |script| {
        script.replace(
            "const fault = r.currentPath;",
            if crash {
                "const fault = 'crash';"
            } else {
                "const fault = 'hang';"
            },
        )
    })
}

#[tokio::test]
async fn outside_reader_fold_plain_edits_never_dispatch_with_a_reader_configured() {
    let (scratch, store, _) = fixture(false);
    let db = store.database_path().to_owned();
    drop(store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    let reader = Arc::new(Reader::new(Some(failing_reader(&scratch, true))));
    actor
        .configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(
            reader.clone(),
        )))
        .await
        .unwrap();
    for source in [
        "Changed plain paragraph.",
        "# Heading\n\nPlain paragraph.",
        "- first\n- second",
        "1. first\n2. second",
        "```rust\nlet x = \"**literal**\";\n```",
    ] {
        std::fs::write(scratch.path().join("note.md"), source).unwrap();
        assert!(
            prepare(
                &actor,
                Arc::from([input(source)]),
                scratch.path(),
                &mut None
            )
            .await
            .is_empty()
        );
    }
    assert_eq!(
        reader.dispatch_count(),
        0,
        "plain edits started the configured reader"
    );
    supervisor.close(&db).unwrap();
}

#[test]
fn outside_reader_fold_inline_grammar_and_structural_refusals_need_reader() {
    for source in [
        "*em*",
        "_em_",
        "**strong**",
        "__strong__",
        "***both***",
        "[link](url)",
        "[](url)",
        "![image](url)",
        "[ref][id]",
        "[shortcut]",
        "<https://example.com>",
        "<a@b.com>",
        "<span>html</span>",
        "<!-- html -->",
        "https://example.com",
        "ftp://example.com",
        "www.example.com",
        "WWW.example.com",
        "ice@example.com",
        "~strike~",
        "~~strike~~",
        "\\*escaped\\*",
        "&amp;",
        "&#65;",
        "`code`",
        "``code``",
        "hard  \nbreak",
        "hard\\\nbreak",
        "[[target|label]]",
        "{{atom:id params}}",
        "==highlight==",
        "$math$",
        "$$\nmath\n$$",
        "> [!note]\n> callout",
        "| table |",
        "\u{e000}sentinel\u{e001}",
        "- parent\n  - child",
        "- parent\n    body",
        "- parent\nlazy continuation",
        "- - child",
        "1. 1. child",
        "- # heading",
        "-    indented code",
        "bare carriage return\r",
        "1. parent\nbody",
        ">>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> quote",
        "\t- indented",
        "~~~rust\ncode\n~~~",
        "````\ncode\n````",
        "```rust\nunclosed",
        "```rust\ncode\n``` trailing\n**bold**",
        "    **indented**",
        "a\rb",
        "heading\n===",
        "---\ntitle: frontmatter\n---",
    ] {
        assert!(needs_reader(source), "false native admission: {source:?}");
    }
    for source in [
        "plain",
        "# heading\n\nparagraph",
        "- first\n- second",
        "+ first\n+ second",
        "1. first\n2. second",
        "plain\r\ntext",
        "```rust\n**literal** [link](url) $math$\n```",
        "```\n- parent\n  - child\n```",
    ] {
        assert!(!needs_reader(source), "unnecessary reader: {source:?}");
    }
    for marker in ["-", "+", "*", "1.", "2)"] {
        for separator in [" ", "\n", "\n\n", "\n  ", "\n    ", "\n\t"] {
            for body in [
                "plain",
                "- child",
                "1. child",
                "# heading",
                "> quote",
                "    code",
            ] {
                for lead in ["", " parent"] {
                    let source = format!("{marker}{lead}{separator}{body}");
                    let native = Ydoc::wire();
                    if native
                        .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &source)
                        .is_err()
                    {
                        assert!(needs_reader(&source), "Strict refusal bypassed: {source:?}");
                    }
                }
            }
        }
    }
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
async fn outside_reader_fold_native_admissions_match_the_editor_tree() {
    let (_scratch, store, key) = fixture(false);
    let checkpoint = store
        .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
        .unwrap()
        .encode_full_state();
    let marker = dohc_engine_collab::read_marker(&store, &key)
        .unwrap()
        .unwrap();
    let reader = Reader::new(Some(
        serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap(),
    ));
    let mut mismatches = Vec::new();
    for source in [
        "ordinary paragraph",
        "- a\n\n- b",
        "3. a\n4. b",
        "a\nb",
        "-",
        "1.",
        "# heading",
        "- first\n- second",
        "1. first\n2. second",
        "```rust\nlet x = \"**literal**\";\n```",
        "**bold**",
        "a\n\u{a0}\nb",
        "a\n\u{1680}\nb",
        "a\n\u{2000}\nb",
        "a\n\u{2028}\nb",
        "a\n\u{202f}\nb",
        "a\n\u{205f}\nb",
        "a\n\u{3000}\nb",
        "a\n\u{feff}\nb",
        "a\rb",
        "```\na\rb\n```",
    ] {
        let native = Ydoc::wire();
        native.apply(&checkpoint).unwrap();
        if native
            .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, source)
            .is_err()
        {
            assert!(needs_reader(source), "Strict refusal bypassed: {source:?}");
            continue;
        }
        let outcome = reader
            .request(dohc_engine_reader::Request {
                method: dohc_engine_reader::Method::Construct,
                document: dohc_engine_reader::Document {
                    workspace_id: key.workspace_id.clone(),
                    main_version_id: key.version_id.clone(),
                    object_id: key.object_id.clone(),
                    lineage_claim_id: marker.lineage_claim_id.clone().unwrap(),
                },
                current_path: "note.md".into(),
                source: source.as_bytes().to_vec(),
                checkpoint: checkpoint.clone(),
            })
            .await
            .unwrap();
        let dohc_engine_reader::Outcome::Constructed { delta, .. } = outcome else {
            panic!("reader refused {source:?}: {outcome:?}")
        };
        let editor = Ydoc::wire();
        editor.apply(&checkpoint).unwrap();
        editor.apply(&delta).unwrap();
        if native.canonical_content()["body"] != editor.canonical_content()["body"]
            && !needs_reader(source)
        {
            mismatches.push(format!(
                "{source:?}: native={} editor={}",
                native.canonical_content()["body"],
                editor.canonical_content()["body"]
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "different editor trees bypassed: {mismatches:#?}"
    );
}

struct Round1Root;
impl WorkspaceRootGuard for Round1Root {
    fn validate(&self, root: &std::path::Path) -> Result<(), RuntimeError> {
        assert!(root.is_dir());
        Ok(())
    }
}

fn round1_batch(
    actor: ActorHandle,
    root: PathBuf,
    inputs: Vec<CaptureIngest>,
    guard: Arc<dyn WorkspaceRootGuard>,
) -> Result<Vec<Result<WriteResult, RuntimeError>>, RuntimeError> {
    let policy = Arc::new(crate::search::read_engine_search_policy(&root));
    std::thread::spawn(move || {
        actor.capture_ingest_batch_blocking(
            inputs,
            policy,
            LeaseRegistry::new(),
            Arc::new(NoFaults),
            root,
            guard,
        )
    })
    .join()
    .unwrap()
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
async fn outside_reader_fold_round1_stale_retry_keeps_receipt_bytes_and_author() {
    let (scratch, store, _) = fixture(false);
    let db = store.database_path().to_owned();
    drop(store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    actor
        .configure_reader_resolver(Arc::new(resolver()))
        .await
        .unwrap();
    let mut captured = input("**Receipt A**");
    captured.author_json = Some(r#"[{"name":"capture-sink-author"}]"#.into());
    let author = captured.author_json.clone();
    std::fs::write(scratch.path().join("note.md"), &captured.text).unwrap();
    hooks().lock().unwrap().insert(
        scratch.path().to_owned(),
        VecDeque::from([Change::File("**Later B**".into())]),
    );
    let results = round1_batch(
        actor.clone(),
        scratch.path().to_owned(),
        vec![captured.clone()],
        Arc::new(Round1Root),
    )
    .unwrap();
    let result = results[0].as_ref().unwrap();
    assert_eq!(
        result.snapshot.text, captured.text,
        "committed bytes differ from the sink receipt"
    );
    assert_eq!(
        result.snapshot.blob_sha256,
        dohc_engine_storage::hex_sha256(captured.text.as_bytes())
    );
    assert_eq!(
        result.moment.author_json, author,
        "stale retry lost the sink author"
    );
    let later = round1_batch(
        actor,
        scratch.path().to_owned(),
        vec![input("**Later B**")],
        Arc::new(Round1Root),
    )
    .unwrap();
    assert_eq!(later[0].as_ref().unwrap().snapshot.text, "**Later B**");
    hooks().lock().unwrap().remove(scratch.path());
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn outside_reader_fold_round1_preparation_error_is_per_item() {
    use rusqlite::hooks::{AuthAction, Authorization};
    use std::sync::atomic::{AtomicBool, Ordering};
    let (scratch, store, key) = fixture(false);
    let db = store.database_path().to_owned();
    drop(store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    actor
        .configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(Arc::new(
            Reader::new(None),
        ))))
        .await
        .unwrap();
    let deny = Arc::new(AtomicBool::new(true));
    let observed = deny.clone();
    actor
        .run(move |store, _| {
            store.read_with(|conn| {
                conn.authorizer(Some(move |context: rusqlite::hooks::AuthContext<'_>| {
                    if matches!(
                        context.action,
                        AuthAction::Read {
                            table_name: "ydoc_docs",
                            ..
                        }
                    ) && deny.swap(false, Ordering::SeqCst)
                    {
                        Authorization::Deny
                    } else {
                        Authorization::Allow
                    }
                }))
                .unwrap();
                Ok::<_, RuntimeError>(())
            })
        })
        .await
        .unwrap();
    let original = input("**Strict keeps this literal**");
    let mut sibling = input("Sibling commits");
    sibling.path = "sibling.md".into();
    std::fs::write(scratch.path().join("note.md"), &original.text).unwrap();
    std::fs::write(scratch.path().join("sibling.md"), &sibling.text).unwrap();
    let results = round1_batch(
        actor.clone(),
        scratch.path().to_owned(),
        vec![original.clone(), sibling],
        Arc::new(Round1Root),
    );
    assert!(
        !observed.load(Ordering::SeqCst),
        "preparation did not exercise the denied read"
    );
    let results = results.expect("one preparation error escaped the batch");
    assert_eq!(results[0].as_ref().unwrap().snapshot.text, original.text);
    assert_eq!(
        results[1].as_ref().unwrap().snapshot.text,
        "Sibling commits"
    );
    actor
        .run(move |store, _| {
            let doc = store.read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))?;
            let strict = Ydoc::wire();
            strict.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &original.text)?;
            assert_eq!(
                doc.canonical_content()["body"],
                strict.canonical_content()["body"]
            );
            Ok(())
        })
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
async fn outside_reader_fold_round1_later_batch_failure_keeps_committed_receipts() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct FailRetry(AtomicUsize);
    impl WorkspaceRootGuard for FailRetry {
        fn validate(&self, _: &std::path::Path) -> Result<(), RuntimeError> {
            if self.0.fetch_add(1, Ordering::SeqCst) >= 2 {
                Err(RuntimeError::Cancelled)
            } else {
                Ok(())
            }
        }
    }
    let (scratch, store, key) = fixture(false);
    let db = store.database_path().to_owned();
    drop(store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    actor
        .configure_reader_resolver(Arc::new(resolver()))
        .await
        .unwrap();
    let rich = input("Changed\n\n- parent\n  - child");
    let mut sibling = input("Committed sibling");
    sibling.path = "sibling.md".into();
    std::fs::write(scratch.path().join("note.md"), &rich.text).unwrap();
    std::fs::write(scratch.path().join("sibling.md"), &sibling.text).unwrap();
    hooks().lock().unwrap().insert(
        scratch.path().to_owned(),
        VecDeque::from([Change::Remote(key)]),
    );
    let results = round1_batch(
        actor,
        scratch.path().to_owned(),
        vec![sibling, rich],
        Arc::new(FailRetry(AtomicUsize::new(0))),
    )
    .expect("retry failure discarded committed siblings");
    assert_eq!(
        results[0].as_ref().unwrap().snapshot.text,
        "Committed sibling"
    );
    assert!(!results[0].as_ref().unwrap().deduped);
    assert_eq!(results[1].as_ref().unwrap_err().code(), "cancelled");
    hooks().lock().unwrap().remove(scratch.path());
    supervisor.close(&db).unwrap();
}

#[test]
fn outside_reader_fold_round1_non_markdown_skips_preparation() {
    for path in [
        "data.json",
        "code.rs",
        "code.ts",
        "data.csv",
        "notes.md/code.py",
    ] {
        let mut captured = input("{\"bold\":\"**literal**\"}");
        captured.path = path.into();
        assert!(
            eligible(&[captured]).is_empty(),
            "non-Markdown capture prepared: {path}"
        );
    }
}

#[tokio::test]
async fn outside_reader_fold_round1_batch_reader_budget_bounds_dispatches() {
    let (scratch, store, _) = fixture(false);
    let db = store.database_path().to_owned();
    drop(store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    let reader = Arc::new(Reader::new(Some(failing_reader(&scratch, false))));
    actor
        .configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(
            reader.clone(),
        )))
        .await
        .unwrap();
    let captured = input("**A changed note**");
    std::fs::write(scratch.path().join("note.md"), &captured.text).unwrap();
    let results = round1_batch(
        actor,
        scratch.path().to_owned(),
        vec![captured.clone(), captured],
        Arc::new(Round1Root),
    )
    .unwrap();
    assert!(results.iter().all(Result::is_ok));
    assert_eq!(
        reader.dispatch_count(),
        1,
        "batch exceeded its shared reader construction budget"
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn outside_reader_fold_crash_and_timeout_fall_back_without_holding_the_writer() {
    for crash in [false, true] {
        let (scratch, store, _) = fixture(false);
        let db = store.database_path().to_owned();
        drop(store);
        let source = "Changed\n\n- parent\n  - child";
        std::fs::write(scratch.path().join("note.md"), source).unwrap();
        let supervisor = crate::WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 3).unwrap().actor;
        let reader = Arc::new(Reader::new(Some(failing_reader(&scratch, crash))));
        actor
            .configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(
                reader.clone(),
            )))
            .await
            .unwrap();
        let mut deadline = None;
        let preparation = prepare(
            &actor,
            Arc::from([input(source)]),
            scratch.path(),
            &mut deadline,
        );
        let barrier = async {
            while reader.dispatch_count() == 0 {
                tokio::task::yield_now().await;
            }
            // This must run while a hanging reader request is still unresolved.
            actor.run(|_, _| Ok(())).await.unwrap();
        };
        let (folds, ()) = tokio::time::timeout(std::time::Duration::from_secs(7), async {
            if crash {
                tokio::join!(preparation, barrier)
            } else {
                tokio::pin!(preparation);
                tokio::select! {
                    biased;
                    _ = &mut preparation => panic!("hanging reader finished before the writer barrier"),
                    () = barrier => {}
                }
                (preparation.await, ())
            }
        })
        .await
        .expect("outside-fold reader deadline bounds the capture wait");
        assert!(folds.is_empty());
        assert_eq!(reader.dispatch_count(), 1);
        let result = actor
            .capture_ingest(
                input(source),
                LeaseRegistry::new(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(result, Err(RuntimeError::CaptureFileHeld { .. })));
        supervisor.close(&db).unwrap();
    }
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
async fn outside_reader_fold_retries_once_then_uses_strict_fallback() {
    for file in [false, true] {
        for changes in [1, 2] {
            let (scratch, store, key) = fixture(false);
            let source = "Changed\n\n- parent\n  - child";
            std::fs::write(scratch.path().join("note.md"), source).unwrap();
            let db = store.database_path().to_owned();
            drop(store);
            let supervisor = crate::WorkspaceSupervisor::new();
            let actor = supervisor.open(&db, 3).unwrap().actor;
            let reader = Arc::new(Reader::new(Some(
                serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap(),
            )));
            actor
                .configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(
                    reader.clone(),
                )))
                .await
                .unwrap();
            hooks().lock().unwrap().insert(
                scratch.path().to_owned(),
                (0..changes)
                    .map(|n| {
                        if file {
                            Change::File(format!("Changed {n}\n\n- parent\n  - child"))
                        } else {
                            Change::Remote(key.clone())
                        }
                    })
                    .collect(),
            );
            let result = actor
                .capture_ingest_indexed(
                    input(source),
                    scratch.path().to_owned(),
                    LeaseRegistry::new(),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await;
            if changes == 1 && !file {
                assert!(result.is_ok(), "{result:?}");
            } else {
                assert!(
                    matches!(result, Err(RuntimeError::CaptureFileHeld { .. })),
                    "{result:?}"
                );
            }
            assert_eq!(reader.dispatch_count(), if file { 1 } else { 2 });
            assert!(
                hooks()
                    .lock()
                    .unwrap()
                    .remove(scratch.path())
                    .unwrap()
                    .is_empty()
            );
            supervisor.close(&db).unwrap();
        }
    }
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
async fn outside_reader_fold_batch_retry_preserves_committed_sibling_receipts() {
    struct Root;
    impl WorkspaceRootGuard for Root {
        fn validate(&self, root: &std::path::Path) -> Result<(), RuntimeError> {
            assert!(root.is_dir());
            Ok(())
        }
    }
    let (scratch, mut store, key) = fixture(false);
    let mut sibling = input("Sibling before");
    sibling.path = "sibling.md".into();
    VersionedTextStore::new(&mut store)
        .capture_ingest(&sibling, &NoFaults)
        .unwrap();
    store
        .write_with(&NoFaults, |tx| record_capture_file_hold_in(tx, &sibling))
        .unwrap();
    sibling.text = "Sibling after".into();
    let source = "Changed\n\n- parent\n  - child";
    std::fs::write(scratch.path().join("note.md"), source).unwrap();
    std::fs::write(scratch.path().join("sibling.md"), &sibling.text).unwrap();
    let root = scratch.path().to_owned();
    let db = store.database_path().to_owned();
    drop(store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    actor
        .configure_reader_resolver(Arc::new(resolver()))
        .await
        .unwrap();
    hooks()
        .lock()
        .unwrap()
        .insert(root.clone(), VecDeque::from([Change::Remote(key)]));
    let policy = Arc::new(crate::search::read_engine_search_policy(&root));
    let results = std::thread::spawn(move || {
        actor.capture_ingest_batch_blocking(
            vec![sibling, input(source)],
            policy,
            LeaseRegistry::new(),
            Arc::new(NoFaults),
            root,
            Arc::new(Root),
        )
    })
    .join()
    .unwrap()
    .unwrap();
    let sibling = results[0].as_ref().unwrap();
    assert_eq!(sibling.snapshot.path, "sibling.md");
    assert_eq!(sibling.snapshot.text, "Sibling after");
    assert!(
        sibling.released_capture_hold,
        "first commit receipt was lost"
    );
    assert!(sibling.pending_placement);
    assert!(!sibling.deduped);
    assert!(results[1].is_ok(), "{:?}", results[1]);
    hooks().lock().unwrap().remove(scratch.path());
    supervisor.close(&db).unwrap();
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
async fn outside_reader_fold_requires_engine_serialization_to_match_the_file() {
    for ending in ["\n", "\r\n"] {
        let (scratch, mut store, key) = fixture(false);
        let canonical = "A **bold** word";
        let delta = fold(&store, &key, canonical).await.delta;
        let source = format!("{canonical}{ending}");
        std::fs::write(scratch.path().join("note.md"), &source).unwrap();
        // A byte-bound, schema-valid child result whose native output omits the file's newline.
        let config = scripted_reader(&scratch, |script| {
            script
            .replace("r.method === 'construct'", "r.method !== 'prove'")
            .replace("const delta = fault === 'declaration' ? Buffer.alloc(20 * 1024 * 1024 + 1) : Buffer.from([0, 0]);",
                &format!("const delta = Buffer.from({});", serde_json::to_string(&delta).unwrap()))
        });
        let resolver = reader_resolver::ReaderResolver::new(Arc::new(Reader::new(Some(config))));
        let prepared = store
            .read_with(|conn| reader_resolver::prepare_fold(conn, &key, "note.md", &source))
            .unwrap()
            .unwrap()
            .construct(&resolver)
            .await
            .unwrap();
        commit(&mut store, scratch.path(), &source, prepared).unwrap();
        let doc = store
            .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
            .unwrap();
        // Strict's current paragraph builder keeps the Markdown literal on this fallback.
        assert!(
            doc.canonical_content()["body"]
                .to_string()
                .contains("**bold**")
        );
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("note.md")).unwrap(),
            source
        );
    }
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
async fn outside_reader_fold_preserves_existing_history_undo_refusal() {
    let (scratch, mut store, key) = fixture(false);
    let source = "Changed beside list\n\n- parent\n  - child";
    std::fs::write(scratch.path().join("note.md"), source).unwrap();
    let prepared = fold(&store, &key, source).await;
    commit(&mut store, scratch.path(), source, prepared).unwrap();
    let db = store.database_path().to_owned();
    drop(store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 6).unwrap().actor;
    actor
        .configure_reader_resolver(Arc::new(resolver()))
        .await
        .unwrap();
    let result = actor
        .history_undo_in_turns(
            "w".into(),
            "dohc-operation:outside-fold".into(),
            "undo-outside-fold".into(),
            None,
            scratch.path().to_owned(),
            Arc::new(NoFaults),
            8,
            [Arc::default(), Arc::default()],
            Arc::new(()),
            None,
            CancellationToken::new(),
        )
        .await;
    assert!(
        matches!(
            result,
            Err(RuntimeError::Domain(
                dohc_engine_domain::DomainError::UndoRefused {
                    reason: "unsupported inverse",
                    ..
                }
            ))
        ),
        "{result:?}"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("note.md")).unwrap(),
        source
    );
    actor
        .run(move |store, _| {
            let doc = store.read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))?;
            assert_eq!(doc.project(ContentKind::Richdoc)?.content, source);
            Ok(())
        })
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
}
