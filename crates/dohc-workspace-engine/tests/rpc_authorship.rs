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

async fn open(scratch: &ScratchDir) -> (InProcessTransport<EngineService>, WorkspaceHandle) {
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = call_with_busy_retry(&transport, RequestContext::unbounded(), request(1, "workspace.open", None,
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

// The person desktop main read from its account when the edit arrived.
fn typed_by(person: &str) -> Value {
    json!({"actorOriginId":person, "attribution":{"actorKind":"human", "onBehalfOf":person, "depth":0}})
}

fn record_update(
    id: u64,
    handle: &WorkspaceHandle,
    session: &Value,
    update: &str,
    author: Value,
) -> dohc_engine_protocol::wire::Request {
    let mut params = json!({"sessionId":session, "updateBase64":update});
    params
        .as_object_mut()
        .unwrap()
        .extend(author.as_object().unwrap().clone());
    let mut original = request(id, "ydoc.recordUpdate", Some(handle.clone()), params);
    original.idempotency_key = Some(format!("update-{id}"));
    original
}

#[tokio::test]
async fn main_named_people_survive_retry_and_restart() {
    let scratch = ScratchDir::new().unwrap();
    let (transport, handle) = open(&scratch).await;
    let opened = call(&transport,&handle,5,"ydoc.open",json!({"versionId":"main","path":"note.txt","contentKind":"plaintext","seedFromArtifact":false})).await;
    let doc = Ydoc::wire();
    let first = base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "a"));
    let mut original = record_update(6, &handle, &opened["sessionId"], &first, typed_by("alice"));
    original.idempotency_key = Some("original-alice".into());
    transport
        .call(RequestContext::unbounded(), original)
        .await
        .unwrap();
    let agent = base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(1, "b"));
    transport
        .call(RequestContext::unbounded(), record_update(7, &handle, &opened["sessionId"], &agent,
            json!({"actorOriginId":"declared-agent", "attribution":{"actorKind":"agent","onBehalfOf":"bob","depth":0}})))
        .await
        .unwrap();
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
    let mut replay = record_update(
        11,
        &handle,
        &resumed["sessionId"],
        &first,
        typed_by("alice"),
    );
    replay.idempotency_key = Some("original-alice".into());
    let response = restarted
        .call(RequestContext::unbounded(), replay.clone())
        .await
        .unwrap();
    assert_eq!(response.result["deduped"], true);
    // The same request naming someone else is a different request.
    let mut relabeled = record_update(12, &handle, &resumed["sessionId"], &first, typed_by("bob"));
    relabeled.idempotency_key = Some("original-alice".into());
    assert!(
        restarted
            .call(RequestContext::unbounded(), relabeled)
            .await
            .is_err()
    );
    call(
        &restarted,
        &handle,
        13,
        "ydoc.settle",
        json!({"sessionId":resumed["sessionId"]}),
    )
    .await;
    let page = call(
        &restarted,
        &handle,
        14,
        "moments.list",
        json!({"versionId":"main","limit":10}),
    )
    .await;
    let authors = page["moments"][0]["authors"].as_array().unwrap();
    assert!(authors.contains(&json!({"kind":"human","humanId":"alice","onBehalfOf":"alice"})));
    assert!(
        authors.contains(&json!({"kind":"agent","agentId":"declared-agent","onBehalfOf":"bob"}))
    );
    assert!(!authors.iter().any(|author| author["humanId"] == "bob"));
    call(
        &restarted,
        &handle,
        15,
        "ydoc.close",
        json!({"sessionId":resumed["sessionId"]}),
    )
    .await;
    call(&restarted, &handle, 16, "workspace.close", json!({})).await;
}

#[tokio::test]
async fn hand_made_creation_and_deletion_name_the_person_as_local_file_edits() {
    let scratch = ScratchDir::new().unwrap();
    let (transport, handle) = open(&scratch).await;
    let person = json!({"kind":"human","humanId":"alice"});
    call(&transport,&handle,4,"versionedText.write",json!({"workspaceId":"authors","versionId":"main","path":"record.md","text":"record", "origin":"local-file","author":person})).await;
    call(&transport,&handle,5,"versionedText.delete",json!({"workspaceId":"authors","versionId":"main","path":"record.md","origin":"local-file","author":person})).await;
    let page = call(
        &transport,
        &handle,
        6,
        "moments.list",
        json!({"versionId":"main","limit":10}),
    )
    .await;
    let moments = page["moments"].as_array().unwrap();
    assert_eq!(moments.len(), 2);
    for moment in moments {
        assert_eq!(moment["authors"], json!([person]));
        assert_eq!(moment["metadataOrigin"], "local-file");
    }
    call(&transport, &handle, 7, "workspace.close", json!({})).await;
}

// An automation names its run's person, whoever is signed in here: a run a
// synced edit by Bob started names Bob, and a scheduled run names nobody.
#[tokio::test]
async fn an_automation_write_keeps_its_runs_person() {
    let scratch = ScratchDir::new().unwrap();
    let (transport, handle) = open(&scratch).await;
    let for_bob = json!({"kind":"automation","automationId":"collection:tasks#stamp","onBehalfOf":"bob","depth":1});
    let scheduled = json!({"kind":"automation","automationId":"collection:tasks#weekly","depth":0});
    for (id, (path, author)) in [("bob.md", &for_bob), ("scheduled.md", &scheduled)]
        .into_iter()
        .enumerate()
    {
        call(&transport,&handle,4 + id as u64,"versionedText.write",json!({"workspaceId":"authors","versionId":"main","path":path,"text":"run", "origin":"api","author":author})).await;
    }
    let page = call(
        &transport,
        &handle,
        8,
        "moments.list",
        json!({"versionId":"main","limit":10}),
    )
    .await;
    let authors_of = |path: &str| {
        page["moments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|moment| moment["path"] == path)
            .unwrap()["authors"]
            .clone()
    };
    assert_eq!(authors_of("bob.md"), json!([for_bob]));
    assert_eq!(authors_of("scheduled.md"), json!([scheduled]));
    call(&transport, &handle, 9, "workspace.close", json!({})).await;
}
