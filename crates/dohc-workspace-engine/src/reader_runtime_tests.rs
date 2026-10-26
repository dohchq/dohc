// Startup configuration has no protocol reader caller.
use super::*;
use dohc_engine_protocol::transport::{EngineService as _, RequestContext};
use dohc_engine_protocol::wire::Request;
use serde_json::json;

async fn open_unchanged_notes(root: &std::path::Path) {
    let service = EngineService::new();
    service.configure_reader(dohc_engine_reader::Config {
        node: root.join("absent-node"),
        bundle: root.join("absent-bundle"),
        manifest: root.join("absent-manifest"),
    });
    let request = |id, method: &str, workspace, params| Request {
        id,
        method: method.into(),
        workspace,
        params,
        deadline_ms: None,
        idempotency_key: None,
        progress: false,
    };
    let opened = service
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({"rootDir": root, "workspaceId": "w"}),
            ),
        )
        .await
        .unwrap();
    let workspace: dohc_engine_protocol::wire::WorkspaceHandle =
        serde_json::from_value(opened.response.result["workspace"].clone()).unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let status = service
            .call(
                RequestContext::unbounded(),
                request(2, "watcher.status", Some(workspace.clone()), json!({})),
            )
            .await
            .unwrap();
        if status.response.result["phase"] == "ready" {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "initial capture never completed: {:?}",
            status.response.result
        );
        tokio::task::yield_now().await;
    }
    assert_eq!(
        service.reader.get().unwrap().dispatch_count(),
        0,
        "full workspace open must stay lazy"
    );
    service
        .call(
            RequestContext::unbounded(),
            request(3, "workspace.close", Some(workspace), json!({})),
        )
        .await
        .unwrap();
    assert_eq!(service.reader.get().unwrap().dispatch_count(), 0);
    println!("OPEN_DISPATCHES 0");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "new-process helper for opening_200_reader_documents"]
async fn opening_child() {
    open_unchanged_notes(std::path::Path::new(
        &std::env::var_os("DOHC_READER_OPEN_ROOT").unwrap(),
    ))
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opening_200_reader_documents_and_a_new_process_dispatch_nothing() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use dohc_engine_collab::{ContentKind, DocKey};
    use dohc_engine_domain::{VersionedTextStore, WriteText};
    use dohc_engine_storage::{EngineStore, NoFaults};
    use dohc_engine_testkit::{ScratchDir, engine_db_path};
    let scratch = ScratchDir::new().unwrap();
    let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    crate::root_binding::write_root_binding(scratch.path(), token).unwrap();
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/reader-resolver.json"
    ))
    .unwrap();
    let source = data["source"].as_str().unwrap();
    let checkpoint = STANDARD
        .decode(data["claimedCheckpoint"].as_str().unwrap())
        .unwrap();
    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1).unwrap();
    assert!(store.bind_root_token(token, &NoFaults).unwrap());
    VersionedTextStore::new(&mut store)
        .ensure_main_version("w", "main", 1, &NoFaults)
        .unwrap();
    for index in 0..200 {
        let object = format!("object-{index}");
        let path = format!("note-{index}.md");
        let key = DocKey::new("w", "main", &object).unwrap();
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "w".into(),
                    version_id: "main".into(),
                    object_id: object,
                    path: path.clone(),
                    text: source.into(),
                    moment_id: format!("seed-{index}"),
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        dohc_engine_collab::claim_base(
            &mut store,
            &key,
            ContentKind::Richdoc,
            &checkpoint,
            &NoFaults,
            3,
        )
        .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_docs SET path=?1 WHERE object_id=?2",
                    rusqlite::params![path, key.object_id],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
        std::fs::write(scratch.path().join(&path), source).unwrap();
    }
    drop(store);
    for _ in 0..2 {
        open_unchanged_notes(scratch.path()).await;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "reader_runtime_tests::opening_child",
            "--ignored",
            "--nocapture",
            "--test-threads=4",
        ])
        .env("DOHC_READER_OPEN_ROOT", scratch.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("OPEN_DISPATCHES 0"));
}

#[tokio::test]
async fn library_host_requires_explicit_reader_configuration() {
    let service = EngineService::new();
    assert!(service.reader.get().is_none());
    let missing = dohc_engine_testkit::ScratchDir::new().unwrap();
    service.configure_reader(dohc_engine_reader::Config {
        node: missing.path().join("node.exe"),
        bundle: missing.path().join("reader.cjs"),
        manifest: missing.path().join("manifest.json"),
    });
    let reader = service
        .reader
        .get()
        .expect("explicit configuration installs the reader");
    assert!(matches!(
        reader
            .request(dohc_engine_reader::Request {
                method: dohc_engine_reader::Method::Construct,
                document: dohc_engine_reader::Document {
                    workspace_id: "w".into(),
                    main_version_id: "v".into(),
                    object_id: "o".into(),
                    lineage_claim_id: "l".into(),
                },
                current_path: "note.md".into(),
                source: vec![],
                checkpoint: vec![],
            })
            .await,
        Err(dohc_engine_reader::Failure::Unavailable)
    ));
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG from the staged packaged/image layout"]
async fn staged_reader_starts_from_engine_configuration() {
    use dohc_engine_reader::{Config, Document, Method, Outcome, RefusalReason, Request};
    let config: Config =
        serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
    let service = EngineService::new();
    service.configure_reader(config);
    let reader = service.reader.get().unwrap();
    let result = reader
        .request(Request {
            method: Method::Construct,
            document: Document {
                workspace_id: "w".into(),
                main_version_id: "main".into(),
                object_id: "fixture".into(),
                lineage_claim_id: "l".into(),
            },
            current_path: "note.md".into(),
            source: vec![255],
            checkpoint: vec![0, 0],
        })
        .await;
    assert!(
        matches!(
            result,
            Ok(Outcome::Refused {
                reason: RefusalReason::InvalidSource,
                ..
            })
        ),
        "{result:?}"
    );
}
