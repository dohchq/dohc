use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use dohc_engine_collab::{ContentKind, DocKey, Ydoc, reader_resolver};
use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_engine_reader::Reader;
use dohc_engine_storage::NoFaults;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn first_owner_append_dispatches_its_proof_before_holding() {
    first_owner_append(false, false).await;
    first_owner_append(true, false).await;
}

#[tokio::test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
async fn first_owner_append_commits_after_proof() {
    first_owner_append(false, true).await;
}

async fn first_owner_append(crash: bool, available: bool) {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../../dohc-engine-collab/tests/reader-resolver.json"
    ))
    .unwrap();
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("w", "main", 1, &NoFaults)
        .unwrap();
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "w".into(),
                version_id: "main".into(),
                object_id: "fixture".into(),
                path: "note.md".into(),
                text: data["source"].as_str().unwrap().into(),
                moment_id: "source".into(),
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
    store.write_with(&NoFaults, |tx| tx.execute_batch(
        "INSERT INTO sync_identity(workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES('w','origin','epoch','stream',1);
         INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) VALUES('w','origin',0);"
    ).map_err(dohc_engine_storage::StorageError::persist_public)).unwrap();
    drop(store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    let reader = Arc::new(Reader::new(if available {
        Some(serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap())
    } else if crash {
        Some(crashing_reader(&scratch))
    } else {
        None
    }));
    actor
        .configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(
            reader.clone(),
        )))
        .await
        .unwrap();
    let result = actor
        .ydoc_record_update(
            DocKey::new("w", "main", "fixture").unwrap(),
            "note.md".into(),
            ContentKind::Richdoc,
            dohc_engine_collab::Regime::Replicated,
            STANDARD
                .decode(data["checkpoint"].as_str().unwrap())
                .unwrap(),
            None,
            None,
            None,
            true,
            Some(dohc_engine_collab::owner_base_source::OwnerSeedSource {
                moment_id: "source".into(),
                blob_sha256: dohc_engine_storage::hex_sha256(
                    data["source"].as_str().unwrap().as_bytes(),
                ),
            }),
            None,
            4,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await;
    if available {
        assert!(result.is_ok(), "{result:?}");
    } else {
        assert!(
            matches!(
                result,
                Err(RuntimeError::Collab(
                    dohc_engine_collab::CollabError::MarkdownReaderUnavailable
                ))
            ),
            "{result:?}"
        );
    }
    assert_eq!(reader.dispatch_count(), if crash { 2 } else { 1 });
    assert_eq!(
        actor
            .run(|store, _| Ok(store.table_row_count("ydoc_docs")?))
            .await
            .unwrap(),
        i64::from(available)
    );
    assert_eq!(
        actor
            .run(|store, _| Ok(store.table_row_count("ydoc_owner_base_sources")?))
            .await
            .unwrap(),
        i64::from(available)
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn outside_races_dispatch_the_third_observed_proof_before_holding() {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../../dohc-engine-collab/tests/reader-resolver.json"
    ))
    .unwrap();
    let doc = Ydoc::wire();
    doc.apply(
        &STANDARD
            .decode(data["claimedCheckpoint"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let key = DocKey::new("w", "main", "fixture").unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    let mut versions = VersionedTextStore::new(&mut store);
    versions
        .ensure_main_version("w", "main", 1, &NoFaults)
        .unwrap();
    versions
        .write_text(
            &WriteText {
                workspace_id: "w".into(),
                version_id: "main".into(),
                object_id: "fixture".into(),
                path: "note.md".into(),
                text: data["source"].as_str().unwrap().into(),
                moment_id: "initial".into(),
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
        &doc.encode_full_state(),
        &NoFaults,
        3,
    )
    .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET path='note.md'", [])
                .map_err(dohc_engine_storage::StorageError::persist_public)
        })
        .unwrap();
    drop(store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 4).unwrap().actor;
    let reader = Arc::new(Reader::new(None));
    actor
        .configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(
            reader.clone(),
        )))
        .await
        .unwrap();
    let observations = Arc::new(AtomicU64::new(0));
    let seen = observations.clone();
    let checkpoint = doc.encode_full_state();
    let result = actor
        .run_with_reader_retry(move |store, cache| {
            // Each fresh observation sees a snapshot race after the preceding wait.
            let observation = seen.fetch_add(1, Ordering::SeqCst);
            store.write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE snapshots SET latest_moment_id=?1",
                    [observation.to_string()],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)
            })?;
            let doc = Ydoc::wire();
            doc.apply(&checkpoint)?;
            store
                .read_with(|conn| {
                    reader_resolver::resolve(
                        conn,
                        &key,
                        &doc,
                        &doc.project(ContentKind::Richdoc)?.content,
                        cache.reader_resolver.as_deref(),
                    )
                })
                .map_err(RuntimeError::from)
        })
        .await;
    assert!(
        matches!(
            result,
            Err(RuntimeError::Collab(
                dohc_engine_collab::CollabError::MarkdownReaderPending(_)
            ))
        ),
        "{result:?}"
    );
    assert_eq!(observations.load(Ordering::SeqCst), 3);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while reader.dispatch_count() != 3 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("every miss must dispatch, including the held third observation");
    supervisor.close(&db).unwrap();
}

fn crashing_reader(scratch: &ScratchDir) -> dohc_engine_reader::Config {
    use dohc_engine_storage::hex_sha256;
    use serde_json::json;
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
    let mut manifest = json!({"version":1,"runtime":runtime,"buildSha256":"test","parentCwd":std::env::current_dir().unwrap()});
    let script = include_str!("../../../dohc-engine-reader/src/fake.cjs")
        .replace("MANIFEST", &manifest.to_string())
        .replace("MODE", "\"startup-crash\"");
    let bundle = scratch.path().join("crashing-reader.cjs");
    std::fs::write(&bundle, &script).unwrap();
    manifest["bundleSha256"] = hex_sha256(script.as_bytes()).into();
    manifest["sources"] = json!([]);
    let manifest_path = scratch.path().join("reader-manifest.json");
    std::fs::write(&manifest_path, manifest.to_string()).unwrap();
    dohc_engine_reader::Config {
        node,
        bundle,
        manifest: manifest_path,
    }
}
