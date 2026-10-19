// Startup configuration has no protocol reader caller.
use super::*;

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
