mod common;

use base64::Engine as _;
use common::*;
use dohc_engine_collab::Ydoc;
use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::EngineService;
use serde_json::{Value, json};
use std::sync::Arc;

const SECRET: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async fn open(scratch: &ScratchDir) -> (InProcessTransport<EngineService>, WorkspaceHandle) {
    let service = Arc::new(EngineService::new());
    service
        .provision_author_context_secret(SECRET.into())
        .unwrap();
    let transport = InProcessTransport::new(service);
    let opened = transport.call(RequestContext::unbounded(), request(1, "workspace.open", None,
        json!({"workspaceId":"authors", "rootDir":scratch.path().to_string_lossy(), "captureMode":"none"})))
        .await.unwrap();
    let handle = serde_json::from_value(opened.result["workspace"].clone()).unwrap();
    call(
        &transport,
        &handle,
        2,
        "versions.ensureMain",
        json!({"workspaceId":"authors"}),
    )
    .await;
    (transport, handle)
}

async fn context(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    person: &str,
) -> Value {
    call(
        transport,
        handle,
        3,
        "authorContext.admit",
        json!({"hostCredential":SECRET,"personId":person}),
    )
    .await["authorContext"]
        .clone()
}

#[tokio::test]
async fn stamped_originals_keep_people_through_switch_and_restart() {
    let scratch = ScratchDir::new().unwrap();
    let (transport, handle) = open(&scratch).await;
    assert!(
        transport
            .call(
                RequestContext::unbounded(),
                request(
                    4,
                    "authorContext.admit",
                    Some(handle.clone()),
                    json!({"hostCredential":"ordinary-rpc-token","personId":"forged"})
                )
            )
            .await
            .is_err()
    );
    let alice = context(&transport, &handle, "alice").await;
    let bob = context(&transport, &handle, "bob").await;
    let opened = call(&transport,&handle,5,"ydoc.open",json!({"versionId":"main","path":"note.txt","contentKind":"plaintext","seedFromArtifact":false})).await;
    let doc = Ydoc::wire();
    let first = base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "a"));
    let mut original = request(
        6,
        "ydoc.recordUpdate",
        Some(handle.clone()),
        json!({"sessionId":opened["sessionId"],"updateBase64":first,"authorContext":alice}),
    );
    original.idempotency_key = Some("original-alice".into());
    transport
        .call(RequestContext::unbounded(), original)
        .await
        .unwrap();
    call(&transport,&handle,7,"ydoc.recordUpdate",json!({"sessionId":opened["sessionId"],
        "updateBase64":base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(1,"b")),
        "authorContext":bob,"actorOriginId":"declared-agent", "attribution":{"actorKind":"agent","onBehalfOf":"forged-person","depth":0}})).await;
    call(
        &transport,
        &handle,
        8,
        "ydoc.evict",
        json!({"sessionId":opened["sessionId"]}),
    )
    .await;
    call(&transport, &handle, 9, "workspace.close", json!({})).await;
    drop(transport);

    let (restarted, handle) = open(&scratch).await;
    let resumed = call(&restarted,&handle,10,"ydoc.open",json!({"versionId":"main","path":"note.txt","contentKind":"plaintext","seedFromArtifact":false})).await;
    let mut replay = request(
        11,
        "ydoc.recordUpdate",
        Some(handle.clone()),
        json!({"sessionId":resumed["sessionId"],"updateBase64":first,"authorContext":alice}),
    );
    replay.idempotency_key = Some("original-alice".into());
    let response = restarted
        .call(RequestContext::unbounded(), replay.clone())
        .await
        .unwrap();
    assert_eq!(response.result["deduped"], true);
    replay.params["authorContext"] = bob;
    assert!(
        restarted
            .call(RequestContext::unbounded(), replay)
            .await
            .is_err()
    );
    call(
        &restarted,
        &handle,
        12,
        "ydoc.settle",
        json!({"sessionId":resumed["sessionId"]}),
    )
    .await;
    let page = call(
        &restarted,
        &handle,
        13,
        "moments.list",
        json!({"versionId":"main","limit":10}),
    )
    .await;
    let authors = page["moments"][0]["authors"].as_array().unwrap();
    assert!(authors.contains(&json!({"kind":"human","humanId":"alice","onBehalfOf":"alice"})));
    assert!(
        authors.contains(&json!({"kind":"agent","agentId":"declared-agent","onBehalfOf":"bob"}))
    );
    call(
        &restarted,
        &handle,
        14,
        "ydoc.close",
        json!({"sessionId":resumed["sessionId"]}),
    )
    .await;
    call(&restarted, &handle, 15, "workspace.close", json!({})).await;
}

#[tokio::test]
async fn hand_made_file_creation_and_deletion_stamp_the_admitted_person() {
    let scratch = ScratchDir::new().unwrap();
    let (transport, handle) = open(&scratch).await;
    let alice = context(&transport, &handle, "alice").await;
    call(&transport,&handle,4,"versionedText.write",json!({"workspaceId":"authors","versionId":"main","path":"record.md","text":"record", "origin":"api", "authorContext":alice,"author":{"kind":"human","humanId":"forged-person"}})).await;
    call(&transport,&handle,5,"versionedText.delete",json!({"workspaceId":"authors","versionId":"main","path":"record.md","origin":"api","authorContext":alice,"author":{"kind":"human","humanId":"forged-person"}})).await;
    let page = call(
        &transport,
        &handle,
        6,
        "moments.list",
        json!({"versionId":"main","limit":10}),
    )
    .await;
    assert_eq!(page["moments"].as_array().unwrap().len(), 2);
    for moment in page["moments"].as_array().unwrap() {
        assert_eq!(
            moment["authors"],
            json!([{"kind":"human","humanId":"alice"}])
        );
    }
    call(&transport, &handle, 7, "workspace.close", json!({})).await;
}
