// Startup configuration has no protocol reader caller.
use super::*;

#[test]
fn library_host_defaults_to_no_reader() {
    assert!(EngineService::new().reader.get().is_none());
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
